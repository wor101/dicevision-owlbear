/**
 * The one-click roll button in Owlbear Rodeo's tool action bar (the row at
 * the top that belongs to the active tool). `OBR.tool.createAction` with no
 * filter shows it with every tool, so a physical roll is one click away
 * without opening the popover; the background page owns it, so it works on
 * every client as soon as the room loads.
 *
 * What a click does follows the controller's state, and so do the icon and
 * tooltip: the dirty owlbear's face while idle, its startled face while a
 * roll is wanted (Roll once pending, or continuous mode). Both are the
 * design system's OwlbearFaces at 24 px, filled with currentColor so
 * Owlbear's theme colours them. A tool action's icon can't be swapped in
 * place (the SDK has no update call for actions), so the controller creates
 * the action again under the same id when the spec changes; that Owlbear
 * then replaces the toolbar entry rather than adding one is the 0.4.0 room
 * check (if it duplicates, remove before creating).
 *
 * Pure: a spec from a state.
 */

import type { ControllerState } from "./controller";
import { PLUGIN_ID } from "./share";

export const ROLL_BUTTON_ID = `${PLUGIN_ID}/roll-button`;

/** Site-relative, like the manifest's icons; the SDK prepends our origin before sending them to Owlbear. */
export const ROLL_ICON = "/icons/roll.svg";
export const ROLL_WAITING_ICON = "/icons/roll-waiting.svg";

export type RollButtonIcon = typeof ROLL_ICON | typeof ROLL_WAITING_ICON;

/** What a click on the button does. */
export type RollButtonAction = "rollOnce" | "cancelRollOnce" | "openPopover";

export interface RollButtonSpec {
  icon: RollButtonIcon;
  /** The tooltip */
  label: string;
  action: RollButtonAction;
}

/** The button for a state. Anything that needs the popover (not connected, continuous mode) opens it. */
export function rollButtonSpec(state: ControllerState): RollButtonSpec {
  if (state.connection !== "connected") {
    return { icon: ROLL_ICON, label: "DiceVision: connect a session to roll", action: "openPopover" };
  }
  if (state.settings.continuous) {
    return { icon: ROLL_WAITING_ICON, label: "DiceVision: continuous mode is on (open to change)", action: "openPopover" };
  }
  if (state.rollOncePending) {
    return { icon: ROLL_WAITING_ICON, label: "DiceVision: waiting for your roll (click to cancel)", action: "cancelRollOnce" };
  }
  return { icon: ROLL_ICON, label: "DiceVision: roll once", action: "rollOnce" };
}

export function sameSpec(a: RollButtonSpec | null, b: RollButtonSpec): boolean {
  return a !== null && a.icon === b.icon && a.label === b.label && a.action === b.action;
}
