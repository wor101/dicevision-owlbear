import { describe, expect, it } from "vitest";
import {
  createDddiceRoll,
  DDDICE_API,
  DDDICE_ROOM_KEY,
  dddiceDie,
  dddiceKeyFor,
  dddiceRollRequest,
  readDddiceSetup,
  type FetchLike,
} from "../src/dddice";
import type { PhysicalDie, Roll } from "../src/dice";

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
    expect(readDddiceSetup({ [DDDICE_ROOM_KEY]: 5, [dddiceKeyFor("p1")]: "" }, "p1")).toEqual({ room: null, apiKey: null });
    expect(readDddiceSetup({}, "p1")).toEqual({ room: null, apiKey: null });
  });
});

describe("dddiceDie", () => {
  it("sends plain faces as their value", () => {
    expect(dddiceDie(die("d20", "17"), "t")).toEqual({ type: "d20", theme: "t", value: 17 });
    expect(dddiceDie(die("d6", "pip_4"), "t")).toEqual({ type: "d6", theme: "t", value: 4 });
    expect(dddiceDie(die("d8", "8"), "t")).toEqual({ type: "d8", theme: "t", value: 8 });
  });

  it("maps the d10's 0 face and the d100 tens die the way dddice counts them", () => {
    expect(dddiceDie(die("d10", "0"), "t")).toEqual({ type: "d10", theme: "t", value: 10, value_to_display: "0" });
    expect(dddiceDie(die("d10", "7"), "t")).toEqual({ type: "d10", theme: "t", value: 7 });
    expect(dddiceDie(die("d100", "70"), "t")).toEqual({ type: "d10x", theme: "t", value: 7, value_to_display: "70" });
    expect(dddiceDie(die("d100", "00"), "t")).toEqual({ type: "d10x", theme: "t", value: 10, value_to_display: "00" });
  });

  it("shows an icon by its label and keeps the number it stands for", () => {
    expect(dddiceDie(die("d20", "20", { id: "demon", label: "Demon" }), "t")).toEqual({
      type: "d20",
      theme: "t",
      value: 20,
      value_to_display: "Demon",
      label: "Demon",
    });
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
  const body = { dice: [{ type: "d20", theme: "t", value: 1 }], room: "r", label: "DiceVision" };

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
});
