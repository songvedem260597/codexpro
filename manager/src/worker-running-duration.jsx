import React, { useEffect, useState } from "react";
import { formatWorkerRunningDuration } from "./worker-running-duration.js";

export function WorkerRunningDuration({ startedAt, finishedAt = "" }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    if (finishedAt) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt, finishedAt]);

  const finishedAtMs = Date.parse(String(finishedAt || ""));
  const label = formatWorkerRunningDuration(startedAt, Number.isFinite(finishedAtMs) ? finishedAtMs : now);
  return label ? <code className="profile-run-duration" title="Thời lượng task">Hoạt động trong {label}</code> : null;
}
