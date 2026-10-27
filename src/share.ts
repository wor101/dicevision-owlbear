/**
 * Sharing a roll with the rest of the room.
 *
 * Owlbear Rodeo has no dice of its own to hand a result to, so the extension
 * shows rolls itself: the roller's client broadcasts the roll on our channel
 * and every other client with the extension loaded (its background page)
 * shows a notification and adds it to its log. Like every OBR dice
 * extension, visibility is applied by the receiving client: a "GM only"
 * roll is sent to everyone and shown only by GM clients. "Only me" is never
 * broadcast.
 *
 * Channel and metadata keys use the reverse-DNS prefix OBR extensions
 * follow (`rodeo.owlbear.dice/roll`, `com.battle-system.bones/...`).
 * Broadcast messages are JSON of at most 16 KB; a roll is a few hundred
 * bytes.
 */

import { readDice, type GameTag, type Roll } from "./dice";
import type { Visibility } from "./settings";

export const PLUGIN_ID = "com.dirtyowlbear.dicevision";
export const ROLL_CHANNEL = `${PLUGIN_ID}/roll`;

/** The most dice a shared roll is read with; more is a malformed message. */
const MAX_SHARED_DICE = 50;

export interface SharedRoll {
  v: 1;
  playerId: string;
  playerName: string;
  playerColor: string | null;
  visibility: "everyone" | "gm";
  roll: Roll;
  sentAt: string;
  /**
   * The roller wants this roll in Rumble!'s chat. Rumble! shows a line only
   * on the client that wrote it, so every client that shows the roll writes
   * its own copy (forward.ts). Missing in messages from 0.2.0 clients.
   */
  rumble: boolean;
}

export interface PlayerInfo {
  id: string;
  name: string;
  color: string | null;
  role: "GM" | "PLAYER";
}

/** The message to broadcast for a roll, or null when it stays private. */
export function buildShare(
  roll: Roll,
  player: PlayerInfo,
  visibility: Visibility,
  sentAt: string,
  rumble = false,
): SharedRoll | null {
  if (visibility === "self") return null;
  return {
    v: 1,
    playerId: player.id,
    playerName: player.name,
    playerColor: player.color,
    visibility,
    roll: { dice: roll.dice, total: roll.total, rollId: roll.rollId, tags: roll.tags },
    sentAt,
    rumble,
  };
}

/** Read a message from our channel; null for anything that isn't a shared roll. */
export function parseShare(data: unknown): SharedRoll | null {
  if (!data || typeof data !== "object") return null;
  const msg = data as Record<string, unknown>;
  if (msg.v !== 1 || typeof msg.playerId !== "string" || !msg.playerId) return null;
  if (msg.visibility !== "everyone" && msg.visibility !== "gm") return null;
  if (!msg.roll || typeof msg.roll !== "object") return null;
  const roll = msg.roll as Record<string, unknown>;
  if (!Array.isArray(roll.dice) || roll.dice.length === 0 || roll.dice.length > MAX_SHARED_DICE) return null;
  const dice = readDice(roll.dice);
  if (!dice.every((d) => d.readable)) return null;
  const total =
    typeof roll.total === "number" && Number.isFinite(roll.total) ? roll.total : dice.reduce((sum, d) => sum + d.value, 0);
  const tags: GameTag[] = Array.isArray(roll.tags)
    ? roll.tags.flatMap((t): GameTag[] => {
        if (!t || typeof t !== "object") return [];
        const { die_index, tone, label } = t as Record<string, unknown>;
        if (typeof die_index !== "number" || typeof label !== "string") return [];
        return [{ die_index, tone: tone === "bad" ? "bad" : "good", label: label.slice(0, 40) }];
      })
    : [];
  return {
    v: 1,
    playerId: msg.playerId,
    playerName: typeof msg.playerName === "string" && msg.playerName.trim() ? msg.playerName.trim().slice(0, 60) : "Someone",
    playerColor: typeof msg.playerColor === "string" ? msg.playerColor : null,
    visibility: msg.visibility,
    roll: { dice, total, rollId: typeof roll.rollId === "string" && roll.rollId ? roll.rollId : null, tags },
    sentAt: typeof msg.sentAt === "string" ? msg.sentAt : new Date().toISOString(),
    rumble: msg.rumble === true,
  };
}

/** Whether this client should show a shared roll it received. */
export function shouldShow(share: SharedRoll, me: { id: string; role: "GM" | "PLAYER" }): boolean {
  if (share.playerId === me.id) return true;
  if (share.visibility === "everyone") return true;
  return me.role === "GM";
}
