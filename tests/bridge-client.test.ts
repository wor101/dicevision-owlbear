import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeClient, type BridgeEvent, type SocketLike } from "../src/bridge-client";
import { formatSessionCode, normalizeSessionCode } from "../src/session-code";

/** A fake WebSocket the test drives by hand. */
class FakeSocket implements SocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closed = false;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.closed = true;
    this.readyState = 3;
  }

  open() {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(message: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  drop(code = 1006, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  /** Open and confirm the session in one go */
  confirm(code = "XKRM4N7B") {
    this.open();
    this.receive({ type: "connected", session_code: code, waiting: false, waiting_apps: [] });
  }
}

function makeClient() {
  const client = new BridgeClient({ createSocket: (url) => new FakeSocket(url) });
  const events: BridgeEvent[] = [];
  client.on((e) => events.push(e));
  const last = () => FakeSocket.instances[FakeSocket.instances.length - 1];
  const states = () => events.filter((e) => e.type === "state").map((e) => (e as { state: string }).state);
  return { client, events, last, states };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("session codes", () => {
  it("normalizes and formats", () => {
    expect(normalizeSessionCode("xkrm-4n7b")).toBe("XKRM4N7B");
    expect(normalizeSessionCode(" XKRM 4N7B ")).toBe("XKRM4N7B");
    expect(normalizeSessionCode("XKRM4N7")).toBeNull();
    expect(normalizeSessionCode("XKRM4N70")).toBeNull(); // 0 isn't in the alphabet
    expect(normalizeSessionCode(42)).toBeNull();
    expect(formatSessionCode("XKRM4N7B")).toBe("XKRM-4N7B");
    expect(formatSessionCode("XKRM")).toBe("XKRM");
  });
});

describe("BridgeClient", () => {
  it("is live only after the server confirms the session", () => {
    const { client, last, states } = makeClient();
    client.connect("XKRM4N7B");
    expect(last().url).toBe("wss://dicevision.dirtyowlbear.com/api/bridge/XKRM4N7B");
    expect(client.state).toBe("connecting");
    last().open();
    expect(client.isConnected()).toBe(false);
    last().receive({ type: "connected", session_code: "XKRM4N7B" });
    expect(client.isConnected()).toBe(true);
    expect(states()).toEqual(["disconnected", "connecting", "connected"]);
  });

  it("pings every 30 seconds while the socket is open", () => {
    const { client, last } = makeClient();
    client.connect("XKRM4N7B");
    last().confirm();
    vi.advanceTimersByTime(60_000);
    expect(last().sent.filter((m) => m.type === "ping")).toHaveLength(2);
    client.disconnect();
    vi.advanceTimersByTime(60_000);
    expect(last().sent.filter((m) => m.type === "ping")).toHaveLength(2);
  });

  it("tracks waiting registration and sends the app id", () => {
    const { client, last } = makeClient();
    client.connect("XKRM4N7B");
    expect(client.sendWaiting()).toBe(false); // not open yet
    last().confirm();
    expect(client.sendWaiting()).toBe(true);
    expect(client.registered).toBe(true);
    expect(last().sent.at(-1)).toEqual({ type: "waiting", app_id: "owlbear" });
    expect(client.sendCancel()).toBe(true);
    expect(client.registered).toBe(false);
    expect(last().sent.at(-1)).toEqual({ type: "cancel", app_id: "owlbear" });
  });

  it("relays rolls, no_dice, cancelled and errors", () => {
    const { client, last, events } = makeClient();
    client.connect("XKRM4N7B");
    last().confirm();
    client.sendWaiting();
    last().receive({ type: "roll", data: { dice: [], total: 0 }, timestamp: "t" });
    last().receive({ type: "no_dice" });
    last().receive({ type: "cancelled", app: "foundry" });
    last().receive({ type: "error", message: "nope" });
    last().receive({ type: "pong" });
    last().receive({ type: "mystery" });
    const relayed = events.filter((e) => e.type !== "state");
    expect(relayed).toEqual([
      { type: "roll", data: { dice: [], total: 0 }, timestamp: "t" },
      { type: "no_dice" },
      { type: "cancelled", app: "foundry" },
      { type: "error", message: "nope" },
    ]);
    expect(client.registered).toBe(false); // cancelled cleared it
  });

  it("stops on an invalid session (4001) and forgets the code", () => {
    const { client, last, events } = makeClient();
    client.connect("XKRM4N7B");
    last().open();
    last().drop(4001, "Invalid session");
    expect(events.some((e) => e.type === "invalid-session")).toBe(true);
    expect(client.state).toBe("disconnected");
    expect(client.getSessionCode()).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("reconnects with backoff, then gives up", () => {
    const { client, last, events } = makeClient();
    client.connect("XKRM4N7B");
    last().confirm();
    last().drop();
    expect(client.state).toBe("reconnecting");
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(2_000);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(client.state).toBe("connecting");
    for (const delay of [4_000, 8_000, 16_000, 30_000]) {
      last().drop();
      vi.advanceTimersByTime(delay);
    }
    expect(FakeSocket.instances).toHaveLength(6);
    last().drop();
    expect(events.some((e) => e.type === "gave-up")).toBe(true);
    expect(client.state).toBe("disconnected");
    expect(client.isActive()).toBe(false);
  });

  it("a confirmed session resets the retry count", () => {
    const { client, last } = makeClient();
    client.connect("XKRM4N7B");
    last().confirm();
    last().drop();
    vi.advanceTimersByTime(2_000);
    last().confirm();
    last().drop();
    vi.advanceTimersByTime(1_999);
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(3); // first delay again, not the second
  });

  it("disconnect closes quietly: no reconnect, no stale close handler", () => {
    const { client, last, events } = makeClient();
    client.connect("XKRM4N7B");
    const socket = last();
    socket.confirm();
    client.disconnect();
    expect(socket.closed).toBe(true);
    expect(client.state).toBe("disconnected");
    socket.drop(); // a late close event from the old socket
    expect(client.state).toBe("disconnected");
    expect(events.filter((e) => e.type === "gave-up")).toHaveLength(0);
  });

  it("connecting again drops the previous socket", () => {
    const { client, last } = makeClient();
    client.connect("XKRM4N7B");
    const first = last();
    first.confirm();
    client.connect("ABCD2345");
    expect(first.closed).toBe(true);
    expect(last().url.endsWith("/ABCD2345")).toBe(true);
  });

  it("survives a malformed message and a throwing listener", () => {
    const { client, last } = makeClient();
    client.on(() => {
      throw new Error("boom");
    });
    client.connect("XKRM4N7B");
    last().confirm();
    last().onmessage?.({ data: "not json" });
    expect(client.isConnected()).toBe(true);
  });
});
