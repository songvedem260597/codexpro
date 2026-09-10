import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { codexProHome } from "./profileStore.js";
import { STRUCTURED_STRING_MAX_CHARS } from "./toolResults.js";

export const CODEXPRO_GLOBAL_RULES_FILE = "CODEXPRO.md";

export const DEFAULT_CODEXPRO_GLOBAL_RULES = `# CodexPro Global Rules

<!-- Rule trong file này áp dụng cho mọi repo/dự án được thao tác qua MCP CodexPro. -->
<!-- Thêm hoặc sửa rule bên dưới. Không lưu password, token hoặc API key trong file này. -->

- Đọc và tuân thủ file này trước khi đọc rule riêng của từng repo/dự án.
- Rule riêng của repo có thể bổ sung chi tiết nhưng không được âm thầm bỏ qua rule toàn cục này.
`;

export type GlobalRulesSnapshot = {
  path: string;
  text: string;
  sha256: string;
  source: "file" | "template";
};

export function readGlobalRulesSnapshotSync(): GlobalRulesSnapshot {
  const filePath = path.join(codexProHome(), CODEXPRO_GLOBAL_RULES_FILE);
  let text = DEFAULT_CODEXPRO_GLOBAL_RULES;
  let source: GlobalRulesSnapshot["source"] = "template";
  try {
    text = fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n").slice(0, STRUCTURED_STRING_MAX_CHARS);
    source = "file";
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
  return {
    path: filePath,
    text,
    sha256: createHash("sha256").update(text).digest("hex"),
    source
  };
}

export async function readGlobalRulesSnapshot(): Promise<GlobalRulesSnapshot> {
  return readGlobalRulesSnapshotSync();
}

export function withGlobalRules(text: string, rules: GlobalRulesSnapshot): string {
  return [
    "# Mandatory CodexPro Global Rules",
    "",
    `Source: ${rules.path}`,
    `SHA-256: ${rules.sha256}`,
    "Read and follow these rules before repository-specific AGENTS.md instructions or project decisions.",
    "",
    rules.text || "(No global rules configured.)",
    "",
    text
  ].join("\n");
}
