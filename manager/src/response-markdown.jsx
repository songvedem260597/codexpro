import React from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import { useFrameCoalescedValue } from "./use-frame-coalesced-value.js";

function safeMarkdownHref(value) {
  const href = String(value || "").trim();
  return /^(?:https?:\/\/|mailto:)/i.test(href) ? href : "";
}

function openExternalLink(event, href) {
  const openExternal = globalThis.window?.codexpro?.openExternal;
  if (typeof openExternal !== "function") return;
  event.preventDefault();
  Promise.resolve(openExternal(href)).catch(() => undefined);
}

const components = {
  a: ({ href, children, ...props }) => {
    const safeHref = safeMarkdownHref(href);
    return safeHref
      ? <a {...props} href={safeHref} target="_blank" rel="noreferrer" onClick={(event) => openExternalLink(event, safeHref)}>{children}</a>
      : <span className="response-unsafe-link">{children}</span>;
  },
  h1: ({ children, ...props }) => <h1 {...props} className="response-heading">{children}</h1>,
  h2: ({ children, ...props }) => <h2 {...props} className="response-heading">{children}</h2>,
  h3: ({ children, ...props }) => <h3 {...props} className="response-heading">{children}</h3>,
  h4: ({ children, ...props }) => <h4 {...props} className="response-heading">{children}</h4>,
  h5: ({ children, ...props }) => <h5 {...props} className="response-heading">{children}</h5>,
  h6: ({ children, ...props }) => <h6 {...props} className="response-heading">{children}</h6>,
  blockquote: ({ children, ...props }) => <blockquote {...props} className="response-quote">{children}</blockquote>,
  ul: ({ className = "", children, ...props }) => <ul {...props} className={`response-list response-bullets ${className}`.trim()}>{children}</ul>,
  ol: ({ className = "", children, ...props }) => <ol {...props} className={`response-list response-numbered ${className}`.trim()}>{children}</ol>,
  pre: ({ children, ...props }) => {
    const child = React.Children.toArray(children)[0];
    const language = React.isValidElement(child)
      ? String(child.props?.className || "").match(/language-([^\s]+)/)?.[1] || ""
      : "";
    return <pre {...props} className="response-code-block" data-language={language || undefined}>{children}</pre>;
  },
  code: ({ className = "", children, ...props }) => className
    ? <code {...props} className={className}>{children}</code>
    : <code {...props} className="response-inline-code">{children}</code>,
  table: ({ children, ...props }) => <div className="response-table-wrap"><table {...props} className="response-table">{children}</table></div>,
  hr: (props) => <hr {...props} className="response-rule" />,
  input: ({ type, ...props }) => type === "checkbox"
    ? <input {...props} type="checkbox" className="response-task-checkbox" disabled />
    : <input {...props} type={type} disabled />,
  img: ({ src, alt }) => {
    const safeHref = safeMarkdownHref(src);
    return safeHref
      ? <a className="response-image-link" href={safeHref} target="_blank" rel="noreferrer" onClick={(event) => openExternalLink(event, safeHref)}>Ảnh: {alt || safeHref}</a>
      : <span className="response-image-link">Ảnh: {alt || "không có mô tả"}</span>;
  }
};

function markdownBlockRanges(source) {
  if (!source) return [];
  const ranges = [];
  let start = 0;
  let offset = 0;
  let fence = "";
  const lines = source.match(/.*(?:\r?\n|$)/g)?.filter(Boolean) || [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/)?.[1] || "";
    if (marker) {
      if (!fence) fence = marker[0];
      else if (marker[0] === fence) fence = "";
    }
    offset += line.length;
    const next = lines[index + 1] || "";
    if (!fence && /^\s*$/.test(line) && next && !/^\s*$/.test(next)) {
      ranges.push({ start, end: offset });
      start = offset;
    }
  }
  if (start < source.length) ranges.push({ start, end: source.length });
  return ranges.filter((range) => source.slice(range.start, range.end).trim());
}

export function partitionStreamingMarkdown(value, options = {}) {
  const source = String(value || "");
  const mutableBlocks = Math.max(1, Number(options.mutableBlocks) || 2);
  const ranges = markdownBlockRanges(source);
  const frozenCount = Math.max(0, ranges.length - mutableBlocks);
  const frozen = ranges.slice(0, frozenCount).map((range) => ({
    ...range,
    key: `markdown:${range.start}:${range.end}`,
    text: source.slice(range.start, range.end)
  }));
  const tailStart = ranges[frozenCount]?.start ?? 0;
  return {
    frozen,
    tail: {
      start: tailStart,
      end: source.length,
      key: `markdown-tail:${tailStart}`,
      text: source.slice(tailStart)
    }
  };
}

const MarkdownBlock = React.memo(function MarkdownBlock({ source, blockKey, tail = false }) {
  return <div className={tail ? "response-markdown-tail" : "response-markdown-frozen"} data-markdown-block={blockKey}><ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks, remarkMath]} rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]} components={components} skipHtml>{source}</ReactMarkdown></div>;
});

export const ResponseText = React.memo(function ResponseText({ text, truncated, streaming = false }) {
  const incomingText = String(text || "");
  const previousIncoming = React.useRef("");
  const settleTimer = React.useRef(0);
  const [appendStreaming, setAppendStreaming] = React.useState(false);
  const appendOnlyUpdate = Boolean(previousIncoming.current && incomingText.length > previousIncoming.current.length && incomingText.startsWith(previousIncoming.current));
  previousIncoming.current = incomingText;
  React.useEffect(() => {
    if (!appendOnlyUpdate) return undefined;
    setAppendStreaming(true);
    globalThis.clearTimeout(settleTimer.current);
    settleTimer.current = globalThis.setTimeout(() => setAppendStreaming(false), 160);
    return () => globalThis.clearTimeout(settleTimer.current);
  }, [incomingText]);
  const activelyStreaming = streaming || appendOnlyUpdate || appendStreaming;
  const visualText = useFrameCoalescedValue(incomingText, activelyStreaming);
  const cleanText = visualText
    .replace(/[^\r\n]*/g, "")
    .replace(/[ \t]+\n/g, "\n");
  const source = `${cleanText}${truncated ? "\n\n> [Đã rút gọn khi hiển thị]" : ""}`;

  const partition = React.useMemo(() => partitionStreamingMarkdown(source, { mutableBlocks: 2 }), [source]);

  return (
    <div className="chat-message-text response-rich-text">
      {activelyStreaming ? <>
        {partition.frozen.map((block) => <MarkdownBlock key={block.key} blockKey={block.key} source={block.text} />)}
        <MarkdownBlock key={partition.tail.key} blockKey={partition.tail.key} source={partition.tail.text} tail />
      </> : <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks, remarkMath]} rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]} components={components} skipHtml>{source}</ReactMarkdown>}
    </div>
  );
});
