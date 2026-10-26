# DiceVision — Owlbear Rodeo Extension

An [Owlbear Rodeo](https://owlbear.rodeo) extension for [DiceVision](https://github.com/wor101/dice-vision), an AI-powered physical dice recognition system. Roll real dice in front of a camera and the results show up in your Owlbear Rodeo room for the whole table.

> **Status:** early development (0.1.0). The code is complete for a first version but has not yet been tested in a live Owlbear Rodeo room, and the hosted manifest URL below is not live until the site is deployed.

## Requirements

- An Owlbear Rodeo account (the extension is added to your profile)
- A DiceVision account at [dicevision.dirtyowlbear.com](https://dicevision.dirtyowlbear.com)

## Installation

1. In Owlbear Rodeo, open your **profile** → **Add Extension**.
2. Paste the manifest URL:
   ```
   https://rodeo.dirtyowlbear.com/manifest.json
   ```
3. Enable **DiceVision** for a room (when creating it, or from the room's extension menu). Everyone in the room then gets the extension; each player with physical dice connects their own DiceVision session.

## Setup

1. Go to [dicevision.dirtyowlbear.com](https://dicevision.dirtyowlbear.com), point a camera (or your phone) at your dice, and create a session in the dashboard's **VTT Bridge** panel (or under Settings). The bridge sends rolls to whatever connects with the code, so there is nothing to pick.
2. Copy the 8-character session code (e.g. `XKRM-4N7B`; the dash is optional).
3. In your Owlbear Rodeo room, click the **DiceVision** button in the top-left bar and paste the code. **Connect automatically** (on by default) reconnects you the next time you open the room in this browser.

## Rolling

| Control | What it does |
|---------|--------------|
| **Roll once** | Asks DiceVision for your next physical roll. The DiceVision dashboard switches to continuous capture until the roll arrives; click again to cancel. |
| **Continuous** | Every roll the camera reads is sent, until you turn it off. |
| **Share rolls with** | **Everyone**, **GM only**, or **Only me**. |

Each roll goes into the popover's **Recent rolls** (faces as printed: `00`, pips as their count, DiceVision game labels such as "Critical!" or "Dragon!"), is shared with the room according to your choice, and is announced to the other players as a notification. The DiceVision button shows your latest total as a badge. Other players' rolls appear in your log and as notifications whether or not you have the popover open.

- **A die the camera couldn't read** keeps the roll private: the popover names the die ("Couldn't read 1d8") and keeps waiting. Roll it again.
- **No dice seen:** after Roll once, one notification; in continuous mode nothing (every empty capture would otherwise notify).
- **GM only** is applied by each receiving client, as with every Owlbear Rodeo dice extension: it hides rolls from players, it doesn't encrypt them.

## What it does not do

- Roll virtual dice, or replace the rolls of other dice extensions. Owlbear Rodeo has no roll request to intercept, so there is nothing like the Foundry module's Replace mode.
- Keep your settings in every browser. The extension runs in an iframe inside Owlbear Rodeo; private windows and some browsers don't let it store anything, and it says so in the popover. Everything works, you just paste the code again.

## Development

```bash
npm ci
npm run dev        # http://localhost:5173
npm test           # unit tests (Vitest, Node)
npm run lint       # ESLint + typecheck
npm run build      # dist/
```

To try a local build in Owlbear Rodeo, add `http://localhost:5173/manifest.json` as an extension to your profile (the SDK tutorials do the same). See `CLAUDE.md` for the architecture and the protocol.

## Hosting

The built site (`dist/`) is served by the DiceVision droplet at `https://rodeo.dirtyowlbear.com` (nginx vhost `nginx/rodeo.conf` in the [dice-vision](https://github.com/wor101/dice-vision) repo, web root `/var/www/rodeo`). That host sends `Content-Security-Policy: frame-ancestors` for the Owlbear Rodeo origins instead of the main site's `X-Frame-Options`, and `Access-Control-Allow-Origin: *` so Owlbear Rodeo can fetch the manifest.

`scripts/deploy.sh` builds and rsyncs `dist/` there (`DEPLOY_TARGET=user@host:/var/www/rodeo` to override the destination); `.github/workflows/deploy.yml` does the same on every push to `main` when the `DEPLOY_TARGET`, `DEPLOY_SSH_KEY` and `DEPLOY_KNOWN_HOSTS` secrets are set. The manifest, popover and background page use site-relative paths, so the site works at any host. Droplet setup (DNS, certificate, vhost) is in the dice-vision repo's `docs/backend/DEPLOYMENT.md`.

## Related

- [DiceVision](https://github.com/wor101/dice-vision) — the dashboard and backend
- [Talespire symbiote](https://github.com/wor101/dicevision-talespire), [Foundry VTT module](https://github.com/wor101/dicevision-foundry), [MCDM Codex mod](https://github.com/wor101/MCDM_Codex) — the other integrations, same bridge

## License

MIT
