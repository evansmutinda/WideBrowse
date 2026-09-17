import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_PORT,
  WS_PATH,
  PROTOCOL_VERSION,
  Events,
  type WireMessage,
  type ResponseMessage,
  type EventMessage,
} from "./protocol.js";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

export type SessionInfo = {
  state: "idle" | "pending" | "active";
  sessionId: string | null;
};

export class ExtensionBridge {
  private wss: WebSocketServer | null = null;
  private httpServer: ReturnType<typeof createServer> | null = null;
  private extension: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private session: SessionInfo = { state: "idle", sessionId: null };
  private eventHandlers = new Set<(ev: EventMessage) => void>();
  readonly port: number;

  constructor(port = DEFAULT_PORT) {
    this.port = port;
  }

  get connected(): boolean {
    return Boolean(this.extension && this.extension.readyState === WebSocket.OPEN);
  }

  get sessionInfo(): SessionInfo {
    return { ...this.session };
  }

  onEvent(handler: (ev: EventMessage) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  async start(): Promise<void> {
    if (this.wss) return;
    this.httpServer = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("WideBrowse MCP bridge\n");
    });

    this.wss = new WebSocketServer({
      server: this.httpServer,
      path: WS_PATH,
    });

    this.wss.on("connection", (ws, req) => {
      const host = req.socket.remoteAddress || "";
      if (!isLocalAddress(host)) {
        ws.close(1008, "Local connections only");
        return;
      }
      // Prefer a single extension client
      if (this.extension && this.extension.readyState === WebSocket.OPEN) {
        try {
          this.extension.close(1000, "Replaced by new extension connection");
        } catch {
          /* ignore */
        }
      }
      this.extension = ws;
      ws.on("message", (data) => this.onMessage(ws, data.toString()));
      ws.on("close", () => {
        if (this.extension === ws) {
          this.extension = null;
          this.session = { state: "idle", sessionId: null };
          this.rejectAll("Extension disconnected");
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(this.port, "127.0.0.1", () => resolve());
      this.httpServer!.on("error", reject);
    });
  }

  async stop(): Promise<void> {
    this.rejectAll("Bridge stopped");
    this.extension?.close();
    this.extension = null;
    await new Promise<void>((resolve) => {
      this.wss?.close(() => resolve());
    });
    this.wss = null;
    await new Promise<void>((resolve, reject) => {
      if (!this.httpServer) return resolve();
      this.httpServer.close((err) => (err ? reject(err) : resolve()));
    });
    this.httpServer = null;
  }

  async call(method: string, params: Record<string, unknown> = {}, timeoutMs = 120000): Promise<unknown> {
    if (!this.connected || !this.extension) {
      throw new Error(
        "WideBrowse extension is not connected. Load the extension and ensure the MCP bridge is running."
      );
    }
    const id = randomUUID();
    const message: WireMessage = { type: "request", id, method, params };
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for extension response: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.extension.send(JSON.stringify(message));
    const value = await result;
    if (method === "session.request" && value && typeof value === "object") {
      const v = value as { sessionId?: string; status?: string; alreadyActive?: boolean };
      if (v.status === "active" || v.alreadyActive) {
        this.session = {
          state: "active",
          sessionId: v.sessionId || this.session.sessionId,
        };
      } else if (v.status === "pending") {
        this.session = {
          state: "pending",
          sessionId: v.sessionId || this.session.sessionId,
        };
      }
    } else if (method === "session.end" || method === "session.unlock") {
      this.session = { state: "idle", sessionId: null };
    }
    return value;
  }

  async waitForSession(timeoutMs = 120000): Promise<SessionInfo> {
    const started = Date.now();
    let sawPending = this.session.state === "pending" || this.session.state === "active";
    while (Date.now() - started < timeoutMs) {
      if (this.session.state === "active") return this.sessionInfo;
      if (this.session.state === "pending") sawPending = true;
      if (sawPending && this.session.state === "idle") {
        throw new Error("User denied WideBrowse session (or approval timed out).");
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error("Timed out waiting for the user to Approve the WideBrowse session.");
  }

  private onMessage(_ws: WebSocket, raw: string): void {
    let msg: WireMessage;
    try {
      msg = JSON.parse(raw) as WireMessage;
    } catch {
      return;
    }
    if (msg.type === "hello") {
      return;
    }
    if (msg.type === "response") {
      this.handleResponse(msg);
      return;
    }
    if (msg.type === "event") {
      this.handleEvent(msg);
      return;
    }
  }

  private handleResponse(msg: ResponseMessage): void {
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(msg.id);
    if (msg.ok) pending.resolve(msg.result);
    else pending.reject(new Error(msg.error || "Extension request failed"));
  }

  private handleEvent(msg: EventMessage): void {
    if (msg.name === Events.SESSION_APPROVED) {
      this.session = {
        state: "active",
        sessionId: String(msg.data?.sessionId || this.session.sessionId || ""),
      };
    } else if (msg.name === Events.SESSION_DENIED || msg.name === Events.SESSION_ENDED) {
      this.session = { state: "idle", sessionId: null };
    } else if (msg.name === Events.EXTENSION_READY) {
      // no-op; connection already tracked
    }
    for (const handler of this.eventHandlers) handler(msg);
  }

  private rejectAll(reason: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pending.delete(id);
    }
  }
}

function isLocalAddress(addr: string): boolean {
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === "::ffff:127.0.0.1" ||
    addr.endsWith("127.0.0.1")
  );
}

export { DEFAULT_PORT, PROTOCOL_VERSION, WS_PATH };
