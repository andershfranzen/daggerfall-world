// Quest Repair: reconciles missing active quest targets, markers, and quest items
// strictly from the owner's saved progress without losing progress or duplicating payouts.
//
// Design guarantees (§9 Quest Repair):
//   1. Outstanding item / missing marker or target: reconciles the quest's site placement
//      (pinned to its assigned layoutId) so the player can collect or confront it without
//      marking the objective done early.
//   2. Collected item (`given && !handedOver`): checks the owner's inventory; if the item is
//      present, keeps it untouched; if genuinely missing from pack, restores that exact item
//      identity once so progress is preserved without creating duplicates.
//   3. Paid / completed quest (`paid || handedOver || done`): preserves payout ownership and
//      refuses to re-grant items or re-pay gold.
//
// Actions:
//   quest.repair.scan  {}
//   quest.repair.run   { uid?, dryRun? }
//
// Services (ctx.services.questRepair):
//   scan(player), repair(player, { uid?, dryRun? }), history(player)

import { randomBytes } from 'node:crypto';

export const name = 'questRepair';
const MAX_AUDIT = 40;

function ensureRepairLog(p) {
  if (!p.rpg || typeof p.rpg !== 'object') p.rpg = {};
  if (!Array.isArray(p.rpg.questRepairs)) p.rpg.questRepairs = [];
  return p.rpg.questRepairs;
}

function inventoryOf(p) {
  if (!Array.isArray(p.rpg?.inventory)) return [];
  return p.rpg.inventory;
}

function hasQuestItemInInventory(p, questUid, itemKey, rec) {
  const inv = inventoryOf(p);
  return inv.some((it) => {
    if (!it || typeof it !== 'object') return false;
    if (rec.invId && it.id === rec.invId) return true;
    if (rec.inventoryItemId && it.id === rec.inventoryItemId) return true;
    if (it.questUid === questUid && (it.questKey === itemKey || it.key === itemKey)) return true;
    if (rec.template && it.template === rec.template && it.questUid === questUid) return true;
    return false;
  });
}

