// Localization framework for Daggerfall World: selectable locales, keyed UI & server messages,
// automatic fallback to English, community pack registration, and non-Latin font fallback stacks.
// DOM-free core so it runs under `node --test`.

export const LOCALE_STORAGE_KEY = 'dfw.locale';
export const DEFAULT_LOCALE = 'en';

export const BUILTIN_LOCALES = Object.freeze({
  en: Object.freeze({
    code: 'en',
    name: 'English',
    nativeName: 'English',
    script: 'Latin',
    dir: 'ltr',
    fontStack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    messages: Object.freeze({
      'app.title': 'Daggerfall World',
      'menu.character': 'Character',
      'menu.inventory': 'Inventory',
      'menu.magic': 'Magic',
      'menu.journal': 'Journal',
      'menu.maps': 'Maps',
      'menu.social': 'Social',
      'menu.system': 'System',
      'menu.close': 'Close',
      'menu.settings': 'Settings',
      'menu.help': 'Help',
      'hud.ready': 'Ready',
      'hud.sheathe': 'Sheathe',
      'hud.attack': 'Attack',
      'hud.use': 'Use',
      'hud.talk': 'Talk',
      'hud.loot': 'Loot',
      'hud.revive': 'Revive',
      'hud.party': 'Party',
      'hud.arrows': 'Arrows: {count}',
      'hud.arrowsEmpty': 'No arrows!',
      'hud.questDeadline': '{title}: {remaining}',
      'hud.wagonPrompt': 'Wagon in reach at dungeon exit — Open Wagon',
      'hud.restWarning': 'Rest warning: {reason}',
      'hud.layoutEditOn': 'HUD Layout Edit Mode: drag widgets to move',
      'settings.controls': 'Controls & Look',
      'settings.cameraWeapon': 'Camera & Weapon Preferences',
      'settings.interface': 'Interface & HUD Layout',
      'settings.bindings': 'Keyboard Action Bindings',
      'settings.moveBindings': 'Keyboard Movement & Look Bindings',
      'settings.gamepad': 'Controller & Gamepad Remapping',
      'settings.localization': 'Language & Locale',
      'settings.portable': 'Portable Settings (Export / Import)',
      'settings.account': 'Account',
      'settings.sensitivity': 'Look sensitivity',
      'settings.invertY': 'Invert look up/down',
      'settings.clickAttack': 'Click to attack',
      'settings.mouseSmoothing': 'Mouse smoothing',
      'settings.movementAccel': 'Movement acceleration',
      'settings.headBob': 'Head bob strength',
      'settings.handedness': 'Weapon handedness',
      'settings.handednessRight': 'Right-handed',
      'settings.handednessLeft': 'Left-handed',
      'settings.cameraRecoil': 'Camera recoil',
      'settings.weaponGesture': 'Weapon gesture sensitivity',
      'settings.bowDrawback': 'Classic bow drawback',
      'settings.uiScale': 'Interface size',
      'settings.showTarget': 'Show target name',
      'settings.classicCompass': 'Classic Daggerfall compass',
      'settings.touchOverlay': 'Show phone touch controls',
      'settings.hudEdit': 'Edit HUD layout (drag widgets)',
      'settings.hudReset': 'Reset HUD layout',
      'settings.restoreKeys': 'Restore default keys',
      'settings.restoreMove': 'Restore movement defaults',
      'settings.restorePad': 'Restore controller defaults',
      'settings.exportJson': 'Export JSON',
      'settings.importJson': 'Import JSON',
      'settings.resetAll': 'Reset all settings',
      'settings.localeLabel': 'Display language',
      'settings.localeNote': 'Identifiers stay stable across locales. Missing translations fall back to English.',
      'settings.portableNote': 'Export or import your controls, HUD layout, camera preferences, and locale as JSON.',
      'settings.importOk': 'Settings imported successfully.',
      'settings.importErr': 'Could not import settings: {reason}',
      'settings.exported': 'Settings exported as JSON.',
      'action.offline': 'Not connected — action not sent.',
      'action.cannotRestEnemies': 'Enemies are nearby — resting may be interrupted.',
      'action.cannotRestTown': 'Loitering in town streets risks guard intervention.',
      'quickslots.title': 'Quickslots',
      'quickslots.empty': 'Empty',
      'help.title': 'Help & Active Bindings',
      'help.searchPlaceholder': 'Search commands, controls, tips…',
      'road.following': 'Following road to {dest}',
      'road.junction': 'Junction ahead',
    }),
  }),

  es: Object.freeze({
    code: 'es',
    name: 'Spanish (Español)',
    nativeName: 'Español',
    script: 'Latin',
    dir: 'ltr',
    fontStack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    messages: Object.freeze({
      'app.title': 'Daggerfall World',
      'menu.character': 'Personaje',
      'menu.inventory': 'Inventario',
      'menu.magic': 'Magia',
      'menu.journal': 'Diario',
      'menu.maps': 'Mapas',
      'menu.social': 'Social',
      'menu.system': 'Sistema',
      'menu.close': 'Cerrar',
      'menu.settings': 'Ajustes',
      'menu.help': 'Ayuda',
      'hud.ready': 'Desenvainar',
      'hud.sheathe': 'Envainar',
      'hud.attack': 'Atacar',
      'hud.use': 'Usar',
      'hud.talk': 'Hablar',
      'hud.loot': 'Saquear',
      'hud.revive': 'Revivir',
      'hud.party': 'Grupo',
      'hud.arrows': 'Flechas: {count}',
      'hud.arrowsEmpty': '¡Sin flechas!',
      'hud.wagonPrompt': 'Carro cerca de la salida — Abrir carro',
      'settings.controls': 'Controles y cámara',
      'settings.cameraWeapon': 'Cámara y armas',
      'settings.interface': 'Interfaz y HUD',
      'settings.bindings': 'Teclas de acción',
      'settings.moveBindings': 'Teclas de movimiento y vista',
      'settings.gamepad': 'Mando y botones',
      'settings.localization': 'Idioma y región',
      'settings.portable': 'Ajustes portátiles (JSON)',
      'settings.account': 'Cuenta',
      'settings.localeLabel': 'Idioma de interfaz',
      'settings.exportJson': 'Exportar JSON',
      'settings.importJson': 'Importar JSON',
      'settings.resetAll': 'Restablecer todo',
      'settings.hudEdit': 'Mover elementos del HUD',
      'settings.hudReset': 'Restablecer diseño del HUD',
      'help.title': 'Ayuda y controles activos',
      'help.searchPlaceholder': 'Buscar comandos, teclas o consejos…',
      'action.offline': 'Sin conexión — acción no enviada.',
    }),
  }),

  // Sample non-Latin community locale pack (Japanese / CJK). Intentionally omits several keys to exercise fallback.
  ja: Object.freeze({
    code: 'ja',
    name: 'Japanese (日本語)',
    nativeName: '日本語',
    script: 'CJK',
    dir: 'ltr',
    fontStack: '"Noto Sans CJK JP", "Hiragino Sans", "Yu Gothic UI", "Meiryo", system-ui, sans-serif',
    messages: Object.freeze({
      'app.title': 'ダガーフォール・ワールド',
      'menu.character': 'キャラクター',
      'menu.inventory': '持ち物',
      'menu.magic': '魔法',
      'menu.journal': '日誌',
      'menu.maps': '地図',
      'menu.social': '交流',
      'menu.system': 'システム',
      'menu.close': '閉じる',
      'menu.settings': '設定',
      'menu.help': 'ヘルプ',
      'hud.ready': '構える',
      'hud.sheathe': '納刀',
      'hud.attack': '攻撃',
      'hud.use': '調べる',
      'hud.talk': '話す',
      'hud.loot': '漁る',
      'hud.revive': '蘇生',
      'hud.party': 'パーティ',
      'hud.arrows': '矢: {count}',
      'hud.arrowsEmpty': '矢がありません！',
      'hud.wagonPrompt': '出口付近に荷車があります — 荷車を開く',
      'settings.controls': '操作と視点',
      'settings.cameraWeapon': 'カメラと武器の設定',
      'settings.interface': '画面とHUD配置',
      'settings.bindings': 'アクションキー設定',
      'settings.moveBindings': '移動・視点キー設定',
      'settings.gamepad': 'コントローラー設定',
      'settings.localization': '言語とロケール',
      'settings.portable': '設定の書き出し・読み込み (JSON)',
      'settings.account': 'アカウント',
      'settings.localeLabel': '表示言語',
      'settings.exportJson': 'JSON書き出し',
      'settings.importJson': 'JSON読み込み',
      'settings.resetAll': 'すべて初期化',
      'settings.hudEdit': 'HUD配置を編集',
      'settings.hudReset': 'HUD配置をリセット',
      'help.title': 'ヘルプと現在のキー設定',
      'help.searchPlaceholder': '操作・コマンド・ヒントを検索…',
      'action.offline': '未接続のため送信できませんでした。',
    }),
  }),

  // Sample Cyrillic non-Latin community locale pack (Russian).
  ru: Object.freeze({
    code: 'ru',
    name: 'Russian (Русский)',
    nativeName: 'Русский',
    script: 'Cyrillic',
    dir: 'ltr',
    fontStack: '"Noto Sans", "DejaVu Sans", "Segoe UI", system-ui, sans-serif',
    messages: Object.freeze({
      'app.title': 'Daggerfall World',
      'menu.character': 'Персонаж',
      'menu.inventory': 'Инвентарь',
      'menu.magic': 'Магия',
      'menu.journal': 'Журнал',
      'menu.maps': 'Карты',
      'menu.social': 'Общение',
      'menu.system': 'Система',
      'menu.close': 'Закрыть',
      'menu.settings': 'Настройки',
      'menu.help': 'Справка',
      'hud.ready': 'Оружие',
      'hud.sheathe': 'Убрать',
      'hud.attack': 'Атака',
      'hud.use': 'Действие',
      'hud.talk': 'Говорить',
      'hud.loot': 'Обыскать',
      'hud.arrows': 'Стрелы: {count}',
      'settings.controls': 'Управление и обзор',
      'settings.localization': 'Язык и локаль',
      'settings.portable': 'Переносимые настройки (JSON)',
      'settings.localeLabel': 'Язык интерфейса',
      'help.title': 'Справка и клавиши',
    }),
  }),
});

