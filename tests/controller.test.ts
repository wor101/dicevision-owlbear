import { beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeClient, type SocketLike } from "../src/bridge-client";
import { Controller, type ControllerState } from "../src/controller";
import { DDDICE_API, DDDICE_ROOM_KEY, dddiceKeyFor, type DddiceRollRequest, type FetchLike } from "../src/dddice";
import { GRIMOIRE_ROLL_CHANNEL, GRIMOIRE_WHISPER_CHANNEL, RUMBLE_CHAT_KEY, type GrimoireRollEntry, type RumbleChatLine } from "../src/forward";
import type { BroadcastDestination, Host, NotificationVariant, ToolActionSpec } from "../src/host";
import { ROLL_BUTTON_ID, ROLL_ICON, ROLL_WAITING_ICON } from "../src/roll-button";
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

/** What a fake Host refuses: player metadata writes, broadcasts on given channels, or reading the player. */
interface Failing {
  metadata?: boolean;
  channels?: string[];
  player?: boolean;
  room?: boolean;
}

/** A recording Host: notifications, badge, broadcasts, player metadata, room metadata, and a way to deliver incoming ones. */
function fakeHost(player: PlayerInfo, actionOpen = false, failing: Failing = {}, room: Record<string, unknown> = {}) {
  const notifications: { message: string; variant: NotificationVariant }[] = [];
  const badges: (string | undefined)[] = [];
  const broadcasts: { channel: string; data: unknown; destination: BroadcastDestination }[] = [];
  const metadata: Record<string, unknown> = {};
  const metadataWrites: Record<string, unknown>[] = [];
  const subscribers = new Map<string, (data: unknown) => void>();
  const roomListeners = new Set<(metadata: Record<string, unknown>) => void>();
  const playerListeners = new Set<(player: PlayerInfo) => void>();
  const toolActions = new Map<string, ToolActionSpec>();
  const toolActionLog: { id: string; icon: string; label: string }[] = [];
  const popoverOpens: number[] = [];
  const host: Host = {
    available: true,
    getPlayer: async () => {
      if (failing.player) throw new Error("no player");
      return player;
    },
    onPlayerChange: (callback) => {
      playerListeners.add(callback);
      return () => playerListeners.delete(callback);
    },
    notify: async (message, variant) => void notifications.push({ message, variant }),
    setBadge: async (text) => void badges.push(text),
    isActionOpen: async () => actionOpen,
    broadcast: async (channel, data, destination) => {
      if (failing.channels?.includes(channel)) throw new Error(`${channel} refused`);
      broadcasts.push({ channel, data, destination });
    },
    onBroadcast: (channel, callback) => {
      subscribers.set(channel, callback);
      return () => subscribers.delete(channel);
    },
    setPlayerMetadata: async (patch) => {
      if (failing.metadata) throw new Error("metadata refused");
      Object.assign(metadata, patch);
      metadataWrites.push(patch);
    },
    getRoomMetadata: async () => {
      if (failing.room) throw new Error("room refused");
      return room;
    },
    onRoomMetadataChange: (callback) => {
      roomListeners.add(callback);
      return () => roomListeners.delete(callback);
    },
    createToolAction: async (action) => {
      toolActions.set(action.id, action);
      toolActionLog.push({ id: action.id, icon: action.icon, label: action.label });
    },
    removeToolAction: async (id) => void toolActions.delete(id),
    openPopover: async () => void popoverOpens.push(1),
  };
  return {
    host,
    notifications,
    badges,
    broadcasts,
    metadata,
    metadataWrites,
    deliver: (data: unknown) => subscribers.get(ROLL_CHANNEL)?.(data),
    /** The room metadata changed (the dddice extension wrote something) */
    roomChanged: (next: Record<string, unknown>) => {
      for (const l of roomListeners) l(next);
    },
    /** Owlbear reported the player (late, or changed) */
    playerChanged: (next: PlayerInfo) => {
      for (const l of playerListeners) l(next);
    },
    /** The toolbar buttons currently registered, and every registration in order */
    toolActions,
    toolActionLog,
    popoverOpens,
    /** The user clicks the toolbar button */
    clickToolAction: (id: string) => toolActions.get(id)?.onClick(),
  };
}

