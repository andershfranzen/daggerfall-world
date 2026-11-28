// Game client controller: landing → loading → game, with failure and reconnect paths.
// Also hosts the gameplay shell: the browser API for client/gameplay features (gameplay/api.js),
// the menus and HUD (gameplay/shell.js), account sign-in gating, action keys and gamepad input.

import { Identity, cleanDisplayName, nameProblem } from './lib/identity.js';
import { selectArena2, readDroppedEntries } from './lib/files.js';
import { discoverInstalledArena2, isLoopbackPage } from './lib/local-assets.js';
import { createArena2Store, folderPermission, readDirectoryHandle } from './lib/arena2-store.js';
import { Connection, CLOSE, describeClose, defaultUrl } from './lib/net.js';
import { Predictor, SnapshotBuffer, InputSender, wrapAngle, clamp } from './lib/motion.js';
import { indoorFloor, groundFor, offsetGround, layersHeightAt } from './lib/ground.js';
import { Renderer } from './render/renderer.js';
import { Avatar, LABEL_HEIGHT } from './render/avatar.js';
import { Input, PITCH_LIMIT, PadReader, PAD } from './input.js';
import {
  createGameplayApi, installFeatures, manifestEntries, actionForCode, pickTarget, targetables,
  interactionFor, readiedOf, statsOf, locationName,
} from './gameplay/api.js';
import { createShell, loadSettings } from './gameplay/shell.js';
import { arrivalStatus, crossesDoor } from './lib/arrival.js';
import { canResumeWaterWalk, newBody, stepBody, eyeHeight, LOCO } from './lib/locomotion.js';
import { movementMods, movementView, modeOfStance, syncSwimBreath } from './gameplay/movement.js';
import { peerCoverage } from './gameplay/magic/concealment.js';
import { shouldSkipFallbackAvatar } from './gameplay/actors/peerHybrid.js';
import { MODE_ACTIONS, MODE_LABELS } from './gameplay/api.js';
import {
  BUG_DRAFT_KEY, BUG_REPORT_URL, PATCH_NOTES_FEED_URL,
  parseInitialPlace, parseLatestPatchNote, isPatchNoteUnseen, markPatchNoteSeen,
  buildBugDraft, saveBugDraft, captureCanvasScreenshot, detectWebglRenderer,
} from './lib/web-integration.js';

const $ = (id) => document.getElementById(id);
const ui = {
  canvas: $('view'), labels: $('labels'),
  landing: $('screen-landing'), loading: $('screen-loading'), failure: $('screen-failure'), hud: $('hud'),
  form: $('join-form'), name: $('name-input'), nameNote: $('name-note'),
  drop: $('data-drop'), pick: $('data-pick'), dataStatus: $('data-status'), dataInput: $('data-input'),
  resume: $('data-resume'), forget: $('data-forget'), cacheBox: $('data-cache'), cacheField: $('data-cache-field'), cacheStatus: $('data-cache-status'),
  enter: $('enter-btn'), formError: $('form-error'),
  whatsNew: $('whats-new'), whatsNewLink: $('whats-new-link'), whatsNewBadge: $('whats-new-badge'),
  whatsNewDate: $('whats-new-date'), whatsNewTitle: $('whats-new-title'),
  nameField: $('name-field'), accountGate: $('account-gate'),
  charSelector: $('char-selector'), charSlotCount: $('char-slot-count'), charSlots: $('char-slots'),
  charCreateBox: $('char-create-box'), charCreateTitle: $('char-create-title'), charCreateName: $('char-create-name'),
  charCreateSubmit: $('char-create-submit'), charCreateCancel: $('char-create-cancel'),
  charArchiveBox: $('char-archive-box'), charArchiveTitle: $('char-archive-title'), charArchiveWarn: $('char-archive-warn'),
  charArchiveBlockers: $('char-archive-blockers'), charArchiveConfirmWrap: $('char-archive-confirm-wrap'),
  charArchiveLabel: $('char-archive-label'), charArchiveInput: $('char-archive-input'),
  charArchiveSubmit: $('char-archive-submit'), charArchiveCancel: $('char-archive-cancel'),
  charRosterNote: $('char-roster-note'),
  loadingTitle: $('loading-title'), steps: $('loading-steps'), loadingDetail: $('loading-detail'), loadingCancel: $('loading-cancel'),
  failTitle: $('failure-title'), failMsg: $('failure-message'), failHint: $('failure-hint'),
  failRetry: $('failure-retry'), failFolder: $('failure-folder'), failReport: $('failure-report'), failBack: $('failure-back'),
  town: $('hud-town'), conn: $('hud-conn'), heading: $('hud-heading'),
  peopleBtn: $('hud-people-btn'), count: $('hud-count'), helpBtn: $('hud-help-btn'), switchBtn: $('hud-switch-btn'), leaveBtn: $('hud-leave-btn'),
  roster: $('hud-roster'), rosterList: $('roster-list'), help: $('hud-help'),
  chatLog: $('chat-log'), chatForm: $('chat-form'), chatInput: $('chat-input'),
  banner: $('hud-banner'), bannerText: $('hud-banner-text'), reconnect: $('hud-reconnect-btn'), bannerLeave: $('hud-banner-leave-btn'),
  menuBtn: $('hud-menu-btn'),
};

const EYE_HEIGHT = 1.62;
const LABEL_RANGE = 45;
const SAY_SECONDS = 7;
const MAX_CHAT_LINES = 80;

const identity = new Identity();
const input = new Input(ui.canvas);
const pad = new PadReader();
let renderer = null;
const ATTACK_GAP = 0.25; // s between attack requests from keys/clicks
const TARGET_EVERY = 0.1; // s between fallback target picks

const S = {
  screen: 'landing',
  data: null, // result of selectArena2
  townJob: null, // { data, promise }
  town: null, townData: null, ground: null,
  op: 0,
  name: '',
  claim: null,
  guestTokens: new Map(), // profile key -> token for non-owning tabs (memory only)
  conn: null, connected: false, joinedAt: 0, autoRetried: false,
  selfId: null, selfName: '',
  predictor: new Predictor(), sender: new InputSender(),
  yaw: 0, pitch: 0, footY: 0, walked: 0,
  // Local body for the shared locomotion rule (client/lib/locomotion.js). locoFootY is the foot height it
  // last wrote: any other value in footY means a reset/transfer placed us, and the body follows it.
  body: newBody(0, 0, 0), locoFootY: null, jumpSeq: 0, crouch: false, serverBody: null, bodyMismatch: 0,
  remotes: new Map(), firstState: true,
  pendingPositions: null, // a position snapshot sent before its matching RPG location
  lastHeading: null,
  failureRetry: null,
  // accounts: 'checking' until /auth/account.js reports; 'required' when the server has accounts;
  // 'off' when it does not (prototype/test servers) or the page was opened with ?guest=1.
  auth: 'checking',
  account: null, // {id, username} when signed in
  roster: null, // { maxSlots, archiveWindowMs, activeCharacterId, characters }
  rosterLoading: false,
  selectedCharId: null,
  switchOnJoin: false,
  createSlot: null,
  archiveTarget: null,
  greet: false,
  arrival: null,
  lastJourney: null,
  travelReset: false, // next authoritative self position snaps the camera (after travel)
  walkingTo: null, // keep the camera on its current floor when the streamed exterior appears
  lastAttack: -Infinity, lastTargetPick: -Infinity,
  doorArrival: false, // the previous view stays painted while the destination of a door transfer loads
  arrivalWait: null, // {op, resolve, reject, detail}: the loading screen holds until the current place is complete
  sceneError: null, // {location, message}: the last scene a feature could not draw
  firstFrame: null, // set when the game is revealed; filled in by the first gameplay frame (evidence for tests)
};
const guestEscape = new URLSearchParams(location.search).has('guest');

// ---------------------------------------------------------------- gameplay API + shell

const settings = loadSettings();
const api = createGameplayApi({
  send: (verb, args) => S.connected && S.conn ? S.conn.sendAction(verb, args) : false,
  applyScene: (mesh) => applyScene(mesh),
  notify: (text, opts) => shell?.toast(text, opts),
});
let shell = null;
let featuresReady = null; // resolves once every gameplay feature has installed (the arrival gate needs their hooks)
api.on('sceneError', (e) => { if (e && typeof e.location === 'string') S.sceneError = { location: e.location, message: String(e.message ?? 'unknown error') }; });


// ---------------------------------------------------------------- screens & events

function emit(type, detail) {
  window.dispatchEvent(new CustomEvent(type, { detail }));
}

function showScreen(name) {
  S.screen = name;
  document.body.dataset.screen = name;
  ui.landing.hidden = name !== 'landing';
  ui.loading.hidden = name !== 'loading';
  ui.failure.hidden = name !== 'failure';
  ui.hud.hidden = name !== 'game';
  input.setEnabled(name === 'game');
  if (name !== 'game') shell?.close();
  if (name === 'landing') refreshLanding();
  api.screen = name;
  emit('game:screen', { screen: name });
  api.emit('screen', name);
}

function setConn(state, text) {
  document.body.dataset.conn = state;
  ui.conn.dataset.conn = state;
  ui.conn.textContent = text ?? { online: '', connecting: 'Connecting…', lost: 'Disconnected', closed: 'Offline', idle: '' }[state];
  // Features (journal, party) tell "disconnected, last known state" apart from "nothing yet".
  if (api.connection !== state) { api.connection = state; api.emit('connection', state); }
}

function setStep(step, state) {
  for (const li of ui.steps.children) {
    if (step === '*') li.dataset.state = state;
    else if (li.dataset.step === step) li.dataset.state = state;
  }
}

function fail({ title, message, hint = '', retry = null, folder = false, back = true, retryLabel = 'Try again' }) {
  ui.failTitle.textContent = title;
  ui.failMsg.textContent = message;
  ui.failHint.textContent = hint;
  S.failureRetry = retry;
  ui.failRetry.hidden = !retry;
  ui.failRetry.textContent = retryLabel;
  ui.failFolder.hidden = !folder;
  ui.failBack.hidden = !back;
  showScreen('failure');
  (retry ? ui.failRetry : ui.failBack).focus();
}

// ---------------------------------------------------------------- landing

function townReadyFor(data) {
  return S.town && S.townData === data;
}

function selectedActiveCharacter() {
  const chars = S.roster?.characters ?? [];
  const active = chars.filter((c) => c.status === 'active');
  if (!active.length) return null;
  return active.find((c) => c.id === S.selectedCharId)
    ?? active.find((c) => c.lastSelected)
    ?? active[0];
}

function refreshLanding() {
  const signedIn = !!S.account;
  const guestAllowed = S.auth === 'off';
  // Signed-in players pick from their character roster; the name field is only for guests.
  ui.nameField.hidden = signedIn || !guestAllowed;
  if (ui.charSelector) ui.charSelector.hidden = !signedIn;
  const problem = signedIn ? null : nameProblem(ui.name.value);
  const nameOk = signedIn || (guestAllowed && !problem);
  if (!signedIn && ui.name.value && problem) ui.nameNote.textContent = problem;
  else if (!ui.nameNote.dataset.sticky) ui.nameNote.textContent = '';
  const dataOk = !!(S.data && !S.data.problem);
  let gate = '';
  if (S.auth === 'checking') gate = 'Checking your account…';
  else if (!signedIn && !guestAllowed) gate = 'Sign in or create an account to enter the world.';
  else if (signedIn) gate = `Signed in as ${S.account.username}.${dataOk || discoveringData ? '' : ' Choose your game folder to continue.'}`;
  ui.accountGate.textContent = gate;
  ui.accountGate.hidden = !gate;
  ui.accountGate.dataset.state = signedIn ? 'signed-in' : S.auth;

  const rosterChars = S.roster?.characters ?? [];
  const activeChars = rosterChars.filter((c) => c.status === 'active');
  const selected = signedIn ? selectedActiveCharacter() : null;
  const allArchived = signedIn && S.roster && activeChars.length === 0 && rosterChars.length >= (S.roster.maxSlots ?? 3);
  const hasArchivedOnly = signedIn && S.roster && activeChars.length === 0 && rosterChars.length > 0;
  const needsSelection = signedIn && S.roster && (allArchived || hasArchivedOnly);

  ui.enter.disabled = !(nameOk && dataOk) || S.auth === 'checking' || Boolean(needsSelection);
  if (signedIn && selected) {
    const isSwitch = Boolean(S.roster?.activeCharacterId && S.roster.activeCharacterId !== selected.id);
    if (isSwitch) {
      ui.enter.textContent = `Switch to ${selected.name}`;
    } else if (selected.draft && !selected.created) {
      ui.enter.textContent = `Continue creating ${selected.name}`;
    } else {
      ui.enter.textContent = `Resume ${selected.name}`;
    }
  } else if (signedIn && hasArchivedOnly) {
    ui.enter.textContent = allArchived ? 'Restore an archived character to play' : 'Create or restore a character';
  } else {
    const who = signedIn ? ` as ${S.account.username}` : '';
    ui.enter.textContent = dataOk && townReadyFor(S.data) ? `Return to ${S.town.name || 'the world'}${who}` : `Enter the world${who}`;
  }
}

