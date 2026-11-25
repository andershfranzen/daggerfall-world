// Captain's log, harbour board and spyglass in Play (server/rpg/admiralty.js). Loaded by ../sailing.js like the
// shipyard: `import('./sailing/admiralty.js').then((m) => m.install(api))`.
//
// Authority: renders only the server's admiralty.state / admiralty.glass snapshots. The spyglass keeps no clock of its
// own that matters: the server times the hold, the browser only repeats the look while the player keeps it raised.
// Colours: 'safe' ships read cool (blue-grey), 'hostile' ones red; the server decides which (services.admiralty.stanceFor).

export const PANEL_ID = 'admiralty';
const TITLE = 'Captain’s Log';
/** Looks sent while the glass is held: colours after 0.6 s, studied after 1.4 s (server constants), plus slack. */
export const GLASS_LOOKS_MS = Object.freeze([0, 700, 1500, 2300]);
export const STANCE_COLOURS = Object.freeze({ safe: '#8fb3c9', hostile: '#d0453a' });

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === 'string' && v ? v : null);
const list = (v) => (Array.isArray(v) ? v.filter(isObj) : []);

/** Normalise an admiralty.state event; null for anything else. */
export function readAdmiralty(ev) {
  if (!isObj(ev) || ev.kind !== 'admiralty.state') return null;
  const contract = (c) => ({
    id: String(c.id), kind: str(c.kind), region: str(c.region), portName: str(c.portName), title: str(c.title) ?? 'Contract',
    words: str(c.words) ?? '', pay: num(c.pay) ?? 0, standing: num(c.standing) ?? 0, status: str(c.status) ?? 'open',
    progress: str(c.progress) ?? '', left: str(c.left) ?? '', site: isObj(c.site) && Number.isFinite(c.site.x) ? { x: c.site.x, z: c.site.z, name: str(c.site.name) } : null,
  });
  const b = isObj(ev.board) ? ev.board : null;
  return {
    regions: list(ev.regions).filter((r) => str(r.region)).map((r) => ({
      region: r.region, standing: num(r.standing) ?? 0, title: str(r.title) ?? 'Unsworn', rank: num(r.rank) ?? 0,
      next: isObj(r.next) ? { title: str(r.next.title), wanting: num(r.next.wanting) } : null,
      notoriety: num(r.notoriety) ?? 0, anchors: Math.max(0, Math.min(4, num(r.anchors) ?? 0)), hunted: r.hunted === true,
    })),
    contracts: list(ev.contracts).filter((c) => c.id != null).map(contract),
    log: isObj(ev.log) ? ev.log : null,
    board: b && str(b.portId) ? {
      portId: b.portId, portName: str(b.portName) ?? b.portId, region: str(b.region), refused: str(b.refused),
      offers: list(b.offers).filter((o) => str(o.id)).map((o) => ({ id: o.id, kind: str(o.kind), title: str(o.title) ?? 'Notice', words: str(o.words) ?? '', pay: num(o.pay) ?? 0, days: num(o.days), taken: o.taken === true })),
    } : null,
    max: num(ev.max) ?? 3,
  };
}

/** Normalise an admiralty.sea event: casks within sight of the deck and the sites of held contracts. */
export function readSea(ev) {
  if (!isObj(ev) || ev.kind !== 'admiralty.sea') return null;
  const pt = (o) => Number.isFinite(o.x) && Number.isFinite(o.z);
  return {
    vesselId: str(ev.vesselId), reach: num(ev.reach) ?? 30, maxSpeed: num(ev.maxSpeed),
    casks: list(ev.casks).filter((c) => str(c.id) && pt(c)).map((c) => ({ id: c.id, x: c.x, z: c.z, kind: c.kind === 'wreck' ? 'wreck' : 'salvage', label: str(c.label) ?? 'A cask', haul: c.haul === true })),
    sites: list(ev.sites).filter((x) => str(x.id) && pt(x)).map((x) => ({ id: x.id, kind: x.kind === 'salvage' ? 'salvage' : 'bounty', x: x.x, z: x.z, name: str(x.name), radius: num(x.radius) ?? 300, shipId: str(x.shipId) })),
  };
}