/** Common server message patterns keyed for localization. */
const SERVER_MESSAGE_PATTERNS = [
  { re: /^Not connected\.?$/i, key: 'action.offline' },
  { re: /^Not connected — action not sent\.?$/i, key: 'action.offline' },
];

const registry = new Map(Object.entries(BUILTIN_LOCALES).map(([k, v]) => [k, { ...v, messages: { ...v.messages } }]));
let currentLocale = DEFAULT_LOCALE;
const listeners = new Set();

export function normalizeLocaleCode(code) {
  if (typeof code !== 'string') return DEFAULT_LOCALE;
  const clean = code.trim().toLowerCase().replace(/_/g, '-');
  if (registry.has(clean)) return clean;
  const base = clean.split('-')[0];
  if (registry.has(base)) return base;
  return DEFAULT_LOCALE;
}

/**
 * Register or extend a community translation pack at runtime.
 * @param {string} code  BCP-47 tag (e.g. 'de', 'ko', 'pl')
 * @param {{ name?: string, nativeName?: string, script?: string, dir?: 'ltr'|'rtl', fontStack?: string, messages: Record<string,string> }} pack
 */
export function registerLocalePack(code, pack) {
  if (typeof code !== 'string' || !/^[a-z]{2,8}(?:-[a-z0-9]{2,8})*$/i.test(code.trim())) {
    throw new Error('Invalid locale code');
  }
  if (!pack || typeof pack !== 'object' || !pack.messages || typeof pack.messages !== 'object') {
    throw new Error('Locale pack requires a messages dictionary');
  }
  const key = code.trim().toLowerCase();
  const prev = registry.get(key);
  const merged = {
    code: key,
    name: String(pack.name || prev?.name || key),
    nativeName: String(pack.nativeName || pack.name || prev?.nativeName || key),
    script: String(pack.script || prev?.script || 'Latin'),
    dir: pack.dir === 'rtl' ? 'rtl' : (prev?.dir || 'ltr'),
    fontStack: String(pack.fontStack || prev?.fontStack || BUILTIN_LOCALES.en.fontStack),
    messages: { ...(prev?.messages || {}), ...Object.fromEntries(Object.entries(pack.messages).filter(([, v]) => typeof v === 'string')) },
  };
  registry.set(key, merged);
  return merged;
}