// ---------------------------------------------------------------- character roster selector

function formatRelativeTime(ts) {
  if (!ts || !Number.isFinite(Number(ts))) return 'Never';
  const diffMs = Math.max(0, Date.now() - Number(ts));
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 14) return `${days}d ago`;
  return new Date(Number(ts)).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function formatRestoreWindow(purgeAfter) {
  if (!purgeAfter || !Number.isFinite(Number(purgeAfter))) return 'Restorable';
  const remMs = Math.max(0, Number(purgeAfter) - Date.now());
  const hrs = Math.ceil(remMs / 3_600_000);
  if (hrs <= 24) return `${Math.max(1, hrs)}h left to restore`;
  const days = Math.ceil(remMs / 86_400_000);
  return `${days}d left to restore`;
}

function setRosterNote(text, { error = false } = {}) {
  if (!ui.charRosterNote) return;
  ui.charRosterNote.textContent = text || '';
  ui.charRosterNote.classList.toggle('error', Boolean(error));
  ui.charRosterNote.hidden = !text;
}

async function rosterRequest(path, body) {
  const init = body === undefined
    ? { method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' } }
    : {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      };
  const res = await fetch(path, init);
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error(data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = data?.code;
    err.blockers = data?.blockers;
    throw err;
  }
  return data ?? {};
}

function closeRosterDrawers() {
  S.createSlot = null;
  S.archiveTarget = null;
  if (ui.charCreateBox) ui.charCreateBox.hidden = true;
  if (ui.charArchiveBox) ui.charArchiveBox.hidden = true;
}

function openCreateDrawer(slot) {
  closeRosterDrawers();
  S.createSlot = slot;
  if (ui.charCreateTitle) ui.charCreateTitle.textContent = `Create character in Slot ${slot}`;
  if (ui.charCreateName) {
    ui.charCreateName.value = S.roster?.characters?.length === 0 && S.account?.username ? S.account.username : '';
  }
  if (ui.charCreateBox) ui.charCreateBox.hidden = false;
  setRosterNote('');
  ui.charCreateName?.focus();
}

function openArchiveDrawer(char) {
  closeRosterDrawers();
  S.archiveTarget = char;
  const days = Math.max(1, Math.round((S.roster?.archiveWindowMs ?? 7 * 86_400_000) / 86_400_000));
  if (ui.charArchiveTitle) ui.charArchiveTitle.textContent = `Archive ${char.name} (Slot ${char.slot})`;
  if (ui.charArchiveWarn) {
    ui.charArchiveWarn.textContent =
      `Archiving hides ${char.name} from the world and Chronicles and retires active parties. `
      + `Slot ${char.slot} and the name "${char.name}" remain reserved for ${days} days so you can restore before permanent purge.`;
  }
  const blockers = Array.isArray(char.blockers) ? char.blockers : [];
  if (ui.charArchiveBlockers) {
    ui.charArchiveBlockers.replaceChildren(...blockers.map((b) => {
      const li = document.createElement('li');
      li.textContent = b.message || String(b);
      return li;
    }));
    ui.charArchiveBlockers.hidden = blockers.length === 0;
  }
  if (ui.charArchiveConfirmWrap) ui.charArchiveConfirmWrap.hidden = blockers.length > 0;
  if (ui.charArchiveLabel) ui.charArchiveLabel.textContent = `Type "${char.name}" to confirm archiving`;
  if (ui.charArchiveInput) {
    ui.charArchiveInput.value = '';
    ui.charArchiveInput.placeholder = char.name;
  }
  if (ui.charArchiveSubmit) ui.charArchiveSubmit.disabled = true;
  if (ui.charArchiveBox) ui.charArchiveBox.hidden = false;
  setRosterNote('');
  if (!blockers.length) ui.charArchiveInput?.focus();
}

function syncHudSwitchButton() {
  if (!ui.switchBtn) return;
  const activeCount = (S.roster?.characters ?? []).filter((c) => c.status === 'active').length;
  ui.switchBtn.hidden = !S.account || activeCount < 1;
}

function renderRosterSelector() {
  if (!ui.charSlots || !ui.charSelector) return;
  if (!S.account) {
    ui.charSelector.hidden = true;
    closeRosterDrawers();
    syncHudSwitchButton();
    refreshLanding();
    return;
  }
  ui.charSelector.hidden = false;
  const maxSlots = S.roster?.maxSlots ?? 3;
  const chars = S.roster?.characters ?? [];
  const bySlot = new Map(chars.map((c) => [c.slot, c]));
  const selected = selectedActiveCharacter();
  if (selected && S.selectedCharId !== selected.id) S.selectedCharId = selected.id;
  if (ui.charSlotCount) {
    ui.charSlotCount.textContent = S.rosterLoading && !S.roster
      ? 'Loading roster…'
      : `${chars.length} / ${maxSlots} slots`;
  }

  const cards = [];
  for (let slot = 1; slot <= maxSlots; slot++) {
    const c = bySlot.get(slot);
    const card = document.createElement('article');
    card.className = 'char-card';
    card.setAttribute('role', 'listitem');
    card.dataset.slot = String(slot);

    if (!c) {
      card.dataset.state = 'empty';
      const tag = document.createElement('span');
      tag.className = 'char-slot-tag';
      tag.textContent = `Slot ${slot}`;
      const label = document.createElement('p');
      label.className = 'char-empty-label';
      label.textContent = 'Empty slot';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = chars.length === 0 && slot === 1 ? 'btn btn-primary btn-small' : 'btn btn-small';
      btn.textContent = 'Create character';
      btn.addEventListener('click', () => openCreateDrawer(slot));
      card.append(tag, label, btn);
      cards.push(card);
      continue;
    }

    const isArchived = c.status === 'archived';
    const isSelected = !isArchived && selected?.id === c.id;
    const isOnline = Boolean(c.online || S.roster?.activeCharacterId === c.id);
    const otherOnline = Boolean(!isArchived && S.roster?.activeCharacterId && S.roster.activeCharacterId !== c.id);

    card.dataset.state = isArchived ? 'archived' : 'active';
    card.dataset.characterId = String(c.id);
    card.dataset.selected = String(isSelected);

    const top = document.createElement('div');
    top.className = 'char-card-top';
    const tag = document.createElement('span');
    tag.className = 'char-slot-tag';
    tag.textContent = `Slot ${slot}`;
    const badge = document.createElement('span');
    badge.className = 'char-badge';
    if (isArchived) {
      badge.dataset.kind = 'archived';
      badge.textContent = 'Archived';
    } else if (isOnline) {
      badge.dataset.kind = 'online';
      badge.textContent = 'Online';
    } else if (c.draft && !c.created) {
      badge.dataset.kind = 'draft';
      badge.textContent = 'Draft';
    } else {
      badge.textContent = 'Active';
    }
    top.append(tag, badge);

    const nameEl = document.createElement('h3');
    nameEl.className = 'char-name';
    nameEl.textContent = c.name;

    const sub = document.createElement('p');
    sub.className = 'char-sub';
    sub.textContent = c.created
      ? `Level ${c.level} ${c.race || 'Adventurer'} ${c.className || ''}`.trim()
      : 'Unfinished — enter to create character';

    const meta = document.createElement('div');
    meta.className = 'char-meta';
    const addMeta = (k, v) => {
      const row = document.createElement('div');
      row.className = 'char-meta-row';
      const kl = document.createElement('span');
      kl.className = 'char-meta-label';
      kl.textContent = k;
      const vl = document.createElement('span');
      vl.className = 'char-meta-val';
      vl.textContent = v;
      row.append(kl, vl);
      meta.append(row);
    };
    addMeta('Location', c.locationName || 'Iliac Bay');
    addMeta(isArchived ? 'Window' : 'Last played', isArchived ? formatRestoreWindow(c.purgeAfter) : formatRelativeTime(c.lastPlayedAt));

    const actionsRow = document.createElement('div');
    actionsRow.className = 'char-card-actions';

    if (isArchived) {
      const restoreBtn = document.createElement('button');
      restoreBtn.type = 'button';
      restoreBtn.className = 'btn btn-primary btn-small';
      restoreBtn.textContent = 'Restore';
      restoreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void restoreCharacterSlot(c.id);
      });
      actionsRow.append(restoreBtn);
    } else {
      card.addEventListener('click', () => {
        S.selectedCharId = c.id;
        renderRosterSelector();
      });
      const resumeBtn = document.createElement('button');
      resumeBtn.type = 'button';
      resumeBtn.className = isSelected ? 'btn btn-primary btn-small' : 'btn btn-small';
      resumeBtn.textContent = otherOnline ? 'Switch' : (c.draft && !c.created ? 'Continue' : 'Resume');
      resumeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        S.selectedCharId = c.id;
        S.switchOnJoin = otherOnline;
        renderRosterSelector();
        if (!S.data || S.data.problem) {
          setRosterNote(`Selected ${c.name}. Choose your ARENA2 game folder below to enter.`);
          ui.pick.focus();
          return;
        }
        enter();
      });
      const archiveBtn = document.createElement('button');
      archiveBtn.type = 'button';
      archiveBtn.className = 'btn btn-small';
      archiveBtn.textContent = 'Archive';
      archiveBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openArchiveDrawer(c);
      });
      actionsRow.append(resumeBtn, archiveBtn);
    }

    card.append(top, nameEl, sub, meta, actionsRow);
    cards.push(card);
  }

  ui.charSlots.replaceChildren(...cards);
  syncHudSwitchButton();
  refreshLanding();
}

async function fetchRoster() {
  if (!S.account) {
    S.roster = null;
    S.selectedCharId = null;
    renderRosterSelector();
    return null;
  }
  S.rosterLoading = true;
  renderRosterSelector();
  try {
    const data = await rosterRequest('/api/characters');
    if (!S.account) return null;
    S.roster = data;
    const active = (data.characters ?? []).filter((c) => c.status === 'active');
    if (!active.some((c) => c.id === S.selectedCharId)) {
      const preferred = active.find((c) => c.lastSelected) ?? active[0] ?? null;
      S.selectedCharId = preferred ? preferred.id : null;
    }
    setRosterNote('');
    return data;
  } catch (err) {
    setRosterNote(err.message || 'Could not load your character roster.', { error: true });
    return null;
  } finally {
    S.rosterLoading = false;
    renderRosterSelector();
  }
}

async function startCharacterSlot() {
  if (!S.account || S.createSlot == null) return;
  const rawName = ui.charCreateName?.value ?? '';
  const problem = nameProblem(rawName);
  if (problem) {
    setRosterNote(problem, { error: true });
    ui.charCreateName?.focus();
    return;
  }
  const clean = cleanDisplayName(rawName);
  if (ui.charCreateSubmit) ui.charCreateSubmit.disabled = true;
  try {
    const res = await rosterRequest('/api/characters/start', { slot: S.createSlot, name: clean });
    closeRosterDrawers();
    await fetchRoster();
    if (res.character?.id) {
      S.selectedCharId = res.character.id;
      S.switchOnJoin = Boolean(S.roster?.activeCharacterId && S.roster.activeCharacterId !== res.character.id);
      renderRosterSelector();
    }
    setRosterNote(`Created ${res.character?.name || clean} in Slot ${res.character?.slot}.`);
    if (S.data && !S.data.problem) {
      enter();
    }
  } catch (err) {
    setRosterNote(err.message || 'Could not create character.', { error: true });
  } finally {
    if (ui.charCreateSubmit) ui.charCreateSubmit.disabled = false;
  }
}

