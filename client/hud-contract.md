# HUD contract (`client/play.html`)

The launcher and in-game controls share the markup in `play.html`.
`main.js` manages the current screen, input, and connection state through the IDs below.
`hud/interface.css` loads after the base styles, and `hud/interface.js` subscribes to
game events to draw the compass and show the town name on arrival.

## Global state hooks

| Where | Attribute | Values |
|---|---|---|
| `<body>` | `data-screen` | `landing` · `loading` · `failure` · `game` |
| `<body>` | `data-conn` | `idle` · `connecting` · `online` · `lost` · `closed` |
| `<body>` | `data-pointer-lock` | present while the mouse is captured |
| `<body>` | `data-chat-open` | present while the chat input has focus |

Only the section matching `data-screen` is visible (others carry `hidden`). Respect
`[hidden]` — keep `[hidden]{display:none!important}` semantics.

## Always present

- `#view` — full-viewport WebGL `<canvas>` (behind everything; the game sizes it).
- `#labels` — absolutely positioned overlay; the game creates children:
  `.label` (`data-id`, `style.transform` set every frame) containing
  `.label-name` and, briefly after someone speaks, `.label-say`. Don't set `transform`
  on `.label`.

## Landing — `#screen-landing`

- `.panel.panel-landing` › `.panel-head` (`.back-link` to `/`, `h1#landing-title`, `.lede`)
- `form#join-form`
  - `#name-input` (text, max 24) + `#name-note` (validation / “already active in another tab” notice)
  - `#data-drop.drop[data-state]` — `empty` · `ready` · `warn` · `error` · `dragover`;
    contains `#data-pick` button and `#data-status` text. Folder may be dropped onto it.
  - `#data-input` hidden directory file input (opened by `#data-pick`)
  - `#enter-btn.btn.btn-primary` (disabled until name + data are valid; label changes to
    “Return to ⟨town⟩” when the town is already loaded)
  - `#form-error` (`hidden` unless a problem)

## Loading — `#screen-loading`

- `#loading-title`, `ol#loading-steps > li[data-step][data-state]`
  - steps: `read`, `build`, `connect`; state: `pending` · `active` · `done` · `failed`
- `#loading-detail` live text, `#loading-cancel` button.

## Failure — `#screen-failure`

- `#failure-title`, `#failure-message`, `#failure-hint`
- `#failure-retry` (primary), `#failure-folder`, `#failure-back` — any may be `hidden`
  depending on what makes sense for the error.

## In game — `#hud`

`#hud` is one CSS grid over the view (`hud/layout.css` owns all geometry; `interface.css` and
`gameplay/shell.css` own the look). Regions never overlap and only real controls take pointer
input, so drags reach the canvas:

| Region | Element | Holds |
|---|---|---|
| top | `header#hud-top` | `#hud-status` (place plaque, clock chip) · `#hud-compass` · `#hud-actions` |
| notices | `ol#hud-toasts` | under the compass; above the menu (z 45), at the bottom edge while a page is open |
| popovers | `#hud-popovers` | `#hud-roster`, `#hud-help`, stacked under the actions and sharing the column height |
| centre | `#hud-crosshair`, `#hud-prompts` | target readout, door/actor prompts, stacked under the crosshair |
| right edge | `#hud-breath` | Remaining seconds while submerged. The vertical gauge turns red at low breath and hides on surfacing or with Water Breathing. Play corrects its prediction from the swimmer’s private snapshot. |
| bottom | `#hud-bottom` | `#hud-chat` (chat dock, left) and `#hud-dock` (spell chip, vitals, action bar; right) |
| modal | `#game-menu` (z 40), `#hud-banner` (z 50) | above the grid |

Narrow screens (≤ 640 px) stack the top into two rows and the docks full-width; short screens
(≤ 560 px tall) use one slim top row, compact vitals and a full-bleed menu. The action bar wraps
instead of scrolling, so every page button stays reachable.

Slots: `hud/layout.js` moves widgets that feature modules append to `#hud`/`<body>` into their
region (`.atmo-chip` → `#hud-status`, `.mg-chip` → `#hud-dock`, `.interiors-prompt` and
`#actor-target` → `#hud-prompts`). New widgets may append straight into a `[data-hud-slot]`
element (`status`, `prompts`, `dock`) instead of positioning themselves.

- `header#hud-top`
  - `#hud-status[data-hud-slot=status]` › `#hud-place` › `#hud-town` (town name),
    `#hud-conn.conn[data-conn]` (short status text)
  - `#hud-compass` › `#hud-heading` (game writes N/NE/E… text). Live heading is also
    dispatched every change as `window` event
    `new CustomEvent('game:heading', { detail: { yaw } })` — `yaw` radians, 0 = north (−z),
    positive clockwise (toward east, +x), range (−π, π].
  - `#hud-actions` › `#hud-people-btn` (with `#hud-count`), `#hud-help-btn`, `#hud-menu-btn`,
    `#hud-leave-btn` (buttons use `aria-expanded` for their panels).
