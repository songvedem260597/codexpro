import { useCallback, useEffect, useRef } from "react";
import {
  cancelResponseAutoResume,
  handleResponseWheel,
  installResponseAutoPin,
  recordResponseScroll,
  responseScrollMetrics,
  scheduleResponseAutoResume,
  scrollResponseToTurnAnchor as applyResponseTurnAnchor
} from "../chat-scroll.js";

const RESPONSE_BOTTOM_THRESHOLD_PX = 18;
const RESPONSE_MANUAL_SCROLL_RESUME_MS = 5000;

export function syncTurnAnchorPresentation(container, anchored, anchorSpace = "") {
  if (!container) return false;
  let changed = false;
  if (anchored) {
    if (!container.classList.contains("has-turn-anchor")) {
      container.classList.add("has-turn-anchor");
      changed = true;
    }
    const nextAnchorSpace = String(anchorSpace || "");
    if (nextAnchorSpace && container.style.getPropertyValue("--chat-turn-anchor-space") !== nextAnchorSpace) {
      container.style.setProperty("--chat-turn-anchor-space", nextAnchorSpace);
      changed = true;
    }
    return changed;
  }
  if (container.classList.contains("has-turn-anchor")) {
    container.classList.remove("has-turn-anchor");
    changed = true;
  }
  if (container.style.getPropertyValue("--chat-turn-anchor-space")) {
    container.style.removeProperty("--chat-turn-anchor-space");
    changed = true;
  }
  return changed;
}

