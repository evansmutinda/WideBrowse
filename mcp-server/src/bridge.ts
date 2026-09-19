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
  type HelloMessage,
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

export type BridgeHealth = {
  mode: "hub" | "peer" | "stopped";
  port: number;
  hubLink: boolean;
  extensionConnected: boolean;
  recovering: boolean;
  issue: string | null;
  hint: string | null;
};

type ClientRole = "unknown" | "extension" | "mcp";

type PortProbe =
  | { kind: "free" }
  | { kind: "widebrowse" }
  | { kind: "other"; detail: string }
  | { kind: "unknown"; detail: string };

const RECOVER_MIN_MS = 750;
const RECOVER_MAX_MS = 10000;
const PORT_WAIT_DEFAULT_MS = 60_000;
const PORT_WAIT_POLL_MS = 2500;
const ENSURE_READY_MS = 15_000;

/**
 * Owns the localhost WebSocket hub (or joins an existing one when the port is busy).
 * Cursor may spawn multiple WideBrowse MCP processes across windows; only one can bind
 * 17321 — others attach as MCP peers and share the same extension connection.
 *
 * If the hub disappears, peers self-heal: rejoin a WideBrowse hub, or take over the port
 * when it becomes free. Non-WideBrowse occupants are reported and waited on at startup.
 */
export class ExtensionBridge {
  private wss: WebSocketServer | null = null;
  private httpServer: ReturnType<typeof createServer> | null = null;
  private extension: WebSocket | null = null;
  private peers = new Set<WebSocket>();
  private peerSocket: WebSocket | null = null;
  private mode: "hub" | "peer" | "stopped" = "stopped";
  private pending = new Map<string, Pending>();
  private session: SessionInfo = { state: "idle", sessionId: null };
  private eventHandlers = new Set<(ev: EventMessage) => void>();
  private roles = new WeakMap<WebSocket, ClientRole>();
  private recovering = false;
  private recoverTimer: NodeJS.Timeout | null = null;
  private recoverAttempt = 0;
  private issue: string | null = null;
  private stopRequested = false;
  readonly port: number;

  constructor(port = DEFAULT_PORT) {
    this.port = port;
  }

  get connected(): boolean {
    if (this.mode === "peer") {
      return Boolean(this.peerSocket && this.peerSocket.readyState === WebSocket.OPEN);
    }
    return Boolean(this.extension && this.extension.readyState === WebSocket.OPEN);
  }

  get bridgeMode(): "hub" | "peer" | "stopped" {
    return this.mode;
  }

  get sessionInfo(): SessionInfo {
    return { ...this.session };
  }

  get health(): BridgeHealth {
    const hubLink =
      this.mode === "hub"
        ? true
        : Boolean(this.peerSocket && this.peerSocket.readyState === WebSocket.OPEN);
    const extensionConnected =
      this.mode === "hub"
        ? Boolean(this.extension && this.extension.readyState === WebSocket.OPEN)
        : this.connected; // peer: hub link only; ping refines this in browse_status
    return {
      mode: this.mode,
      port: this.port,
      hubLink,
      extensionConnected,
      recovering: this.recovering,
      issue: this.issue,
      hint: this.buildHint(hubLink, extensionConnected),
    };
  }

  onEvent(handler: (ev: EventMessage) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  async start(): Promise<void> {
    if (this.mode !== "stopped") return;
    this.stopRequested = false;
    await this.becomeHubOrPeer({ waitForForeignPort: true });
  }

  /**
   * Ensure we own a hub or a live peer link. Used before tool calls so a dead peer
   * recovers without requiring an MCP reload. Does not wait for the extension —
   * that is reported separately when the hub/peer link is up.
   */
  async ensureReady(timeoutMs = ENSURE_READY_MS): Promise<void> {
    if (this.hasTransportLink()) return;
    this.scheduleRecover("Bridge link down before tool call");
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (this.hasTransportLink()) return;
      if (this.stopRequested) throw new Error("WideBrowse bridge stopped.");
      await sleep(200);
    }
    throw new Error(this.issue || this.buildHint(false, false) || "WideBrowse bridge is not ready.");
  }