async function archiveCharacterSlot() {
  const target = S.archiveTarget;
  if (!S.account || !target) return;
  const confirmName = (ui.charArchiveInput?.value ?? '').trim();
  if (confirmName !== target.name) {
    setRosterNote(`Type "${target.name}" exactly to confirm archiving.`, { error: true });
    return;
  }
  if (ui.charArchiveSubmit) ui.charArchiveSubmit.disabled = true;
  try {
    await rosterRequest('/api/characters/archive', { characterId: target.id, confirmName });
    closeRosterDrawers();
    await fetchRoster();
    setRosterNote(`${target.name} was archived. You can restore them during the 7-day window.`);
  } catch (err) {
    if (Array.isArray(err.blockers) && err.blockers.length) {
      target.blockers = err.blockers;
      openArchiveDrawer(target);
    }
    setRosterNote(err.message || 'Could not archive character.', { error: true });
  } finally {
    if (ui.charArchiveSubmit) ui.charArchiveSubmit.disabled = (ui.charArchiveInput?.value ?? '').trim() !== target.name;
  }
}

async function restoreCharacterSlot(characterId) {
  if (!S.account) return;
  try {
    const res = await rosterRequest('/api/characters/restore', { characterId });
    closeRosterDrawers();
    await fetchRoster();
    if (res.character?.id) S.selectedCharId = res.character.id;
    renderRosterSelector();
    setRosterNote(`Restored ${res.character?.name || 'character'} to Slot ${res.character?.slot}.`);
  } catch (err) {
    setRosterNote(err.message || 'Could not restore character.', { error: true });
  }
}

ui.charCreateCancel?.addEventListener('click', () => { closeRosterDrawers(); setRosterNote(''); });
ui.charCreateSubmit?.addEventListener('click', () => { void startCharacterSlot(); });
ui.charCreateName?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); void startCharacterSlot(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeRosterDrawers(); }
});
ui.charArchiveCancel?.addEventListener('click', () => { closeRosterDrawers(); setRosterNote(''); });
ui.charArchiveInput?.addEventListener('input', () => {
  const target = S.archiveTarget;
  if (ui.charArchiveSubmit) {
    ui.charArchiveSubmit.disabled = !target || ui.charArchiveInput.value.trim() !== target.name;
  }
});
ui.charArchiveInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !ui.charArchiveSubmit?.disabled) { e.preventDefault(); void archiveCharacterSlot(); }
  else if (e.key === 'Escape') { e.preventDefault(); closeRosterDrawers(); }
});
ui.charArchiveSubmit?.addEventListener('click', () => { void archiveCharacterSlot(); });

window.dfwRoster = {
  refresh: () => fetchRoster(),
  get state() { return S.roster; },
  openCreate: (slot) => openCreateDrawer(slot),
  openArchive: (id) => {
    const c = (S.roster?.characters ?? []).find((r) => r.id === Number(id));
    if (c) openArchiveDrawer(c);
  },
  select(id) {
    S.selectedCharId = Number(id);
    renderRosterSelector();
  },
};

function describeData(sel) {
  if (sel.problem) {
    ui.drop.dataset.state = 'error';
    ui.dataStatus.textContent = sel.problem;
    return;
  }
  const where = sel.source === 'cache' ? 'the copy saved in this browser' : sel.dir ? `“${sel.dir}”` : 'the selected folder';
  ui.drop.dataset.source = sel.source || 'folder';
  ui.cacheField.hidden = sel.source === 'installed'; // the server's own files are never copied
  if (sel.source === 'installed' && !sel.missing.length) {
    ui.drop.dataset.state = 'ready';
    ui.dataStatus.textContent = `Installed game files ready — ${sel.files.length} files from ARENA2 on this computer.`;
  } else if (sel.missing.length) {
    ui.drop.dataset.state = 'warn';
    ui.dataStatus.textContent = `Using ${sel.files.length} files from ${where}. Missing ${sel.missing.join(', ')} — the town may not load.`;
  } else {
    ui.drop.dataset.state = 'ready';
    ui.dataStatus.textContent = `Ready: ${sel.files.length} files from ${where}.`;
  }
  ui.pick.textContent = 'Change folder…';
}

// Bumped by every data source (folder pick, drop, installed discovery) so a slow discovery
// can never replace a folder the player chose in the meantime.
let dataSeq = 0;
let discoveringData = false; // installed-data lookup in flight (localhost only)

function acceptData(items, source = 'folder') {
  dataSeq++;
  const sel = selectArena2(items);
  sel.source = source;
  if (!sel.problem && S.data && !S.data.problem && S.data.source === source && sameFiles(S.data.files, sel.files)) {
    describeData(S.data); // same folder again: keep the loaded town
  } else {
    S.data = sel;
    describeData(sel);
    if (!sel.problem) {
      api.files = sel.files;
      api.emit('assets', sel.files);
      savedFolder = null; // a working folder supersedes a pending "Resume saved folder"
      ui.resume.hidden = true;
      cacheSelection();
    }
  }
  ui.formError.hidden = true;
  refreshLanding();
}

function sameFiles(a, b) {
  if (a.length !== b.length) return false;
  const key = (f) => `${f.name}:${f.size}:${f.lastModified}`;
  const set = new Set(a.map(key));
  return b.every((f) => set.has(key(f)));
}

ui.pick.addEventListener('click', pickFolder);

// Localhost only: adopt the server operator's installed ARENA2 (server/local-assets.js) through the
// same acceptData path a folder pick uses. Metadata only; bytes are read lazily by the game readers.
async function discoverInstalledData() {
  if (!isLoopbackPage()) return;
  const seq = ++dataSeq;
  discoveringData = true;
  if (!S.data) ui.dataStatus.textContent = 'Looking for installed game files on this computer…';
  const found = await discoverInstalledArena2().catch(() => null);
  discoveringData = false;
  refreshLanding();
  if (seq !== dataSeq || S.data) return; // the player chose or dropped a folder meanwhile
  if (!found) {
    ui.dataStatus.textContent = DATA_PROMPT;
    return;
  }
  acceptData(found.files, 'installed');
}

// ------------------------------------------------ saved folder and local copy (lib/arena2-store.js)
// Both live only in this browser (IndexedDB / origin private file system); nothing is uploaded.

const DATA_PROMPT = 'Select the ARENA2 folder from your Daggerfall install, or the install folder that contains it. You can also drop the folder here.';
const arena2Store = createArena2Store();
const canPickDir = typeof window.showDirectoryPicker === 'function';
const KEEP_COPY = 'dfw.arena2.keepCopy'; // per-browser preference only
let savedFolder = null; // { handle, name } waiting for a "Resume" click to grant permission
let caching = null; // AbortController of the copy in progress
let cacheRun = Promise.resolve();

const setCacheStatus = (text) => (ui.cacheStatus.textContent = text);
function keepCopyPref() {
  try {
    const v = localStorage.getItem(KEEP_COPY);
    if (v !== null) return v === '1';
  } catch {}
  return !canPickDir; // browsers without saved folder handles rely on the copy; Chromium opts in
}
ui.cacheBox.checked = keepCopyPref();

async function refreshSaved() {
  const [folder, cache] = await Promise.all([arena2Store.loadSavedFolder(), arena2Store.cacheInfo()]);
  ui.forget.hidden = !folder && !cache;
}

async function stopCaching() {
  caching?.abort();
  await cacheRun;
}

/** Copy the current selection into this browser when the player opted in. */
function cacheSelection() {
  const sel = S.data;
  if (!ui.cacheBox.checked || !sel || sel.problem || sel.source === 'installed' || sel.source === 'cache') return;
  caching?.abort();
  const ctl = (caching = new AbortController());
  const prev = cacheRun;
  const total = sel.files.length;
  cacheRun = (async () => {
    await prev; // one copy at a time: an aborted run clears its files before the next writes
    if (ctl.signal.aborted) return;
    setCacheStatus(`Saving a copy in this browser… 0 of ${total} files`);
    const res = await arena2Store.cacheFiles(sel.files, {
      dir: sel.dir, signal: ctl.signal,
      onProgress: ({ stored }) => setCacheStatus(`Saving a copy in this browser… ${stored} of ${total} files`),
    });
    if (caching === ctl) caching = null;
    if (res.ok) setCacheStatus('Saved a copy in this browser. Next time the world loads without choosing the folder.');
    else if (res.reason === 'quota') setCacheStatus('Not enough browser storage for a copy. You can still play; you will choose the folder again next visit.');
    else if (res.reason !== 'aborted') setCacheStatus('Could not save a copy in this browser. You can still play.');
    await refreshSaved();
  })();
}

/** The cached files are about to be deleted: stop using them. */
function dropCachedData() {
  if (S.data?.source !== 'cache') return;
  dataSeq++;
  S.data = null;
  api.files = [];
  delete ui.drop.dataset.source;
  ui.drop.dataset.state = 'empty';
  ui.dataStatus.textContent = DATA_PROMPT;
  ui.pick.textContent = 'Choose ARENA2 folder…';
  refreshLanding();
}

ui.cacheBox.addEventListener('change', async () => {
  try { localStorage.setItem(KEEP_COPY, ui.cacheBox.checked ? '1' : '0'); } catch {}
  if (ui.cacheBox.checked) return cacheSelection();
  await stopCaching();
  dropCachedData();
  await arena2Store.clearCache();
  setCacheStatus('');
  refreshSaved();
});

/** Read a directory handle (picked now or saved earlier) and remember it on success. */
async function useHandle(handle) {
  const seq = ++dataSeq;
  ui.dataStatus.textContent = `Reading “${handle.name}”…`;
  let entries;
  try {
    entries = await readDirectoryHandle(handle);
  } catch (err) {
    if (seq !== dataSeq) return;
    ui.drop.dataset.state = 'error';
    ui.dataStatus.textContent = `Could not read “${handle.name}” (${err.message}). Choose the folder again.`;
    return;
  }
  if (seq !== dataSeq) return; // the player chose something else meanwhile
  acceptData(entries);
  if (S.data.problem) return;
  await arena2Store.saveHandle(handle).catch(() => {});
  refreshSaved();
}

/** Folder picker: a saved-able directory handle on Chromium, <input webkitdirectory> elsewhere. */
async function pickFolder() {
  if (!canPickDir) return ui.dataInput.click();
  let handle;
  try {
    handle = await window.showDirectoryPicker({ id: 'dfw-arena2', mode: 'read' });
  } catch (err) {
    if (err?.name !== 'AbortError') ui.dataInput.click(); // e.g. blocked in a frame: classic picker
    return;
  }
  await useHandle(handle);
}

/** Return visit: the local copy first (fastest), else the saved folder handle. */
async function restoreSavedData() {
  const seq = dataSeq;
  const stale = () => seq !== dataSeq || !!S.data; // installed files, a pick or a drop won
  if (await arena2Store.cacheInfo()) {
    if (stale()) return refreshSaved();
    ui.dataStatus.textContent = 'Loading the copy saved in this browser…';
    const entries = await arena2Store.loadCache();
    if (stale()) return refreshSaved();
    if (entries) {
      acceptData(entries, 'cache');
      return refreshSaved();
    }
    await arena2Store.clearCache();
    ui.dataStatus.textContent = DATA_PROMPT;
    setCacheStatus('The copy saved in this browser was incomplete and has been removed.');
  } else if (!stale()) {
    // No manifest: a copy interrupted by a reload left its bytes behind with nothing to restore them from.
    await arena2Store.clearCache();
  }
  const saved = canPickDir ? await arena2Store.loadSavedFolder() : null;
  if (saved && !stale()) {
    const perm = await folderPermission(saved.handle);
    if (stale()) return refreshSaved();
    if (perm === 'granted') {
      await useHandle(saved.handle);
    } else if (perm === 'prompt') {
      savedFolder = saved;
      ui.resume.textContent = `Resume saved folder (${saved.name})`;
      ui.resume.hidden = false;
      ui.dataStatus.textContent = `Your browser needs permission to read “${saved.name}” again. Click Resume, or choose another folder.`;
    } else {
      ui.dataStatus.textContent = `This browser blocked access to “${saved.name}”. Choose the folder again.`;
    }
  }
  refreshSaved();
}

