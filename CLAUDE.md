# DiceVision Owlbear Rodeo Extension - Development Guide

## Overview

An Owlbear Rodeo (OBR) extension that connects to DiceVision's WebSocket bridge and shows physical dice rolls to the room. OBR has no dice, chat or roll API of its own, so the extension displays rolls itself (its own roll log, OBR notifications, the action badge) and shares them with the other clients over `OBR.broadcast`. There is no roll to intercept (nothing like the Foundry module's Replace mode).

**Status:** 0.4.0. Live at `https://rodeo.dirtyowlbear.com`; the design doc's spike (§9) passed in live rooms on 0.1.x (Chrome + Firefox, desktop + phone, both themes, second player via incognito). 0.2.x adds Phase 2, forwarding to Game Master's Grimoire and Rumble! (`src/forward.ts`), checked in a room with both (0.2.0 found that Rumble! lines are per client; 0.2.1 fixed it). 0.3.x adds 3D dice through dddice (`src/dddice.ts`), checked in a room 2026-10-26 (d20s and an icon face land right for GM and players; 0.3.0 sent the percentile tens die as a plain d10, "cannot roll value 80", fixed in 0.3.1; 0.3.2 fixed the roll text for the 00 face ("0"); 0.3.3 sends the tens die's value as its face label so the 3D die lands on 00, confirmed in a room). 0.4.0 adds the toolbar roll button (`src/roll-button.ts`) and folds the popover's settings behind a disclosure, **not yet seen in a room**. The design is in the main repo: `wor101/dice-vision` → `docs/planning/OWLBEAR_RODEO_INTEGRATION.md` (§6 is what this code implements; §10 the phases).

## Architecture

```
DiceVision Camera → Backend → WebSocket Bridge → background.html (Controller) → own log + OBR.broadcast → every client's background page
                              /api/bridge/{code}        ↕ BroadcastChannel                               → OBR.notification, log
                                                   action.html (popover UI)
```

- **`background.html`** (`src/background.ts`): OBR loads it hidden for the whole room visit, on every client with the extension enabled. It runs the `Controller`, which owns the bridge client, the waiting logic, the roll log, sharing and notifications, and serves it to the popover over a `BroadcastChannel` (`src/local-bus.ts`). Rolls shared by other players reach this page even if the popover is never opened.
- **`action.html`** (`src/action.ts`): the popover behind the DiceVision button in OBR's top-left bar. UI only, opening short: status, Roll once, Continuous, notice line, Recent rolls, and a **Settings** disclosure (`<details>`, open until a session is connecting/connected, a one-line summary while folded) holding the session code, Connect, Connect automatically, Share rolls with (Everyone / GM only / Only me) and Also send to (Game Master's Grimoire / Rumble! chat / dddice 3D dice, with a status line and theme field under it). `fitHeight()` sizes the popover to its content with `OBR.action.setHeight` (260–640 px; the manifest's 380 is the first paint). It asks the background page for its state (`hello`) and, if nothing answers within 1.5 s, runs its own `Controller` (local dev of the page alone, or a host that didn't load the background page).
- **`src/controller.ts`**: the brain. `Command`s in, `ControllerState` out (every change). Talks to OBR through the `Host` interface (`src/host.ts`: `obrHost()` for the SDK, `standaloneHost()` outside OBR, a recording fake in tests).
- **Pure modules** (tested in Node, no OBR, no DOM): `src/dice.ts` (read a roll, display faces, describe it), `src/bridge-client.ts` (WebSocket state machine, injectable socket), `src/share.ts` (broadcast payload, parsing, visibility rule), `src/forward.ts` (the roll as a Game Master's Grimoire log entry and as a Rumble! chat line), `src/dddice.ts` (the dddice setup read from room metadata, the roll as a dddice API request, the fetch wrapper), `src/settings.ts` (best-effort `localStorage`), `src/session-code.ts`.
- **`src/theme.ts`**: maps `OBR.theme` onto the CSS variables `src/action.css` uses; `prefers-color-scheme` defaults outside OBR.
- **`src/roll-button.ts`**: the one-click roll button in OBR's tool action bar (`OBR.tool.createAction`, no filter, so it shows with every tool). A pure spec from the state: idle → the owlbear face, "roll once"; waiting → the startled face, "click to cancel"; disconnected or continuous → opens the popover. The background page's controller (`rollButton: true`) registers it in `emit()` and re-creates it when the spec changes (a tool action's icon can't be swapped in place); the popover's fallback controller never does. Icons: `public/icons/roll.svg`, `roll-waiting.svg` (the design system's OwlbearFaces, 24 px, `fill="currentColor"`; a d20 with the face inside would put the face under its 16 px minimum at toolbar size).

