import React, { useState } from "react";
import { DiagnosticLogView } from "./diagnostic-log-view.jsx";
import { HangWatchView } from "./hang-watch-view.jsx";

export function DiagnosticsView({
  api,
  notify,
  data,
  filters,
  busy,
  selected,
  onFilters,
  onRefresh,
  onClear,
  onSelect,
  onCopy
}) {
  const [tab, setTab] = useState("logs");
  return (
    <div className="diagnostics-view">
      <div className="diagnostics-tabs" role="tablist" aria-label="Diagnostics">
        <button type="button" role="tab" aria-selected={tab === "logs"} className={tab === "logs" ? "is-active" : ""} onClick={() => setTab("logs")}>Logs</button>
        <button type="button" role="tab" aria-selected={tab === "hang-watch"} className={tab === "hang-watch" ? "is-active" : ""} onClick={() => setTab("hang-watch")}>Hang Watch</button>
      </div>
      {tab === "logs" ? (
        <DiagnosticLogView
          data={data}
          filters={filters}
          busy={busy}
          selected={selected}
          onFilters={onFilters}
          onRefresh={onRefresh}
          onClear={onClear}
          onSelect={onSelect}
          onCopy={onCopy}
        />
      ) : <HangWatchView api={api} notify={notify} />}
    </div>
  );
}
