/**
 * The extension's brain: owns the bridge client, decides when to be
 * registered as waiting, reads each roll, keeps the roll log, shares rolls
 * with the room and shows notifications. One Controller runs per client, in
 * the background page; the action popover is a view on its state (see
 * local-bus.ts). The popover falls back to its own Controller when no
 * background page answers.
 *
 * Waiting rules (the Talespire symbiote's and Foundry module's):
 * - A roll is wanted in continuous mode, or after Roll once until a usable
 *   roll arrives.
 * - The dashboard drops its waiting flag with every roll it forwards, so
 *   after each roll we re-register if a roll is still wanted, else cancel if
 *   we were registered (so a reloaded dashboard doesn't find us waiting).
 * - A roll with an unreadable die, or no dice, is shown locally as "not
 *   shared" and we keep waiting for the reroll.
 * - `no_dice` (the camera saw nothing) gets one notification per Roll once;
 *   nothing in continuous mode, where every empty capture would toast.
 * - A usable roll is also forwarded to the other extensions turned on in
 *   settings.forward (Game Master's Grimoire, Rumble!), see forward.ts.
 *   Rumble! lines are per client, so a shared roll whose roller asked for
 *   Rumble! is written here too (onSharedRoll), whatever our own setting.
 */

import { BridgeClient, type BridgeEvent, type ConnectionState } from "./bridge-client";
import { createDddiceRoll, dddiceRollRequest, readDddiceSetup, type DddiceSetup, type FetchLike } from "./dddice";
import { describeRoll, isUsable, readRoll, summarizeTypes, unreadableDice, type Roll } from "./dice";
import { grimoireMessage, rumbleChatPatch } from "./forward";
import type { Host } from "./host";
import { formatSessionCode, normalizeSessionCode } from "./session-code";
import {
  availableStorage,
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type ForwardTarget,
  type Settings,
  type StorageLike,
  type Visibility,
} from "./settings";
import { buildShare, parseShare, ROLL_CHANNEL, shouldShow, type PlayerInfo } from "./share";

export const MAX_LOG_ENTRIES = 20;

export interface LogEntry {
  id: string;
  at: string;
  playerName: string;
  playerColor: string | null;
  mine: boolean;
  roll: Roll;
  /** Whether the roll went out to the room (false: "Only me", or unusable) */
  shared: boolean;
  /** Why a roll wasn't shared ("Couldn't read 1d8"), or where it failed to arrive ("Couldn't send it to Rumble!") */
  note: string | null;
}

export interface Notice {
  text: string;
  tone: "info" | "warn" | "error";
}

/** Whose roll a delivery was for, named up front so a failure is worded right even after the entry left the log. */
interface DeliverySubject {
  entryId: string;
  mine: boolean;
  playerName: string;
}

const PLAYER_UNKNOWN = "Your Owlbear Rodeo player couldn't be read; reload the room.";

/** An error's message as a sentence to append to a failure notice ("...failed. <reason>"). */
function reasonFrom(err: unknown): string | undefined {
  if (!(err instanceof Error) || !err.message.trim()) return undefined;
  return `${err.message.trim().replace(/[.!]+$/, "")}.`;
}

export interface ControllerState {
  connection: ConnectionState;
  sessionCode: string | null;
  reconnectAttempt: number;
  /** The bridge has us registered as waiting */
  waiting: boolean;
  rollOncePending: boolean;
  settings: Settings;
  /** Whether settings persist in this browser */
  storage: boolean;
  player: PlayerInfo;
  log: LogEntry[];
  notice: Notice | null;
  /** What the dddice extension has set up in this room for us (the key itself stays private); roomRead false = the room couldn't be read */
  dddice: { room: string | null; hasKey: boolean; roomRead: boolean };
}

export type Command =
  | { cmd: "hello" }
  | { cmd: "connect"; code: string }
  | { cmd: "disconnect" }
  | { cmd: "rollOnce" }
  | { cmd: "cancelRollOnce" }
  | { cmd: "setContinuous"; on: boolean }
  | { cmd: "setVisibility"; visibility: Visibility }
  | { cmd: "setAutoConnect"; on: boolean }
  | { cmd: "setForward"; target: ForwardTarget; on: boolean }
  | { cmd: "setDddiceTheme"; theme: string }
  | { cmd: "clearLog" }
  | { cmd: "clearNotice" };

