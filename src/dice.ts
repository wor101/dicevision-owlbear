/**
 * Reading a DiceVision roll.
 *
 * The bridge sends each roll as `{dice, total, roll_id, game}` (dice-vision
 * `docs/integrations/VTT.md`, built by `app/services/vtt_payload.py`). Each
 * die is `{type, value, face, readable, icon}`:
 *
 * - `face`: the face as printed: "7", "00", "30", "pip_4" (a pip d6), "-1"
 *   when the camera couldn't read it.
 * - `value`: its number: pips as their dot count, "00" and "0" both 0, -1
 *   when unreadable.
 * - `readable`: false when the camera couldn't read the die.
 * - `icon`: set when a dice profile read the face as an icon
 *   (`{id, label, ...}`); `value`/`face` then hold the face the icon stands
 *   for (a Dragonbane demon is the 20).
 *
 * Older servers sent `{type, value}` only, so face and readable are worked
 * out from value then. Pure functions: no OBR, no DOM, so they're tested in
 * Node. Mirrors `readDice()` in the Talespire and Foundry clients.
 */

/** Die types the camera can read, with their face counts. */
export const SUPPORTED_DICE: Record<string, number> = {
  d4: 4,
  d6: 6,
  d8: 8,
  d10: 10,
  d12: 12,
  d20: 20,
  d100: 100,
};

export interface DieIcon {
  id: string;
  label: string;
}

export interface PhysicalDie {
  /** "d20"; "d?" when the server sent none */
  type: string;
  /** The face's number; -1 when unreadable */
  value: number;
  /** The face as printed ("00", "pip_4"); "-1" when unreadable */
  face: string;
  readable: boolean;
  /** The icon the face was read as, if a dice profile named one */
  icon: DieIcon | null;
}

export interface GameTag {
  die_index: number;
  tone: "good" | "bad";
  label: string;
}

/** A roll as the extension keeps and shares it. */
export interface Roll {
  dice: PhysicalDie[];
  total: number;
  rollId: string | null;
  tags: GameTag[];
}

/**
 * The number a DiceVision face string stands for: "7" -> 7, "00" -> 0,
 * "pip_4" -> 4, "-1" -> -1. null for any other symbol.
 */
export function faceNumber(face: unknown): number | null {
  const s = String(face ?? "").trim();
  const pips = /^pip_(-?\d+)$/.exec(s);
  if (pips) return Number(pips[1]);
  return /^-?\d+$/.test(s) ? Number(s) : null;
}

function readIcon(icon: unknown): DieIcon | null {
  if (!icon || typeof icon !== "object") return null;
  const { id, label } = icon as Record<string, unknown>;
  if (typeof id !== "string" || !id) return null;
  return { id, label: typeof label === "string" && label ? label : id };
}

/**
 * Read the dice of a roll. Anything that isn't a die object, and a
 * `readable` other than true (or missing), reads as an unreadable die, so a
 * bad message is reported rather than thrown on. A dice list that isn't an
 * array reads as no dice. Safe to call on its own output.
 */
export function readDice(dice: unknown): PhysicalDie[] {
  if (!Array.isArray(dice)) return [];
  return dice.map((d): PhysicalDie => {
    if (!d || typeof d !== "object") return { type: "d?", value: -1, face: "-1", readable: false, icon: null };
    const die = d as Record<string, unknown>;
    const type = typeof die.type === "string" && die.type.trim() ? die.type.trim().toLowerCase() : "d?";
    const face = String(die.face ?? die.value ?? "-1").trim();
    const value = typeof die.value === "number" ? die.value : faceNumber(face);
    const readable =
      (die.readable === undefined || die.readable === true) &&
      typeof value === "number" &&
      Number.isInteger(value) &&
      value >= 0 &&
      type in SUPPORTED_DICE;
    return { type, value: readable ? (value as number) : -1, face, readable, icon: readIcon(die.icon) };
  });
}

function readTags(game: unknown): GameTag[] {
  if (!game || typeof game !== "object") return [];
  const tags = (game as Record<string, unknown>).tags;
  if (!Array.isArray(tags)) return [];
  return tags.flatMap((t): GameTag[] => {
    if (!t || typeof t !== "object") return [];
    const { die_index, tone, label } = t as Record<string, unknown>;
    if (typeof die_index !== "number" || typeof label !== "string") return [];
    return [{ die_index, tone: tone === "bad" ? "bad" : "good", label }];
  });
}

/**
 * Read a roll message's `data`. The total is the server's when it sent a
 * number, else the sum of the readable dice.
 */
export function readRoll(data: unknown): Roll {
  const record = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const dice = readDice(record.dice);
  const total =
    typeof record.total === "number" && Number.isFinite(record.total)
      ? record.total
      : dice.reduce((sum, d) => (d.readable ? sum + d.value : sum), 0);
  return {
    dice,
    total,
    rollId: typeof record.roll_id === "string" ? record.roll_id : null,
    tags: readTags(record.game),
  };
}

/** The dice the camera couldn't read. */
export function unreadableDice(roll: Roll): PhysicalDie[] {
  return roll.dice.filter((d) => !d.readable);
}

/** A roll worth showing to the table: at least one die, all of them read. */
export function isUsable(roll: Roll): boolean {
  return roll.dice.length > 0 && roll.dice.every((d) => d.readable);
}

/** "2d8, 1d20" from ["d8", "d8", "d20"] */
export function summarizeTypes(types: string[]): string {
  const counts = new Map<string, number>();
  for (const t of types) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].map(([t, n]) => `${n}${t}`).join(", ");
}

/**
 * A face for display: as printed ("00"), pips as their count, an icon by
 * its label ("Demon"), "?" when unread.
 */
export function displayFace(die: PhysicalDie): string {
  if (!die.readable) return "?";
  if (die.icon) return die.icon.label;
  const pips = /^pip_(\d+)$/.exec(die.face);
  return pips ? pips[1] : die.face;
}

/** "1d20 (17) + 2d6 (4, 3)": dice grouped by type in the order read. */
export function formatDice(dice: PhysicalDie[]): string {
  const groups: { type: string; faces: string[] }[] = [];
  for (const die of dice) {
    const group = groups.find((g) => g.type === die.type);
    if (group) group.faces.push(displayFace(die));
    else groups.push({ type: die.type, faces: [displayFace(die)] });
  }
  return groups.map((g) => `${g.faces.length}${g.type} (${g.faces.join(", ")})`).join(" + ");
}

/** "Will rolled 1d20 (17) + 2d6 (4, 3) = 24 · Critical!" */
export function describeRoll(roll: Roll, playerName: string | null): string {
  const who = playerName ? `${playerName} rolled` : "Rolled";
  const labels = [...new Set(roll.tags.map((t) => t.label))];
  const tail = labels.length ? ` · ${labels.join(", ")}` : "";
  return `${who} ${formatDice(roll.dice)} = ${roll.total}${tail}`;
}
