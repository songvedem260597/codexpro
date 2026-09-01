import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./app-plugin-center.css";

export function AppPluginCenter({ api, notify, onError }) {
  const [plugins, setPlugins] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState("");
  const [removeArmed, setRemoveArmed] = useState("");
  const [frameRevision, setFrameRevision] = useState(0);
  const pluginFrameRef = useRef(null);

  const reportError = useCallback((error) => {
    onError?.(error instanceof Error ? error : new Error(String(error)));
  }, [onError]);

  const load = useCallback(async () => {
    try {
      const [nextPlugins, nextCatalog] = await Promise.all([api.listAppPlugins(), api.listAppPluginCatalog()]);
      setPlugins(Array.isArray(nextPlugins) ? nextPlugins : []);
      setCatalog(Array.isArray(nextCatalog) ? nextCatalog : []);
    } catch (error) {
      reportError(error);
    }
  }, [api, reportError]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (selectedId && plugins.some((plugin) => plugin.id === selectedId)) return;
    setSelectedId(plugins.find((plugin) => plugin.status === "ready")?.id || plugins[0]?.id || "");
  }, [plugins, selectedId]);

  const selected = useMemo(() => plugins.find((plugin) => plugin.id === selectedId) || null, [plugins, selectedId]);
  const tasteSkill = useMemo(() => catalog.find((plugin) => plugin.id === "taste-skill") || null, [catalog]);

  useEffect(() => {
    const receivePluginMessage = (event) => {
      if (!pluginFrameRef.current || event.source !== pluginFrameRef.current.contentWindow) return;
      if (event.data?.type !== "codexpro:copy-text") return;
      const text = String(event.data?.text || "");
      if (!text || text.length > 250_000) {
        reportError(new Error("Plugin gửi nội dung copy không hợp lệ."));
        return;
      }
      void api.copyText(text)
        .then(() => notify?.(`Đã copy skill “${String(event.data?.label || selected?.name || "plugin").slice(0, 80)}”`))
        .catch(reportError);
    };
    window.addEventListener("message", receivePluginMessage);
    return () => window.removeEventListener("message", receivePluginMessage);
  }, [api, notify, reportError, selected?.name]);

  async function install() {
    setBusy("install");
    setRemoveArmed("");
    try {
      const result = await api.installAppPlugin();
      setPlugins(Array.isArray(result?.plugins) ? result.plugins : []);
      if (!result?.cancelled && result?.plugin?.id) {
        setSelectedId(result.plugin.id);
        setFrameRevision((current) => current + 1);
        notify?.(`Đã cài plugin “${result.plugin.name}” mà không cần restart`);
      }
    } catch (error) {
      reportError(error);
    } finally {
      setBusy("");
    }
  }

  async function reload(plugin) {
    setBusy(`reload:${plugin.id}`);
    setRemoveArmed("");
    try {
      const result = await api.reloadAppPlugin(plugin.id);
      setPlugins(Array.isArray(result?.plugins) ? result.plugins : []);
      setSelectedId(plugin.id);
      setFrameRevision((current) => current + 1);
      notify?.(`Đã nạp lại plugin “${result?.plugin?.name || plugin.name}”`);
    } catch (error) {
      await load();
      reportError(error);
    } finally {
      setBusy("");
    }
  }

  async function installCatalogPlugin(plugin) {
    const action = plugin.installed ? "update" : "install";
    setBusy(`${action}-catalog:${plugin.id}`);
    setRemoveArmed("");
    try {
      const result = plugin.installed
        ? await api.updateCatalogAppPlugin(plugin.id)
        : await api.installCatalogAppPlugin(plugin.id);
      setPlugins(Array.isArray(result?.plugins) ? result.plugins : []);
      setCatalog(Array.isArray(result?.catalog) ? result.catalog : []);
      setSelectedId(plugin.id);
      setFrameRevision((current) => current + 1);
      notify?.(`${plugin.installed ? "Đã cập nhật" : "Đã cài"} ${plugin.name} · ${Number(result?.skill_count) || 0} skill`);
    } catch (error) {
      await load();
      reportError(error);
    } finally {
      setBusy("");
    }
  }

  async function uninstall(plugin) {
    if (removeArmed !== plugin.id) {
      setRemoveArmed(plugin.id);
      return;
    }
    setBusy(`remove:${plugin.id}`);
    try {
      const result = await api.uninstallAppPlugin(plugin.id);
      setPlugins(Array.isArray(result?.plugins) ? result.plugins : []);
      setCatalog(await api.listAppPluginCatalog());
      setRemoveArmed("");
      setFrameRevision((current) => current + 1);
      notify?.(`Đã gỡ plugin “${plugin.name}”. Repo vẫn được giữ nguyên.`);
    } catch (error) {
      reportError(error);
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="app-plugin-center">
      <div className="app-plugin-toolbar">
        <div>
          <p className="eyebrow">REPOSITORY PLUGINS</p>
          <h2>Plugin đã cài</h2>
          <p className="section-note">Repo plugin chạy trong khung riêng. Cài, reload hoặc gỡ không restart Manager và không dừng worker.</p>
        </div>
        <button className="button primary" type="button" onClick={() => void install()} disabled={Boolean(busy)}>
          {busy === "install" ? "Đang đọc manifest…" : "+ Cài từ repo"}
        </button>
      </div>

      {tasteSkill && (
        <article className={`app-plugin-catalog-card ${tasteSkill.installed ? "is-installed" : ""}`}>
          <div className="app-plugin-catalog-mark">T</div>
          <div className="app-plugin-catalog-copy">
            <div><span>FEATURED SKILL REPOSITORY</span>{tasteSkill.installed && <b>ĐÃ CÀI</b>}</div>
            <h3>Taste Skill</h3>
            <p>{tasteSkill.description}</p>
            <small>{tasteSkill.skill_count ? `${tasteSkill.skill_count} skill` : "GPT/Codex · Frontend · Redesign · Image-to-code"}{tasteSkill.source_commit ? ` · ${tasteSkill.source_commit.slice(0, 12)}` : ""}</small>
          </div>
          <button className={`button ${tasteSkill.installed ? "secondary" : "primary"}`} type="button" onClick={() => void installCatalogPlugin(tasteSkill)} disabled={Boolean(busy)}>
            {busy === `install-catalog:${tasteSkill.id}` ? "Đang tải repo…" : busy === `update-catalog:${tasteSkill.id}` ? "Đang cập nhật…" : tasteSkill.installed ? "Cập nhật" : "Cài Taste Skill"}
          </button>
        </article>
      )}

      <div className="app-plugin-layout">
        <aside className="app-plugin-list" aria-label="Danh sách plugin ứng dụng">
          {!plugins.length ? (
            <div className="app-plugin-empty">
              <strong>Chưa có plugin</strong>
              <span>Chọn repo chứa <code>.codexpro-plugin/plugin.json</code> để cài.</span>
            </div>
          ) : plugins.map((plugin) => (
            <button
              type="button"
              key={plugin.id}
              className={`app-plugin-list-item ${selectedId === plugin.id ? "is-selected" : ""} ${plugin.status === "broken" ? "is-broken" : ""}`}
              onClick={() => { setSelectedId(plugin.id); setRemoveArmed(""); }}
            >
              <span className={`app-plugin-status ${plugin.status === "ready" ? "is-ready" : "is-broken"}`} aria-hidden="true" />
              <span className="app-plugin-list-copy">
                <strong>{plugin.name}</strong>
                <small>{plugin.status === "ready" ? `v${plugin.version}` : "Cần kiểm tra repo"}</small>
              </span>
            </button>
          ))}
        </aside>

        <div className="app-plugin-stage">
          {!selected ? (
            <div className="app-plugin-stage-empty">
              <span>◇</span>
              <strong>Chọn hoặc cài một plugin</strong>
              <p>Giao diện plugin sẽ mở tại đây như một tab bên trong CodexPro.</p>
            </div>
          ) : (
            <>
              <div className="app-plugin-stage-head">
                <div>
                  <div className="app-plugin-title-row">
                    <h3>{selected.name}</h3>
                    <span className={`app-plugin-badge ${selected.status === "ready" ? "is-ready" : "is-broken"}`}>
                      {selected.status === "ready" ? "ĐANG BẬT" : "PLUGIN LỖI"}
                    </span>
                  </div>
                  <p>{selected.description || selected.repo_root}</p>
                  <code title={selected.repo_root}>{selected.repo_root}</code>
                </div>
                <div className="app-plugin-actions">
                  <button className="button secondary" type="button" onClick={() => void reload(selected)} disabled={Boolean(busy)}>
                    {busy === `reload:${selected.id}` ? "Đang reload…" : "Reload plugin"}
                  </button>
                  <button
                    className={`button danger-quiet ${removeArmed === selected.id ? "is-armed" : ""}`}
                    type="button"
                    onClick={() => void uninstall(selected)}
                    disabled={Boolean(busy)}
                    title="Chỉ gỡ khỏi CodexPro Manager; không xóa thư mục repo"
                  >
                    {busy === `remove:${selected.id}` ? "Đang gỡ…" : removeArmed === selected.id ? "Xác nhận gỡ" : "Gỡ plugin"}
                  </button>
                </div>
              </div>
              <div className="app-plugin-preserve-note"><b>Không xóa repo.</b> Gỡ plugin chỉ bỏ đăng ký khỏi Manager.</div>
              {selected.status === "ready" ? (
                <iframe
                  ref={pluginFrameRef}
                  key={`${selected.id}:${frameRevision}`}
                  className="app-plugin-frame"
                  title={`Plugin ${selected.name}`}
                  src={`${selected.url}?revision=${frameRevision}`}
                  sandbox="allow-scripts allow-forms allow-downloads"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="app-plugin-broken-panel" role="alert">
                  <strong>Không thể mở giao diện plugin</strong>
                  <p>{selected.error}</p>
                  <span>Sửa hoặc build lại repo rồi bấm <b>Reload plugin</b>. Manager và worker vẫn tiếp tục chạy bình thường.</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
