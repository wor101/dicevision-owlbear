import { describe, expect, it, vi } from "vitest";
import {
  createDddiceRoll,
  DDDICE_API,
  DDDICE_ROOM_KEY,
  dddiceDie,
  dddiceKeyFor,
  dddiceRollRequest,
  readDddiceSetup,
  type DddiceRollRequest,
  type FetchLike,
} from "../src/dddice";
import { readDice, type PhysicalDie, type Roll } from "../src/dice";

const die = (type: string, face: string, icon: PhysicalDie["icon"] = null): PhysicalDie => ({
  type,
  value: Number(/^pip_(\d+)$/.exec(face)?.[1] ?? face),
  face,
  readable: true,
  icon,
});

describe("readDddiceSetup", () => {
  it("reads the room slug and this player's key, nothing else", () => {
    const room = { [DDDICE_ROOM_KEY]: " AbC123 ", [dddiceKeyFor("p1")]: "k1", [dddiceKeyFor("p2")]: "k2", other: 1 };
    expect(readDddiceSetup(room, "p1")).toEqual({ room: "AbC123", apiKey: "k1" });
    expect(readDddiceSetup(room, "p3")).toEqual({ room: "AbC123", apiKey: null });
    expect(readDddiceSetup(room, "")).toEqual({ room: "AbC123", apiKey: null }); // no id, no key lookup
    expect(readDddiceSetup({}, "p1")).toEqual({ room: null, apiKey: null });
  });

  it("warns, without the value, when dddice's format isn't what we expect", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(readDddiceSetup({ [DDDICE_ROOM_KEY]: { slug: "AbC123" }, [dddiceKeyFor("p1")]: "" }, "p1")).toEqual({ room: null, apiKey: null });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toMatch(/dddice wrote a object as its room slug/);
    expect(warn.mock.calls[1][0]).toMatch(/dddice wrote a string as its player key/);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("AbC123");
    warn.mockRestore();
  });
});

describe("dddiceDie", () => {
  it("sends plain faces as their value", () => {
    expect(dddiceDie(die("d20", "17"), "t")).toEqual({ type: "d20", theme: "t", value: 17 });
    expect(dddiceDie(die("d6", "pip_4"), "t")).toEqual({ type: "d6", theme: "t", value: 4 });
    expect(dddiceDie(die("d8", "8"), "t")).toEqual({ type: "d8", theme: "t", value: 8 });
  });

  it("maps the d10's 0 face and the percentile tens die (a d10 with a two-digit face) the way dddice counts them", () => {
    // A d10's "0" is dddice's 10, shown as dddice shows its own (10): no display override
    expect(dddiceDie(die("d10", "0"), "t")).toEqual({ type: "d10", theme: "t", value: 10 });
    expect(dddiceDie(die("d10", "7"), "t")).toEqual({ type: "d10", theme: "t", value: 7 });
    // As DiceVision sends them: type d10, face "80", value 80 (the room check's "cannot roll value 80")
    expect(dddiceDie(die("d10", "80"), "t")).toEqual({ type: "d10x", theme: "t", value: 80, value_to_display: "80" });
    // The 00 face: the API takes the face label as the value (0.3.2's value 10 landed the die on the "10" face), shown "0"
    expect(dddiceDie(die("d10", "00"), "t")).toEqual({ type: "d10x", theme: "t", value: 0, value_to_display: "0" });
    expect(dddiceDie(die("d10", "10"), "t")).toEqual({ type: "d10x", theme: "t", value: 10, value_to_display: "10" });
    expect(dddiceDie(die("d10", "90"), "t")).toEqual({ type: "d10x", theme: "t", value: 90, value_to_display: "90" });
    // A d100 type, should a client ever send one, is the same die
    expect(dddiceDie(die("d100", "70"), "t")).toEqual({ type: "d10x", theme: "t", value: 70, value_to_display: "70" });
  });

  it("maps what readDice makes of the bridge's dice, including an older dashboard's value-only die", () => {
    const [tens, zeroZero, oldTens, oldZero] = readDice([
      { type: "d10", value: 80, face: "80", readable: true },
      { type: "d10", value: 0, face: "00", readable: true },
      { type: "d10", value: 70 },
      { type: "d10", value: 0 },
    ]);
    expect(dddiceDie(tens, "t")).toEqual({ type: "d10x", theme: "t", value: 80, value_to_display: "80" });
    expect(dddiceDie(zeroZero, "t")).toEqual({ type: "d10x", theme: "t", value: 0, value_to_display: "0" });
    expect(dddiceDie(oldTens, "t")).toEqual({ type: "d10x", theme: "t", value: 70, value_to_display: "70" });
    // A value-only "00" can't be told from a "0": it goes out as a d10's 10
    expect(dddiceDie(oldZero, "t")).toEqual({ type: "d10", theme: "t", value: 10 });
  });

  it("shows an icon by its label and keeps the number it stands for", () => {
    expect(dddiceDie(die("d20", "20", { id: "demon", label: "Demon" }), "t")).toEqual({
      type: "d20",
      theme: "t",
      value: 20,
      value_to_display: "Demon",
      label: "Demon",
    });
    expect(dddiceDie(die("d10", "90", { id: "skull", label: "Skull" }), "t")).toEqual({
      type: "d10x",
      theme: "t",
      value: 90,
      value_to_display: "Skull",
      label: "Skull",
    });
  });

  it("refuses what dddice can't show, so the roll is reported instead of sent as nonsense", () => {
    expect(() => dddiceDie(die("d100", "5"), "t")).toThrow('"5" isn\'t a tens face');
    expect(() => dddiceDie({ type: "d?", value: 3, face: "3", readable: true, icon: null }, "t")).toThrow("dddice has no d?");
  });
});

