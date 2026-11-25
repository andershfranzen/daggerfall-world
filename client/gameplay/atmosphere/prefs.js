// Persisted sound preferences. Pure apart from the injected storage.

export const PREFS_KEY = 'daggerfallworld.audio.v1';

export const DEFAULT_PREFS = Object.freeze({
  master: 0.8,
  music: 0.55,
  effects: 0.8,
  ambience: 0.6,
  muted: false,
  musicEnabled: true,
  /** 'gm' = General MIDI arrangements, 'fm' = the FM-card arrangements. */
  arrangement: 'gm',
});

const clamp01 = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : d;
};

export function normalizePrefs(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    master: clamp01(r.master, DEFAULT_PREFS.master),
    music: clamp01(r.music, DEFAULT_PREFS.music),
    effects: clamp01(r.effects, DEFAULT_PREFS.effects),
    ambience: clamp01(r.ambience, DEFAULT_PREFS.ambience),
    muted: r.muted === true,
    musicEnabled: r.musicEnabled !== false,
    arrangement: r.arrangement === 'fm' ? 'fm' : 'gm',
  };
}

export function loadPrefs(storage) {
  try {
    const s = storage?.getItem(PREFS_KEY);
    return normalizePrefs(s ? JSON.parse(s) : null);
  } catch {
    return normalizePrefs(null);
  }
}

export function savePrefs(storage, prefs) {
  const p = normalizePrefs(prefs);
  try { storage?.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* private mode or full */ }
  return p;
}

/** Effective gain of each bus. */
export function busGains(prefs) {
  const p = normalizePrefs(prefs);
  const m = p.muted ? 0 : p.master;
  return { master: m, music: p.musicEnabled ? p.music : 0, effects: p.effects, ambience: p.ambience };
}
