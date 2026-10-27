---
title: DiceVision
description: Roll real dice on camera and see the results in Owlbear Rodeo
author: DirtyOwlbear Studios
image: https://rodeo.dirtyowlbear.com/store-header.png
icon: https://rodeo.dirtyowlbear.com/icon.png
tags:
  - dice
manifest: https://rodeo.dirtyowlbear.com/manifest.json
learn-more: https://dicevision.dirtyowlbear.com
---

# DiceVision

Roll your real dice in front of a camera and the results show up in Owlbear Rodeo for the whole table.

[DiceVision](https://dicevision.dirtyowlbear.com) reads physical dice with computer vision. This extension connects a DiceVision session to your room: when you roll, everyone with the extension sees what you rolled, as a notification and in the extension's roll log.

**Setup**

1. Sign in at [dicevision.dirtyowlbear.com](https://dicevision.dirtyowlbear.com), point a camera (or your phone) at your dice, and create a session in the dashboard's **VTT Bridge** panel. The bridge sends rolls to whatever connects with the code.
2. In Owlbear Rodeo, open the DiceVision action in the top-left bar and paste the 8-character session code.
3. Press **Roll once** and roll, or turn on **Continuous** to send every roll. After that, the owlbear button in Owlbear's top toolbar rolls once without opening the panel.

**Sharing**

Choose who sees your rolls: **Everyone**, **GM only**, or **Only me**. Rolls are shared with the clients in your room that have the extension enabled. As with every Owlbear Rodeo dice extension, "GM only" is applied by each receiving client.

**Other extensions**

Turn on **Also send to** and each roll also goes to Game Master's Grimoire's roll log, Rumble!'s chat and/or dddice (as 3D dice landing on the faces you rolled; Everyone rolls only), if your room has them. GM only and Only me rolls stay private in Grimoire and Rumble! too.

**What it reads**

d4, d6 (numbers and pips), d8, d10 (including percentile tens), d12, d20 and d100. Faces are shown as printed, and game labels from DiceVision ("Critical!", "Dragon!") come along with the roll. A roll the camera couldn't fully read stays in your own log and is not shared; roll again.

**Notes**

- The extension does not roll virtual dice and does not replace Owlbear Rodeo's own dice extensions.
- Your session code is kept in this browser only. Some browsers (private windows, Safari with strict settings) don't keep it; you'll paste it again next time.
- Support: [GitHub issues](https://github.com/wor101/dicevision-owlbear/issues).
