import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles.css";
import { AttachmentPreviewModal } from "../src/features/chat/attachment-preview-modal.jsx";

const previews = {
  text: {
    loading: false,
    name: "notes.md",
    size: 2048,
    mimeType: "text/markdown",
    kind: "text",
    truncated: true,
    text: "# CodexPro attachment preview\n\nDòng tiếng Việt để kiểm tra typography và khoảng cách.\n\n- text preview\n- scroll độc lập\n- Escape để đóng"
  },
  image: {
    loading: false,
    name: "preview.svg",
    size: 1234,
    mimeType: "image/svg+xml",
    kind: "image",
    dataUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='960' height='540' viewBox='0 0 960 540'%3E%3Crect width='960' height='540' fill='%23131720'/%3E%3Crect x='100' y='80' width='760' height='380' rx='32' fill='%23242d3d'/%3E%3Ctext x='480' y='270' fill='white' font-size='48' text-anchor='middle' font-family='sans-serif'%3EAttachment Preview%3C/text%3E%3C/svg%3E"
  },
  loading: {
    loading: true,
    name: "large-log.txt",
    size: 8192,
    mimeType: "text/plain"
  },
  unsupported: {
    loading: false,
    name: "archive.zip",
    size: 4096,
    mimeType: "application/zip",
    kind: "unsupported",
    error: "Định dạng này chưa hỗ trợ xem trước."
  }
};

function Fixture() {
  const [preview, setPreview] = useState(previews.text);

  useEffect(() => {
    window.__openAttachmentPreview = (kind = "text") => setPreview(previews[kind] || previews.text);
    window.__attachmentPreviewState = () => ({ open: Boolean(preview), name: preview?.name || "" });
    return () => {
      delete window.__openAttachmentPreview;
      delete window.__attachmentPreviewState;
    };
  }, [preview]);

  return (
    <main style={{ minHeight: "100vh" }}>
      <AttachmentPreviewModal preview={preview} onClose={() => setPreview(null)} />
    </main>
  );
}

createRoot(document.getElementById("root")).render(<Fixture />);