## Project Structure

```
dicevision-owlbear/
├── public/
│   ├── manifest.json         # OBR manifest (action popover, background_url, clipboard-read)
│   ├── store.md              # Store listing (owlbear-rodeo/extensions PR points at the hosted copy)
│   ├── icon.svg              # Action icon (currentColor strokes)
│   └── icon.png              # Manifest / store icon (rendered from the same geometry)
├── action.html, background.html   # Vite entry pages
├── src/
│   ├── action.ts, action.css # Popover UI
│   ├── background.ts         # Background page entry
│   ├── controller.ts         # Waiting logic, roll log, sharing, notifications
│   ├── host.ts               # OBR calls behind an interface
│   ├── local-bus.ts          # BroadcastChannel between popover and background page
│   ├── bridge-client.ts      # WebSocket client
│   ├── dice.ts               # Read a DiceVision roll
│   ├── share.ts              # Party broadcast payload + visibility
│   ├── forward.ts            # Grimoire roll-event + Rumble! chat line (opt-in)
│   ├── dddice.ts             # dddice 3D dice: room setup from metadata + roll API request (opt-in)
│   ├── settings.ts           # localStorage settings (best-effort)
│   ├── session-code.ts       # Normalize / format XKRM-4N7B
│   └── theme.ts              # OBR theme → CSS variables
├── tests/*.test.ts           # Vitest, Node environment
├── .github/workflows/tests.yml   # lint + typecheck, test + build (required checks)
├── .github/workflows/deploy.yml  # main → rsync dist/ to the droplet
├── scripts/deploy.sh             # the same by hand: build + rsync + live-version check
├── .github/dependabot.yml        # weekly npm + Actions, 7-day cooldown
├── vite.config.ts, tsconfig.json, eslint.config.js, package.json
├── README.md, CLAUDE.md, LICENSE (MIT)
```

## Reference Links

| Resource | URL |
|----------|-----|
| OBR developer docs (bot check; read via a text proxy if needed) | https://docs.owlbear.rodeo/extensions/getting-started |
| Manifest reference | https://docs.owlbear.rodeo/extensions/reference/manifest |
| SDK (`@owlbear-rodeo/sdk`, MIT) | https://www.npmjs.com/package/@owlbear-rodeo/sdk |
| SDK tutorials | https://github.com/owlbear-rodeo/sdk-tutorials |
| First-party Dice extension (GPLv3; background page + popover pattern) | https://github.com/owlbear-rodeo/dice |
| Extension store repo (listing PR) | https://github.com/owlbear-rodeo/extensions |
| Pixels Dice extension (prior art for physical dice → OBR) | https://extensions.owlbear.rodeo/pixels-dice |
| DiceVision bridge | `wss://dicevision.dirtyowlbear.com/api/bridge/{session_code}` |

## WebSocket Protocol

Same bridge as the Talespire symbiote and the Foundry module (`wor101/dice-vision` → `docs/integrations/VTT.md`, `backend/app/routers/bridge.py`).

```
wss://dicevision.dirtyowlbear.com/api/bridge/{session_code}
```

Session codes: 8 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, shown as `XKRM-4N7B`, normalized to `XKRM4N7B` (`src/session-code.ts`).

**Server → client**

```javascript
{ "type": "connected", "session_code": "XKRM4N7B", "waiting": false, "waiting_apps": [] }
{ "type": "roll", "session_code": "...", "timestamp": "...", "data": {
    "dice": [
      {"type": "d20", "value": 15, "face": "15", "readable": true, "icon": null},
      {"type": "d6",  "value": 4,  "face": "pip_4", "readable": true, "icon": null},
      {"type": "d8",  "value": -1, "face": "-1", "readable": false, "icon": null}
    ],
    "total": 19, "roll_id": "uuid",
    "game": { "profile_id": "d20_rpg", "status": "applied", "tags": [{"die_index": 0, "tone": "good", "label": "Critical!", "rule": 0}], "verdict": null }
} }
{ "type": "waiting", "app": "owlbear" }       // some app registered
{ "type": "cancelled", "app": "foundry" }     // some app's cancel: the dashboard's waiting state is cleared for everyone
{ "type": "no_dice" }                          // the camera saw nothing while an app was waiting; waiting state unchanged
{ "type": "pong" }
{ "type": "error", "message": "..." }
```

