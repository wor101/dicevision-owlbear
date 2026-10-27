import { describe, expect, it } from "vitest";
import type { PhysicalDie, Roll } from "../src/dice";
import {
  equation,
  FORWARD_LABEL,
  GRIMOIRE_ROLL_CHANNEL,
  GRIMOIRE_WHISPER_CHANNEL,
  grimoireMessage,
  RUMBLE_CHAT_KEY,
  RUMBLE_EVERYONE,
  rumbleChatPatch,
} from "../src/forward";
import type { PlayerInfo } from "../src/share";

const die = (type: string, face: string, icon: PhysicalDie["icon"] = null): PhysicalDie => ({
  type,
  value: Number(/^pip_(\d+)$/.exec(face)?.[1] ?? face),
  face,
  readable: true,
  icon,
});

const will: PlayerInfo = { id: "p1", name: "Will", color: "#f00", role: "PLAYER" };
const at = "2026-10-26T18:00:00.000Z";
const roll: Roll = {
  dice: [die("d20", "17"), die("d6", "pip_4"), die("d6", "3")],
  total: 24,
  rollId: "roll-1",
  tags: [{ die_index: 0, tone: "good", label: "Critical!" }],
};

describe("equation", () => {
  it("groups dice by type in the order read, Grimoire style", () => {
    expect(equation(roll.dice)).toBe("1d20+2d6");
    expect(equation([die("d6", "2"), die("d20", "1"), die("d6", "5")])).toBe("2d6+1d20");
    expect(equation([die("d100", "70")])).toBe("1d100");
  });
});

describe("grimoireMessage", () => {
  it("is Grimoire's roll-log entry, with the roll id as uuid", () => {
    const { channel, data, destination } = grimoireMessage(roll, will, "everyone", at);
    expect(channel).toBe(GRIMOIRE_ROLL_CHANNEL);
    expect(destination).toBe("ALL"); // our own Grimoire has to add it too
    expect(data).toEqual({
      uuid: "roll-1",
      created_at: at,
      equation: "1d20+2d6",
      label: `${FORWARD_LABEL}: Critical!`,
      is_hidden: false,
      total_value: "24",
      username: "Will",
      values: ["17", "4", "3"],
      owlbear_user_id: "p1",
      participantUsername: "Will",
    });
  });

  it("shows icons by their label and a plain label without tags", () => {
    const demon: Roll = {
      dice: [die("d20", "20", { id: "demon", label: "Demon" })],
      total: 20,
      rollId: null,
      tags: [],
    };
    const a = grimoireMessage(demon, will, "everyone", at).data;
    const b = grimoireMessage(demon, will, "everyone", at).data;
    expect(a.values).toEqual(["Demon"]);
    expect(a.label).toBe(FORWARD_LABEL);
    expect(a.uuid).toMatch(/\S/);
    expect(a.uuid).not.toBe(b.uuid); // no roll id: each message gets its own
  });

  it("joins distinct tag labels into the label", () => {
    const two: Roll = {
      ...roll,
      tags: [
        { die_index: 0, tone: "good", label: "Critical!" },
        { die_index: 1, tone: "bad", label: "Fumble!" },
        { die_index: 2, tone: "bad", label: "Fumble!" },
      ],
    };
    expect(grimoireMessage(two, will, "everyone", at).data.label).toBe(`${FORWARD_LABEL}: Critical!, Fumble!`);
  });

  it("follows the visibility: whisper channel for GM only and Only me", () => {
    const gm = grimoireMessage(roll, will, "gm", at);
    expect(gm.channel).toBe(GRIMOIRE_WHISPER_CHANNEL);
    expect(gm.destination).toBe("ALL"); // Grimoire's GMs and the roller show it
    const self = grimoireMessage(roll, will, "self", at);
    expect(self.channel).toBe(GRIMOIRE_WHISPER_CHANNEL);
    expect(self.destination).toBe("LOCAL");
    expect(self.data.owlbear_user_id).toBe("p1"); // what Grimoire checks on the whisper channel
  });
});

describe("rumbleChatPatch", () => {
  it("is one chat line under Rumble!'s metadata key", () => {
    expect(rumbleChatPatch(roll, "Will", "everyone", "p1", at)).toEqual({
      [RUMBLE_CHAT_KEY]: {
        chatlog: "Will rolled 1d20 (17) + 2d6 (4, 3) = 24 · Critical!",
        created: at,
        sender: FORWARD_LABEL,
        targetId: RUMBLE_EVERYONE,
      },
    });
  });

  it("names another player's roll and addresses a private one to this client", () => {
    const line = rumbleChatPatch(roll, "Ana", "gm", "gm-id", at)[RUMBLE_CHAT_KEY];
    expect(line.chatlog).toMatch(/^Ana rolled /);
    expect(line.targetId).toBe("gm-id");
    expect(rumbleChatPatch(roll, "Will", "self", "p1", at)[RUMBLE_CHAT_KEY].targetId).toBe("p1");
  });
});
