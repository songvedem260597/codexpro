import React from "react";
import { WorkerIcon, WorkingBadge } from "../../components/worker-ui.jsx";
import { ALL_ALLOWED_WORKSPACES, ProjectDropdown } from "../../project-dropdown.jsx";
import { responseAuditTextFingerprint } from "../../chat-response-audit.js";
import { canAcceptNextChatMessage, isRecoverableAbortedChatNetworkFailure, shouldShowChatBusy, shouldShowChatSettling } from "../../chat-status.js";
import { latestTurnHasProvisionalAssistant, materializeTranscriptMessages, transcriptAwaitingAssistant } from "../../chat-transcript.js";
import { ChatDropdown, NEW_CHAT_TARGET } from "./chat-dropdown.jsx";
import { ChatRequestComposer } from "./chat-request-composer.jsx";
import { GENERIC_TOOL_ACTIVITY_TEXT, codexProToolActivityLabel, compactToolActivityMessages, toolActivityFromText } from "./chat-activity.js";
import { profileRequestChats, repoTaskEvidenceSummary } from "./chat-conversation-utils.js";

const ResponseText = React.lazy(() => import("../../response-markdown.jsx").then((module) => ({ default: module.ResponseText })));

export function ChatModal({ profile, settings, projects, busy, state, refs, actions }) {
  if (!profile) return null;

  const {
    requestTargets,
    requestDraftResetVersions,
    requestFiles,
    requestResponses,
    requestSendErrors,
    requestSendEvidence,
    responseSelection,
    clearedResponseTargets
  } = state;
  const {
    requestTargetsRef,
    requestDraftsRef,
    chatModalRef,
    chatResponseRef,
    responseBodyRefs,
    responseComposerActive
  } = refs;
  const {
    projectRootForProfile,
    changeProjectForProfile,
    selectRequestConversation,
    loadResponse,
    continueIncompleteResponse,
    copyText,
    notify,
    clearResponse,
    captureResponseSelection,
    openGeneratedImage,
    holdOpenChatAutoScroll,
    holdResponseAutoScroll,
    pauseResponseAutoScroll,
    pasteRequestImage,
    chooseRequestAttachments,
    openAttachmentPreview,
    removeAttachment,
    clearSendError,
    close,
    openProfile,
    sendRequest
  } = actions;

  const pinnedTarget = String(requestTargetsRef.current[profile.profile_id] || requestTargets[profile.profile_id] || "");
  const conversations = profileRequestChats(profile, pinnedTarget);
  const selectedProjectRoot = projectRootForProfile(profile);
  const selectedTarget = String(requestTargets[profile.profile_id] || conversations.find((chat) => chat.active)?.id || conversations[0]?.id || NEW_CHAT_TARGET);
  const isNewChat = selectedTarget === NEW_CHAT_TARGET;
  const sending = busy === `request:${profile.profile_id}`;
  const initialDraft = requestDraftsRef.current[profile.profile_id] || "";
  const attachments = requestFiles[profile.profile_id] || [];
  const response = requestResponses[profile.profile_id];
  const sendError = requestSendErrors[profile.profile_id] || "";
  const sendEvidence = requestSendEvidence[profile.profile_id] || null;
  const responseCurrent = response?.conversationId === selectedTarget;
  const clearedKey = `${profile.profile_id}:${selectedTarget}`;
  const selectedResponseText = responseSelection.key === clearedKey ? responseSelection.text : "";
  const responseCleared = Boolean(clearedResponseTargets[clearedKey]);
  const responseMessages = responseCurrent && Array.isArray(response?.messages) ? response.messages : [];
  const rawLiveNetworkToolActivity = responseCurrent && response?.networkStreamInProgress ? String(response?.networkStreamActivityText || "").trim() : "";
  const liveNetworkToolActivity = codexProToolActivityLabel(rawLiveNetworkToolActivity) ? GENERIC_TOOL_ACTIVITY_TEXT : rawLiveNetworkToolActivity;
  const compactResponseMessages = compactToolActivityMessages(responseMessages, { collapseArgumentPayloads: codexProToolActivityLabel(rawLiveNetworkToolActivity) });
  const displayResponseMessages = liveNetworkToolActivity
    ? [...compactResponseMessages.filter((message) => !message?.toolActivity), { id: "codexpro-live-tool-activity", role: "assistant", text: liveNetworkToolActivity, truncated: false, toolActivity: true }]
    : compactResponseMessages;
  const fallbackToolActivity = toolActivityFromText(response?.text);
  const fallbackResponseMessage = fallbackToolActivity
    ? { id: "codexpro-live-tool-activity", role: "assistant", text: fallbackToolActivity, truncated: false, toolActivity: true }
    : { id: "latest-assistant", role: "assistant", text: response?.text || "", truncated: response?.truncated };
  const hasResponseContent = !responseCleared && Boolean(fallbackResponseMessage.text || displayResponseMessages.length);
  const responseVerifiedComplete = Boolean(responseCurrent && response?.responseReady && hasResponseContent);
  const selectedTab = (profile.conversation_tabs || []).find((tab) => String(tab.url || "").includes(`/c/${selectedTarget}`));
  const selectedNetworkState = String(selectedTab?.network_state || (responseCurrent ? response?.networkState : "") || (selectedTab?.busy ? "generating" : "idle"));
  const selectedNetworkCompleted = selectedNetworkState === "completed";
  const selectedNetworkFailed = selectedNetworkState === "failed";
  const selectedNetworkError = String((responseCurrent && response?.networkError) || selectedTab?.network_error || "");
  const selectedRecoveringNetworkAbort = isRecoverableAbortedChatNetworkFailure({
    networkState: selectedNetworkState,
    networkError: selectedNetworkError,
    networkCompletedAt: (responseCurrent && response?.networkCompletedAt) || selectedTab?.network_last_completed_at || "",
    responseReady: responseVerifiedComplete
  });
  const selectedBusy = selectedRecoveringNetworkAbort || shouldShowChatBusy({
    networkState: selectedNetworkState,
    tabBusy: selectedTab?.busy,
    responseCurrent,
    responseBusy: response?.busy,
    responseReady: responseVerifiedComplete,
    responseLoading: response?.loading || response?.transcriptLoading,
    streamBusy: responseCurrent && response?.networkStreamInProgress,
    canonicalBusy: responseCurrent && response?.canonicalBusy
  });
  const selectedSettling = !(responseCurrent && response?.networkStreamInProgress) && shouldShowChatSettling({
    networkState: selectedNetworkState,
    networkCompletedAt: (responseCurrent && response?.networkCompletedAt) || selectedTab?.network_last_completed_at || "",
    tabSettling: selectedTab?.settling,
    responseCurrent,
    responseIncomplete: response?.incomplete,
    responseReady: responseVerifiedComplete,
    awaitingAssistant: responseCurrent && transcriptAwaitingAssistant(materializeTranscriptMessages(response, selectedTarget)),
    finalityPending: responseCurrent && response?.finalityPending
  });
  const responseBorderActive = selectedBusy || selectedSettling;
  const responseTurnActive = selectedRecoveringNetworkAbort || Boolean(sending || selectedBusy || selectedSettling || (responseCurrent && (response?.busy || response?.loading)));
  const latestTurnProvisionalAssistant = latestTurnHasProvisionalAssistant(displayResponseMessages);
  const showSyntheticThinking = Boolean(responseTurnActive && !(response?.networkStreamAvailable && hasResponseContent) && !latestTurnProvisionalAssistant);
  const turnReady = !selectedRecoveringNetworkAbort && canAcceptNextChatMessage({
    networkState: selectedNetworkState,
    networkCompletedAt: (responseCurrent && response?.networkCompletedAt) || selectedTab?.network_last_completed_at || "",
    tabBusy: selectedTab?.busy,
    tabSettling: selectedTab?.settling,
    responseCurrent,
    responseBusy: response?.busy,
    responseReady: responseVerifiedComplete,
    responseLoading: response?.loading || response?.transcriptLoading,
    responseIncomplete: response?.incomplete,
    awaitingAssistant: responseCurrent && transcriptAwaitingAssistant(materializeTranscriptMessages(response, selectedTarget)),
    finalityPending: responseCurrent && response?.finalityPending,
    canonicalBusy: responseCurrent && response?.canonicalBusy,
    streamBusy: responseCurrent && response?.networkStreamInProgress
  });
  const domUnavailable = Boolean(responseCurrent && response?.domAvailable === false && !response?.domSkipped);
  const contentNeedsRefresh = Boolean(responseCurrent && response?.contentNeedsRefresh);
  const rolloverCreating = Boolean(responseCurrent && response?.rolloverStatus === "creating");
  const otherBusyTab = (profile.conversation_tabs || []).some((tab) => (!selectedTab || tab.id !== selectedTab.id) && (tab?.busy || tab?.settling || String(tab?.network_state || "") === "generating"));
  const selectedResponseClearsProfileBusy = Boolean(responseVerifiedComplete && !selectedBusy && !selectedSettling && !otherBusyTab);
  const canSendBase = !sending && profile.connected && Boolean(selectedProjectRoot) && !selectedRecoveringNetworkAbort && !rolloverCreating && (isNewChat || conversations.length > 0);
  const working = profile.connected && ((profile.activity === "working" && !selectedResponseClearsProfileBusy) || selectedBusy || selectedSettling || rolloverCreating);
  const workerState = !profile.connected ? "hung" : working ? "working" : "idle";
  const showRolloverNotice = Boolean(responseCurrent && !responseCleared && response?.rolloverNotice);
  const showRepoTaskNotice = Boolean(responseCurrent && !responseCleared && response?.repoTaskId && (response.repoTaskStatus === "verified" || response.repoTaskStatus === "failed"));
  const showNetworkNotice = Boolean(responseCurrent && !responseCleared && !isNewChat && !responseVerifiedComplete && (selectedNetworkFailed || selectedRecoveringNetworkAbort));
  const hasResponseNotice = showRolloverNotice || showRepoTaskNotice || showNetworkNotice;
  const responseHeadline = responseCleared
    ? "Chat đã được dọn"
    : isNewChat
      ? "Chat mới"
      : responseCurrent && response?.transcriptLoading
        ? "Đang tải tin nhắn"
        : selectedRecoveringNetworkAbort
          ? "AI vẫn đang xử lý · đang xác minh sau khi transport bị hủy"
          : selectedBusy || selectedSettling
            ? "CodexPro đang xử lý…"
            : selectedNetworkFailed && responseVerifiedComplete
              ? "AI đã phản hồi xong · canonical xác nhận"
              : selectedNetworkFailed
                ? "Request AI kết thúc với lỗi network"
                : selectedNetworkCompleted && domUnavailable
                  ? "AI đã phản hồi xong · Chrome UI đang treo"
                  : selectedNetworkCompleted && contentNeedsRefresh
                    ? "AI đã phản hồi xong · nội dung chưa đọc"
                    : selectedNetworkCompleted
                      ? "AI đã phản hồi xong · network xác nhận"
                      : responseCurrent && response?.incomplete
                        ? "Phản hồi có vẻ bị ngắt"
                        : "Chờ tín hiệu network";

  return (
    <div className="modal-backdrop chat-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <div className="modal chat-modal" ref={chatModalRef} onWheelCapture={(event) => holdOpenChatAutoScroll(profile.profile_id, event.deltaY)} onTouchMoveCapture={() => holdOpenChatAutoScroll(profile.profile_id, -1)}>
        <div className="modal-head chat-modal-head">
          <div className="chat-modal-profile">
            <WorkerIcon state={workerState} customImages={settings.workerImageDataUrls} />
            <div>
              <p className="eyebrow">CHATGPT · {profile.label}</p>
              <div className="profile-title"><strong>{profile.email || profile.label}</strong>{selectedSettling ? <span className="badge profile-settling">ĐANG HOÀN TẤT</span> : working ? <WorkingBadge /> : profile.connected ? <span className="badge connected">ĐANG RẢNH</span> : <span className="badge profile-hung">MẤT KẾT NỐI</span>}</div>
              <code>{profile.profile_id}</code>
            </div>
          </div>
          <button type="button" aria-label="Đóng chat" onClick={close}><span aria-hidden="true">×</span></button>
        </div>

        <article className={`request-card chat-popup-card ${profile.connected ? "is-online" : "is-offline"}`}>
          <label className="request-label">Chọn repo và đường dẫn</label>
          <ProjectDropdown value={selectedProjectRoot} projects={projects} onChange={(root) => changeProjectForProfile(profile, root)} disabled={!profile.connected || sending || (!isNewChat && !turnReady) || rolloverCreating} />
          {!projects.length && selectedProjectRoot !== ALL_ALLOWED_WORKSPACES && <div className="request-send-error">Chưa có workspace đã lưu. Chọn “Tất cả vùng được cấp quyền” để CodexPro tự tìm.</div>}
          {settings.showChatConversationSelector !== false && (
            <>
              <label className="request-label">Đoạn chat <small>giữ nguyên lựa chọn khi làm mới</small></label>
              <ChatDropdown value={selectedTarget} conversations={conversations} onChange={(id) => selectRequestConversation(profile, id)} disabled={!profile.connected || !conversations.length || sending} />
            </>
          )}
          <label className="request-label request-section-label">Tin nhắn gần nhất</label>
          <div className={`chat-response is-inline ${responseBorderActive ? "is-streaming" : sending ? "is-sending" : ""} ${responseCurrent && response?.incomplete ? "is-incomplete" : ""}`} ref={chatResponseRef} data-layout-conversation-id={selectedTarget} data-layout-sending={sending ? "1" : "0"} data-layout-busy={selectedBusy ? "1" : "0"} data-layout-transcript-loading={responseCurrent && response?.transcriptLoading ? "1" : "0"} data-layout-settling={selectedSettling ? "1" : "0"} data-layout-stream={response?.networkStreamInProgress ? "1" : "0"} data-layout-has-content={hasResponseContent ? "1" : "0"} data-layout-network-state={selectedNetworkState} data-layout-message-count={displayResponseMessages.length}>
            <div className="chat-response-head">
              <div><span className="response-status-dot" /><strong title={responseHeadline}>{responseHeadline}</strong>{sending && <span className="chat-response-send-state"><span>Đang gửi tin nhắn</span><span className="typing-dots" aria-hidden="true"><i /><i /><i /></span></span>}{!sending && !isNewChat && responseCurrent && response?.updatedAt && <small>{new Date(response.updatedAt).toLocaleTimeString("vi-VN")}</small>}</div>
              <div className="response-head-actions">
                {responseCurrent && !responseCleared && !isNewChat && !selectedBusy && (contentNeedsRefresh || domUnavailable) && <button type="button" onClick={() => void loadResponse(profile, selectedTarget, false, true)} disabled={Boolean(busy)}>Đọc nội dung</button>}
                {responseCurrent && !responseCleared && response?.incomplete && !selectedBusy && <button type="button" className="continue-response" onClick={() => void continueIncompleteResponse(profile, selectedTarget)} disabled={Boolean(busy)}>Tiếp tục</button>}
                {selectedResponseText && <button type="button" onClick={async () => { await copyText(selectedResponseText); notify("Đã copy đoạn được chọn"); }}>Copy đoạn</button>}
                {responseCurrent && response?.text && !responseCleared && <button type="button" onClick={async () => { await copyText(response.text); notify("Đã copy toàn bộ phản hồi mới nhất"); }}>Copy hết</button>}
                {responseCurrent && hasResponseContent && !selectedBusy && <button type="button" onClick={() => clearResponse(clearedKey)}>Clear</button>}
              </div>
            </div>
            {hasResponseNotice && (
              <div className="chat-response-notices" aria-live="polite">
                {showRolloverNotice && <div className={`conversation-rollover-notice is-${response.rolloverStatus || "done"}`}><strong>{response.rolloverStatus === "creating" ? "Chat đã đầy · đang chuyển sang chat mới" : response.rolloverStatus === "failed" ? "Chat đã đầy · chuyển chat tự động thất bại" : "Đã chuyển sang chat mới"}</strong><span>{response.rolloverNotice}</span></div>}
                {showRepoTaskNotice && <div className={`network-response-notice is-${response.repoTaskStatus === "verified" ? "completed" : response.repoTaskStatus === "failed" ? "failed" : "generating"}`}><strong>{response.repoTaskStatus === "verified" ? (response.repoTaskProof?.task_kind === "code" ? "CodexPro: Rules + CodexGraph đã xác minh" : "CodexPro: đã ghi nhận task title") : response.repoTaskStatus === "retrying" ? "CodexPro: ChatGPT thiếu title · đang gửi lại" : response.repoTaskStatus === "failed" ? "CodexPro: phản hồi bị chặn" : "CodexPro: đang chờ task title"}</strong><span>{response.repoTaskStatus === "verified" ? repoTaskEvidenceSummary(response.repoTaskProof) : response.repoTaskStatus === "failed" ? "ChatGPT không trả task title qua CodexPro nên Manager không công nhận phản hồi này." : "Mọi task phải có title; chỉ task CODE mới tải Rules và CodexGraph."}</span></div>}
                {showNetworkNotice && <div className={`network-response-notice is-${selectedNetworkState}`}><strong>{selectedRecoveringNetworkAbort ? "Network: transport cũ bị hủy · đang xác minh" : selectedBusy ? "Network: AI đang xử lý" : "Network: request thất bại"}</strong><span>{selectedRecoveringNetworkAbort ? "Chrome đã hủy transport cũ nhưng ChatGPT có thể vẫn tiếp tục ở backend. CodexPro đang kiểm tra transcript canonical trước khi kết luận lỗi." : selectedNetworkFailed ? (response?.networkError || selectedTab?.network_error || `HTTP ${response?.networkStatusCode || selectedTab?.network_status_code || "error"}`) : "Theo dõi trực tiếp vòng đời request của ChatGPT."}</span></div>}
              </div>
            )}
            {responseCleared ? <div className="response-empty">Chat đã được dọn.</div> : !profile.connected ? <div className="response-empty">Extension đang mất heartbeat nên chưa thể cập nhật.</div> : isNewChat ? <div className="response-empty">Chat mới chưa được tạo trên ChatGPT. Gửi tin nhắn đầu tiên để tạo conversation mới trong nền.</div> : responseCurrent && response?.transcriptLoading ? <div className="response-empty is-transcript-loading"><span className="thinking-state latest-response-typing"><span>Đang tải tin nhắn</span><span className="typing-dots" aria-hidden="true"><i /><i /><i /></span></span></div> : selectedRecoveringNetworkAbort && !hasResponseContent ? <div className="response-empty"><span className="typing-dots"><i /><i /><i /></span> Đang xác minh phản hồi sau khi Chrome hủy transport cũ…</div> : selectedNetworkFailed && !hasResponseContent ? <div className="response-error">Request AI đã kết thúc với lỗi network. CodexPro không cần DOM để phát hiện lỗi này.</div> : selectedNetworkCompleted && domUnavailable && !hasResponseContent ? <div className="response-empty network-complete-empty"><strong>AI đã phản hồi xong.</strong><span>Chrome renderer không phản hồi nên chưa đọc được nội dung từ giao diện. Trạng thái hoàn tất được xác nhận trực tiếp từ network.</span></div> : selectedNetworkCompleted && !hasResponseContent ? <div className="response-empty network-complete-empty"><strong>AI đã phản hồi xong.</strong><span>{contentNeedsRefresh ? "CodexPro chưa đụng DOM để đọc nội dung. Bấm “Đọc nội dung” khi bạn cần xem transcript." : "Network đã xác nhận hoàn tất. Bấm “Đọc nội dung” nếu bạn cần tải transcript từ giao diện."}</span></div> : !responseCurrent || response?.loading && !hasResponseContent ? <div className="response-empty is-transcript-loading"><span className="thinking-state latest-response-typing"><span>Đang tải tin nhắn</span><span className="typing-dots" aria-hidden="true"><i /><i /><i /></span></span></div> : response?.error ? <div className="response-error">{response.error}</div> : hasResponseContent ? (
              <div className="latest-response chat-transcript" ref={(element) => { if (element) responseBodyRefs.current.set(profile.profile_id, element); else responseBodyRefs.current.delete(profile.profile_id); }} onWheel={(event) => holdResponseAutoScroll(profile.profile_id, event.currentTarget, event.deltaY)} onTouchMove={(event) => holdResponseAutoScroll(profile.profile_id, event.currentTarget, -1)} onScroll={(event) => pauseResponseAutoScroll(profile.profile_id, event.currentTarget)}>
                {(displayResponseMessages.length ? displayResponseMessages : [fallbackResponseMessage]).map((message, messageIndex, allMessages) => {
                  const isLastAssistant = message.role === "assistant" && !allMessages.slice(messageIndex + 1).some((candidate) => candidate.role === "assistant");
                  const showLiveStreamTail = Boolean(responseTurnActive && isLastAssistant && (response?.networkStreamAvailable || message.provisional === true || message.endTurn === false));
                  const inlineLiveStatus = Boolean(showLiveStreamTail && !message.images?.length && String(message.text || "").length <= 80 && !/[\r\n]/.test(String(message.text || "")));
                  const responseSpaceClass = !isLastAssistant ? "" : showSyntheticThinking ? "is-response-cage" : "is-response-runway";
                  if (message.toolActivity) return <div className="chat-transcript-message is-tool-activity" key={message.id} data-message-id={message.id}><div className="tool-activity-live"><span className="tool-activity-text">{message.text}</span><span className="typing-dots" aria-hidden="true"><i /><i /><i /></span></div></div>;
                  return (
                    <div className={`chat-transcript-message is-${message.role} ${responseSpaceClass}`} key={message.id} data-message-id={message.id} data-audit-role={message.role} data-audit-fingerprint={responseAuditTextFingerprint(message.text)} data-audit-length={String(message.text || "").length}>
                      <div className="chat-message-avatar">{message.role === "user" ? "B" : "✦"}</div>
                      <div className={`latest-response-content ${inlineLiveStatus ? "is-inline-live-status" : ""}`} onPointerUp={message.role === "assistant" ? (event) => captureResponseSelection(clearedKey, event.currentTarget) : undefined}>
                        <span className="chat-message-role">{message.role === "user" ? "Bạn" : "ChatGPT"}{message.pending ? " · đang gửi" : message.uncertain ? " · chưa xác định đã gửi" : ""}</span>
                        {message.role === "assistant" ? <>
                          {message.text && <React.Suspense fallback={<div className="chat-message-text response-rich-text response-rich-loading">{message.text}</div>}><ResponseText text={message.text} truncated={message.truncated} streaming={showLiveStreamTail} /></React.Suspense>}
                          {Boolean(message.images?.length) && <div className={`chat-message-images ${message.images.length === 1 ? "is-single" : "is-grid"}`}>{message.images.map((image, imageIndex) => <button type="button" className="chat-generated-image" key={image.id || `${message.id}-image-${imageIndex}`} title="Mở ảnh" aria-label={`Mở ${image.alt || image.name || "ảnh tạo bởi ChatGPT"}`} onClick={() => openGeneratedImage(image)}><img src={image.dataUrl} alt={image.alt || image.name || "Ảnh tạo bởi ChatGPT"} /></button>)}</div>}
                          {showLiveStreamTail && <span className="live-stream-tail" aria-label="ChatGPT đang tiếp tục phản hồi"><span className="typing-dots"><i /><i /><i /></span></span>}
                          {message.text && turnReady && <div className="chat-message-actions"><button type="button" className="chat-message-copy" title="Copy response" aria-label="Copy phản hồi" onClick={async () => { await copyText(message.text); notify("Đã copy phản hồi"); }}><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg></button></div>}
                        </> : <div className="chat-message-text user-message-text">{message.text}</div>}
                      </div>
                    </div>
                  );
                })}
                {showSyntheticThinking && <div className="chat-transcript-message is-assistant is-typing is-response-runway"><div className="chat-message-avatar">✦</div><div className="latest-response-content"><span className="chat-message-role">ChatGPT</span><span className="thinking-state latest-response-typing"><span>Thinking</span><span className="typing-dots"><i /><i /><i /></span></span></div></div>}
              </div>
            ) : <div className="response-empty">Đoạn chat này chưa có tin nhắn.</div>}
          </div>

          <ChatRequestComposer
            profileId={profile.profile_id}
            initialDraft={initialDraft}
            draftResetVersion={requestDraftResetVersions[profile.profile_id] || 0}
            attachments={attachments}
            placeholder={rolloverCreating ? "Chat cũ đã đầy · đang tạo chat mới để tiếp tục dự án…" : "Nhập file hoặc tin nhắn"}
            disabled={!profile.connected || rolloverCreating}
            attachmentDisabled={!profile.connected || sending || rolloverCreating}
            canSendBase={canSendBase}
            sending={sending}
            rolloverCreating={rolloverCreating}
            selectedBusy={selectedBusy}
            selectedSettling={selectedSettling}
            isNewChat={isNewChat}
            sendError={sendError}
            sendEvidence={sendEvidence}
            canOpenChrome={!busy && profile.connected && !isNewChat && Boolean(profile.conversation_tabs?.length)}
            onPaste={(event) => { if (!sending) void pasteRequestImage(profile.profile_id, event); }}
            onChooseAttachments={() => void chooseRequestAttachments(profile.profile_id)}
            onOpenAttachmentPreview={openAttachmentPreview}
            onRemoveAttachment={(filePath) => removeAttachment(profile.profile_id, filePath)}
            onClearSendError={() => clearSendError(profile.profile_id)}
            onDraftSnapshot={(nextDraft) => { requestDraftsRef.current[profile.profile_id] = nextDraft; }}
            onDraftActivityChange={(active) => {
              if (active) responseComposerActive.current.set(profile.profile_id, true);
              else responseComposerActive.current.delete(profile.profile_id);
            }}
            onClose={close}
            onOpenChrome={() => openProfile(profile)}
            onSend={(nextDraft) => sendRequest(profile, nextDraft)}
          />
        </article>
      </div>
    </div>
  );
}
