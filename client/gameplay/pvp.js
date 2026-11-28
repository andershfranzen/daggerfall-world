// Land PvP Client Feature & Granite/Verdigris HUD (docs/multiplayer-feature-plan.md §4).
//
// Exports for Wave 2B integration & standalone testing:
//   PANEL_ID                 'pvp'
//   TABS                     duel | arena | district | siege
//   pvpView(state, cache)    pure DOM-free view-model builder
//   renderPvpPanel(el, view, handlers)
//   renderPvpHud(el, view, handlers)
//   mountPvpPanel(container, api, opts)
//   mountPvpHud(host, api, opts)
//   install(api)             standard client gameplay feature installer

export const PANEL_ID = 'pvp';

export const TABS = Object.freeze([
  { id: 'duel', label: 'Duels' },
  { id: 'arena', label: 'Ranked Arena' },
  { id: 'district', label: 'Open PvP Ward' },
  { id: 'siege', label: 'Order Sieges' },
]);

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = String(v);
    else if (k === 'value') n.value = String(v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
}

export function loadStyles() {
  if (typeof document === 'undefined' || document.querySelector('link[data-feature="pvp"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./pvp.css', import.meta.url).href;
  link.dataset.feature = 'pvp';
  document.head.append(link);
}

function fmtSec(ms) {
  const s = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}:${String(r).padStart(2, '0')}` : `${r}s`;
}

/**
 * Pure view-model builder (DOM-free, unit-testable in Node).
 */
export function pvpView(state = {}, cache = {}) {
  const raw = cache.pvpState ?? {};
  const peers = Array.isArray(state?.peers) ? state.peers : [];
  const selfId = state?.selfId ?? state?.character?.id ?? null;

  const duel = raw.duel ?? {
    active: null,
    incomingInvites: [],
    outgoingInvites: [],
    stats: { wins: 0, losses: 0, draws: 0 },
  };

  const arena = raw.arena ?? {
    queue: null,
    queueCounts: { ranked: 0, practice: 0 },
    activeMatch: null,
    rating: { elo: 1200, wins: 0, losses: 0, draws: 0, streak: 0, season: 1 },
    leaderboard: [],
    liveMatches: [],
    recentHistory: [],
  };

  const district = raw.district ?? {
    districtName: 'Bloodmarket Ward',
    location: 'pvp:Iliac/Bloodmarket Ward',
    inDistrict: false,
    inSafeZone: false,
    flagged: false,
    combatTagMsLeft: 0,
    respawnProtectMsLeft: 0,
    score: { honor: 0, kills: 0, deaths: 0, streak: 0, bestStreak: 0 },
    leaderboard: [],
    occupantCount: 0,
  };

  const siege = raw.siege ?? {
    tenure: {
      seatId: 'keep:iliac-bay/castle-gothway',
      seatName: 'Castle Gothway',
      holderOrderId: null,
      holderOrderName: 'Unclaimed Garrison',
      holderOrderTag: null,
      defenses: 0,
      prestige: 0,
    },
    activeSiege: null,
    standings: [],
    myOrder: null,
  };

  const nearbyDuelTargets = peers.filter((peer) => peer && peer.id !== selfId && !peer.defeated);

  return {
    selfId,
    tab: cache.tab ?? 'duel',
    status: cache.status ?? '',
    warning: cache.districtWarning ?? null,
    nearbyDuelTargets,
    duel,
    arena,
    district,
    siege,
  };
}

function meter(percent, label, variant = '') {
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  return el('div', { class: 'pvp-meter' },
    el('div', { class: `pvp-meter-fill ${variant}`.trim(), style: `width:${clamped}%` }),
    el('span', { class: 'pvp-meter-label', text: label }),
  );
}

// ------------------------------------------------------------------ Tab Renderers

function renderDuelTab(view, h) {
  const { duel, nearbyDuelTargets } = view;
  const active = duel.active;

  const leftCol = el('div', { class: 'pvp-col' });
  const rightCol = el('div', { class: 'pvp-col' });

  // Active Duel or Invites Card
  if (active) {
    const [fA, fB] = active.participants ?? [];
    const anyOob = (active.participants ?? []).find((f) => f.oobRemainingSec != null);
    const phaseBadge = active.phase === 'countdown'
      ? el('span', { class: 'pvp-badge is-gold', text: `Countdown ${fmtSec(active.countdownMsLeft)}` })
      : anyOob
        ? el('span', { class: 'pvp-badge is-danger', text: `Out of Bounds ${anyOob.oobRemainingSec}s` })
        : el('span', { class: 'pvp-badge is-ok', text: `Active · ${fmtSec(active.timeRemainingMs)}` });

    leftCol.append(
      el('section', { class: `pvp-card ${anyOob ? 'is-danger' : 'is-verdigris'}` },
        el('div', { class: 'pvp-card-head' },
          el('h3', { class: 'pvp-card-title', text: 'Active Consent Duel' }),
          phaseBadge,
        ),
        fA && fB ? el('div', { class: 'pvp-vs' },
          el('div', { class: 'pvp-col' },
            el('div', { class: 'pvp-row-name', text: fA.name }),
            meter((fA.hp / Math.max(1, fA.maxHp)) * 100, `${fA.hp}/${fA.maxHp} HP`, 'is-hp'),
            el('span', { class: 'pvp-row-sub', text: `Consumables ${fA.consumablesUsed}/${fA.consumablesMax}${fA.disconnected ? ' · Reconnecting' : ''}` }),
          ),
          el('div', { class: 'pvp-vs-center', text: 'VS' }),
          el('div', { class: 'pvp-col' },
            el('div', { class: 'pvp-row-name', text: fB.name }),
            meter((fB.hp / Math.max(1, fB.maxHp)) * 100, `${fB.hp}/${fB.maxHp} HP`, 'is-hp'),
            el('span', { class: 'pvp-row-sub', text: `Consumables ${fB.consumablesUsed}/${fB.consumablesMax}${fB.disconnected ? ' · Reconnecting' : ''}` }),
          ),
        ) : null,
        el('p', { class: 'pvp-muted', text: `Ring center (${active.center?.x ?? 0}, ${active.center?.z ?? 0}) · Radius ${active.radius}m · Non-lethal finish at 1 HP.` }),
        el('div', { class: 'pvp-actions' },
          el('button', { class: 'pvp-btn is-danger', type: 'button', text: 'Forfeit Duel', onclick: () => h.act('pvp.duel.forfeit') }),
        ),
      ),
    );
  }

  // Incoming Invites
  if (duel.incomingInvites?.length) {
    leftCol.append(
      el('section', { class: 'pvp-card is-verdigris' },
        el('div', { class: 'pvp-card-head' },
          el('h3', { class: 'pvp-card-title', text: 'Incoming Duel Challenges' }),
          el('span', { class: 'pvp-badge is-gold', text: `${duel.incomingInvites.length} Pending` }),
        ),
        el('div', { class: 'pvp-list' },
          duel.incomingInvites.map((inv) => el('div', { class: 'pvp-row' },
            el('div', { class: 'pvp-row-meta' },
              el('span', { class: 'pvp-row-name', text: inv.fromName }),
              el('span', { class: 'pvp-row-sub', text: `Ring ${inv.radius}m · Non-lethal 1 HP` }),
            ),
            el('div', { class: 'pvp-actions' },
              el('button', { class: 'pvp-btn is-primary', type: 'button', text: 'Accept', onclick: () => h.act('pvp.duel.accept', { inviteId: inv.id }) }),
              el('button', { class: 'pvp-btn', type: 'button', text: 'Decline', onclick: () => h.act('pvp.duel.decline', { inviteId: inv.id }) }),
            ),
          )),
        ),
      ),
    );
  }

  // Nearby Challengers
  leftCol.append(
    el('section', { class: 'pvp-card' },
      el('div', { class: 'pvp-card-head' },
        el('h3', { class: 'pvp-card-title', text: 'Challenge Nearby Traveller' }),
        el('span', { class: 'pvp-badge', text: `${nearbyDuelTargets.length} Nearby` }),
      ),
      nearbyDuelTargets.length
        ? el('div', { class: 'pvp-list' },
          nearbyDuelTargets.map((peer) => el('div', { class: 'pvp-row' },
            el('div', { class: 'pvp-row-meta' },
              el('span', { class: 'pvp-row-name', text: peer.name }),
              el('span', { class: 'pvp-row-sub', text: peer.className ? `Lv ${peer.level ?? 1} ${peer.className}` : `Player #${peer.id}` }),
            ),
            el('button', {
              class: 'pvp-btn is-primary',
              type: 'button',
              disabled: !!active,
              text: 'Duel',
              onclick: () => h.act('pvp.duel.invite', { targetId: peer.id }),
            }),
          )),
        )
        : el('p', { class: 'pvp-muted', text: 'No other travellers are within outdoor duel range right now.' }),
    ),
  );

  // Right column: Duel Record & Rules
  rightCol.append(
    el('section', { class: 'pvp-card' },
      el('div', { class: 'pvp-card-head' },
        el('h3', { class: 'pvp-card-title', text: 'Consent Duel Record' }),
        el('span', { class: 'pvp-badge', text: 'Non-Lethal' }),
      ),
      el('div', { class: 'pvp-stats' },
        el('div', { class: 'pvp-stat' }, el('span', { class: 'pvp-stat-label', text: 'Wins' }), el('span', { class: 'pvp-stat-val is-verdigris', text: duel.stats?.wins ?? 0 })),
        el('div', { class: 'pvp-stat' }, el('span', { class: 'pvp-stat-label', text: 'Losses' }), el('span', { class: 'pvp-stat-val', text: duel.stats?.losses ?? 0 })),
        el('div', { class: 'pvp-stat' }, el('span', { class: 'pvp-stat-label', text: 'Draws' }), el('span', { class: 'pvp-stat-val', text: duel.stats?.draws ?? 0 })),
      ),
      el('ul', { class: 'pvp-rules' },
        el('li', { text: 'Permitted in outdoor towns and wilderness; Town Watch ignores legal duels.' }),
        el('li', { text: 'Leaving the ring starts a 5s out-of-bounds forfeit countdown.' }),
        el('li', { text: 'Ends at 1 HP with full vitals restored; no item loss or death penalty.' }),
        el('li', { text: 'Brief disconnect rejoin window preserves interrupted fights.' }),
      ),
    ),
  );

  return el('div', { class: 'pvp-grid' }, leftCol, rightCol);
}