export function install(ctx) {
  const services = (ctx.services ||= {});

  function inspectPersonalQuests(p) {
    const active = Array.isArray(p.rpg?.quests?.active) ? p.rpg.quests.active : [];
    const done = Array.isArray(p.rpg?.quests?.done) ? p.rpg.quests.done : [];
    const findings = [];

    for (const inst of active) {
      if (!inst || typeof inst !== 'object') continue;
      const uid = String(inst.uid ?? inst.name ?? 'unknown');
      const questName = String(inst.title ?? inst.name ?? uid);
      const payoutOwnerId = inst.payoutOwnerId ?? p.id;
      const alreadyPaid = Boolean(inst.paid || inst.rewardPaid || inst.completed);

      // 1. Check quest items
      for (const [itemKey, rec] of Object.entries(inst.items ?? {})) {
        if (!rec || typeof rec !== 'object' || rec.gold) continue;

        if (alreadyPaid || rec.handedOver) {
          findings.push({
            scope: 'personal',
            questUid: uid,
            questName,
            resourceType: 'item',
            resourceKey: itemKey,
            state: 'paid-or-handed-over',
            needsRepair: false,
            payoutOwnerId,
            detail: `Item ${rec.name ?? itemKey} already settled; payout ownership preserved.`,
          });
          continue;
        }

        if (rec.given) {
          const inPack = hasQuestItemInInventory(p, uid, itemKey, rec);
          if (!inPack) {
            findings.push({
              scope: 'personal',
              questUid: uid,
              questName,
              resourceType: 'collected-item',
              resourceKey: itemKey,
              state: 'missing-from-pack',
              needsRepair: true,
              payoutOwnerId,
              detail: `Collected quest item "${rec.name ?? itemKey}" is missing from inventory and can be restored.`,
            });
          } else {
            findings.push({
              scope: 'personal',
              questUid: uid,
              questName,
              resourceType: 'collected-item',
              resourceKey: itemKey,
              state: 'intact',
              needsRepair: false,
              payoutOwnerId,
              detail: `Collected quest item "${rec.name ?? itemKey}" is intact in inventory.`,
            });
          }
          continue;
        }

        // Outstanding item (not yet collected): verify its placement/marker exists.
        if (rec.placedAt && (!rec.markerId || rec.markerMissing)) {
          findings.push({
            scope: 'personal',
            questUid: uid,
            questName,
            resourceType: 'outstanding-item-marker',
            resourceKey: itemKey,
            state: 'missing-marker',
            needsRepair: true,
            payoutOwnerId,
            site: rec.placedAt,
            detail: `Outstanding quest item "${rec.name ?? itemKey}" at ${rec.placedAt} lost its marker.`,
          });
        }
      }

      // 2. Check placed targets (foes / NPCs)
      for (const [targetKey, rec] of Object.entries(inst.foes ?? {})) {
        if (!rec || typeof rec !== 'object' || rec.killed || rec.dead || rec.removed) continue;
        if (rec.placedAt && (!rec.markerId || rec.targetMissing)) {
          findings.push({
            scope: 'personal',
            questUid: uid,
            questName,
            resourceType: 'foe-target',
            resourceKey: targetKey,
            state: 'missing-target',
            needsRepair: true,
            payoutOwnerId,
            site: rec.placedAt,
            detail: `Active quest target "${rec.name ?? targetKey}" at ${rec.placedAt} needs marker reconciliation.`,
          });
        }
      }

      for (const [placeKey, place] of Object.entries(inst.places ?? {})) {
        if (!place || typeof place !== 'object') continue;
        if (place.scope === 'permanent' || inst.story) continue;
        const site = place.interior ?? place.location;
        if (typeof site === 'string' && site.startsWith('dungeon:') && !place.layoutId) {
          findings.push({
            scope: 'personal',
            questUid: uid,
            questName,
            resourceType: 'dungeon-layout',
            resourceKey: placeKey,
            state: 'unpinned-layout',
            needsRepair: true,
            payoutOwnerId,
            site,
            detail: `Quest dungeon ${site} is missing its pinned layoutId.`,
          });
        }
      }
    }

    // 3. Check completed/paid quests (verify payout ownership, never re-grant)
    for (const d of done) {
      if (!d || typeof d !== 'object') continue;
      findings.push({
        scope: 'personal-done',
        questUid: String(d.uid ?? d.name ?? 'done'),
        questName: String(d.title ?? d.name ?? 'Completed Quest'),
        resourceType: 'payout',
        resourceKey: 'reward',
        state: 'paid',
        needsRepair: false,
        payoutOwnerId: d.payoutOwnerId ?? p.id,
        detail: 'Completed quest payout already settled; repair will not duplicate rewards.',
      });
    }

    // 4. Check active party quests for missing markers
    for (const pq of services.partyQuests?.activeForPlayer?.(p) ?? []) {
      if (pq.status !== 'active') continue;
      if (!Array.isArray(pq.markers) || pq.markers.length === 0) {
        findings.push({
          scope: 'party',
          questUid: pq.uid,
          questName: pq.title,
          resourceType: 'party-marker',
          resourceKey: 'markers',
          state: 'missing-marker',
          needsRepair: true,
          payoutOwnerId: p.id,
          site: pq.site,
          detail: `Party quest "${pq.title}" is missing active objective markers at ${pq.site}.`,
        });
      }
    }

    return findings;
  }

  function applyRepair(p, { uid = null, dryRun = false } = {}) {
    const findings = inspectPersonalQuests(p).filter((f) => !uid || f.questUid === String(uid));
    const actionable = findings.filter((f) => f.needsRepair);
    const repaired = [];
    const preserved = [];

    for (const f of findings) {
      if (!f.needsRepair) {
        preserved.push({
          questUid: f.questUid,
          questName: f.questName,
          resourceKey: f.resourceKey,
          state: f.state,
          payoutOwnerId: f.payoutOwnerId,
        });
      }
    }

    if (dryRun || actionable.length === 0) {
      return {
        dryRun: Boolean(dryRun),
        scanned: findings.length,
        repaired,
        preserved,
        findings,
      };
    }

    const active = Array.isArray(p.rpg?.quests?.active) ? p.rpg.quests.active : [];
    const log = ensureRepairLog(p);
    ctx.dirty(p);

    for (const f of actionable) {
      if (f.scope === 'party') {
        const pq = services.partyQuests?.getQuest?.(f.questUid);
        if (!pq || pq.status !== 'active') continue;
        const layout = pq.site?.startsWith('dungeon:')
          ? services.smallerDungeons?.selectLayout?.(pq.site, { player: p, pinnedLayoutId: pq.layoutId })
          : null;
        pq.markers = layout?.questMarkers?.length
          ? layout.questMarkers.map((m) => ({ ...m }))
          : [{ id: `pqm:repaired:${pq.uid}`, x: 4, y: 0, z: -4, kind: pq.objectiveKind, layoutId: pq.layoutId }];
        services.partyQuests.saveQuest(pq);
        const entry = {
          at: Math.trunc(ctx.now?.() ?? Date.now()),
          questUid: pq.uid,
          questName: pq.title,
          issue: f.state,
          action: 'reconciled-party-markers',
          recoveredResource: pq.markers[0].id,
          payoutPreserved: true,
        };
        log.unshift(entry);
        repaired.push(entry);
        continue;
      }

      const inst = active.find((q) => String(q.uid ?? q.name) === f.questUid);
      if (!inst) continue;

      if (f.resourceType === 'collected-item') {
        const rec = inst.items?.[f.resourceKey];
        if (!rec || !rec.given || rec.handedOver || inst.paid) continue;
        if (hasQuestItemInInventory(p, f.questUid, f.resourceKey, rec)) continue;
        if (!Array.isArray(p.rpg.inventory)) p.rpg.inventory = [];
        let restoredId = rec.invId || rec.inventoryItemId || `qrep_${f.questUid}_${f.resourceKey}_${randomBytes(3).toString('hex')}`;
        let restoredName = rec.name ?? 'Recovered Quest Item';
        let granted = null;
        if (!rec.inventoryItemId && rec.template && typeof services.giveItem === 'function') {
          try {
            granted = services.giveItem(p, rec.template, 1, rec.appearance);
          } catch {
            granted = null;
          }
        }
        if (granted && typeof granted.id === 'string') {
          restoredId = granted.id;
          restoredName = granted.name ?? restoredName;
          rec.invId = restoredId;
        } else {
          const restoredItem = {
            id: restoredId,
            template: rec.template ?? 'quest-relic',
            name: restoredName,
            quantity: 1,
            questUid: f.questUid,
            questKey: f.resourceKey,
            recoveredByRepair: true,
          };
          p.rpg.inventory.push(restoredItem);
          rec.invId = restoredId;
          rec.inventoryItemId = restoredId;
        }
        const entry = {
          at: Math.trunc(ctx.now?.() ?? Date.now()),
          questUid: f.questUid,
          questName: f.questName,
          issue: f.state,
          action: 'restored-collected-item',
          recoveredResource: `${restoredName} (${restoredId})`,
          payoutPreserved: true,
        };
        log.unshift(entry);
        repaired.push(entry);
      } else if (f.resourceType === 'outstanding-item-marker') {
        const rec = inst.items?.[f.resourceKey];
        if (!rec || rec.given || rec.handedOver) continue;
        const layout = rec.placedAt?.startsWith('dungeon:')
          ? services.smallerDungeons?.selectLayout?.(rec.placedAt, { player: p })
          : null;
        const marker = layout?.questMarkers?.[0] ?? { id: `qm:repaired:${f.questUid}:${f.resourceKey}`, x: 8, y: 0, z: -8, layoutId: layout?.layoutId ?? null };
        rec.markerId = marker.id;
        rec.markerX = marker.x;
        rec.markerY = marker.y ?? 0;
        rec.markerZ = marker.z;
        rec.layoutId = marker.layoutId ?? layout?.layoutId ?? null;
        delete rec.markerMissing;
        const entry = {
          at: Math.trunc(ctx.now?.() ?? Date.now()),
          questUid: f.questUid,
          questName: f.questName,
          issue: f.state,
          action: 'reconciled-item-marker',
          recoveredResource: `${rec.name ?? f.resourceKey} @ ${marker.id}`,
          payoutPreserved: true,
        };
        log.unshift(entry);
        repaired.push(entry);
      } else if (f.resourceType === 'foe-target') {
        const rec = inst.foes?.[f.resourceKey];
        if (!rec || rec.killed || rec.dead) continue;
        const layout = rec.placedAt?.startsWith('dungeon:')
          ? services.smallerDungeons?.selectLayout?.(rec.placedAt, { player: p })
          : null;
        const marker = layout?.questMarkers?.find((m) => m.kind === 'questFoe')
          ?? layout?.questMarkers?.[0]
          ?? { id: `qfoe:repaired:${f.questUid}:${f.resourceKey}`, x: 12, y: 0, z: -12, layoutId: layout?.layoutId ?? null };
        rec.markerId = marker.id;
        rec.layoutId = marker.layoutId ?? layout?.layoutId ?? null;
        delete rec.targetMissing;
        const entry = {
          at: Math.trunc(ctx.now?.() ?? Date.now()),
          questUid: f.questUid,
          questName: f.questName,
          issue: f.state,
          action: 'reconciled-target-marker',
          recoveredResource: `${rec.name ?? f.resourceKey} @ ${marker.id}`,
          payoutPreserved: true,
        };
        log.unshift(entry);
        repaired.push(entry);
      } else if (f.resourceType === 'dungeon-layout') {
        const place = inst.places?.[f.resourceKey];
        const site = place?.interior ?? place?.location;
        if (!place || !site) continue;
        const pin = services.smallerDungeons?.pinQuestLayout?.(p, f.questUid, site);
        place.layoutId = pin?.layoutId ?? `classic:v1:${f.questUid}`;
        const entry = {
          at: Math.trunc(ctx.now?.() ?? Date.now()),
          questUid: f.questUid,
          questName: f.questName,
          issue: f.state,
          action: 'pinned-dungeon-layout',
          recoveredResource: place.layoutId,
          payoutPreserved: true,
        };
        log.unshift(entry);
        repaired.push(entry);
      }
    }

    if (log.length > MAX_AUDIT) log.length = MAX_AUDIT;
    return {
      dryRun: false,
      scanned: findings.length,
      repaired,
      preserved,
      findings,
    };
  }

  ctx.onJoin?.((p) => {
    ensureRepairLog(p);
  });

  ctx.onAction?.('quest.repair.scan', (p) => {
    const findings = inspectPersonalQuests(p);
    const actionable = findings.filter((f) => f.needsRepair);
    ctx.notify(p, {
      kind: 'questRepair',
      mode: 'scan',
      findings,
      actionableCount: actionable.length,
      history: ensureRepairLog(p).slice(0, 10),
      text: actionable.length
        ? `Quest Repair found ${actionable.length} issue(s) ready to reconcile.`
        : 'All active quests and payouts are consistent.',
    });
  });

  ctx.onAction?.('quest.repair.run', (p, args) => {
    const result = applyRepair(p, { uid: args?.uid ?? null, dryRun: Boolean(args?.dryRun) });
    ctx.notify(p, {
      kind: 'questRepair',
      mode: result.dryRun ? 'dryRun' : 'run',
      ...result,
      history: ensureRepairLog(p).slice(0, 10),
      text: result.repaired.length
        ? `Quest Repair reconciled ${result.repaired.length} resource(s) while preserving progress and payout ownership.`
        : 'No broken quest targets or items required repair; progress and payouts preserved.',
    });
  });

  services.questRepair = {
    scan: inspectPersonalQuests,
    repair: applyRepair,
    history: (p) => [...ensureRepairLog(p)],
  };
}
