import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ControllerState } from "../src/controller";
import { DEFAULT_SETTINGS } from "../src/settings";
import { ROLL_ICON, ROLL_WAITING_ICON, rollButtonSpec, sameSpec } from "../src/roll-button";

const root = new URL("../", import.meta.url);

function state(patch: Partial<ControllerState> & { continuous?: boolean } = {}): ControllerState {
  const { continuous, ...rest } = patch;
  return {
    connection: "connected",
    sessionCode: "XKRM4N7B",
    reconnectAttempt: 0,
    waiting: false,
    rollOncePending: false,
    settings: { ...DEFAULT_SETTINGS, forward: { ...DEFAULT_SETTINGS.forward }, continuous: continuous ?? false },
    storage: true,
    player: { id: "p1", name: "Will", color: null, role: "PLAYER" },
    log: [],
    notice: null,
    dddice: { room: null, hasKey: false, roomRead: true },
    ...rest,
  };
}

describe("rollButtonSpec", () => {
  it("rolls once when connected and idle", () => {
    expect(rollButtonSpec(state())).toEqual({ icon: ROLL_ICON, label: "DiceVision: roll once", action: "rollOnce" });
  });

  it("cancels while waiting, with the startled face", () => {
    expect(rollButtonSpec(state({ rollOncePending: true }))).toEqual({
      icon: ROLL_WAITING_ICON,
      label: "DiceVision: waiting for your roll (click to cancel)",
      action: "cancelRollOnce",
    });
  });

  it("opens the popover when there is nothing to trigger: not connected, or continuous mode", () => {
    for (const connection of ["disconnected", "connecting", "reconnecting"] as const) {
      expect(rollButtonSpec(state({ connection }))).toEqual({ icon: ROLL_ICON, label: "DiceVision: connect a session to roll", action: "openPopover" });
    }
    expect(rollButtonSpec(state({ continuous: true, rollOncePending: true })).action).toBe("openPopover");
  });

  it("compares specs by what the user sees and gets", () => {
    const a = rollButtonSpec(state());
    expect(sameSpec(null, a)).toBe(false);
    expect(sameSpec(a, rollButtonSpec(state()))).toBe(true);
    expect(sameSpec(a, rollButtonSpec(state({ rollOncePending: true })))).toBe(false);
  });

  it("points at icons that ship, drawn the design system's way", () => {
    for (const icon of [ROLL_ICON, ROLL_WAITING_ICON]) {
      const file = new URL(`public${icon}`, root);
      expect(existsSync(file)).toBe(true);
      const svg = readFileSync(file, "utf8");
      expect(svg).toMatch(/viewBox="0 0 24 24"/);
      expect(svg).toMatch(/fill="currentColor"/);
      expect(svg).not.toMatch(/stroke=/);
    }
  });
});
