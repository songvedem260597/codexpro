import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CodexProConfig } from "./config.js";
import { TOOL_CARD_LEGACY_URIS, TOOL_CARD_MIME_TYPE, TOOL_CARD_URI, toolCardWidgetHtml } from "./toolCardWidget.js";

export { TOOL_CARD_URI };

export function toolCardMeta(): Record<string, unknown> {
  return {
    ui: { resourceUri: TOOL_CARD_URI },
    "openai/outputTemplate": TOOL_CARD_URI
  };
}

const TOOL_CARD_RENDER_TOOL_NAMES = new Set<string>([
  "open_current_workspace",
  "open_workspace",
  "workspace_snapshot",
  "inspect_workspace",
  "show_changes",
  "git_status",
  "handoff_to_agent",
  "handoff_to_codex",
  "bash"
]);

const OPTIONAL_TOOL_CARD_META = [
  "ui",
  "openai/outputTemplate",
  "openai/toolInvocation/invoking",
  "openai/toolInvocation/invoked"
] as const;

export function usesToolCard(config: CodexProConfig, name: string): boolean {
  return config.toolCards && TOOL_CARD_RENDER_TOOL_NAMES.has(name);
}

export function descriptorOptionsForConfig(config: CodexProConfig, name: string, options: Record<string, unknown>): Record<string, unknown> {
  if (usesToolCard(config, name)) return options;
  const meta = { ...((options._meta as Record<string, unknown> | undefined) ?? {}) };
  for (const key of OPTIONAL_TOOL_CARD_META) delete meta[key];
  return { ...options, _meta: meta };
}

export function registerToolCardResource(server: McpServer, config: CodexProConfig): void {
  if (config.connectionTest) return;
  const s = server as any;
  if (typeof s.registerResource !== "function") {
    throw new Error("Unsupported MCP SDK: CodexPro widgets require registerResource.");
  }

  const registerUri = (uri: string, name: string): void => {
    s.registerResource(
      name,
      uri,
      {
        title: "CodexPro Tool Card",
        description: "Compact visual renderer for CodexPro workspace orientation, source changes, and handoffs.",
        mimeType: TOOL_CARD_MIME_TYPE
      },
      async () => ({
        contents: [
          {
            uri,
            mimeType: TOOL_CARD_MIME_TYPE,
            text: toolCardWidgetHtml,
            _meta: {
              ui: {
                prefersBorder: true,
                domain: config.widgetDomain,
                csp: {
                  connectDomains: [],
                  resourceDomains: []
                }
              },
              "openai/widgetDescription": "Renders CodexPro workspace orientation, diagnostics, file diffs, change reviews, terminal checks, Pro context exports, and handoff plans as compact developer cards with bounded previews.",
              "openai/widgetPrefersBorder": true,
              "openai/widgetDomain": config.widgetDomain,
              "openai/widgetCSP": {
                connect_domains: [],
                resource_domains: []
              }
            }
          }
        ]
      })
    );
  };

  registerUri(TOOL_CARD_URI, "codexpro-tool-card");
  for (const legacyUri of TOOL_CARD_LEGACY_URIS) {
    registerUri(legacyUri, `codexpro-tool-card-${legacyUri.match(/v\d+/)?.[0] ?? "legacy"}`);
  }
}