function renderArenaTab(view, h) {
  const { arena } = view;
  const active = arena.activeMatch;
  const rating = arena.rating ?? { elo: 1200, wins: 0, losses: 0, draws: 0, streak: 0, season: 1 };

  const leftCol = el('div', { class: 'pvp-col' });
  const rightCol = el('div', { class: 'pvp-col' });

  // Queue / Active Match Card
  if (active) {
    const [fA, fB] = active.fighters ?? [];
    leftCol.append(
      el('section', { class: 'pvp-card is-verdigris' },
        el('div', { class: 'pvp-card-head' },
          el('h3', { class: 'pvp-card-title', text: `${active.queueMode === 'ranked' ? 'Ranked' : 'Practice'} 1v1 Arena` }),
          el('span', {
            class: `pvp-badge ${active.isSpectator ? 'is-gold' : 'is-ok'}`,
            text: active.isSpectator ? `Spectating · ${active.spectatorCount} Viewers` : `${active.phase.toUpperCase()}`,
          }),
        ),
        fA && fB ? el('div', { class: 'pvp-vs' },
          el('div', { class: 'pvp-col' },
            el('div', { class: 'pvp-row-name', text: `${fA.name} (${fA.elo})` }),
            meter((fA.hp / Math.max(1, fA.maxHp)) * 100, `${fA.hp}/${fA.maxHp} HP`, 'is-hp'),
          ),
          el('div', { class: 'pvp-vs-center', text: active.phase === 'countdown' ? fmtSec(active.countdownMsLeft) : fmtSec(active.timeRemainingMs) }),
          el('div', { class: 'pvp-col' },
            el('div', { class: 'pvp-row-name', text: `${fB.name} (${fB.elo})` }),
            meter((fB.hp / Math.max(1, fB.maxHp)) * 100, `${fB.hp}/${fB.maxHp} HP`, 'is-hp'),
          ),
        ) : null,
        el('div', { class: 'pvp-actions' },
          active.phase === 'accept' && active.isFighter ? [
            el('button', { class: 'pvp-btn is-primary', type: 'button', text: `Accept Match (${fmtSec(active.acceptMsLeft)})`, onclick: () => h.act('pvp.arena.accept', { matchId: active.id }) }),
            el('button', { class: 'pvp-btn is-danger', type: 'button', text: 'Decline', onclick: () => h.act('pvp.arena.decline') }),
          ] : null,
          active.isFighter && active.phase !== 'accept'
            ? el('button', { class: 'pvp-btn is-danger', type: 'button', text: 'Surrender Match', onclick: () => h.act('pvp.arena.forfeit') })
            : null,
          active.isSpectator
            ? el('button', { class: 'pvp-btn', type: 'button', text: 'Leave Gallery', onclick: () => h.act('pvp.arena.leaveSpectate') })
            : null,
        ),
      ),
    );
  } else {
    leftCol.append(
      el('section', { class: 'pvp-card is-verdigris' },
        el('div', { class: 'pvp-card-head' },
          el('h3', { class: 'pvp-card-title', text: 'Grand Arena 1v1 Queue' }),
          arena.queue
            ? el('span', { class: 'pvp-badge is-gold', text: `Queued: ${arena.queue.mode}` })
            : el('span', { class: 'pvp-badge', text: `Season ${rating.season ?? 1}` }),
        ),
        el('div', { class: 'pvp-stats' },
          el('div', { class: 'pvp-stat' }, el('span', { class: 'pvp-stat-label', text: 'Elo Rating' }), el('span', { class: 'pvp-stat-val is-gold', text: rating.elo })),
          el('div', { class: 'pvp-stat' }, el('span', { class: 'pvp-stat-label', text: 'Wins' }), el('span', { class: 'pvp-stat-val is-verdigris', text: rating.wins })),
          el('div', { class: 'pvp-stat' }, el('span', { class: 'pvp-stat-label', text: 'Losses' }), el('span', { class: 'pvp-stat-val', text: rating.losses })),
          el('div', { class: 'pvp-stat' }, el('span', { class: 'pvp-stat-label', text: 'Streak' }), el('span', { class: 'pvp-stat-val', text: rating.streak })),
        ),
        el('p', { class: 'pvp-muted', text: `In Queue — Ranked: ${arena.queueCounts?.ranked ?? 0} · Practice: ${arena.queueCounts?.practice ?? 0}. Isolated arena scene with Elo persistence.` }),
        el('div', { class: 'pvp-actions' },
          arena.queue
            ? el('button', { class: 'pvp-btn is-danger', type: 'button', text: 'Leave Queue', onclick: () => h.act('pvp.arena.dequeue') })
            : [
              el('button', { class: 'pvp-btn is-primary', type: 'button', text: 'Queue Ranked 1v1', onclick: () => h.act('pvp.arena.queue', { mode: 'ranked' }) }),
              el('button', { class: 'pvp-btn', type: 'button', text: 'Queue Practice', onclick: () => h.act('pvp.arena.queue', { mode: 'practice' }) }),
            ],
        ),
      ),
    );
  }

  // Spectator Live Matches
  leftCol.append(
    el('section', { class: 'pvp-card' },
      el('div', { class: 'pvp-card-head' },
        el('h3', { class: 'pvp-card-title', text: 'Spectator Viewing Gallery' }),
        el('span', { class: 'pvp-badge', text: `${arena.liveMatches?.length ?? 0} Live` }),
      ),
      arena.liveMatches?.length
        ? el('div', { class: 'pvp-list' },
          arena.liveMatches.map((m) => {
            const [a, b] = m.fighters ?? [];
            return el('div', { class: 'pvp-row' },
              el('div', { class: 'pvp-row-meta' },
                el('span', { class: 'pvp-row-name', text: `${a?.name ?? '?'} (${a?.elo ?? 1200}) vs ${b?.name ?? '?'} (${b?.elo ?? 1200})` }),
                el('span', { class: 'pvp-row-sub', text: `${m.queueMode.toUpperCase()} · ${m.spectatorCount} spectators · ${fmtSec(m.timeRemainingMs)}` }),
              ),
              el('button', {
                class: 'pvp-btn is-primary',
                type: 'button',
                disabled: !!active,
                text: 'Spectate',
                onclick: () => h.act('pvp.arena.spectate', { matchId: m.id }),
              }),
            );
          }),
        )
        : el('p', { class: 'pvp-muted', text: 'No live arena matches are currently in progress.' }),
    ),
  );

  // Right Column: Ranked Elo Leaderboard
  rightCol.append(
    el('section', { class: 'pvp-card' },
      el('div', { class: 'pvp-card-head' },
        el('h3', { class: 'pvp-card-title', text: 'Season Elo Leaderboard' }),
        el('button', { class: 'pvp-btn', type: 'button', text: 'Refresh', onclick: () => h.act('pvp.arena.leaderboard') }),
      ),
      arena.leaderboard?.length
        ? el('table', { class: 'pvp-table' },
          el('thead', {}, el('tr', {}, el('th', { text: '#' }), el('th', { text: 'Gladiator' }), el('th', { text: 'Elo' }), el('th', { text: 'W-L-D' }))),
          el('tbody', {}, arena.leaderboard.map((row, idx) => el('tr', {},
            el('td', { text: idx + 1 }),
            el('td', { text: row.name }),
            el('td', { text: row.elo }),
            el('td', { text: `${row.wins}-${row.losses}-${row.draws}` }),
          ))),
        )
        : el('p', { class: 'pvp-muted', text: 'No rated arena matches recorded yet this season.' }),
    ),
  );

  return el('div', { class: 'pvp-grid' }, leftCol, rightCol);
}

