/**
 * Follow Owlbear Rodeo's theme. OBR hands extensions its palette
 * (`OBR.theme`); the popover maps it onto CSS variables that action.css
 * uses, with prefers-color-scheme defaults for outside OBR.
 */

import OBR, { type Theme } from "@owlbear-rodeo/sdk";

export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = theme.mode === "LIGHT" ? "light" : "dark";
  const vars: Record<string, string> = {
    "--bg": theme.background.default,
    "--paper": theme.background.paper,
    "--text": theme.text.primary,
    "--text-2": theme.text.secondary,
    "--text-disabled": theme.text.disabled,
    "--primary": theme.primary.main,
    "--primary-contrast": theme.primary.contrastText,
    "--secondary": theme.secondary.main,
  };
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
}

/** Apply OBR's theme now and whenever it changes. Call after OBR.onReady. */
export function followTheme(): () => void {
  OBR.theme
    .getTheme()
    .then((theme) => applyTheme(theme))
    .catch((err) => console.warn("[DiceVision] Couldn't read the theme:", err));
  return OBR.theme.onChange((theme) => applyTheme(theme));
}