  private async becomeHubOrPeer(opts: { waitForForeignPort: boolean }): Promise<void> {
    const waitMs = Number(process.env.WIDEBROWSE_PORT_WAIT_MS || PORT_WAIT_DEFAULT_MS);
    const deadline = opts.waitForForeignPort ? Date.now() + Math.max(0, waitMs) : Date.now();

    while (!this.stopRequested) {
      try {
        await this.startHub();
        this.mode = "hub";
        this.clearIssue();
        this.recovering = false;
        this.recoverAttempt = 0;
        console.error(`[widebrowse] Hub listening on ws://127.0.0.1:${this.port}${WS_PATH}`);
        return;
      } catch (err) {
        await this.cleanupPartialHub();
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== "EADDRINUSE") throw err;
      }

      const probe = await this.probePort();
      if (probe.kind === "widebrowse") {
        await this.startPeer();
        this.mode = "peer";
        this.clearIssue();
        this.recovering = false;
        this.recoverAttempt = 0;
        console.error(
          `[widebrowse] Port ${this.port} already has a WideBrowse hub — joined as peer (shared extension).`
        );
        return;
      }

      if (probe.kind === "free") {
        // Race: port freed between bind attempt and probe — loop again.
        continue;
      }

      const detail =
        probe.kind === "other" || probe.kind === "unknown"
          ? probe.detail
          : `port ${this.port} is busy`;
      this.issue = `Port ${this.port} is in use by another process (${detail}).`;
      console.error(
        `[widebrowse] ${this.issue} Waiting for it to free (set WIDEBROWSE_PORT to use another port)...`
      );

      if (!opts.waitForForeignPort || Date.now() >= deadline) {
        throw new Error(
          `${this.issue} Free the port, set WIDEBROWSE_PORT, or stop the other process, then reload MCP.`
        );
      }
      await sleep(PORT_WAIT_POLL_MS);
    }