function renderDistrictTab(view, h) {
  const { district, warning } = view;
  const tagged = (district.combatTagMsLeft ?? 0) > 0;
  const prot = (district.respawnProtectMsLeft ?? 0) > 0;
  const score = district.score ?? { honor: 0, kills: 0, deaths: 0, streak: 0, bestStreak: 0 };

  const leftCol = el('div', { class: 'pvp-col' });
  const rightCol = el('div', { class: 'pvp-col' });

  leftCol.append(
    el('section', { class: `pvp-card ${district.flagged || tagged ? 'is-danger' : 'is-verdigris'}` },
      el('div', { class: 'pvp-card-head' },
        el('h3', { class: 'pvp-card-title', text: district.districtName }),
        district.inDistrict
          ? el('span', { class: `pvp-badge ${district.inSafeZone ? 'is-ok' : 'is-danger'}`, text: district.inSafeZone ? 'Safe Gate' : 'Open PvP Armed' })
          : el('span', { class: 'pvp-badge', text: `${district.occupantCount ?? 0} Inside` }),
      ),
      tagged ? meter(Math.min(100, (district.combatTagMsLeft / 15000) * 100), `COMBAT TAGGED — ${fmtSec(district.combatTagMsLeft)} (Exit & Switch Locked)`, 'is-danger') : null,
      prot ? el('span', { class: 'pvp-badge is-ok', text: `Respawn Protection: ${fmtSec(district.respawnProtectMsLeft)}` }) : null,
      el('ul', { class: 'pvp-rules' },
        el('li', { text: 'Explicit boundary warning required before crossing into Bloodmarket Ward.' }),
        el('li', { text: 'Step past the 8m safe entrance gate to arm open PvP.' }),
        el('li', { text: 'Combat-tag timer (15s) blocks safe exit, Recall, travel, and character switching.' }),
        el('li', { text: 'Carried inventory is retained on defeat; safe respawn outside with brief protection.' }),
      ),
      warning ? el('p', { class: 'pvp-status-line', text: warning.text }) : null,
      el('div', { class: 'pvp-actions' },
        district.inDistrict
          ? el('button', {
            class: 'pvp-btn is-primary',
            type: 'button',
            disabled: tagged,
            text: tagged ? `Exit Locked (${fmtSec(district.combatTagMsLeft)})` : 'Safe Exit to Gothway Garden',
            onclick: () => h.act('pvp.district.exit'),
          })
          : el('button', {
            class: 'pvp-btn is-danger',
            type: 'button',
            text: 'Acknowledge Warning & Enter Open PvP Ward',
            onclick: () => h.act('pvp.district.enter', { acknowledgeWarning: true }),
          }),
      ),
    ),
  );

  rightCol.append(
    el('section', { class: 'pvp-card' },
      el('div', { class: 'pvp-card-head' },
        el('h3', { class: 'pvp-card-title', text: 'Honor & Ward Standings' }),
        el('span', { class: 'pvp-badge is-gold', text: `${score.honor} Honor` }),
      ),
      el('div', { class: 'pvp-stats' },
        el('div', { class: 'pvp-stat' }, el('span', { class: 'pvp-stat-label', text: 'Honor' }), el('span', { class: 'pvp-stat-val is-gold', text: score.honor })),
        el('div', { class: 'pvp-stat' }, el('span', { class: 'pvp-stat-label', text: 'Kills' }), el('span', { class: 'pvp-stat-val is-verdigris', text: score.kills })),
        el('div', { class: 'pvp-stat' }, el('span', { class: 'pvp-stat-label', text: 'Deaths' }), el('span', { class: 'pvp-stat-val', text: score.deaths })),
        el('div', { class: 'pvp-stat' }, el('span', { class: 'pvp-stat-label', text: 'Best Streak' }), el('span', { class: 'pvp-stat-val', text: score.bestStreak })),
      ),
      district.leaderboard?.length
        ? el('table', { class: 'pvp-table' },
          el('thead', {}, el('tr', {}, el('th', { text: '#' }), el('th', { text: 'Champion' }), el('th', { text: 'Honor' }), el('th', { text: 'K/D' }))),
          el('tbody', {}, district.leaderboard.map((row, idx) => el('tr', {},
            el('td', { text: idx + 1 }),
            el('td', { text: row.name }),
            el('td', { text: row.honor }),
            el('td', { text: `${row.kills}/${row.deaths}` }),
          ))),
        )
        : el('p', { class: 'pvp-muted', text: 'No Bloodmarket Ward honor recorded yet.' }),
    ),
  );

  return el('div', { class: 'pvp-grid' }, leftCol, rightCol);
}

