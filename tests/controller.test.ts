import { beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeClient, type SocketLike } from "../src/bridge-client";
import { Controller, type ControllerState } from "../src/controller";
import type { Host, NotificationVariant } from "../src/host";
import { ROLL_CHANNEL, type PlayerInfo, type SharedRoll } from "../src/share";
import type { StorageLike } from "../src/settings";

class FakeSocket implements SocketLike {
  static last: FakeSocket;
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  constructor() {
    FakeSocket.last = this;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  confirm() {
    this.readyState = 1;
    this.onopen?.({});
    this.onmessage?.({ data: JSON.stringify({ type: "connected", session_code: "XKRM4N7B" }) });
  }
  receive(message: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  types() {
    return this.sent.map((m) => m.type);
  }
}

/** A recording Host: notifications, badge, broadcasts, and a way to deliver incoming ones. */
function fakeHost(player: PlayerInfo, actionOpen = false) {
  const notifications: { message: string; variant: NotificationVariant }[] = [];
  const badges: (string | undefined)[] = [];
  const broadcasts: { channel: string; data: unknown }[] = [];
  const subscribers = new Map<string, (data: unknown) => void>();
  const host: Host = {
    available: true,
    getPlayer: async () => player,
    onPlayerChange: () => () => {},
    notify: async (message, variant) => void notifications.push({ message, variant }),
    setBadge: async (text) => void badges.push(text),
    isActionOpen: async () => actionOpen,
    broadcast: async (channel, data) => void broadcasts.push({ channel, data }),
    onBroadcast: (channel, callback) => {
      subscribers.set(channel, callback);
      return () => subscribers.delete(channel);
    },
  };
  return { host, notifications, badges, broadcasts, deliver: (data: unknown) => subscribers.get(ROLL_CHANNEL)?.(data) };
}

function memoryStorage(initial?: string): StorageLike {
  const data = new Map<string, string>();
  if (initial) data.set("com.dirtyowlbear.dicevision/settings", initial);
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

const will: PlayerInfo = { id: "p1", name: "Will", color: "#f00", role: "PLAYER" };
const d20 = (face: string, readable = true) => ({ type: "d20", value: readable ? Number(face) : -1, face, readable });
const flush = () => new Promise((r) => setTimeout(r, 0));

async function setup(opts: { storage?: StorageLike | null; actionOpen?: boolean; player?: PlayerInfo } = {}) {
  const fake = fakeHost(opts.player ?? will, opts.actionOpen ?? false);
  const client = new BridgeClient({ createSocket: () => new FakeSocket() });
  const controller = new Controller(fake.host, { client, storage: opts.storage === undefined ? memoryStorage() : opts.storage, now: () => new Date("2026-10-25T10:00:00Z") });
  const states: ControllerState[] = [];
  controller.onChange((s) => states.push(s));
  await controller.start();
  const state = () => controller.getState();
  return { ...fake, client, controller, states, state };
}

beforeEach(() => {
  vi.useRealTimers();
});

describe("Controller: connecting", () => {
  it("rejects a bad code and saves a good one", async () => {
    const storage = memoryStorage();
    const { controller, state, states } = await setup({ storage });
    const emitted = states.length;
    controller.connect("nope");
    expect(state().notice?.tone).toBe("error");
    expect(state().connection).toBe("disconnected");
    // The popover only re-renders on an emit, so the message must be pushed, not just stored
    expect(states.length).toBe(emitted + 1);
    expect(states.at(-1)?.notice?.tone).toBe("error");
    controller.connect("xkrm-4n7b");
    expect(state().connection).toBe("connecting");
    expect(JSON.parse(storage.getItem("com.dirtyowlbear.dicevision/settings")!).sessionCode).toBe("XKRM4N7B");
  });

  it("auto-connects to a saved code and tells the room on success", async () => {
    const { state, notifications } = await setup({
      storage: memoryStorage(JSON.stringify({ sessionCode: "XKRM4N7B", autoConnect: true })),
    });
    expect(state().connection).toBe("connecting");
    FakeSocket.last.confirm();
    expect(state().connection).toBe("connected");
    expect(state().waiting).toBe(false); // nothing wanted yet
    await flush();
    expect(notifications.at(-1)).toEqual({ message: "DiceVision connected (XKRM-4N7B).", variant: "SUCCESS" });
  });

  it("doesn't auto-connect when turned off, and works with no storage", async () => {
    const off = await setup({ storage: memoryStorage(JSON.stringify({ sessionCode: "XKRM4N7B", autoConnect: false })) });
    expect(off.state().connection).toBe("disconnected");
    expect(off.state().sessionCode).toBe("XKRM4N7B"); // shown in the field
    const none = await setup({ storage: null });
    expect(none.state().storage).toBe(false);
    none.controller.connect("XKRM4N7B");
    expect(none.state().connection).toBe("connecting");
  });

  it("surfaces an invalid session", async () => {
    const { controller, state, notifications } = await setup();
    controller.connect("XKRM4N7B");
    FakeSocket.last.onopen?.({});
    FakeSocket.last.onclose?.({ code: 4001, reason: "invalid" });
    expect(state().connection).toBe("disconnected");
    expect(state().notice?.text).toMatch(/Invalid or expired/);
    await flush();
    expect(notifications.at(-1)?.variant).toBe("ERROR");
  });
});

describe("Controller: waiting", () => {
  it("Roll once registers, a usable roll clears it and cancels", async () => {
    const { controller, state, broadcasts, badges } = await setup();
    controller.rollOnce();
    expect(state().notice?.tone).toBe("warn"); // not connected
    controller.connect("XKRM4N7B");
    FakeSocket.last.confirm();
    controller.rollOnce();
    expect(state().rollOncePending).toBe(true);
    expect(state().waiting).toBe(true);
    expect(FakeSocket.last.types()).toEqual(["waiting"]);

    FakeSocket.last.receive({ type: "roll", data: { dice: [d20("17")], total: 17, roll_id: "r1" } });
    expect(state().rollOncePending).toBe(false);
    expect(state().waiting).toBe(false);
    // The bridge still listed us as waiting, so release it (a reloaded dashboard shouldn't find us waiting)
    expect(FakeSocket.last.types()).toEqual(["waiting", "cancel"]);
    expect(state().log).toHaveLength(1);
    expect(state().log[0]).toMatchObject({ mine: true, shared: true, playerName: "Will", roll: { total: 17 } });
    await flush();
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].channel).toBe(ROLL_CHANNEL);
    expect((broadcasts[0].data as SharedRoll).visibility).toBe("everyone");
    expect(badges.at(-1)).toBe("17");
  });

  it("Roll once can be cancelled", async () => {
    const { controller, state } = await setup();
    controller.connect("XKRM4N7B");
    FakeSocket.last.confirm();
    controller.rollOnce();
    controller.cancelRollOnce();
    expect(state().waiting).toBe(false);
    expect(FakeSocket.last.types()).toEqual(["waiting", "cancel"]);
  });

  it("continuous mode re-registers after every roll and on reconnect", async () => {
    const { controller, state } = await setup();
    controller.connect("XKRM4N7B");
    controller.setContinuous(true);
    FakeSocket.last.confirm();
    expect(FakeSocket.last.types()).toEqual(["waiting"]);
    FakeSocket.last.receive({ type: "roll", data: { dice: [d20("5")], total: 5 } });
    expect(FakeSocket.last.types()).toEqual(["waiting", "waiting"]);
    expect(state().waiting).toBe(true);
    controller.setContinuous(false);
    expect(FakeSocket.last.types()).toEqual(["waiting", "waiting", "cancel"]);
  });

  it("another app's cancel re-arms us", async () => {
    const { controller } = await setup();
    controller.connect("XKRM4N7B");
    controller.setContinuous(true);
    FakeSocket.last.confirm();
    FakeSocket.last.receive({ type: "cancelled", app: "foundry" });
    expect(FakeSocket.last.types()).toEqual(["waiting", "waiting"]);
  });

  it("keeps waiting through an unreadable roll and says which die", async () => {
    const { controller, state, broadcasts, notifications } = await setup();
    controller.connect("XKRM4N7B");
    FakeSocket.last.confirm();
    controller.rollOnce();
    FakeSocket.last.receive({ type: "roll", data: { dice: [d20("17"), { type: "d8", value: -1, face: "-1", readable: false }], total: 17 } });
    expect(state().rollOncePending).toBe(true);
    expect(FakeSocket.last.types()).toEqual(["waiting", "waiting"]);
    expect(state().notice?.text).toBe("Couldn't read 1d8. Roll again. Still waiting.");
    expect(state().log[0]).toMatchObject({ shared: false, note: "Couldn't read 1d8. Roll again." });
    await flush();
    expect(broadcasts).toHaveLength(0);
    expect(notifications.some((n) => n.variant === "WARNING")).toBe(true); // popover closed

    FakeSocket.last.receive({ type: "roll", data: { dice: [], total: 0 } });
    expect(state().notice?.text).toBe("No dice in the roll. Roll again. Still waiting.");
  });

  it("no_dice toasts once per Roll once, never in continuous mode", async () => {
    const { controller, state, notifications } = await setup();
    controller.connect("XKRM4N7B");
    FakeSocket.last.confirm();
    controller.rollOnce();
    FakeSocket.last.receive({ type: "no_dice" });
    FakeSocket.last.receive({ type: "no_dice" });
    await flush();
    expect(notifications.filter((n) => /no dice/i.test(n.message))).toHaveLength(1);
    expect(state().notice?.text).toMatch(/No dice seen/);

    controller.setContinuous(true);
    FakeSocket.last.receive({ type: "no_dice" });
    await flush();
    expect(notifications.filter((n) => /no dice/i.test(n.message))).toHaveLength(1);
  });

  it("ignores no_dice when another app asked", async () => {
    const { controller, notifications } = await setup();
    controller.connect("XKRM4N7B");
    FakeSocket.last.confirm();
    FakeSocket.last.receive({ type: "no_dice" });
    await flush();
    expect(notifications.filter((n) => /no dice/i.test(n.message))).toHaveLength(0);
  });
});

describe("Controller: sharing", () => {
  it("Only me keeps the roll off the room; GM only marks it", async () => {
    const { controller, state, broadcasts } = await setup();
    controller.connect("XKRM4N7B");
    FakeSocket.last.confirm();
    controller.setVisibility("self");
    controller.setContinuous(true);
    FakeSocket.last.receive({ type: "roll", data: { dice: [d20("3")], total: 3 } });
    await flush();
    expect(broadcasts).toHaveLength(0);
    expect(state().log[0]).toMatchObject({ shared: false, note: null });

    controller.setVisibility("gm");
    FakeSocket.last.receive({ type: "roll", data: { dice: [d20("4")], total: 4 } });
    await flush();
    expect(broadcasts).toHaveLength(1);
    expect((broadcasts[0].data as SharedRoll).visibility).toBe("gm");
  });

  it("logs and announces other players' rolls it should see", async () => {
    const { deliver, state, notifications } = await setup({ player: { id: "p2", name: "GM", color: null, role: "PLAYER" } });
    const share: SharedRoll = {
      v: 1,
      playerId: "p1",
      playerName: "Will",
      playerColor: "#f00",
      visibility: "everyone",
      roll: { dice: [{ type: "d20", value: 17, face: "17", readable: true, icon: null }], total: 17, rollId: null, tags: [] },
      sentAt: "2026-10-25T10:00:00Z",
    };
    deliver(share);
    expect(state().log[0]).toMatchObject({ mine: false, playerName: "Will", shared: true });
    await flush();
    expect(notifications.at(-1)).toEqual({ message: "Will rolled 1d20 (17) = 17", variant: "INFO" });

    deliver({ ...share, visibility: "gm" }); // we're a player
    deliver({ ...share, playerId: "p2" }); // our own echo
    deliver("junk");
    expect(state().log).toHaveLength(1);
  });

  it("a GM sees GM-only rolls", async () => {
    const { deliver, state } = await setup({ player: { id: "gm", name: "GM", color: null, role: "GM" } });
    deliver({
      v: 1,
      playerId: "p1",
      playerName: "Will",
      visibility: "gm",
      roll: { dice: [{ type: "d6", value: 4, face: "pip_4", readable: true }], total: 4 },
      sentAt: "t",
    });
    expect(state().log).toHaveLength(1);
  });

  it("notifies the roller only while the popover is closed", async () => {
    const open = await setup({ actionOpen: true });
    open.controller.connect("XKRM4N7B");
    FakeSocket.last.confirm();
    open.controller.setContinuous(true);
    FakeSocket.last.receive({ type: "roll", data: { dice: [d20("9")], total: 9 } });
    await flush();
    expect(open.notifications.filter((n) => /You rolled/.test(n.message))).toHaveLength(0);

    const closed = await setup({ actionOpen: false });
    closed.controller.connect("XKRM4N7B");
    FakeSocket.last.confirm();
    closed.controller.setContinuous(true);
    FakeSocket.last.receive({ type: "roll", data: { dice: [d20("9")], total: 9 } });
    await flush();
    expect(closed.notifications.filter((n) => /You rolled 1d20 \(9\) = 9/.test(n.message))).toHaveLength(1);
  });

  it("caps the log at 20 entries and can clear it", async () => {
    const { controller, state } = await setup();
    controller.connect("XKRM4N7B");
    FakeSocket.last.confirm();
    controller.setContinuous(true);
    for (let i = 1; i <= 25; i++) FakeSocket.last.receive({ type: "roll", data: { dice: [d20("1")], total: i } });
    expect(state().log).toHaveLength(20);
    expect(state().log[0].roll.total).toBe(25);
    controller.handle({ cmd: "clearLog" });
    expect(state().log).toHaveLength(0);
  });
});

describe("Controller: commands", () => {
  it("routes every command", async () => {
    const storage = memoryStorage();
    const { controller, state, states } = await setup({ storage });
    const before = states.length;
    controller.handle({ cmd: "hello" });
    expect(states.length).toBe(before + 1);
    controller.handle({ cmd: "setAutoConnect", on: false });
    controller.handle({ cmd: "setVisibility", visibility: "gm" });
    controller.handle({ cmd: "setContinuous", on: true });
    expect(JSON.parse(storage.getItem("com.dirtyowlbear.dicevision/settings")!)).toEqual({
      sessionCode: null,
      autoConnect: false,
      continuous: true,
      visibility: "gm",
    });
    controller.handle({ cmd: "connect", code: "XKRM4N7B" });
    expect(state().connection).toBe("connecting");
    controller.handle({ cmd: "disconnect" });
    expect(state().connection).toBe("disconnected");
    const emitted = states.length;
    controller.handle({ cmd: "rollOnce" });
    expect(state().notice).not.toBeNull();
    expect(states.length).toBe(emitted + 1); // "connect first" is pushed to the popover
    controller.handle({ cmd: "clearNotice" });
    expect(state().notice).toBeNull();
  });
});