    throw new Error("WideBrowse bridge stopped while waiting for the port.");
  }

  private async probePort(): Promise<PortProbe> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/`, {
        signal: AbortSignal.timeout(1500),
      });
      const text = await res.text();
      if (text.includes("WideBrowse MCP bridge")) return { kind: "widebrowse" };
      return { kind: "other", detail: `HTTP ${res.status} (not WideBrowse)` };
    } catch (err) {
      const msg = String((err as Error)?.message || err);
      // Connection refused ≈ free enough to retry bind
      if (/ECONNREFUSED|fetch failed|NetworkError|aborted/i.test(msg)) {
        // Could still be a non-HTTP listener; bind attempt will decide.
        return { kind: "unknown", detail: msg };
      }
      return { kind: "unknown", detail: msg };
    }
  }

  private async cleanupPartialHub(): Promise<void> {
    try {
      this.wss?.close();
    } catch {
      /* ignore */
    }
    this.wss = null;
    await new Promise<void>((resolve) => {
      if (!this.httpServer) return resolve();
      this.httpServer.close(() => resolve());
    });
    this.httpServer = null;
  }

  private async startHub(): Promise<void> {
    this.httpServer = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("WideBrowse MCP bridge\n");
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.httpServer?.off("error", onError);
        reject(err);
      };
      this.httpServer!.once("error", onError);
      this.httpServer!.listen(this.port, "127.0.0.1", () => {
        this.httpServer?.off("error", onError);
        resolve();
      });
    });

    this.wss = new WebSocketServer({
      server: this.httpServer,
      path: WS_PATH,
    });
    this.wss.on("error", () => {
      /* surfaced via httpServer */
    });

    this.wss.on("connection", (ws, req) => {
      const host = req.socket.remoteAddress || "";
      if (!isLocalAddress(host)) {
        ws.close(1008, "Local connections only");
        return;
      }
      this.roles.set(ws, "unknown");
      ws.on("message", (data) => this.onHubMessage(ws, data.toString()));
      ws.on("close", () => this.onHubClose(ws));
    });
  }

  private async startPeer(): Promise<void> {
    const probe = await this.probePort();
    if (probe.kind !== "widebrowse") {
      throw new Error(
        `Port ${this.port} is busy and not reachable as a WideBrowse hub. (${
          probe.kind === "free" ? "no listener" : probe.detail
        })`
      );
    }

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}${WS_PATH}`);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("Timed out joining existing WideBrowse bridge"));
      }, 5000);

      ws.on("open", () => {
        const hello: HelloMessage = {
          type: "hello",
          role: "mcp",
          protocolVersion: PROTOCOL_VERSION,
        };
        ws.send(JSON.stringify(hello));
        this.peerSocket = ws;
        clearTimeout(timer);
        resolve();
      });
      ws.on("message", (data) => this.onPeerMessage(data.toString()));
      ws.on("close", () => {
        if (this.peerSocket === ws) {
          this.peerSocket = null;
          this.rejectAll("WideBrowse hub disconnected");
          if (!this.stopRequested && this.mode === "peer") {
            this.scheduleRecover("WideBrowse hub disconnected");
          }
        }
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private scheduleRecover(reason: string): void {
    if (this.stopRequested) return;
    this.issue = reason;
    if (this.recoverTimer) return;
    this.recovering = true;
    const delay = Math.min(RECOVER_MAX_MS, RECOVER_MIN_MS * Math.pow(1.6, this.recoverAttempt));
    this.recoverAttempt += 1;
    console.error(`[widebrowse] ${reason}. Recovering in ${Math.round(delay)}ms...`);
    this.recoverTimer = setTimeout(() => {
      this.recoverTimer = null;
      void this.recoverCycle();
    }, delay);
  }

  private async recoverCycle(): Promise<void> {
    if (this.stopRequested) return;
    if (this.hasTransportLink()) {
      this.recovering = false;
      this.clearIssue();
      this.recoverAttempt = 0;
      return;
    }

    // Drop peer mode so we can try binding as hub again.
    this.mode = "stopped";
    try {
      this.peerSocket?.close();
    } catch {
      /* ignore */
    }
    this.peerSocket = null;

    try {
      await this.becomeHubOrPeer({ waitForForeignPort: false });
      console.error(`[widebrowse] Recovered as ${this.mode}.`);
      return;
    } catch (err) {
      this.issue = String((err as Error)?.message || err);
      console.error(`[widebrowse] Recovery attempt failed: ${this.issue}`);
      this.scheduleRecover(this.issue);
    }
  }

  /** Hub HTTP server bound, or peer WebSocket open. */
  private hasTransportLink(): boolean {
    if (this.mode === "hub") {
      return Boolean(this.httpServer && this.wss);
    }
    if (this.mode === "peer") {
      return Boolean(this.peerSocket && this.peerSocket.readyState === WebSocket.OPEN);
    }
    return false;
  }

  private clearIssue(): void {
    this.issue = null;
  }

  private buildHint(hubLink: boolean, extensionConnected: boolean): string | null {
    if (this.recovering) {
      return (
        this.issue ||
        `Recovering bridge on port ${this.port}. If this persists, free the port or set WIDEBROWSE_PORT.`
      );
    }
    if (this.issue) return this.issue;
    if (this.mode === "peer" && !hubLink) {
      return `Lost WideBrowse hub on port ${this.port}. Waiting to rejoin or take over the port.`;
    }
    if (hubLink && !extensionConnected) {
      return "Hub is up but the browser extension is offline. Open the WideBrowse popup and click Reconnect bridge.";
    }
    return null;
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.recovering = false;
    if (this.recoverTimer) {
      clearTimeout(this.recoverTimer);
      this.recoverTimer = null;
    }
    this.rejectAll("Bridge stopped");
    this.extension?.close();
    this.extension = null;
    for (const peer of this.peers) {
      try {
        peer.close();
      } catch {
        /* ignore */
      }
    }
    this.peers.clear();
    try {
      this.peerSocket?.close();
    } catch {
      /* ignore */
    }
    this.peerSocket = null;

    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      for (const client of this.wss.clients) {
        try {
          client.terminate();
        } catch {
          /* ignore */
        }
      }
      this.wss.close(() => resolve());
      setTimeout(resolve, 500);
    });
    this.wss = null;

    await new Promise<void>((resolve) => {
      if (!this.httpServer) return resolve();
      try {
        this.httpServer.closeAllConnections?.();
      } catch {
        /* ignore */
      }
      this.httpServer.close(() => resolve());
      setTimeout(resolve, 500);
    });
    this.httpServer = null;
    this.mode = "stopped";
  }

  async call(method: string, params: Record<string, unknown> = {}, timeoutMs = 120000): Promise<unknown> {
    if (!this.hasTransportLink()) {
      await this.ensureReady();
    }

    const sink = this.mode === "peer" ? this.peerSocket : this.extension;
    if (!sink || sink.readyState !== WebSocket.OPEN) {
      const hubLink = this.hasTransportLink();
      const hint = this.buildHint(hubLink, false);
      if (this.mode === "peer" && !hubLink) {
        throw new Error(
          hint ||
            `WideBrowse hub link is down on port ${this.port}. Recovery is in progress — retry in a few seconds, or free the port / reload MCP.`
        );
      }
      throw new Error(
        hint ||
          "WideBrowse extension is not connected. Open the WideBrowse popup and click Reconnect bridge."
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
    sink.send(JSON.stringify(message));
    const value = await result;
    this.applyCallSideEffects(method, value);
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

  private applyCallSideEffects(method: string, value: unknown): void {
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
  }

  private onHubMessage(ws: WebSocket, raw: string): void {
    let msg: WireMessage;
    try {
      msg = JSON.parse(raw) as WireMessage;
    } catch {
      return;
    }

    if (msg.type === "hello") {
      const role = msg.role === "mcp" ? "mcp" : "extension";
      this.roles.set(ws, role);
      if (role === "extension") {
        if (this.extension && this.extension !== ws && this.extension.readyState === WebSocket.OPEN) {
          try {
            this.extension.close(1000, "Replaced by new extension connection");
          } catch {
            /* ignore */
          }
        }
        this.extension = ws;
      } else {
        this.peers.add(ws);
      }
      return;
    }

    const role = this.roles.get(ws) || "unknown";

    // Legacy: treat unclassified traffic as extension until hello arrives
    if (role === "unknown" || role === "extension") {
      if (!this.extension) this.extension = ws;
      if (msg.type === "response") {
        this.handleResponse(msg);
        this.forwardToPeers(msg);
        return;
      }
      if (msg.type === "event") {
        this.handleEvent(msg);
        this.forwardToPeers(msg);
        return;
      }
      return;
    }

    // MCP peer → forward requests to extension
    if (role === "mcp" && msg.type === "request") {
      if (!this.extension || this.extension.readyState !== WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "response",
            id: msg.id,
            ok: false,
            error: "WideBrowse extension is not connected to the hub.",
          })
        );
        return;
      }
      // Route response back to requesting peer
      const timer = setTimeout(() => {
        peerRoute.delete(msg.id);
      }, 130000);
      peerRoute.set(msg.id, { peer: ws, timer });
      this.extension.send(JSON.stringify(msg));
      return;
    }
  }

  private onHubClose(ws: WebSocket): void {
    const role = this.roles.get(ws);
    this.peers.delete(ws);
    if (this.extension === ws) {
      this.extension = null;
      this.session = { state: "idle", sessionId: null };
      this.rejectAll("Extension disconnected");
      this.forwardToPeers({
        type: "event",
        name: Events.SESSION_ENDED,
        data: { reason: "extension_disconnect" },
      });
    }
    if (role === "mcp") {
      // peer left — nothing else
    }
  }

  private onPeerMessage(raw: string): void {
    let msg: WireMessage;
    try {
      msg = JSON.parse(raw) as WireMessage;
    } catch {
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

  private forwardToPeers(msg: WireMessage): void {
    // If this is a response, prefer the peer that owns the request id
    if (msg.type === "response") {
      const routed = peerRoute.get(msg.id);
      if (routed) {
        clearTimeout(routed.timer);
        peerRoute.delete(msg.id);
        if (routed.peer.readyState === WebSocket.OPEN) {
          routed.peer.send(JSON.stringify(msg));
        }
        return;
      }
    }
    const payload = JSON.stringify(msg);
    for (const peer of this.peers) {
      if (peer.readyState === WebSocket.OPEN) peer.send(payload);
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

const peerRoute = new Map<string, { peer: WebSocket; timer: NodeJS.Timeout }>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
