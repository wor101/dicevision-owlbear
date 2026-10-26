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
 */

import { BridgeClient, type BridgeEvent, type ConnectionState } from "./bridge-client";
import { describeRoll, isUsable, readRoll, summarizeTypes, unreadableDice, type Roll } from "./dice";
import { grimoireMessage, rumbleChatPatch } from "./forward";
import type { Host } from "./host";
import { formatSessionCode, normalizeSessionCode } from "./session-code";
import {
  availableStorage,
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
  /** Why a roll wasn't shared: "Couldn't read 1d8" */
  note: string | null;
}

export interface Notice {
  text: string;
  tone: "info" | "warn" | "error";
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
  | { cmd: "clearLog" }
  | { cmd: "clearNotice" };

export interface ControllerOptions {
  client?: BridgeClient;
  /** null: no storage; undefined: probe localStorage */
  storage?: StorageLike | null;
  now?: () => Date;
}

export class Controller {
  private readonly host: Host;
  private readonly client: BridgeClient;
  private readonly storage: StorageLike | null;
  private readonly now: () => Date;
  private settings: Settings;
  private player: PlayerInfo = { id: "", name: "You", color: null, role: "PLAYER" };
  private rollOncePending = false;
  private noDiceShown = false;
  private reconnectAttempt = 0;
  private log: LogEntry[] = [];
  private notice: Notice | null = null;
  private readonly listeners = new Set<(state: ControllerState) => void>();
  private readonly cleanups: (() => void)[] = [];
  private entryCounter = 0;

  constructor(host: Host, options: ControllerOptions = {}) {
    this.host = host;
    this.client = options.client ?? new BridgeClient();
    this.storage = options.storage === undefined ? availableStorage() : options.storage;
    this.now = options.now ?? (() => new Date());
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
    }
    this.cleanups.push(
      this.host.onPlayerChange((player) => {
        this.player = player;
        this.emit();
      }),
    );
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
    };
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
      const share = buildShare(roll, this.player, this.settings.visibility, at);
      this.addLogEntry({ at, mine: true, roll, shared: share !== null, note: null });
      if (share) {
        void this.host.broadcast(ROLL_CHANNEL, share).catch((err) => {
          console.error("[DiceVision] Failed to share the roll:", err);
          this.setNotice("Rolled, but sharing it with the room failed.", "warn");
          this.emit();
        });
      }
      this.forwardRoll(roll, at);
      void this.host.setBadge(String(roll.total)).catch(() => {});
      void this.notifyIfActionClosed(describeRoll(roll, "You"), "INFO");
    }

    // The dashboard dropped its waiting flag when it sent this roll
    if (this.wantsRoll()) this.client.sendWaiting();
    else if (this.client.registered) this.client.sendCancel();
  }

  /** Send a usable roll to the other extensions turned on in settings. */
  private forwardRoll(roll: Roll, at: string): void {
    const { forward, visibility } = this.settings;
    if (forward.grimoire) {
      const message = grimoireMessage(roll, this.player, visibility, at);
      void this.host
        .broadcast(message.channel, message.data, message.destination)
        .catch((err) => this.forwardFailed("Game Master's Grimoire", err));
    }
    if (forward.rumble) {
      void this.host
        .setPlayerMetadata(rumbleChatPatch(roll, this.player, visibility, at))
        .catch((err) => this.forwardFailed("Rumble!", err));
    }
  }

  private forwardFailed(extension: string, err: unknown): void {
    console.error(`[DiceVision] Failed to send the roll to ${extension}:`, err);
    this.setNotice(`Rolled, but sending it to ${extension} failed.`, "warn");
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
    this.addLogEntry({
      at: share.sentAt,
      mine: false,
      roll: share.roll,
      shared: true,
      note: null,
      playerName: share.playerName,
      playerColor: share.playerColor,
    });
    void this.host.notify(describeRoll(share.roll, share.playerName), "INFO").catch(() => {});
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

  private addLogEntry(entry: Omit<LogEntry, "id" | "playerName" | "playerColor"> & Partial<Pick<LogEntry, "playerName" | "playerColor">>): void {
    this.entryCounter++;
    this.log = [
      {
        id: `${entry.at}-${this.entryCounter}`,
        playerName: entry.playerName ?? this.player.name,
        playerColor: entry.playerColor ?? this.player.color,
        ...entry,
      },
      ...this.log,
    ].slice(0, MAX_LOG_ENTRIES);
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