function renderSiegeTab(view, h) {
  const { siege } = view;
  const tenure = siege.tenure ?? {};
  const active = siege.activeSiege;

  const leftCol = el('div', { class: 'pvp-col' });
  const rightCol = el('div', { class: 'pvp-col' });

  // Seat Tenure & Active Window
  leftCol.append(
    el('section', { class: 'pvp-card is-verdigris' },
      el('div', { class: 'pvp-card-head' },
        el('h3', { class: 'pvp-card-title', text: tenure.seatName ?? 'Castle Gothway' }),
        el('span', { class: 'pvp-badge is-gold', text: tenure.holderOrderTag ? `[${tenure.holderOrderTag}] ${tenure.holderOrderName}` : 'Unclaimed Garrison' }),
      ),
      el('div', { class: 'pvp-stats' },
        el('div', { class: 'pvp-stat' }, el('span', { class: 'pvp-stat-label', text: 'Defenses' }), el('span', { class: 'pvp-stat-val is-verdigris', text: tenure.defenses ?? 0 })),
        el('div', { class: 'pvp-stat' }, el('span', { class: 'pvp-stat-label', text: 'Prestige' }), el('span', { class: 'pvp-stat-val is-gold', text: tenure.prestige ?? 0 })),
        el('div', { class: 'pvp-stat' }, el('span', { class: 'pvp-stat-label', text: 'Heraldry' }), el('span', { class: 'pvp-stat-val', text: tenure.heraldry ?? 'Standard' })),
      ),
      active ? [
        el('div', { class: 'pvp-vs' },
          el('div', { class: 'pvp-col' },
            el('span', { class: 'pvp-stat-label', text: 'Attackers' }),
            el('span', { class: 'pvp-row-name', text: active.attackerOrder ? `[${active.attackerOrder.tag}] ${active.attackerOrder.name}` : 'Open Slot' }),
            el('span', { class: 'pvp-row-sub', text: `Roster ${active.frozenRosterCounts?.attacker ?? 0} · Field ${active.onFieldCounts?.attacker ?? 0}/${active.teamCap} · Score ${active.scores?.attacker ?? 0}` }),
          ),
          el('div', { class: 'pvp-vs-center', text: `${active.phase.toUpperCase()}\n${fmtSec(active.timeRemainingMs)}` }),
          el('div', { class: 'pvp-col' },
            el('span', { class: 'pvp-stat-label', text: 'Defenders' }),
            el('span', { class: 'pvp-row-name', text: active.defenderOrder ? `[${active.defenderOrder.tag}] ${active.defenderOrder.name}` : 'Castle Garrison' }),
            el('span', { class: 'pvp-row-sub', text: `Roster ${active.frozenRosterCounts?.defender ?? 0} · Field ${active.onFieldCounts?.defender ?? 0}/${active.teamCap} · Score ${active.scores?.defender ?? 0}` }),
          ),
        ),
        meter((active.captureProgress / Math.max(1, active.captureGoal)) * 100, `Keep Capture Point: ${active.captureProgress}% / ${active.captureGoal}%`, 'is-capture'),
      ] : el('p', { class: 'pvp-muted', text: 'No siege window is currently scheduled for Castle Gothway.' }),
      el('div', { class: 'pvp-actions' },
        !active || active.phase === 'ended'
          ? el('button', { class: 'pvp-btn is-primary', type: 'button', text: 'Schedule Siege Window', onclick: () => h.act('pvp.siege.schedule') })
          : null,
        active?.phase === 'scheduled' ? [
          el('button', { class: 'pvp-btn is-danger', type: 'button', text: 'Register as Attacker', onclick: () => h.act('pvp.siege.register', { siegeId: active.id, side: 'attacker' }) }),
          el('button', { class: 'pvp-btn is-primary', type: 'button', text: 'Register as Defender', onclick: () => h.act('pvp.siege.register', { siegeId: active.id, side: 'defender' }) }),
        ] : null,
        (active?.phase === 'locked' || active?.phase === 'active') && !active.myTeam
          ? el('button', { class: 'pvp-btn is-primary', type: 'button', text: 'Enter Siege Battle', onclick: () => h.act('pvp.siege.enter', { siegeId: active.id }) })
          : null,
        active?.myTeam
          ? el('button', { class: 'pvp-btn is-danger', type: 'button', text: 'Withdraw from Battle', onclick: () => h.act('pvp.siege.leave') })
          : null,
      ),
    ),
  );

  // Right Column: Order Standings
  rightCol.append(
    el('section', { class: 'pvp-card' },
      el('div', { class: 'pvp-card-head' },
        el('h3', { class: 'pvp-card-title', text: 'Order Siege Standings' }),
        el('span', { class: 'pvp-badge', text: 'Frozen Rosters' }),
      ),
      siege.standings?.length
        ? el('table', { class: 'pvp-table' },
          el('thead', {}, el('tr', {}, el('th', { text: 'Order' }), el('th', { text: 'W-L' }), el('th', { text: 'Cap/Def' }), el('th', { text: 'Prestige' }))),
          el('tbody', {}, siege.standings.map((row) => el('tr', {},
            el('td', { text: `[${row.orderTag}] ${row.orderName}` }),
            el('td', { text: `${row.wins}-${row.losses}` }),
            el('td', { text: `${row.captures}/${row.defenses}` }),
            el('td', { text: row.prestige }),
          ))),
        )
        : el('p', { class: 'pvp-muted', text: 'No Order sieges completed yet.' }),
      el('ul', { class: 'pvp-rules' },
        el('li', { text: 'Order Leaders and Officers register before roster lock time.' }),
        el('li', { text: 'Eligible rosters freeze at lock time; late recruits wait for the next siege.' }),
        el('li', { text: 'Attackers secure the Keep Capture Point to 100%; defenders win at time expiry.' }),
      ),
    ),
  );

  return el('div', { class: 'pvp-grid' }, leftCol, rightCol);
}

