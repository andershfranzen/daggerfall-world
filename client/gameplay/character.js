// Character feature (browser). Registers the 'character' panel (creation wizard + character sheet) and reads the player's own CLASS*.CFG files to note any differences from the
// server's ruleset. All numbers shown come from the server; the wizard only proposes how to spend pools.

import * as R from './character/rules.js';
import { CharacterDraft, LevelUpDraft } from './character/draft.js';
import { renderWizard } from './character/wizard.js';
import { renderSheet } from './character/sheet.js';
import { parseClassCfg, CLASS_FILE_RE } from './character/cfg.js';
import * as K from './character/classic.js';
import { h } from './character/dom.js';

export { setPortraitProvider, setPortraitFiles } from './character/art.js';
import { setPortraitFiles } from './character/art.js';

const PANEL = 'character';
const PROMPT_KEY = 'dfw.character.prompted';

// Focus survives re-renders (same scheme as the shell: id, data-focus-key, then label).
function focusKey(el, root) {
  if (!el || !root.contains(el) || el === root) return null;
  if (el.id) return { id: el.id };
  if (el.dataset?.focusKey) return { fk: el.dataset.focusKey };
  return { tag: el.tagName, label: el.getAttribute('aria-label') || el.textContent.trim().slice(0, 60) };
}

function restoreFocus(key, root) {
  let el = null;
  if (key.id) el = root.querySelector(`#${CSS.escape(key.id)}`);
  else if (key.fk) el = root.querySelector(`[data-focus-key="${CSS.escape(key.fk)}"]`);
  else {
    el = [...root.querySelectorAll(key.tag)].find((e) => (e.getAttribute('aria-label') || e.textContent.trim().slice(0, 60)) === key.label) ?? null;
  }
  if (!el || el.disabled) return false;
  el.focus({ preventScroll: true });
  return true;
}

