/**
 * Forwarding a roll into other extensions that keep a roll log or a chat, so
 * a physical roll sits next to the table's virtual ones. Both are opt-in
 * (settings.forward) and off by default: they only do anything when the room
 * has that extension, and neither publishes a spec. The shapes below come
 * from the extensions' own source and from the Pixels Dice extension, which
 * forwards its physical rolls the same way:
 *
 * - Game Master's Grimoire (kamejosh/owlbear-hp-tracker): its background
 *   page listens on `<id>.roll-event` and adds the message to its roll log as
 *   it is (`RollLogEntryType`, deduplicated by `uuid`); `<id>.roll-event-whisper`
 *   is shown only by the roller's own client and GMs. Grimoire itself
 *   broadcasts REMOTE and adds its own entry locally; we have no entry of our
 *   own there, so we send to ALL and every client's Grimoire adds it once.
 * - Rumble! (Battle-System chat): a line is a write to the player's own
 *   metadata under `com.battle-system.friends/metadata_chatlog`; Rumble
 *   shows it to everyone (`targetId: "0000"`) or to one player.
 *
 * Pure functions, tested in Node.
 */

import { describeRoll, displayFace, type PhysicalDie, type Roll } from "./dice";
import type { BroadcastDestination } from "./host";
import type { Visibility } from "./settings";
import type { PlayerInfo } from "./share";

export const GRIMOIRE_ID = "com.bitperfect-software.hp-tracker";
export const GRIMOIRE_ROLL_CHANNEL = `${GRIMOIRE_ID}.roll-event`;
export const GRIMOIRE_WHISPER_CHANNEL = `${GRIMOIRE_ID}.roll-event-whisper`;
export const RUMBLE_CHAT_KEY = "com.battle-system.friends/metadata_chatlog";
/** Rumble!'s target for a message to the whole room */
export const RUMBLE_EVERYONE = "0000";
/** How forwarded rolls are labelled in the other extension */
export const FORWARD_LABEL = "DiceVision";

/** Grimoire's `RollLogEntryType` (src/context/RollLogContext.tsx there). */
export interface GrimoireRollEntry {
  uuid: string;
  created_at: string;
  /** "1d20+2d6"; Grimoire shows it and offers it as a re-roll */
  equation: string;
  /** "DiceVision" or "DiceVision: Critical!" (Grimoire splits on the colon) */
  label: string;
  is_hidden: boolean;
  total_value: string;
  /** Who rolled, as shown */
  username: string;
  /** One face per die, as displayed; Grimoire joins them with ", " */
  values: string[];
  owlbear_user_id: string;
  participantUsername: string;
}

export interface GrimoireMessage {
  channel: string;
  data: GrimoireRollEntry;
  destination: BroadcastDestination;
}

/** Rumble!'s chat line (the value under RUMBLE_CHAT_KEY in player metadata). */
export interface RumbleChatLine {
  chatlog: string;
  created: string;
  sender: string;
  /** RUMBLE_EVERYONE or a player id */
  targetId: string;
}

/** "1d20+2d6": dice grouped by type in the order read, no spaces (Grimoire's own form). */
export function equation(dice: PhysicalDie[]): string {
  const groups: { type: string; count: number }[] = [];
  for (const die of dice) {
    const group = groups.find((g) => g.type === die.type);
    if (group) group.count++;
    else groups.push({ type: die.type, count: 1 });
  }
  return groups.map((g) => `${g.count}${g.type}`).join("+");
}

function newUuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

/**
 * The roll as a Grimoire roll-log entry, on the channel and to the clients
 * its visibility allows: Everyone → the roll channel to all clients; GM only
 * → the whisper channel to all (shown by GMs and the roller); Only me → the
 * whisper channel to this client alone.
 */
export function grimoireMessage(roll: Roll, player: PlayerInfo, visibility: Visibility, at: string): GrimoireMessage {
  const labels = [...new Set(roll.tags.map((t) => t.label))];
  const data: GrimoireRollEntry = {
    uuid: roll.rollId ?? newUuid(),
    created_at: at,
    equation: equation(roll.dice),
    label: labels.length ? `${FORWARD_LABEL}: ${labels.join(", ")}` : FORWARD_LABEL,
    is_hidden: false,
    total_value: String(roll.total),
    username: player.name,
    values: roll.dice.map(displayFace),
    owlbear_user_id: player.id,
    participantUsername: player.name,
  };
  if (visibility === "everyone") return { channel: GRIMOIRE_ROLL_CHANNEL, data, destination: "ALL" };
  return { channel: GRIMOIRE_WHISPER_CHANNEL, data, destination: visibility === "gm" ? "ALL" : "LOCAL" };
}

/**
 * The roll as a Rumble! chat line, as a player-metadata patch. Rumble!
 * whispers to one player at most, so anything not shared with everyone goes
 * to the roller alone.
 */
export function rumbleChatPatch(roll: Roll, player: PlayerInfo, visibility: Visibility, at: string): Record<string, RumbleChatLine> {
  return {
    [RUMBLE_CHAT_KEY]: {
      chatlog: describeRoll(roll, player.name),
      created: at,
      sender: FORWARD_LABEL,
      targetId: visibility === "everyone" ? RUMBLE_EVERYONE : player.id,
    },
  };
}