export interface ControllerOptions {
  client?: BridgeClient;
  /** null: no storage; undefined: probe localStorage */
  storage?: StorageLike | null;
  now?: () => Date;
  /** For the dddice API; defaults to the browser's fetch */
  fetch?: FetchLike;
}

export class Controller {
  private readonly host: Host;
  private readonly client: BridgeClient;
  private readonly storage: StorageLike | null;
  private readonly now: () => Date;
  private readonly fetch: FetchLike;
  private settings: Settings;
  private roomMetadata: Record<string, unknown> = {};
  private dddice: DddiceSetup = { room: null, apiKey: null };
  /** Whether the room's metadata has been read at least once (a failed start read leaves this false) */
  private roomRead = false;
  private player: PlayerInfo = { id: "", name: "You", color: null, role: "PLAYER" };
  private rollOncePending = false;
  private noDiceShown = false;
  private reconnectAttempt = 0;
  private log: LogEntry[] = [];
  /** Where each log entry failed to go ("the room", "Rumble!"); another player's entry can fail on its Rumble! line */
  private readonly deliveryFailures = new Map<string, string[]>();
  private notice: Notice | null = null;
  private readonly listeners = new Set<(state: ControllerState) => void>();
  private readonly cleanups: (() => void)[] = [];
  private entryCounter = 0;

  constructor(host: Host, options: ControllerOptions = {}) {
    this.host = host;
    this.client = options.client ?? new BridgeClient();
    this.storage = options.storage === undefined ? availableStorage() : options.storage;
    this.now = options.now ?? (() => new Date());
    // Wrapped so `this` is never the Controller: a bare fetch throws "Illegal invocation" when called as a method
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.settings = loadSettings(this.storage);
  }

  /** Subscribe to the bridge and the room; auto-connect if a code is saved. */
  async start(): Promise<void> {
    this.cleanups.push(this.client.on((event) => this.onBridgeEvent(event)));
    this.cleanups.push(this.host.onBroadcast(ROLL_CHANNEL, (data) => this.onSharedRoll(data)));
    try {
      this.player = await this.host.getPlayer();
    } catch (err) {
      console.warn("[DiceVision] Couldn't read the player:", err);
      this.setNotice("Couldn't read your Owlbear Rodeo player. Rolls are labelled \"You\" until you reload the room.", "warn");
    }
    this.cleanups.push(
      this.host.onPlayerChange((player) => {
        this.player = player;
        this.readRoom(this.roomMetadata);
        this.emit();
      }),
    );
    // Subscribe before the first read so a write during the read isn't missed; a
    // change that arrives meanwhile is newer than the snapshot and wins.
    this.cleanups.push(
      this.host.onRoomMetadataChange((metadata) => {
        this.readRoom(metadata);
        this.emit();
      }),
    );
    try {
      const snapshot = await this.host.getRoomMetadata();
      if (!this.roomRead) this.readRoom(snapshot);
    } catch (err) {
      console.warn("[DiceVision] Couldn't read the room metadata:", err);
      if (!this.roomRead) this.setNotice("Couldn't read this room's shared data; dddice forwarding won't work until you reload the room.", "warn");
    }
    if (this.settings.sessionCode && this.settings.autoConnect) {
      this.client.connect(this.settings.sessionCode);
    }
    this.emit();
  }

  stop(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.client.disconnect();
  }

