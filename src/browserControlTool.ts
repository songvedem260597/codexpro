import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CodexProConfig } from "./config.js";
import { CodexProError, type WorkspaceManager } from "./guard.js";
import { runBrowserControl } from "./browserOps.js";
import {
  forgetBrowserExtensionProfile,
  getBrowserExtensionProfileTaskBinding,
  listBrowserExtensionProfiles,
  rebindBrowserExtensionProfileTaskConversation,
  runBrowserExtensionCommand,
  setBrowserExtensionProfileWorkspace,
  setBrowserExtensionProfileWorkspaceBinding
} from "./browserExtensionBridge.js";
import { finalizeWorkerJob, readWorkerJob } from "./workerPolicy.js";
import { finalizeWorkspaceTask } from "./workspaceCoordination.js";
import { textResult } from "./toolResults.js";
import type { CodexToolHandler } from "./toolRegistration.js";

const defaultDependencies = {
  runBrowserControl,
  forgetBrowserExtensionProfile,
  getBrowserExtensionProfileTaskBinding,
  listBrowserExtensionProfiles,
  rebindBrowserExtensionProfileTaskConversation,
  runBrowserExtensionCommand,
  setBrowserExtensionProfileWorkspace,
  setBrowserExtensionProfileWorkspaceBinding,
  finalizeWorkerJob,
  readWorkerJob,
  finalizeWorkspaceTask,
  textResult
};

type RegisterCodexTool = (
  config: CodexProConfig,
  server: McpServer,
  name: string,
  options: Record<string, unknown>,
  handler: CodexToolHandler
) => void;

type BrowserControlToolOptions = {
  config: CodexProConfig;
  server: McpServer;
  workspaces: WorkspaceManager;
  registerCodexTool: RegisterCodexTool;
  annotations: Record<string, unknown>;
  dependencies?: Partial<typeof defaultDependencies>;
};

