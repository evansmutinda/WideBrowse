/** WideBrowse shared wire protocol — keep in sync with shared/protocol.js */

export const DEFAULT_PORT = 17321;
export const WS_PATH = "/widebrowse";
export const PROTOCOL_VERSION = 1;

export type SessionState = "idle" | "pending" | "active";

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
} as const;

export type Method = (typeof Methods)[keyof typeof Methods];

export const Events = {
  EXTENSION_READY: "extension.ready",
  SESSION_APPROVED: "session.approved",
  SESSION_DENIED: "session.denied",
  SESSION_ENDED: "session.ended",
  CONNECTION_STATE: "connection.state",
} as const;

export type EventName = (typeof Events)[keyof typeof Events];

export type HelloMessage = {
  type: "hello";
  role: "extension" | "mcp";
  protocolVersion: number;
};

export type RequestMessage = {
  type: "request";
  id: string;
  method: Method | string;
  params?: Record<string, unknown>;
};

export type ResponseMessage = {
  type: "response";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

export type EventMessage = {
  type: "event";
  name: EventName | string;
  data?: Record<string, unknown>;
};

export type WireMessage = HelloMessage | RequestMessage | ResponseMessage | EventMessage;
