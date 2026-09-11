import React, { useCallback, useEffect, useMemo, useState } from "react";

const STATE_LABEL = {
  HEALTHY: "HEALTHY",
  WARNING: "WARNING",
  FREEZE_DETECTED: "FREEZE DETECTED",
  RECOVERED: "RECOVERED"
};

function time(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString("vi-VN", { hour12: false }) : "--";
}

function duration(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) return "--";
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`;
}

function bytes(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return "--";
  return `${(amount / (1024 * 1024)).toFixed(1)} MB`;
}

function age(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms >= 0 ? duration(ms) : "--";
}

function metric(value, suffix = "") {
  return value == null || value === "" || !Number.isFinite(Number(value)) ? "--" : `${Number(value)}${suffix}`;
}

function StateBadge({ state }) {
  const normalized = String(state || "WARNING");
  return <span className={`hang-watch-state is-${normalized.toLowerCase().replaceAll("_", "-")}`}>{STATE_LABEL[normalized] || normalized}</span>;
}

function Correlation({ values }) {
  const rows = Array.isArray(values) ? values : [];
  if (!rows.length) return <span className="hang-watch-muted">Không có correlation.</span>;
  return (
    <div className="hang-watch-correlations">
      {rows.map((item, index) => (
        <code key={`${item.profile_id || "ctx"}-${index}`}>
          {[item.profile_id && `profile=${item.profile_id}`, item.task_id && `task=${item.task_id}`, item.conversation_id && `conversation=${item.conversation_id}`, item.tab_id && `tab=${item.tab_id}`].filter(Boolean).join(" · ")}
        </code>
      ))}
    </div>
  );
}

function IncidentDetail({ incident, onCopy }) {
  if (!incident) return null;
  const evidence = Array.isArray(incident.pre_freeze_evidence) ? incident.pre_freeze_evidence : [];
  return (
    <section className="hang-watch-panel hang-watch-detail">
      <div className="hang-watch-panel-head">
        <div><p className="eyebrow">INCIDENT DETAIL</p><h3>{incident.incident_id || "Incident"}</h3></div>
        <button className="button subtle" type="button" onClick={() => onCopy(incident)}>Copy chi tiết</button>
      </div>
      <div className="hang-watch-detail-grid">
        <span>Trạng thái<strong><StateBadge state={incident.state} /></strong></span>
        <span>Phát hiện<strong>{time(incident.detected_at)}</strong></span>
        <span>Hồi phục<strong>{incident.recovered ? time(incident.recovered_at) : "Chưa"}</strong></span>
        <span>Thời lượng<strong>{duration(incident.duration_ms)}</strong></span>
        <span>Peak event-loop<strong>{metric(incident.peak_event_loop_delay_ms, " ms")}</strong></span>
        <span>Oldest MCP / read<strong>{age(incident.oldest_mcp_age_ms)} / {age(incident.oldest_response_read_age_ms)}</strong></span>
      </div>
      <div className="hang-watch-subsection"><strong>Trigger signals</strong><div className="hang-watch-tags">{(incident.active_signals || []).map((signal) => <span key={signal}>{signal}</span>)}</div></div>
      <div className="hang-watch-subsection"><strong>Correlation</strong><Correlation values={incident.correlations} /></div>
      <details className="hang-watch-evidence">
        <summary>Pre-freeze evidence ({evidence.length})</summary>
        {evidence.length ? evidence.map((snapshot, index) => (
          <div className="hang-watch-evidence-row" key={`${snapshot.timestamp}-${index}`}>
            <strong>{time(snapshot.timestamp)}</strong>
            <span>renderer {snapshot.renderer?.responsive === false ? "unresponsive" : "responsive"}</span>
            <span>event-loop {metric(snapshot.event_loop?.peak_delay_ms, " ms")}</span>
            <span>MCP {snapshot.mcp?.in_flight ?? 0} · read {snapshot.response_reads?.in_flight ?? 0} · browser {snapshot.browser_stream?.backlog ?? 0}</span>
          </div>
        )) : <p className="hang-watch-muted">Không có snapshot pre-freeze.</p>}
      </details>
    </section>
  );
}

export function HangWatchView({ api, notify }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [selected, setSelected] = useState(null);

  const load = useCallback(async ({ incidentId = "" } = {}) => {
    setBusy(true);
    setError("");
    try {
      const next = await api.getHangWatchDiagnostics(incidentId ? { incident_id: incidentId } : {});
      setData(next || null);
      setSelected(next?.selected_incident || null);
    } catch (loadError) {
      setError(loadError?.message || String(loadError));
    } finally {
      setBusy(false);
    }
  }, [api]);

  useEffect(() => { void load({ incidentId: "" }); }, [load]);

  const selectIncident = useCallback((incident) => {
    const id = String(incident?.incident_id || "");
    setSelectedId(id);
    if (id) void load({ incidentId: id });
  }, [load]);

  const current = data?.current || null;
  const incidents = Array.isArray(data?.recent_incidents) ? data.recent_incidents : [];
  const issueText = useMemo(() => (data?.issues || []).join(" · "), [data?.issues]);

  return (
    <div className="hang-watch-view">
      <section className="hang-watch-hero">
        <div>
          <p className="eyebrow">MANAGER HANG / FREEZE FLIGHT RECORDER</p>
          <div className="hang-watch-title-row"><h2>Theo dõi treo</h2><StateBadge state={data?.state || "WARNING"} /></div>
          <p className="hang-watch-muted">Đọc checkpoint và incident đã được recorder ghi sẵn. Không tạo sampler hoặc hành động recovery mới.</p>
        </div>
        <button className="button" type="button" disabled={busy} onClick={() => void load({ incidentId: selectedId })}>{busy ? "Đang đọc…" : "Làm mới"}</button>
      </section>

      {error && <div className="hang-watch-error">{error}</div>}
      <section className="hang-watch-summary-grid">
        <article><span>Recorder</span><strong>{data?.enabled ? "Đang chạy" : "Không xác nhận"}</strong><small>Sample gần nhất: {time(data?.last_sample_at)}</small></article>
        <article><span>Renderer</span><strong>{current ? (current.renderer_responsive ? "Responsive" : "Unresponsive") : "--"}</strong><small>Event-loop: {metric(current?.event_loop_delay_ms, " ms")} · peak {metric(current?.event_loop_peak_ms, " ms")}</small></article>
        <article><span>CPU / RAM</span><strong>{metric(current?.cpu_percent, "%")} / {bytes(current?.rss)}</strong><small>Manager PID: {current?.manager_pid || "--"}</small></article>
        <article><span>MCP / response-read</span><strong>{current?.mcp_in_flight ?? "--"} / {current?.response_reads ?? "--"}</strong><small>Oldest: {age(current?.mcp_oldest_age_ms)} / {age(current?.response_read_oldest_age_ms)}</small></article>
        <article><span>Browser IPC</span><strong>{current?.browser_backlog ?? "--"} backlog</strong><small>Last progress: {age(current?.browser_last_progress_age_ms)}</small></article>
        <article><span>Runtime</span><strong>{current?.runtime_ok == null ? "--" : current.runtime_ok ? "Healthy" : "Unhealthy"}</strong><small>Health age {age(current?.runtime_health_age_ms)} · child PIDs {(current?.child_pids || []).join(", ") || "--"}</small></article>
      </section>

      {issueText && <div className="hang-watch-note"><strong>Recorder status:</strong> {issueText}</div>}
      {data?.checkpoint?.persisted_active_incident && !data?.active_incident && (
        <div className="hang-watch-note"><strong>Persisted incident trước restart:</strong> {data.checkpoint.persisted_active_incident.incident_id} · {time(data.checkpoint.persisted_active_incident.detected_at)}</div>
      )}

      <section className="hang-watch-panel">
        <div className="hang-watch-panel-head"><div><p className="eyebrow">RECENT INCIDENTS</p><h3>Incident gần đây</h3></div><span className="hang-watch-muted">Tối đa {data?.limits?.recent_incidents || 20}</span></div>
        {incidents.length ? (
          <div className="hang-watch-incidents">
            {incidents.map((incident) => (
              <button className={`hang-watch-incident ${selectedId === incident.incident_id ? "is-selected" : ""}`} type="button" key={incident.incident_id} onClick={() => selectIncident(incident)}>
                <span><StateBadge state={incident.state} /><strong>{time(incident.detected_at)}</strong></span>
                <span>{duration(incident.duration_ms)}</span>
                <span>{(incident.active_signals || []).join(", ") || "Không có signal"}</span>
                <span>{incident.renderer?.responsive === false ? "renderer unresponsive" : "renderer responsive"}</span>
              </button>
            ))}
          </div>
        ) : <p className="hang-watch-empty">Chưa có incident được recorder lưu.</p>}
      </section>

      <IncidentDetail incident={selected} onCopy={(incident) => {
        void api.copyText(JSON.stringify(incident, null, 2));
        notify?.("Đã copy chi tiết Hang Watch");
      }} />
    </div>
  );
}
