const MAX_SKILLS = 32;
const MAX_SKILL_CONTENT_CHARS = 500_000;
const MAX_CHAT_REQUEST_CHARS = 20_000;

function clean(value, limit) {
  return String(value || "").trim().slice(0, limit);
}

export function normalizePluginSkills(value) {
  if (!Array.isArray(value) || !value.length) throw new Error("Hãy chọn ít nhất một skill.");
  if (value.length > MAX_SKILLS) throw new Error(`Chỉ được chọn tối đa ${MAX_SKILLS} skill cho một task.`);
  const seen = new Set();
  const exclusiveGroups = new Map();
  const skills = [];
  let contentLength = 0;
  for (const item of value) {
    const id = clean(item?.id, 120);
    const name = clean(item?.install_name || item?.name || id, 120);
    const description = clean(item?.description, 2_000);
    const groupId = clean(item?.group_id || item?.groupId, 120);
    const groupLabel = clean(item?.group_label || item?.groupLabel || groupId, 120);
    const groupExclusive = item?.group_exclusive === true || item?.groupExclusive === true;
    const content = String(item?.content || "").trim();
    if (!id || !name || !content || seen.has(id)) continue;
    if (groupExclusive && groupId && exclusiveGroups.has(groupId)) {
      throw new Error(`Nhóm “${groupLabel}” chỉ được chọn một skill.`);
    }
    contentLength += content.length;
    if (contentLength > MAX_SKILL_CONTENT_CHARS) throw new Error("Tổng nội dung skill quá lớn để giao an toàn trong một task.");
    seen.add(id);
    if (groupExclusive && groupId) exclusiveGroups.set(groupId, id);
    skills.push({ id, name, description, content, groupId, groupLabel, groupExclusive });
  }
  if (!skills.length) throw new Error("Các skill đã chọn không có nội dung hợp lệ.");
  return skills;
}

export function buildPluginTaskPrompt(requirement, value) {
  const skills = normalizePluginSkills(value);
  const skillNames = skills.map((skill) => `\`${skill.name}\``).join(", ");
  const render = (request) => [
    "# Yêu cầu người dùng",
    request,
    "",
    `# Skill cần áp dụng (${skills.length})`,
    skillNames,
    "Đọc toàn bộ file CodexPro Plugin Skill Bundle đính kèm trước khi làm việc, rồi áp dụng đồng thời các skill theo đúng thứ tự trong file.",
    "Nếu có xung đột, ưu tiên yêu cầu trực tiếp của người dùng rồi đến skill được liệt kê trước. Không bỏ qua file đính kèm."
  ].join("\n");
  const request = String(requirement || "").trim();
  if (!request) throw new Error("Hãy nhập yêu cầu cho worker.");
  const maximumRequirementLength = MAX_CHAT_REQUEST_CHARS - render("").length;
  if (request.length > maximumRequirementLength) {
    throw new Error(`Yêu cầu dài quá ${maximumRequirementLength.toLocaleString("vi-VN")} ký tự khi gửi cùng danh sách skill.`);
  }
  return render(request);
}
