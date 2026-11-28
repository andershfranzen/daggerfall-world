// Co-op Party Quests: shared objectives, contribution tracking, and once-per-member rewards.
//
// Keeps classic personal quests completely untouched on their existing `rpg.quests` route.
// Party quests live in world state (`partyQuests/<questUid>`) plus per-character reward
// receipts (`rpg.partyQuests.receipts`), ensuring:
//   - Two or more party members share objective progress and contributions authoritatively.
//   - Leaving/rejoining a party, reconnecting, or restarting the server preserves progress
//     and guarantees each eligible member receives each intended reward exactly once.
//   - Dungeon-based party quests pin their `layoutId` via `services.smallerDungeons` when present.
//
// Actions:
//   partyQuest.board       {}
//   partyQuest.accept      { templateId, layoutMode? }
//   partyQuest.join        { uid }
//   partyQuest.contribute  { uid, amount?, kind?, note? }
//   partyQuest.handIn      { uid }
//   partyQuest.abandon     { uid }
//   partyQuest.sync        {}
//
// Services (ctx.services.partyQuests):
//   catalog, activeForParty, activeForPlayer, accept, contribute, handIn, getQuest

import { randomBytes } from 'node:crypto';

export const name = 'partyQuests';
export const WORLD_PREFIX = 'partyQuests/';

export const PARTY_QUEST_CATALOG = Object.freeze([
  Object.freeze({
    id: 'pq-peristair-purge',
    title: 'Purge of Peristair',
    summary: 'Clear hostile raiders from The Dungeon of Peristair together.',
    site: 'dungeon:Daggerfall/The Dungeon of Peristair',
    objectiveKind: 'slay',
    goal: 4,
    rewardGold: 250,
    rewardRenown: 20,
    rewardItem: { template: 'potion-of-healing', name: 'Potion of Healing', quantity: 1 },
    minPartySize: 2,
  }),
  Object.freeze({
    id: 'pq-gothway-patrol',
    title: 'Gothway Watch Patrol',
    summary: 'Secure the roads and ruins outside Gothway Garden as a company.',
    site: 'town:Daggerfall/Gothway Garden',
    objectiveKind: 'patrol',
    goal: 3,
    rewardGold: 160,
    rewardRenown: 12,
    rewardItem: null,
    minPartySize: 1,
  }),
  Object.freeze({
    id: 'pq-relic-recovery',
    title: 'Relic of the Bay',
    summary: 'Recover lost relics from an ancient crypt and return them together.',
    site: 'dungeon:Daggerfall/The Dungeon of Peristair',
    objectiveKind: 'recover',
    goal: 2,
    rewardGold: 320,
    rewardRenown: 30,
    rewardItem: { template: 'iron-dagger', name: 'Relic-Bound Dagger', quantity: 1 },
    minPartySize: 2,
  }),
]);

const TEMPLATE_BY_ID = new Map(PARTY_QUEST_CATALOG.map((q) => [q.id, q]));

function ensurePlayerPartyQuestState(p) {
  if (!p.rpg || typeof p.rpg !== 'object') p.rpg = {};
  const cur = p.rpg.partyQuests;
  if (!cur || typeof cur !== 'object') {
    p.rpg.partyQuests = { activeUids: [], receipts: {} };
  } else {
    if (!Array.isArray(cur.activeUids)) cur.activeUids = [];
    if (!cur.receipts || typeof cur.receipts !== 'object') cur.receipts = {};
  }
  return p.rpg.partyQuests;
}