ui.resume.addEventListener('click', async () => {
  const saved = savedFolder;
  if (!saved) return;
  if ((await folderPermission(saved.handle, { request: true })) === 'granted') return useHandle(saved.handle);
  ui.dataStatus.textContent = `Permission to read “${saved.name}” was not given. Click Resume to try again, or choose the folder.`;
});

ui.forget.addEventListener('click', async () => {
  await stopCaching();
  await arena2Store.forget();
  savedFolder = null;
  ui.resume.hidden = true;
  dropCachedData();
  setCacheStatus('Forgot the saved folder and deleted the copy from this browser.');
  await refreshSaved();
  ui.pick.focus();
});
ui.dataInput.addEventListener('change', () => {
  if (ui.dataInput.files && ui.dataInput.files.length) acceptData(ui.dataInput.files);
  ui.dataInput.value = '';
});

for (const target of [ui.drop, ui.landing]) {
  target.addEventListener('dragover', (e) => {
    if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
    e.preventDefault();
    ui.drop.dataset.prevState ??= ui.drop.dataset.state;
    ui.drop.dataset.state = 'dragover';
  });
  target.addEventListener('dragleave', (e) => {
    if (e.target === target && ui.drop.dataset.prevState) {
      ui.drop.dataset.state = ui.drop.dataset.prevState;
      delete ui.drop.dataset.prevState;
    }
  });
  target.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const prev = ui.drop.dataset.prevState ?? 'empty';
    delete ui.drop.dataset.prevState;
    ui.drop.dataset.state = prev;
    dataSeq++;
    ui.dataStatus.textContent = 'Reading dropped folder…';
    try {
      const entries = await readDroppedEntries(e.dataTransfer);
      acceptData(entries.length ? entries : e.dataTransfer.files);
    } catch (err) {
      ui.drop.dataset.state = 'error';
      ui.dataStatus.textContent = `Could not read the dropped folder (${err.message}). Use the button instead.`;
    }
  });
}

ui.name.addEventListener('input', () => {
  delete ui.nameNote.dataset.sticky;
  ui.formError.hidden = true;
  refreshLanding();
});

ui.form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (S.auth === 'checking') return;
  if (!S.account && S.auth !== 'off') { document.querySelector('#account-panel input, #account-panel button')?.focus(); return; }
  if (!S.data || S.data.problem) { ui.pick.focus(); return; }
  if (S.account) {
    const sel = selectedActiveCharacter();
    S.name = sel?.name || S.account.username;
    if (sel) {
      S.selectedCharId = sel.id;
      S.switchOnJoin = Boolean(S.roster?.activeCharacterId && S.roster.activeCharacterId !== sel.id);
    }
  } else {
    const problem = nameProblem(ui.name.value);
    if (problem) { ui.nameNote.textContent = problem; ui.name.focus(); return; }
    S.name = cleanDisplayName(ui.name.value);
    ui.name.value = S.name;
    identity.lastName = S.name;
  }
  enter();
});

// ---------------------------------------------------------------- accounts

function setAccount(user) {
  const prev = S.account;
  S.account = user && user.username ? { id: String(user.id), username: String(user.username) } : null;
  if (S.auth === 'checking' || S.auth === 'required') S.auth = 'required';
  if (guestEscape && !S.account) S.auth = 'off';
  api.account = S.account;
  api.emit('account', S.account);
  const changedAccount = (prev?.id ?? null) !== (S.account?.id ?? null);
  if (changedAccount) {
    S.roster = null;
    S.selectedCharId = null;
    S.switchOnJoin = false;
    closeRosterDrawers();
    setRosterNote('');
  }
  // Signing out (or switching account) while in the world returns to the title screen and clears private state.
  if (S.screen !== 'landing' && prev && (!S.account || prev.id !== S.account.id)) {
    leave();
    ui.formError.textContent = S.account ? 'You switched accounts. Choose a character to enter the world.' : 'You signed out.';
    ui.formError.hidden = false;
  }
  if (S.account && (changedAccount || !S.roster)) {
    void fetchRoster();
  } else {
    renderRosterSelector();
  }
  refreshLanding();
}

window.addEventListener('account:change', (e) => setAccount(e.detail?.user ?? null));

async function loadAccounts() {
  try {
    await import('/auth/account.js');
  } catch (err) {
    // No account service on this server (prototype or test build): play as a guest.
    console.info('[auth] account module unavailable, guest play enabled:', err.message);
    S.auth = 'off';
    refreshLanding();
    return;
  }
  if (guestEscape && !S.account) S.auth = 'off';
  // The module may have reported before this listener existed; its ready promise has the answer.
  window.dfwAccount?.ready?.then((u) => { if (S.auth === 'checking') setAccount(u ?? null); }).catch(() => {});
  // The module reports the session with 'account:change'; don't wait forever if it never does.
  setTimeout(() => { if (S.auth === 'checking') { S.auth = guestEscape ? 'off' : 'required'; refreshLanding(); } }, 5000);
}

// ---------------------------------------------------------------- loading pipeline

function ensureRenderer() {
  if (renderer) return renderer;
  renderer = new Renderer(ui.canvas);
  renderer.onContextChange = (what) => {
    if (what === 'lost' && S.screen === 'game') addChat(null, 'Graphics were reset by the browser; restoring…', { system: true });
  };
  return renderer;
}

function townJob(data) {
  if (S.townJob && S.townJob.data === data) return S.townJob.promise;
  const promise = (async () => {
    let mod;
    try {
      mod = await import('./world/town.js');
    } catch (err) {
      throw Object.assign(new Error(`The town builder failed to load: ${err.message}`), { kind: 'module' });
    }
    if (typeof mod.loadTown !== 'function') {
      throw Object.assign(new Error('world/town.js does not export loadTown().'), { kind: 'module' });
    }
    S.loadingPhase = 'build';
    let town;
    try {
      town = await mod.loadTown(data.files);
    } catch (err) {
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), { kind: 'town' });
    }
    if (!town || !town.positions || !town.positions.length) {
      throw Object.assign(new Error('The town builder returned no geometry.'), { kind: 'town' });
    }
    return town;
  })();
  S.townJob = { data, promise };
  promise.catch(() => { if (S.townJob?.promise === promise) S.townJob = null; });
  return promise;
}

async function enter({ reconnecting = false } = {}) {
  const op = ++S.op;
  S.doorArrival = false;
  S.firstFrame = api.firstFrame = null;
  const data = S.data;
  ui.loadingTitle.textContent = townReadyFor(data) ? `Returning to ${S.town.name || 'town'}…` : 'Travelling…';
  setStep('*', 'pending');
  ui.loadingDetail.textContent = '';
  showScreen('loading');
  ui.loadingCancel.focus();

  if (!townReadyFor(data)) {
    setStep('read', 'active');
    ui.loadingDetail.textContent = `${data.files.length} files from ${data.dir || 'the selected folder'}`;
    let town;
    try {
      const job = townJob(data);
      // The builder does reading and building in one call; advance the indicator once it
      // has had a moment to start.
      const tick = setTimeout(() => { if (op === S.op) { setStep('read', 'done'); setStep('build', 'active'); } }, 400);
      town = await job;
      clearTimeout(tick);
    } catch (err) {
      if (op !== S.op) return;
      setStep('read', 'done');
      setStep('build', 'failed');
      console.error(err);
      if (err.kind === 'module') {
        return fail({
          title: 'The town builder is unavailable',
          message: err.message,
          hint: 'The client could not load world/town.js. Reload the page; if it persists, the installation is incomplete.',
          retry: enter,
        });
      }
      return fail({
        title: 'Could not raise the town',
        message: err.message || 'The game data could not be read.',
        hint: 'Make sure you chose the ARENA2 folder (or its parent) from a complete Daggerfall installation.',
        retry: enter, folder: true,
      });
    }
    if (op !== S.op) return;
    setStep('read', 'done');
    setStep('build', 'active');
    try {
      ensureRenderer().setTown(town);
      S.ground = groundFor(town);
      S.town = town;
      S.townData = data;
      api.renderer = renderer;
      api.town = town;
      api.emit('scene', town);
    } catch (err) {
      console.error(err);
      setStep('build', 'failed');
      const webgl = /webgl/i.test(err.message);
      return fail({
        title: webgl ? 'Your browser cannot draw the town' : 'Could not display the town',
        message: err.message,
        hint: webgl ? 'Enable hardware acceleration / WebGL in your browser settings, or try another browser.' : '',
        retry: webgl ? null : enter, folder: !webgl,
      });
    }
  }
  setStep('read', 'done');
  setStep('build', 'done');
  setStep('connect', 'active');
  ui.loadingDetail.textContent = 'Connecting to the town server…';

  try {
    await join(op);
  } catch (err) {
    if (op !== S.op || err.kind === 'cancelled') return;
    setStep('connect', 'failed');
    releaseClaim();
    if ((err.kind === 'rejected' || err.kind === 'account') && !err.retryable) {
      showScreen('landing');
      ui.formError.textContent = err.message;
      ui.formError.hidden = false;
      (S.account ? ui.enter : ui.name).focus();
      return;
    }
    return fail({
      title: err.kind === 'full' ? 'The town is full' : 'Could not reach the town',
      message: err.message,
      hint: err.kind === 'full'
        ? 'Wait for someone to leave, then try again.'
        : 'The town server may be offline or restarting. Your town is loaded, so retrying is quick.',
      retry: enter,
    });
  }
  if (op !== S.op) return;
  setStep('connect', 'done');
  setStep('arrive', 'active');
  try {
    const outcome = await arrive(op);
    if (op !== S.op) return;
    startGame(outcome, reconnecting);
  } catch (err) {
    if (op !== S.op || err.kind === 'cancelled') return;
    return failArrival(err, reconnecting);
  }
  setStep('arrive', 'done');
  if (reconnecting) addChat(null, 'Reconnected.', { system: true });
}

function failArrival(err, keepChat) {
  setStep('arrive', 'failed');
  const failedLocation = api.location;
  abandonJoin();
  // A join that never reached the world leaves no "You arrive…" lines behind for the retry to repeat.
  if (!keepChat) ui.chatLog.replaceChildren();
  if (err.kind === 'client') {
    return fail({ title: 'Could not load the game client', message: err.message, retry: () => window.location.reload(), retryLabel: 'Reload game' });
  }
  if (err.kind === 'people' || err.kind === 'combat') {
    return fail({ title: 'Could not load the occupants here', message: err.message, retry: enter });
  }
  if (err.kind !== 'closed') {
    return fail({
      title: 'Could not finish loading this place',
      message: err.message,
      hint: 'Try again, or choose your complete ARENA2 folder.',
      retry: () => {
        if (err.kind === 'exterior' || err.kind === 'scenery') api.exterior?.arrival?.(failedLocation, { retry: true });
        api.emit('assets', S.data?.files ?? []);
        enter();
      },
      folder: true,
    });
  }
  return fail({
    title: 'The connection dropped while arriving',
    message: err.message,
    hint: 'The server may be restarting. Your town is loaded, so retrying is quick.',
    retry: enter,
  });
}

/**
 * Hold the loading screen until the place the server put us in is complete (client/lib/arrival.js). Re-checked
 * every animation frame and on every state/scene change; no timer decides it. Resolves with the final status.
 */
async function arrive(op) {
  const installed = await featuresReady;
  if (!S.connected && op === S.op) throw Object.assign(new Error('The connection closed before the location was ready.'), { kind: 'closed' });
  if (op !== S.op) throw Object.assign(new Error('cancelled'), { kind: 'cancelled' });
  for (const name of ['actors', 'collision', 'interiors', 'scenery', 'travel', 'wilderness']) {
    if (!installed.some(r => r.name === name && r.ok)) {
      throw Object.assign(new Error(`The ${name} module did not load. Reload the game to try again.`), { kind: 'client' });
    }
  }
  return new Promise((resolve, reject) => {
    S.arrivalWait = { op, resolve, reject, detail: '' };
    checkArrival();
  });
}