// ------------------------------------------------------------------ Public Panel & HUD Renderers

export function renderPvpPanel(container, view, handlers = {}) {
  const h = {
    act: handlers.act ?? (() => {}),
    selectTab: handlers.selectTab ?? (() => {}),
  };
  const root = el('div', { class: 'pvp-root' },
    el('div', { class: 'pvp-tabs', role: 'tablist' },
      TABS.map((t) => {
        let badge = null;
        if (t.id === 'duel' && (view.duel.active || view.duel.incomingInvites?.length)) {
          badge = el('span', { class: 'pvp-badge is-danger', text: view.duel.active ? 'LIVE' : view.duel.incomingInvites.length });
        } else if (t.id === 'arena' && (view.arena.activeMatch || view.arena.queue)) {
          badge = el('span', { class: 'pvp-badge is-gold', text: view.arena.activeMatch ? 'MATCH' : 'Q' });
        } else if (t.id === 'district' && (view.district.inDistrict || view.district.combatTagMsLeft > 0)) {
          badge = el('span', { class: 'pvp-badge is-danger', text: view.district.combatTagMsLeft > 0 ? 'TAG' : 'IN' });
        } else if (t.id === 'siege' && view.siege.activeSiege && view.siege.activeSiege.phase !== 'ended') {
          badge = el('span', { class: 'pvp-badge is-gold', text: view.siege.activeSiege.phase.toUpperCase() });
        }
        return el('button', {
          class: `pvp-tab-btn${view.tab === t.id ? ' is-active' : ''}`,
          type: 'button',
          role: 'tab',
          'aria-selected': view.tab === t.id ? 'true' : 'false',
          onclick: () => h.selectTab(t.id),
        }, t.label, badge);
      }),
    ),
    el('p', { class: 'pvp-status-line', text: view.status || '' }),
    view.tab === 'duel'
      ? renderDuelTab(view, h)
      : view.tab === 'arena'
        ? renderArenaTab(view, h)
        : view.tab === 'district'
          ? renderDistrictTab(view, h)
          : renderSiegeTab(view, h),
  );
  container.replaceChildren(root);
  return root;
}

