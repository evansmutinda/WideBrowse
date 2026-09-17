/**
 * WideBrowse shared wire protocol (MCP <-> Extension over WebSocket).
 * Keep in sync with mcp-server/src/protocol.ts
 */

export const DEFAULT_PORT = 17321;
export const WS_PATH = "/widebrowse";
export const PROTOCOL_VERSION = 1;

/** @typedef {'idle' | 'pending' | 'active'} SessionState */

/**
 * Methods the MCP server may invoke on the extension.
 * @enum {string}
 */
export const Methods = {
  SESSION_REQUEST: "session.request",
  SESSION_END: "session.end",
  SESSION_LOCK: "session.lock",
  SESSION_UNLOCK: "session.unlock",
  TABS_LIST: "tabs.list",
  TABS_SELECT: "tabs.select",
  TABS_CREATE: "tabs.create",
  TABS_CLOSE: "tabs.close",
  NAVIGATE: "navigate",
  SNAPSHOT: "snapshot",
  CLICK: "click",
  TYPE: "type",
  FILL: "fill",
  SELECT_OPTION: "selectOption",
  PRESS_KEY: "pressKey",
  SCROLL: "scroll",
  SCREENSHOT: "screenshot",
  PING: "ping",
};

/**
 * Events the extension may push to the MCP server.
 * @enum {string}
 */
export const Events = {
  EXTENSION_READY: "extension.ready",
  SESSION_APPROVED: "session.approved",
  SESSION_DENIED: "session.denied",
  SESSION_ENDED: "session.ended",
  CONNECTION_STATE: "connection.state",
};
