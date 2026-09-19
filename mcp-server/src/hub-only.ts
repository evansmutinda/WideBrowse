#!/usr/bin/env node
/**
 * Standalone WideBrowse WebSocket hub (no MCP stdio).
 * Use when you want the extension connected without Cursor MCP, or to debug the bridge.
 *
 *   node dist/hub-only.js
 */
import { ExtensionBridge, DEFAULT_PORT } from "./bridge.js";

const port = Number(process.env.WIDEBROWSE_PORT || DEFAULT_PORT);
const bridge = new ExtensionBridge(port);

await bridge.start();
if (bridge.bridgeMode === "hub") {
  console.log(`WideBrowse hub listening on ws://127.0.0.1:${port}/widebrowse`);
} else {
  console.log(`WideBrowse joined existing hub on port ${port} as peer (another process already owns the port).`);
}
console.log("Leave this process running. Extension popup should show Bridge=connected.");

const shutdown = async () => {
  await bridge.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