/** Normalise an admiralty.glass card. */
export function readGlass(ev) {
  if (!isObj(ev) || ev.kind !== 'admiralty.glass' || ev.targetId == null) return null;
  return {
    targetId: String(ev.targetId), know: Math.max(0, Math.min(2, num(ev.know) ?? 0)), distance: num(ev.distance), hull: str(ev.hull) ?? 'ship',
    faction: str(ev.faction), title: str(ev.title), stance: ev.stance === 'hostile' ? 'hostile' : ev.stance === 'safe' ? 'safe' : null,
    hullHp: num(ev.hullHp), maxHull: num(ev.maxHull), crew: num(ev.crew), maxCrew: num(ev.maxCrew), state: str(ev.state),
    bounty: isObj(ev.bounty) ? { title: str(ev.bounty.title), pay: num(ev.bounty.pay) } : null,
  };
}

/** One line of what the glass shows, by knowledge. */
export function glassWords(g) {
  if (!g) return '';
  const range = g.distance != null ? ` at ${g.distance} m` : '';
  if (g.know === 0) return `A ${g.hull}${range}. Hold the glass on her.`;
  const who = g.title ?? `${g.faction ?? 'unknown'} ${g.hull}`;
  if (g.know === 1) return `${who}${range}, flying ${g.stance === 'hostile' ? 'hostile' : 'peaceful'} colours. Closer, and hold the glass, to study her.`;
  const hull = g.hullHp != null && g.maxHull ? ` Hull ${Math.round(100 * g.hullHp / g.maxHull)}%.` : '';
  const crew = g.crew != null ? ` ${g.crew} hands.` : '';
  return `${who}${range}.${hull}${crew}${g.bounty ? ` Wanted: ${g.bounty.title} (${g.bounty.pay} gp).` : ''}`;
}

const anchorsText = (n) => '⚓'.repeat(n) + '·'.repeat(4 - n);

