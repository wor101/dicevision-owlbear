/**
 * Action popover: the UI. Session code, Connect, Roll once, Continuous,
 * who sees your rolls, and the recent rolls. It renders the Controller's
 * state and sends it commands, normally over the local bus to the background
 * page; if no background page answers it runs a Controller of its own.
 */

import OBR from "@owlbear-rodeo/sdk";
import type { Command, ControllerState, LogEntry } from "./controller";
import { Controller } from "./controller";
import { displayFace } from "./dice";
import { obrHost, standaloneHost } from "./host";
import { connectRemote, localView, openBus, type ControllerView } from "./local-bus";
import { formatSessionCode } from "./session-code";
import type { Visibility } from "./settings";
import { followTheme } from "./theme";

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

const ui = {
  statusDot: el<HTMLSpanElement>("status-dot"),
  statusText: el<HTMLSpanElement>("status-text"),
  code: el<HTMLInputElement>("code"),
  paste: el<HTMLButtonElement>("paste"),
  connect: el<HTMLButtonElement>("connect"),
  disconnect: el<HTMLButtonElement>("disconnect"),
  autoConnect: el<HTMLInputElement>("auto-connect"),
  storageNote: el<HTMLParagraphElement>("storage-note"),
  rollOnce: el<HTMLButtonElement>("roll-once"),
  continuous: el<HTMLInputElement>("continuous"),
  visibility: el<HTMLSelectElement>("visibility"),
  forwardGrimoire: el<HTMLInputElement>("forward-grimoire"),
  forwardRumble: el<HTMLInputElement>("forward-rumble"),
  notice: el<HTMLParagraphElement>("notice"),
  noticeClose: el<HTMLButtonElement>("notice-close"),
  log: el<HTMLOListElement>("log"),
  logEmpty: el<HTMLParagraphElement>("log-empty"),
  clearLog: el<HTMLButtonElement>("clear-log"),
  player: el<HTMLSpanElement>("player"),
};

function statusLabel(state: ControllerState): string {
  switch (state.connection) {
    case "connected":
      if (state.waiting) return state.settings.continuous ? "Waiting for rolls (continuous)" : "Waiting for your roll";
      return `Connected · ${state.sessionCode ? formatSessionCode(state.sessionCode) : ""}`;
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return `Reconnecting (attempt ${state.reconnectAttempt})…`;
    default:
      return "Not connected";
  }
}

function timeLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function renderEntry(entry: LogEntry): HTMLLIElement {
  const li = document.createElement("li");
  li.className = `entry${entry.mine ? " mine" : ""}${entry.shared || entry.note ? "" : " private"}${entry.note ? " unusable" : ""}`;

  const head = document.createElement("div");
  head.className = "entry-head";
  const name = document.createElement("span");
  name.className = "entry-name";
  name.textContent = entry.mine ? "You" : entry.playerName;
  if (entry.playerColor) name.style.color = entry.playerColor;
  const time = document.createElement("span");
  time.className = "entry-time";
  time.textContent = timeLabel(entry.at);
  head.append(name, time);

  const dice = document.createElement("div");
  dice.className = "entry-dice";
  for (const die of entry.roll.dice) {
    const chip = document.createElement("span");
    chip.className = `die${die.readable ? "" : " unread"}`;
    const type = document.createElement("small");
    type.textContent = die.type;
    const face = document.createElement("b");
    face.textContent = displayFace(die);
    chip.append(type, face);
    dice.append(chip);
  }
  const total = document.createElement("span");
  total.className = "entry-total";
  total.textContent = `= ${entry.roll.total}`;
  dice.append(total);

  li.append(head, dice);

  const labels = [...new Set(entry.roll.tags.map((t) => `${t.tone}:${t.label}`))];
  if (labels.length) {
    const tags = document.createElement("div");
    tags.className = "entry-tags";
    for (const l of labels) {
      const [tone, label] = l.split(":", 2);
      const tag = document.createElement("span");
      tag.className = `tag ${tone}`;
      tag.textContent = label;
      tags.append(tag);
    }
    li.append(tags);
  }

  if (entry.note || (entry.mine && !entry.shared)) {
    const note = document.createElement("div");
    note.className = "entry-note";
    note.textContent = entry.note ?? "Only you can see this roll.";
    li.append(note);
  }
  return li;
}

let lastLogIds = "";
let lastCode: string | null = null;