export function install(ctx) {
  const services = (ctx.services ||= {});
  const quests = new Map(); // uid -> party quest record

  for (const [k, v] of ctx.loadWorld?.(WORLD_PREFIX) ?? []) {
    if (v && typeof v === 'object' && typeof v.uid === 'string') {
      quests.set(k.slice(WORLD_PREFIX.length), hydrate(v));
    }
  }

  function hydrate(raw) {
    return {
      uid: String(raw.uid),
      templateId: String(raw.templateId),
      title: String(raw.title ?? 'Party Quest'),
      summary: String(raw.summary ?? ''),
      site: String(raw.site ?? ''),
      layoutId: raw.layoutId ? String(raw.layoutId) : null,
      objectiveKind: String(raw.objectiveKind ?? 'slay'),
      goal: Math.max(1, Number(raw.goal) || 1),
      progress: Math.max(0, Number(raw.progress) || 0),
      partyId: String(raw.partyId),
      leaderId: Number(raw.leaderId),
      participants: Array.isArray(raw.participants) ? [...new Set(raw.participants.map(Number).filter(Number.isSafeInteger))] : [],
      contributions: raw.contributions && typeof raw.contributions === 'object' ? { ...raw.contributions } : {},
      claimedBy: Array.isArray(raw.claimedBy) ? [...new Set(raw.claimedBy.map(Number).filter(Number.isSafeInteger))] : [],
      status: raw.status === 'ready' || raw.status === 'completed' || raw.status === 'abandoned' ? raw.status : 'active',
      rewardGold: Math.max(0, Number(raw.rewardGold) || 0),
      rewardRenown: Math.max(0, Number(raw.rewardRenown) || 0),
      rewardItem: raw.rewardItem ? { ...raw.rewardItem } : null,
      markers: Array.isArray(raw.markers) ? raw.markers.map((m) => ({ ...m })) : [],
      createdAt: Number(raw.createdAt) || 0,
      updatedAt: Number(raw.updatedAt) || 0,
    };
  }

  function saveQuest(q) {
    const prev = quests.has(q.uid) ? structuredClone(quests.get(q.uid)) : null;
    q.updatedAt = Math.trunc(ctx.now?.() ?? Date.now());
    quests.set(q.uid, q);
    ctx.dirtyWorld?.(`${WORLD_PREFIX}${q.uid}`, q);
    ctx.onRollback?.(() => {
      if (prev) quests.set(q.uid, prev);
      else quests.delete(q.uid);
    });
  }

  function partyOf(p) {
    try {
      const live = services.partyOf?.(p);
      if (live) return live;
    } catch { /* fallback to saved rpg.party */ }
    const saved = p?.rpg?.party;
    if (saved && saved.id && Array.isArray(saved.members)) {
      return {
        id: saved.id,
        leaderId: saved.leaderId,
        memberIds: saved.members.map((m) => m.id),
      };
    }
    return null;
  }

  function viewOf(q, viewerId) {
    return {
      uid: q.uid,
      templateId: q.templateId,
      title: q.title,
      summary: q.summary,
      site: q.site,
      layoutId: q.layoutId,
      objectiveKind: q.objectiveKind,
      progress: q.progress,
      goal: q.goal,
      status: q.status,
      partyId: q.partyId,
      leaderId: q.leaderId,
      participants: [...q.participants],
      contributions: { ...q.contributions },
      claimed: q.claimedBy.includes(viewerId),
      claimedCount: q.claimedBy.length,
      rewardGold: q.rewardGold,
      rewardRenown: q.rewardRenown,
      rewardItem: q.rewardItem ? { ...q.rewardItem } : null,
      markers: q.markers.map((m) => ({ ...m })),
    };
  }

  function activeForPlayer(p) {
    const party = partyOf(p);
    const out = [];
    for (const q of quests.values()) {
      if (q.status === 'abandoned') continue;
      const inParticipants = q.participants.includes(p.id);
      const inParty = party && party.id === q.partyId;
      if (inParticipants || inParty) out.push(q);
    }
    return out;
  }

  function notifyParticipants(q, text, extra = {}) {
    const recipients = new Set(q.participants);
    for (const p of ctx.players.values()) {
      const party = partyOf(p);
      if (recipients.has(p.id) || (party && party.id === q.partyId)) {
        ctx.notify(p, {
          kind: 'partyQuest',
          quest: viewOf(q, p.id),
          quests: activeForPlayer(p).map((x) => viewOf(x, p.id)),
          ...(text ? { text } : {}),
          ...extra,
        });
      }
    }
  }

  function grantRewardOnce(p, q) {
    const st = ensurePlayerPartyQuestState(p);
    const receiptKey = `${q.uid}:${p.id}`;
    if (q.claimedBy.includes(p.id) || st.receipts[receiptKey]) {
      throw new Error('You have already claimed your reward for this party quest.');
    }
    const eligible = q.participants.includes(p.id) || Number(q.contributions[p.id] ?? 0) > 0;
    if (!eligible) throw new Error('Only party quest participants may claim this reward.');

    ctx.dirty(p);
    if (q.rewardGold > 0) {
      if (typeof services.addGold === 'function') services.addGold(p, q.rewardGold);
      else p.rpg.gold = (Number(p.rpg.gold) || 0) + q.rewardGold;
    }
    let grantedItem = null;
    if (q.rewardItem) {
      if (typeof services.giveItem === 'function') {
        try {
          grantedItem = services.giveItem(p, q.rewardItem.template, { quantity: q.rewardItem.quantity ?? 1, name: q.rewardItem.name });
        } catch { /* fallback if template absent in lightweight test */ }
      }
      if (!grantedItem) {
        if (!Array.isArray(p.rpg.inventory)) p.rpg.inventory = [];
        grantedItem = {
          id: `pq_${q.uid}_${p.id}_${randomBytes(3).toString('hex')}`,
          template: q.rewardItem.template,
          name: q.rewardItem.name,
          quantity: q.rewardItem.quantity ?? 1,
          source: 'partyQuest',
        };
        p.rpg.inventory.push(grantedItem);
      }
    }
    if (q.rewardRenown > 0) {
      services.optionalRules?.awardRenown?.(p, q.rewardRenown, `partyQuest:${q.templateId}`);
    }

    q.claimedBy.push(p.id);
    st.receipts[receiptKey] = {
      uid: q.uid,
      templateId: q.templateId,
      gold: q.rewardGold,
      renown: q.rewardRenown,
      itemId: grantedItem?.id ?? null,
      claimedAt: Math.trunc(ctx.now?.() ?? Date.now()),
    };
    st.activeUids = st.activeUids.filter((u) => u !== q.uid);
    if (q.participants.every((id) => q.claimedBy.includes(id))) {
      q.status = 'completed';
    }
    saveQuest(q);
    return st.receipts[receiptKey];
  }

  function accept(p, templateId, opts = {}) {
    const tmpl = TEMPLATE_BY_ID.get(String(templateId ?? ''));
    if (!tmpl) throw new Error('Unknown party quest.');
    const party = partyOf(p);
    if (!party) throw new Error('You must be in a party to accept a party quest.');
    if (party.memberIds.length < tmpl.minPartySize) {
      throw new Error(`This party quest requires at least ${tmpl.minPartySize} party members.`);
    }
    const existing = [...quests.values()].find(
      (q) => q.partyId === party.id && q.templateId === tmpl.id && (q.status === 'active' || q.status === 'ready'),
    );
    if (existing) throw new Error('Your party already has this quest active.');

    let layoutId = null;
    let markers = [];
    if (tmpl.site.startsWith('dungeon:') && services.smallerDungeons?.selectLayout) {
      const layout = services.smallerDungeons.selectLayout(tmpl.site, { player: p, mode: opts.layoutMode });
      layoutId = layout.layoutId;
      markers = layout.questMarkers.map((m) => ({ ...m }));
    } else {
      markers = [{ id: `pqm:${tmpl.id}:0`, x: 4, y: 0, z: -4, kind: tmpl.objectiveKind, layoutId }];
    }

    const uid = `pq_${randomBytes(5).toString('hex')}`;
    const q = hydrate({
      uid,
      templateId: tmpl.id,
      title: tmpl.title,
      summary: tmpl.summary,
      site: tmpl.site,
      layoutId,
      objectiveKind: tmpl.objectiveKind,
      goal: tmpl.goal,
      progress: 0,
      partyId: party.id,
      leaderId: party.leaderId,
      participants: [...party.memberIds],
      contributions: Object.fromEntries(party.memberIds.map((id) => [id, 0])),
      claimedBy: [],
      status: 'active',
      rewardGold: tmpl.rewardGold,
      rewardRenown: tmpl.rewardRenown,
      rewardItem: tmpl.rewardItem,
      markers,
      createdAt: Math.trunc(ctx.now?.() ?? Date.now()),
    });
    saveQuest(q);

    for (const memberId of party.memberIds) {
      const m = ctx.players.get(memberId);
      if (!m) continue;
      ctx.dirty(m);
      const st = ensurePlayerPartyQuestState(m);
      if (!st.activeUids.includes(uid)) st.activeUids.push(uid);
      if (layoutId && tmpl.site.startsWith('dungeon:')) {
        services.smallerDungeons?.pinQuestLayout?.(m, uid, tmpl.site, { layoutId, mode: layoutId.startsWith('smaller:') ? 'smaller' : 'classic' });
      }
    }
    notifyParticipants(q, `Party accepted quest: ${q.title} (0/${q.goal}).`);
    return q;
  }

  function contribute(p, uid, amount = 1) {
    const q = quests.get(String(uid ?? ''));
    if (!q) throw new Error('Party quest not found.');
    if (q.status !== 'active') throw new Error(`Party quest "${q.title}" is already ${q.status}.`);
    const party = partyOf(p);
    const allowed = q.participants.includes(p.id) || (party && party.id === q.partyId);
    if (!allowed) throw new Error('You are not a participant in this party quest.');
    if (!q.participants.includes(p.id)) {
      q.participants.push(p.id);
      ctx.dirty(p);
      const st = ensurePlayerPartyQuestState(p);
      if (!st.activeUids.includes(q.uid)) st.activeUids.push(q.uid);
    }
    const delta = Math.max(1, Math.min(20, Math.trunc(Number(amount) || 1)));
    q.contributions[p.id] = (Number(q.contributions[p.id]) || 0) + delta;
    q.progress = Math.min(q.goal, q.progress + delta);
    if (q.progress >= q.goal) q.status = 'ready';
    saveQuest(q);
    const note = q.status === 'ready'
      ? `Party quest "${q.title}" objectives complete (${q.progress}/${q.goal})! Each member may now hand in for their reward.`
      : `${p.name} advanced "${q.title}" (${q.progress}/${q.goal}).`;
    notifyParticipants(q, note);
    return q;
  }

  function handIn(p, uid) {
    const q = quests.get(String(uid ?? ''));
    if (!q) throw new Error('Party quest not found.');
    if (q.status !== 'ready' && q.status !== 'completed') {
      throw new Error(`Complete "${q.title}" (${q.progress}/${q.goal}) before handing in.`);
    }
    const receipt = grantRewardOnce(p, q);
    ctx.notify(p, {
      kind: 'partyQuest',
      quest: viewOf(q, p.id),
      quests: activeForPlayer(p).map((x) => viewOf(x, p.id)),
      receipt,
      text: `Handed in "${q.title}" — received ${receipt.gold} gold${receipt.renown ? ` and ${receipt.renown} Renown` : ''}.`,
    });
    return receipt;
  }

  // Automatic kill contribution when a party member slays a monster at a party quest site.
  ctx.on?.('kill', ({ player }) => {
    if (!player) return;
    const loc = ctx.location(player);
    for (const q of activeForPlayer(player)) {
      if (q.status !== 'active' || q.objectiveKind !== 'slay') continue;
      if (q.site && q.site !== loc) continue;
      try {
        contribute(player, q.uid, 1);
      } catch { /* ignore */ }
    }
  });

  ctx.onJoin?.((p) => {
    ensurePlayerPartyQuestState(p);
    const active = activeForPlayer(p);
    if (active.length) {
      ctx.notify(p, {
        kind: 'partyQuest',
        quests: active.map((q) => viewOf(q, p.id)),
        board: PARTY_QUEST_CATALOG,
        silent: true,
      });
    }
  });

  ctx.onAction?.('partyQuest.board', (p) => {
    ctx.notify(p, {
      kind: 'partyQuest',
      board: PARTY_QUEST_CATALOG,
      quests: activeForPlayer(p).map((q) => viewOf(q, p.id)),
      silent: true,
    });
  });

  ctx.onAction?.('partyQuest.sync', (p) => {
    ctx.notify(p, {
      kind: 'partyQuest',
      board: PARTY_QUEST_CATALOG,
      quests: activeForPlayer(p).map((q) => viewOf(q, p.id)),
      silent: true,
    });
  });

  ctx.onAction?.('partyQuest.accept', (p, args) => {
    accept(p, args?.templateId, { layoutMode: args?.layoutMode });
  });

  ctx.onAction?.('partyQuest.join', (p, args) => {
    const q = quests.get(String(args?.uid ?? ''));
    if (!q || q.status === 'abandoned') throw new Error('Party quest not found.');
    const party = partyOf(p);
    if (!party || party.id !== q.partyId) throw new Error('Join the quest’s party first.');
    if (!q.participants.includes(p.id)) {
      q.participants.push(p.id);
      q.contributions[p.id] = q.contributions[p.id] ?? 0;
      saveQuest(q);
    }
    ctx.dirty(p);
    const st = ensurePlayerPartyQuestState(p);
    if (!st.activeUids.includes(q.uid)) st.activeUids.push(q.uid);
    notifyParticipants(q, `${p.name} joined party quest "${q.title}".`);
  });

  ctx.onAction?.('partyQuest.contribute', (p, args) => {
    contribute(p, args?.uid, args?.amount ?? 1);
  });

  ctx.onAction?.('partyQuest.handIn', (p, args) => {
    handIn(p, args?.uid);
  });

  ctx.onAction?.('partyQuest.abandon', (p, args) => {
    const q = quests.get(String(args?.uid ?? ''));
    if (!q) throw new Error('Party quest not found.');
    if (q.leaderId !== p.id && !q.participants.includes(p.id)) throw new Error('Not a participant.');
    q.participants = q.participants.filter((id) => id !== p.id);
    if (q.participants.length === 0) q.status = 'abandoned';
    saveQuest(q);
    ctx.dirty(p);
    const st = ensurePlayerPartyQuestState(p);
    st.activeUids = st.activeUids.filter((u) => u !== q.uid);
    ctx.notify(p, {
      kind: 'partyQuest',
      quests: activeForPlayer(p).map((x) => viewOf(x, p.id)),
      text: `Left party quest "${q.title}".`,
    });
  });

  services.partyQuests = {
    catalog: PARTY_QUEST_CATALOG,
    getQuest: (uid) => quests.get(uid) ?? null,
    activeForPlayer,
    activeForParty: (partyId) => [...quests.values()].filter((q) => q.partyId === partyId && q.status !== 'abandoned'),
    accept,
    contribute,
    handIn,
    saveQuest,
  };
}
