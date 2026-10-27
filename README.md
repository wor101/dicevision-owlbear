# DiceVision — Owlbear Rodeo Extension

An [Owlbear Rodeo](https://owlbear.rodeo) extension for [DiceVision](https://github.com/wor101/dice-vision), an AI-powered physical dice recognition system. Roll real dice in front of a camera and the results show up in your Owlbear Rodeo room for the whole table.

> **Status:** 0.3.2, live at `rodeo.dirtyowlbear.com` and used in live rooms since 0.1.1 (Chrome and Firefox, desktop and phone). 0.2.x added optional forwarding of rolls into Game Master's Grimoire and Rumble!, checked in a room with both; 0.3.x adds 3D dice through dddice, checked in a room on 0.3.0 and 0.3.1 (0.3.1 fixed the percentile tens die; 0.3.2 sends its 00 face the way dddice does, still to be seen in a room).

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
| **Also send to** | Off by default. **Game Master's Grimoire** puts each roll in that extension's roll log; **Rumble! chat** posts it as a chat line; **dddice 3D dice** rolls the same faces as 3D dice for the whole room (Everyone rolls only). Grimoire and Rumble! do nothing unless the room has them; dddice says so when it isn't set up. |

Each roll goes into the popover's **Recent rolls** (faces as printed: `00`, pips as their count, DiceVision game labels such as "Critical!" or "Dragon!"), is shared with the room according to your choice, and is announced to the other players as a notification. The DiceVision button shows your latest total as a badge. Other players' rolls appear in your log and as notifications whether or not you have the popover open.

- **A die the camera couldn't read** keeps the roll private: the popover names the die ("Couldn't read 1d8") and keeps waiting. Roll it again.
- **No dice seen:** after Roll once, one notification; in continuous mode nothing (every empty capture would otherwise notify).
- **GM only** is applied by each receiving client, as with every Owlbear Rodeo dice extension: it hides rolls from players, it doesn't encrypt them.

## Other extensions

Owlbear Rodeo has no roll log, chat or result-taking dice of its own, so groups often use [Game Master's Grimoire](https://extensions.owlbear.rodeo/hp-tracker) (HP tracker with a roll log), [Rumble!](https://extensions.owlbear.rodeo/rumble) (chat) or [dddice](https://extensions.owlbear.rodeo/dddice) (3D dice). With **Also send to** turned on, each physical roll also lands there, next to the table's virtual rolls, the way the Pixels Dice extension does it:

| Extension | How the roll arrives | Everyone | GM only | Only me |
|-----------|----------------------|----------|---------|---------|
| Game Master's Grimoire | Its roll-event broadcast, labelled **DiceVision** (game labels become **DiceVision: Critical!**), equation `1d20+2d6`, faces and total | Every client's log | Its whisper channel: the GM's log and yours | Your log only |
| Rumble! | A chat line from **DiceVision**: `Will rolled 1d20 (17) + 2d6 (4, 3) = 24` (with ` · Critical!` appended for game labels). Rumble! shows such a line only on the client that wrote it, so every client that shows your roll writes its own copy | Everyone's chat | The GM's chat and yours, as a private line | Your chat, as a private line |
| dddice | Its roll API, with each die's value preset (the physical face), as your dddice user, in the dddice room this Owlbear room is linked to | 3D dice for everyone in the dddice room | Not sent | Not sent |

**3D dice.** Owlbear Rodeo's own Dice extension can't be handed a result (it simulates a throw and reads the face off the mesh), but [dddice](https://extensions.owlbear.rodeo/dddice) can: its API takes a predetermined value per die, and its extension shows every roll of the connected dddice room to everyone. There is nothing to configure on our side: when the dddice extension is set up in the room it records its room and each player's own key in the room, and we use yours. Turn on **dddice 3D dice**; the panel under it says whether the room and your key were found, and lets you pick a dddice theme (a theme slug; `dddice-bees`, dddice's own example, is the default; a slug dddice doesn't know is reported as a failed roll with dddice's message). Each player who wants their physical rolls in 3D opens the dddice extension once, signed in or as a guest, so it stores their key, and turns the toggle on. Everyone rolls only. The percentile tens die (a d10 showing a two-digit face) is sent as dddice's `d10x` with its face written the way dddice writes it ("0" for 00), a plain d10's 0 is sent as dddice's 10 (which dddice shows as 10, as it does its own), and an icon face is sent with the icon's name as its display value.

Grimoire and Rumble! don't publish these shapes; they come from their source, from the Pixels Dice extension and from trying them in a room (`src/forward.ts`). dddice's roll API is documented (`src/dddice.ts` records the parts we use) and was tried in a room on 0.3.0 and 0.3.1; 0.3.2's change to the 00 face's display hasn't been yet. If one of them changes its format, turn the toggle off and [open an issue](https://github.com/wor101/dicevision-owlbear/issues). A roll the camera couldn't fully read is never forwarded. The Rumble! line for someone else's roll follows *their* toggle, not yours: it is their roll, written into your chat on their behalf. Players still on 0.2.0 don't write Rumble! lines for other people's rolls.

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

`scripts/deploy.sh` builds and rsyncs `dist/` there (`DEPLOY_TARGET=user@host:/var/www/rodeo` to override the destination); `.github/workflows/deploy.yml` does the same on every push to `main` with the `DEPLOY_TARGET`, `DEPLOY_SSH_KEY` and `DEPLOY_KNOWN_HOSTS` secrets. Its key is restricted on the droplet to rsync within the web root (`rrsync`), so the workflow's target is `root@rodeo.dirtyowlbear.com:/`, which maps to `/var/www/rodeo`. The manifest, popover and background page use site-relative paths, so the site works at any host. Droplet setup (DNS, certificate, vhost) is in the dice-vision repo's `docs/backend/DEPLOYMENT.md`.

## Related

- [DiceVision](https://github.com/wor101/dice-vision) — the dashboard and backend
- [Talespire symbiote](https://github.com/wor101/dicevision-talespire), [Foundry VTT module](https://github.com/wor101/dicevision-foundry), [MCDM Codex mod](https://github.com/wor101/MCDM_Codex) — the other integrations, same bridge

## License

MIT
