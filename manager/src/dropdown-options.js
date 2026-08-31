export const DROPDOWN_SEARCH_THRESHOLD = 8;

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("vi-VN")
    .trim();
}

export function dropdownSearchEnabled(options, searchable, threshold = DROPDOWN_SEARCH_THRESHOLD) {
  if (searchable === false) return false;
  if (searchable === true) return true;
  return (Array.isArray(options) ? options.length : 0) >= Math.max(2, Number(threshold) || DROPDOWN_SEARCH_THRESHOLD);
}

export function filterDropdownOptions(options, query, getSearchText) {
  const list = Array.isArray(options) ? options : [];
  const needle = normalizeSearchText(query);
  if (!needle) return list;
  return list.filter((option) => {
    const text = typeof getSearchText === "function"
      ? getSearchText(option)
      : [option?.label, option?.hint, option?.value, option?.searchText].filter(Boolean).join(" ");
    return normalizeSearchText(text).includes(needle);
  });
}
