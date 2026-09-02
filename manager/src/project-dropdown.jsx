import React, { useEffect, useRef, useState } from "react";

export const ALL_ALLOWED_WORKSPACES = "__codexpro_all_allowed__";

export function formatRepoActivity(project) {
  const timestamp = Date.parse(project?.activityAt || "");
  if (!Number.isFinite(timestamp)) return "";
  const elapsed = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(elapsed / 60000);
  const label = project.activityKind === "push" ? "push" : project.activityKind === "remote" ? "remote" : "commit";
  if (minutes < 1) return `${label} vừa xong`;
  if (minutes < 60) return `${label} ${minutes} phút trước`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${label} ${hours} giờ trước`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${label} ${days} ngày trước`;
  return `${label} ${new Date(timestamp).toLocaleDateString("vi-VN")}`;
}

export function ProjectDropdown({ value, projects = [], disabled, onChange, includeAllAllowed = true, ariaLabel = "Chọn dự án hoặc đường dẫn cần làm" }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef(null);
  const selected = projects.find((project) => project.root === value);
  const allAllowed = includeAllAllowed && value === ALL_ALLOWED_WORKSPACES;
  const normalizedQuery = query.trim().toLocaleLowerCase("vi-VN");
  const filteredProjects = normalizedQuery
    ? projects.filter((project) => [project.name, project.repoFullName, project.branch, project.root].some((field) => String(field || "").toLocaleLowerCase("vi-VN").includes(normalizedQuery)))
    : projects;

  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => {
      if (!root.current?.contains(event.target)) {
        setOpen(false);
        setQuery("");
      }
    };
    const escape = (event) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      setQuery("");
      root.current?.querySelector(".project-dropdown-trigger")?.focus();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const choose = (nextValue) => {
    onChange?.(nextValue);
    setOpen(false);
    setQuery("");
  };

  return (
    <div className={`project-dropdown ${open ? "is-open" : ""} ${disabled ? "is-disabled" : ""}`} ref={root}>
      <button type="button" className="project-dropdown-trigger" aria-haspopup="listbox" aria-expanded={open} aria-label={ariaLabel} disabled={disabled} onClick={() => { setOpen((current) => !current); if (open) setQuery(""); }}>
        <span className="project-dropdown-mark">{allAllowed ? "⌕" : "⌘"}</span>
        <span className="project-dropdown-value">
          <strong>{allAllowed ? "Tất cả vùng được cấp quyền" : selected?.name || "Chọn dự án hoặc đường dẫn"}</strong>
          <small>{allAllowed ? "Không khóa repo/đường dẫn · CodexPro có thể tìm trong toàn bộ vùng đã cấp quyền" : selected ? `${selected.repoFullName ? `${selected.repoFullName} · ` : ""}${selected.isGit ? (selected.branch || "git") : "thư mục"} · ${selected.root}` : includeAllAllowed ? "Chọn một workspace cụ thể hoặc tìm trên toàn bộ vùng được cấp quyền" : "Chọn một workspace cụ thể"}</small>
        </span>
        <svg className="project-dropdown-chevron" aria-hidden="true" viewBox="0 0 16 16"><path d="m4 6 4 4 4-4" /></svg>
      </button>
      {open && (
        <div className="project-dropdown-menu" role="listbox" aria-label={ariaLabel}>
          <div className="project-dropdown-search">
            <svg aria-hidden="true" viewBox="0 0 20 20"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></svg>
            <input autoFocus type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Tìm dự án, thư mục hoặc đường dẫn…" aria-label="Tìm dự án hoặc đường dẫn" />
            {query && <button type="button" aria-label="Xóa từ khóa" onClick={() => setQuery("")}>×</button>}
          </div>
          {includeAllAllowed && <button type="button" role="option" aria-selected={allAllowed} className={`project-dropdown-option project-dropdown-option-all ${allAllowed ? "is-selected" : ""}`} onClick={() => choose(ALL_ALLOWED_WORKSPACES)}>
            <span className="project-dropdown-mark">⌕</span>
            <span className="project-dropdown-copy"><strong>Tất cả vùng được cấp quyền</strong><small>Không khóa repo/đường dẫn · tìm trên mọi workspace được phép truy cập</small></span>
            {allAllowed && <span className="project-dropdown-check">✓</span>}
          </button>}
          {filteredProjects.map((project) => (
            <button type="button" role="option" aria-selected={project.root === value} className={`project-dropdown-option ${project.root === value ? "is-selected" : ""}`} key={project.root} onClick={() => choose(project.root)}>
              <span className="project-dropdown-mark">⌘</span>
              <span className="project-dropdown-copy"><strong>{project.name}</strong><small>{project.repoFullName ? `${project.repoFullName} · ` : ""}{project.isGit ? (project.branch || "git") : "thư mục"} · {project.root}</small></span>
              {formatRepoActivity(project) && <span className="project-dropdown-activity">{formatRepoActivity(project)}</span>}
              {project.changes > 0 && <span className="project-dropdown-changes">{project.changes} đổi</span>}
              {project.root === value && <span className="project-dropdown-check">✓</span>}
            </button>
          ))}
          {!filteredProjects.length && <div className="project-dropdown-empty">Không tìm thấy trong danh sách đã lưu.</div>}
        </div>
      )}
    </div>
  );
}