export function install(api) {
  const doc = globalThis.document;
  const S = { adm: null, glass: null, glassTimers: [], contacts: [], busy: new Set(), sea: null, me: null };
  let root = null;

  const el = (tag, attrs = {}, ...kids) => {
    const n = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'text') n.textContent = v;
      else if (k === 'style') n.setAttribute('style', v);
      else n.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of kids.flat()) if (c != null) n.append(c instanceof Node ? c : doc.createTextNode(String(c)));
    return n;
  };
  const act = (id, verb, args = {}) => {
    if (S.busy.has(id)) return null;
    S.busy.add(id);
    const r = api.act(verb, args);
    const done = (out) => { S.busy.delete(id); if (out && !out.ok && out.error) api.message?.(out.error, { kind: 'error' }); draw(); return out; };
    return r ? r.then(done, () => done({ ok: false })) : done({ ok: false, error: 'Not connected' });
  };
  const button = (id, label, verb, args, primary = false) => el('button', { type: 'button', class: `tsv-btn${primary ? ' tsv-primary' : ''}`, disabled: S.busy.has(id) || null, onclick: () => act(id, verb, args), text: label });

  /** Raise the glass on a ship: repeated looks while held; the server times the hold. */
  function study(targetId) {
    for (const t of S.glassTimers) clearTimeout(t);
    S.glassTimers = GLASS_LOOKS_MS.map((ms) => setTimeout(() => {
      const r = api.act('admiralty.glass', { targetId }, { quiet: true });
      r?.then?.((out) => { if (out && !out.ok && out.error) { S.glass = { targetId, know: 0, error: out.error }; draw(); } });
    }, ms));
  }

  function render(into) {
    root = into;
    const a = S.adm;
    const box = (label, ...kids) => el('section', { class: 'tsv-box sail-box', 'aria-label': label }, el('h3', { class: 'tsv-h4', text: label }), ...kids);
    const dim = (t) => el('p', { class: 'tsv-dim tsv-small', text: t });
    const wrap = el('div', { class: 'tsv-root sail-panel adm-panel' });
    wrap.append(el('header', { class: 'tsv-head' }, el('h2', { class: 'tsv-h', text: TITLE }),
      el('p', { class: 'tsv-dim', text: a?.board ? `Harbourmaster's board: ${a.board.portName}` : 'Standing with the crowns of the Bay, and your contracts.' })));
    if (!a) { wrap.append(dim('Waiting for the harbourmaster…')); into.replaceChildren(wrap); return; }
    const cols = el('div', { class: 'tsv-cols' });

    cols.append(box('Standing', a.regions.length ? el('ul', { class: 'tsv-list adm-regions' }, a.regions.map((r) => el('li', { 'data-region': r.region },
      el('span', { class: 'tsv-name', text: `${r.region}: ${r.title}` }),
      el('span', { class: 'tsv-dim', text: ` ${r.standing}${r.next ? ` (${r.next.wanting} to ${r.next.title})` : ''}` }),
      r.notoriety ? el('span', { class: 'adm-notoriety', title: `Notoriety ${r.notoriety}`, style: `color:${r.hunted ? STANCE_COLOURS.hostile : STANCE_COLOURS.safe}`, text: ` ${anchorsText(r.anchors)}${r.hunted ? ' hunted' : ''}` }) : null)))
      : dim('No crown knows your name at sea yet.')));

    cols.append(box(`Contracts (${a.contracts.length}/${a.max})`, a.contracts.length ? el('ul', { class: 'tsv-list adm-contracts' }, a.contracts.map((c) => el('li', { 'data-contract': c.id, 'data-status': c.status },
      el('div', { class: 'tsv-name', text: c.title }), dim(c.words), dim(`${c.progress} · ${c.left} · ${c.pay} gp`),
      el('div', { class: 'tsv-row' },
        c.status === 'done' && a.board ? button(`claim:${c.id}`, `Claim ${c.pay} gp`, 'admiralty.claim', { contractId: c.id }, true) : null,
        button(`abandon:${c.id}`, c.status === 'void' ? 'Strike off' : 'Give up', 'admiralty.abandon', { contractId: c.id })))))
      : dim('No contracts. Harbourmasters post bounties, pirate hunts and spyglass surveys.')));

    if (a.board) {
      cols.append(box(`Board · ${a.board.portName}`, a.board.refused ? el('p', { class: 'adm-refused', style: `color:${STANCE_COLOURS.hostile}`, text: a.board.refused })
        : el('ul', { class: 'tsv-list adm-board' }, a.board.offers.map((o) => el('li', { 'data-offer': o.id },
          el('div', { class: 'tsv-name', text: o.title }), dim(o.words), dim(`${o.pay} gp · ${o.days} days`),
          o.taken ? dim('Taken.') : button(`take:${o.id}`, 'Take', 'admiralty.take', { offerId: o.id }, true))))));
    }

    if (S.sea && (S.sea.casks.length || S.sea.sites.length)) {
      const me = S.me;
      const dist = (c) => (me ? Math.round(Math.hypot(c.x - me.x, c.z - me.z)) : null);
      const casks = [...S.sea.casks].sort((x, y) => (dist(x) ?? 1e9) - (dist(y) ?? 1e9));
      cols.append(box('Salvage & sea', plot(),
        casks.length ? el('ul', { class: 'tsv-list adm-casks' }, casks.slice(0, 8).map((c) => el('li', { 'data-cask': c.id, 'data-kind': c.kind },
          el('span', { text: `${c.label}${dist(c) != null ? ` · ${dist(c)} m` : ''}` }),
          c.haul ? button(`haul:${c.id}`, 'Haul aboard', 'admiralty.haul', { caskId: c.id }, true) : null)))
          : dim('No casks in sight. Sail to a marked wreck.'),
        dim(`Come within ${S.sea.reach} m of a cask, hove to (under ${S.sea.maxSpeed ?? 2.5} m/s), and haul it aboard.`)));
    }

    const contacts = S.contacts.filter((c) => c.kind !== 'player' || c.id);
    cols.append(box('Spyglass', S.glass ? el('p', { class: 'adm-glass', 'data-know': S.glass.know, style: S.glass.stance ? `border-left:3px solid ${STANCE_COLOURS[S.glass.stance]};padding-left:6px` : null, text: S.glass.error ?? glassWords(S.glass) }) : null,
      contacts.length ? el('ul', { class: 'tsv-list adm-contacts' }, contacts.slice(0, 8).map((c) => el('li', {},
        el('span', { text: `${c.hull ?? 'ship'}${Number.isFinite(c.distance) ? ` · ${Math.round(c.distance)} m` : ''}` }),
        el('button', { type: 'button', class: 'tsv-btn', onclick: () => study(String(c.id)), text: 'Glass' }))))
        : dim('No sail in sight.')));

    if (a.log) {
      const L = a.log;
      const sum = (o) => Object.values(o ?? {}).reduce((x, y) => x + (Number(y) || 0), 0);
      cols.append(box('Log', dim(`Pirates ended: ${(L.sunk?.pirate ?? 0) + (L.taken?.pirate ?? 0)} · boarders repelled: ${L.repelled ?? 0}`),
        dim(`Lawful ships attacked: ${L.piracy ?? 0} · sunk: ${(L.sunk?.merchant ?? 0) + (L.sunk?.navy ?? 0)} · taken: ${(L.taken?.merchant ?? 0) + (L.taken?.navy ?? 0)}`),
        dim(`Contracts done: ${sum(L.contracts)} · failed: ${L.failed ?? 0} · earned: ${L.earned ?? 0} gp · plunder: ${L.plunder ?? 0} gp`)));
    }
    wrap.append(cols);
    into.replaceChildren(wrap);
  }
  const draw = () => { if (api.panel === PANEL_ID && root?.isConnected) render(root); };

  /** Local waters around the ship: north up, 2 km across. Own ship white, casks amber, sites as rings, ships by stance. */
  function plot() {
    const W = 260, H = 260, SPAN = 2000;
    const c = el('canvas', { width: W, height: H, class: 'adm-plot', 'aria-label': 'Local waters', style: 'display:block;margin:4px 0;border:1px solid #34475a;border-radius:4px;background:#0f1a24' });
    const g = c.getContext?.('2d');
    const me = S.me;
    if (!g || !me) return c;
    const k = W / SPAN;
    const at = (x, z) => [W / 2 + (x - me.x) * k, H / 2 + (z - me.z) * k];
    g.strokeStyle = '#22364a';
    for (const r of [250, 500, 750]) { g.beginPath(); g.arc(W / 2, H / 2, r * k, 0, Math.PI * 2); g.stroke(); }
    for (const s of S.sea?.sites ?? []) {
      const [x, y] = at(s.x, s.z);
      g.strokeStyle = s.kind === 'bounty' ? STANCE_COLOURS.hostile : '#d9b45a';
      g.setLineDash([4, 3]); g.beginPath(); g.arc(x, y, Math.max(4, s.radius * k), 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
    }
    for (const s of S.contacts) {
      const [x, y] = at(s.x, s.z);
      g.fillStyle = s.faction === 'pirate' ? STANCE_COLOURS.hostile : STANCE_COLOURS.safe;
      g.beginPath(); g.moveTo(x, y - 5); g.lineTo(x + 4, y + 4); g.lineTo(x - 4, y + 4); g.fill();
    }
    for (const q of S.sea?.casks ?? []) {
      const [x, y] = at(q.x, q.z);
      g.fillStyle = q.kind === 'salvage' ? '#e0b84f' : '#c58a3a';
      g.fillRect(x - 2.5, y - 2.5, 5, 5);
      if (q.haul) { g.strokeStyle = '#ffffff'; g.strokeRect(x - 5, y - 5, 10, 10); }
    }
    g.fillStyle = '#ffffff';
    g.beginPath(); g.arc(W / 2, H / 2, 4, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#8fb3c9'; g.font = '10px system-ui'; g.fillText('N', W / 2 - 3, 11); g.fillText('2 km', W - 30, H - 6);
    return c;
  }

  api.registerPanel?.(PANEL_ID, TITLE, (r) => render(r), { watch: 'none' });
  api.on('event', (ev) => {
    if (!ev || typeof ev.kind !== 'string') return;
    if (ev.kind === 'admiralty.state') { S.adm = readAdmiralty(ev); draw(); }
    else if (ev.kind === 'admiralty.glass') { S.glass = readGlass(ev); draw(); }
    else if (ev.kind === 'admiralty.sea') { S.sea = readSea(ev); api.emit?.('sailing:marks', S.sea); draw(); }
    // admiralty.news is not silent: the shell already shows its text once.
    else if (ev.kind === 'sailing.state' && isObj(ev.vessel) && Number.isFinite(ev.vessel.x)) { S.me = { x: ev.vessel.x, z: ev.vessel.z }; }
    else if (ev.kind === 'naval.state' && isObj(ev.self)) {
      const me = ev.self;
      if (Number.isFinite(me.x) && Number.isFinite(me.z)) S.me = { x: me.x, z: me.z };
      S.contacts = (Array.isArray(ev.contacts) ? ev.contacts : []).filter(isObj).map((c) => ({ ...c, distance: Number.isFinite(me.x) ? Math.hypot(c.x - me.x, c.z - me.z) : null }))
        .sort((x, y) => (x.distance ?? 1e9) - (y.distance ?? 1e9));
      if (api.panel === PANEL_ID) draw();
    }
  });
  api.on('connection', (s) => { if (s === 'online') api.act('admiralty.status', {}, { quiet: true }); });
  api.on('panel', (d) => { if (d?.open && d.id === PANEL_ID) api.act('admiralty.status', {}, { quiet: true }); });
  return { get state() { return S.adm; }, study, open: () => api.openPanel?.(PANEL_ID) };
}
