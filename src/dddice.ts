/**
 * 3D dice through dddice (https://dddice.com), the one Owlbear Rodeo dice
 * extension that can be handed a finished result: its roll API takes a
 * `value` per die ("useful if using an external RNG"), and the dddice
 * extension shows every roll of the connected dddice room on every client.
 * The first-party Dice extension can't do this (it replays physics from a
 * throw and reads the value off the mesh; see the design doc).
 *
 * Setup is zero-config: the dddice extension writes its room slug to
 * Owlbear room metadata as `com.dddice/roomSlug` and each player's own API
 * key as `com.dddice/<player id>` (read from its Owlbear bundle; Game
 * Master's Grimoire reads the same keys). We read both and post the roll
 * from the roller's client with that key, so the roll is attributed to the
 * roller's dddice user. Players without the dddice extension set up have no
 * key, and the popover says so.
 *
 * Request shape from dddice's OpenAPI spec and SDK docs: `dice[].type`
 * (d4..d20, `d10x` for the percentile tens die), `theme` (a theme slug),
 * `value`, `value_to_display`, `label`; `room`, `label`. For a d10x "value
 * would range from 1-10 and value to display from 0 to 90", so a tens face
 * is sent as both. CORS allows our origin (checked 2026-10-26).
 *
 * Pure functions plus one fetch wrapper with an injectable fetch.
 */

import { displayFace, type PhysicalDie, type Roll } from "./dice";
import { FORWARD_LABEL } from "./forward";

export const DDDICE_API = "https://dddice.com/api/1.0";
export const DDDICE_ROOM_KEY = "com.dddice/roomSlug";
/** The theme used when the player hasn't named one (from dddice's own API examples) */
export const DEFAULT_DDDICE_THEME = "dddice-bees";

/** The dddice extension's room-metadata key holding this player's API key. */
export function dddiceKeyFor(playerId: string): string {
  return `com.dddice/${playerId}`;
}

export interface DddiceSetup {
  /** The dddice room the Owlbear room is linked to */
  room: string | null;
  /** This player's dddice API key, written by their dddice extension */
  apiKey: string | null;
}

/** What the dddice extension has written to the room for this player. */
export function readDddiceSetup(roomMetadata: Record<string, unknown>, playerId: string): DddiceSetup {
  const room = roomMetadata[DDDICE_ROOM_KEY];
  const key = playerId ? roomMetadata[dddiceKeyFor(playerId)] : undefined;
  return {
    room: typeof room === "string" && room.trim() ? room.trim() : null,
    apiKey: typeof key === "string" && key.trim() ? key.trim() : null,
  };
}

export interface DddiceDie {
  type: string;
  theme: string;
  value: number;
  value_to_display?: string;
  label?: string;
}

export interface DddiceRollRequest {
  dice: DddiceDie[];
  room: string;
  label: string;
}

/**
 * One die for dddice. The tens die of a d100 is dddice's `d10x`: value 1-10
 * with the face shown separately; a d10's "0" face is its 10. An icon face
 * keeps the number it stands for and shows the icon's label.
 */
export function dddiceDie(die: PhysicalDie, theme: string): DddiceDie {
  if (die.type === "d100") {
    const tens = die.value / 10; // "70" -> 7; "00" -> 0 -> dddice's 10
    return { type: "d10x", theme, value: tens === 0 ? 10 : tens, value_to_display: die.face };
  }
  const value = die.type === "d10" && die.value === 0 ? 10 : die.value;
  const shown = displayFace(die);
  const out: DddiceDie = { type: die.type, theme, value };
  if (shown !== String(value)) out.value_to_display = shown;
  if (die.icon) out.label = die.icon.label;
  return out;
}

/** The roll as a dddice "create a roll" request body. */
export function dddiceRollRequest(roll: Roll, room: string, theme: string): DddiceRollRequest {
  const labels = [...new Set(roll.tags.map((t) => t.label))];
  return {
    dice: roll.dice.map((die) => dddiceDie(die, theme)),
    room,
    label: labels.length ? `${FORWARD_LABEL}: ${labels.join(", ")}` : FORWARD_LABEL,
  };
}

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/** POST the roll to dddice; rejects with the API's message on anything but a 2xx. */
export async function createDddiceRoll(apiKey: string, body: DddiceRollRequest, fetchImpl: FetchLike): Promise<void> {
  const response = await fetchImpl(`${DDDICE_API}/roll`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (response.ok) return;
  let detail = "";
  try {
    detail = (await response.text()).trim().slice(0, 200);
    const parsed = JSON.parse(detail) as { data?: { message?: unknown }; message?: unknown };
    const message = parsed?.data?.message ?? parsed?.message;
    if (typeof message === "string") detail = message;
  } catch {
    // not JSON, or no readable body: keep what we have
  }
  throw new Error(`dddice answered ${response.status}${detail ? `: ${detail}` : ""}`);
}
