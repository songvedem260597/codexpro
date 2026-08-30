import React from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";

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

export const ResponseText = React.memo(function ResponseText({ text, truncated }) {
  const cleanText = String(text || "")
    .replace(/[^\r\n]*/g, "")
    .replace(/[ \t]+\n/g, "\n");
  const source = `${cleanText}${truncated ? "\n\n> [Đã rút gọn khi hiển thị]" : ""}`;

  return (
    <div className="chat-message-text response-rich-text">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
        components={components}
        skipHtml
      >
        {source}
      </ReactMarkdown>
    </div>
  );
});
