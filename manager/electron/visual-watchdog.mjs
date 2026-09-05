export const VISUAL_WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;
const VISUAL_WATCHDOG_RESPONSE_TIMEOUT_MS = 120 * 1000;
const VISUAL_WATCHDOG_MIN_STUCK_CONFIDENCE = 0.90;
const VISUAL_WATCHDOG_STATE_RETENTION_MS = 24 * 60 * 60 * 1000;

function conversationIdFromUrl(url) {
  return String(url || "").match(/\/c\/([A-Za-z0-9-]{8,160})/)?.[1] || "";
}

function clampConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

export function parseVisualWatchdogJudgement(text) {
  const raw = String(text || "").trim();
  let parsed = null;
  const candidates = [raw, raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1], raw.match(/\{[\s\S]*\}/)?.[0]].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(String(candidate).trim());
      if (value && typeof value === "object" && !Array.isArray(value)) {
        parsed = value;
        break;
      }
    } catch {}
  }
  if (!parsed) return { state: "UNCERTAIN", confidence: 0, reason: "Watchdog không trả JSON hợp lệ." };
  let state = String(parsed.state || "UNCERTAIN").trim().toUpperCase();
  if (!["ACTIVE", "STUCK", "UNCERTAIN"].includes(state)) state = "UNCERTAIN";
  const confidence = clampConfidence(parsed.confidence);
  const reason = String(parsed.reason || "").trim().slice(0, 600) || "Không có giải thích.";
  if (state === "STUCK" && confidence < VISUAL_WATCHDOG_MIN_STUCK_CONFIDENCE) {
    return { state: "UNCERTAIN", confidence, reason: `Chưa đủ độ tin cậy để xác nhận treo: ${reason}`.slice(0, 600) };
  }
  return { state, confidence, reason };
}

export function buildVisualWatchdogPrompt({ taskId, title, hasPrevious, previousCaptureAt, currentCaptureAt }) {
  const comparison = hasPrevious
    ? `Có 2 ảnh. Ảnh previous-task.png được chụp lúc ${previousCaptureAt || "khoảng 5 phút trước"}; ảnh current-task.png được chụp lúc ${currentCaptureAt || "hiện tại"}. Hãy so sánh tiến triển thực sự giữa hai ảnh.`
    : "Chỉ có 1 ảnh current-task.png. Với một ảnh duy nhất, chỉ kết luận STUCK khi ảnh hiển thị lỗi treo/stream/crash rõ ràng; nếu không đủ bằng chứng phải trả UNCERTAIN.";
  return [
    "Bạn là CodexPro Visual Watchdog. Nhiệm vụ duy nhất là nhìn screenshot của tab ChatGPT đang chạy task và xác định tab có bị treo hay không.",
    "KHÔNG gọi tool. KHÔNG tiếp tục task. KHÔNG sửa code. KHÔNG trả lời nội dung task trong ảnh.",
    comparison,
    "Quy tắc: ACTIVE khi thấy nội dung assistant/tool/status có tiến triển thực sự. Spinner, con trỏ nhấp nháy, animation hoặc thay đổi nhỏ không tính là tiến triển.",
    "STUCK chỉ khi có lỗi UI rõ ràng (ví dụ Error in message stream/crash) hoặc hai ảnh cho thấy cùng trạng thái không tiến triển trong suốt khoảng kiểm tra và bạn chắc chắn cao.",
    "Nếu không thể chắc chắn, trả UNCERTAIN. Không được đoán STUCK chỉ vì hai ảnh trông giống nhau.",
    `Task ID tham chiếu: ${String(taskId || "")}. Tiêu đề: ${String(title || "Task CodexPro").slice(0, 300)}.`,
    'Chỉ trả đúng một JSON, không markdown: {"state":"ACTIVE|STUCK|UNCERTAIN","confidence":0.0,"reason":"giải thích ngắn"}'
  ].join("\n");
}

function profileIdValid(value) {
  return Boolean(value && value.length <= 160 && /^[A-Za-z0-9._-]+$/.test(value));
}

