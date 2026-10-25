/**
 * WebSocket client for the DiceVision bridge,
 * wss://dicevision.dirtyowlbear.com/api/bridge/{code}.
 *
 * Protocol (dice-vision `docs/integrations/VTT.md`, `backend/app/routers/bridge.py`):
 * - Server -> client: `connected` (the session is valid; only now is it
 *   live, since an invalid code is accepted then closed with 4001), `roll`
 *   {data}, `waiting` {app}, `cancelled` {app}, `no_dice`, `pong`, `error`
 *   {message}.
 * - Client -> server: `waiting` {app_id}, `cancel` {app_id}, `ping`.
 *
 * The dashboard forwards a roll only while it believes an app is waiting and
 * drops that flag with each roll it sends, so whoever wants the next roll
 * re-sends `waiting` (the Controller does; this class just tracks
 * `registered`). Any `cancel` on the session clears the dashboard's waiting
 * state for every app on it, so one is only sent when needed.
 *
 * No OBR and no DOM: the socket constructor is injectable for tests. The
 * reconnect schedule is the Foundry module's: 2s, 4s, 8s, 16s, 30s, then
 * give up.
 */

export const WS_BASE_URL = "wss://dicevision.dirtyowlbear.com/api/bridge";
export const APP_ID = "owlbear";
export const PING_INTERVAL_MS = 30_000;
export const RECONNECT_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000];
export const INVALID_SESSION_CLOSE_CODE = 4001;

export type ConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting";

export type BridgeEvent =
  | { type: "state"; state: ConnectionState; sessionCode: string | null; reconnectAttempt: number }
  | { type: "roll"; data: unknown; timestamp: string | null }
  | { type: "no_dice" }
  | { type: "waiting"; app: string | null }
  | { type: "cancelled"; app: string | null }
  | { type: "error"; message: string }
  | { type: "invalid-session" }
  | { type: "gave-up" };

/** The part of WebSocket this client uses, so tests can hand in a fake. */
export interface SocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

const SOCKET_OPEN = 1;

export interface BridgeClientOptions {
  wsBaseUrl?: string;
  appId?: string;
  createSocket?: (url: string) => SocketLike;
  pingIntervalMs?: number;
  reconnectDelaysMs?: number[];
}

export class BridgeClient {
  private readonly wsBaseUrl: string;
  private readonly appId: string;
  private readonly createSocket: (url: string) => SocketLike;
  private readonly pingIntervalMs: number;
  private readonly reconnectDelaysMs: number[];

  private ws: SocketLike | null = null;
  private sessionCode: string | null = null;
  private connected = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<(event: BridgeEvent) => void>();

  /** Whether the bridge currently has us registered as waiting. */
  registered = false;

  constructor(options: BridgeClientOptions = {}) {
    this.wsBaseUrl = options.wsBaseUrl ?? WS_BASE_URL;
    this.appId = options.appId ?? APP_ID;
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.pingIntervalMs = options.pingIntervalMs ?? PING_INTERVAL_MS;
    this.reconnectDelaysMs = options.reconnectDelaysMs ?? RECONNECT_DELAYS_MS;
  }