describe("dddiceRollRequest", () => {
  it("is dddice's create-a-roll body", () => {
    const roll: Roll = {
      dice: [die("d20", "17"), die("d6", "3")],
      total: 20,
      rollId: "r1",
      tags: [{ die_index: 0, tone: "good", label: "Critical!" }],
    };
    expect(dddiceRollRequest(roll, "AbC123", "dddice-bees")).toEqual({
      dice: [
        { type: "d20", theme: "dddice-bees", value: 17 },
        { type: "d6", theme: "dddice-bees", value: 3 },
      ],
      room: "AbC123",
      label: "DiceVision: Critical!",
    });
    expect(dddiceRollRequest({ ...roll, tags: [] }, "AbC123", "t").label).toBe("DiceVision");
  });
});

describe("createDddiceRoll", () => {
  const body: DddiceRollRequest = { dice: [{ type: "d20", theme: "t", value: 1 }], room: "r", label: "DiceVision" };

  it("posts with the bearer key and resolves on a 2xx", async () => {
    const calls: Parameters<FetchLike>[] = [];
    const fetch: FetchLike = async (...args) => {
      calls.push(args);
      return { ok: true, status: 201, text: async () => "{}" };
    };
    await createDddiceRoll("k1", body, fetch);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(`${DDDICE_API}/roll`);
    expect(calls[0][1].method).toBe("POST");
    expect(calls[0][1].headers).toMatchObject({ Authorization: "Bearer k1", "Content-Type": "application/json" });
    expect(JSON.parse(calls[0][1].body)).toEqual(body);
  });

  it("rejects with the status and dddice's message otherwise", async () => {
    const refuse = (status: number, text: string): FetchLike => async () => ({ ok: false, status, text: async () => text });
    await expect(createDddiceRoll("k", body, refuse(401, '{"type":"error","data":{"message":"Not authenticated"}}'))).rejects.toThrow(
      "dddice answered 401: Not authenticated",
    );
    await expect(createDddiceRoll("k", body, refuse(500, "<html>boom</html>"))).rejects.toThrow("dddice answered 500: <html>boom</html>");
    await expect(createDddiceRoll("k", body, refuse(502, ""))).rejects.toThrow("dddice answered 502");
  });

  it("digs the useful line out of a validation error, however long the body", async () => {
    const laravel = {
      message: "The given data was invalid.",
      errors: { "dice.0.theme": ["The selected dice.0.theme is invalid."], "dice.1.value": ["x".repeat(300)] },
    };
    const refuse: FetchLike = async () => ({ ok: false, status: 422, text: async () => JSON.stringify(laravel) });
    await expect(createDddiceRoll("k", body, refuse)).rejects.toThrow(
      "dddice answered 422: The given data was invalid. The selected dice.0.theme is invalid.",
    );
    const unreadable: FetchLike = async () => ({
      ok: false,
      status: 500,
      text: async () => {
        throw new Error("gone");
      },
    });
    await expect(createDddiceRoll("k", body, unreadable)).rejects.toThrow("dddice answered 500");
  });

  it("explains a network failure in plain words and keeps the cause", async () => {
    const offline: FetchLike = async () => {
      throw new TypeError("Failed to fetch");
    };
    const err = await createDddiceRoll("k", body, offline).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Couldn't reach dddice.com (offline, or a content blocker is in the way)");
    expect(((err as Error).cause as Error).message).toBe("Failed to fetch");
  });
});
