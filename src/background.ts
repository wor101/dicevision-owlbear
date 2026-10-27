/**
 * Background page: loaded by Owlbear Rodeo for the whole room visit, on every
 * client with the extension enabled. Runs the Controller (bridge client,
 * waiting, roll log, sharing, notifications) and serves it to the action
 * popover over the local bus. Rolls shared by other players reach this page
 * whether or not the popover was ever opened. It also owns the one-click
 * roll button in Owlbear's toolbar (roll-button.ts).
 */

import OBR from "@owlbear-rodeo/sdk";
import { Controller } from "./controller";
import { obrHost } from "./host";
import { openBus, serveController } from "./local-bus";

OBR.onReady(() => {
  const bus = openBus();
  // The toolbar roll button belongs to this controller only while the popover can talk to it;
  // without a bus the popover runs its own controller and the button would drive a different one
  const controller = new Controller(obrHost(), { rollButton: bus !== null });
  if (bus) serveController(controller, bus);
  else console.warn("[DiceVision] No BroadcastChannel: the popover will run its own connection");
  controller.start().catch((err) => console.error("[DiceVision] Background start failed:", err));
});
