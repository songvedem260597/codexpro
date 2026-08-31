import React, { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useFrameCoalescedValue } from "./use-frame-coalesced-value.js";

const ResponseText = React.lazy(() => import("./response-markdown.jsx").then((module) => ({ default: module.ResponseText })));

function CopyIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>;
}

function useReaderOwnedScroll(revision, working) {
  const scrollerRef = useRef(null);
  const contentRef = useRef(null);
  const pinnedRef = useRef(true);
  const programmaticRef = useRef(false);
  const [pinned, setPinned] = useState(true);
  const setOwnership = useCallback((nextPinned) => {
    pinnedRef.current = nextPinned;
    setPinned(nextPinned);
  }, []);
  const scrollToLatest = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    setOwnership(true);
    programmaticRef.current = true;
    scroller.scrollTop = scroller.scrollHeight;
    requestAnimationFrame(() => { programmaticRef.current = false; });
  }, [setOwnership]);

  useLayoutEffect(() => {
    if (!pinnedRef.current) return;
    scrollToLatest();
  }, [revision, scrollToLatest]);

  useLayoutEffect(() => {
    if (!working || !pinned || !contentRef.current || typeof ResizeObserver !== "function") return undefined;
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current) scrollToLatest();
    });
    observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [pinned, scrollToLatest, working]);

  const onWheel = useCallback((event) => {
    if (event.deltaY < 0) setOwnership(false);
  }, [setOwnership]);
  const onTouchMove = useCallback(() => setOwnership(false), [setOwnership]);
  const onScroll = useCallback((event) => {
    if (programmaticRef.current) return;
    const scroller = event.currentTarget;
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 24;
    if (atBottom !== pinnedRef.current) setOwnership(atBottom);
  }, [setOwnership]);

  return { scrollerRef, contentRef, pinned, onWheel, onTouchMove, onScroll, scrollToLatest };
}

export function LatestMessagePanel({
  working = false,
  headline,
  title = "",
  requestText = "",
  responseText = "",
  error = "",
  emptyText = "Chưa có tin nhắn.",
  phase = "",
  toolStatus = "",
  turnId = "",
  revision = 0,
  onCopyResponse
}) {
  const visualResponseText = useFrameCoalescedValue(responseText, working, turnId);
  const scroll = useReaderOwnedScroll(revision, working);
  const hasContent = Boolean(requestText || visualResponseText || working);
  const status = headline || (working ? "CodexPro đang xử lý…" : error ? "Job kết thúc với lỗi" : responseText ? "AI đã phản hồi xong" : "Chưa có tin nhắn");
  const waitingText = phase === "tool" && toolStatus
    ? `Đang dùng MCP: ${toolStatus}`
    : phase === "agent"
      ? "Đã xác minh title qua MCP · đang xử lý"
      : "Đang tự đặt title qua MCP và xử lý";

  return (
    <div className={`chat-response is-inline ${working ? "is-streaming" : ""}`} data-turn-id={turnId} data-stream-revision={revision}>
      <div className="chat-response-head">
        <div><span className="response-status-dot" /><strong>{status}</strong>{title && <small>{title}</small>}</div>
      </div>
      {hasContent ? <div className="latest-response chat-transcript" ref={scroll.scrollerRef} onWheel={scroll.onWheel} onTouchMove={scroll.onTouchMove} onScroll={scroll.onScroll}><div className="latest-message-scroll-content" ref={scroll.contentRef}>
        {requestText && <div className="chat-transcript-message is-user"><div className="chat-message-avatar">B</div><div className="latest-response-content"><span className="chat-message-role">Bạn</span><div className="chat-message-text user-message-text">{requestText}</div></div></div>}
        {(visualResponseText || working) && <div className="chat-transcript-message is-assistant is-response-runway">
          <div className="chat-message-avatar">✦</div>
          <div className="latest-response-content">
            <span className="chat-message-role">AI{title ? ` · ${title}` : ""}</span>
            {visualResponseText
              ? <><React.Suspense fallback={<div className="chat-message-text response-rich-text response-rich-loading">{visualResponseText}</div>}><ResponseText text={visualResponseText} streaming={working} /></React.Suspense>{working && <span className="live-stream-tail" aria-label="AI đang tiếp tục phản hồi"><span className="typing-dots"><i /><i /><i /></span></span>}</>
              : <span className="thinking-state latest-response-typing"><span>{waitingText}</span><span className="typing-dots"><i /><i /><i /></span></span>}
            {!working && responseText && onCopyResponse && <div className="chat-message-actions"><button type="button" className="chat-message-copy" title="Copy response" aria-label="Copy phản hồi" onClick={() => void onCopyResponse(responseText)}><CopyIcon /></button></div>}
          </div>
        </div>}
      </div></div> : error ? <div className="response-error">{error}</div> : <div className="response-empty">{emptyText}</div>}
      {!scroll.pinned && <div className="latest-message-back-slot"><button type="button" onClick={scroll.scrollToLatest}>Về cuối</button></div>}
    </div>
  );
}
