const inFlightRecoveries = new Map();

function clean(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function normalizedWorkerId(value) {
  return clean(value, 180).replace(/^browser:/, "");
}

export function isTransientTaskGateRecoveryError(error) {
  const message = clean(error?.message || error, 1200).toLowerCase();
  return /\b(econnreset|econnrefused|etimedout|socket|network|fetch failed|offline|connection closed|mcp session|503|502)\b/.test(message)
    || /timeout|timed out|did not reconnect|mất kết nối|không kết nối/.test(message);
}

export function runningTaskRecoveryCandidates(profiles, jobs) {
  const runningCodeJobs = (Array.isArray(jobs) ? jobs : []).filter((job) => String(job?.status || "").toLowerCase() === "running" && String(job?.kind || "").toLowerCase() === "code");
  const candidates = [];
  for (const profile of Array.isArray(profiles) ? profiles : []) {
    const profileId = clean(profile?.profile_id, 180);
    if (!profileId) continue;
    const matches = runningCodeJobs.filter((job) => normalizedWorkerId(job?.worker_id || job?.workerId) === normalizedWorkerId(profileId));
    if (matches.length > 1) {
      candidates.push({
        profileId,
        taskId: "",
        job: null,
        profile,
        state: "blocked",
        message: "Không thể tiếp tục: worker có nhiều task running cùng lúc, không thể chọn owner an toàn."
      });
      continue;
    }
    if (!profile?.connected) {
      if (matches.length === 1) {
        candidates.push({
          profileId,
          taskId: clean(matches[0]?.job_id || matches[0]?.jobId, 100),
          job: matches[0],
          profile,
          state: "reconnecting",
          message: "Đang kết nối lại"
        });
      }
      continue;
    }
    if (matches.length !== 1) continue;
    candidates.push({
      profileId,
      taskId: clean(matches[0]?.job_id || matches[0]?.jobId, 100),
      job: matches[0],
      profile,
      state: "recovering",
      message: "Đang khôi phục task"
    });
  }
  return candidates;
}

async function recoverWithRetry({ key, taskId, profileId, resumeTask, maxAttempts, sleep, onState }) {
  const phases = [];
  const emit = (state, message, details = {}) => {
    const value = { state, message, task_id: taskId, profile_id: profileId, ...details };
    phases.push(value);
    onState?.(value);
    return value;
  };
  emit("recovering", "Đang khôi phục task", { attempt: 1 });
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await resumeTask({ taskId, profileId, attempt });
      return {
        ...emit("ready", result?.gate_already_active ? "" : "Đã khôi phục task", {
          attempt,
          gate_already_active: result?.gate_already_active === true,
          rules_changed: result?.rules_changed === true,
          owner_binding_recovered: result?.owner_binding_recovered === true
        }),
        result,
        phases
      };
    } catch (error) {
      const transient = isTransientTaskGateRecoveryError(error);
      const errorMessage = clean(error?.message || error, 800);
      if (!transient || attempt >= maxAttempts) {
        return {
          ...emit("blocked", `Không thể tiếp tục: ${errorMessage}`, { attempt, transient, error: errorMessage }),
          error,
          phases
        };
      }
      emit("reconnecting", "Đang kết nối lại", { attempt, transient: true, error: errorMessage });
      await sleep(Math.min(1200, 150 * (2 ** (attempt - 1))));
      emit("recovering", "Đang khôi phục task", { attempt: attempt + 1 });
    }
  }
  return { state: "blocked", message: "Không thể tiếp tục: hết số lần thử khôi phục task.", task_id: taskId, profile_id: profileId, phases };
}

export async function reconcileRunningTaskGates({
  runtimeKey,
  profiles,
  jobs,
  resumeTask,
  maxAttempts = 3,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onState
}) {
  const candidates = runningTaskRecoveryCandidates(profiles, jobs);
  const results = new Map();
  await Promise.all(candidates.map(async (candidate) => {
    if (candidate.state === "reconnecting" || candidate.state === "blocked" || !candidate.taskId) {
      const result = {
        state: candidate.state,
        message: candidate.message,
        task_id: candidate.taskId,
        profile_id: candidate.profileId,
        phases: [{ state: candidate.state, message: candidate.message }]
      };
      results.set(candidate.profileId, result);
      onState?.(result);
      return;
    }
    const key = `${clean(runtimeKey, 220) || "runtime"}:${candidate.profileId}:${candidate.taskId}`;
    let recovery = inFlightRecoveries.get(key);
    if (!recovery) {
      recovery = recoverWithRetry({
        key,
        taskId: candidate.taskId,
        profileId: candidate.profileId,
        resumeTask,
        maxAttempts: Math.max(1, Math.min(5, Number(maxAttempts) || 3)),
        sleep,
        onState
      });
      inFlightRecoveries.set(key, recovery);
      recovery.finally(() => {
        if (inFlightRecoveries.get(key) === recovery) inFlightRecoveries.delete(key);
      }).catch(() => {});
    }
    results.set(candidate.profileId, await recovery);
  }));
  return results;
}