/**
 * Renders compact in-world floating HUD cards for active PvP states:
 * Duel invite/countdown/ring indicator, Ranked Arena match/spectator HUD,
 * Open PvP District badge/combat timer, and Order Siege capture progress HUD.
 */
export function renderPvpHud(host, view, handlers = {}) {
  const h = { act: handlers.act ?? (() => {}) };
  const cards = [];

  // 1. Incoming Duel Invite HUD Card
  const inv = view.duel?.incomingInvites?.[0];
  if (inv && !view.duel.active) {
    cards.push(el('div', { class: 'pvp-hud-card', 'data-pvp-hud': 'duel-invite' },
      el('div', { class: 'pvp-hud-head' },
        el('span', { class: 'pvp-hud-title', text: 'Duel Challenge' }),
        el('span', { class: 'pvp-badge is-gold', text: `${inv.radius}m Ring` }),
      ),
      el('p', { class: 'pvp-muted', text: `${inv.fromName} challenges you to a non-lethal duel (1 HP finish).` }),
      el('div', { class: 'pvp-actions' },
        el('button', { class: 'pvp-btn is-primary', type: 'button', text: 'Accept', onclick: () => h.act('pvp.duel.accept', { inviteId: inv.id }) }),
        el('button', { class: 'pvp-btn', type: 'button', text: 'Decline', onclick: () => h.act('pvp.duel.decline', { inviteId: inv.id }) }),
      ),
    ));
  }

  // 2. Active Duel Countdown / Ring HUD Card
  const d = view.duel?.active;
  if (d) {
    const [a, b] = d.participants ?? [];
    const oob = (d.participants ?? []).find((f) => f.oobRemainingSec != null);
    cards.push(el('div', { class: `pvp-hud-card${oob ? ' is-danger' : ''}`, 'data-pvp-hud': 'duel-active' },
      el('div', { class: 'pvp-hud-head' },
        el('span', { class: 'pvp-hud-title', text: d.phase === 'countdown' ? `Duel Countdown · ${fmtSec(d.countdownMsLeft)}` : 'Consent Duel' }),
        el('span', { class: `pvp-badge ${oob ? 'is-danger' : 'is-ok'}`, text: oob ? `OOB ${oob.oobRemainingSec}s` : `Ring ${d.radius}m` }),
      ),
      a && b ? el('div', { class: 'pvp-list' },
        meter((a.hp / Math.max(1, a.maxHp)) * 100, `${a.name}: ${a.hp}/${a.maxHp} HP`, 'is-hp'),
        meter((b.hp / Math.max(1, b.maxHp)) * 100, `${b.name}: ${b.hp}/${b.maxHp} HP`, 'is-hp'),
      ) : null,
    ));
  }

  // 3. Ranked Arena Match / Queue / Spectator HUD Card
  const am = view.arena?.activeMatch;
  if (am) {
    const [a, b] = am.fighters ?? [];
    cards.push(el('div', { class: 'pvp-hud-card', 'data-pvp-hud': 'arena-active' },
      el('div', { class: 'pvp-hud-head' },
        el('span', { class: 'pvp-hud-title', text: `${am.queueMode === 'ranked' ? 'Ranked' : 'Practice'} Arena` }),
        el('span', { class: `pvp-badge ${am.isSpectator ? 'is-gold' : 'is-ok'}`, text: am.isSpectator ? 'Spectator' : am.phase.toUpperCase() }),
      ),
      a && b ? el('div', { class: 'pvp-list' },
        meter((a.hp / Math.max(1, a.maxHp)) * 100, `${a.name} (${a.elo}): ${a.hp}/${a.maxHp}`, 'is-hp'),
        meter((b.hp / Math.max(1, b.maxHp)) * 100, `${b.name} (${b.elo}): ${b.hp}/${b.maxHp}`, 'is-hp'),
      ) : null,
      am.phase === 'accept' && am.isFighter ? el('div', { class: 'pvp-actions' },
        el('button', { class: 'pvp-btn is-primary', type: 'button', text: `Accept (${fmtSec(am.acceptMsLeft)})`, onclick: () => h.act('pvp.arena.accept', { matchId: am.id }) }),
        el('button', { class: 'pvp-btn is-danger', type: 'button', text: 'Decline', onclick: () => h.act('pvp.arena.decline') }),
      ) : null,
    ));
  } else if (view.arena?.queue) {
    cards.push(el('div', { class: 'pvp-hud-card', 'data-pvp-hud': 'arena-queue' },
      el('div', { class: 'pvp-hud-head' },
        el('span', { class: 'pvp-hud-title', text: 'Arena Queue Active' }),
        el('span', { class: 'pvp-badge is-gold', text: view.arena.queue.mode.toUpperCase() }),
      ),
      el('div', { class: 'pvp-actions' },
        el('button', { class: 'pvp-btn is-danger', type: 'button', text: 'Leave Queue', onclick: () => h.act('pvp.arena.dequeue') }),
      ),
    ));
  }

  // 4. Open PvP District Badge & Combat Tag Timer HUD Card
  const dist = view.district;
  if (dist?.inDistrict || (dist?.combatTagMsLeft ?? 0) > 0) {
    const tagged = (dist.combatTagMsLeft ?? 0) > 0;
    cards.push(el('div', { class: `pvp-hud-card${dist.flagged || tagged ? ' is-danger' : ''}`, 'data-pvp-hud': 'district' },
      el('div', { class: 'pvp-hud-head' },
        el('span', { class: 'pvp-hud-title', text: dist.districtName }),
        el('span', { class: `pvp-badge ${dist.inSafeZone ? 'is-ok' : 'is-danger'}`, text: dist.inSafeZone ? 'Safe Gate' : 'Open PvP' }),
      ),
      tagged ? meter(Math.min(100, (dist.combatTagMsLeft / 15000) * 100), `Combat Tag: ${fmtSec(dist.combatTagMsLeft)}`, 'is-danger') : null,
      el('span', { class: 'pvp-row-sub', text: `Honor: ${dist.score?.honor ?? 0} · Streak: ${dist.score?.streak ?? 0}` }),
    ));
  }

  // 5. Active Order Siege Capture Progress HUD Card
  const sg = view.siege?.activeSiege;
  if (sg && (sg.myTeam || sg.phase === 'active')) {
    cards.push(el('div', { class: 'pvp-hud-card', 'data-pvp-hud': 'siege' },
      el('div', { class: 'pvp-hud-head' },
        el('span', { class: 'pvp-hud-title', text: `Siege: ${sg.seatName}` }),
        el('span', { class: 'pvp-badge is-gold', text: `${fmtSec(sg.timeRemainingMs)}` }),
      ),
      meter((sg.captureProgress / Math.max(1, sg.captureGoal)) * 100, `Keep Capture: ${sg.captureProgress}%`, 'is-capture'),
      el('span', { class: 'pvp-row-sub', text: `ATK ${sg.scores?.attacker ?? 0} (${sg.onFieldCounts?.attacker ?? 0}) vs DEF ${sg.scores?.defender ?? 0} (${sg.onFieldCounts?.defender ?? 0})` }),
    ));
  }

  host.replaceChildren(...cards);
  return host;
}

