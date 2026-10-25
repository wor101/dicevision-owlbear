/**
 * How the action popover talks to the background page. Both are iframes of
 * our origin inside the same Owlbear Rodeo tab, so a BroadcastChannel joins
 * them (the first-party Dice extension does the same for its tray focus).
 *
 * The background page serves: it applies commands and posts its state after
 * every change (and on "hello"). The popover is a client: it posts commands
 * and renders states. If no state arrives shortly after "hello" there is no
 * background page (local dev of action.html alone, or a host that didn't
 * load it), and the popover runs its own Controller instead.
 */

import type { Command, Controller, ControllerState } from "./controller";
import { PLUGIN_ID } from "./share";

export const LOCAL_CHANNEL = `${PLUGIN_ID}/local`;

export type BusMessage = { kind: "cmd"; command: Command } | { kind: "state"; state: ControllerState };

export interface Bus {
  post(message: BusMessage): void;
  onMessage(callback: (message: BusMessage) => void): () => void;
  close(): void;
}

/** A BroadcastChannel on our local channel, or null where the browser has none. */
export function openBus(): Bus | null {
  if (typeof BroadcastChannel === "undefined") return null;
  let channel: BroadcastChannel;
  try {
    channel = new BroadcastChannel(LOCAL_CHANNEL);
  } catch (err) {
    console.warn("[DiceVision] BroadcastChannel unavailable:", err);
    return null;
  }
  return {
    post: (message) => {
      try {
        channel.postMessage(message);
      } catch (err) {
        console.warn("[DiceVision] Failed to post on the local channel:", err);
      }
    },
    onMessage: (callback) => {
      const handler = (event: MessageEvent) => {
        const message = event.data as BusMessage | undefined;
        if (message && typeof message === "object" && "kind" in message) callback(message);
      };
      channel.addEventListener("message", handler);
      return () => channel.removeEventListener("message", handler);
    },
    close: () => channel.close(),
  };
}

/** Background side: apply commands from the bus, publish every state change. */
export function serveController(controller: Controller, bus: Bus): () => void {
  const stopState = controller.onChange((state) => bus.post({ kind: "state", state }));
  const stopCommands = bus.onMessage((message) => {
    if (message.kind === "cmd") controller.handle(message.command);
  });
  return () => {
    stopState();
    stopCommands();
  };
}

/** What the popover renders from: a remote Controller or its own. */
export interface ControllerView {
  send(command: Command): void;
  onState(callback: (state: ControllerState) => void): () => void;
}

/**
 * Popover side: ask the background page for its state. Resolves with a view
 * on it, or null when nothing answered within the timeout.
 */
export function connectRemote(bus: Bus, timeoutMs = 1500): Promise<ControllerView | null> {
  return new Promise((resolve) => {
    let settled = false;
    const stopProbe = bus.onMessage((message) => {
      if (message.kind !== "state" || settled) return;
      settled = true;
      clearTimeout(timer);
      stopProbe();
      const view: ControllerView = {
        send: (command) => bus.post({ kind: "cmd", command }),
        onState: (callback) => {
          callback(message.state);
          return bus.onMessage((m) => {
            if (m.kind === "state") callback(m.state);
          });
        },
      };
      resolve(view);
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stopProbe();
      resolve(null);
    }, timeoutMs);
    bus.post({ kind: "cmd", command: { cmd: "hello" } });
  });
}

/** A view on a Controller running in this very page. */
export function localView(controller: Controller): ControllerView {
  return {
    send: (command) => controller.handle(command),
    onState: (callback) => {
      callback(controller.getState());
      return controller.onChange(callback);
    },
  };
}
