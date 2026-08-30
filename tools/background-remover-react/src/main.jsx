import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const api = window.backgroundRemover;

function formatBytes(bytes = 0) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function Icon({ name }) {
  const paths = {
    upload: <><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M5 20h14"/></>,
    sparkles: <><path d="m12 3 1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2L12 3Z"/><path d="m5 14 .8 2.2L8 17l-2.2.8L5 20l-.8-2.2L2 17l2.2-.8L5 14Z"/><path d="m19 13 .6 1.4L21 15l-1.4.6L19 17l-.6-1.4L17 15l1.4-.6L19 13Z"/></>,
    folder: <><path d="M3 7h6l2 2h10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/><path d="M3 9V6a2 2 0 0 1 2-2h4l2 3"/></>,
    image: <><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="m4 17 5-4 4 3 3-3 5 4"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    heart: <path d="M20.8 5.7a5.5 5.5 0 0 0-7.8 0L12 6.8l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 22l7.8-7.4 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z"/>
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

function Preview({ label, file, emptyText, result }) {
  return (
    <section className={`preview-card ${result ? "is-result" : ""}`}>
      <div className="preview-head">
        <span>{label}</span>
        {file && <em>{file.width} × {file.height}</em>}
      </div>
      <div className="checkerboard preview-stage">
        {file ? <img src={file.dataUrl} alt={file.name} /> : (
          <div className="preview-empty"><Icon name="image"/><strong>{emptyText}</strong><small>PNG, JPG, GIF hoặc WEBP</small></div>
        )}
      </div>
      <div className="file-meta">
        {file ? <><strong title={file.path}>{file.name}</strong><span>{formatBytes(file.bytes)}</span></> : <><strong>Chưa có ảnh</strong><span>—</span></>}
      </div>
    </section>
  );
}

function App() {
  const [input, setInput] = useState(null);
  const [output, setOutput] = useState(null);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("Sẵn sàng");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const removeProgressListener = api.onProgress(({ percent, status: nextStatus }) => {
      setProgress(percent);
      setStatus(nextStatus);
    });
    const removeOpenListener = api.onOpenedFile((selected) => {
      setInput(selected);
      setOutput(null);
      setProgress(0);
      setStatus("Ảnh đã sẵn sàng");
    });
    return () => {
      removeProgressListener();
      removeOpenListener();
    };
  }, []);

  const progressLabel = useMemo(() => `${Math.round(progress)}%`, [progress]);
  const isGif = input?.name?.toLowerCase().endsWith(".gif") ?? false;

  async function chooseImage() {
    setError("");
    const selected = await api.chooseImage();
    if (!selected) return;
    setInput(selected);
    setOutput(null);
    setProgress(0);
    setStatus("Ảnh đã sẵn sàng");
  }

  async function loadDropped(file) {
    setError("");
    try {
      const filePath = api.pathForFile(file);
      const selected = await api.loadPath(filePath);
      setInput(selected);
      setOutput(null);
      setProgress(0);
      setStatus("Ảnh đã sẵn sàng");
    } catch (nextError) {
      setError(nextError.message || String(nextError));
    }
  }

  async function removeBackground() {
    if (!input || busy) return;
    setBusy(true);
    setOutput(null);
    setError("");
    setProgress(2);
    try {
      const result = await api.removeBackground({ inputPath: input.path });
      setOutput(result);
      setProgress(100);
      setStatus("Hoàn tất · nền đã trong suốt");
    } catch (nextError) {
      setError(nextError.message || String(nextError));
      setProgress(0);
      setStatus("Xử lý chưa thành công");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="app-shell" onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDragging(false); }} onDrop={(event) => { event.preventDefault(); setDragging(false); if (event.dataTransfer.files[0]) void loadDropped(event.dataTransfer.files[0]); }}>
      <div className="ambient ambient-one"/><div className="ambient ambient-two"/><div className="noise"/>
      {dragging && <div className="drop-overlay"><Icon name="upload"/><strong>Thả ảnh vào đây</strong><span>Xóa nền và giữ lại chi tiết ảnh</span></div>}

      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><Icon name="sparkles"/></div>
          <div><h1>CodexPro <span>Xóa Nền</span></h1><p>Pixel-perfect background cleaner</p></div>
        </div>
        <div className="top-actions">
          <div className="privacy-pill"><i/><span>LOCAL · OFFLINE</span></div>
          <button className="secondary-button" onClick={chooseImage}><Icon name="folder"/>Chọn ảnh</button>
        </div>
      </header>

      <div className={`content-dock ${input ? "has-image" : "is-empty"}`}>
        {!input ? (
          <button className="hero-drop" onClick={chooseImage}>
            <div className="hero-icon"><Icon name="upload"/></div>
            <h2>Kéo ảnh vào để bắt đầu</h2>
            <p>Thả PNG, JPG, GIF hoặc WEBP vào vùng này</p>
            <span className="hero-choose"><Icon name="folder"/>Chọn ảnh từ máy</span>
            <div className="feature-row"><span><Icon name="check"/>Giữ chi tiết</span><span><Icon name="check"/>GIF động</span><span><Icon name="check"/>Nền alpha sạch</span></div>
          </button>
        ) : (
          <div className="workspace">
            <Preview label="01 · Ảnh gốc" file={input} emptyText="Chọn ảnh đầu vào" />
            <div className="flow-arrow"><span>→</span></div>
            <Preview label="02 · Kết quả" file={output} emptyText={busy ? "Đang xử lý…" : "Bấm Xóa nền để xem"} result />
          </div>
        )}

        <section className="control-deck">
          <div className="control-copy">
            <div className="status-line"><span className={busy ? "pulse-dot" : output ? "done-dot" : "ready-dot"}/><strong>{status}</strong></div>
          <p>{output ? output.path : input ? isGif ? "AI nhận diện chủ thể từng frame và giữ nguyên chuyển động." : "AI tự nhận diện người hoặc vật thể trong ảnh." : "Chọn ảnh để bật công cụ."}</p>
        </div>
          <div className="ai-control">
            <div className="ai-badge"><Icon name="sparkles"/><span>AI</span></div>
            <strong>AI giữ trọn trang phục</strong>
            <p>{isGif ? "Xử lý riêng từng frame GIF" : "Làm sạch mũ, tóc và quần áo"}</p>
          </div>
          <div className="progress-block">
            <div className="progress-number">{progressLabel}</div>
            <div className="progress-track"><i style={{ width: `${progress}%` }}/></div>
          </div>
          <div className="deck-actions">
            {output && <button className="ghost-button" onClick={() => api.reveal(output.path)}><Icon name="folder"/>Mở Finder</button>}
            <button className="primary-button" disabled={!input || busy} onClick={removeBackground}>
              <Icon name="sparkles"/>{busy ? "Đang xóa nền…" : "Xóa nền"}
            </button>
          </div>
        </section>
      </div>

      <footer><span><Icon name="check"/>Thiết kế để giữ chi tiết ảnh</span><em>{isGif ? "BiRefNet AI · Animated GIF" : "BiRefNet AI · Local / Offline"}</em></footer>
      {error && <div className="error-toast"><strong>Có lỗi xảy ra</strong><span>{error}</span><button onClick={() => setError("")}>×</button></div>}
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