// ------------------------------------------------------------------ Mount Helpers & Installer

export function mountPvpPanel(container, api, opts = {}) {
  loadStyles();
  const cache = { tab: opts.initialTab ?? 'duel', status: '', pvpState: opts.initialState ?? null, districtWarning: null };
  const act = (verb, args = {}) => {
    try { return api?.act?.(verb, args); } catch (err) {
      cache.status = err?.message || String(err);
      render();
      return false;
    }
  };
  const render = () => renderPvpPanel(container, pvpView(api?.state ?? {}, cache), {
    act,
    selectTab: (tab) => { cache.tab = tab; render(); },
  });
  const onEvent = (ev) => {
    if (!ev || typeof ev.kind !== 'string' || !ev.kind.startsWith('pvp.')) return;
    if (ev.kind === 'pvp.state' && ev.state) cache.pvpState = ev.state;
    else if (ev.kind === 'pvp.districtWarning') cache.districtWarning = ev;
    else if (ev.text) cache.status = ev.text;
    render();
  };
  api?.on?.('event', onEvent);
  render();
  return { render, setState: (s) => { cache.pvpState = s; render(); }, setTab: (t) => { cache.tab = t; render(); } };
}

export function mountPvpHud(host, api, opts = {}) {
  loadStyles();
  host.classList.add('pvp-hud-host');
  const cache = { pvpState: opts.initialState ?? null };
  const act = (verb, args = {}) => api?.act?.(verb, args);
  const render = () => renderPvpHud(host, pvpView(api?.state ?? {}, cache), { act });
  api?.on?.('event', (ev) => {
    if (ev?.kind === 'pvp.state' && ev.state) {
      cache.pvpState = ev.state;
      render();
    }
  });
  render();
  return { render, setState: (s) => { cache.pvpState = s; render(); } };
}

