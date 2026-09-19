#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ExtensionBridge, DEFAULT_PORT } from "./bridge.js";
import { Methods } from "./protocol.js";

const port = Number(process.env.WIDEBROWSE_PORT || DEFAULT_PORT);
const bridge = new ExtensionBridge(port);

function text(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

function requireSession(): void {
  if (bridge.sessionInfo.state !== "active") {
    throw new Error(
      "No active WideBrowse session. Call browse_request_session first and wait for the user to Approve in the browser."
    );
  }
}

async function main() {
  await bridge.start();
  console.error(
    `WideBrowse MCP ready (bridge=${bridge.bridgeMode}, port=${port}). Extension popup should show Bridge=connected.`
  );

  const server = new McpServer({
    name: "widebrowse",
    version: "1.0.0",
  });

  server.tool(
    "browse_list_tabs",
    "List open browser tabs (no session required). Call this FIRST before requesting control. Then ask the user which tab to grant access to, and pass that tab's id to browse_request_session.",
    {},
    async () => {
      const result = (await bridge.call(Methods.TABS_LIST, {})) as {
        tabs?: Array<{
          id?: number;
          title?: string;
          url?: string;
          active?: boolean;
          controllable?: boolean;
        }>;
        hint?: string;
      };
      const controllable = (result.tabs || []).filter((t) => t.controllable !== false && t.id != null);
      const lines = [
        "Open tabs (choose one with the user, then browse_request_session with tabId):",
        "",
        ...controllable.map(
          (t, i) =>
            `${i + 1}. [id=${t.id}] ${t.active ? "(active) " : ""}${t.title || "(untitled)"}\n   ${t.url || ""}`
        ),
      ];
      if (!controllable.length) {
        lines.push("(No controllable http(s) tabs. Ask the user to open a normal webpage.)");
      }
      if (result.hint) {
        lines.push("", result.hint);
      }
      return text(lines.join("\n"));
    }
  );

  server.tool(
    "browse_request_session",
    "Request user approval to control ONE specific tab. REQUIRED workflow: (1) browse_list_tabs (2) ask the user which tab (3) call this with that tabId. Shows Approve/Deny on the chosen tab. Do not call without tabId.",
    {
      tabId: z
        .number()
        .describe("Required. Tab id from browse_list_tabs that the user chose to grant access to."),
      reason: z
        .string()
        .optional()
        .describe("Short explanation shown in the approval prompt"),
      timeoutMs: z
        .number()
        .optional()
        .describe("How long to wait for approval (default 120000)"),
    },
    async ({ reason, tabId, timeoutMs }) => {
      const waitMs = timeoutMs || 120000;
      const started = await bridge.call(
        Methods.SESSION_REQUEST,
        {
          reason:
            reason ||
            "A Cursor agent wants to control this browser tab via WideBrowse.",
          tabId,
          timeoutMs: waitMs,
        },
        15000
      );
      const start = started as {
        status?: string;
        alreadyActive?: boolean;
        sessionId?: string;
        tabId?: number;
        url?: string;
        title?: string;
        message?: string;
        tabs?: unknown;
      };
      if (start.status === "need_tab") {
        return text({
          ...start,
          next: "Show the tabs to the user, ask which one to grant, then retry browse_request_session with tabId.",
        });
      }
      if (start.status === "active" || start.alreadyActive) {
        return text(start);
      }
      const session = await bridge.waitForSession(waitMs);
      return text({
        ...start,
        status: "active",
        sessionId: session.sessionId,
        message: "User approved the WideBrowse session on the selected tab.",
      });
    }
  );

  server.tool(
    "browse_end_session",
    "End the active WideBrowse session. Clears the edge hue / input lock and notifies the user (toast + OS notification) that the agent is done.",
    {},
    async () => {
      const result = await bridge.call(Methods.SESSION_END, {});
      return text(result);
    }
  );

  server.tool(
    "browse_lock",
    "Reinforce the agent-control indicator (soft hue + Take control) on the active session tab.",
    {},
    async () => {
      requireSession();
      const result = await bridge.call(Methods.SESSION_LOCK, {});
      return text(result);
    }
  );

  server.tool(
    "browse_unlock",
    "Unlock / end the session from the agent side (same as browse_end_session for the UI).",
    {},
    async () => {
      requireSession();
      const result = await bridge.call(Methods.SESSION_UNLOCK, {});
      return text(result);
    }
  );

  server.tool(
    "browse_tabs",
    "List/select/create/close tabs. Prefer browse_list_tabs before starting a session. select/create/close require an active session.",
    {
      action: z.enum(["list", "select", "create", "close"]),
      tabId: z.number().optional(),
      url: z.string().optional(),
      active: z.boolean().optional(),
    },
    async ({ action, tabId, url, active }) => {
      if (action !== "list") requireSession();
      if (action === "list") {
        return text(await bridge.call(Methods.TABS_LIST, {}));
      }
      if (action === "select") {
        return text(await bridge.call(Methods.TABS_SELECT, { tabId }));
      }
      if (action === "create") {
        return text(await bridge.call(Methods.TABS_CREATE, { url, active }));
      }
      return text(await bridge.call(Methods.TABS_CLOSE, { tabId }));
    }
  );

  server.tool(
    "browse_navigate",
    "Navigate the active (or specified) tab to a URL.",
    {
      url: z.string().describe("Absolute URL to open"),
      tabId: z.number().optional(),
    },
    async ({ url, tabId }) => {
      requireSession();
      return text(await bridge.call(Methods.NAVIGATE, { url, tabId }));
    }
  );

  server.tool(
    "browse_snapshot",
    "Capture an accessibility-oriented snapshot of the page with stable refs for click/type/fill.",
    {
      tabId: z.number().optional(),
      maxNodes: z.number().optional(),
    },
    async ({ tabId, maxNodes }) => {
      requireSession();
      const result = (await bridge.call(Methods.SNAPSHOT, { tabId, maxNodes })) as {
        snapshot?: string;
        url?: string;
        title?: string;
        nodeCount?: number;
      };
      const body = [
        `url: ${result.url || ""}`,
        `title: ${result.title || ""}`,
        `nodes: ${result.nodeCount ?? "?"}`,
        "",
        result.snapshot || "(empty)",
      ].join("\n");
      return text(body);
    }
  );

  server.tool(
    "browse_click",
    "Click an element by ref from browse_snapshot.",
    {
      ref: z.string(),
      tabId: z.number().optional(),
    },
    async ({ ref, tabId }) => {
      requireSession();
      return text(await bridge.call(Methods.CLICK, { ref, tabId }));
    }
  );

  server.tool(
    "browse_type",
    "Type text into an element by ref (appends unless clear=true).",
    {
      ref: z.string(),
      text: z.string(),
      clear: z.boolean().optional(),
      submit: z.boolean().optional(),
      tabId: z.number().optional(),
    },
    async (args) => {
      requireSession();
      return text(await bridge.call(Methods.TYPE, args));
    }
  );

  server.tool(
    "browse_fill",
    "Replace the value of an input/textarea/contenteditable by ref.",
    {
      ref: z.string(),
      value: z.string(),
      tabId: z.number().optional(),
    },
    async (args) => {
      requireSession();
      return text(await bridge.call(Methods.FILL, args));
    }
  );

  server.tool(
    "browse_select_option",
    "Select option(s) in a <select> by ref.",
    {
      ref: z.string(),
      values: z.array(z.string()).optional(),
      value: z.string().optional(),
      tabId: z.number().optional(),
    },
    async (args) => {
      requireSession();
      return text(await bridge.call(Methods.SELECT_OPTION, args));
    }
  );

  server.tool(
    "browse_press_key",
    "Press a keyboard key, optionally targeting an element ref.",
    {
      key: z.string(),
      ref: z.string().optional(),
      ctrlKey: z.boolean().optional(),
      metaKey: z.boolean().optional(),
      altKey: z.boolean().optional(),
      shiftKey: z.boolean().optional(),
      tabId: z.number().optional(),
    },
    async (args) => {
      requireSession();
      return text(await bridge.call(Methods.PRESS_KEY, args));
    }
  );

  server.tool(
    "browse_scroll",
    "Scroll the page by delta, or scroll an element ref into view.",
    {
      ref: z.string().optional(),
      deltaX: z.number().optional(),
      deltaY: z.number().optional(),
      block: z.string().optional(),
      inline: z.string().optional(),
      tabId: z.number().optional(),
    },
    async (args) => {
      requireSession();
      return text(await bridge.call(Methods.SCROLL, args));
    }
  );

  server.tool(
    "browse_take_screenshot",
    "Capture a PNG screenshot of the visible tab (base64). Prefer browse_snapshot for interactions.",
    {
      tabId: z.number().optional(),
    },
    async ({ tabId }) => {
      requireSession();
      const result = (await bridge.call(Methods.SCREENSHOT, { tabId })) as {
        base64: string;
        mimeType: string;
        url?: string;
      };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { url: result.url, mimeType: result.mimeType, note: "image follows" },
              null,
              2
            ),
          },
          {
            type: "image" as const,
            data: result.base64,
            mimeType: result.mimeType || "image/png",
          },
        ],
      };
    }
  );

  server.tool(
    "browse_status",
    "Check whether the WideBrowse extension is connected and whether a control session is active.",
    {},
    async () => {
      const health = bridge.health;
      let extensionConnected = health.extensionConnected;
      if (health.mode === "peer" && health.hubLink) {
        try {
          await bridge.call("ping", {}, 3000);
          extensionConnected = true;
        } catch (err) {
          extensionConnected = false;
          const msg = String((err as Error)?.message || err);
          if (!health.issue) {
            return text({
              ...health,
              extensionConnected: false,
              session: bridge.sessionInfo,
              bridgePort: port,
              bridgeMode: health.mode,
              hint: msg.includes("extension")
                ? "Hub is up but the browser extension is offline. Open the WideBrowse popup and click Reconnect bridge."
                : msg,
            });
          }
        }
      } else if (health.mode === "hub") {
        extensionConnected = bridge.connected;
      }
      return text({
        extensionConnected,
        session: bridge.sessionInfo,
        bridgePort: port,
        bridgeMode: health.mode,
        hubLink: health.hubLink,
        recovering: health.recovering,
        issue: health.issue,
        hint: health.hint,
      });
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    try {
      await bridge.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