- `#hud-popovers` › `aside#hud-roster` (toggle) › `ul#roster-list > li[data-id]` (`.you` class
  on self, `.roster-name` span); `aside#hud-help` (toggle) › `dl` of controls.
- `#hud-chat[role=region]` (chat dock) › `section#hud-talk` (NPC conversation, `hidden` unless
  talking; contents owned by `gameplay/npcs.js`, which also sets `body[data-talk]`), then
  `ol#chat-log > li.chat-line` (`.chat-system` for arrivals/departures/errors,
  `.chat-self` for own lines) each containing `.chat-name` + `.chat-text`; `form#chat-form`
  › `#chat-input`. The log keeps the last ~80 lines; older lines get `.chat-old` after
  ~20 s idle (fade them, but keep readable on hover/when chat open). While talking the dock
  widens, `#hud-talk` scrolls within `--talk-max` and the log shrinks to a few lines.
- `#hud-banner` (`hidden` unless the connection dropped) › `#hud-banner-text`,
  `#hud-reconnect-btn`, `#hud-banner-leave-btn`.
- `#hud-crosshair` — tiny centre mark; `#hud-prompts[data-hud-slot=prompts]` › `#hud-target`.

## Other events (window)

- `game:screen` `{ screen }` — on every screen change.
- `game:presence` `{ players: [{ id, name, self }] }` — on roster changes.
- `game:chat` `{ name, text, system }` — every chat line added.

Keep the HUD compact and readable over bright and dark scenes; it must not intercept
pointer drags on the canvas except where actual controls are.

## Game shell (`gameplay/shell.js`, `gameplay/shell.css`)

Markup in `#hud`: `#hud-vitals > .vital[data-vital=health|fatigue|magicka][role=meter]`
(`.vital-fill`, `.vital-num` “cur / max”, `data-low` at ≤25 %), `#hud-target` (crosshair target:
`.target-name`, `.target-hp`, `kbd` hint, `data-kind`), `ol#hud-toasts > li.toast[.toast-error]`,
`#hud-dock > nav#hud-bar > .bar-btn[data-action=ready|attack|interact | data-panel=<id>]` (the
interact button `#hud-use-btn` is labelled for the current target: Talk, Loot, Revive, Party or Use), `#hud-menu-btn`, and
the menu dialog `#game-menu[role=dialog][aria-modal] > .menu-frame > #menu-tabs[role=tablist] >
.menu-tab[role=tab][data-panel][data-group]` (grouped You · World · People · System; a group's
first tab has `data-group-start`) + `#menu-title`, `#menu-close`, `#menu-panel[role=tabpanel]`.
`/auth/account.js` mounts `#account-panel` before `#join-form`; `#account-gate` says why Enter is
disabled; `#name-field` is shown only for guest play.

Body hooks: `data-menu="<panel id>"` while a menu page is open, `data-readied` while the weapon is
drawn, `data-gamepad` while a controller is connected, `data-account` (`pending|in|out`, set by the
account module).

Default keys (rebindable in Settings, saved in `localStorage['dfw.settings']`): F ready/sheathe ·
Space or left-click attack (attack draws the weapon first when sheathed; on desktop the first click
on the view only captures the mouse) · G talk/use/loot ·
C character · I inventory · B spellbook · J journal · M map · O party · F10 settings · P people ·
T/Enter speak · Esc closes the menu, or opens Settings when nothing is open. Fixed: W A S D, Q E,
arrows, Tab (focus), Enter, Esc. Right-button drag belongs to the weapons feature. Gamepad
(standard mapping): left stick walk, right stick look, A use, X/RT attack, Y ready, Start menu,
Back map; in menus D-pad moves focus, A activates, B/Start closes, LB/RB change page.

Mouse look: on a desktop mouse, one primary click on the game view requests pointer lock; that
click never attacks or interacts. While locked, plain mouse motion turns the view, every primary
press is a click action, and Esc only releases the mouse (it does not open Settings). If pointer
lock is unavailable or refused twice in a row, the mouse falls back to drag-to-look with
click-to-attack and a toast says so. Touch and pen always drag to look; a short tap attacks.
Closing a menu never re-captures the mouse; the player clicks the view again.

While a menu page is open, `api.modalOpen` is true, movement and look are suspended, pointer lock
is released and focus is trapped in the dialog; closing restores focus to the canvas.

Window events added: `game:location` `{ location, name }` after travel.
