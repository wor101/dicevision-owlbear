/**
 * Background page: loaded by Owlbear Rodeo for the whole room visit, on every
 * client with the extension enabled. Runs the Controller (bridge client,
 * waiting, roll log, sharing, notifications) and serves it to the action
 * popover over the local bus. Rolls shared by other players reach this page
 * whether or not the popover was ever opened.
 */

import OBR from "@owlbear-rodeo/sdk";
import { Controller } from "./controller";
import { obrHost } from "./host";
import { openBus, serveController } from "./local-bus";

OBR.onReady(() => {
  const controller = new Controller(obrHost(), { rollButton: true });
  const bus = openBus();
  if (bus) serveController(controller, bus);
  else console.warn("[DiceVision] No BroadcastChannel: the popover will run its own connection");
  controller.start().catch((err) => console.error("[DiceVision] Background start failed:", err));
});