  on(listener: (event: BridgeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get state(): ConnectionState {
    if (this.ws) return this.connected ? "connected" : "connecting";
    if (this.reconnectTimer) return "reconnecting";
    return "disconnected";
  }

  /** The normalized session code of the current or pending connection. */
  getSessionCode(): string | null {
    return this.sessionCode;
  }

  isConnected(): boolean {
    return this.connected && this.ws?.readyState === SOCKET_OPEN;
  }

  /** Whether a connection is open, opening, or waiting to reconnect. */
  isActive(): boolean {
    return this.ws !== null || this.reconnectTimer !== null;
  }

  /** Connect to a session, dropping any current connection first. */
  connect(sessionCode: string): void {
    this.disconnect();
    this.sessionCode = sessionCode;
    this.openSocket();
  }

  /** Disconnect, cancel any pending reconnect, and forget the session. */
  disconnect(): void {
    // No "cancel" first: the bridge drops our waiting registration when the
    // socket closes, and only tells the dashboard if no other app is still
    // waiting. An explicit cancel would always clear it.
    this.closeSocket();
    this.clearReconnect();
    this.reconnectAttempt = 0;
    this.sessionCode = null;
    this.emitState();
  }

  /** Register as waiting for the next roll. */
  sendWaiting(): boolean {
    const sent = this.send({ type: "waiting", app_id: this.appId });
    if (sent) this.registered = true;
    return sent;
  }

  /** Withdraw our waiting registration. */
  sendCancel(): boolean {
    const sent = this.send({ type: "cancel", app_id: this.appId });
    if (sent) this.registered = false;
    return sent;
  }

  send(message: Record<string, unknown>): boolean {
    if (!this.ws || this.ws.readyState !== SOCKET_OPEN) return false;
    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch (err) {
      console.warn("[DiceVision] Failed to send:", err);
      return false;
    }
  }

  private openSocket(): void {
    if (!this.sessionCode) return;
    this.closeSocket();
    const url = `${this.wsBaseUrl}/${this.sessionCode}`;
    console.log(`[DiceVision] Connecting to ${url}`);

    let ws: SocketLike;
    try {
      ws = this.createSocket(url);
    } catch (err) {
      console.error("[DiceVision] Failed to create WebSocket:", err);
      this.emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
      this.sessionCode = null;
      this.emitState();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      // Not connected yet: the server accepts invalid sessions before
      // closing them with 4001, so the session only counts once it sends
      // "connected".
      this.startPing();
    };

    ws.onmessage = (event) => {
      let message: unknown;
      try {
        message = JSON.parse(String(event.data));
      } catch (err) {
        console.error("[DiceVision] Failed to parse message:", err);
        return;
      }
      try {
        this.onMessage(message);
      } catch (err) {
        console.error("[DiceVision] Failed to handle message:", err);
      }
    };

    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      console.log(`[DiceVision] Disconnected: ${event.code} ${event.reason}`);
      this.ws = null;
      this.connected = false;
      this.registered = false;
      this.stopPing();

      if (event.code === INVALID_SESSION_CLOSE_CODE) {
        this.sessionCode = null;
        this.emit({ type: "invalid-session" });
        this.emitState();
        return;
      }
      this.scheduleReconnect();
    };

    ws.onerror = (err) => {
      console.error("[DiceVision] WebSocket error:", err);
    };

    this.emitState();
  }

  private closeSocket(): void {
    this.stopPing();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.onclose = null;
      ws.onmessage = null;
      ws.onopen = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch (err) {
        console.warn("[DiceVision] Failed to close socket:", err);
      }
    }
    this.connected = false;
    this.registered = false;
  }

  private onMessage(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const msg = message as Record<string, unknown>;
    const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
    switch (msg.type) {
      case "connected":
        this.connected = true;
        this.reconnectAttempt = 0;
        this.emitState();
        break;
      case "roll":
        this.emit({ type: "roll", data: msg.data, timestamp: str(msg.timestamp) });
        break;
      case "no_dice":
        this.emit({ type: "no_dice" });
        break;
      case "waiting":
        this.emit({ type: "waiting", app: str(msg.app) });
        break;
      case "cancelled":
        // Any app's cancel (or another client's on a shared code) clears the
        // dashboard's waiting state and may have removed us from the bridge.
        this.registered = false;
        this.emit({ type: "cancelled", app: str(msg.app) });
        break;
      case "pong":
        break;
      case "error":
        this.emit({ type: "error", message: str(msg.message) ?? "Unknown server error" });
        break;
      default:
        console.log("[DiceVision] Unknown message type:", msg.type);
    }
  }

  private scheduleReconnect(): void {
    if (!this.sessionCode) {
      this.emitState();
      return;
    }
    if (this.reconnectAttempt >= this.reconnectDelaysMs.length) {
      console.log("[DiceVision] Max reconnection attempts reached");
      this.sessionCode = null;
      this.reconnectAttempt = 0;
      this.emit({ type: "gave-up" });
      this.emitState();
      return;
    }
    const delay = this.reconnectDelaysMs[this.reconnectAttempt];
    this.reconnectAttempt++;
    console.log(`[DiceVision] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt}/${this.reconnectDelaysMs.length})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
    this.emitState();
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => this.send({ type: "ping" }), this.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private emitState(): void {
    this.emit({ type: "state", state: this.state, sessionCode: this.sessionCode, reconnectAttempt: this.reconnectAttempt });
  }

  private emit(event: BridgeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[DiceVision] Listener failed:", err);
      }
    }
  }
}
