import React from "react";
import workerHung from "../assets/worker-hung.gif";
import workerIdle from "../assets/worker-idle.gif";
import workerWorking from "../assets/worker-working.gif";

const workerIcons = {
  hung: { src: workerHung, label: "CodexPro mất kết nối extension" },
  idle: { src: workerIdle, label: "CodexPro đang rảnh" },
  working: { src: workerWorking, label: "CodexPro đang làm việc" }
};

const CHAT_GALAXY_ORBIT_STARS = [
  { size: 2, alpha: 0.72, distance: 30, duration: 7, delay: 1 },
  { size: 3, alpha: 0.86, distance: 38, duration: 11, delay: 4 },
  { size: 2, alpha: 0.58, distance: 44, duration: 9, delay: 7 },
  { size: 4, alpha: 0.82, distance: 50, duration: 15, delay: 2 },
  { size: 2, alpha: 0.66, distance: 56, duration: 13, delay: 8 },
  { size: 3, alpha: 0.78, distance: 62, duration: 17, delay: 5 },
  { size: 2, alpha: 0.54, distance: 68, duration: 12, delay: 9 },
  { size: 3, alpha: 0.9, distance: 74, duration: 19, delay: 3 },
  { size: 2, alpha: 0.64, distance: 80, duration: 14, delay: 6 },
  { size: 4, alpha: 0.76, distance: 86, duration: 18, delay: 10 },
  { size: 2, alpha: 0.7, distance: 92, duration: 16, delay: 2 },
  { size: 3, alpha: 0.56, distance: 98, duration: 20, delay: 7 }
];

const CHAT_GALAXY_STATIC_STARS = [
  { x: 18, y: 28, size: 2, alpha: 0.78 },
  { x: 34, y: 72, size: 3, alpha: 0.88 },
  { x: 68, y: 24, size: 2, alpha: 0.7 },
  { x: 82, y: 67, size: 3, alpha: 0.82 }
];

export function Dot({ ok }) {
  return <span className={`dot ${ok ? "ok" : "bad"}`} aria-hidden="true" />;
}

export function WorkerIcon({ state, customImages }) {
  const worker = workerIcons[state] || workerIcons.hung;
  const customSrc = customImages?.[state] || "";
  return (
    <div className={`profile-worker is-${state}`} title={worker.label}>
      <img src={customSrc || worker.src} alt={worker.label} />
      <span className="profile-worker-dot" aria-hidden="true" />
    </div>
  );
}

export function WorkingBadge() {
  return (
    <span className="badge profile-working">
      <span className="working-motion-icon" aria-hidden="true">
        <svg className="working-terminal-icon" viewBox="0 0 22 16">
          <rect x="1" y="1" width="17" height="13" rx="3" />
          <path d="m4.5 5 2.5 2-2.5 2" />
          <path className="working-terminal-caret" d="M9 9h4" />
        </svg>
        <svg className="working-cog-icon" viewBox="0 0 16 16">
          <path d="M6.8 1.4h2.4l.5 1.5 1.3.6 1.5-.6 1.2 2.1-1.1 1.1.1 1.5 1.3.9-1.2 2.1-1.6-.3-1.2.8-.3 1.6H7.3L7 11.1l-1.2-.8-1.6.3L3 8.5l1.3-.9.1-1.5L3.3 5l1.2-2.1 1.5.6 1.3-.6.5-1.5Z" />
          <circle cx="8" cy="7.7" r="2" />
        </svg>
      </span>
      <span>ĐANG LÀM VIỆC</span>
    </span>
  );
}

export function ChatGalaxyButtonContent() {
  return (
    <>
      <span className="chat-galaxy-backdrop" aria-hidden="true" />
      <span className="chat-galaxy-spark" aria-hidden="true" />
      <span className="chat-galaxy-static" aria-hidden="true">
        {CHAT_GALAXY_STATIC_STARS.map((star, index) => (
          <span key={`static-${index}`} className="chat-galaxy-star is-static" style={{ "--x": `${star.x}%`, "--y": `${star.y}%`, "--size": `${star.size}px`, "--alpha": star.alpha }} />
        ))}
      </span>
      <span className="chat-galaxy-orbit" aria-hidden="true">
        <span className="chat-galaxy-ring">
          {CHAT_GALAXY_ORBIT_STARS.map((star, index) => (
            <span key={`orbit-${index}`} className="chat-galaxy-star" style={{ "--size": `${star.size}px`, "--alpha": star.alpha, "--distance": `${star.distance}px`, "--duration": `${star.duration}s`, "--delay": `${star.delay}s` }} />
          ))}
        </span>
      </span>
      <span className="chat-galaxy-label">Chat</span>
    </>
  );
}