export function listLocales() {
  return [...registry.values()].map(({ code, name, nativeName, script, dir }) => ({ code, name, nativeName, script, dir }));
}

export function getLocale() {
  return currentLocale;
}

export function getLocaleMeta(code = currentLocale) {
  return registry.get(normalizeLocaleCode(code)) ?? registry.get(DEFAULT_LOCALE);
}

export function setLocale(code, { storage = globalThis.localStorage, persist = true } = {}) {
  const next = normalizeLocaleCode(code);
  currentLocale = next;
  if (persist) saveLocale(next, storage);
  for (const fn of [...listeners]) {
    try { fn(next, getLocaleMeta(next)); } catch { /* listener error isolated */ }
  }
  return next;
}

export function onLocaleChange(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function loadSavedLocale(storage = globalThis.localStorage) {
  try {
    const saved = storage?.getItem(LOCALE_STORAGE_KEY);
    if (saved) return normalizeLocaleCode(saved);
  } catch { /* storage disabled */ }
  return DEFAULT_LOCALE;
}

export function saveLocale(code, storage = globalThis.localStorage) {
  const next = normalizeLocaleCode(code);
  try { storage?.setItem(LOCALE_STORAGE_KEY, next); } catch { /* storage disabled */ }
  return next;
}

function interpolate(template, vars) {
  if (!vars || typeof vars !== 'object') return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, k) => (k in vars && vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : `{${k}}`));
}