function taskIdValid(value) {
  return /^cpt_[a-f0-9]{24}$/.test(value);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function createVisualWatchdogService({ readyRuntimeStatus, readToken, openSession, closeSession, callTool, sendChat, resumeTask }) {
  const stateByTask = new Map();
  const inFlightByTask = new Map();

  const prune = (now) => {
    for (const [key, value] of stateByTask) {
      if (now - Number(value?.last_capture_at || 0) > VISUAL_WATCHDOG_STATE_RETENTION_MS) stateByTask.delete(key);
    }
  };

  const listTabs = async (session, profileId) => {
    const result = await callTool(session, "browser_control", { action: "list_tabs", profile_id: profileId }, 30_000);
    return Array.isArray(result?.tabs) ? result.tabs : [];
  };

  const resolveWatchdogTarget = async (session, profileId) => {
    const tabs = await listTabs(session, profileId);
    const tab = tabs.find((item) => item?.visual_watchdog === true);
    if (!tab?.id) return { targetId: 0, conversationId: "" };
    return { targetId: Number(tab.id) || 0, conversationId: conversationIdFromUrl(tab.url) };
  };

  const waitForConversationId = async (session, profileId, targetId, initialConversationId = "") => {
    if (/^[A-Za-z0-9-]{8,160}$/.test(initialConversationId)) return initialConversationId;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const tabs = await listTabs(session, profileId).catch(() => []);
      const tab = tabs.find((item) => Number(item?.id) === Number(targetId));
      const conversationId = conversationIdFromUrl(tab?.url);
      if (conversationId) return conversationId;
      await sleep(500);
    }
    return "";
  };

  const sendJudgeRequest = async ({ session, profile, profileId, prompt, attachments, watchdog }) => {
    const existing = Boolean(watchdog?.targetId && watchdog?.conversationId);
    const args = {
      action: "send_chat_request",
      profile_id: profileId,
      text: prompt,
      attachments,
      new_chat: !existing,
      visual_watchdog: true,
      allow_busy_followup: false,
      ...(existing ? { target_id: String(watchdog.targetId), conversation_id: watchdog.conversationId } : {})
    };
    return await sendChat(session, profile, args, 235_000);
  };

  const createOrSendWatchdog = async ({ session, profile, profileId, prompt, attachments }) => {
    let watchdog = await resolveWatchdogTarget(session, profileId);
    let sent;
    try {
      sent = await sendJudgeRequest({ session, profile, profileId, prompt, attachments, watchdog });
    } catch (error) {
      if (!watchdog.targetId) throw error;
      await callTool(session, "browser_control", { action: "close_tab", profile_id: profileId, target_id: String(watchdog.targetId) }, 30_000).catch(() => {});
      watchdog = { targetId: 0, conversationId: "" };
      sent = await sendJudgeRequest({ session, profile, profileId, prompt, attachments, watchdog });
    }
    const targetId = Number(sent?.target_id || watchdog.targetId) || 0;
    const conversationId = await waitForConversationId(session, profileId, targetId, String(sent?.conversation_id || watchdog.conversationId || ""));
    if (!targetId || !conversationId) throw new Error("Không xác định được tab/conversation của CodexPro Watchdog.");
    await callTool(session, "browser_control", {
      action: "register_watchdog_tab",
      profile_id: profileId,
      target_id: String(targetId),
      conversation_id: conversationId
    }, 30_000);
    if (!watchdog.conversationId || watchdog.conversationId !== conversationId) {
      await callTool(session, "browser_control", {
        action: "rename_chat",
        profile_id: profileId,
        conversation_id: conversationId,
        title: "CodexPro Watchdog"
      }, 30_000).catch(() => {});
    }
    return { targetId, conversationId };
  };

  const waitForJudgement = async (session, profileId, conversationId) => {
    const deadline = Date.now() + VISUAL_WATCHDOG_RESPONSE_TIMEOUT_MS;
    let latest = null;
    while (Date.now() < deadline) {
      latest = await callTool(session, "browser_control", {
        action: "get_chat_response",
        profile_id: profileId,
        conversation_id: conversationId,
        canonical_only: true,
        read_dom: false
      }, 30_000);
      if (latest?.response_ready === true && latest?.busy !== true && String(latest?.text || "").trim()) return latest;
      await sleep(1_500);
    }
    throw new Error("CodexPro Watchdog không trả kết luận trong thời gian cho phép.");
  };

  const recoverConfirmedStuck = async ({ session, payload, judgement }) => {
    if (payload.autoRecover !== true) return { attempted: false, recovered: false, reason: "auto_recovery_disabled" };
    if (typeof resumeTask !== "function") throw new Error("Visual Watchdog chưa có recovery handler.");

    const freshStatus = await readyRuntimeStatus();
    const profile = (Array.isArray(freshStatus?.browserProfiles) ? freshStatus.browserProfiles : [])
      .find((item) => String(item?.profile_id || "") === payload.profileId);
    if (!profile?.connected) return { attempted: false, recovered: false, reason: "profile_offline" };
    if (String(profile?.current_task_id || "") !== payload.taskId) {
      return { attempted: false, recovered: false, reason: "task_changed" };
    }

    const jobResult = await callTool(session, "worker_job_status", { task_id: payload.taskId }, 15_000);
    const job = jobResult?.job;
    const jobStatus = String(job?.status || "").trim().toLowerCase();
    if (!job || jobStatus !== "running" || job?.completion_confirmed === true || job?.completionConfirmed === true) {
      return { attempted: false, recovered: false, reason: `task_not_running:${jobStatus || "missing"}` };
    }

    const tabs = await listTabs(session, payload.profileId);
    const taskTab = tabs.find((item) => Number(item?.id) === Number(payload.targetId) && item?.visual_watchdog !== true)
      || tabs.find((item) => item?.visual_watchdog !== true && conversationIdFromUrl(item?.url) === payload.conversationId);
    if (!taskTab?.id) return { attempted: false, recovered: false, reason: "task_tab_missing" };

    await callTool(session, "browser_control", {
      action: "close_tab",
      profile_id: payload.profileId,
      target_id: String(taskTab.id)
    }, 30_000);

    const recoveryReason = `Visual Watchdog xác nhận tab không tiến triển sau chu kỳ 5 phút (${Number(judgement.confidence || 0).toFixed(2)}): ${String(judgement.reason || "không có lý do").slice(0, 360)}`;
    const resumed = await resumeTask({
      profileId: payload.profileId,
      taskId: payload.taskId,
      hangRecovery: true,
      recoveryReason
    });
    if (String(resumed?.repo_task_id || "") !== payload.taskId) {
      throw new Error("Visual Watchdog recovery đã đổi Task ID; dừng để tránh tạo task mới.");
    }
    const newConversationId = String(resumed?.conversation_id || "").trim();
    if (!/^[A-Za-z0-9-]{8,160}$/.test(newConversationId)) {
      throw new Error("Visual Watchdog recovery chưa tạo được conversation mới hợp lệ.");
    }
    return {
      attempted: true,
      recovered: true,
      old_target_id: Number(taskTab.id) || 0,
      abandoned_conversation_id: payload.conversationId,
      conversation_id: newConversationId,
      task_id: payload.taskId,
      task_id_preserved: true
    };
  };

  const performCheck = async (payload, key) => {
    const now = Date.now();
    prune(now);
    const previousState = stateByTask.get(key) || {};
    const lastCaptureAt = Number(previousState.last_capture_at || 0);
    if (lastCaptureAt && now - lastCaptureAt < VISUAL_WATCHDOG_INTERVAL_MS) {
      return {
        skipped: true,
        state: String(previousState.last_state || "UNCERTAIN"),
        confidence: Number(previousState.last_confidence || 0),
        reason: "Chưa đến chu kỳ chụp 5 phút tiếp theo.",
        next_check_at: new Date(lastCaptureAt + VISUAL_WATCHDOG_INTERVAL_MS).toISOString()
      };
    }

    const status = await readyRuntimeStatus();
    if (!status?.local?.ok) throw new Error("Local MCP chưa sẵn sàng cho Visual Watchdog.");
    const profile = (status.browserProfiles || []).find((item) => String(item?.profile_id || "") === payload.profileId);
    if (!profile?.connected) throw new Error("Chrome profile của task đang offline.");
    const token = readToken(status.config.tokenFile);
    let session = null;
    try {
      session = await openSession(status.config, token);
      const screenshot = await callTool(session, "browser_control", {
        action: "screenshot",
        profile_id: payload.profileId,
        target_id: String(payload.targetId),
        full_page: false
      }, 35_000);
      const currentImage = String(screenshot?.image_base64 || "");
      if (!currentImage) throw new Error("Không chụp được screenshot của tab task.");

      const capturedAt = new Date().toISOString();
      const previousImage = String(previousState.previous_image_base64 || "");
      const previousCaptureAt = String(previousState.last_capture_iso || "");
      const nextState = {
        ...previousState,
        last_capture_at: Date.now(),
        last_capture_iso: capturedAt,
        previous_image_base64: currentImage
      };
      stateByTask.set(key, nextState);

      const attachments = [];
      if (previousImage) attachments.push({ name: "previous-task.png", mime_type: "image/png", data_base64: previousImage });
      attachments.push({ name: "current-task.png", mime_type: "image/png", data_base64: currentImage });
      const prompt = buildVisualWatchdogPrompt({
        taskId: payload.taskId,
        title: payload.title,
        hasPrevious: Boolean(previousImage),
        previousCaptureAt,
        currentCaptureAt: capturedAt
      });
      const watchdog = await createOrSendWatchdog({ session, profile, profileId: payload.profileId, prompt, attachments });
      const response = await waitForJudgement(session, payload.profileId, watchdog.conversationId);
      const judgement = parseVisualWatchdogJudgement(response?.text);
      Object.assign(nextState, {
        last_state: judgement.state,
        last_confidence: judgement.confidence,
        last_reason: judgement.reason,
        watchdog_target_id: watchdog.targetId,
        watchdog_conversation_id: watchdog.conversationId
      });
      const recovery = judgement.state === "STUCK"
        ? await recoverConfirmedStuck({ session, payload, judgement })
        : { attempted: false, recovered: false, reason: "not_stuck" };
      return {
        skipped: false,
        ...judgement,
        captured_at: capturedAt,
        previous_capture_at: previousCaptureAt,
        compared_two_images: Boolean(previousImage),
        watchdog_target_id: watchdog.targetId,
        watchdog_conversation_id: watchdog.conversationId,
        recovery,
        next_check_at: new Date(Date.now() + VISUAL_WATCHDOG_INTERVAL_MS).toISOString()
      };
    } finally {
      if (session) void closeSession(session);
    }
  };

  const check = async (payload = {}) => {
    const profileId = String(payload.profileId || "").trim();
    const taskId = String(payload.taskId || "").trim();
    const conversationId = String(payload.conversationId || "").trim();
    const targetId = Number(payload.targetId);
    if (!profileIdValid(profileId)) throw new Error("Chrome profile id không hợp lệ cho Visual Watchdog.");
    if (!taskIdValid(taskId)) throw new Error("Task ID không hợp lệ cho Visual Watchdog.");
    if (!/^[A-Za-z0-9-]{8,160}$/.test(conversationId)) throw new Error("Conversation task không hợp lệ cho Visual Watchdog.");
    if (!Number.isInteger(targetId) || targetId <= 0) throw new Error("Tab task không hợp lệ cho Visual Watchdog.");
    const normalized = { profileId, taskId, conversationId, targetId, title: String(payload.title || "Task CodexPro").trim().slice(0, 300), autoRecover: payload.autoRecover === true };
    const key = `${profileId}:${taskId}`;
    if (inFlightByTask.has(key)) return await inFlightByTask.get(key);
    const promise = performCheck(normalized, key);
    inFlightByTask.set(key, promise);
    try {
      return await promise;
    } finally {
      if (inFlightByTask.get(key) === promise) inFlightByTask.delete(key);
    }
  };

  return { check };
}