function checkArrival() {
  const w = S.arrivalWait;
  if (!w) return;
  if (w.op !== S.op) { S.arrivalWait = null; w.reject(Object.assign(new Error('cancelled'), { kind: 'cancelled' })); return; }
  let st;
  try {
    // A reconnect retains the last snapshot for the disconnected HUD until this connection sends its own.
    st = S.greet ? { waiting: ['Waiting for the server to place you…'] }
      : arrivalStatus(api, { scene: S.town, at: { x: S.predictor.x, z: S.predictor.z }, sceneError: S.sceneError, requireRoster: S.conn?.arrival === true });
  } catch (err) {
    console.error('[arrival] status check failed:', err);
    st = { failed: { part: 'arrival', message: 'The game could not verify that this location finished loading.' } };
  }
  const place = currentPlace();
  const title = place && !/^Iliac Bay$/.test(place) ? `Arriving in ${place}…` : 'Arriving…';
  if (ui.loadingTitle.textContent !== title) ui.loadingTitle.textContent = title;
  if (st.failed) {
    S.arrivalWait = null;
    w.reject(Object.assign(new Error(st.failed.message), { kind: st.failed.part }));
    return;
  }
  if (!st.ready) {
    const detail = st.waiting.join(' ');
    if (detail !== w.detail) { w.detail = detail; ui.loadingDetail.textContent = detail; }
    return;
  }
  S.arrivalWait = null;
  w.resolve(st);
}

/** Drop a join that cannot finish arriving (failure, retry): the next enter() starts clean. */
function abandonJoin() {
  const conn = S.conn;
  S.conn = null;
  S.connected = false;
  conn?.close();
  releaseClaim();
  clearRemotes();
  api._reset();
  S.firstFrame = api.firstFrame = null;
  S.sceneError = null;
  S.doorArrival = false;
  S.arrival = S.lastJourney = null;
  S.travelReset = false;
  setConn('idle');
}

ui.loadingCancel.addEventListener('click', () => {
  S.op++;
  checkArrival(); // rejects a pending arrival as cancelled
  S.conn?.cancel();
  abandonJoin();
  ui.chatLog.replaceChildren();
  showScreen('landing');
});

ui.failRetry.addEventListener('click', () => S.failureRetry?.());
ui.failFolder.addEventListener('click', () => {
  showScreen('landing');
  pickFolder();
});
ui.failReport?.addEventListener('click', () => {
  openBugReport({
    category: 'gameplay',
    title: ui.failTitle.textContent || 'Game client error',
    screenshot: false,
    context: {
      screen: 'failure',
      errorTitle: ui.failTitle.textContent || '',
      errorMessage: ui.failMsg.textContent || '',
      errorHint: ui.failHint.textContent || '',
      url: location.href,
    },
  });
});
ui.failBack.addEventListener('click', () => showScreen('landing'));

// ---------------------------------------------------------------- website integration (patch notes & bug reports)

function currentRegionName() {
  const loc = api.location;
  if (loc) {
    const entry = api.travelWorld?.()?.catalog?.get?.(loc);
    if (entry?.region) return entry.region;
    const m = /^(?:town|interior|dungeon):([^/]+)\//.exec(loc);
    if (m && !/^\d+$/.test(m[1])) return m[1];
  }
  return S.town?.source?.region ?? S.town?.region ?? '';
}

function createBugDraft(opts = {}) {
  const inGame = S.screen === 'game';
  const liveContext = {
    screen: S.screen,
    location: inGame ? currentPlace() : '',
    locationId: api.location ?? '',
    region: currentRegionName(),
    panel: api.panel ?? '',
    conn: api.connection ?? document.body.dataset.conn ?? '',
    renderer: detectWebglRenderer(renderer),
    url: location.href,
  };
  let screenshot = null;
  if (opts.screenshot && typeof opts.screenshot === 'object') {
    screenshot = opts.screenshot;
  } else if (opts.screenshot !== false && opts.screenshot !== null && inGame) {
    screenshot = captureCanvasScreenshot(ui.canvas);
  }
  return buildBugDraft({
    ...opts,
    context: { ...liveContext, ...(opts.context && typeof opts.context === 'object' ? opts.context : {}) },
    screenshot,
  });
}

function openBugReport(opts = {}) {
  const draft = createBugDraft(opts);
  const saved = saveBugDraft(draft);
  window.open(BUG_REPORT_URL, '_blank', 'noopener');
  return { draft: saved.draft ?? draft, ok: saved.ok, droppedScreenshot: saved.droppedScreenshot };
}

api.openBugReport = openBugReport;
window.dfwBugDraft = {
  key: BUG_DRAFT_KEY,
  url: BUG_REPORT_URL,
  create: createBugDraft,
  save: saveBugDraft,
  open: openBugReport,
};

async function loadWhatsNew() {
  if (!ui.whatsNew || !ui.whatsNewLink || location.protocol === 'file:') return;
  try {
    const res = await fetch(PATCH_NOTES_FEED_URL, { headers: { Accept: 'application/json' }, cache: 'no-cache' });
    if (!res.ok) return;
    const entry = parseLatestPatchNote(await res.json());
    if (!entry) return;
    if (ui.whatsNewDate) {
      ui.whatsNewDate.textContent = entry.date;
      if (entry.date) ui.whatsNewDate.dateTime = entry.date;
      ui.whatsNewDate.hidden = !entry.date;
    }
    if (ui.whatsNewTitle) ui.whatsNewTitle.textContent = entry.headline;
    ui.whatsNewLink.href = entry.url;
    if (ui.whatsNewBadge) ui.whatsNewBadge.hidden = !isPatchNoteUnseen(entry.id);
    ui.whatsNewLink.addEventListener('click', () => {
      markPatchNoteSeen(entry.id);
      if (ui.whatsNewBadge) ui.whatsNewBadge.hidden = true;
    });
    ui.whatsNew.hidden = false;
  } catch {
    // Fail silently if patch notes feed is absent or unreachable.
  }
}

// ---------------------------------------------------------------- networking

async function claimProfile() {
  if (S.claim) return S.claim;
  const claim = await identity.claim(S.name);
  if (!claim.owned) {
    const t = S.guestTokens.get(claim.key);
    if (t) claim.sessionToken = t;
  }
  S.claim = claim;
  if (!claim.owned) {
    ui.nameNote.dataset.sticky = '1';
    ui.nameNote.textContent = `“${S.name}” is already playing in another tab; this tab joins as a separate traveller.`;
  }
  return claim;
}

function releaseClaim() {
  if (!S.claim) return;
  if (!S.claim.owned && S.claim.sessionToken) S.guestTokens.set(S.claim.key, S.claim.sessionToken);
  S.claim.release();
  S.claim = null;
}

async function join(op) {
  if (S.account) return joinAccount(op);
  const claim = await claimProfile();
  if (op !== S.op) throw Object.assign(new Error('cancelled'), { kind: 'cancelled' });
  setConn('connecting');
  for (let attempt = 0; attempt < 2; attempt++) {
    const conn = new Connection();
    S.conn = conn;
    const token = claim.token;
    try {
      const welcome = await conn.connect({ name: S.name, token });
      if (op !== S.op) { conn.close(); throw Object.assign(new Error('cancelled'), { kind: 'cancelled' }); }
      claim.adopt(welcome.token);
      if (!claim.owned) S.guestTokens.set(claim.key, welcome.token);
      attach(conn, welcome);
      return welcome;
    } catch (err) {
      // A stale saved traveller: forget it once and join fresh under the chosen name.
      if (err.kind === 'invalid-token' && token && attempt === 0) {
        claim.invalidate(token);
        S.guestTokens.delete(claim.key);
        continue;
      }
      setConn('closed');
      throw err;
    }
  }
  throw Object.assign(new Error('Could not join.'), { kind: 'unreachable' });
}

function accountWsUrl() {
  const base = defaultUrl();
  const params = new URLSearchParams();
  if (Number.isSafeInteger(S.selectedCharId) && S.selectedCharId > 0) {
    params.set('characterId', String(S.selectedCharId));
  }
  if (S.switchOnJoin) params.set('switch', '1');
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

/**
 * Account join: the session cookie identifies the player, so no guest token is sent. The first
 * account join offers this browser's saved guest of the same name (claimToken) so the server can
 * carry that character over; if the claim is refused we join once more without it.
 */
async function joinAccount(op) {
  setConn('connecting');
  const sel = selectedActiveCharacter();
  if (sel && !S.selectedCharId) S.selectedCharId = sel.id;
  const name = sel?.name || S.account.username;
  const allowClaim = !S.roster || (S.roster.characters ?? []).length === 0;
  let claimToken = allowClaim ? identity.storedToken(profileKeyOf(S.account.username)) : null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const conn = new Connection(accountWsUrl());
    S.conn = conn;
    try {
      const welcome = await conn.connect({ name, account: true, claimToken });
      if (op !== S.op) { conn.close(); throw Object.assign(new Error('cancelled'), { kind: 'cancelled' }); }
      if (claimToken) identity.writeToken(profileKeyOf(S.account.username), null); // now owned by the account
      S.selectedCharId = Number(welcome.id) || S.selectedCharId;
      S.switchOnJoin = false;
      attach(conn, welcome);
      return welcome;
    } catch (err) {
      if (claimToken && err.kind === 'rejected' && attempt === 0) { claimToken = null; continue; }
      setConn('closed');
      if (err.kind === 'unreachable' && err.code === 1006) {
        // The upgrade is refused (401) when the session has expired.
        err.message = 'Could not reach the world. If you were signed out, sign in again.';
      }
      if (err.kind === 'rejected') void fetchRoster();
      throw err;
    }
  }
  throw Object.assign(new Error('Could not join.'), { kind: 'unreachable' });
}

const profileKeyOf = (name) => String(name).trim().replace(/\s+/g, ' ').toLowerCase();

function attach(conn, welcome) {
  S.connected = true;
  S.pendingPositions = null;
  S.joinedAt = performance.now();
  S.selfId = welcome.id;
  S.selfName = welcome.player.name;
  S.sender.reset();
  clearRemotes();
  S.firstState = true;
  if (S.screen === 'game') S.predictor.reset(welcome.player.x, welcome.player.z); // reconnect: keep view
  else spawnAt(welcome.player);
  conn.onState = onState;
  conn.onChat = ({ name, text }) => {
    addChat(name, text, { self: name === S.selfName });
    for (const r of S.remotes.values()) {
      if (r.name === name) { r.say = text; r.sayUntil = performance.now() / 1000 + SAY_SECONDS; }
    }
  };
  conn.onError = (message) => {
    addChat(null, message, { system: true });
    api.message(capital(message), { kind: 'error' });
  };
  conn.onRpg = onRpg;
  conn.onGameEvent = onGameEvent;
  conn.onClose = (info) => onClosed(conn, info);
  api.selfId = String(welcome.id);
  S.greet = true;
  S.returning = welcome.returning;
  setConn('online');
  ui.banner.hidden = true;
  if (welcome.rpg) onRpg(welcome.rpg);
}

const capital = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);

function onRpg(rpg) {
  queueMicrotask(checkArrival);
  const previous = api.location;
  const { locationChanged } = api._receiveRpg(rpg);
  if (rpg.character) syncSwimBreath(S.body, api.character?.portal, api.location);
  // An outdoor crossing the exterior stream carried the view across (brief D): the same
  // spot, re-expressed in the new frame, so neither the camera nor held movement resets.
  const carried = locationChanged ? api.exterior?.crossing?.(previous, api.location) : null;
  if (locationChanged) {
    S.doorArrival = S.screen === 'game' && (S.doorArrival || crossesDoor(previous, api.location));
    S.sceneError = null;
  }
  if (carried) {
    S.predictor.shift(carried.x, carried.z);
    S.footY += carried.y;
    S.walkingTo = { from: previous, to: api.location, shift: carried };
    S.firstState = true;
    // Nearby players stay on screen across the edge (server/rpg/peers.js): re-express their
    // buffered positions in the new frame instead of dropping them.
    shiftRemotes(carried.x, carried.z);
    S.sender.reset();
  } else if (locationChanged) {
    S.walkingTo = null;
    // Travel: the next authoritative position snaps the camera; peers from the old place go.
    S.travelReset = true;
    S.firstState = true;
    clearRemotes();
    input.clear();
    S.sender.reset();
  }
  if (locationChanged || S.greet) {
    S.arrival = { location: api.location, as: S.greet && !locationChanged ? S.selfName : null };
  }
  updatePlace();
  if (S.greet) {
    S.greet = false;
    const returning = S.returning ?? statsOf(api.state)?.created === true;
    const who = S.selfName || S.account?.username;
    if (S.account) addChat(null, returning ? `Welcome back, ${who}.` : `Welcome, ${who}. Your story starts here.`, { system: true });
  }
  if (S.pendingPositions?.location === api.location) onState(S.pendingPositions.players, api.location);
}