export function useChatViewport({
  api,
  chatProfileId,
  selectedRequestTarget,
  requestTargetsRef,
  setResponseSelection,
  deepDiagnosticsEnabled = false
}) {
  const responseBodyRefs = useRef(new Map());
  const chatModalRef = useRef(null);
  const chatResponseRef = useRef(null);
  const responseScrollLocked = useRef(new Map());
  const responseComposerActive = useRef(new Map());
  const responseScrollResumeTimers = useRef(new Map());
  const responseScrollPositions = useRef(new Map());
  const responseScrollDiagnostics = useRef(new Map());
  const responseTurnAnchors = useRef(new Map());

  const logResponseScrollAdjustment = useCallback((profileId, container, before, after, cause, mode, extra = {}) => {
    if (!before || !after) return;
    const previous = responseScrollDiagnostics.current.get(profileId) || null;
    const delta = {
      scrollTop: after.scrollTop - before.scrollTop,
      scrollHeight: previous ? before.scrollHeight - previous.scrollHeight : 0,
      clientHeight: previous ? before.clientHeight - previous.clientHeight : 0,
      distanceFromBottom: after.distanceFromBottom - before.distanceFromBottom
    };
    const signature = `${mode}:${cause}:${before.scrollTop}:${before.scrollHeight}:${before.clientHeight}:${after.scrollTop}:${after.scrollHeight}:${after.clientHeight}:${extra.anchorId || ""}`;
    const shouldLog = Math.abs(delta.scrollTop) >= 2 || Math.abs(delta.scrollHeight) >= 2 || Math.abs(delta.clientHeight) >= 2;
    responseScrollDiagnostics.current.set(profileId, { ...after, signature });
    if (!shouldLog || previous?.signature === signature || typeof api.logChatLayout !== "function") return;
    const panel = chatResponseRef.current;
    api.logChatLayout({
      at: new Date().toISOString(),
      type: "scroll-jump",
      profileId,
      conversationId: String(requestTargetsRef.current[profileId] || panel?.dataset.layoutConversationId || ""),
      cause,
      mode,
      locked: Boolean(responseScrollLocked.current.get(profileId)),
      before,
      after,
      delta,
      ...extra,
      panel: panel ? {
        height: Math.round(panel.getBoundingClientRect().height),
        scrollHeight: Math.round(panel.scrollHeight),
        clientHeight: Math.round(panel.clientHeight)
      } : null,
      messages: [...container.children].slice(-8).map((node) => ({
        id: String(node.dataset.messageId || "").slice(0, 180),
        role: String(node.dataset.auditRole || ""),
        height: Math.round(node.getBoundingClientRect().height),
        textLength: String(node.textContent || "").length
      }))
    });
  }, [api, requestTargetsRef]);

  const scrollResponseToBottom = useCallback((profileId, cause = "unspecified") => {
    const container = responseBodyRefs.current.get(profileId);
    if (!container) return;
    syncTurnAnchorPresentation(container, false);
    const before = responseScrollMetrics(container);
    container.scrollTop = container.scrollHeight;
    const after = responseScrollMetrics(container);
    responseScrollPositions.current.set(profileId, container.scrollTop);
    logResponseScrollAdjustment(profileId, container, before, after, cause, "bottom");
  }, [logResponseScrollAdjustment]);

  const scrollResponseToTurnAnchor = useCallback((profileId, cause = "unspecified") => {
    const container = responseBodyRefs.current.get(profileId);
    const anchorState = responseTurnAnchors.current.get(profileId);
    if (!container || !anchorState) return false;
    const activeConversationId = String(requestTargetsRef.current[profileId] || chatResponseRef.current?.dataset.layoutConversationId || "");
    if (anchorState.conversationId && activeConversationId && anchorState.conversationId !== activeConversationId) {
      responseTurnAnchors.current.delete(profileId);
      return false;
    }
    const userMessages = [...container.querySelectorAll('.chat-transcript-message.is-user[data-audit-fingerprint]')];
    const anchor = anchorState.fingerprint
      ? userMessages.findLast((node) => node.dataset.auditFingerprint === anchorState.fingerprint)
      : userMessages.at(-1);
    if (!anchor) return false;
    const anchorRect = anchor.getBoundingClientRect();
    const anchorViewportTop = 56;
    const anchorSpace = `${Math.max(240, Math.round(container.clientHeight - anchorViewportTop - anchorRect.height + 24))}px`;
    syncTurnAnchorPresentation(container, true, anchorSpace);
    const before = responseScrollMetrics(container);
    const beforeAnchorTop = Math.round(anchorRect.top - container.getBoundingClientRect().top);
    const after = applyResponseTurnAnchor(container, anchor, 0.42, anchorViewportTop);
    const afterAnchorTop = Math.round(anchor.getBoundingClientRect().top - container.getBoundingClientRect().top);
    responseScrollPositions.current.set(profileId, container.scrollTop);
    logResponseScrollAdjustment(profileId, container, before, after, cause, "turn-anchor", {
      anchorId: String(anchor.dataset.messageId || "").slice(0, 180),
      anchorFingerprint: String(anchor.dataset.auditFingerprint || ""),
      anchorViewportTopBefore: beforeAnchorTop,
      anchorViewportTopAfter: afterAnchorTop,
      anchorViewportDelta: afterAnchorTop - beforeAnchorTop
    });
    return true;
  }, [logResponseScrollAdjustment, requestTargetsRef]);

  const maintainResponsePosition = useCallback((profileId, cause = "unspecified") => {
    if (responseScrollLocked.current.get(profileId) || responseComposerActive.current.get(profileId)) return;
    if (scrollResponseToTurnAnchor(profileId, cause)) return;
    scrollResponseToBottom(profileId, cause);
  }, [scrollResponseToBottom, scrollResponseToTurnAnchor]);

  const restoreOpenResponseTurnAnchor = useCallback((profileId) => {
    if (responseTurnAnchors.current.has(profileId)) return true;
    const container = responseBodyRefs.current.get(profileId);
    const anchor = [...(container?.querySelectorAll('.chat-transcript-message.is-user[data-audit-fingerprint]') || [])].at(-1);
    if (!anchor) return false;
    responseTurnAnchors.current.set(profileId, {
      conversationId: String(requestTargetsRef.current[profileId] || chatResponseRef.current?.dataset.layoutConversationId || ""),
      fingerprint: String(anchor.dataset.auditFingerprint || ""),
      messageId: String(anchor.dataset.messageId || ""),
      restoredAt: Date.now()
    });
    return true;
  }, [requestTargetsRef]);

  const positionOpenChatViewport = useCallback((profileId, cause = "open-chat") => {
    if (responseScrollLocked.current.get(profileId) || responseComposerActive.current.get(profileId)) return;
    maintainResponsePosition(profileId, cause);
    const modal = chatModalRef.current;
    if (!modal) return;
    const previousBehavior = modal.style.scrollBehavior;
    modal.style.scrollBehavior = "auto";
    modal.scrollTop = modal.scrollHeight;
    modal.style.scrollBehavior = previousBehavior;
  }, [maintainResponsePosition]);

  const scheduleOpenChatAutoResume = useCallback((profileId) => {
    scheduleResponseAutoResume({
      profileId,
      lockedProfiles: responseScrollLocked.current,
      timers: responseScrollResumeTimers.current,
      delay: RESPONSE_MANUAL_SCROLL_RESUME_MS,
      resume: (resumedProfileId) => {
        window.requestAnimationFrame(() => positionOpenChatViewport(resumedProfileId, "manual-scroll-idle"));
      }
    });
  }, [positionOpenChatViewport]);

  const holdOpenChatAutoScroll = useCallback((profileId, deltaY = 0) => {
    if (deltaY < 0) responseScrollLocked.current.set(profileId, true);
    if (responseScrollLocked.current.get(profileId)) scheduleOpenChatAutoResume(profileId);
  }, [scheduleOpenChatAutoResume]);

  const holdResponseAutoScroll = useCallback((profileId, container, deltaY = 0) => {
    if (responseTurnAnchors.current.has(profileId) && deltaY) {
      responseTurnAnchors.current.delete(profileId);
      syncTurnAnchorPresentation(container, false);
      responseScrollLocked.current.set(profileId, true);
      responseScrollPositions.current.set(profileId, container.scrollTop);
      scheduleOpenChatAutoResume(profileId);
      return;
    }
    handleResponseWheel(profileId, container, deltaY, responseScrollLocked.current, RESPONSE_BOTTOM_THRESHOLD_PX);
    if (responseScrollLocked.current.get(profileId)) scheduleOpenChatAutoResume(profileId);
    else cancelResponseAutoResume(profileId, responseScrollResumeTimers.current);
  }, [scheduleOpenChatAutoResume]);

  const pauseResponseAutoScroll = useCallback((profileId, container) => {
    recordResponseScroll(profileId, container, responseScrollLocked.current, responseScrollPositions.current, RESPONSE_BOTTOM_THRESHOLD_PX);
    if (!responseScrollLocked.current.get(profileId)) cancelResponseAutoResume(profileId, responseScrollResumeTimers.current);
  }, []);

  const resetChatViewport = useCallback((profileId, { clearAnchor = true } = {}) => {
    cancelResponseAutoResume(profileId, responseScrollResumeTimers.current);
    responseScrollLocked.current.delete(profileId);
    responseScrollPositions.current.delete(profileId);
    responseScrollDiagnostics.current.delete(profileId);
    if (clearAnchor) responseTurnAnchors.current.delete(profileId);
  }, []);

  const captureResponseSelection = useCallback((key, container) => {
    const selection = window.getSelection?.();
    const text = selection?.toString() || "";
    const inside = Boolean(
      selection
      && selection.rangeCount > 0
      && !selection.isCollapsed
      && selection.anchorNode
      && selection.focusNode
      && container.contains(selection.anchorNode)
      && container.contains(selection.focusNode)
    );
    setResponseSelection(inside && text.trim() ? { key, text } : (current) => current.key === key ? { key: "", text: "" } : current);
  }, [setResponseSelection]);

  useEffect(() => {
    if (!chatProfileId) return undefined;
    cancelResponseAutoResume(chatProfileId, responseScrollResumeTimers.current);
    responseScrollLocked.current.delete(chatProfileId);
    responseScrollPositions.current.delete(chatProfileId);
    return () => cancelResponseAutoResume(chatProfileId, responseScrollResumeTimers.current);
  }, [chatProfileId, selectedRequestTarget]);

  useEffect(() => {
    if (!chatProfileId) return undefined;
    return installResponseAutoPin({
      panel: chatResponseRef.current,
      getContainer: () => responseBodyRefs.current.get(chatProfileId),
      isLocked: () => Boolean(responseScrollLocked.current.get(chatProfileId) || responseComposerActive.current.get(chatProfileId)),
      scrollToBottom: (cause) => maintainResponsePosition(chatProfileId, `observer:${cause}`)
    });
  }, [chatProfileId, selectedRequestTarget, maintainResponsePosition]);

  useEffect(() => {
    if (!chatProfileId || typeof api.logChatLayout !== "function") return undefined;
    const modal = chatModalRef.current;
    const panel = chatResponseRef.current;
    if (!modal || !panel) return undefined;
    let timer = 0;
    let previousSignature = "";
    let textarea = null;
    const observedNodes = new WeakSet();
    const resizeObserver = new ResizeObserver(() => schedule("geometry-resize"));
    const roundedRect = (node) => {
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { top: Math.round(rect.top), height: Math.round(rect.height) };
    };
    const observeNode = (node) => {
      if (!node || observedNodes.has(node)) return;
      observedNodes.add(node);
      resizeObserver.observe(node);
    };
    const capture = (cause) => {
      const transcript = responseBodyRefs.current.get(chatProfileId) || panel.querySelector(".latest-response");
      const composer = modal.querySelector(".request-composer");
      const nextTextarea = composer?.querySelector("textarea") || null;
      const notices = [...panel.querySelectorAll(".chat-response-notices > .conversation-rollover-notice, .chat-response-notices > .network-response-notice")].map((node) => ({
        className: String(node.className || "").slice(0, 160),
        height: Math.round(node.getBoundingClientRect().height)
      }));
      const geometry = {
        panel: { ...roundedRect(panel), clientHeight: panel.clientHeight },
        transcript: transcript ? { ...roundedRect(transcript), clientHeight: transcript.clientHeight, scrollTop: Math.round(transcript.scrollTop), scrollHeight: transcript.scrollHeight } : null,
        composer: roundedRect(composer),
        textarea: nextTextarea ? { ...roundedRect(nextTextarea), scrollHeight: nextTextarea.scrollHeight, draftLength: nextTextarea.value.length, draftActive: Boolean(nextTextarea.value.trim()) } : null,
        modal: { scrollTop: Math.round(modal.scrollTop), scrollHeight: modal.scrollHeight, clientHeight: modal.clientHeight },
        notices,
        scrollLocked: Boolean(responseScrollLocked.current.get(chatProfileId)),
        composerActive: Boolean(responseComposerActive.current.get(chatProfileId))
      };
      const signature = JSON.stringify({
        panel: geometry.panel,
        transcript: geometry.transcript ? { top: geometry.transcript.top, height: geometry.transcript.height, clientHeight: geometry.transcript.clientHeight } : null,
        composer: geometry.composer,
        textarea: geometry.textarea ? { height: geometry.textarea.height, scrollHeight: geometry.textarea.scrollHeight, draftActive: geometry.textarea.draftActive } : null,
        notices,
        scrollLocked: geometry.scrollLocked,
        composerActive: geometry.composerActive
      });
      if (signature === previousSignature) return;
      previousSignature = signature;
      api.logChatLayout({
        at: new Date().toISOString(),
        type: "chat-frame-geometry",
        profileId: chatProfileId,
        conversationId: String(panel.dataset.layoutConversationId || requestTargetsRef.current[chatProfileId] || ""),
        cause,
        ...geometry
      });
      observeNode(transcript);
      observeNode(composer);
      observeNode(nextTextarea);
    };
    function schedule(cause) {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => capture(cause), 90);
    }
    const onComposerInput = () => schedule("composer-input");
    const attachTextarea = () => {
      const nextTextarea = modal.querySelector(".request-composer textarea");
      if (textarea === nextTextarea) return;
      textarea?.removeEventListener("input", onComposerInput);
      textarea = nextTextarea;
      textarea?.addEventListener("input", onComposerInput, { passive: true });
      observeNode(textarea);
    };
    const mutationObserver = new MutationObserver(() => {
      attachTextarea();
      schedule("panel-mutation");
    });
    observeNode(panel);
    observeNode(modal.querySelector(".request-composer"));
    observeNode(responseBodyRefs.current.get(chatProfileId) || panel.querySelector(".latest-response"));
    attachTextarea();
    mutationObserver.observe(panel, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    schedule("attach");
    return () => {
      window.clearTimeout(timer);
      textarea?.removeEventListener("input", onComposerInput);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
    };
  }, [api, chatProfileId, requestTargetsRef, selectedRequestTarget]);

  useEffect(() => {
    if (!deepDiagnosticsEnabled || !chatProfileId || typeof api.logChatLayout !== "function") return undefined;
    const panel = chatResponseRef.current;
    if (!panel) return undefined;
    let animationFrame = 0;
    let flushTimer = 0;
    let previousSnapshot = null;
    const pendingChanges = [];
    const describeNode = (node) => {
      if (!(node instanceof Element)) return { nodeType: node?.nodeType || 0 };
      return {
        tag: node.tagName.toLowerCase(),
        className: String(node.className || "").slice(0, 180),
        height: Math.round(node.getBoundingClientRect().height),
        children: node.childElementCount,
        textLength: String(node.textContent || "").length
      };
    };
    const captureSnapshot = (cause) => {
      const transcript = panel.querySelector(".chat-transcript");
      const panelNodes = [...panel.children].map(describeNode);
      const transcriptNodes = transcript ? [...transcript.children].map(describeNode) : [];
      const snapshot = {
        at: new Date().toISOString(),
        profileId: chatProfileId,
        conversationId: String(panel.dataset.layoutConversationId || ""),
        cause,
        state: {
          sending: panel.dataset.layoutSending === "1",
          busy: panel.dataset.layoutBusy === "1",
          settling: panel.dataset.layoutSettling === "1",
          stream: panel.dataset.layoutStream === "1",
          hasContent: panel.dataset.layoutHasContent === "1",
          networkState: String(panel.dataset.layoutNetworkState || ""),
          messageCount: Number(panel.dataset.layoutMessageCount || 0)
        },
        panel: {
          height: Math.round(panel.getBoundingClientRect().height),
          scrollHeight: panel.scrollHeight,
          clientHeight: panel.clientHeight
        },
        transcript: transcript ? {
          height: Math.round(transcript.getBoundingClientRect().height),
          scrollTop: Math.round(transcript.scrollTop),
          scrollHeight: transcript.scrollHeight,
          clientHeight: transcript.clientHeight,
          locked: Boolean(responseScrollLocked.current.get(chatProfileId))
        } : null,
        panelNodes,
        transcriptNodes,
        changes: pendingChanges.splice(0, pendingChanges.length)
      };
      const layoutPanelNodes = panelNodes.map(({ textLength: _textLength, ...node }) => node);
      const layoutTranscriptNodes = transcriptNodes.map(({ textLength: _textLength, ...node }) => node);
      const signature = JSON.stringify({ state: snapshot.state, panel: snapshot.panel, transcript: snapshot.transcript, panelNodes: layoutPanelNodes, transcriptNodes: layoutTranscriptNodes });
      if (!previousSnapshot || previousSnapshot.signature !== signature) {
        snapshot.delta = previousSnapshot ? {
          panelHeight: snapshot.panel.height - previousSnapshot.panelHeight,
          transcriptHeight: (snapshot.transcript?.height || 0) - previousSnapshot.transcriptHeight,
          scrollTop: (snapshot.transcript?.scrollTop || 0) - previousSnapshot.scrollTop
        } : null;
        api.logChatLayout(snapshot);
        previousSnapshot = {
          signature,
          panelHeight: snapshot.panel.height,
          transcriptHeight: snapshot.transcript?.height || 0,
          scrollTop: snapshot.transcript?.scrollTop || 0
        };
      }
    };
    const scheduleSnapshot = (cause) => {
      window.clearTimeout(flushTimer);
      window.cancelAnimationFrame(animationFrame);
      flushTimer = window.setTimeout(() => {
        animationFrame = window.requestAnimationFrame(() => captureSnapshot(cause));
      }, 80);
    };
    const mutationObserver = new MutationObserver((records) => {
      for (const record of records) {
        pendingChanges.push({
          type: record.type,
          attribute: record.attributeName || "",
          target: describeNode(record.target),
          added: [...record.addedNodes].map(describeNode),
          removed: [...record.removedNodes].map(describeNode)
        });
      }
      if (pendingChanges.length > 24) pendingChanges.splice(0, pendingChanges.length - 24);
      scheduleSnapshot("mutation");
    });
    const resizeObserver = new ResizeObserver(() => scheduleSnapshot("resize"));
    mutationObserver.observe(panel, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "data-layout-sending", "data-layout-busy", "data-layout-settling", "data-layout-stream", "data-layout-has-content", "data-layout-network-state", "data-layout-message-count"]
    });
    resizeObserver.observe(panel);
    scheduleSnapshot("attach");
    return () => {
      window.clearTimeout(flushTimer);
      window.cancelAnimationFrame(animationFrame);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
    };
  }, [api, chatProfileId, deepDiagnosticsEnabled, selectedRequestTarget]);

  return {
    responseBodyRefs,
    chatModalRef,
    chatResponseRef,
    responseScrollLocked,
    responseComposerActive,
    responseScrollResumeTimers,
    responseScrollPositions,
    responseScrollDiagnostics,
    responseTurnAnchors,
    maintainResponsePosition,
    restoreOpenResponseTurnAnchor,
    positionOpenChatViewport,
    holdOpenChatAutoScroll,
    holdResponseAutoScroll,
    pauseResponseAutoScroll,
    resetChatViewport,
    captureResponseSelection
  };
}