/** A fake fetch for the dddice API: records requests, answers as told. */
function fakeFetch(answer: { ok: boolean; status: number; body?: string } = { ok: true, status: 201 }) {
  const requests: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[] = [];
  const fetch: FetchLike = async (url, init) => {
    requests.push({ url, init });
    return { ok: answer.ok, status: answer.status, text: async () => answer.body ?? "" };
  };
  return { fetch, requests };
}

function memoryStorage(initial?: string): StorageLike {
  const data = new Map<string, string>();
  if (initial) data.set("com.dirtyowlbear.dicevision/settings", initial);
  return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

const will: PlayerInfo = { id: "p1", name: "Will", color: "#f00", role: "PLAYER" };
const d20 = (face: string, readable = true) => ({ type: "d20", value: readable ? Number(face) : -1, face, readable });
const flush = () => new Promise((r) => setTimeout(r, 0));

async function setup(
  opts: {
    storage?: StorageLike | null;
    actionOpen?: boolean;
    player?: PlayerInfo;
    failing?: Failing;
    room?: Record<string, unknown>;
    fetch?: FetchLike;
    rollButton?: boolean;
  } = {},
) {
  const fake = fakeHost(opts.player ?? will, opts.actionOpen ?? false, opts.failing ?? {}, opts.room ?? {});
  const client = new BridgeClient({ createSocket: () => new FakeSocket() });
  const controller = new Controller(fake.host, {
    client,
    storage: opts.storage === undefined ? memoryStorage() : opts.storage,
    now: () => new Date("2026-10-25T10:00:00Z"),
    fetch: opts.fetch,
    rollButton: opts.rollButton,
  });
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
    expect(broadcasts[0].destination).toBe("REMOTE");
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
    const { deliver, state, notifications, metadata } = await setup({ player: { id: "p2", name: "GM", color: null, role: "PLAYER" } });
    const share: SharedRoll = {
      v: 1,
      playerId: "p1",
      playerName: "Will",
      playerColor: "#f00",
      visibility: "everyone",
      roll: { dice: [{ type: "d20", value: 17, face: "17", readable: true, icon: null }], total: 17, rollId: null, tags: [] },
      sentAt: "2026-10-25T10:00:00Z",
      rumble: false,
    };
    deliver(share);
    expect(state().log[0]).toMatchObject({ mine: false, playerName: "Will", shared: true });
    await flush();
    expect(notifications.at(-1)).toEqual({ message: "Will rolled 1d20 (17) = 17", variant: "INFO" });

    deliver({ ...share, visibility: "gm" }); // we're a player
    deliver({ ...share, playerId: "p2", rumble: true }); // our own echo: not logged, no Rumble! line either
    deliver("junk");
    await flush();
    expect(state().log).toHaveLength(1);
    expect(metadata).toEqual({});
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

  it("forwards nothing to other extensions unless asked", async () => {
    const { controller, broadcasts, metadata } = await setup();
    controller.connect("XKRM4N7B");
    FakeSocket.last.confirm();
    controller.setContinuous(true);
    FakeSocket.last.receive({ type: "roll", data: { dice: [d20("12")], total: 12 } });
    await flush();
    expect(broadcasts.map((b) => b.channel)).toEqual([ROLL_CHANNEL]);
    expect((broadcasts[0].data as SharedRoll).rumble).toBe(false); // receivers write no Rumble! line either
    expect(metadata).toEqual({});
  });

  it("carries the roller's Rumble! choice to every client that shows the roll, whatever that client's own setting", async () => {
    const roller = await setup();
    const receiver = await setup({ player: { id: "p2", name: "Ana", color: null, role: "PLAYER" } });
    receiver.controller.handle({ cmd: "setForward", target: "rumble", on: false });
    roller.controller.handle({ cmd: "setForward", target: "rumble", on: true });
    roller.controller.connect("XKRM4N7B");
    FakeSocket.last.confirm();
    roller.controller.setContinuous(true);
    FakeSocket.last.receive({ type: "roll", data: { dice: [d20("17")], total: 17 } });
    await flush();
    const shared = roller.broadcasts.find((b) => b.channel === ROLL_CHANNEL)!;
    expect(shared.destination).toBe("REMOTE");
    expect((shared.data as SharedRoll).rumble).toBe(true);
    expect(roller.metadataWrites).toHaveLength(1); // the roller's own line, once

    receiver.deliver(JSON.parse(JSON.stringify(shared.data)));
    await flush();
    expect(receiver.metadataWrites).toHaveLength(1);
    expect(receiver.metadata[RUMBLE_CHAT_KEY]).toMatchObject({ chatlog: "Will rolled 1d20 (17) = 17", targetId: "0000" });
    expect(receiver.broadcasts).toHaveLength(0);
  });

  it("forwards a usable roll to Grimoire and Rumble! when turned on, following the visibility", async () => {
    const { controller, state, broadcasts, metadata } = await setup();
    controller.connect("XKRM4N7B");
    FakeSocket.last.confirm();
    controller.handle({ cmd: "setForward", target: "grimoire", on: true });
    controller.handle({ cmd: "setForward", target: "rumble", on: true });
    expect(state().settings.forward).toEqual({ grimoire: true, rumble: true, dddice: false });
    controller.setContinuous(true);

    FakeSocket.last.receive({ type: "roll", data: { dice: [d20("17"), d20("3")], total: 20, roll_id: "r1" } });
    await flush();
    const grimoire = broadcasts.find((b) => b.channel === GRIMOIRE_ROLL_CHANNEL);
    expect(grimoire?.destination).toBe("ALL");
    expect(grimoire?.data as GrimoireRollEntry).toMatchObject({
      uuid: "r1",
      equation: "2d20",
      total_value: "20",
      values: ["17", "3"],
      username: "Will",
      owlbear_user_id: "p1",
      created_at: "2026-10-25T10:00:00.000Z",
    });
    expect(metadata[RUMBLE_CHAT_KEY] as RumbleChatLine).toEqual({
      chatlog: "Will rolled 2d20 (17, 3) = 20",
      created: "2026-10-25T10:00:00.000Z",
      sender: "DiceVision",
      targetId: "0000",
    });

    // An unreadable roll is not forwarded
    FakeSocket.last.receive({ type: "roll", data: { dice: [{ type: "d8", value: -1, face: "-1", readable: false }], total: 0 } });
    await flush();
    expect(broadcasts.filter((b) => b.channel === GRIMOIRE_ROLL_CHANNEL)).toHaveLength(1);
    expect((metadata[RUMBLE_CHAT_KEY] as RumbleChatLine).chatlog).toBe("Will rolled 2d20 (17, 3) = 20");

    // GM only: Grimoire's whisper channel to all clients; our own Rumble! line is addressed to
    // ourselves (GM clients write theirs on receipt, tested below)
    controller.setVisibility("gm");
    FakeSocket.last.receive({ type: "roll", data: { dice: [d20("9")], total: 9 } });
    await flush();
    expect(broadcasts.at(-1)).toMatchObject({ channel: GRIMOIRE_WHISPER_CHANNEL, destination: "ALL" });
    expect((metadata[RUMBLE_CHAT_KEY] as RumbleChatLine).targetId).toBe("p1");

    // Only me: still forwarded, but to this client only
    controller.setVisibility("self");
    FakeSocket.last.receive({ type: "roll", data: { dice: [d20("1")], total: 1 } });
    await flush();
    expect(broadcasts.at(-1)).toMatchObject({ channel: GRIMOIRE_WHISPER_CHANNEL, destination: "LOCAL" });
    expect(broadcasts.filter((b) => b.channel === ROLL_CHANNEL)).toHaveLength(2); // the Only me roll wasn't shared
  });

  it("never re-broadcasts other players' rolls to Grimoire, and leaves Rumble! alone unless the roller asked", async () => {
    const { controller, deliver, broadcasts, metadata } = await setup();
    controller.handle({ cmd: "setForward", target: "grimoire", on: true });
    controller.handle({ cmd: "setForward", target: "rumble", on: true }); // our own setting doesn't apply to their rolls
    deliver({
      v: 1,
      playerId: "p2",
      playerName: "Ana",
      visibility: "everyone",
      roll: { dice: [{ type: "d20", value: 17, face: "17", readable: true }], total: 17 },
      sentAt: "t",
    });
    await flush();
    expect(broadcasts).toHaveLength(0);
    expect(metadata).toEqual({});
  });

  it("writes another player's roll into this client's Rumble! chat when they asked for it", async () => {
    const anaRoll = {
      v: 1,
      playerId: "p2",
      playerName: "Ana",
      visibility: "everyone",
      roll: { dice: [{ type: "d20", value: 17, face: "17", readable: true }], total: 17 },
      sentAt: "2026-10-26T20:00:00.000Z",
      rumble: true,
    };
    const asPlayer = await setup();
    asPlayer.controller.handle({ cmd: "setForward", target: "rumble", on: false }); // the roller's choice counts, not ours
    asPlayer.deliver(anaRoll);
    await flush();
    expect(asPlayer.metadata[RUMBLE_CHAT_KEY]).toEqual({
      chatlog: "Ana rolled 1d20 (17) = 17",
      created: "2026-10-26T20:00:00.000Z",
      sender: "DiceVision",
      targetId: "0000",
    });
    expect(asPlayer.broadcasts).toHaveLength(0); // Grimoire got it from the roller's ALL broadcast

    // A GM-only roll: a player client never shows it, a GM client writes it as a private line
    asPlayer.deliver({ ...anaRoll, visibility: "gm", sentAt: "later" });
    await flush();
    expect((asPlayer.metadata[RUMBLE_CHAT_KEY] as RumbleChatLine).created).toBe("2026-10-26T20:00:00.000Z");
    const asGm = await setup({ player: { id: "gm", name: "GM", color: null, role: "GM" } });
    asGm.deliver({ ...anaRoll, visibility: "gm" });
    await flush();
    expect((asGm.metadata[RUMBLE_CHAT_KEY] as RumbleChatLine).targetId).toBe("gm");
  });

  it("reports a failed Rumble! write of another player's roll on that entry, without taking over the notice", async () => {
    const { controller, deliver, state, notifications } = await setup({ failing: { metadata: true } });
    controller.rollOnce(); // "connect first": our own notice, which Ana's failure must not replace
    const ours = state().notice;
    deliver({
      v: 1,
      playerId: "p2",
      playerName: "Ana",
      visibility: "everyone",
      roll: { dice: [{ type: "d20", value: 17, face: "17", readable: true }], total: 17 },
      sentAt: "t",
      rumble: true,
    });
    await flush();
    expect(state().log[0]).toMatchObject({ mine: false, playerName: "Ana", note: "Couldn't send it to Rumble!." });
    expect(state().notice).toEqual(ours);
    expect(notifications.filter((n) => n.variant === "WARNING").at(-1)?.message).toBe("DiceVision: sending Ana's roll to Rumble! failed.");
  });

  it("a received Everyone roll still gets its Rumble! line when our own player is unknown; a private one is reported", async () => {
    const ana = {
      v: 1,
      playerId: "p2",
      playerName: "Ana",
      visibility: "everyone",
      roll: { dice: [{ type: "d20", value: 17, face: "17", readable: true }], total: 17 },
      sentAt: "t",
      rumble: true,
    };
    const noPlayer = await setup({ failing: { player: true } });
    noPlayer.deliver(ana);
    await flush();
    expect(noPlayer.metadata[RUMBLE_CHAT_KEY]).toMatchObject({ chatlog: "Ana rolled 1d20 (17) = 17", targetId: "0000" });
    expect(noPlayer.state().notice?.text).toMatch(/Couldn't read your Owlbear Rodeo player/); // untouched

    // A GM whose id is unknown (not something OBR does; pins the guard on the receive side)
    const gm = await setup({ player: { id: "", name: "GM", color: null, role: "GM" } });
    gm.deliver({ ...ana, visibility: "gm" });
    await flush();
    expect(gm.metadata).toEqual({});
    expect(gm.state().log[0].note).toBe("Couldn't send it to Rumble!. Your Owlbear Rodeo player couldn't be read; reload the room.");
  });

  it("says so when forwarding fails, and keeps the roll", async () => {
    const { controller, state, badges, metadataWrites } = await setup({ failing: { metadata: true } });
    controller.connect("XKRM4N7B");
    FakeSocket.last.confirm();
    controller.handle({ cmd: "setForward", target: "rumble", on: true });
    controller.setContinuous(true);
    FakeSocket.last.receive({ type: "roll", data: { dice: [d20("12")], total: 12 } });
    await flush();
    expect(state().log[0]).toMatchObject({ shared: true, roll: { total: 12 }, note: "Couldn't send it to Rumble!." });
    expect(state().notice).toEqual({ text: "Rolled, but sending it to Rumble! failed.", tone: "warn" });
    expect(badges.at(-1)).toBe("12");
    expect(metadataWrites).toHaveLength(0);
  });

  it("a Grimoire failure is reported the same way", async () => {
    const { controller, state } = await setup({ failing: { channels: [GRIMOIRE_ROLL_CHANNEL] } });
    controller.connect("XKRM4N7B");
    FakeSocket.last.confirm();
    controller.handle({ cmd: "setForward", target: "grimoire", on: true });
    controller.setContinuous(true);
    FakeSocket.last.receive({ type: "roll", data: { dice: [d20("12")], total: 12 } });
    await flush();
    expect(state().notice).toEqual({ text: "Rolled, but sending it to Game Master's Grimoire failed.", tone: "warn" });
  });

  it("adds up several failures on one roll, keeps them on the log entry, and toasts while the popover is closed", async () => {
    const { controller, state, notifications } = await setup({
      actionOpen: false,
      failing: { metadata: true, channels: [ROLL_CHANNEL, GRIMOIRE_ROLL_CHANNEL] },
    });
    controller.connect("XKRM4N7B");
    FakeSocket.last.confirm();
    controller.handle({ cmd: "setForward", target: "grimoire", on: true });
    controller.handle({ cmd: "setForward", target: "rumble", on: true });
    controller.setContinuous(true);
    FakeSocket.last.receive({ type: "roll", data: { dice: [d20("12")], total: 12 } });
    await flush();
    const where = "the room, Game Master's Grimoire and Rumble!";
    expect(state().notice).toEqual({ text: `Rolled, but sending it to ${where} failed.`, tone: "warn" });
    expect(state().log[0].note).toBe(`Couldn't send it to ${where}.`);
    expect(notifications.filter((n) => n.variant === "WARNING").at(-1)?.message).toBe(`DiceVision: sending the roll to ${where} failed.`);

    // The next roll clears the notice as usual, but the failed entry keeps its note
    controller.handle({ cmd: "setForward", target: "grimoire", on: false });
    controller.handle({ cmd: "setForward", target: "rumble", on: false });
    controller.setVisibility("self");
    FakeSocket.last.receive({ type: "roll", data: { dice: [d20("1")], total: 1 } });
    await flush();
    expect(state().notice).toBeNull();
    expect(state().log[1].note).toBe(`Couldn't send it to ${where}.`);
  });

  it("reports a private roll it can't address instead of sending it to nobody", async () => {
    const { controller, state, broadcasts, metadata } = await setup({ failing: { player: true } });
    expect(state().notice?.text).toMatch(/Couldn't read your Owlbear Rodeo player/);
    controller.connect("XKRM4N7B");
    FakeSocket.last.confirm();
    controller.handle({ cmd: "setForward", target: "grimoire", on: true });
    controller.handle({ cmd: "setForward", target: "rumble", on: true });
    controller.setVisibility("gm");
    controller.setContinuous(true);
    FakeSocket.last.receive({ type: "roll", data: { dice: [d20("12")], total: 12 } });
    await flush();
    expect(broadcasts.filter((b) => b.channel === GRIMOIRE_WHISPER_CHANNEL)).toHaveLength(0);
    expect(metadata).toEqual({});
    expect(state().notice?.text).toBe(
      "Rolled, but sending it to Game Master's Grimoire and Rumble! failed. Your Owlbear Rodeo player couldn't be read; reload the room.",
    );

    // Everyone rolls need no address and go out
    controller.setVisibility("everyone");
    FakeSocket.last.receive({ type: "roll", data: { dice: [d20("12")], total: 12 } });
    await flush();
    expect(broadcasts.filter((b) => b.channel === GRIMOIRE_ROLL_CHANNEL)).toHaveLength(1);
    expect(metadata[RUMBLE_CHAT_KEY]).toBeDefined();
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

describe("Controller: dddice", () => {
  const dddiceRoom = { [DDDICE_ROOM_KEY]: "AbC123", [dddiceKeyFor("p1")]: "key-will", [dddiceKeyFor("p2")]: "key-ana" };

  /** A connected controller with dddice forwarding on, ready to receive rolls. */
  async function dddiceSetup(opts: Parameters<typeof setup>[0] = {}) {
    const s = await setup(opts);
    s.controller.connect("XKRM4N7B");
    FakeSocket.last.confirm();
    s.controller.handle({ cmd: "setForward", target: "dddice", on: true });
    s.controller.setContinuous(true);
    return s;
  }
  const rollOf = (dice: unknown[], total: number, game?: unknown) => FakeSocket.last.receive({ type: "roll", data: { dice, total, game } });

  it("reads the dddice room and our own key from the room metadata, and follows changes", async () => {
    const { states, roomChanged } = await setup({ room: dddiceRoom });
    const last = () => states.at(-1)!.dddice; // what the popover saw, not just the controller's own view
    expect(last()).toEqual({ room: "AbC123", hasKey: true, roomRead: true });
    roomChanged({ [DDDICE_ROOM_KEY]: "AbC123", [dddiceKeyFor("p2")]: "key-ana" });
    expect(last()).toEqual({ room: "AbC123", hasKey: false, roomRead: true }); // someone else's key isn't ours
    roomChanged({});
    expect(last()).toEqual({ room: null, hasKey: false, roomRead: true });
  });

  it("looks our key up again once Owlbear reports our player", async () => {
    const api = fakeFetch();
    const { controller, states, playerChanged } = await dddiceSetup({ failing: { player: true }, room: dddiceRoom, fetch: api.fetch });
    expect(states.at(-1)!.dddice).toEqual({ room: "AbC123", hasKey: false, roomRead: true });
    rollOf([d20("4")], 4);
    await flush();
    expect(api.requests).toHaveLength(0);
    expect(states.at(-1)!.notice?.text).toBe("Rolled, but sending it to dddice failed. Your Owlbear Rodeo player couldn't be read; reload the room.");

    playerChanged(will);
    expect(states.at(-1)!.dddice).toEqual({ room: "AbC123", hasKey: true, roomRead: true });
    controller.handle({ cmd: "clearNotice" });
    rollOf([d20("4")], 4);
    await flush();
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0].init.headers.Authorization).toBe("Bearer key-will");
  });

  it("survives a room that can't be read at start, says so, and recovers on the next change", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const api = fakeFetch();
    const { state, states, roomChanged } = await setup({
      failing: { room: true },
      storage: memoryStorage(JSON.stringify({ sessionCode: "XKRM4N7B", autoConnect: true, forward: { dddice: true } })),
      fetch: api.fetch,
    });
    warn.mockRestore();
    expect(state().connection).toBe("connecting"); // auto-connect still ran
    expect(state().dddice).toEqual({ room: null, hasKey: false, roomRead: false });
    expect(state().notice?.text).toMatch(/Couldn't read this room's shared data/);
    roomChanged(dddiceRoom); // the listener was registered despite the failed read
    expect(states.at(-1)!.dddice).toEqual({ room: "AbC123", hasKey: true, roomRead: true });
  });

  it("explains a roll that can't go out because the room couldn't be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const api = fakeFetch();
    const { controller, state } = await dddiceSetup({ failing: { room: true }, fetch: api.fetch });
    warn.mockRestore();
    controller.handle({ cmd: "clearNotice" });
    rollOf([d20("4")], 4);
    await flush();
    expect(api.requests).toHaveLength(0);
    expect(state().notice?.text).toBe("Rolled, but sending it to dddice failed. This room's shared data couldn't be read at start; reload the room.");
  });

  it("rolls an Everyone roll in dddice as this player, with the chosen theme", async () => {
    const api = fakeFetch();
    const { controller, state, metadataWrites } = await dddiceSetup({ room: dddiceRoom, fetch: api.fetch });
    controller.handle({ cmd: "setDddiceTheme", theme: "dddice-red" });
    rollOf([d20("17"), { type: "d10", value: 70, face: "70", readable: true }], 87, {
      tags: [{ die_index: 0, tone: "good", label: "Critical!" }],
    });
    await flush();
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0].url).toBe(`${DDDICE_API}/roll`);
    expect(api.requests[0].init.method).toBe("POST");
    expect(api.requests[0].init.headers.Authorization).toBe("Bearer key-will");
    expect(JSON.parse(api.requests[0].init.body) as DddiceRollRequest).toEqual({
      dice: [
        { type: "d20", theme: "dddice-red", value: 17 },
        { type: "d10x", theme: "dddice-red", value: 70, value_to_display: "70" },
      ],
      room: "AbC123",
      label: "DiceVision: Critical!",
    });
    expect(state().log[0].note).toBeNull();
    expect(metadataWrites).toHaveLength(0); // Rumble! stayed off
    expect(JSON.stringify(state())).not.toContain("key-will"); // the key never reaches the popover

    // An unreadable roll goes nowhere
    rollOf([{ type: "d8", value: -1, face: "-1", readable: false }], 0);
    await flush();
    expect(api.requests).toHaveLength(1);

    // GM only: not sent to dddice (and not reported either; the hint says so)
    controller.setVisibility("gm");
    rollOf([d20("3")], 3);
    await flush();
    expect(api.requests).toHaveLength(1);
    expect(state().notice).toBeNull();
  });

  it("uses the theme saved from an earlier visit, and the default without one", async () => {
    const saved = fakeFetch();
    const a = await dddiceSetup({ room: dddiceRoom, fetch: saved.fetch, storage: memoryStorage(JSON.stringify({ dddiceTheme: "dddice-red" })) });
    void a;
    rollOf([d20("1")], 1);
    await flush();
    expect((JSON.parse(saved.requests[0].init.body) as DddiceRollRequest).dice[0].theme).toBe("dddice-red");

    const fresh = fakeFetch();
    await dddiceSetup({ room: dddiceRoom, fetch: fresh.fetch });
    rollOf([d20("1")], 1);
    await flush();
    expect((JSON.parse(fresh.requests[0].init.body) as DddiceRollRequest).dice[0].theme).toBe("dddice-bees");
  });

  it("never posts another player's shared roll to dddice (the roller's client already did)", async () => {
    const api = fakeFetch();
    const { deliver, state } = await dddiceSetup({ room: dddiceRoom, fetch: api.fetch });
    deliver({
      v: 1,
      playerId: "p2",
      playerName: "Ana",
      visibility: "everyone",
      roll: { dice: [{ type: "d20", value: 17, face: "17", readable: true }], total: 17 },
      sentAt: "t",
      rumble: false,
    });
    await flush();
    expect(api.requests).toHaveLength(0);
    expect(state().log[0].note).toBeNull();
  });

  it("reports a missing dddice room with what to do", async () => {
    const { state } = await dddiceSetup({ fetch: fakeFetch().fetch });
    rollOf([d20("8")], 8);
    await flush();
    expect(state().notice?.text).toBe(
      "Rolled, but sending it to dddice failed. No dddice room in this Owlbear room yet: open the dddice extension and pick a room.",
    );
  });

  it("reports a missing key with what to do", async () => {
    const { state } = await dddiceSetup({ room: { [DDDICE_ROOM_KEY]: "AbC123" }, fetch: fakeFetch().fetch });
    rollOf([d20("8")], 8);
    await flush();
    expect(state().notice?.text).toBe("Rolled, but sending it to dddice failed. dddice has no key for you yet: open the dddice extension in this room once.");
  });

  it("reports a refused roll with dddice's message, once punctuated", async () => {
    const refused = fakeFetch({ ok: false, status: 422, body: JSON.stringify({ type: "error", data: { message: "The selected theme is invalid." } }) });
    const { state } = await dddiceSetup({ room: dddiceRoom, fetch: refused.fetch });
    rollOf([d20("8")], 8);
    await flush();
    expect(state().notice).toEqual({
      text: "Rolled, but sending it to dddice failed. dddice answered 422: The selected theme is invalid.",
      tone: "warn",
    });
    expect(state().log[0].note).toBe("Couldn't send it to dddice. dddice answered 422: The selected theme is invalid.");
    expect(JSON.stringify(state())).not.toContain("key-will");
  });

  it("reports a network failure in plain words, and a bare rejection without a reason", async () => {
    const offline: FetchLike = async () => {
      throw new TypeError("Failed to fetch");
    };
    const a = await dddiceSetup({ room: dddiceRoom, fetch: offline });
    rollOf([d20("8")], 8);
    await flush();
    expect(a.state().notice?.text).toBe(
      "Rolled, but sending it to dddice failed. Couldn't reach dddice.com (offline, or a content blocker is in the way).",
    );

    const weird: FetchLike = async () => {
      throw "boom";
    };
    const b = await dddiceSetup({ room: dddiceRoom, fetch: weird });
    rollOf([d20("8")], 8);
    await flush();
    expect(b.state().notice?.text).toBe("Rolled, but sending it to dddice failed. Couldn't reach dddice.com (offline, or a content blocker is in the way).");
  });

  it("reports a die dddice can't show instead of sending it", async () => {
    const api = fakeFetch();
    const { state } = await dddiceSetup({ room: dddiceRoom, fetch: api.fetch });
    rollOf([{ type: "d100", value: 5, face: "5", readable: true }], 5); // a type dddice has, with a face it can't show
    await flush();
    expect(api.requests).toHaveLength(0);
    expect(state().log[0].note).toBe('Couldn\'t send it to dddice. "5" isn\'t a tens face.');
  });
});