/**
 * Look up a localized UI message by key with automatic fallback to English, then fallback text, then key.
 */
export function t(key, vars = null, { locale = currentLocale, fallback = null } = {}) {
  const code = normalizeLocaleCode(locale);
  const pack = registry.get(code);
  const en = registry.get(DEFAULT_LOCALE);
  const raw = pack?.messages?.[key] ?? en?.messages?.[key] ?? fallback ?? key;
  return interpolate(String(raw), vars);
}

/** Translate known keyed or patterned server feedback while keeping unknown text intact. */
export function translateServerMessage(text, { locale = currentLocale } = {}) {
  if (typeof text !== 'string' || !text) return '';
  for (const { re, key } of SERVER_MESSAGE_PATTERNS) {
    if (re.test(text)) return t(key, null, { locale, fallback: text });
  }
  return text;
}

/** Apply active locale language, text direction, and non-Latin font fallback stack to document. */
export function applyLocaleToDocument(doc = globalThis.document, code = currentLocale) {
  if (!doc?.documentElement) return null;
  const meta = getLocaleMeta(code);
  doc.documentElement.lang = meta.code;
  doc.documentElement.dir = meta.dir;
  doc.documentElement.dataset.locale = meta.code;
  doc.documentElement.dataset.script = meta.script;
  doc.documentElement.style.setProperty('--font-locale-fallback', meta.fontStack);
  if (meta.script !== 'Latin') {
    doc.documentElement.style.setProperty('--font-ui', meta.fontStack);
  } else {
    doc.documentElement.style.removeProperty('--font-ui');
  }
  return meta;
}