export function install(api) {
  const ui = {
    mode: 'sheet', // sheet | wizard
    inWizard: false,
    dismissedWizard: false,
    draft: null,
    levelDraft: null,
    levelKey: '',
    tab: 'primary',
    error: null,
    busy: false,
    container: null,
    cfgNotes: new Map(),
  };

  // The runtime sends the whole private record as state.character (p.rpg); the sheet lives at .character.
  const character = () => {
    const rpg = api.state?.character;
    if (!rpg || typeof rpg !== 'object') return null;
    return rpg.character && typeof rpg.character === 'object' ? rpg.character : null;
  };
  const isOpen = () => api.panel === PANEL;

  // ---------------------------------------------------------------- server requests

  function send(verb, args = {}) {
    ui.error = null;
    ui.busy = true;
    let result;
    try {
      result = api.act(verb, args);
    } catch (err) {
      ui.busy = false;
      ui.error = err?.message ?? String(err);
      rerender();
      return;
    }
    if (result === false) {
      ui.busy = false;
      if (ui.draft) ui.draft.pending = false;
      rerender();
      return;
    }
    if (result && typeof result.then === 'function') {
      result.then(() => { ui.busy = false; rerender(); }, (err) => {
        ui.busy = false;
        ui.error = err?.message ?? String(err);
        if (ui.draft) ui.draft.pending = false;
        rerender();
      });
    } else {
      // Fire-and-forget transport: the next state message clears the busy flag.
      setTimeout(() => { if (ui.busy) { ui.busy = false; rerender(); } }, 1500);
    }
  }

  const ctl = {
    get error() { return ui.error; },
    get busy() { return ui.busy; },
    get levelDraft() { return ui.levelDraft; },
    get tab() { return ui.tab; },
    get cfgNotes() { return ui.cfgNotes; },
    update: () => { ui.error = null; rerender(); },
    setTab: (t) => { ui.tab = t; rerender(); },
    roll: () => {
      const d = ui.draft;
      if (!d) return;
      d.pending = true;
      d.rollKey = ''; // accept the next roll even if identical
      send('character.roll', d.rollRequest());
      rerender();
    },
    create: () => {
      const d = ui.draft;
      if (!d || d.finalProblem()) return;
      send('character.create', d.createRequest());
    },
    cancel: () => {
      if (!character()?.created) return; // Character creation is mandatory for uncreated characters.
      if (character()?.draft) send('character.cancel');
      ui.dismissedWizard = true;
      ui.mode = 'sheet';
      ui.draft = null;
      ui.error = null;
      rerender();
    },
    startCreate: () => startWizard(),
    submitLevel: () => {
      const lv = ui.levelDraft;
      if (!lv || lv.problem()) return;
      send('character.levelUp', { attributes: { ...lv.attributes } });
    },
    clearRecent: () => send('character.clearRecent'),
  };

  function startWizard() {
    const ch = character();
    if (ch?.created) return;
    ui.dismissedWizard = false;
    ui.mode = 'wizard';
    ui.draft ??= new CharacterDraft(ch?.name ?? '');
    ui.draft.localCareers ??= ui.localCareers ?? null;
    ui.draft.classic ??= ui.classic ?? null;
    ui.draft.serverBiography = !!ch?.classicData?.biography;
    if (ch?.draft) ui.draft.syncRoll(ch.draft);
    ui.error = null;
    if (!isOpen()) api.openPanel(PANEL);
    else rerender();
  }

  // ---------------------------------------------------------------- panel

  /** Level-up spend tracks the server's pool. Called from render too (the shell may draw first). */
  function syncLevel(ch) {
    const key = `${ch.level}:${ch.bonusPoints}:${JSON.stringify(ch.attributes)}`;
    if (key === ui.levelKey) return;
    ui.levelKey = key;
    ui.levelDraft = ch.bonusPoints > 0 ? new LevelUpDraft(ch.attributes, ch.bonusPoints) : null;
  }

  function render(container) {
    ui.container = container;
    container.classList.add('cc-panel');
    const ch = character();
    if (!ch) {
      container.replaceChildren(h('p', { class: 'cc-note' }, 'Connecting to the world…'));
      return;
    }
    if (!ch.created) ui.mode = 'wizard';
    if (ui.mode === 'wizard' && !ch.created) {
      ui.inWizard = true;
      ui.draft ??= new CharacterDraft(ch.name);
      ui.draft.localCareers ??= ui.localCareers ?? null;
      ui.draft.classic ??= ui.classic ?? null;
      ui.draft.serverBiography = !!ch.classicData?.biography;
      // Pull the server's roll on every render: the shell may redraw the panel on a state message
      // before this module's own 'state' listener has run.
      if (ch.draft) ui.draft.syncRoll(ch.draft);
      const step = ui.draft.step;
      renderWizard(container, ui.draft, ctl);
      const menu = container.closest?.('#game-menu');
      if (menu) menu.dataset.wizard = 'true';
      if (step !== ui.lastStep) {
        // New step: start keyboard navigation at its field or heading. A microtask runs after the
        // shell's own focus restore, whichever of us drew the panel.
        ui.lastStep = step;
        queueMicrotask(() => {
          if (!container.isConnected) return;
          (container.querySelector('[data-autofocus]') ?? container.querySelector('.cc-wizard-head h2'))?.focus({ preventScroll: true });
        });
      }
    } else {
      ui.mode = 'sheet';
      const menu = container.closest?.('#game-menu');
      if (menu) delete menu.dataset.wizard;
      syncLevel(ch);
      renderSheet(container, ch, ctl);
    }
  }

  function rerender() {
    const root = ui.container;
    if (!root?.isConnected) return;
    const scroll = root.scrollTop;
    const key = focusKey(document.activeElement, root);
    render(root);
    root.scrollTop = scroll;
    if (key && !restoreFocus(key, root)) {
      root.querySelector('.cc-nav .btn-primary:not(:disabled), .cc-wizard-head h2, button:not(:disabled)')?.focus({ preventScroll: true });
    }
  }

  api.registerPanel(PANEL, 'Character', (container) => render(container));

  // Server rejections arrive as error toasts; while a character request is in flight, show it in the panel.
  api.on('message', (m) => {
    if (m?.kind !== 'error' || !ui.busy || !isOpen()) return;
    ui.busy = false;
    ui.error = m.text;
    if (ui.draft) ui.draft.pending = false;
    rerender();
  });

  // ---------------------------------------------------------------- state & events

  api.on('state', () => {
    const ch = character();
    if (!ch) return;
    ui.busy = false;
    if (ch.created && (ui.mode === 'wizard' || ui.inWizard)) {
      ui.mode = 'sheet';
      ui.inWizard = false;
      ui.dismissedWizard = false;
      ui.draft = null;
      try { sessionStorage.removeItem(promptKeyFor(ch)); } catch {}
      if (isOpen()) {
        api.refreshPanel?.();
        api.closePanel?.();
      }
    }
    const rollBefore = ui.draft?.rollKey;
    if (ui.draft && ch.draft) ui.draft.syncRoll(ch.draft);
    // If the shell already drew this state, nothing changes; otherwise show the new roll now.
    if (ui.draft && ui.draft.rollKey !== rollBefore && isOpen()) rerender();
    syncLevel(ch);
    maybePrompt(ch);
  });

  api.on('event', (event) => {
    if (!event || typeof event !== 'object') return;
    // The shell already shows every private event's text as a toast; only react here.
    switch (event.kind) {
      case 'levelUp':
        if (!api.modalOpen) api.openPanel(PANEL);
        break;
      case 'characterNeeded':
        maybePrompt(character());
        break;
      case 'error':
      case 'actionError':
        if (typeof event.verb === 'string' && event.verb.startsWith('character.')) {
          ui.error = event.text ?? event.message ?? 'That did not work.';
          if (ui.draft) ui.draft.pending = false;
          rerender();
        }
        break;
      default:
    }
  });

  const promptKeyFor = (ch) => `${PROMPT_KEY}:${ch?.name ?? ''}`;

  /** Mandatory first-run creation: open the wizard for any uncreated character. */
  function maybePrompt(ch) {
    if (!ch || ch.created) return;
    if (isOpen() && ui.mode === 'wizard') return;
    startWizard();
  }

  // ---------------------------------------------------------------- player's class files

  let assetRead = 0;
  async function readClassFiles(files) {
    const read = ++assetRead;
    const notes = new Map();
    const local = new Map();
    for (const f of files ?? []) {
      const m = CLASS_FILE_RE.exec(f?.name ?? '');
      if (!m) continue;
      const std = R.CLASSES[Number(m[1])];
      if (!std) continue;
      try {
        const cfg = parseClassCfg(new Uint8Array(await f.arrayBuffer()));
        local.set(std.name, Object.freeze({ ...std, ...cfg, name: std.name }));
        const diffs = [];
        if (cfg.hitPointsPerLevel !== std.hitPointsPerLevel) diffs.push(`health per level ${cfg.hitPointsPerLevel}`);
        if (cfg.spellPointMultiplier !== std.spellPointMultiplier) diffs.push(`magicka ${cfg.spellPointMultiplier}× INT`);
        for (const g of ['primarySkills', 'majorSkills', 'minorSkills']) {
          if ([...cfg[g]].sort().join() !== [...std[g]].sort().join()) diffs.push(`${g.replace('Skills', '')} skills ${cfg[g].join(', ')}`);
        }
        notes.set(std.name, diffs.length
          ? 'Shown from your game files. The server confirms the exact lists when you roll.'
          : 'Matches the class record in your game files.');
      } catch {
        // Not a usable record; ignore.
      }
    }
    const classic = await readClassicFiles(files);
    if (read !== assetRead) return;
    ui.cfgNotes = notes;
    ui.localCareers = local;
    if (ui.draft) ui.draft.localCareers = local;
    ui.classic = classic;
    if (ui.draft) ui.draft.classic = ui.classic;
    rerender();
  }

  /** TEXT.RSC, CLASSES.DAT and BIOGnnT0.TXT from the player's own folder; kept in memory only. */
  async function readClassicFiles(files) {
    const byName = new Map();
    for (const f of files ?? []) if (f?.name) byName.set(f.name.toUpperCase(), f);
    const bytes = async (name) => {
      const f = byName.get(name);
      return f ? new Uint8Array(await f.arrayBuffer()) : null;
    };
    const out = { rsc: null, classQuestions: [], classesDat: null, biogs: new Map() };
    try {
      const raw = await bytes('TEXT.RSC');
      if (raw) {
        out.rsc = K.parseTextRsc(raw);
        out.classQuestions = K.parseClassQuestions(out.rsc.text(K.CLASS_QUESTIONS_RECORD));
      }
    } catch (err) {
      console.warn('[character] TEXT.RSC unreadable:', err.message);
    }
    out.classesDat = await bytes('CLASSES.DAT');
    for (const [name, f] of byName) {
      const m = K.BIOG_FILE_RE.exec(name);
      if (!m || m[2] !== '0') continue;
      try {
        out.biogs.set(Number(m[1]), K.parseBiog(K.decodeLatin1(new Uint8Array(await f.arrayBuffer())), Number(m[1])));
      } catch (err) {
        console.warn(`[character] ${name} unreadable:`, err.message);
      }
    }
    return out.rsc || out.biogs.size ? out : null;
  }
  const setFiles = (files) => {
    setPortraitFiles(files);
    rerender();
    readClassFiles(files).catch((err) => console.warn('[character] class data unavailable:', err.message));
  };
  api.on('assets', setFiles);
  if (api.files) setFiles(api.files);

  if (character()) maybePrompt(character());
  api.emit?.('character:ready', { created: !!character()?.created });
  return { open: () => api.openPanel(PANEL), startCreate: startWizard };
}
