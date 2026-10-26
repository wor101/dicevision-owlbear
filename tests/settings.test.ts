import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, loadSettings, parseSettings, saveSettings, SETTINGS_KEY, type StorageLike } from "../src/settings";

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

describe("settings", () => {
  it("defaults when nothing is stored or storage is unavailable", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(saveSettings(null, DEFAULT_SETTINGS)).toBe(false);
  });

  it("round-trips", () => {
    const storage = memoryStorage();
    const settings = {
      sessionCode: "XKRM4N7B",
      autoConnect: false,
      continuous: true,
      visibility: "gm" as const,
      forward: { grimoire: true, rumble: false },
    };
    expect(saveSettings(storage, settings)).toBe(true);
    expect(storage.data.has(SETTINGS_KEY)).toBe(true);
    expect(loadSettings(storage)).toEqual(settings);
  });

  it("falls back per field on a malformed blob", () => {
    expect(parseSettings("not json")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('"a string"')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(JSON.stringify({ sessionCode: "xkrm-4n7b", autoConnect: "yes", continuous: 1, visibility: "all" }))).toEqual(
      DEFAULT_SETTINGS,
    );
    expect(parseSettings(JSON.stringify({ sessionCode: "XKRM4N7B", visibility: "self" }))).toEqual({
      ...DEFAULT_SETTINGS,
      sessionCode: "XKRM4N7B",
      visibility: "self",
    });
    // Settings saved before forwarding existed, and junk in it, read as off
    expect(parseSettings(JSON.stringify({ forward: "yes" })).forward).toEqual({ grimoire: false, rumble: false });
    expect(parseSettings(JSON.stringify({ sessionCode: "XKRM4N7B", forward: null }))).toMatchObject({
      sessionCode: "XKRM4N7B", // a null forward must not cost the rest of the blob
      forward: { grimoire: false, rumble: false },
    });
    expect(parseSettings(JSON.stringify({ forward: { grimoire: 1, rumble: true } })).forward).toEqual({ grimoire: false, rumble: true });
  });

  it("hands out its own copy of the defaults", () => {
    const a = parseSettings(null);
    a.forward.grimoire = true;
    expect(parseSettings(null).forward.grimoire).toBe(false);
    expect(DEFAULT_SETTINGS.forward.grimoire).toBe(false);
  });

  it("swallows a storage that throws", () => {
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadSettings(throwing)).toEqual(DEFAULT_SETTINGS);
    expect(saveSettings(throwing, DEFAULT_SETTINGS)).toBe(false);
  });
});