function onGameEvent(ev) {
  if (ev.kind === 'locomotion' && ev.event === 'drown') S.body.breath = 0;
  if (ev.kind === 'teleport') S.landedAt = Number.isFinite(ev.y) ? { location: ev.location, y: ev.y } : null;
  if (ev.kind === 'travel' && typeof ev.name === 'string') S.lastJourney = { id: ev.to, name: ev.name };
  if (ev.kind === 'teleport' && ev.location === api.location && Number.isFinite(ev.y)) {
    input.clear();
    S.sender.reset();
    S.travelReset = true;
    S.footY = ev.y;
  }
  if (String(ev.playerId) === api.selfId && (ev.kind === 'defeat' || ev.kind === 'resurrect')) {
    input.clear();
    S.sender.reset();
    S.travelReset = true;
    api.message(ev.kind === 'defeat' ? 'You fell in battle. A nearby player can revive you.' : 'You are back on your feet.');
  }
  api.emit('event', ev);
  // Private notices with text are shown to the player unless a feature marks them silent.
  if (typeof ev.text === 'string' && ev.text && !ev.silent) {
    api.message(ev.text, { kind: ev.kind === 'error' ? 'error' : 'info', event: ev });
  }
}

function onClosed(conn, info) {
  if (conn !== S.conn || info.byUs) return;
  S.connected = false;
  const d = describeClose(info.code, info.reason);
  if (info.code === CLOSE.INVALID_TOKEN && S.claim) S.claim.invalidate(S.claim.token);
  if (S.arrivalWait) {
    // Still on the loading screen: the join failed; say so there instead of on the hidden HUD.
    const w = S.arrivalWait;
    S.arrivalWait = null;
    w.reject(Object.assign(new Error(d.text), { kind: 'closed' }));
    return;
  }
  // At most one silent retry per 15 s of stable play, so a flapping server can't loop us.
  const stable = performance.now() - S.joinedAt > 15000;
  if (d.auto && (!S.autoRetried || stable)) {
    S.autoRetried = true;
    showBanner(`${d.text} Reconnecting…`, { buttons: false });
    setConn('connecting');
    setTimeout(() => { if (S.conn === conn && S.screen === 'game') reconnect(); }, 1500);
    return;
  }
  setConn('lost');
  shell?.close();
  showBanner(d.text, { replaced: info.code === CLOSE.REPLACED, reconnect: d.canReconnect !== false, signIn: !!d.signIn });
  addChat(null, d.text, { system: true });
}

function showBanner(text, { buttons = true, replaced = false, reconnect = true, signIn = false } = {}) {
  ui.bannerText.textContent = text;
  ui.reconnect.hidden = !buttons || !reconnect;
  ui.bannerLeave.hidden = !buttons;
  ui.bannerLeave.textContent = signIn ? 'Sign in again' : 'Leave';
  ui.reconnect.textContent = replaced ? 'Play here instead' : 'Reconnect';
  ui.banner.hidden = false;
  if (buttons) (reconnect ? ui.reconnect : ui.bannerLeave).focus();
}

function reconnect() {
  return enter({ reconnecting: true });
}

ui.reconnect.addEventListener('click', () => { S.autoRetried = true; reconnect(); });
ui.bannerLeave.addEventListener('click', () => leave());
ui.leaveBtn.addEventListener('click', () => leave());
ui.switchBtn?.addEventListener('click', () => leave({ switching: true }));

function leave({ switching = false } = {}) {
  S.op++;
  const conn = S.conn;
  S.conn = null;
  S.connected = false;
  conn?.close();
  releaseClaim();
  clearRemotes();
  shell?.close();
  api._reset();
  S.arrival = S.lastJourney = null;
  S.sceneError = null;
  S.firstFrame = api.firstFrame = null;
  api.emit('state', null);
  S.travelReset = false;
  S.predictor = new Predictor();
  ui.banner.hidden = true;
  ui.chatLog.replaceChildren();
  setConn('idle');
  showScreen('landing');
  if (S.account) {
    void fetchRoster().then(() => {
      if (switching) setRosterNote('Choose another character or create a new slot.');
    });
  }
  ui.enter.focus();
}

window.addEventListener('pagehide', () => S.conn?.close());

// ---------------------------------------------------------------- game state

function currentPlace() {
  if (S.lastJourney && S.lastJourney.id === api.location) return S.lastJourney.name;
  const entry = api.location?.startsWith('town:') && api.travelWorld?.()?.catalog.get(api.location);
  if (entry?.name) return entry.name.trim();
  return locationName(api.location, api.character?.wilderness, S.town, api.character?.portal);
}

function updatePlace() {
  const place = currentPlace();
  if (!place) return;
  ui.town.textContent = place;
  const arrival = S.arrival;
  if (!arrival || arrival.location !== api.location || S.doorArrival) return;
  // On cold rejoin the catalogue and mesh can both arrive after the character.
  if (place === 'Iliac Bay' && /^town:\d+\/\d+$/.test(api.location)) return;
  // Older interior saves may have only a room address. The scene supplies its proper name.
  if (/^(interior|dungeon):/.test(api.location) && S.town?.location !== api.location) return;
  S.arrival = null;
  addChat(null, `You arrive in ${place}${arrival.as ? ` as ${arrival.as}` : ''}.`, { system: true });
  if (!arrival.as) emit('game:location', { location: api.location, name: place });
}

function startGame(outcome, reconnecting) {
  ui.town.textContent = currentPlace() || 'Entering the world…';
  S.firstFrame = { pending: true, location: api.location, status: outcome, entities: (api.state?.entities ?? []).length };
  showScreen('game');
  S.firstState = true;
  if (!reconnecting) S.autoRetried = false;
  // Draw synchronously so a rendering failure returns to the loading error screen before paint.
  const t = performance.now() / 1000;
  gameFrame(t, 0);
  lastT = t;
  // The place is on screen: only now may other players see us (server/game.js `arriving`).
  if (S.conn?.arrival && !S.conn.sendArrived()) {
    throw Object.assign(new Error('The connection closed before you could enter the world.'), { kind: 'closed' });
  }
  if (S.claim && !S.claim.owned) {
    addChat(null, `“${S.name}” is active in another tab, so this tab is a separate traveller.`, { system: true });
  }
  ui.canvas.focus?.();
}

function spawnAt(player) {
  S.walkingTo = null;
  S.predictor.reset(player.x, player.z);
  S.yaw = player.yaw;
  S.pitch = 0;
  resetBodyAt(player);
}

function initialFootY(x, z) {
  const portal = api.character?.portal;
  if (portal?.to === api.location && portal.swimming === true && Number.isFinite(portal.footY)) return portal.footY;
  if (portal?.to === api.location && movementMods(api.state).waterWalk
    && canResumeWaterWalk(api.locomotionWorld?.(), x, z, portal)) return portal.footY;
  // On a ship deck (a town without streets) the last teleport names its storey: a cabin door below the main deck.
  const landed = S.town?.spawn?.deck && S.landedAt?.location === api.location ? S.landedAt.y : null;
  const floor = Number.isFinite(landed) ? landed : indoorFloor(S.town, portal);
  return S.ground?.heightAt(x, z, floor) ?? floor ?? 0;
}

function resetBodyAt(player) {
  S.footY = Number.isFinite(player.y) ? player.y : initialFootY(player.x, player.z);
  S.body = newBody(player.x, player.z, S.footY);
  S.body.mode = modeOfStance(player.stance);
  syncSwimBreath(S.body, api.character?.portal, api.location);
  S.locoFootY = S.footY;
  S.bodyMismatch = 0;
  S.crouch = false;
}

function onState(players, location) {
  // The server can send the positions first. Reconcile them after the matching scene change
  // has shifted the predictor and peer buffers into that coordinate system.
  if (location && (location !== api.location || S.greet)) {
    S.pendingPositions = { location, players };
    return;
  }
  if (!location && api.exterior?.pendingCrossing?.()) return; // older server, coordinates are ambiguous
  S.pendingPositions = null;
  const now = performance.now() / 1000;
  const seen = new Set();
  let rosterChanged = false;
  for (const p of players) {
    seen.add(p.id);
    if (p.id === S.selfId) {
      if (S.travelReset) {
        S.travelReset = false;
        S.predictor.reset(p.x, p.z);
        S.yaw = p.yaw;
        resetBodyAt(p);
        S.sender.reset();
      } else {
        S.predictor.reconcile(p.x, p.z, now);
      }
      S.serverBody = Number.isFinite(p.y) ? { y: p.y, stance: p.stance ?? null, at: now } : null;
      continue;
    }
    let r = S.remotes.get(p.id);
    if (!r) {
      r = createRemote(p);
      S.remotes.set(p.id, r);
      rosterChanged = true;
      // Someone coming into view across a gate or map edge has not arrived here.
      if (!S.firstState && !p.across) addChat(null, `${p.name} arrives.`, { system: true });
    } else if (r.name !== p.name) {
      r.name = p.name;
      r.nameEl.textContent = p.name;
      rosterChanged = true;
    }
    r.across = p.across === true;
    r.buf.push(now, p);
  }
  for (const [id, r] of S.remotes) {
    if (!seen.has(id)) {
      removeRemote(id);
      rosterChanged = true;
      if (!r.across) addChat(null, `${r.name} departs.`, { system: true });
    }
  }
  if (S.firstState || rosterChanged) renderRoster();
  S.firstState = false;
}

function createRemote(p) {
  const el = document.createElement('div');
  el.className = 'label';
  el.dataset.id = p.id;
  const nameEl = document.createElement('span');
  nameEl.className = 'label-name';
  nameEl.textContent = p.name;
  const sayEl = document.createElement('span');
  sayEl.className = 'label-say';
  sayEl.hidden = true;
  el.append(sayEl, nameEl);
  ui.labels.append(el);
  return {
    id: p.id, name: p.name, buf: new SnapshotBuffer(), avatar: new Avatar(p.id),
    el, nameEl, sayEl, footY: null, say: null, sayUntil: 0, shownSay: null,
  };
}

function removeRemote(id) {
  const r = S.remotes.get(id);
  if (!r) return;
  r.el.remove();
  S.remotes.delete(id);
}

/** Re-express every remote's buffered positions after our own frame moved by (dx, dz). */
function shiftRemotes(dx, dz) {
  for (const r of S.remotes.values()) {
    for (const s of r.buf.samples) { s.x += dx; s.z += dz; }
    r.footY = null;
  }
}

function clearRemotes() {
  for (const id of [...S.remotes.keys()]) removeRemote(id);
  renderRoster();
}

function renderRoster() {
  const people = [{ id: S.selfId, name: S.selfName, self: true }];
  for (const r of S.remotes.values()) people.push({ id: r.id, name: r.name, self: false });
  people.sort((a, b) => (b.self - a.self) || a.name.localeCompare(b.name));
  ui.count.textContent = String(S.connected || S.screen === 'game' ? people.length : 0);
  ui.rosterList.replaceChildren(...people.map((p) => {
    const li = document.createElement('li');
    li.dataset.id = p.id ?? '';
    if (p.self) li.classList.add('you');
    const span = document.createElement('span');
    span.className = 'roster-name';
    span.textContent = p.name;
    li.append(span);
    if (p.self) {
      const you = document.createElement('small');
      you.textContent = ' (you)';
      li.append(you);
    }
    return li;
  }));
  emit('game:presence', { players: people });
}

// ---------------------------------------------------------------- chat & panels

function addChat(name, text, { system = false, self = false } = {}) {
  const li = document.createElement('li');
  li.className = 'chat-line';
  if (system) li.classList.add('chat-system');
  if (self) li.classList.add('chat-self');
  li.dataset.at = String(Date.now());
  if (name) {
    const n = document.createElement('span');
    n.className = 'chat-name';
    n.textContent = name;
    li.append(n);
  }
  const t = document.createElement('span');
  t.className = 'chat-text';
  t.textContent = text;
  li.append(t);
  ui.chatLog.append(li);
  while (ui.chatLog.children.length > MAX_CHAT_LINES) ui.chatLog.firstElementChild.remove();
  ui.chatLog.scrollTop = ui.chatLog.scrollHeight;
  emit('game:chat', { name, text, system });
}

