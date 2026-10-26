/**
 * The Owlbear Rodeo calls the controller makes, behind one interface so the
 * controller runs the same in a room (OBR SDK), standalone in a browser tab
 * (no OBR, nothing shared), and in tests (a recording fake).
 */

import OBR from "@owlbear-rodeo/sdk";
import type { PlayerInfo } from "./share";

export type NotificationVariant = "DEFAULT" | "ERROR" | "INFO" | "SUCCESS" | "WARNING";

/** Who a broadcast reaches: the other clients, this client's own iframes, or both. */
export type BroadcastDestination = "REMOTE" | "LOCAL" | "ALL";

export interface Host {
  /** Whether the page runs inside Owlbear Rodeo. */
  readonly available: boolean;
  getPlayer(): Promise<PlayerInfo>;
  onPlayerChange(callback: (player: PlayerInfo) => void): () => void;
  notify(message: string, variant: NotificationVariant): Promise<void>;
  /** The action button's badge; no text clears it. */
  setBadge(text?: string): Promise<void>;
  isActionOpen(): Promise<boolean>;
  /** Send on a broadcast channel to the given clients. */
  broadcast(channel: string, data: unknown, destination: BroadcastDestination): Promise<void>;
  onBroadcast(channel: string, callback: (data: unknown) => void): () => void;
  /** Merge keys into this player's metadata (how Rumble! takes a chat line). */
  setPlayerMetadata(patch: Record<string, unknown>): Promise<void>;
  /** The room's shared metadata (where the dddice extension leaves its room and keys). */
  getRoomMetadata(): Promise<Record<string, unknown>>;
  onRoomMetadataChange(callback: (metadata: Record<string, unknown>) => void): () => void;
}

const UNKNOWN_PLAYER: PlayerInfo = { id: "", name: "You", color: null, role: "PLAYER" };

async function readPlayer(): Promise<PlayerInfo> {
  const [name, color, role] = await Promise.all([OBR.player.getName(), OBR.player.getColor(), OBR.player.getRole()]);
  return { id: OBR.player.id, name, color, role };
}

/** The real thing: the OBR SDK. Call only after OBR.onReady. */
export function obrHost(): Host {
  return {
    available: true,
    getPlayer: readPlayer,
    onPlayerChange: (callback) =>
      OBR.player.onChange((player) => callback({ id: player.id, name: player.name, color: player.color, role: player.role })),
    notify: async (message, variant) => {
      await OBR.notification.show(message, variant);
    },
    setBadge: async (text) => {
      await OBR.action.setBadgeText(text);
    },
    isActionOpen: () => OBR.action.isOpen(),
    broadcast: (channel, data, destination) => OBR.broadcast.sendMessage(channel, data, { destination }),
    onBroadcast: (channel, callback) => OBR.broadcast.onMessage(channel, (event) => callback(event.data)),
    setPlayerMetadata: (patch) => OBR.player.setMetadata(patch),
    getRoomMetadata: () => OBR.room.getMetadata(),
    onRoomMetadataChange: (callback) => OBR.room.onMetadataChange(callback),
  };
}

/** Outside Owlbear Rodeo (a plain browser tab): nothing to notify or share with. */
export function standaloneHost(): Host {
  return {
    available: false,
    getPlayer: async () => UNKNOWN_PLAYER,
    onPlayerChange: () => () => {},
    notify: async (message, variant) => {
      console.log(`[DiceVision] ${variant}: ${message}`);
    },
    setBadge: async () => {},
    isActionOpen: async () => true,
    broadcast: async (channel, _data, destination) => {
      console.log(`[DiceVision] standalone: would broadcast on ${channel} (${destination})`);
    },
    onBroadcast: () => () => {},
    setPlayerMetadata: async (patch) => {
      console.log(`[DiceVision] standalone: would set player metadata ${Object.keys(patch).join(", ")}`);
    },
    getRoomMetadata: async () => ({}),
    onRoomMetadataChange: () => () => {},
  };
}
