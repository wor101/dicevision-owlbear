# DiceVision Owlbear Rodeo Extension - Development Guide

## Overview

An Owlbear Rodeo (OBR) extension that connects to DiceVision's WebSocket bridge and shows physical dice rolls to the room. OBR has no dice, chat or roll API of its own, so the extension displays rolls itself (its own roll log, OBR notifications, the action badge) and shares them with the other clients over `OBR.broadcast`. There is no roll to intercept (nothing like the Foundry module's Replace mode).

**Status:** 0.1.0, code complete for a first version, **not yet run in a live room**. The design and the open questions are in the main repo: `wor101/dice-vision` → `docs/planning/OWLBEAR_RODEO_INTEGRATION.md` (§9 lists the spike to run first; §6 is what this code implements).

## Architecture

```
DiceVision Camera → Backend → WebSocket Bridge → background.html (Controller) → own log + OBR.broadcast → every client's background page
                              /api/bridge/{code}        ↕ BroadcastChannel                               → OBR.notification, log
                                                   action.html (popover UI)
```

- **`background.html`** (`src/background.ts`): OBR loads it hidden for the whole room visit, on every client with the extension enabled. It runs the `Controller`, which owns the bridge client, the waiting logic, the roll log, sharing and notifications, and serves it to the popover over a `BroadcastChannel` (`src/local-bus.ts`). Rolls shared by other players reach this page even if the popover is never opened.
- **`action.html`** (`src/action.ts`): the popover behind the DiceVision button in OBR's top-left bar. UI only: session code, Connect, Roll once, Continuous, Share rolls with (Everyone / GM only / Only me), Connect automatically, notice line, Recent rolls. It asks the background page for its state (`hello`) and, if nothing answers within 1.5 s, runs its own `Controller` (local dev of the page alone, or a host that didn't load the background page).
- **`src/controller.ts`**: the brain. `Command`s in, `ControllerState` out (every change). Talks to OBR through the `Host` interface (`src/host.ts`: `obrHost()` for the SDK, `standaloneHost()` outside OBR, a recording fake in tests).
- **Pure modules** (tested in Node, no OBR, no DOM): `src/dice.ts` (read a roll, display faces, describe it), `src/bridge-client.ts` (WebSocket state machine, injectable socket), `src/share.ts` (broadcast payload, parsing, visibility rule), `src/settings.ts` (best-effort `localStorage`), `src/session-code.ts`.
- **`src/theme.ts`**: maps `OBR.theme` onto the CSS variables `src/action.css` uses; `prefers-color-scheme` defaults outside OBR.

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
- A roll with an unreadable die (`readable: false`) or no dice is logged locally as not shared (`note`), the notice says which die ("Couldn't read 1d8. Roll again. Still waiting."), and we keep waiting.
- `no_dice`: one notification per Roll once (`noDiceShown`), nothing in continuous mode, nothing when another app asked (we aren't registered).
- `cancelled` (another app, or another client on a shared code) re-arms us if a roll is still wanted.
- Reconnect: 2, 4, 8, 16, 30 s, then `gave-up` (notice + notification). A confirmed session resets the count.

## Owlbear Rodeo API Used

| API | Use |
|-----|-----|
| `OBR.onReady`, `OBR.isAvailable` | Start; `isAvailable` false means a plain browser tab (standalone host) |
| `OBR.player.id/getName/getColor/getRole/onChange` | Who's rolling; role decides whether a GM-only roll is shown |
| `OBR.broadcast.sendMessage(channel, data, {destination: "REMOTE"})` / `onMessage` | Share rolls on `com.dirtyowlbear.dicevision/roll` (≤16 KB; a roll is a few hundred bytes). REMOTE, so our own roll (already logged) never echoes back; a message from our own `playerId` is ignored anyway |
| `OBR.notification.show(msg, variant)` | Connected (SUCCESS), invalid session (ERROR), lost connection (WARNING), other players' rolls (INFO), and our own roll / unreadable die / no dice only while the popover is closed (`OBR.action.isOpen()`) |
| `OBR.action.setBadgeText` | Our latest total; cleared on disconnect |
| `OBR.theme.getTheme/onChange` | Popover colours in both modes |

Metadata/broadcast keys are namespaced `com.dirtyowlbear.dicevision/...`. Nothing is written to room or player metadata (a session code is per player and room metadata is shared and limited to 16 kB).

## Local Bus (popover ↔ background page)

`BroadcastChannel("com.dirtyowlbear.dicevision/local")`, same-origin iframes in the same OBR tab.

- Popover → background: `{ kind: "cmd", command }` with `command.cmd` one of `hello | connect {code} | disconnect | rollOnce | cancelRollOnce | setContinuous {on} | setVisibility {visibility} | setAutoConnect {on} | clearLog | clearNotice`.
- Background → popover: `{ kind: "state", state: ControllerState }` after every change and on `hello`.
- `connectRemote()` resolves null when no state arrives within 1.5 s; the popover then runs a local `Controller`. If OBR turns out to load the background page lazily (spike §9.1), two controllers could briefly coexist; the state still comes from whichever answers. Revisit after the spike.

## Settings

`localStorage["com.dirtyowlbear.dicevision/settings"]` = `{ sessionCode, autoConnect, continuous, visibility }`, read and written through `src/settings.ts` with try/catch everywhere (`availableStorage()` probes with a write). Third-party-iframe storage can be partitioned, empty or throwing (Safari, private windows, cookies blocked); `ControllerState.storage` is false then and the popover says settings won't be kept. OBR's verification checklist requires the extension to *work* with storage blocked.

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

Vitest in Node (`tests/`): `dice`, `session-code`/`bridge-client` (fake socket, fake timers: ping, backoff, 4001, give-up), `share` (round trip, rejection, visibility), `settings`, `controller` (recording Host and fake socket: Roll once / continuous / cancel / unreadable / no_dice / sharing / incoming rolls / log cap / commands), `manifest` (field limits, referenced files exist, version matches `package.json`, store.md front matter).

Not covered by unit tests, check in a room (design doc §9): background page lifecycle, BroadcastChannel reach between the two iframes, `OBR.broadcast` reach to clients that never opened the popover, storage in Safari/private windows, the popover at phone width, both themes.

## CI, Deploy and Branch Rules

- **Tests** workflow on every PR and push to `main`: `lint` (ESLint + typecheck) and `test` (Vitest, build, check `dist/` has what the manifest points at). Make both required checks in a "Main" ruleset like the Talespire and Foundry repos (PR + 1 approval, no force-push; admins bypass).
- **Deploy** workflow on push to `main`: build → `scripts/deploy.sh --no-build`, which rsyncs `dist/` to the DiceVision droplet. Secrets: `DEPLOY_TARGET` (`user@host:/var/www/rodeo`), `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`; without `DEPLOY_TARGET` the workflow builds and stops. By hand: `scripts/deploy.sh` (default target `root@rodeo.dirtyowlbear.com:/var/www/rodeo`; it checks the live manifest version afterwards).
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
| `frontend/app/components/new/VttQuickSettings.tsx` | The dashboard's bridge picker ("Owlbear Rodeo" option) |