export function install(api) {
  loadStyles();
  const cache = { tab: 'duel', status: '', pvpState: null, districtWarning: null };
  let panelContainer = null;
  let hudHost = null;

  const act = (verb, args = {}) => {
    try {
      return api.act(verb, args);
    } catch (err) {
      api.message?.(err?.message || String(err), { kind: 'error' });
      cache.status = err?.message || String(err);
      rerender();
      return false;
    }
  };

  function ensureHud() {
    if (typeof document === 'undefined') return null;
    if (!hudHost || !hudHost.isConnected) {
      hudHost = document.createElement('div');
      hudHost.className = 'pvp-hud-host';
      document.body.append(hudHost);
    }
    return hudHost;
  }

  function rerender() {
    const view = pvpView(api.state ?? {}, cache);
    if (panelContainer?.isConnected) {
      renderPvpPanel(panelContainer, view, {
        act,
        selectTab: (tab) => { cache.tab = tab; rerender(); },
      });
    }
    const hud = ensureHud();
    if (hud) renderPvpHud(hud, view, { act });
  }

  api.on?.('event', (ev) => {
    if (!ev || typeof ev.kind !== 'string' || !ev.kind.startsWith('pvp.')) return;
    if (ev.kind === 'pvp.state' && ev.state) {
      cache.pvpState = ev.state;
    } else if (ev.kind === 'pvp.districtWarning') {
      cache.districtWarning = ev;
    } else if (ev.text) {
      cache.status = ev.text;
      api.message?.(ev.text);
    }
    rerender();
  });

  api.on?.('state', () => rerender());
  api.on?.('characterChange', () => {
    cache.pvpState = null;
    cache.status = '';
    cache.districtWarning = null;
    rerender();
  });
  api.on?.('disconnect', () => {
    cache.pvpState = null;
    cache.status = '';
    cache.districtWarning = null;
    rerender();
  });

  if (typeof api.registerPanel === 'function') {
    api.registerPanel(PANEL_ID, 'Land PvP', (container) => {
      panelContainer = container;
      act('pvp.status');
      rerender();
    }, { watch: 'all' });
  }

  api.on?.('panel', (p) => {
    if (p && p.id === PANEL_ID && !p.open) panelContainer = null;
  });

  return { rerender, cache };
}

export default install;
