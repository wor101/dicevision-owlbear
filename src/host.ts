/**
 * The Owlbear Rodeo calls the controller makes, behind one interface so the
 * controller runs the same in a room (OBR SDK), standalone in a browser tab
 * (no OBR, nothing shared), and in tests (a recording fake).
 */

import OBR from "@owlbear-rodeo/sdk";
import type { PlayerInfo } from "./share";

export type NotificationVariant = "DEFAULT" | "ERROR" | "INFO" | "SUCCESS" | "WARNING";

export interface Host {
  /** Whether the page runs inside Owlbear Rodeo. */
  readonly available: boolean;
  getPlayer(): Promise<PlayerInfo>;
  onPlayerChange(callback: (player: PlayerInfo) => void): () => void;
  notify(message: string, variant: NotificationVariant): Promise<void>;
  /** The action button's badge; no text clears it. */
  setBadge(text?: string): Promise<void>;
  isActionOpen(): Promise<boolean>;
  /** Send to the other clients in the room (not back to this one). */
  broadcast(channel: string, data: unknown): Promise<void>;
  onBroadcast(channel: string, callback: (data: unknown) => void): () => void;
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
    broadcast: (channel, data) => OBR.broadcast.sendMessage(channel, data, { destination: "REMOTE" }),
    onBroadcast: (channel, callback) => OBR.broadcast.onMessage(channel, (event) => callback(event.data)),
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
    broadcast: async () => {},
    onBroadcast: () => () => {},
  };
}
