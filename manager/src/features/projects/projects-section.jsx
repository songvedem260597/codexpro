import React from "react";
import { formatRepoActivity } from "../../project-dropdown.jsx";

export function ProjectsSection({
  projects,
  visibleProjects,
  busy,
  page,
  pageCount,
  pageSize,
  onAdd,
  onInspect,
  onOpenFolder,
  onRemove,
  onPageChange
}) {
  return (
    <section id="projects">
      <div className="section-head">
        <div><p className="eyebrow">WORKSPACES</p><h2>Repo và dự án</h2><p className="section-note">Tự quét Git repo trên Desktop, Documents, Downloads và toàn bộ ổ/thư mục đã cấp quyền cho CodexPro.</p></div>
        <button className="button secondary" onClick={onAdd} disabled={Boolean(busy)}>+ Thêm dự án</button>
      </div>
      <div className="project-list">
        {projects.length === 0 && <div className="empty">Chưa tìm thấy dự án CodexPro.</div>}
        {visibleProjects.map((project) => (
          <article className="project" key={project.root}>
            <div className="repo-icon">{project.name.slice(0, 1).toUpperCase()}</div>
            <div className="project-main">
              <div className="project-title"><strong>{project.name}</strong>{project.active ? <span className="badge">ĐANG CHẠY</span> : project.inUse ? <span className="badge">ĐANG CODE</span> : null}</div>
              <code>{project.root}</code>
              <div className="project-meta">
                {project.repoFullName && <span>{project.repoFullName}</span>}
                {formatRepoActivity(project) && <span className="recent-activity">{formatRepoActivity(project)}</span>}
                <span>{project.source}</span>
                <span>{project.isGit ? `nhánh ${project.branch}` : "không phải Git repo"}</span>
                {project.isGit && (
                  <span className={project.changes || project.behind || project.ahead ? "changed" : "clean"} title={project.commit?.subject || ""}>
                    Local: {project.commit?.hash || "—"} · Remote: {project.remoteCommitHash || "—"} · {project.behind ? `Máy đang chậm ${project.behind} commit` : project.ahead ? `Máy đang trước ${project.ahead} commit` : "Máy đã đồng bộ"} · {project.changes ? `${project.changes} file chưa commit` : "Không có file chưa commit"}
                  </span>
                )}
              </div>
            </div>
            <div className="project-actions">
              <button onClick={() => onInspect(project)} disabled={Boolean(busy)}>{busy === project.root ? "Đang kiểm tra..." : "Kiểm tra qua MCP"}</button>
              <button onClick={() => onOpenFolder(project.root)}>Mở thư mục</button>
              {!project.active && project.source === "Đã thêm" && <button className="remove" title="Bỏ khỏi danh sách" onClick={() => onRemove(project.root)}>×</button>}
            </div>
          </article>
        ))}
      </div>
      {projects.length > pageSize && (
        <nav className="project-pagination" aria-label="Phân trang repo và dự án">
          <span>{page * pageSize + 1}–{Math.min((page + 1) * pageSize, projects.length)} / {projects.length} repo</span>
          <div>
            <button type="button" onClick={() => onPageChange(Math.max(0, page - 1))} disabled={page === 0}>‹ Trước</button>
            <strong>Trang {page + 1} / {pageCount}</strong>
            <button type="button" onClick={() => onPageChange(Math.min(pageCount - 1, page + 1))} disabled={page >= pageCount - 1}>Sau ›</button>
          </div>
        </nav>
      )}
    </section>
  );
}
