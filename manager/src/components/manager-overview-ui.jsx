import React from "react";
import { Dot } from "./worker-ui.jsx";

export function StatusCard({ label, ok, value, detail }) {
  return (
    <article className={`status-card ${ok ? "is-ok" : "is-bad"}`}>
      <div className="status-label"><Dot ok={ok} />{label}</div>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

export function Icon({ children }) {
  return <span className="icon" aria-hidden="true">{children}</span>;
}

function ProfileSummaryIcon({ state, missing }) {
  if (missing) {
    return (
      <svg className="profile-summary-svg" viewBox="0 0 24 24" aria-hidden="true">
        <path className="summary-missing-plug" d="M8 3v5M12 3v5M6 8h8v2a4 4 0 0 1-4 4v3" />
        <path className="summary-missing-plus" d="M16 16h6M19 13v6" />
      </svg>
    );
  }
  if (state === "working") {
    return (
      <svg className="profile-summary-svg" viewBox="0 0 24 24" aria-hidden="true">
        <path className="summary-working-bolt" d="m13.5 2-8 12h6l-1 8 8-12h-6l1-8Z" />
        <circle className="summary-working-spark" cx="18.4" cy="5.2" r="1.25" />
      </svg>
    );
  }
  if (state === "idle") {
    return (
      <svg className="profile-summary-svg" viewBox="0 0 24 24" aria-hidden="true">
        <circle className="summary-idle-ring" cx="12" cy="12" r="9" />
        <path className="summary-idle-check" d="m8 12 2.6 2.6L16.5 9" />
      </svg>
    );
  }
  return (
    <svg className="profile-summary-svg" viewBox="0 0 24 24" aria-hidden="true">
      <path className="summary-hung-triangle" d="M12 3 2.8 20h18.4L12 3Z" />
      <path className="summary-hung-mark" d="M12 9v5" />
      <circle className="summary-hung-dot" cx="12" cy="17.25" r=".75" />
    </svg>
  );
}

export function ProfileSummaryItem({ state, count, label, missing = false }) {
  return (
    <span className={`profile-summary-item is-${state}${missing ? " is-missing" : ""}`}>
      <span className="profile-summary-icon">
        <ProfileSummaryIcon state={state} missing={missing} />
      </span>
      <strong>{count}</strong>
      <span>{label}</span>
    </span>
  );
}

export function TitleGalaxyAccent() {
  return <span className="title-accent title-galaxy-accent">Multi</span>;
}