function render(state: ControllerState): void {
  const connected = state.connection === "connected";
  const active = state.connection !== "disconnected";

  ui.statusDot.dataset.state = state.connection;
  ui.statusDot.classList.toggle("waiting", connected && state.waiting);
  ui.statusText.textContent = statusLabel(state);

  // Only rewrite the code field when the saved code changed, so typing isn't interrupted
  if (state.sessionCode !== lastCode) {
    lastCode = state.sessionCode;
    if (state.sessionCode) ui.code.value = formatSessionCode(state.sessionCode);
  }
  ui.code.disabled = active;
  ui.paste.disabled = active;
  ui.connect.hidden = active;
  ui.disconnect.hidden = !active;
  ui.autoConnect.checked = state.settings.autoConnect;
  ui.storageNote.hidden = state.storage;

  ui.rollOnce.disabled = !connected || state.settings.continuous;
  ui.rollOnce.textContent = state.rollOncePending ? "Cancel" : "Roll once";
  ui.rollOnce.classList.toggle("pending", state.rollOncePending);
  ui.continuous.checked = state.settings.continuous;
  ui.continuous.disabled = !connected;
  ui.visibility.value = state.settings.visibility;
  ui.forwardGrimoire.checked = state.settings.forward.grimoire;
  ui.forwardRumble.checked = state.settings.forward.rumble;

  ui.notice.hidden = !state.notice;
  ui.notice.dataset.tone = state.notice?.tone ?? "info";
  ui.notice.firstChild!.textContent = state.notice?.text ?? "";

  const ids = state.log.map((e) => e.id).join("|");
  if (ids !== lastLogIds) {
    lastLogIds = ids;
    ui.log.replaceChildren(...state.log.map(renderEntry));
  }
  ui.logEmpty.hidden = state.log.length > 0;
  ui.clearLog.hidden = state.log.length === 0;

  ui.player.textContent = state.player.id ? `${state.player.name} · ${state.player.role === "GM" ? "GM" : "Player"}` : "";
}

function bind(view: ControllerView): void {
  const send = (command: Command) => view.send(command);

  ui.connect.addEventListener("click", () => send({ cmd: "connect", code: ui.code.value }));
  ui.code.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !ui.code.disabled) send({ cmd: "connect", code: ui.code.value });
  });
  ui.code.addEventListener("input", () => {
    const clean = ui.code.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    ui.code.value = clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
  });
  ui.paste.addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      ui.code.value = text;
      ui.code.dispatchEvent(new Event("input"));
      send({ cmd: "connect", code: ui.code.value });
    } catch {
      ui.code.focus();
    }
  });
  ui.paste.hidden = !navigator.clipboard?.readText;
  ui.disconnect.addEventListener("click", () => send({ cmd: "disconnect" }));
  ui.autoConnect.addEventListener("change", () => send({ cmd: "setAutoConnect", on: ui.autoConnect.checked }));
  ui.rollOnce.addEventListener("click", () =>
    send(ui.rollOnce.classList.contains("pending") ? { cmd: "cancelRollOnce" } : { cmd: "rollOnce" }),
  );
  ui.continuous.addEventListener("change", () => send({ cmd: "setContinuous", on: ui.continuous.checked }));
  ui.visibility.addEventListener("change", () => send({ cmd: "setVisibility", visibility: ui.visibility.value as Visibility }));
  ui.forwardGrimoire.addEventListener("change", () => send({ cmd: "setForward", target: "grimoire", on: ui.forwardGrimoire.checked }));
  ui.forwardRumble.addEventListener("change", () => send({ cmd: "setForward", target: "rumble", on: ui.forwardRumble.checked }));
  ui.noticeClose.addEventListener("click", () => send({ cmd: "clearNotice" }));
  ui.clearLog.addEventListener("click", () => send({ cmd: "clearLog" }));

  view.onState(render);
}

async function main(): Promise<void> {
  const inObr = OBR.isAvailable;
  if (inObr) {
    await new Promise<void>((resolve) => OBR.onReady(resolve));
    followTheme();
  }

  const bus = openBus();
  const remote = bus ? await connectRemote(bus) : null;
  if (remote) {
    bind(remote);
    return;
  }

  console.warn("[DiceVision] No background page answered; running the connection in the popover");
  const controller = new Controller(inObr ? obrHost() : standaloneHost());
  bind(localView(controller));
  await controller.start();
}

main().catch((err) => {
  console.error("[DiceVision] Popover failed to start:", err);
  ui.statusText.textContent = "DiceVision failed to start. See the console.";
});