  onChange(listener: (state: ControllerState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): ControllerState {
    return {
      connection: this.client.state,
      sessionCode: this.client.getSessionCode() ?? this.settings.sessionCode,
      reconnectAttempt: this.reconnectAttempt,
      waiting: this.client.registered,
      rollOncePending: this.rollOncePending,
      settings: { ...this.settings },
      storage: this.storage !== null,
      player: this.player,
      log: this.log,
      notice: this.notice,
      dddice: { room: this.dddice.room, hasKey: this.dddice.apiKey !== null, roomRead: this.roomRead },
    };
  }

  /** Pick up what the dddice extension wrote to the room (its room slug, our API key). */
  private readRoom(metadata: Record<string, unknown>): void {
    this.roomMetadata = metadata;
    this.roomRead = true;
    this.dddice = readDddiceSetup(metadata, this.player.id);
  }

  handle(command: Command): void {
    switch (command.cmd) {
      case "hello":
        this.emit();
        break;
      case "connect":
        this.connect(command.code);
        break;
      case "disconnect":
        this.disconnect();
        break;
      case "rollOnce":
        this.rollOnce();
        break;
      case "cancelRollOnce":
        this.cancelRollOnce();
        break;
      case "setContinuous":
        this.setContinuous(command.on);
        break;
      case "setVisibility":
        this.setVisibility(command.visibility);
        break;
      case "setAutoConnect":
        this.setAutoConnect(command.on);
        break;
      case "setForward":
        this.setForward(command.target, command.on);
        break;
      case "setDddiceTheme":
        this.updateSettings({ dddiceTheme: command.theme.trim() || DEFAULT_SETTINGS.dddiceTheme });
        this.emit();
        break;
      case "clearLog":
        this.log = [];
        this.emit();
        break;
      case "clearNotice":
        this.notice = null;
        this.emit();
        break;
    }
  }

  connect(input: string): void {
    const code = normalizeSessionCode(input);
    if (!code) {
      this.setNotice("That isn't a session code. It has 8 letters and digits, like XKRM-4N7B.", "error");
      this.emit();
      return;
    }
    this.noDiceShown = false;
    this.notice = null;
    this.updateSettings({ sessionCode: code });
    this.client.connect(code);
  }

  disconnect(): void {
    this.rollOncePending = false;
    this.client.disconnect();
    void this.host.setBadge().catch(() => {});
    this.emit();
  }

  rollOnce(): void {
    if (!this.client.isConnected()) {
      this.setNotice("Connect to a DiceVision session first.", "warn");
      this.emit();
      return;
    }
    if (this.settings.continuous) return;
    this.rollOncePending = true;
    this.noDiceShown = false;
    this.notice = null;
    this.syncWaiting();
    this.emit();
  }

  cancelRollOnce(): void {
    this.rollOncePending = false;
    this.syncWaiting();
    this.emit();
  }

  setContinuous(on: boolean): void {
    if (on) {
      this.rollOncePending = false;
      this.noDiceShown = false;
    }
    this.updateSettings({ continuous: on });
    this.syncWaiting();
    this.emit();
  }

  setVisibility(visibility: Visibility): void {
    this.updateSettings({ visibility });
    this.emit();
  }

  setAutoConnect(on: boolean): void {
    this.updateSettings({ autoConnect: on });
    this.emit();
  }

  setForward(target: ForwardTarget, on: boolean): void {
    this.updateSettings({ forward: { ...this.settings.forward, [target]: on } });
    this.emit();
  }

  private wantsRoll(): boolean {
    return this.settings.continuous || this.rollOncePending;
  }

  /** Register or release our waiting state to match wantsRoll(). */
  private syncWaiting(): void {
    if (!this.client.isConnected()) return;
    if (this.wantsRoll()) {
      if (!this.client.registered) this.client.sendWaiting();
    } else if (this.client.registered) {
      this.client.sendCancel();
    }
  }

  private onBridgeEvent(event: BridgeEvent): void {
    switch (event.type) {
      case "state":
        this.reconnectAttempt = event.reconnectAttempt;
        if (event.state === "connected") {
          this.syncWaiting();
          const code = event.sessionCode ? formatSessionCode(event.sessionCode) : "";
          this.setNotice(`Connected to DiceVision session ${code}.`, "info");
          void this.host.notify(`DiceVision connected (${code}).`, "SUCCESS").catch(() => {});
        }
        break;
      case "roll":
        this.onRoll(event.data);
        break;
      case "no_dice":
        this.onNoDice();
        break;
      case "cancelled":
        this.syncWaiting();
        break;
      case "waiting":
        break;
      case "error":
        this.setNotice(`DiceVision: ${event.message}`, "error");
        break;
      case "invalid-session":
        this.rollOncePending = false;
        this.setNotice("Invalid or expired session code. Create a new session in the DiceVision dashboard.", "error");
        void this.host.notify("DiceVision: invalid or expired session code.", "ERROR").catch(() => {});
        break;
      case "gave-up":
        this.rollOncePending = false;
        this.setNotice("Lost the connection to DiceVision. Press Connect to try again.", "error");
        void this.host.notify("DiceVision lost its connection. Open the extension to reconnect.", "WARNING").catch(() => {});
        break;
    }
    this.emit();
  }

  private onRoll(data: unknown): void {
    const roll = readRoll(data);
    const usable = isUsable(roll);
    const at = this.now().toISOString();

    if (!usable) {
      const unreadable = unreadableDice(roll);
      const note = unreadable.length
        ? `Couldn't read ${summarizeTypes(unreadable.map((d) => d.type))}. Roll again.`
        : "No dice in the roll. Roll again.";
      this.addLogEntry({ at, mine: true, roll, shared: false, note });
      this.setNotice(this.wantsRoll() ? `${note} Still waiting.` : note, "warn");
      void this.notifyIfActionClosed(`DiceVision: ${note}`, "WARNING");
    } else {
      this.rollOncePending = false;
      this.noDiceShown = false;
      this.notice = null;
      const share = buildShare(roll, this.player, this.settings.visibility, at, this.settings.forward.rumble);
      const entryId = this.addLogEntry({ at, mine: true, roll, shared: share !== null, note: null });
      const subject: DeliverySubject = { entryId, mine: true, playerName: this.player.name };
      if (share) {
        void this.host.broadcast(ROLL_CHANNEL, share, "REMOTE").catch((err) => this.deliveryFailed(subject, "the room", err));
      }
      this.forwardRoll(roll, at, subject);
      void this.host.setBadge(String(roll.total)).catch(() => {});
      void this.notifyIfActionClosed(describeRoll(roll, "You"), "INFO");
    }

    // The dashboard dropped its waiting flag when it sent this roll
    if (this.wantsRoll()) this.client.sendWaiting();
    else if (this.client.registered) this.client.sendCancel();
  }

  /** Send our usable roll to the other extensions turned on in settings. */
  private forwardRoll(roll: Roll, at: string, subject: DeliverySubject): void {
    const { forward, visibility } = this.settings;
    if (forward.grimoire) {
      const unaddressed = this.unaddressed(visibility);
      if (unaddressed) this.deliveryFailed(subject, "Game Master's Grimoire", new Error("player id unknown"), unaddressed);
      else {
        const message = grimoireMessage(roll, this.player, visibility, at);
        void this.host
          .broadcast(message.channel, message.data, message.destination)
          .catch((err) => this.deliveryFailed(subject, "Game Master's Grimoire", err));
      }
    }
    if (forward.rumble) this.writeRumbleLine(roll, visibility, at, subject);
    if (forward.dddice && visibility === "everyone") this.rollInDddice(roll, subject);
  }

  /**
   * Roll the same faces as 3D dice in the room's dddice room, as this
   * player. Called by forwardRoll for our usable Everyone rolls only:
   * addressing a GM only roll would need dddice's participant ids, an extra
   * round trip we don't make. Needs our player id (the key is filed under
   * it), the dddice extension's room slug and our key from the room
   * metadata; each missing piece is reported with what to do about it.
   */
  private rollInDddice(roll: Roll, subject: DeliverySubject): void {
    const { room, apiKey } = this.dddice;
    const why = !this.player.id
      ? PLAYER_UNKNOWN
      : !this.roomRead
        ? "This room's shared data couldn't be read at start; reload the room."
        : !room
          ? "No dddice room in this Owlbear room yet: open the dddice extension and pick a room."
          : !apiKey
            ? "dddice has no key for you yet: open the dddice extension in this room once."
            : null;
    if (why || !room || !apiKey) {
      this.deliveryFailed(subject, "dddice", new Error("dddice not set up"), why ?? undefined);
      return;
    }
    let request;
    try {
      request = dddiceRollRequest(roll, room, this.settings.dddiceTheme);
    } catch (err) {
      this.deliveryFailed(subject, "dddice", err, reasonFrom(err));
      return;
    }
    void createDddiceRoll(apiKey, request, this.fetch).catch((err) => this.deliveryFailed(subject, "dddice", err, reasonFrom(err)));
  }

  /**
   * Put a roll into this client's own Rumble! chat. Rumble! shows a line only
   * where it was written, so this runs for our own roll and for every shared
   * roll whose roller asked for Rumble! (see forward.ts). The subject names
   * the roller.
   */
  private writeRumbleLine(roll: Roll, visibility: Visibility, at: string, subject: DeliverySubject): void {
    const unaddressed = this.unaddressed(visibility);
    if (unaddressed) {
      this.deliveryFailed(subject, "Rumble!", new Error("player id unknown"), unaddressed);
      return;
    }
    void this.host
      .setPlayerMetadata(rumbleChatPatch(roll, subject.playerName, visibility, this.player.id, at))
      .catch((err) => this.deliveryFailed(subject, "Rumble!", err));
  }

  /**
   * A private roll needs our player id: Grimoire checks `owlbear_user_id` on
   * its whisper channel and Rumble! uses it as the private line's target.
   * Without one (getPlayer() failed at start) the roll would be misaddressed,
   * so the caller reports a failure with this reason instead of sending it.
   */
  private unaddressed(visibility: Visibility): string | null {
    return !this.player.id && visibility !== "everyone" ? PLAYER_UNKNOWN : null;
  }

  /**
   * One destination refused a roll that went out to the table: the room
   * share, Grimoire, this client's Rumble! line, or dddice. Says so on the log entry
   * (which outlives the notice) and as a notification while the popover is
   * closed; for our own roll also in the notice, which another player's roll
   * must not take over. Several failures on one roll add up ("the room and
   * Rumble!"); a reason the user can act on is appended when there is one.
   */
  private deliveryFailed(subject: DeliverySubject, destination: string, err: unknown, reason?: string): void {
    const { entryId, mine, playerName } = subject;
    console.error(`[DiceVision] Failed to send roll ${entryId} (${mine ? "ours" : playerName}) to ${destination}:`, err);
    const failed = [...(this.deliveryFailures.get(entryId) ?? []), destination];
    this.deliveryFailures.set(entryId, failed);
    for (const id of this.deliveryFailures.keys()) if (!this.log.some((e) => e.id === id)) this.deliveryFailures.delete(id);
    const where = failed.length > 1 ? `${failed.slice(0, -1).join(", ")} and ${failed.at(-1)}` : failed[0];
    const why = reason ? ` ${reason}` : "";
    this.log = this.log.map((e) => (e.id === entryId ? { ...e, note: `Couldn't send it to ${where}.${why}` } : e));
    if (mine) this.setNotice(`Rolled, but sending it to ${where} failed.${why}`, "warn");
    const whose = mine ? "the roll" : `${playerName}'s roll`;
    void this.notifyIfActionClosed(`DiceVision: sending ${whose} to ${where} failed.${why}`, "WARNING");
    this.emit();
  }

  private onNoDice(): void {
    if (!this.client.registered) return; // another app on the session asked
    if (this.rollOncePending && !this.noDiceShown) {
      this.noDiceShown = true;
      this.setNotice("No dice seen. Roll again in view of the camera.", "warn");
      void this.notifyIfActionClosed("DiceVision: no dice seen. Roll again.", "WARNING");
    }
  }

  private onSharedRoll(data: unknown): void {
    const share = parseShare(data);
    if (!share) return;
    if (share.playerId && share.playerId === this.player.id) return; // our own, already logged
    if (!shouldShow(share, this.player)) return;
    const entryId = this.addLogEntry({
      at: share.sentAt,
      mine: false,
      roll: share.roll,
      shared: true,
      note: null,
      playerName: share.playerName,
      playerColor: share.playerColor,
    });
    void this.host.notify(describeRoll(share.roll, share.playerName), "INFO").catch(() => {});
    // The roller's Rumble! choice, carried out here because Rumble! lines are per client
    if (share.rumble) {
      this.writeRumbleLine(share.roll, share.visibility, share.sentAt, { entryId, mine: false, playerName: share.playerName });
    }
    this.emit();
  }

  private async notifyIfActionClosed(message: string, variant: "INFO" | "WARNING"): Promise<void> {
    try {
      if (await this.host.isActionOpen()) return;
      await this.host.notify(message, variant);
    } catch (err) {
      console.warn("[DiceVision] Notification failed:", err);
    }
  }

  /** @returns the new entry's id */
  private addLogEntry(entry: Omit<LogEntry, "id" | "playerName" | "playerColor"> & Partial<Pick<LogEntry, "playerName" | "playerColor">>): string {
    this.entryCounter++;
    const id = `${entry.at}-${this.entryCounter}`;
    this.log = [
      {
        id,
        playerName: entry.playerName ?? this.player.name,
        playerColor: entry.playerColor ?? this.player.color,
        ...entry,
      },
      ...this.log,
    ].slice(0, MAX_LOG_ENTRIES);
    return id;
  }

  private setNotice(text: string, tone: Notice["tone"]): void {
    this.notice = { text, tone };
  }

  private updateSettings(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...patch };
    saveSettings(this.storage, this.settings);
  }

  private emit(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch (err) {
        console.error("[DiceVision] State listener failed:", err);
      }
    }
  }
}
