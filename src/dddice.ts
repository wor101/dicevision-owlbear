/**
 * 3D dice through dddice (https://dddice.com), an Owlbear Rodeo dice
 * extension that can be handed a finished result: its roll API takes a
 * `value` per die ("useful if using an external RNG"), and the dddice
 * extension shows every roll of the connected dddice room on every client.
 * The first-party Dice extension can't do this (it replays physics from a
 * throw and reads the value off the mesh; see the design doc).
 *
 * Setup is zero-config: the dddice extension writes its room slug to
 * Owlbear room metadata as `com.dddice/roomSlug` and each player's own API
 * key as `com.dddice/<player id>` (read from its Owlbear bundle; Game
 * Master's Grimoire reads the same keys, see its `getApiKey`/`getDiceRoom`).
 * We read both and post the roll from the roller's client with that key,
 * so the roll is attributed to the roller's dddice user. Players without
 * the dddice extension set up have no key, and the popover says so.
 *
 * Request shape from dddice's OpenAPI spec and SDK docs: `dice[].type`
 * (d4..d20, `d10x` for the percentile tens die), `theme` (a theme slug),
 * `value`, `value_to_display`, `label`; `room`, `label`. For a d10x the SDK
 * says the value ranges 1-10 and the value to display 0-90; dddice's own
 * integrations (dddice-browser-extension `convertD100toD10x`, and the SDK's
 * notation parser) send the tens face divided by ten as `value`, 10 for the
 * 00 face, with `value_to_display` "0", "10" … "90"; the SDK's theme face
 * list for d10x is [10, 20 … 90, 0], so value 10 lands on the 00 face. We
 * do exactly that (an icon face shows its label instead). 0.3.1 sent "00"
 * as the display, a string no theme lists, and the room showed 10 for it;
 * 0.3.2 matches dddice's "0", whether that shows 00 in the room is still
 * to be seen.
 * DiceVision reports that die as a `d10` with a two-digit face (bridge
 * docs: `"00"` and `"0"` stay distinct by face), so the face, not the type,
 * says which d10 is the tens die; sending it as a plain d10 gets "Die with
 * id: d10 cannot roll value 80" (room check 2026-10-26). A value-only die
 * from an older dashboard works too, since readDice derives its face from
 * the value ("70"), though its "00" arrives as "0" and goes out as a plain
 * d10. CORS allows our origin (checked 2026-10-26).
 *
 * Pure functions plus one fetch wrapper with an injectable fetch.
 */

import { displayFace, type PhysicalDie, type Roll } from "./dice";
import { FORWARD_LABEL } from "./forward";

export const DDDICE_API = "https://dddice.com/api/1.0";
export const DDDICE_ROOM_KEY = "com.dddice/roomSlug";

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

function readKey(metadata: Record<string, unknown>, key: string, what: string): string | null {
  const value = metadata[key];
  if (value === undefined) return null;
  if (typeof value === "string" && value.trim()) return value.trim();
  // Another extension's undocumented format: say so (the shape only, never a value, one may be a key)
  console.warn(`[DiceVision] dddice wrote a ${value === null ? "null" : typeof value} as its ${what}; expected a string. Has the dddice extension changed its format?`);
  return null;
}

/** What the dddice extension has written to the room for this player. */
export function readDddiceSetup(roomMetadata: Record<string, unknown>, playerId: string): DddiceSetup {
  return {
    room: readKey(roomMetadata, DDDICE_ROOM_KEY, "room slug"),
    apiKey: playerId ? readKey(roomMetadata, dddiceKeyFor(playerId), "player key") : null,
  };
}

/** dddice's standard die types; the percentile tens die is `d10x`. */
export type DddiceDieType = "d4" | "d6" | "d8" | "d10" | "d10x" | "d12" | "d20";

const DDDICE_TYPE: Record<string, DddiceDieType> = { d4: "d4", d6: "d6", d8: "d8", d10: "d10", d12: "d12", d20: "d20", d100: "d10x" };

export interface DddiceDie {
  type: DddiceDieType;
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

/** A percentile tens face as DiceVision prints it: "00", "10" … "90" (a d10's own faces are "0" … "9"). */
const TENS_FACE = /^[0-9]0$/;

/**
 * One die for dddice. DiceVision reports the percentile tens die as a `d10`
 * whose face is two digits ("00", "30"); that is dddice's `d10x`, value 1-10
 * (10 for "00") shown as dddice writes it ("0", "30"). A d10's "0" face is
 * its 10, shown as 10 the way dddice shows its own. An icon face keeps the
 * number it stands for and shows the icon's label. Throws on a
 * die dddice has no type for, or a tens die whose value isn't a multiple of
 * ten (a `d100`-typed die with a one-digit face), so the roll is reported
 * instead of sent as nonsense.
 */
export function dddiceDie(die: PhysicalDie, theme: string): DddiceDie {
  let type = DDDICE_TYPE[die.type];
  if (!type) throw new Error(`dddice has no ${die.type}`);
  const shown = displayFace(die);
  let value = die.value;
  if (type === "d10" && TENS_FACE.test(die.face)) type = "d10x";
  if (type === "d10x") {
    value = die.value === 0 ? 10 : die.value / 10;
    if (!Number.isInteger(value) || value < 1 || value > 10) throw new Error(`"${die.face}" isn't a tens face`);
  } else if (type === "d10" && value === 0) {
    value = 10; // no display override below: dddice shows that face as 10, its own convention
  }
  const out: DddiceDie = { type, theme, value };
  if (die.icon) {
    out.value_to_display = shown;
    out.label = die.icon.label;
  } else if (type === "d10x") {
    // dddice's own form for the tens die: "0", "10" … "90" (its themes list the 00 face as 0)
    out.value_to_display = String(value === 10 ? 0 : value * 10);
  }
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

/** dddice's error body: `{data: {message}}` from the API, or Laravel's `{message, errors: {field: [..]}}` on validation. */
function errorDetail(text: string): string {
  try {
    const parsed = JSON.parse(text) as { data?: { message?: unknown }; message?: unknown; errors?: Record<string, unknown> };
    const parts: string[] = [];
    const message = parsed?.data?.message ?? parsed?.message;
    if (typeof message === "string") parts.push(message);
    if (parsed?.errors && typeof parsed.errors === "object") {
      const first = Object.values(parsed.errors)[0];
      const detail = Array.isArray(first) ? first[0] : first;
      if (typeof detail === "string" && detail !== message) parts.push(detail);
    }
    if (parts.length) return parts.join(" ");
  } catch {
    // not JSON: use the text itself
  }
  return text.trim().slice(0, 200);
}

/**
 * POST the roll to dddice; rejects with the API's message on anything but a
 * 2xx, and with a plain explanation when dddice.com can't be reached.
 */
export async function createDddiceRoll(apiKey: string, body: DddiceRollRequest, fetchImpl: FetchLike): Promise<void> {
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(`${DDDICE_API}/roll`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error("Couldn't reach dddice.com (offline, or a content blocker is in the way)", { cause: err });
  }
  if (response.ok) return;
  let detail = "";
  try {
    detail = errorDetail(await response.text());
  } catch {
    // no readable body: the status will have to do
  }
  throw new Error(`dddice answered ${response.status}${detail ? `: ${detail}` : ""}`);
}