setInterval(() => {
  const cutoff = Date.now() - 20000;
  for (const li of ui.chatLog.children) li.classList.toggle('chat-old', Number(li.dataset.at) < cutoff);
}, 1000);

function openChat() {
  ui.chatInput.focus();
}
ui.chatInput.addEventListener('focus', () => { document.body.toggleAttribute('data-chat-open', true); input.clear(); });
ui.chatInput.addEventListener('blur', () => document.body.toggleAttribute('data-chat-open', false));
ui.chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = ui.chatInput.value.replace(/\s+/g, ' ').trim();
  if (text) {
    if (!S.conn?.sendChat(text)) addChat(null, 'Not connected — message not sent.', { system: true });
  }
  ui.chatInput.value = '';
  ui.chatInput.blur();
});
ui.chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { ui.chatInput.value = ''; ui.chatInput.blur(); e.preventDefault(); }
});

function togglePanel(panel, btn, force) {
  const show = force ?? panel.hidden;
  panel.hidden = !show;
  btn.setAttribute('aria-expanded', String(show));
}
ui.peopleBtn.addEventListener('click', () => togglePanel(ui.roster, ui.peopleBtn));
ui.helpBtn.addEventListener('click', () => togglePanel(ui.help, ui.helpBtn));

ui.menuBtn.addEventListener('click', () => (shell.isOpen ? shell.close() : api.openPanel('character')));

// ---------------------------------------------------------------- actions (keys, clicks, bar, pad)

/** Dispatch an intent event; a feature that sets detail.handled (or calls preventDefault) consumes it. */
/** Switch the classic activation mode (F1-F4) and say so. */
function setMode(mode) {
  if (api.setActivationMode(mode)) api.message(`${MODE_LABELS[mode]} mode.`);
}

function intent(name, detail) {
  const d = { ...detail, handled: false, preventDefault() { this.handled = true; } };
  api.emit(name, d);
  return d.handled;
}

function needOnline() {
  if (S.connected) return true;
  api.message('Not connected.', { kind: 'error' });
  return false;
}

const actions = {
  ready() {
    if (!needOnline()) return;
    const ready = !readiedOf(api.state);
    if (intent('readyIntent', { ready })) return;
    api.act('combat.ready', { ready });
  },
  attack(source = 'key') {
    if (api.modalOpen || !needOnline()) return;
    const now = performance.now() / 1000;
    if (now - S.lastAttack < ATTACK_GAP) return;
    S.lastAttack = now;
    if (!readiedOf(api.state)) {
      // Classic behaviour: the weapon must be drawn first; the attack key draws it.
      api.act('combat.ready', { ready: true });
      return;
    }
    const targetId = api.target ?? undefined;
    if (intent('attackIntent', { targetId, source })) return;
    api.act('combat.attack', targetId ? { targetId } : {});
  },
  interact() {
    if (!needOnline()) return;
    const entity = api.entity(api.target);
    const mode = api.activationMode ?? 'grab';
    const detail = { targetId: entity ? String(entity.id) : null, entity, mode };
    if (mode === 'info') {
      // Info mode (PlayerActivate Info): name what is targeted; owners may describe it (doors: the building).
      if (intent('infoIntent', detail)) return;
      api.message(entity ? `You see ${entity.name || 'something'}.` : 'You see nothing of interest.');
      return;
    }
    if (mode === 'steal') {
      if (!intent('stealIntent', detail)) api.message(entity ? `You cannot steal from ${entity.name || 'that'}.` : 'There is nothing here to steal.');
      return;
    }
    if (mode === 'talk' && entity?.kind !== 'npc' && entity?.kind !== 'player') {
      api.message(entity ? `${entity.name || 'That'} has nothing to say.` : 'There is no one here to talk to.');
      return;
    }
    if (intent('interactIntent', detail)) return;
    if (!entity) { api.message('There is nothing here to use.'); return; }
    const it = interactionFor(entity);
    if (!it) { api.message(`Nothing to do with ${entity.name || 'that'}.`); return; }
    if (it.verb) api.act(it.verb, it.args);
    else if (it.panel) api.openPanel(it.panel, it.args);
  },
  leave: () => leave(),
  chat: () => openChat(),
  people: () => togglePanel(ui.roster, ui.peopleBtn),
};

input.onPrimaryClick = () => {
  if (settings.clickAttack && readiedOf(api.state)) actions.attack('mouse');
};
input.onLockChange = (locked, { error, unavailable } = {}) => {
  if (locked || !error || S.screen !== 'game') return;
  api.message(unavailable
    ? 'This browser will not capture the mouse here. Drag to look around instead.'
    : 'The mouse could not be captured. Click the view again to look around.', { kind: 'error' });
};

/** Fields that take typed characters. Sliders, checkboxes and radios do not, so menu keys still work on them. */
function isTextEntry(el) {
  const tag = el?.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return true;
  return tag === 'INPUT' && !/^(range|checkbox|radio|button|submit|reset|color|file|image)$/i.test(el.type || 'text');
}

window.addEventListener('keydown', (e) => {
  if (S.screen !== 'game' || e.defaultPrevented || shell?.rebinding || api.journey?.active) return;
  const typing = document.activeElement === ui.chatInput || isTextEntry(document.activeElement);
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'Tab') return; // keyboard focus moves normally
  const onButton = e.target instanceof HTMLButtonElement || e.target?.getAttribute?.('role') === 'tab';
  if (onButton && (e.key === 'Enter' || e.key === ' ')) return;
  const b = settings.bindings;

  if (e.key === 'Escape') {
    // Esc that releases a captured mouse only releases it; it does not also open Settings.
    if (input.locked) { e.preventDefault(); input.release(); return; }
    if (performance.now() - input.unlockedAt < 250) return;
    if (shell.isOpen) { e.preventDefault(); shell.close(); return; }
    if (!ui.roster.hidden || !ui.help.hidden) {
      togglePanel(ui.roster, ui.peopleBtn, false);
      togglePanel(ui.help, ui.helpBtn, false);
      return;
    }
    e.preventDefault();
    api.openPanel('settings');
    return;
  }
  const action = actionForCode(b, e.code);
  // Menu pages (built-in and feature-registered) toggle from their keys, even with a menu open.
  const page = action && api.getPanel(action) ? action
    : api.panels().find((p) => !p.builtin && !(p.id in b) && p.key && p.key === e.code && !actionForCode(b, e.code))?.id; // bound pages follow the bindings only
  if (page) {
    e.preventDefault();
    if (!e.repeat) api.togglePanel(page);
    return;
  }
  if (shell.isOpen) return; // the rest are world actions
  if (e.key === 'Enter' || action === 'chat') { e.preventDefault(); openChat(); return; }
  if (!action) return;
  e.preventDefault();
  if (e.repeat && action !== 'attack') return;
  if (action === 'run' || action === 'slow') return; // held: read by input.traversalHeld()
  if (action === 'jump') { S.jumpSeq += 1; return; }
  if (action === 'crouch') { if (S.body.mode === 'ground') S.crouch = !S.crouch; return; }
  if (action in MODE_ACTIONS) { setMode(MODE_ACTIONS[action]); return; }
  if (action === 'people') actions.people();
  else if (action === 'ready') actions.ready();
  else if (action === 'attack') actions.attack('key');
  else if (action === 'interact') actions.interact();
});

function pollPad(now) {
  const { pressed, axes } = pad.poll(now);
  document.body.toggleAttribute('data-gamepad', pad.connected);
  if (!pressed.size && S.screen !== 'game') return;
  if (S.screen !== 'game') {
    if (pressed.has(PAD.A) && document.activeElement instanceof HTMLButtonElement) document.activeElement.click();
    return;
  }
  if (shell.isOpen) { input.setPadAxes([0, 0, 0, 0]); input.setPadHeld({}); shell.padNav(pressed); return; }
  input.setPadAxes(axes);
  // LB runs, RS (stick click) toggles crouch; while swimming or levitating, A rises and B sinks.
  const vertical = S.body.mode === 'swim' || S.body.mode === 'levitate';
  input.setPadHeld({ run: pad.held(PAD.LB), jump: vertical && pad.held(PAD.A), crouch: vertical && pad.held(PAD.B) });
  if (pressed.has(PAD.RS) && S.body.mode === 'ground') S.crouch = !S.crouch;
  if (pressed.has(PAD.START)) api.openPanel('character');
  else if (pressed.has(PAD.BACK)) api.openPanel('map');
  else if (pressed.has(PAD.A)) actions.interact();
  else if (pressed.has(PAD.Y)) actions.ready();
  if (pressed.has(PAD.X) || pressed.has(PAD.RT)) actions.attack('pad');
}

// ---------------------------------------------------------------- frame loop

const HEADINGS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
let lastT = performance.now() / 1000;

function frame(tms) {
  const now = tms / 1000;
  const dt = Math.min(Math.max(now - lastT, 0), 0.1);
  lastT = now;
  try {
    pollPad(now);
    if (S.arrivalWait) checkArrival();
    if (renderer && S.town) {
      if (S.screen === 'game' && S.predictor.initialized) gameFrame(now, dt);
      else idleFrame(now);
    }
  } catch (err) {
    console.error(err);
  }
  requestAnimationFrame(frame);
}

function idleFrame(now) {
  // Behind the menus: a slow look around the square.
  const y = S.ground?.heightAt(0, 0, null) ?? 0;
  renderer.render({ x: 0, y: y + EYE_HEIGHT + 0.4, z: 0, yaw: now * 0.05, pitch: 0.04 }, []);
  ui.labels.hidden = true;
}