describe("Controller: toolbar roll button", () => {
  it("is registered only by the controller asked to (the background page's)", async () => {
    const popover = await setup();
    expect(popover.toolActions.size).toBe(0);
    const background = await setup({ rollButton: true });
    expect([...background.toolActions.keys()]).toEqual([ROLL_BUTTON_ID]);
    expect(background.toolActions.get(ROLL_BUTTON_ID)).toMatchObject({ icon: ROLL_ICON, label: "DiceVision: connect a session to roll" });
  });

  it("opens the popover while disconnected, rolls once when connected, cancels while waiting", async () => {
    const { controller, state, clickToolAction, toolActions, toolActionLog, popoverOpens } = await setup({ rollButton: true });
    clickToolAction(ROLL_BUTTON_ID);
    expect(popoverOpens).toHaveLength(1);
    expect(state().rollOncePending).toBe(false);

    controller.connect("XKRM4N7B");
    FakeSocket.last.confirm();
    expect(toolActions.get(ROLL_BUTTON_ID)).toMatchObject({ icon: ROLL_ICON, label: "DiceVision: roll once" });
    clickToolAction(ROLL_BUTTON_ID);
    expect(state().rollOncePending).toBe(true);
    expect(FakeSocket.last.types()).toEqual(["waiting"]);
    expect(toolActions.get(ROLL_BUTTON_ID)).toMatchObject({ icon: ROLL_WAITING_ICON, label: "DiceVision: waiting for your roll (click to cancel)" });

    clickToolAction(ROLL_BUTTON_ID);
    expect(state().rollOncePending).toBe(false);
    expect(FakeSocket.last.types()).toEqual(["waiting", "cancel"]);
    expect(toolActions.get(ROLL_BUTTON_ID)?.label).toBe("DiceVision: roll once");

    // A roll arriving flips it back too
    clickToolAction(ROLL_BUTTON_ID);
    FakeSocket.last.receive({ type: "roll", data: { dice: [d20("17")], total: 17 } });
    expect(toolActions.get(ROLL_BUTTON_ID)?.label).toBe("DiceVision: roll once");

    // Re-created only when icon, label or action change: four specs so far
    expect(toolActionLog.map((a) => a.label)).toEqual([
      "DiceVision: connect a session to roll",
      "DiceVision: roll once",
      "DiceVision: waiting for your roll (click to cancel)",
      "DiceVision: roll once",
      "DiceVision: waiting for your roll (click to cancel)",
      "DiceVision: roll once",
    ]);
  });

  it("sends you to the popover in continuous mode, and goes away on stop", async () => {
    const { controller, clickToolAction, toolActions, popoverOpens } = await setup({ rollButton: true });
    controller.connect("XKRM4N7B");
    FakeSocket.last.confirm();
    controller.setContinuous(true);
    expect(toolActions.get(ROLL_BUTTON_ID)).toMatchObject({ icon: ROLL_WAITING_ICON, label: "DiceVision: continuous mode is on (open to change)" });
    clickToolAction(ROLL_BUTTON_ID);
    expect(popoverOpens).toHaveLength(1);
    controller.stop();
    expect(toolActions.size).toBe(0);
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
    controller.handle({ cmd: "setForward", target: "grimoire", on: true });
    controller.handle({ cmd: "setDddiceTheme", theme: "  dddice-red " });
    expect(JSON.parse(storage.getItem("com.dirtyowlbear.dicevision/settings")!)).toEqual({
      sessionCode: null,
      autoConnect: false,
      continuous: true,
      visibility: "gm",
      forward: { grimoire: true, rumble: false, dddice: false },
      dddiceTheme: "dddice-red",
    });
    controller.handle({ cmd: "setDddiceTheme", theme: "   " });
    expect(state().settings.dddiceTheme).toBe("dddice-bees"); // back to the default
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
