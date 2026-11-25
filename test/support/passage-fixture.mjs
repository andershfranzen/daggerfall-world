// FIXTURE for server/rpg/passage.js tests and private live proofs: a TEST STAND-IN for the sailing core's narrow berth
// interface (services.sailing: charter/embark/setCourse/disembark/retire/byId/aboard/crewOf) and the geo owner's coast
// ports. It moves a vessel in a straight line purely so the passage's own rules can be exercised; it is NOT the
// production simulation. Port pixels are the classic starter towns' map pixels (client/gameplay/travel/classic.js).
export const DF = 'town:Daggerfall/Daggerfall';
export const SE = 'town:Sentinel/Sentinel';
export const WR = 'town:Wayrest/Wayrest';
export const GP = 'town:Glenpoint/Glenpoint';
export const PORTS = [
  { id: DF, name: 'Daggerfall', region: 'Daggerfall', px: 207, py: 213 },
  { id: SE, name: 'Sentinel', region: 'Sentinel', px: 397, py: 343 },
  { id: WR, name: 'Wayrest', region: 'Wayrest', px: 859, py: 244 },
  { id: GP, name: 'Glenpoint', region: 'Glenpoint', px: 167, py: 109 },
];
export const DECK = 'ship:charter';
const SPEED_PX_S = 20; // fixture only

/** FIXTURE stand-in for the sailing core + coast. Persists vessels as world rows so a restart keeps them. */
export function fixtureCore(opts = {}) {
  const speed = opts.speedPxS ?? SPEED_PX_S;
  return {
    name: 'sailing',
    install(ctx) {
      const vessels = new Map(ctx.loadWorld('fixsail:').map(([, v]) => [v.id, v]));
      const aboard = new Map(); // player id -> vessel id (rebuilt from rpg on join)
      const save = (v) => ctx.dirtyWorld(`fixsail:${v.id}`, v.retired ? null : { ...v });
      const port = (id) => PORTS.find((p) => p.id === id);
      let n = vessels.size;
      ctx.services.coast = { ports: () => PORTS, reachable: (a, b) => !(opts.unreachable ?? []).includes(b) };
      ctx.services.sailing = {
        ports: () => PORTS,
        byId: (id) => vessels.get(id) ?? null,
        aboard: (p) => vessels.get(aboard.get(p.id)) ?? null,
        crewOf: (v) => [...ctx.players.values()].filter((p) => aboard.get(p.id) === v.id),
        charter({ fromPortId, toPortId, type, name, master, record }) {
          if (opts.refuseCharter) throw new Error('No ship lies at her berth.');
          const at = port(fromPortId);
          const v = { id: `v${++n}`, ownerId: null, ownerName: master, type, name, px: at.px, py: at.py, docked: fromPortId, course: null, charter: record };
          vessels.set(v.id, v);
          ctx.onRollback(() => vessels.delete(v.id));
          save(v);
          void toPortId;
          return v;
        },
        embark(p, v) {
          ctx.dirty(p);
          p.rpg.fixtureShore = p.rpg.location;
          p.rpg.location = DECK;
          p.rpg.fixtureAboard = v.id;
          aboard.set(p.id, v.id);
          ctx.onRollback(() => aboard.delete(p.id));
        },
        setCourse(v, portId) {
          if (opts.noRoute) throw new Error('Her master knows no way there by sea from here.');
          v.course = portId;
          save(v);
        },
        disembark(p, v) {
          if (!v.docked) throw new Error('She is at sea.');
          ctx.dirty(p);
          p.rpg.location = v.docked;
          delete p.rpg.fixtureAboard;
          aboard.delete(p.id);
        },
        retire(v) { v.retired = true; vessels.delete(v.id); save(v); },
      };
      ctx.onJoin((p) => { if (p.rpg.fixtureAboard && vessels.has(p.rpg.fixtureAboard)) aboard.set(p.id, p.rpg.fixtureAboard); });
      ctx.onLeave((p) => aboard.delete(p.id));
      ctx.onTick((dt) => {
        for (const v of vessels.values()) {
          if (!v.course) continue;
          const to = port(v.course);
          v.docked = null;
          const dx = to.px - v.px, dy = to.py - v.py, d = Math.hypot(dx, dy), step = speed * dt;
          if (d <= step) { v.px = to.px; v.py = to.py; v.docked = to.id; v.course = null; ctx.emit('sailing.docked', { vessel: v, portId: to.id }); }
          else { v.px += (dx / d) * step; v.py += (dy / d) * step; }
          save(v);
        }
      });
    },
  };
}