function gameFrame(now, dt) {
  // The server can place us indoors before the room or its people are drawable. Keep the old
  // frame intact through the transfer, including while the authoritative landing is in flight.
  if (S.doorArrival) {
    const arrival = arrivalStatus(api, { scene: S.town, sceneError: S.sceneError, requireRoster: S.conn?.arrival === true });
    if (arrival.failed) {
      failArrival(Object.assign(new Error(arrival.failed.message), { kind: arrival.failed.part }), true);
      return;
    }
    if (!arrival.ready || S.travelReset) {
      ui.labels.hidden = true;
      const detail = arrival.waiting[0] ?? 'Arriving…';
      if (ui.town.textContent !== detail) ui.town.textContent = detail;
      return;
    }
    S.doorArrival = false;
    updatePlace();
  }
  if (S.boundFor !== settings.bindings) {
    input.setTraversalBindings(settings.bindings);
    S.boundFor = settings.bindings;
  }
  const look = api.journey?.active ? { yaw: 0, pitch: 0 } : input.look(dt);
  S.yaw = wrapAngle(S.yaw + look.yaw);
  S.pitch = clamp(S.pitch + look.pitch, -PITCH_LIMIT, PITCH_LIMIT);
  // api.movementLocked: a feature holds the player still (travel journey on screen).
  const law = api.character?.law;
  const inCustody = law?.prison || law?.charge?.stage === 'court' || law?.charge?.stage === 'defence';
  const canMove = S.connected && !api.character?.defeated && !inCustody && !api.movementLocked && api.collisionReady?.() !== false;
  const { forward, strafe } = canMove ? input.axes() : { forward: 0, strafe: 0 };

  const px0 = S.predictor.x, pz0 = S.predictor.z;
  // api.moveSpeed(): the server's ground speed for this player (mount feature: on horseback), else walking.
  let speed;
  try { speed = typeof api.moveSpeed === 'function' ? api.moveSpeed() ?? undefined : undefined; } catch { speed = undefined; }
  const locoWorld = S.connected && api.collisionReady?.() !== false ? api.locomotionWorld?.() ?? null : null;
  let eye = EYE_HEIGHT, grounded = true;
  if (locoWorld) {
    // Shared locomotion rule: the same step the server applies (server/rpg/collision.js stepPlayer).
    const b = S.body;
    if (S.footY !== S.locoFootY || !Number.isFinite(b.y)) { b.y = S.footY; b.mode = 'ground'; b.vy = 0; b.peak = null; b.climbHold = 0; }
    b.x = S.predictor.x; b.z = S.predictor.z;
    const held = canMove ? input.traversalHeld() : { run: false, slow: false, jump: false, crouch: false };
    const vertical = b.mode === 'swim' || b.mode === 'levitate';
    const rise = vertical ? (held.jump ? 1 : 0) - (held.crouch ? 1 : 0) : 0;
    if (b.mode !== 'ground' && S.crouch) S.crouch = false;
    const traversal = { run: held.run, slow: held.slow, crouch: S.crouch, rise, jump: S.jumpSeq };
    let mods;
    try { mods = movementMods(api.state, { baseSpeed: speed }); } catch { mods = movementMods(null, { baseSpeed: speed }); }
    const events = stepBody(locoWorld, b, { forward, strafe, yaw: S.yaw, ...traversal, jumpSeq: S.jumpSeq }, dt, mods);
    if (b.mode !== 'ground') S.crouch = false;
    // Vertical reconciliation: adopt the server's height and mode after a sustained disagreement.
    const sb = S.serverBody;
    if (sb && now - sb.at < 1 && Math.abs(sb.y - b.y) > 0.75) S.bodyMismatch += dt; else S.bodyMismatch = 0;
    if (S.bodyMismatch > 0.4) {
      const was = b.mode, peak = b.peak;
      b.y = sb.y; b.mode = modeOfStance(sb.stance); b.vy = 0; b.peak = b.mode === 'air' ? b.y : null; S.bodyMismatch = 0;
      // The server landed us first: still report the landing (sounds, view) with the predicted drop.
      if (was === 'air' && b.mode === 'ground') events.push({ kind: 'land', fall: Math.max(0, (peak ?? b.y) - b.y), damage: null, reconciled: true });
    }
    S.predictor.advanceTo(b.x, b.z, dt, now);
    S.walked += Math.hypot(b.x - px0, b.z - pz0);
    S.footY = S.locoFootY = b.y;
    eye = EYE_HEIGHT - LOCO.eye + eyeHeight(b);
    grounded = b.mode === 'ground';
    api.movement = movementView(b, locoWorld, mods);
    for (const ev of events) if (ev.kind !== 'exert') api.emit('movement', ev);
    if (S.connected) {
      const msg = S.sender.poll(forward, strafe, S.yaw, now, traversal);
      if (msg) S.conn.sendInput(msg.forward, msg.strafe, msg.yaw, traversal);
    }
  } else {
    S.predictor.update(forward, strafe, S.yaw, dt, now, speed);
    if (typeof api.constrainMove === 'function' && (S.predictor.x !== px0 || S.predictor.z !== pz0)) {
      // Collision feature: keep the predicted position out of walls before the camera uses it.
      try {
        const c = api.constrainMove(px0, pz0, S.predictor.x, S.predictor.z);
        if (c && Number.isFinite(c.x) && Number.isFinite(c.z)) {
          S.predictor.x = c.x; S.predictor.z = c.z;
          const last = S.predictor.history[S.predictor.history.length - 1];
          if (last) { last.x = c.x; last.z = c.z; }
        }
      } catch (err) { console.error('[gameplay] constrainMove failed:', err); }
    }
    S.walked += Math.hypot(S.predictor.x - px0, S.predictor.z - pz0);
    if (S.connected) {
      const msg = S.sender.poll(forward, strafe, S.yaw, now);
      if (msg) S.conn.sendInput(msg.forward, msg.strafe, msg.yaw);
    }
  }

  const x = S.predictor.renderX, z = S.predictor.renderZ;
  if (!locoWorld) {
    const groundY = S.town?.kind === 'dungeon'
      ? api.groundAt?.(x, z, S.footY) : S.ground?.heightAt(x, z, S.footY);
    // Without a local world (still building, seam overlap) the server's height wins while it reports the body
    // off the ground (climbing, falling, swimming, levitating).
    const sb = S.serverBody;
    const airborne = sb && now - sb.at < 1 && modeOfStance(sb.stance) !== 'ground';
    S.footY = airborne ? S.footY + (sb.y - S.footY) * Math.min(1, dt * 12) : settle(S.footY, groundY, dt);
    api.movement = { mode: airborne ? modeOfStance(sb.stance) : 'ground', grounded: true, swimming: false, underwater: false, climbing: false, levitating: false, crouch: false, running: false, slow: false, speed: 0, y: S.footY };
  }
  const moving = forward !== 0 || strafe !== 0;
  const bob = moving && grounded ? Math.sin(S.walked * 4.2) * 0.035 : 0;
  let camera = { x, y: S.footY + eye + bob, z, yaw: S.yaw, pitch: S.pitch };
  // api.viewTransforms: features may move the eye (mount: rider's height; travel journey: the
  // raised view over the traveller). Each gets the camera and returns a replacement or nothing.
  for (const fn of api.viewTransforms ?? []) {
    try { camera = fn(camera, { dt, now, moving: forward !== 0 || strafe !== 0, footY: S.footY }) ?? camera; } catch (err) { console.error('[gameplay] view transform failed:', err); }
  }

  const avatars = [], peers = [];
  const appearances = new Map((api.state?.peers ?? []).map((p) => [String(p.id), p]));
  for (const r of S.remotes.values()) {
    const s = r.buf.sample(now);
    if (!s) continue;
    if (Number.isFinite(s.y) && !r.across) {
      // The server's foot height for this player (jumping, climbing, swimming, stacked floors).
      r.footY = r.footY === null || Math.abs(r.footY - s.y) > 3 ? s.y : r.footY + (s.y - r.footY) * Math.min(1, dt * 20);
    } else {
      const g = S.ground?.heightAt(s.x, s.z, r.footY) ?? layersHeightAt(renderer?.layers, s.x, s.z);
      r.footY = r.footY === null ? (g ?? 0) : settle(r.footY, g, dt);
    }
    r.pos = [s.x, r.footY, s.z];
    r.coverage = peerCoverage(appearances.get(String(r.id))?.concealment, s.moving);
    peers.push({ id: String(r.id), name: r.name, x: s.x, y: r.footY, z: s.z, yaw: s.yaw, moving: s.moving, stance: s.stance ?? null, speed: s.speed ?? 0 });
    // The cube stands in only for a player whose ARENA2 figure cannot be drawn (no files, archive failed).
    if (shouldSkipFallbackAvatar({
      hasActorSprite: !!renderer.hasActorSprite?.(String(r.id)),
      figureDrawable: !!api.actors?.figureDrawable?.(String(r.id)),
      peer: { coverage: r.coverage },
    })) continue;
    avatars.push({ ...r.avatar.pose(s.x, r.footY, s.z, s.yaw, s.moving, dt, now), coverage: r.coverage });
  }
  // Sprite passes sample companions during render, including the first draw in a new room.
  api.peers = peers;
  renderer.render(camera, avatars);
  if (S.firstFrame?.pending) {
    S.firstFrame = {
      ...S.firstFrame, pending: false, at: performance.now(), scene: S.town?.location ?? S.town?.source?.townId ?? null,
      drawn: api.actors?.drawnIds?.() ?? [], collision: api.collisionLocal?.(api.location) ?? null, camera: { ...camera },
    };
    api.firstFrame = S.firstFrame;
    emit('game:first-frame', S.firstFrame);
  }
  api.camera = camera;
  api.renderer = renderer;
  // Frame subscribers run right after the world pass, so the depth buffer still holds the
  // town: features can draw with renderer.gl / renderer.viewProj and real depth testing.
  api.frame = { camera, location: api.location, dt, now, renderer, town: S.town, gl: renderer.gl, viewProj: renderer.viewProj, ground: S.ground, peers };
  api.emit('frame', api.frame);
  if (!api.targetOwnedByFeature && now - S.lastTargetPick > TARGET_EVERY) {
    S.lastTargetPick = now;
    api.setTarget(pickTarget(camera, targetCandidates()), { owner: 'shell' });
  }
  placeLabels(camera, now);

  const deg = ((S.yaw * 180) / Math.PI + 360) % 360;
  const heading = HEADINGS[Math.round(deg / 45) % 8];
  if (ui.heading.textContent !== heading) ui.heading.textContent = heading;
  if (S.lastHeading === null || Math.abs(wrapAngle(S.yaw - S.lastHeading)) > 0.005) {
    S.lastHeading = S.yaw;
    emit('game:heading', { yaw: S.yaw });
  }
}

/** Entities from the latest RPG state plus other players at their interpolated positions. */
function targetCandidates() {
  const list = (api.state?.entities ?? []).filter((e) => Number.isFinite(e?.x) && Number.isFinite(e?.z));
  for (const r of S.remotes.values()) {
    if (r.pos && r.coverage !== 0) list.push({ id: String(r.id), kind: 'player', name: r.name, x: r.pos[0], z: r.pos[2] });
  }
  return list;
}

/** Upload a new scene mesh (travel), keeping the same renderer and resetting ground height. */
function applyScene(mesh) {
  const r = ensureRenderer();
  r.setTown(mesh);
  S.ground = groundFor(mesh);
  S.town = mesh;
  const walking = S.walkingTo;
  S.walkingTo = null;
  if (walking && walking.to === api.location) {
    if (walking.shift.provisional) {
      // A cold destination may have supplied only its horizontal origin.
      const resolved = api.exterior?.stream?.crossing(walking.from, walking.to);
      if (resolved && !resolved.provisional) S.footY += resolved.y - walking.shift.y;
      else S.footY = initialFootY(S.predictor.x, S.predictor.z);
    }
  } else {
    S.footY = initialFootY(S.predictor.x, S.predictor.z);
  }
  if (api.location) updatePlace();
  if (S.arrivalWait) queueMicrotask(checkArrival);
  for (const rem of S.remotes.values()) rem.footY = null;
}

/**
 * Keep drawing the current scene, translated by `offset` into the frame of a location whose
 * own scene is still loading (client/gameplay/wilderness.js). The next applyScene replaces it.
 */
api.rebaseScene = (offset) => {
  if (!renderer || !S.town) return;
  renderer.setPrimaryOffset(offset);
  S.ground = offsetGround(groundFor(S.town), offset);
};

/** Smoothly follow ground height: quick to step up, gravity-like going down. */
function settle(cur, target, dt) {
  if (target === null || target === undefined) return cur;
  if (target > cur) return cur + (target - cur) * Math.min(1, dt * 14);
  return Math.max(target, cur - Math.max(2.5, (cur - target) * 10) * dt);
}

function placeLabels(camera, now) {
  ui.labels.hidden = false;
  for (const r of S.remotes.values()) {
    if (!r.pos || r.coverage < 1) { r.el.hidden = true; continue; }
    const dist = Math.hypot(r.pos[0] - camera.x, r.pos[2] - camera.z);
    const p = dist < LABEL_RANGE ? renderer.project(r.pos[0], r.pos[1] + LABEL_HEIGHT, r.pos[2]) : null;
    if (!p) { r.el.hidden = true; continue; }
    r.el.hidden = false;
    r.el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -100%)`;
    r.el.style.opacity = String(clamp(1.25 - dist / LABEL_RANGE, 0.35, 1));
    r.el.style.zIndex = String(1000 - Math.round(dist));
    const saying = r.say && now < r.sayUntil;
    if (saying && r.shownSay !== r.say) { r.sayEl.textContent = r.say; r.shownSay = r.say; }
    if (r.sayEl.hidden === !!saying) r.sayEl.hidden = !saying;
  }
}

// ---------------------------------------------------------------- boot

shell = createShell({ api, input, actions, settings });
globalThis.dfwGame = api; // for console debugging and end-to-end checks

const initialPlace = parseInitialPlace(location.search);
if (initialPlace) api.setInitialPlace(initialPlace);

ui.name.value = identity.lastName;
showScreen('landing');
setConn('idle');
(ui.name.value ? ui.pick : ui.name).focus();
requestAnimationFrame(frame);
loadAccounts();
loadWhatsNew();
discoverInstalledData().then(restoreSavedData);

// Gameplay features (client/gameplay/features.js manifest). Failures are isolated per feature.
featuresReady = (async () => {
  let mod = null;
  try { mod = await import('./gameplay/features.js'); } catch (err) { console.error('[gameplay] feature manifest failed to load:', err); }
  const results = await installFeatures(api, manifestEntries(mod));
  const failed = results.filter((r) => !r.ok);
  if (failed.length) console.warn('[gameplay] features that failed to install:', failed.map((f) => `${f.name}: ${f.error?.message}`));
  globalThis.dfwFeatures = results.map(({ name, ok, error }) => ({ name, ok, error: error?.message }));
  if (api.files.length) api.emit('assets', api.files);
  api.emit('screen', S.screen);
  return results;
})();