export function registerBrowserControlTool(options: BrowserControlToolOptions): void {
  const { config, server, workspaces, registerCodexTool, annotations } = options;
  const dependencies = { ...defaultDependencies, ...options.dependencies };

  registerCodexTool(
    config,
    server,
    "browser_control",
    {
      title: "Browser Control",
      description:
        "Fast browser-agent control for the Chrome profile explicitly marked ACTIVE, with dedicated port-9223 Chrome as fallback. Supports persistent CDP/debugger sessions, trusted input, batch actions, wait_for, inspect_element, evaluate, hover/scroll, screenshots, and existing ChatGPT-specific actions.",
      inputSchema: {
        action: z.enum(["status", "list_profiles", "forget_profile", "select_workspace", "rebind_profile_task", "check_chatgpt", "setup_chatgpt", "reload_extension", "stop_chat_generation", "audit_long_running_chat", "recover_chat_tab", "register_watchdog_tab", "send_chat_request", "rename_chat", "hide_chat", "get_chat_response", "list_tabs", "open_tab", "activate_tab", "close_tab", "snapshot", "navigate", "click", "trusted_click", "type", "press", "hover", "scroll", "wait_for", "inspect_element", "evaluate", "batch", "screenshot"]),
        profile_id: z.string().optional().describe("Optional extension profile id. Omit to use the profile marked ACTIVE. Ignored for the dedicated fallback browser."),
        root: z.string().optional().describe("Workspace root for select_workspace. The selected profile is locked to this root until changed by CodexPro Manager."),
        browser: z.enum(["active", "dedicated"]).optional().describe("Use the ACTIVE extension profile when available (default), or force the dedicated port-9223 Chrome."),
        target_id: z.string().optional().describe("Tab id from list_tabs. Omit to use the first page tab."),
        conversation_id: z.string().optional().describe("Exact ChatGPT conversation id for send_chat_request, rename_chat, get_chat_response, recovery, or a long-task audit."),
        task_id: z.string().regex(/^cpt_[a-f0-9]{24}$/).optional().describe("Exact Manager task id to finalize when a ChatGPT response reaches a terminal state."),
        started_at: z.string().max(80).optional().describe("Stable task start timestamp for a one-shot long-task audit."),
        attempt_key: z.string().max(300).optional().describe("Persistent deduplication key for a one-shot long-task audit."),
        read_dom: z.boolean().optional().describe("For get_chat_response, read transcript text from the page DOM. Set false to return network state only."),
        canonical_only: z.boolean().optional().describe("For get_chat_response, read the authenticated canonical conversation without querying the rendered DOM."),
        recover_stale_dom: z.boolean().optional().describe("For get_chat_response after network completion, compare the live DOM with the canonical ChatGPT conversation and reload the exact tab when the rendered stream is stale."),
        new_chat: z.boolean().optional().describe("For send_chat_request, create a new ChatGPT conversation and foreground-focus its Chrome tab/window."),
        visual_watchdog: z.boolean().optional().describe("For CodexPro Visual Watchdog only, reserve/use the dedicated Watchdog tab slot instead of a normal task tab slot."),
        focus_window: z.boolean().optional().describe("For recover_chat_tab, foreground-focus the recovered Chrome tab/window. Manager automatic recovery enables this so continuation stays visible."),
        allow_busy_followup: z.boolean().optional().describe("For send_chat_request, allow one explicitly serialized follow-up while the target conversation is already generating. The send still waits for a fresh ChatGPT submission ACK before another send may proceed."),
        one_shot_recovery: z.boolean().optional().describe("For an interrupted-task continuation, disable renderer replacement and stop after the first send preparation failure."),
        title: z.string().max(120).optional().describe("New conversation title for rename_chat."),
        attachments: z.array(z.object({
          name: z.string().min(1).max(255),
          mime_type: z.string().min(1).max(160),
          data_base64: z.string().min(1).max(14_000_000)
        })).max(4).optional().describe("Files to attach to send_chat_request. Base64 payload; maximum 4 files."),
        url: z.string().optional().describe("HTTP(S) URL for open_tab or navigate."),
        selector: z.string().optional().describe("CSS selector or semantic @e ref from snapshot."),
        ref: z.string().max(80).optional().describe("Stable semantic element ref such as @e3 from snapshot."),
        role: z.string().max(80).optional().describe("Semantic ARIA or implicit role locator, for example button or textbox."),
        name: z.string().max(500).optional().describe("Accessible-name locator, optionally combined with role."),
        placeholder: z.string().max(500).optional().describe("Input placeholder locator."),
        label: z.string().max(500).optional().describe("Associated label or aria-label locator."),
        test_id: z.string().max(500).optional().describe("Exact data-testid or data-test locator."),
        nth: z.number().int().min(0).max(1000).optional().describe("Zero-based match index for a semantic locator. Default: 0."),
        text: z.string().optional().describe("Text to enter for type."),
        key: z.string().optional().describe("Key for press, such as Enter, Tab, Escape, or ArrowDown."),
        expression: z.string().max(100000).optional().describe("JavaScript expression for evaluate. Runs in the selected page context."),
        state: z.enum(["attached", "visible", "hidden", "detached"]).optional().describe("Target state for wait_for. Default: visible."),
        timeout_ms: z.number().int().min(100).max(60000).optional().describe("Timeout for wait_for. Default: 10000 ms."),
        delta_x: z.number().optional().describe("Horizontal mouse-wheel delta for scroll. Default: 0."),
        delta_y: z.number().optional().describe("Vertical mouse-wheel delta for scroll. Default: 600."),
        steps: z.array(z.object({
          action: z.enum(["snapshot", "navigate", "click", "trusted_click", "type", "press", "hover", "scroll", "wait_for", "inspect_element", "evaluate", "screenshot"]),
          url: z.string().optional(),
          selector: z.string().optional(),
          ref: z.string().max(80).optional(),
          role: z.string().max(80).optional(),
          name: z.string().max(500).optional(),
          placeholder: z.string().max(500).optional(),
          label: z.string().max(500).optional(),
          test_id: z.string().max(500).optional(),
          nth: z.number().int().min(0).max(1000).optional(),
          text: z.string().optional(),
          key: z.string().optional(),
          expression: z.string().max(100000).optional(),
          state: z.enum(["attached", "visible", "hidden", "detached"]).optional(),
          timeout_ms: z.number().int().min(100).max(60000).optional(),
          delta_x: z.number().optional(),
          delta_y: z.number().optional(),
          max_chars: z.number().int().min(500).max(50000).optional(),
          full_page: z.boolean().optional(),
          delta: z.boolean().optional()
        })).max(50).optional().describe("Batch up to 50 browser actions without extra MCP round-trips."),
        max_chars: z.number().int().min(500).max(50000).optional().describe("Maximum visible page text returned by snapshot. Default: 20000."),
        full_page: z.boolean().optional().describe("Capture beyond the viewport for screenshot. Default: false."),
        delta: z.boolean().optional().describe("For snapshot, return only semantic elements/text changed since the previous snapshot on this tab."),
        trace: z.boolean().optional().describe("Collect sanitized CDP network, console, and page lifecycle events around this action."),
        trace_ms: z.number().int().min(0).max(10000).optional().describe("Milliseconds to keep collecting trace events after the action. Default: 750.")
      },
      annotations,
      _meta: {
        "openai/toolInvocation/invoking": "Controlling CodexPro Chrome...",
        "openai/toolInvocation/invoked": "Browser action complete"
      }
    },
    async (args) => {
      const profiles = dependencies.listBrowserExtensionProfiles();
      if (args.action === "list_profiles") {
        return dependencies.textResult(`# Browser Profiles\n\n${profiles.length ? profiles.map((profile) => `- ${profile.active ? "ACTIVE" : "idle"} · ${profile.label} · ${profile.connected ? "online" : "offline"} · ${profile.profile_id}`).join("\n") : "No extension profiles connected."}`, { action: args.action, profiles });
      }
      if (args.action === "forget_profile") {
        if (!args.profile_id) throw new CodexProError("Chrome profile id is required before forgetting a profile.");
        const forgotten = dependencies.forgetBrowserExtensionProfile(args.profile_id);
        return dependencies.textResult(
          forgotten ? "Chrome profile hidden from CodexPro Manager." : "Chrome profile was already absent.",
          { action: args.action, profile_id: args.profile_id, forgotten }
        );
      }
      if (args.action === "status") {
        let dedicated: Record<string, any>;
        try {
          dedicated = await dependencies.runBrowserControl(config.browserDebugUrl, { action: "status" });
        } catch (error) {
          dedicated = { connected: false, error: error instanceof Error ? error.message : String(error) };
        }
        return dependencies.textResult(`# Browser Control Status\n\nDedicated Chrome: ${dedicated.connected ? "online" : "offline"}\nExtension profiles: ${profiles.length}\nACTIVE: ${profiles.find((profile) => profile.active)?.label ?? "none"}`, {
          action: args.action,
          dedicated,
          profiles,
          active_profile_id: profiles.find((profile) => profile.active)?.profile_id ?? null
        });
      }
      if ((args.action === "open_tab" || args.action === "navigate") && args.url) {
        const parsed = new URL(args.url);
        const extensionReloadUrl = parsed.protocol === "chrome-extension:" && parsed.hostname === "gndipignbnipohooclcbhjliikamjlpl" && parsed.pathname === "/popup.html";
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && !extensionReloadUrl) {
          throw new CodexProError("Browser navigation only allows http, https, and the signed CodexPro reload page.");
        }
      }
      let result: Record<string, any>;
      const selectedProfile = args.profile_id || profiles.find((profile) => profile.active && profile.connected)?.profile_id;
      if ((args.action === "select_workspace" || args.action === "rebind_profile_task" || args.action === "check_chatgpt" || args.action === "setup_chatgpt" || args.action === "stop_chat_generation" || args.action === "audit_long_running_chat" || args.action === "send_chat_request" || args.action === "rename_chat" || args.action === "hide_chat" || args.action === "get_chat_response") && !selectedProfile) {
        throw new CodexProError("Choose an online Chrome extension profile before setting up CodexPro in ChatGPT.");
      }
      if (args.action === "select_workspace") {
        const workspace = workspaces.openWorkspace(String(args.root || ""));
        dependencies.setBrowserExtensionProfileWorkspaceBinding(selectedProfile!, workspace.root);
        dependencies.setBrowserExtensionProfileWorkspace(selectedProfile!, workspace.root);
        return dependencies.textResult(`# Workspace Locked\n\nProfile: ${selectedProfile}\nRoot: ${workspace.root}`, {
          action: args.action,
          profile_id: selectedProfile,
          workspace_id: workspace.id,
          root: workspace.root,
          locked: true
        });
      }
      if (args.action === "rebind_profile_task") {
        if (!selectedProfile || !args.task_id || !args.conversation_id) throw new CodexProError("Profile, task id, and conversation id are required for recovery rebinding.");
        const workerJob = dependencies.readWorkerJob(args.task_id);
        if (!workerJob || workerJob.workerId !== selectedProfile || !["prepared", "running"].includes(workerJob.status)) {
          throw new CodexProError("RECOVERY_TASK_NOT_ACTIVE: Refusing to move a completed or foreign task to another conversation.");
        }
        const rebound = dependencies.rebindBrowserExtensionProfileTaskConversation(selectedProfile, args.task_id, args.conversation_id);
        if (!rebound) throw new CodexProError("RECOVERY_TASK_REBIND_FAILED: The profile task binding changed before recovery completed.");
        return dependencies.textResult(`# Profile Task Rebound\n\nTask: ${args.task_id}\nConversation: ${args.conversation_id}`, {
          action: args.action,
          profile_id: selectedProfile,
          task_id: args.task_id,
          conversation_id: args.conversation_id,
          rebound: true
        });
      }
      const useExtension = args.browser !== "dedicated" && Boolean(selectedProfile);
      if (useExtension) {
        result = await dependencies.runBrowserExtensionCommand(args.action, {
          target_id: args.target_id,
          conversation_id: args.conversation_id,
          task_id: args.task_id,
          started_at: args.started_at,
          attempt_key: args.attempt_key,
          read_dom: args.read_dom,
          recover_stale_dom: args.recover_stale_dom,
          new_chat: args.new_chat,
          visual_watchdog: args.visual_watchdog,
          focus_window: args.focus_window,
          allow_busy_followup: args.allow_busy_followup,
          one_shot_recovery: args.one_shot_recovery,
          title: args.title,
          attachments: args.attachments,
          expression: args.expression,
          state: args.state,
          timeout_ms: args.timeout_ms,
          delta_x: args.delta_x,
          delta_y: args.delta_y,
          steps: args.steps,
          url: args.url,
          selector: args.selector,
          ref: args.ref,
          role: args.role,
          name: args.name,
          placeholder: args.placeholder,
          label: args.label,
          test_id: args.test_id,
          nth: args.nth,
          text: args.text,
          key: args.key,
          max_chars: args.max_chars,
          full_page: args.full_page,
          delta: args.delta,
          trace: args.trace,
          trace_ms: args.trace_ms
        }, selectedProfile);
        result.browser_backend = "extension";
        result.profile_id = selectedProfile;
      } else {
        result = await dependencies.runBrowserControl(config.browserDebugUrl, {
          action: args.action,
          targetId: args.target_id,
          expression: args.expression,
          state: args.state,
          timeoutMs: args.timeout_ms,
          deltaX: args.delta_x,
          deltaY: args.delta_y,
          steps: Array.isArray(args.steps) ? args.steps.map((step: any) => ({
            action: step.action,
            url: step.url,
            selector: step.selector,
            ref: step.ref,
            role: step.role,
            name: step.name,
            placeholder: step.placeholder,
            label: step.label,
            testId: step.test_id,
            nth: step.nth,
            text: step.text,
            key: step.key,
            expression: step.expression,
            state: step.state,
            timeoutMs: step.timeout_ms,
            deltaX: step.delta_x,
            deltaY: step.delta_y,
            maxChars: step.max_chars,
            fullPage: step.full_page,
            delta: step.delta
          })) : undefined,
          url: args.url,
          selector: args.selector,
          ref: args.ref,
          role: args.role,
          name: args.name,
          placeholder: args.placeholder,
          label: args.label,
          testId: args.test_id,
          nth: args.nth,
          text: args.text,
          key: args.key,
          maxChars: args.max_chars,
          fullPage: args.full_page,
          delta: args.delta,
          trace: args.trace,
          traceMs: args.trace_ms
        });
        result.browser_backend = "dedicated";
      }
      if (selectedProfile && args.task_id && (args.action === "get_chat_response" || args.action === "stop_chat_generation")) {
        const workerJob = dependencies.readWorkerJob(args.task_id);
        const taskBinding = dependencies.getBrowserExtensionProfileTaskBinding(selectedProfile);
        const requestedConversationId = String(args.conversation_id || "").trim();
        const conversationOwnsTask = Boolean(taskBinding
          && taskBinding.taskId === args.task_id
          && (!taskBinding.conversationId || taskBinding.conversationId === requestedConversationId));
        const responseFinished = args.action === "get_chat_response"
          && result.response_ready === true
          && result.busy !== true
          && result.network_stream_in_progress !== true;
        const terminalOutcome = args.action === "stop_chat_generation"
          ? "cancelled"
          : String(result.network_state || "").toLowerCase() === "failed" || result.network_error
            ? "failed"
            : null;
        if (workerJob?.status === "running" && responseFinished && conversationOwnsTask) result.worker_job_completion_pending_finalize = true;
        if (workerJob?.status === "running" && workerJob.workerId === selectedProfile && terminalOutcome && conversationOwnsTask) {
          const finalized = await dependencies.finalizeWorkerJob({
            jobId: args.task_id,
            workerId: selectedProfile,
            outcome: terminalOutcome,
            summary: undefined,
            error: terminalOutcome === "failed" ? String(result.network_error || result.error || "ChatGPT generation failed.") : undefined
          });
          if (finalized.kind === "code" && finalized.root) {
            await dependencies.finalizeWorkspaceTask({
              taskId: finalized.jobId,
              workerId: selectedProfile,
              title: finalized.title,
              root: finalized.root
            }, terminalOutcome);
          }
          result.worker_job_finalized = true;
        }
        if (terminalOutcome && !conversationOwnsTask) {
          result.worker_job_finalization_skipped = "conversation_rebound";
        }
        const currentWorkerJob = dependencies.readWorkerJob(args.task_id);
        if (currentWorkerJob && currentWorkerJob.workerId === selectedProfile) {
          result.worker_job_status = currentWorkerJob.status;
          result.worker_job_finished_at = currentWorkerJob.finishedAt;
        }
      }
      if (result.image_base64) {
        const { image_base64, ...structured } = result;
        return {
          content: [
            { type: "image", data: image_base64, mimeType: result.mime_type ?? "image/png" },
            { type: "text", text: `Browser screenshot captured for tab ${result.target_id}.` }
          ],
          structuredContent: structured
        };
      }
      return dependencies.textResult(`# Browser Control\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``, result);
    }
  );
}
