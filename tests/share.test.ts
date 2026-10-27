import { describe, expect, it } from "vitest";
import { readRoll } from "../src/dice";
import { buildShare, parseShare, ROLL_CHANNEL, shouldShow, type PlayerInfo } from "../src/share";

const will: PlayerInfo = { id: "p1", name: "Will", color: "#ff0000", role: "PLAYER" };
const gm = { id: "gm", role: "GM" as const };
const player = { id: "p2", role: "PLAYER" as const };

const roll = readRoll({
  dice: [
    { type: "d20", value: 17, face: "17", readable: true },
    { type: "d6", value: 4, face: "pip_4", readable: true },
  ],
  total: 21,
  roll_id: "r1",
  game: { tags: [{ die_index: 0, tone: "good", label: "Critical!" }] },
});

describe("buildShare", () => {
  it("is null for Only me and carries the roll otherwise", () => {
    expect(buildShare(roll, will, "self", "t")).toBeNull();
    const share = buildShare(roll, will, "gm", "2026-10-25T10:00:00Z");
    expect(share).toMatchObject({ v: 1, playerId: "p1", playerName: "Will", playerColor: "#ff0000", visibility: "gm" });
    expect(share?.roll.total).toBe(21);
    expect(share?.roll.tags).toEqual(roll.tags);
    expect(ROLL_CHANNEL).toBe("com.dirtyowlbear.dicevision/roll");
  });

  it("round-trips through parseShare as JSON", () => {
    const share = buildShare(roll, will, "everyone", "2026-10-25T10:00:00Z")!;
    const parsed = parseShare(JSON.parse(JSON.stringify(share)));
    expect(parsed).toEqual(share);
    expect(JSON.stringify(share).length).toBeLessThan(16_000);
  });

  it("carries the roller's Rumble! choice; a 0.2.0 message without it reads as off", () => {
    expect(buildShare(roll, will, "everyone", "t")!.rumble).toBe(false);
    const share = buildShare(roll, will, "everyone", "t", true)!;
    expect(parseShare(JSON.parse(JSON.stringify(share)))!.rumble).toBe(true);
    const withoutFlag: Partial<typeof share> = { ...share };
    delete withoutFlag.rumble;
    expect(parseShare(withoutFlag)!.rumble).toBe(false);
    expect(parseShare({ ...share, rumble: "yes" })!.rumble).toBe(false);
  });
});

describe("parseShare", () => {
  const good = buildShare(roll, will, "everyone", "t")!;

  it("rejects anything that isn't a shared roll", () => {
    expect(parseShare(null)).toBeNull();
    expect(parseShare("roll")).toBeNull();
    expect(parseShare({ ...good, v: 2 })).toBeNull();
    expect(parseShare({ ...good, playerId: "" })).toBeNull();
    expect(parseShare({ ...good, visibility: "self" })).toBeNull();
    expect(parseShare({ ...good, roll: { dice: [] } })).toBeNull();
    expect(parseShare({ ...good, roll: { ...good.roll, dice: [{ type: "d8", value: -1, face: "-1", readable: false }] } })).toBeNull();
    expect(parseShare({ ...good, roll: { ...good.roll, dice: new Array(51).fill(good.roll.dice[0]) } })).toBeNull();
  });

  it("fills in defaults and trims what players send", () => {
    const parsed = parseShare({
      ...good,
      playerName: "   ",
      playerColor: 7,
      roll: { dice: good.roll.dice, total: "nan", tags: [{ die_index: 0, tone: "odd", label: "x".repeat(80) }, "junk"] },
      sentAt: 5,
    })!;
    expect(parsed.playerName).toBe("Someone");
    expect(parsed.playerColor).toBeNull();
    expect(parsed.roll.total).toBe(21); // summed
    expect(parsed.roll.tags).toEqual([{ die_index: 0, tone: "good", label: "x".repeat(40) }]);
    expect(typeof parsed.sentAt).toBe("string");
  });
});

describe("shouldShow", () => {
  it("everyone sees public rolls, only GMs (and the roller) see GM rolls", () => {
    const pub = buildShare(roll, will, "everyone", "t")!;
    const hidden = buildShare(roll, will, "gm", "t")!;
    expect(shouldShow(pub, player)).toBe(true);
    expect(shouldShow(pub, gm)).toBe(true);
    expect(shouldShow(hidden, player)).toBe(false);
    expect(shouldShow(hidden, gm)).toBe(true);
    expect(shouldShow(hidden, { id: "p1", role: "PLAYER" })).toBe(true);
  });
});
