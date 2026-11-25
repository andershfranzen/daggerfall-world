# 04: Legal and licences (Phase 0 research)

> **Not legal advice.** These are facts, primary sources and precedents for a lawyer or a careful maintainer to review. Sources were retrieved on 2026-11-24. **[UNVERIFIED]** marks a claim that rests only on secondary reporting or on my own knowledge. Where I couldn't read a primary page, I say so.

The project subsequently selected a browser client. Unity licensing is included here as background to the earlier client comparison. The code license and funding suggestions below are the researcher's proposals. Project-specific permission from Bethesda has not been established. See the [browser architecture decision](../browser-architecture.md).

---

## Summary

**Published licenses and relevant project precedents**
- **Building on Daggerfall Unity (DFU) code.** DFU is MIT-licensed. A fork or mod may be used, modified and redistributed, including commercially, provided we keep the copyright and permission notice. ([LICENSE](https://github.com/Interkarma/daggerfall-unity/blob/master/LICENSE))
- **Players supplying their own game data.** DFU, OpenMW, TES3MP and Skyblivion all use this model. Bethesda distributes Daggerfall free on Steam, so anyone can get the data legally. DFU has run this way for about 10 years with no known objection, and Bethesda approved GOG's commercial-platform bundle of DFU in 2022.
- **Using Unity Personal for a free project.** DFU's Unity version (2019.4) has no runtime fee or revenue share, and Unity Personal is free below US$200k of revenue and funding over 12 months.
- **Factual, nominative use of "Daggerfall"** in descriptions ("a multiplayer mod for Daggerfall Unity; requires The Elder Scrolls II: Daggerfall"), together with a clear "unofficial / not affiliated" disclaimer.

**Clearly not OK:**
- Redistributing any Bethesda data. That includes ARENA2 files, extracted textures, sounds and music, and pre-converted data on our servers or in our releases. No public licence for the free release could be found. Steam presents it as "All Rights Reserved".
- Using Bethesda's logos, or a name or branding that suggests an official product. ZeniMax actively enforces marks: "Scrolls" v. Mojang (2012) and "DoomRL" → "DRL" (2016).
- Paywalling anything: beta access, servers, tick-rate, cosmetics or priority. This was the core problem in the Skyrim Together 2019 episode. Microsoft's Game Content Usage Rules also forbid any compensation except optional donations, if those rules apply here at all.
- Pulling in code whose licence we can't honour. Skyrim Together's other 2019 problem was using SKSE code that its licence explicitly forbade them to use.

**Needs a lawyer (or written permission):**
1. **Whether any donations are acceptable.** This is the most important open question. The precedents point both ways: OpenMW and Skyblivion refuse donations, while TES3MP's developers and DFO Online take Patreon/Ko-fi without any reported response. Section 5 describes what "clearance" should mean.
2. **Whether "Daggerfall" may appear in the project name or domain.** Daggerfall is a registered ZeniMax mark. "Daggerfall Unity" has been tolerated. DFO Online renamed itself away from "Daggerfall Online".
3. **DFU's own repository contains Bethesda-derived data.** It includes original quest scripts, BIOG/faction text, FONT*.FNT files and 133 MIDI files, and DFU's MIT licence cannot license any of it. A fork that ships DFU builds inherits that exposure. Bethesda tolerates it today.
4. **The EU and UK online-service duties for the chosen hosting setup** (GDPR, DSA and the UK Online Safety Act). These depend on who the "provider" is (a person, an association, or a fiscal host) and where it is based.

**Recommended licences for our code:** server under AGPL-3.0-or-later; reusable networking/protocol library under MPL-2.0 (or Apache-2.0); changes to DFU code under MIT to match upstream. Reasons in §7.

---

## 1. Bethesda's free release of Daggerfall

**Facts**
- Bethesda made Daggerfall a free download on 9 July 2009 for the series' 15th anniversary. The original BethBlog post was `http://bethblog.com/index.php/2009/07/09/daggerfall-now-available-for-free/`. That domain is dead, and I couldn't fetch an archived copy because the Wayback Machine is blocked from this environment. Contemporary reports: [Shacknews](https://www.shacknews.com/article/59477/free-version-of-the-elder), [RPGWatch](https://rpgwatch.com/news/daggerfall--released-for-free-12575.html) (released "as is", no support), and [DF Workshop, 10 Jul 2009](https://www.dfworkshop.net/daggerfall-for-free/), which links the BethBlog post and states no terms.
- **Current availability:** [Steam app 1812390](https://store.steampowered.com/app/1812390/The_Elder_Scrolls_II_Daggerfall/) is listed as "Free To Play", developer and publisher Bethesda Softworks. Its notice reads: *"© 1994-1996 Bethesda Softworks LLC, a ZeniMax Media company. The Elder Scrolls, Daggerfall, Bethesda, ZeniMax and their respective logos are registered trademarks of ZeniMax Media Inc. All Rights Reserved."* The page links no game-specific EULA, only the Steam Subscriber Agreement. The official page [elderscrolls.bethesda.net/en/daggerfall](https://elderscrolls.bethesda.net/en/daggerfall) sends "Download The Full Game" to Steam and links the generic ZeniMax ToS and [eulas.bethesda.net](https://eulas.bethesda.net/).
- **No explicit licence text for the 2009 free release could be found.** I found nothing that grants permission to redistribute, rehost, modify or make derivative works. "Free of charge" is not a licence. The default position is all rights reserved.
- **Generic ZeniMax ToS.** The pages at [documents.bethesda.net/terms-of-service](https://documents.bethesda.net/terms-of-service) and [zenimax.com/en/legal/terms-of-service](https://www.zenimax.com/en/legal/terms-of-service) returned HTTP 403 to automated fetching. The following comes from search-engine extracts only **[UNVERIFIED wording]**: the licence is "for Your personal, private and non-commercial use only". It says "You may not (a) distribute, … sell, transmit, publish, edit, reproduce, sublicense, rent … any Game, Software, and/or Content", and it bars reverse engineering and derivative works. It also says "Any commercial use or play of a Service … is prohibited absent written permission". Whether this ToS binds a 1996 game obtained through Steam is a question for a lawyer.

**What follows for us**
- Never host, mirror or bundle Daggerfall files or anything converted from them. Point users to Steam (and GOG, if it is still listed **[UNVERIFIED current GOG listing]**).
- Our server needs world data (map, locations, quests). Prefer reading it from the operator's own legally obtained copy at start-up rather than shipping it.

## 2. Daggerfall Unity: licence, contents, obligations

Checked against a local clone (commit `3d85a28`, 2026-11-13) of [Interkarma/daggerfall-unity](https://github.com/Interkarma/daggerfall-unity).

**Code licence:** MIT, "Copyright (c) 2009-2023 Daggerfall Workshop" (`LICENSE`).

**Third-party components shipped in the repo**

| Component | Licence | Where |
|---|---|---|
| Daggerfall Connect, DFU core (Gavin Clayton) | MIT | `Assets/Licenses/` |
| C# Synth Project | MIT | `Assets/Licenses/` |
| Full Serializer (J. Dufault) | MIT | `Assets/Licenses/` |
| INI File Parser (R. Amores) | MIT | `Assets/Licenses/` |
| mcs ICodeCompiler (Ximian) | MIT/X11 | `Assets/Licenses/` |
| Unity Console (S. Turcotte) | MIT | `Assets/Licenses/` |
| Open Sans font | Apache-2.0 | `Assets/Resources/Fonts/OpenSans/License!.txt` |
| Unity packages (post-processing, TextMesh Pro, etc.) | [Unity Companion License](http://www.unity3d.com/legal/licenses/Unity_Companion_License), usable only with Unity | `Packages/` |
| `TimGM6mb.sf2` soundfont (Tim Brechbill) | **GPL-2.0**, per [MuseScore handbook](https://musescore.org/en/handbook/3/soundfonts-and-sfz-files). **No licence file in the DFU repo.** | `Assets/Resources/TimGM6mb.sf2.bytes` |

**Does DFU ship Bethesda material? Yes, some.** DFU's README says the DOS game "provides all necessary game assets such as textures, 3D models, and sound effects", and textures, models, sounds, video and ARENA2 are indeed not in the repo (`StreamingAssets/GameFiles/readme.txt` tells users to supply ARENA2). However, the repo also contains:
- `StreamingAssets/Quests/` (265 files): original quest scripts, decompiled and "Edited for Daggerfall Unity". Example header: `-- Quest: C:\QUESTS\WORKING\A0C00Y00.Qbn.`
- `StreamingAssets/BIOGs/`, `Factions/FACTION.TXT`, `Fonts/FONT000x.FNT` (original font files), and text tables.
- `Resources/Songs/` (133 `.mid` files, standard and `fm` variants): the game's MIDI music.

None of this can be under DFU's MIT licence, because Daggerfall Workshop doesn't own it. The status is "tolerated", not "licensed". I found no public Bethesda permission for it **[no source found]**.

**GOG "Daggerfall Unity – GOG Cut"**
- Released free on GOG on 15 June 2022. It bundled DFU 0.13.5, the game data and around 40 mods, and was assembled by GamerZakh and GOG ([PC Gamer](https://www.pcgamer.com/daggerfall-unity-gog-cut-brings-back-the-elder-scrolls-classic-without-the-headaches-and-its-free/), [GOG page](https://www.gog.com/en/game/daggerfall_unity_gog_cut)).
- Interkarma posted that GOG told him "Bethesda gave it their approval" ([DFW forum t=5676](https://forums.dfworkshop.net/viewtopic.php?t=5676); I couldn't read this directly (HTTP 403) and quote it via search extracts **[UNVERIFIED wording]**).
- The DFU team says: "The Daggerfall Unity development team did not assemble the 'GOG Cut' release and in no way recommend it" ([dfworkshop.net](https://www.dfworkshop.net/)).
- GOG delisted it on 12 Feb 2025 as "outdated" ([Gameranx](https://gameranx.com/updates/id/528545/article/daggerfall-unity-is-about-to-be-delisted-from-gog-but-why/)).
- Significance: Bethesda knows about DFU and approved a distribution that included its data, through GOG under GOG's own arrangement. That approval does not extend to us.

**Obligations on our fork or mod**
1. Keep DFU's MIT notice and every `Assets/Licenses/*` file in source and binary distributions. Add the Open Sans Apache-2.0 notice and the GPL-2.0 text and credit for TimGM6mb. Better: drop the soundfont from our builds or confirm its licence.
2. Don't relicense DFU files. Our new files can carry our own licence.
3. To minimise exposure, a **mod (`.dfmod`) or a slim patch set is lower-risk than a full fork build**, because a full build redistributes the Bethesda-derived quest, MIDI and font files above. If we do ship a full client build, decide consciously whether to strip or replace them. A lawyer question.
4. The Unity Companion License restricts Unity packages to use with Unity, which is fine for us.

## 3. Unity terms

- **Version:** DFU requires Unity **2019.4.41f2** (`ProjectSettings/ProjectVersion.txt`).
- **Current Editor Software Terms** ([unity.com/legal/editor-terms-of-service/software](https://unity.com/legal/editor-terms-of-service/software), "Last updated: November 16, 2026"):
  - "The Financial Threshold for Unity Personal is $200,000 USD for the most recent twelve (12) month period."
  - For an individual not doing client work, Total Finances means "the amount generated in connection with your use of the Software". For a legal entity, it means "your aggregate gross revenues and funding". For a non-profit, "your budget for the entire entity or institution".
  - Distribution is "without royalty, revenue share, or a runtime fee, for any Projects created with Unity 6 or any earlier versions".
  - "You may not use Unity Build Server with the Unity Personal tier." This is about headless *Editor* build machines (CI). It does not cover shipping a headless *player* build as a game server. A Linux headless/"Server Build" player is an ordinary runtime build **[my reading; confirm]**.
- **Version-pinning promise:** after the 2023 Runtime Fee backlash, Unity said users "can stay on the terms applicable for the version of Unity editor you are using" ([summary and archive links](https://gist.github.com/runevision/1c0d6a856dda1461577cf7f84574253a), [GameFromScratch](https://gamefromscratch.com/unity-update-licensing-terms/)).
- **Do donations count?** Unity's terms don't mention donations, crowdfunding or open source. The [Unity Personal page](https://unity.com/products/unity-personal) says "less than $200K USD of revenue and funds raised". Donations to a Unity-built project most likely count toward the threshold **[interpretation, community thread only: [discussions.unity.com](https://discussions.unity.com/t/do-patreon-donations-count-as-revenue/930294)]**. A hosting-cost donation stream will stay far below US$200k, so the tier does not change in practice. Each contributor using the Editor checks their *own* eligibility. There are no seat fees on Personal.
- **Practical note:** 2019.4 LTS is long out of support (no security patches). That matters for a network-facing client and is one more reason to keep the server non-Unity (see the architecture docs).

## 4. Names and marks

- **Registered marks:** "The Elder Scrolls, Daggerfall, Bethesda, ZeniMax and their respective logos are registered trademarks of ZeniMax Media Inc." ([Steam](https://store.steampowered.com/app/1812390/The_Elder_Scrolls_II_Daggerfall/))
- **ZeniMax enforces its marks:**
  - It sued Mojang over "Scrolls" (2011). In the 2012 settlement the mark was transferred to ZeniMax and Mojang was barred from sequels under the name ([Game Developer](https://www.gamedeveloper.com/business/zenimax-settlement-blocks-mojang-from-making-more-em-scrolls-em-games), [VentureBeat](https://venturebeat.com/2012/03/12/zenimax-media-and-minecraft-developer-mojang-settle-scrolls-lawsuit/)).
  - A free fan roguelike, DoomRL, was renamed DRL after a C&D in 2016 ([Wikipedia](https://en.wikipedia.org/wiki/DRL_(video_game))).
  - A "Fallout: New York" fan browser game was taken offline after a reported ZeniMax C&D/DMCA, c. Oct 2026 ([GameLoop](https://gameloop.gg/articles/fallout-new-york-ai-game-taken-offline-after-bethesda-cease-desist-browser/)) **[secondary only]**.
- **How comparable projects named themselves:**

| Project | Name uses mark? | Disclaimer found |
|---|---|---|
| Daggerfall Unity | "Daggerfall" | None visible on dfworkshop.net or in the README ([site](https://www.dfworkshop.net/)) |
| OpenMW | No ("MW" only) | "not in any way associated with or supported by Bethesda Softworks or ZeniMax Media Inc." ([FAQ](https://openmw.org/faq/)) |
| TES3MP | "TES" abbreviation | — ([tes3mp.com](https://tes3mp.com/)) |
| Skyrim Together (Reborn) / TiltedEvolution | "Skyrim" (mod); framework name neutral | None on [repo](https://github.com/tiltedphoques/TiltedEvolution) |
| Skywind / Skyblivion | Portmanteaus | — |
| DFO Online (formerly "Daggerfall Online") | Renamed away from "Daggerfall Online". The rename PR is titled "the new logo and name everywhere, the original game named only where it must be" ([PR #786](https://github.com/Lattymoy/daggerfall-js-source/pull/786); the page now 404s, title seen via search). The reason isn't stated, and I found no evidence of a rights-holder request. | — |
| daggerfall.online (third-party DFO fork) | Domain uses mark | "This is an unofficial community project." / "Not affiliated with Bethesda, ZeniMax, or the upstream team." ([about](https://daggerfall.online/about/)) |

- **Recommendation:** pick a **distinctive name that doesn't contain "Daggerfall" or "Elder Scrolls"** for the project, domain and logo. Use "Daggerfall" only descriptively ("multiplayer for Daggerfall Unity", "requires The Elder Scrolls II: Daggerfall"). That way the networking technology can also be rebranded and reused. Microsoft's own guidance on fan items treats "Let's Play X" as fine and "X: Covenant Strike"-style titles as objectionable ([Game Content Usage Rules](https://www.xbox.com/en-US/developers/rules)), and it asks fans not to use the game's actual logos.
- **Suggested disclaimer** (README, website footer, client title screen, server MOTD):
  > *\<Project\> is an unofficial, free, fan-made open-source project. It is not made, endorsed, sponsored or approved by Bethesda Softworks, ZeniMax Media or Microsoft. The Elder Scrolls, Daggerfall and related names and logos are trademarks of ZeniMax Media Inc. \<Project\> contains no game data from The Elder Scrolls II: Daggerfall; you must supply your own copy, available free from Bethesda. \<Project\> builds on Daggerfall Unity (MIT licence, © Daggerfall Workshop) and is not affiliated with the Daggerfall Unity team.*

## 5. Money and donations

**Bethesda/ZeniMax and Microsoft policy texts**
- **Creation Kit EULA** (Bethesda's modding tool, not used by us but the closest statement of Bethesda's mod policy): "You will not permit any third party to download, distribute or use Game Mods developed or created by You for any commercial purpose". The only paid route is Bethesda's own Creations/Verified Creator programme ([Steam EULA 1946180](https://store.steampowered.com//eula/1946180_eula_0), [UESP archive of the older Skyrim EULA](https://en.m.uesp.net/wiki/Skyrim_Mod:EULA)).
- **Microsoft Game Content Usage Rules** ([xbox.com/en-US/developers/rules](https://www.xbox.com/en-US/developers/rules), last updated January 2015):
  - Scope: "all games and Game Content published and owned by Microsoft Studios". The rules don't mention Bethesda or ZeniMax, so **it is unverified whether they cover Daggerfall**. They are still the best public signal of Microsoft's stance.
  - Key lines: "you can't sell or otherwise earn any compensation from your Item" … but "You may use the Item on a page where you ask for optional donation requests."
  - They also say "You can't reverse engineer our games to access the assets". If the rules applied, that would be a problem for any DFU-style engine.
  - They require a notice: "[Game] © Microsoft Corporation. [Item] was created under Microsoft's 'Game Content Usage Rules' using assets from [Game], and it is not endorsed by or affiliated with Microsoft."
- **Paid mods history:** Valve and Bethesda's Skyrim paid Workshop (April 2015) was pulled after 3–4 days, with Bethesda saying "paid mods are being removed from Steam Workshop" ([Game Rant](https://gamerant.com/steam-paid-mod-cancel-skyrim/)). Bethesda later monetised mods only through its own curated channels (Creation Club 2017, then Creations in Dec 2023) ([Wikipedia](https://en.wikipedia.org/wiki/Creation_Club)).

**Precedents**

| Project | Money | Outcome |
|---|---|---|
| Skyrim Together (2018–19) | Patreon peaked at roughly $25–33k/month. Closed beta required a ≥$1 pledge, and better servers needed more ([TechCrunch](https://techcrunch.com/2019/02/28/skyrim-mod-drama-gets-ugly-with-allegations-of-stolen-code-and-misappropriated-donations), [VentureBeat](https://venturebeat.com/games/skyrim-together-reborn-is-finally-out-and-playable/)) | SKSE code-theft scandal; the team apologised and removed the code ([PC Gamer](https://www.pcgamer.com/skyrim-script-extender-devs-accuse-skyrim-together-modders-of-stealing-code/)), and donations collapsed ([GamesRadar](https://www.gamesradar.com/this-multiplayer-skyrim-mod-has-been-accused-of-stealing-code-and-its-turned-into-a-war-thats-cost-them-almost-dollar10k-in-patreon-donations/)). Claims that Bethesda sent a letter about the paywalled beta are **forum hearsay** ([OpenMW forum](https://forum.openmw.org/viewtopic.php?t=5783)). There's no public Bethesda statement. |
| Skyrim Together Reborn (2022) | Takes no donations; new team; GPL-3.0 ([VentureBeat](https://venturebeat.com/games/skyrim-together-reborn-is-finally-out-and-playable/)) | Released on Nexus, with no reported action. |
| OpenMW | "OpenMW itself won't accept monetary donations"; it points to individual developers' Patreon/Ko-fi pages. Bethesda "has given us approval to continue", on the condition of not promoting Morrowind running on mobile ([FAQ](https://openmw.org/faq/)) | Left alone for 15+ years. |
| TES3MP | GPLv3; "donating on Patreon to our two developers" ([tes3mp.com](https://tes3mp.com/)) | No reported action. |
| Skyblivion | "We neither accept donations nor have any kind of crowdfunding accounts" ([FAQ](https://skyblivion.com/faq/)). Bethesda is publicly supportive and required that it replace 100% of the original assets ([Wikipedia](https://en.wikipedia.org/wiki/Skyblivion)) | Supported. A volunteer lawsuit (2026) is internal, not from Bethesda ([Kotaku](https://kotaku.com/team-behind-fan-made-oblivion-remake-face-lawsuit-from-former-contributor-2000752100)). |
| Daggerfall Unity | No donation links on the official site ([dfworkshop.net](https://www.dfworkshop.net/)) | Tolerated; Bethesda approved the GOG bundle. |
| DFO Online (ex-"Daggerfall Online") | Patreon and Ko-fi, about $600/month target. "No gameplay, source code, or normal releases are locked behind them." ([SUPPORT.md](https://raw.githubusercontent.com/Lattymoy/daggerfall-js-source/main/SUPPORT.md)) | **No rights-holder response found** (absence of evidence only). Renamed from "Daggerfall Online"; reason not stated. |

**What separates projects left alone from those in trouble.** This is a pattern, not a rule: the projects left alone redistribute no assets, sell no access or perks, keep money small and project-level (or none at all), avoid official-looking branding, and often talk to Bethesda. The trouble came with paywalled access, large revenue, licence violations and use of the mark as a name.

**Options**

| Option | Risk | Notes |
|---|---|---|
| A. No donations at all (Skyblivion, Reborn, OpenMW-as-project) | Lowest | Hosting is paid out of pocket or by in-kind sponsors (free OSS hosting credits, which carry no gameplay link). |
| B. Donations to individual developers (OpenMW, TES3MP model) | Low–medium | Separates the money from the game. Individuals carry the tax burden and personal exposure, and transparency is weak. |
| C. Fiscal host, e.g. [Open Source Collective](https://docs.oscollective.org/getting-started/acceptance-criteria) or Open Collective Europe | Medium | Public ledger, and the host holds funds and handles tax. But the host may refuse a project built on third-party IP **[unverified for games]**, and the money is visibly *for this project*, so it ties funding to the game more directly than B does. |
| D. Hosting-cost-only, transparent (C plus a published budget, a cap, no perks and no surplus) | Medium, but the most defensible if Bethesda agrees | Matches Microsoft's "optional donation requests" carve-out in spirit. Must be clearly opt-in, with no perks of any kind, and kept off the client and in-game. |

**Recommendation:** launch with **A**. Move to **D** (through a fiscal host) only after clearance.

**What "legal clearance" should consist of**
1. **Written permission from the rights holder.** Email Bethesda/ZeniMax (OpenMW got approval this way) describing the project and asking specifically about (a) the name and disclaimer, (b) a server run by us, and (c) voluntary hosting-cost donations with no perks. Keep the reply. Silence is not consent.
2. **Review by a lawyer in the jurisdiction where the fund-holder sits.** The lawyer should check: whether the ZeniMax ToS or EULA binds Daggerfall players; whether DFU's Bethesda-derived files are being redistributed; trademark use in the name and domain; tax and charity status of the donations; and the liability of individual maintainers.
3. **Fiscal host acceptance** (if option C/D), with the host told explicitly about the IP situation.
4. **A written donations policy** published before the first donation: what the money pays for, no perks, refunds and wind-down if a C&D arrives, and how surplus is handled.
5. **A takedown plan:** who receives notices, and a commitment to comply quickly.

## 6. Running an online service (accounts + chat, EU/UK users): checklist

Legal texts: GDPR [EU 2016/679](https://eur-lex.europa.eu/eli/reg/2016/679/oj) and UK GDPR + DPA 2018 ([ICO guide](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/)); DSA [EU 2022/2065](https://eur-lex.europa.eu/eli/reg/2022/2065/oj); UK Online Safety Act 2023 ([legislation.gov.uk](https://www.legislation.gov.uk/ukpga/2023/50), [Ofcom duties](https://www.ofcom.org.uk/online-safety/illegal-and-harmful-content/illegal-content-duties-under-the-online-safety-act)). The article references below are from my own knowledge of these texts **[check against the linked texts]**.

- [ ] **Identify the controller and provider.** Name a real person or entity with a contact address. If based outside the EU or UK, check the GDPR Art. 27 and DSA Art. 13 representative rules, and the GDPR Art. 27(2) exemption for occasional, low-risk processing.
- [ ] **Privacy notice** (GDPR Art. 13): what is collected, why, the lawful basis (Art. 6(1)(b) contract is the usual one for accounts), retention, rights, how to contact you, and the right to complain to a supervisory authority or the ICO.
- [ ] **Data minimisation** (Art. 5(1)(c)): username and password hash; email only if needed for recovery; no real names, birth dates or analytics SDKs. Short retention for IP logs and chat logs, with documented periods.
- [ ] **Password storage** (Art. 32 security): Argon2id or bcrypt with per-user salt ([OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)); TLS on all auth traffic; rate-limit logins. Have a breach plan: notify the regulator within 72h if there is risk (Art. 33).
- [ ] **User rights:** a way to delete an account and export data (Arts. 15–17, 20).
- [ ] **Age:** set a minimum age (13+ or 16+) in the terms. If you rely on consent for under-16s, GDPR Art. 8 applies (member states set 13–16; the UK sets 13). If children are likely users, the UK [Age Appropriate Design Code](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/childrens-information/childrens-code-guidance-and-resources/) applies. The OSA also requires a **children's access assessment**.
- [ ] **Terms of service and rules of conduct** explaining what moderation exists (DSA Art. 14).
- [ ] **Illegal-content handling.** DSA: a notice-and-action mechanism (Art. 16), statements of reasons for removals and bans (Art. 17), and a single point of contact (Arts. 11–12). These apply regardless of size. Platform-only duties are waived for micro and small enterprises (Art. 19). UK OSA: an **illegal content risk assessment**, due within 3 months of launch and reviewed yearly; reporting and complaints routes; and a named responsible person. Ofcom provides a [compliance checker](https://www.ofcom.org.uk/online-safety/illegal-and-harmful-content/check-how-to-comply-with-the-illegal-content-rules).
- [ ] **Practical moderation:** in-game report command, mute and block, an admin ban tool, a profanity filter, logging for evidence with short retention, and the option of server-side text chat only (no voice or images) to keep risk low.
- [ ] **Cookies:** none on the website beyond strictly necessary ones; otherwise a consent banner is needed.

## 7. Licence for our code

Constraints: DFU is MIT, which is compatible with everything below. The client runs on the proprietary Unity runtime. We want a reusable networking layer, and we want to stop server operators from closing the source.

| Licence | Reuse | Stops closed server forks? | Works inside a Unity client? |
|---|---|---|---|
| MIT / Apache-2.0 | Maximal (Apache adds a patent grant) | No | Yes |
| MPL-2.0 | High: file-level copyleft; can be combined with proprietary or MIT code | Only modified MPL files must stay open, and only when *distributed*. Running a server is not distribution. | Yes |
| GPL-3.0 | Lower | No: running a network service is not distribution | Problematic: GPL code combined with the proprietary UnityPlayer is arguably a violation without an added exception |
| AGPL-3.0 | Lowest for libraries | **Yes**: users of a modified network service must be offered the source (§13) | Same problem as GPL |

**Recommendation**
- **Dedicated server (application): AGPL-3.0-or-later.** This is the only common licence that makes operators publish their modifications. It doesn't stop people running unmodified servers, and it shouldn't.
- **Networking/protocol library shared by client and server: MPL-2.0**, or Apache-2.0 if adoption beyond us matters most. It can be embedded in the Unity client and in other games or engines without dragging AGPL along, and improvements to the library files themselves stay open.
- **Client changes to DFU: MIT**, matching upstream so they can be contributed back and other DFU mods can reuse them. Avoid GPL/AGPL in anything that ships inside the Unity build.
- **Contributions:** use a DCO sign-off (no CLA), and state per-directory licences in `LICENSE` files plus SPDX headers so the split is unambiguous.

---
*Sources that couldn't be read directly: the BethBlog 2009 post (dead; archive blocked), documents.bethesda.net and zenimax.com ToS (HTTP 403), DFW forum t=5676 (HTTP 403), and DFO Online PR #786 (404). Their content above comes from search extracts and is marked.*
