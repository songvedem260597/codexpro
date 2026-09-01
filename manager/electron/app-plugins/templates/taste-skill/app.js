const state = { catalog: null, selected: "", query: "" };
const elements = {
  search: document.querySelector("#search"),
  skills: document.querySelector("#skills"),
  count: document.querySelector("#count"),
  folder: document.querySelector("#folder"),
  name: document.querySelector("#name"),
  description: document.querySelector("#description"),
  content: document.querySelector("#content"),
  copy: document.querySelector("#copy"),
  commit: document.querySelector("#commit")
};

function selectedSkill() {
  return state.catalog?.skills?.find((skill) => skill.id === state.selected) || null;
}

function visibleSkills() {
  const query = state.query.trim().toLowerCase();
  if (!query) return state.catalog?.skills || [];
  return (state.catalog?.skills || []).filter((skill) => [skill.install_name, skill.id, skill.description].join(" ").toLowerCase().includes(query));
}

function renderList() {
  const skills = visibleSkills();
  elements.count.textContent = String(skills.length);
  elements.skills.replaceChildren(...skills.map((skill) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = skill.id === state.selected ? "skill active" : "skill";
    const name = document.createElement("strong");
    name.textContent = skill.install_name;
    const description = document.createElement("span");
    description.textContent = skill.description || skill.id;
    button.append(name, description);
    button.addEventListener("click", () => { state.selected = skill.id; render(); });
    return button;
  }));
}

function renderDetail() {
  const skill = selectedSkill();
  elements.folder.textContent = skill ? skill.id : "NO RESULT";
  elements.name.textContent = skill?.install_name || "Không tìm thấy skill";
  elements.description.textContent = skill?.description || "Thử một từ khóa khác.";
  elements.content.textContent = skill?.content || "";
  elements.copy.disabled = !skill;
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

fetch("./catalog.json", { cache: "no-store" })
  .then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  })
  .then((catalog) => {
    state.catalog = catalog;
    state.selected = catalog.skills?.find((skill) => skill.install_name === "gpt-taste")?.id || catalog.skills?.[0]?.id || "";
    elements.commit.textContent = catalog.source_commit ? `commit ${catalog.source_commit.slice(0, 12)}` : "";
    render();
  })
  .catch((error) => {
    elements.name.textContent = "Không tải được catalog";
    elements.description.textContent = error.message;
    elements.copy.disabled = true;
  });
