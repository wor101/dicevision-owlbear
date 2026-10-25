import { describe, expect, it } from "vitest";
import {
  describeRoll,
  displayFace,
  faceNumber,
  formatDice,
  isUsable,
  readDice,
  readRoll,
  summarizeTypes,
  unreadableDice,
} from "../src/dice";

/** A die as the server sends it */
const vtt = (type: string, face: string, readable = true, extra: Record<string, unknown> = {}) => {
  const n = faceNumber(face);
  return { type, value: readable && n !== null ? n : -1, face, readable, ...extra };
};

describe("faceNumber", () => {
  it("reads numbers, percentile tens, pips and the unread marker", () => {
    expect(faceNumber("7")).toBe(7);
    expect(faceNumber("00")).toBe(0);
    expect(faceNumber("30")).toBe(30);
    expect(faceNumber("pip_4")).toBe(4);
    expect(faceNumber("-1")).toBe(-1);
  });

  it("gives null for symbols and blanks", () => {
    expect(faceNumber("skull")).toBeNull();
    expect(faceNumber("")).toBeNull();
    expect(faceNumber(undefined)).toBeNull();
  });
});

describe("readDice", () => {
  it("reads every server shape", () => {
    const [tens, pip, old, unread, symbol, flagged, nul, noType, oddType, fraction, icon] = readDice([
      { type: "D10", value: 0, face: "00", readable: true },
      { type: "d6", value: "pip_4" },
      { type: "d20", value: 15 },
      { type: "d8", value: -1, face: "-1", readable: false },
      { type: "d12", value: "unknown" },
      { type: "d6", value: 3, face: "3", readable: "false" },
      null,
      { value: 2 },
      { type: "d7", value: 5 },
      { type: "d6", value: 2.5, face: "2.5", readable: true },
      { type: "d20", value: 20, face: "20", readable: true, icon: { id: "demon", label: "Demon", profile_id: "dragonbane" } },
    ]);
    expect(tens).toEqual({ type: "d10", value: 0, face: "00", readable: true, icon: null });
    expect(pip).toMatchObject({ value: 4, readable: true });
    expect(old).toMatchObject({ value: 15, face: "15", readable: true });
    expect(unread).toMatchObject({ readable: false, value: -1 });
    expect(symbol.readable).toBe(false);
    expect(flagged.readable).toBe(false);
    expect(nul).toMatchObject({ type: "d?", readable: false });
    expect(noType).toMatchObject({ type: "d?", readable: false, value: -1 });
    expect(oddType).toMatchObject({ type: "d7", readable: false });
    expect(fraction).toMatchObject({ readable: false, value: -1 });
    expect(icon).toMatchObject({ value: 20, readable: true, icon: { id: "demon", label: "Demon" } });
  });

  it("reads a missing list as no dice and is stable on its own output", () => {
    expect(readDice(undefined)).toEqual([]);
    expect(readDice({})).toEqual([]);
    const once = readDice([vtt("d20", "15"), vtt("d8", "-1", false)]);
    expect(readDice(once)).toEqual(once);
  });
});

describe("readRoll", () => {
  it("takes the server's total and the game tags", () => {
    const roll = readRoll({
      dice: [vtt("d20", "20"), vtt("d6", "pip_3")],
      total: 23,
      roll_id: "r1",
      game: { profile_id: "d20_rpg", status: "applied", tags: [{ die_index: 0, tone: "good", label: "Critical!", rule: 0 }] },
    });
    expect(roll.total).toBe(23);
    expect(roll.rollId).toBe("r1");
    expect(roll.tags).toEqual([{ die_index: 0, tone: "good", label: "Critical!" }]);
    expect(isUsable(roll)).toBe(true);
  });

  it("sums readable dice when the total is missing, and ignores a null game", () => {
    const roll = readRoll({ dice: [vtt("d20", "15"), vtt("d8", "-1", false)], game: null });
    expect(roll.total).toBe(15);
    expect(roll.tags).toEqual([]);
    expect(isUsable(roll)).toBe(false);
    expect(unreadableDice(roll).map((d) => d.type)).toEqual(["d8"]);
  });

  it("reads garbage as an empty roll", () => {
    expect(readRoll(null)).toEqual({ dice: [], total: 0, rollId: null, tags: [] });
    expect(isUsable(readRoll({ dice: [] }))).toBe(false);
  });
});

describe("display", () => {
  it("shows faces as printed, pips as counts, icons by label, ? when unread", () => {
    const [tens, pip, unread, icon] = readDice([
      vtt("d10", "00"),
      vtt("d6", "pip_5"),
      vtt("d8", "-1", false),
      vtt("d20", "20", true, { icon: { id: "demon", label: "Demon" } }),
    ]);
    expect(displayFace(tens)).toBe("00");
    expect(displayFace(pip)).toBe("5");
    expect(displayFace(unread)).toBe("?");
    expect(displayFace(icon)).toBe("Demon");
  });

  it("groups dice by type in the order read", () => {
    expect(formatDice(readDice([vtt("d10", "00"), vtt("d6", "pip_4"), vtt("d10", "7")]))).toBe("2d10 (00, 7) + 1d6 (4)");
    expect(summarizeTypes(["d8", "d8", "d20"])).toBe("2d8, 1d20");
  });

  it("describes a roll for a notification", () => {
    const roll = readRoll({
      dice: [vtt("d20", "17"), vtt("d6", "4"), vtt("d6", "3")],
      total: 24,
      game: { tags: [{ die_index: 0, tone: "good", label: "Critical!" }] },
    });
    expect(describeRoll(roll, "Will")).toBe("Will rolled 1d20 (17) + 2d6 (4, 3) = 24 · Critical!");
    expect(describeRoll({ ...roll, tags: [] }, null)).toBe("Rolled 1d20 (17) + 2d6 (4, 3) = 24");
  });
});
