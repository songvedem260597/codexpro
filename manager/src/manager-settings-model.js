export const FONT_OPTIONS = [
  { value: "system", label: "Segoe UI / mặc định Windows", css: '\"Segoe UI Variable Text\", \"Segoe UI Variable\", \"Segoe UI\", sans-serif' },
  { value: "be-vietnam-pro", label: "Be Vietnam Pro", hint: "Text dài · tiếng Việt rõ và dễ đọc", css: '\"Be Vietnam Pro\", \"Segoe UI\", sans-serif' },
  { value: "manrope", label: "Manrope", hint: "Tiêu đề · giao diện hiện đại, gọn", css: 'Manrope, \"Segoe UI\", sans-serif' },
  { value: "jetbrains-mono", label: "JetBrains Mono", hint: "Code · ID · log kỹ thuật", css: '\"JetBrains Mono\", \"Cascadia Code\", Consolas, monospace' },
  { value: "arial", label: "Arial", css: "Arial, sans-serif" },
  { value: "tahoma", label: "Tahoma", css: "Tahoma, sans-serif" },
  { value: "verdana", label: "Verdana", css: "Verdana, sans-serif" },
  { value: "trebuchet", label: "Trebuchet MS", css: '\"Trebuchet MS\", sans-serif' },
  { value: "georgia", label: "Georgia", css: "Georgia, serif" },
  { value: "cascadia", label: "Cascadia Code", css: '\"Cascadia Code\", Consolas, monospace' }
];

export const FONT_ROLE_OPTIONS = [
  { value: "inherit", label: "Theo font nội dung", hint: "Dùng cùng font với nội dung & control" },
  ...FONT_OPTIONS
];

export const FONT_WEIGHT_LABELS = {
  400: "Regular",
  500: "Medium",
  600: "Semibold",
  700: "Bold"
};

export const GLOBAL_RULES_TEMPLATE = `# CodexPro Global Rules

<!-- Rule trong file này áp dụng cho mọi repo/dự án được thao tác qua MCP CodexPro. -->
<!-- Thêm hoặc sửa rule bên dưới. Không lưu password, token hoặc API key trong file này. -->

- Đọc và tuân thủ file này trước khi đọc rule riêng của từng repo/dự án.
- Rule riêng của repo có thể bổ sung chi tiết nhưng không được âm thầm bỏ qua rule toàn cục này.
`;

export const DEFAULT_MANAGER_SETTINGS = {
  chatWidth: 940,
  chatHeight: 330,
  showChatConversationSelector: true,
  fontFamily: "system",
  headingFontFamily: "inherit",
  monoFontFamily: "inherit",
  fontSize: 14,
  fontWeight: 400,
  profileLayout: "rows",
  profileCardHeight: 390,
  workingBorderStyle: "shine",
  maxSubagents: 1,
  autoRecovery: false,
  autoUpdateWorkers: false,
  taskNotifications: true,
  appBackground: "",
  appBackgroundDataUrl: "",
  appBackgroundBlur: 6,
  appBackgroundDim: 54,
  globalRules: GLOBAL_RULES_TEMPLATE,
  repoSelections: {},
  selectedWorkerPackId: "default",
  workerImagePacks: [],
  workerImages: { idle: "", working: "", hung: "" },
  workerImageDataUrls: { idle: "", working: "", hung: "" }
};