Close code `4001` = invalid or expired session: stop, don't reconnect. The server accepts an invalid code before closing it, so the session counts as live only after `connected`.

**Client → server**

```javascript
{ "type": "waiting", "app_id": "owlbear" }
{ "type": "cancel", "app_id": "owlbear" }
{ "type": "ping" }                             // every 30 s
```

**Rules the Controller follows** (the Talespire/Foundry rules):

- A roll is *wanted* in continuous mode, or after Roll once until a usable roll arrives. `syncWaiting()` registers when wanted and not registered, cancels when registered and not wanted.
- The dashboard forwards a roll only while it believes an app is waiting and drops that flag with each roll, so after **every** roll: re-send `waiting` if still wanted, else `cancel` if registered (a reloaded dashboard shouldn't find us waiting). Any `cancel` clears the dashboard's waiting state for all apps on the session: give each app its own session code.
- A roll with an unreadable die (`readable: false`) or no dice is logged locally as not shared (`note`; the same field later carries a delivery failure), the notice says which die ("Couldn't read 1d8. Roll again. Still waiting."), and we keep waiting.
- `no_dice`: one notification per Roll once (`noDiceShown`), nothing in continuous mode, nothing when another app asked (we aren't registered).
- `cancelled` (another app, or another client on a shared code) re-arms us if a roll is still wanted.
- Reconnect: 2, 4, 8, 16, 30 s, then `gave-up` (notice + notification). A confirmed session resets the count.
- **Forwarding** (`settings.forward`, all off by default): a usable roll of *ours* is also sent to Game Master's Grimoire and/or Rumble! after it is shared. Grimoire gets one broadcast from the roller (never re-sent by receivers). Rumble! shows a metadata line only on the client that wrote it, so the shared roll carries the roller's `rumble` choice and every client that shows the roll writes the line into its own Rumble! chat (`writeRumbleLine()`). dddice gets an Everyone roll of ours as an API call with the faces preset (`rollInDddice()`); GM only / Only me rolls are not sent there (the popover hint says so). Unusable rolls are never forwarded.
- **Delivery failures** (the room share, Grimoire, Rumble!, dddice) all go through `deliveryFailed()`: a `warn` notice ("Rolled, but sending it to the room and Rumble! failed."), the same text as the log entry's `note` (which outlives the notice), and a WARNING notification while the popover is closed. The roll, badge and waiting logic are unaffected. For another player's roll (only its Rumble! line can fail here) the entry gets the note and the closed-popover notification, but the notice is left alone (it may be ours). A private (GM only / Only me) roll with no player id (`getPlayer()` failed at start) is reported as failed rather than misaddressed, with the reason appended ("Your Owlbear Rodeo player couldn't be read; reload the room.").

## Forwarding to other extensions (Phase 2)

Grimoire and Rumble! have no published API; the shapes in `src/forward.ts` were read from their source and from the Pixels Dice extension's bundle (2026-10-26), so a format change on their side breaks silently. dddice's API is documented (OpenAPI spec, SDK docs); only its Owlbear room-metadata keys are undocumented, and `readDddiceSetup()` warns (shape only, never a value) if they stop being strings. Test in a room with the extension enabled.

| Extension | Mechanism | Visibility mapping |
|-----------|-----------|--------------------|
| **Game Master's Grimoire** ([kamejosh/owlbear-hp-tracker](https://github.com/kamejosh/owlbear-hp-tracker)) | `OBR.broadcast.sendMessage("com.bitperfect-software.hp-tracker.roll-event", entry)`; its background page adds the message to its roll log as is, and pops its roll log open for a few seconds on each client that adds it (the fields of its `RollLogEntryType` we fill: `uuid, created_at, equation, label, is_hidden, total_value (a string; Grimoire also allows an array), username, values (string[]), owlbear_user_id, participantUsername`; dedup by `uuid`, we use DiceVision's `roll_id`). Grimoire broadcasts REMOTE and adds its own entry locally; we have no entry there, so we send **ALL** and each client's Grimoire adds it once. | Everyone → roll channel, ALL. GM only → `...roll-event-whisper`, ALL (Grimoire shows it when `owlbear_user_id` is the viewer or the viewer is GM). Only me → whisper channel, LOCAL. |
| **Rumble!** (Battle-System, closed source; shape from its store page and two other senders) | `OBR.player.setMetadata({"com.battle-system.friends/metadata_chatlog": {chatlog, created, sender: "DiceVision", targetId}})`. **Shown only on the client that writes it** (room check 2026-10-26: the roller saw the line, nobody else did), so it is written on the roller's client *and* on every client that shows the shared roll (`SharedRoll.rumble`), exactly what Pixels Dice does. `targetId` picks Rumble!'s header only. | Everyone → every client that shows the roll writes it with `targetId: "0000"`. GM only → GM clients and the roller write it with their own player id (a private line). Only me → the roller's client only. |
| **dddice** (closed source; API from its OpenAPI spec + SDK docs) | `POST https://dddice.com/api/1.0/roll` with `Authorization: Bearer <key>` and `{dice: [{type, theme, value, value_to_display?, label?}], room, label}`; the roll shows as 3D dice on every client in that dddice room. The dddice Owlbear extension writes `com.dddice/roomSlug` and `com.dddice/<player id>` (that player's API key) to **Owlbear room metadata** (read from its bundle `Owlbear-*.js`; Grimoire reads the same), so there is nothing to configure: `Controller.readRoom()` picks both up (`ControllerState.dddice = {room, hasKey, roomRead}`, the key stays private; `roomRead` false = the start-time read failed, which is a notice, and a roll then says to reload rather than to set dddice up). The room listener is subscribed before the first read. A roll needs our player id (the key is filed under it); without one the failure says so. Network failures are reported as "Couldn't reach dddice.com"; a refusal carries dddice's message (incl. Laravel validation errors). Percentile tens die (DiceVision sends it as a `d10` with a two-digit face, "00"/"10"…"90": `TENS_FACE`) → `d10x` with `value` = the face label (0 for "00", 10 … 90; the API validates it against the theme's face list and the 3D die lands on it: 0.3.2's value 10, the SDK's in-process 1-10 index convention, landed on the "10" face) and `value_to_display` the same ("0", "10" … "90", as dddice writes it; 0.3.1's "00" read as 10 in the text); d10 "0" → value 10 with no display override (dddice shows it as 10, its own convention); icon faces show the icon label. Theme = `settings.dddiceTheme` (default `dddice-bees`). CORS allows our origin. | Everyone → sent. GM only / Only me → not sent. |

Pixels Dice does the same two writes on every client that receives its broadcast (Grimoire with destination LOCAL); we forward to Grimoire from the roller's client only (one ALL broadcast) and to Rumble! on every client that shows the roll, as Pixels does. Not done: the Initiative Tracker (Pixels writes a d20 to a token the roller owns that has no initiative yet, `rodeo.owlbear.initiative-tracker/metadata` `{active, count}`), design doc §6.6.

## Owlbear Rodeo API Used

| API | Use |
|-----|-----|
| `OBR.onReady`, `OBR.isAvailable` | Start; `isAvailable` false means a plain browser tab (standalone host) |
| `OBR.player.id/getName/getColor/getRole/onChange` | Who's rolling; role decides whether a GM-only roll is shown |
| `OBR.broadcast.sendMessage(channel, data, {destination})` / `onMessage` | Share rolls on `com.dirtyowlbear.dicevision/roll` (≤16 KB; a roll is a few hundred bytes) with REMOTE, so our own roll (already logged) never echoes back; a message from our own `playerId` is ignored anyway. Forwarding sends on Grimoire's channels with ALL or LOCAL (`Host.broadcast` takes the destination explicitly; sharing passes REMOTE) |
| `OBR.room.getMetadata/onMetadataChange` | Read only: the dddice extension's room slug and our API key |
| `OBR.player.setMetadata` | Only for Rumble! forwarding: the chat line goes into the metadata of the player whose client wrote it, the roller's and every client that shows the shared roll |
| `OBR.notification.show(msg, variant)` | Connected (SUCCESS), invalid session (ERROR), lost connection (WARNING), other players' rolls (INFO), and our own roll / unreadable die / no dice / a delivery failure (WARNING) only while the popover is closed (`OBR.action.isOpen()`) |
| `OBR.action.setBadgeText`, `setHeight`, `open` | Our latest total (cleared on disconnect); the popover's height follows its content; the toolbar button opens the popover when there is nothing to trigger |
| `OBR.tool.createAction/removeAction` | The toolbar roll button (`src/roll-button.ts`), background page only |
| `OBR.theme.getTheme/onChange` | Popover colours in both modes |

Our own metadata/broadcast keys are namespaced `com.dirtyowlbear.dicevision/...`. Nothing of ours is written to room or player metadata (a session code is per player and room metadata is shared and limited to 16 kB); the only metadata write is Rumble!'s key, on any client that shows a roll whose roller turned Rumble! on (`SharedRoll.rumble`), whatever that client's own toggle says.

## Local Bus (popover ↔ background page)

`BroadcastChannel("com.dirtyowlbear.dicevision/local")`, same-origin iframes in the same OBR tab.

- Popover → background: `{ kind: "cmd", command }` with `command.cmd` one of `hello | connect {code} | disconnect | rollOnce | cancelRollOnce | setContinuous {on} | setVisibility {visibility} | setAutoConnect {on} | setForward {target, on} | setDddiceTheme {theme} | clearLog | clearNotice`.
- Background → popover: `{ kind: "state", state: ControllerState }` after every change and on `hello`.
- `connectRemote()` resolves null when no state arrives within 1.5 s; the popover then runs a local `Controller`. If OBR turns out to load the background page lazily (spike §9.1), two controllers could briefly coexist; the state still comes from whichever answers. Revisit after the spike.

## Settings

`localStorage["com.dirtyowlbear.dicevision/settings"]` = `{ sessionCode, autoConnect, continuous, visibility, forward: {grimoire, rumble, dddice}, dddiceTheme }`, read and written through `src/settings.ts` with try/catch everywhere (`availableStorage()` probes with a write). Third-party-iframe storage can be partitioned, empty or throwing (Safari, private windows, cookies blocked); `ControllerState.storage` is false then and the popover says settings won't be kept. OBR's verification checklist requires the extension to *work* with storage blocked.

## Development Workflow

```bash
npm ci
npm run dev        # Vite on http://localhost:5173 (strict port; CORS on for OBR's cross-origin manifest fetch)
npm test           # vitest run
npm run lint       # eslint .
npm run typecheck  # tsc --noEmit
npm run build      # tsc --noEmit && vite build → dist/
```

- **In OBR:** add `http://localhost:5173/manifest.json` to your profile as an extension (as the SDK tutorials do), enable it in a test room, open the DiceVision action. Check both themes (OBR profile → theme), a phone-width window, and a private window.
- **Standalone:** open `http://localhost:5173/action.html` in a tab. `OBR.isAvailable` is false, so the popover runs its own Controller with `standaloneHost()`: the bridge works, nothing is shared or notified (console logs instead). Good for bridge testing against a real session code.
- **Local backend:** set `wsBaseUrl` on `BridgeClient` (Controller option `client: new BridgeClient({ wsBaseUrl: "ws://localhost:8000/api/bridge" })`) or edit `WS_BASE_URL` in `src/bridge-client.ts` temporarily.
- Logs use the `[DiceVision]` prefix; the popover and background page are separate iframes, so pick the right frame in dev tools.

## Testing

Vitest in Node (`tests/`): `dice`, `session-code`/`bridge-client` (fake socket, fake timers: ping, backoff, 4001, give-up), `share` (round trip, rejection, visibility), `forward` (Grimoire entry and channel/destination per visibility, Rumble! line and target), `dddice` (setup from room metadata, die mapping incl. d10x and icons, request body, fetch wrapper errors), `settings`, `roll-button` (spec per state; the icon files exist and follow the design system), `controller` (recording Host and fake socket: toolbar button registered by the background controller only, click → roll once / cancel / open popover, re-created on change, removed on stop; Roll once / continuous / cancel / unreadable / no_dice / sharing / forwarding on and off, failure notice / incoming rolls / log cap / commands), `manifest` (field limits, referenced files exist, version matches `package.json`, store.md front matter).

Not covered by unit tests, check in a room: the toolbar button (shows with every tool, click rolls, face changes while waiting, opens the popover when disconnected; pending as of 0.4.0), the folded popover's height on desktop and phone (pending as of 0.4.0); forwarding into Game Master's Grimoire and Rumble! (Everyone checked on 0.2.0/0.2.1 with a GM and a player; GM only / Only me not yet); dddice 3D dice: room/key discovery, the theme (left at `dddice-bees`, as far as known) and icon faces confirmed in a room on 0.3.0; 0.3.2 confirmed the roll text for a 00 + 9 pair ("0", "9", total 9) but the 3D tens die landed on "10"; 0.3.3 sends the face label as the value, to re-check (00 should land on the 00 face). Still to see: a plain d10's "0" face (sent as value 10 with no display; dddice should show 10). Checked in rooms on 0.1.x (design doc §9): background page lifecycle, BroadcastChannel reach between the two iframes, `OBR.broadcast` reach to clients that never opened the popover, the popover at phone width, both themes; storage in Safari/private windows not yet.

## CI, Deploy and Branch Rules

- **Tests** workflow on every PR and push to `main`: `lint` (ESLint + typecheck) and `test` (Vitest, build, check `dist/` has what the manifest points at). Make both required checks in a "Main" ruleset like the Talespire and Foundry repos (PR + 1 approval, no force-push; admins bypass).
- **Deploy** workflow on push to `main`: build → `scripts/deploy.sh --no-build`, which rsyncs `dist/` to the DiceVision droplet. Secrets: `DEPLOY_TARGET` (`root@rodeo.dirtyowlbear.com:/`: the deploy key's `authorized_keys` line is `command="/usr/bin/rrsync /var/www/rodeo",restrict`, so remote paths are relative to the web root and the key can do nothing but rsync there), `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`; without `DEPLOY_TARGET` the workflow builds and stops. The private key is `~/.ssh/dicevision-deploy` on Will's machine. By hand: `scripts/deploy.sh` (default target `root@rodeo.dirtyowlbear.com:/var/www/rodeo`; it checks the live manifest version afterwards).
- **Hosting:** `https://rodeo.dirtyowlbear.com`, an nginx vhost on the droplet tracked as `nginx/rodeo.conf` in the dice-vision repo (setup: its `docs/backend/DEPLOYMENT.md` → "Owlbear Rodeo extension"). It sends `Content-Security-Policy: frame-ancestors` for the Owlbear origins and `Access-Control-Allow-Origin: *`, no `X-Frame-Options`; `dicevision.dirtyowlbear.com` sends `X-Frame-Options: SAMEORIGIN`, which is why the extension has its own host. The subdomain is `rodeo`, not `owlbear`, so it doesn't read as part of the DirtyOwlbear name. Hashed `/assets/` are cached for a year, `manifest.json` / HTML / `store.md` are `no-cache`. nginx needs no reload per release.
- **Versioning:** bump `version` in both `package.json` and `public/manifest.json` (a test checks they match); OBR shows the manifest version. Tag `vX.Y.Z` on `main` for the record; deployment is per push, not per tag.
- **Dependabot:** weekly npm + Actions, 7-day cooldown. ESLint 10 and typescript-eslint 8 are in use here (no `eslint-plugin-react`, which is what blocks ESLint 10 in the main repo).

## Store Submission (Phase 3)

Host `public/store.md` (it ships in `dist/`), fork `owlbear-rodeo/extensions`, add `"dicevision": "https://rodeo.dirtyowlbear.com/store.md"` to `extensions.json` in a single-commit PR to `main`. Verification later: comment `/verify dicevision` on that PR and pass the checklist (both themes, mobile, Chrome/Firefox/Safari, works in private browsing, manifest on a domain we control, support contact, no companion extension required). `store.md` references `store-header.png`, rendered with the icon by a scratch script (regenerate if the branding changes).

## Key Files in the Main Repo

| File | Purpose |
|------|---------|
| `docs/planning/OWLBEAR_RODEO_INTEGRATION.md` | Investigation, design, spike list, phases |
| `docs/integrations/VTT.md` | Bridge protocol shared by every VTT app |
| `backend/app/routers/bridge.py`, `backend/app/services/bridge_manager.py` | The server side |
| `backend/app/services/vtt_payload.py` | The roll payload (`dice`, `total`, `roll_id`, `game`) |
| `frontend/app/components/new/VttQuickSettings.tsx` | The dashboard's VTT Bridge panel: sessions, the "How to connect" help (has an Owlbear Rodeo line) and the "<app> is waiting" footer; there is no app picker |
