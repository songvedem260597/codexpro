const state = { catalog: null, focused: "", selected: [], query: "", notice: "" };
const elements = {
  search: document.querySelector("#search"),
  skills: document.querySelector("#skills"),
  count: document.querySelector("#count"),
  selectedCount: document.querySelector("#selected-count"),
  folder: document.querySelector("#folder"),
  name: document.querySelector("#name"),
  description: document.querySelector("#description"),
  content: document.querySelector("#content"),
  copy: document.querySelector("#copy"),
  selectionSummary: document.querySelector("#selection-summary"),
  selectionHelp: document.querySelector("#selection-help"),
  clearSelection: document.querySelector("#clear-selection"),
  useSelection: document.querySelector("#use-selection"),
  commit: document.querySelector("#commit")
};

function selectedSkill() {
  return state.catalog?.skills?.find((skill) => skill.id === state.focused) || null;
}

function selectedSkills() {
  return state.selected.map((id) => state.catalog?.skills?.find((skill) => skill.id === id)).filter(Boolean);
}

function toggleSkill(id) {
  const skill = state.catalog?.skills?.find((item) => item.id === id);
  if (!skill) return;
  state.focused = id;
  if (state.selected.includes(id)) {
    state.selected = state.selected.filter((item) => item !== id);
    state.notice = "";
  } else {
    const conflicting = skill.group_exclusive
      ? state.selected.map((item) => state.catalog?.skills?.find((candidate) => candidate.id === item)).filter((candidate) => candidate?.group_id === skill.group_id)
      : [];
    const withoutConflict = skill.group_exclusive
      ? state.selected.filter((item) => state.catalog?.skills?.find((candidate) => candidate.id === item)?.group_id !== skill.group_id)
      : state.selected;
    state.selected = [...withoutConflict, id];
    state.notice = conflicting.length ? `Đã thay ${conflicting[0].install_name} vì nhóm “${skill.group_label}” chỉ chọn 1.` : "";
  }
  render();
}

function visibleSkills() {
  const query = state.query.trim().toLowerCase();
  if (!query) return state.catalog?.skills || [];
  return (state.catalog?.skills || []).filter((skill) => [skill.install_name, skill.id, skill.description].join(" ").toLowerCase().includes(query));
}

function renderList() {
  const skills = visibleSkills();
  elements.count.textContent = String(skills.length);
  const nodes = [];
  let previousGroup = "";
  for (const skill of skills) {
    if (skill.group_id !== previousGroup) {
      const group = document.createElement("div");
      group.className = "skill-group";
      const label = document.createElement("strong");
      label.textContent = skill.group_label || "Khác";
      const rule = document.createElement("span");
      rule.textContent = skill.group_exclusive ? "Chọn 1" : "Chọn nhiều";
      group.append(label, rule);
      nodes.push(group);
      previousGroup = skill.group_id;
    }
    const button = document.createElement("button");
    button.type = "button";
    const checked = state.selected.includes(skill.id);
    button.className = `skill ${skill.id === state.focused ? "active" : ""} ${checked ? "selected" : ""}`.trim();
    button.setAttribute("aria-pressed", String(checked));
    const check = document.createElement("i");
    check.setAttribute("aria-hidden", "true");
    check.textContent = checked ? "✓" : "";
    const copy = document.createElement("span");
    copy.className = "skill-copy";
    const name = document.createElement("strong");
    name.textContent = skill.install_name;
    const description = document.createElement("span");
    description.textContent = skill.description || skill.id;
    copy.append(name, description);
    button.append(check, copy);
    button.addEventListener("click", () => toggleSkill(skill.id));
    nodes.push(button);
  }
  elements.skills.replaceChildren(...nodes);
}

function renderDetail() {
  const skill = selectedSkill();
  elements.folder.textContent = skill ? skill.id : "NO RESULT";
  elements.name.textContent = skill?.install_name || "Không tìm thấy skill";
  elements.description.textContent = skill?.description || "Thử một từ khóa khác.";
  elements.content.textContent = skill?.content || "";
  elements.copy.disabled = !skill;
  const skills = selectedSkills();
  elements.selectedCount.textContent = `${skills.length} đã chọn`;
  elements.selectionSummary.textContent = skills.length ? skills.map((item) => item.install_name).join(" · ") : "Chưa chọn skill";
  elements.selectionHelp.textContent = state.notice || "Các nhóm ghi “Chọn 1” sẽ tự thay lựa chọn cũ để tránh xung đột.";
  elements.clearSelection.disabled = !skills.length;
  elements.useSelection.disabled = !skills.length;
}

function render() {
  renderList();
  renderDetail();
}

elements.search.addEventListener("input", (event) => { state.query = event.target.value; renderList(); });
elements.copy.addEventListener("click", () => {
  const skill = selectedSkill();
  if (!skill) return;
  window.parent.postMessage({ type: "codexpro:copy-text", text: skill.content, label: skill.install_name }, "*");
  const original = elements.copy.textContent;
  elements.copy.textContent = "Đã gửi vào clipboard";
  setTimeout(() => { elements.copy.textContent = original; }, 1400);
});
elements.clearSelection.addEventListener("click", () => { state.selected = []; state.notice = ""; render(); });
elements.useSelection.addEventListener("click", () => {
  const skills = selectedSkills();
  if (!skills.length) return;
  window.parent.postMessage({
    type: "codexpro:use-skills",
    skills: skills.map((skill) => ({ id: skill.id, install_name: skill.install_name, description: skill.description, content: skill.content, group_id: skill.group_id, group_label: skill.group_label, group_exclusive: skill.group_exclusive }))
  }, "*");
});

fetch("./catalog.json", { cache: "no-store" })
  .then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  })
  .then((catalog) => {
    state.catalog = catalog;
    state.focused = catalog.skills?.find((skill) => skill.install_name === "gpt-taste")?.id || catalog.skills?.[0]?.id || "";
    elements.commit.textContent = catalog.source_commit ? `commit ${catalog.source_commit.slice(0, 12)}` : "";
    render();
  })
  .catch((error) => {
    elements.name.textContent = "Không tải được catalog";
    elements.description.textContent = error.message;
    elements.copy.disabled = true;
  });
