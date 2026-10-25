/**
 * Per-player settings, kept in the extension's own localStorage when the
 * browser allows it. Our pages are a third-party iframe inside Owlbear
 * Rodeo, so storage can be partitioned, empty in a private window, or throw
 * (Safari, cookies blocked). Everything here is best-effort: the extension
 * works without it, the user just re-enters the code.
 *
 * Nothing goes in OBR room metadata (a session code is per player and would
 * be visible to the whole room).
 */

export type Visibility = "everyone" | "gm" | "self";

export interface Settings {
  sessionCode: string | null;
  autoConnect: boolean;
  continuous: boolean;
  visibility: Visibility;
}

export const SETTINGS_KEY = "com.dirtyowlbear.dicevision/settings";

export const DEFAULT_SETTINGS: Settings = {
  sessionCode: null,
  autoConnect: true,
  continuous: false,
  visibility: "everyone",
};

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const VISIBILITIES: Visibility[] = ["everyone", "gm", "self"];

/** Read a stored settings blob; anything malformed falls back per field. */
export function parseSettings(raw: string | null): Settings {
  if (!raw) return { ...DEFAULT_SETTINGS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
  if (!parsed || typeof parsed !== "object") return { ...DEFAULT_SETTINGS };
  const s = parsed as Record<string, unknown>;
  return {
    sessionCode: typeof s.sessionCode === "string" && /^[A-Z2-9]{8}$/.test(s.sessionCode) ? s.sessionCode : null,
    autoConnect: typeof s.autoConnect === "boolean" ? s.autoConnect : DEFAULT_SETTINGS.autoConnect,
    continuous: typeof s.continuous === "boolean" ? s.continuous : DEFAULT_SETTINGS.continuous,
    visibility: VISIBILITIES.includes(s.visibility as Visibility) ? (s.visibility as Visibility) : DEFAULT_SETTINGS.visibility,
  };
}

/** The browser's localStorage if reading and writing it works, else null. */
export function availableStorage(): StorageLike | null {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return null;
    const probe = `${SETTINGS_KEY}/probe`;
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

export function loadSettings(storage: StorageLike | null): Settings {
  if (!storage) return { ...DEFAULT_SETTINGS };
  try {
    return parseSettings(storage.getItem(SETTINGS_KEY));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** @returns whether the settings were stored */
export function saveSettings(storage: StorageLike | null, settings: Settings): boolean {
  if (!storage) return false;
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}
