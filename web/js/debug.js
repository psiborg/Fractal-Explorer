// Developer diagnostics: settings persistence, categorised console logging on
// the JS side, and instrumentation of the JS↔Wasm boundary. The Rust side has
// matching categories in src/debug.rs; both are switched by the same flags.

import { setDebugFlags } from '../libs/fractal/fractal_explorer.js';

/** Bit flags shared with src/debug.rs. */
export const CAT = {
  WGPU: 1 << 0,
  WGSL: 1 << 1,
  FRAME: 1 << 2,
  WASM: 1 << 3,
  WGPU_INTERNAL: 1 << 4,
  APP: 1 << 5, // JS-only: startup timeline, resize, input routing
};

const TAGS = {
  [CAT.WGPU]: ['wgpu', '#ffb347'],
  [CAT.WGSL]: ['wgsl', '#4fd1c5'],
  [CAT.FRAME]: ['frame', '#9aa3ad'],
  [CAT.WASM]: ['wasm', '#b794f4'],
  [CAT.WGPU_INTERNAL]: ['wgpu-log', '#f6ad55'],
  [CAT.APP]: ['app', '#57e389'],
};

const STORAGE_KEY = 'fractal-explorer.settings';

const DEFAULTS = {
  debug: false,
  categories: CAT.WGPU | CAT.WGSL | CAT.WASM | CAT.APP,
  guideOnStart: true,
  guideSeen: false,
  insight: true,
  insightCollapsed: false,
  layout: null,             // panel positions, docks and states (see windows.js)
};

export const settings = loadSettings();

/** Effective flags: none unless the master switch is on. `?debug` forces everything but frames. */
export function flags() {
  if (new URLSearchParams(location.search).has('debug')) {
    return DEFAULTS.categories | CAT.WGPU_INTERNAL;
  }
  return settings.debug ? settings.categories : 0;
}

export function on(cat) {
  return (flags() & cat) !== 0;
}

export function log(cat, message, ...extra) {
  if (!on(cat)) return;
  const [name, colour] = TAGS[cat];
  console.log(`%c[${name}]%c ${message}`, `color:${colour};font-weight:bold`, '', ...extra);
}

export function group(cat, title, body) {
  if (!on(cat)) return;
  const [name, colour] = TAGS[cat];
  console.groupCollapsed(`%c[${name}]%c ${title}`, `color:${colour};font-weight:bold`, '');
  console.log(body);
  console.groupEnd();
}

/** Pushes the current flags into the Rust module (safe to call before or after create). */
export function applyToWasm() {
  try {
    setDebugFlags(flags());
  } catch {
    // Module not initialised yet; main() calls this again after init().
  }
}

export function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private mode or storage blocked: settings just won't persist.
  }
  applyToWasm();
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return { ...DEFAULTS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

// ---------------------------------------------------------------- startup timeline

const marks = [];
let lastMark = performance.now();

/** Records a startup step and how long it took since the previous one. */
export function mark(label) {
  const now = performance.now();
  marks.push([label, now - lastMark]);
  lastMark = now;
}

export function reportStartup() {
  if (!on(CAT.APP)) return;
  const total = marks.reduce((sum, [, ms]) => sum + ms, 0);
  console.groupCollapsed(
    `%c[app]%c Startup took ${total.toFixed(0)} ms`, 'color:#57e389;font-weight:bold', '',
  );
  console.table(Object.fromEntries(marks.map(([label, ms]) => [label, { ms: +ms.toFixed(1) }])));
  console.groupEnd();
}

/** Logs how big the Wasm binary was and how long the browser spent fetching it. */
export function reportWasmModule(wasmExports) {
  if (!on(CAT.WASM)) return;
  const entry = performance.getEntriesByType('resource').find((e) => e.name.endsWith('.wasm'));
  if (entry) {
    const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
    log(
      CAT.WASM,
      `Module ${entry.name.split('/').pop()}: ${kb(entry.decodedBodySize)} ` +
        `(${entry.transferSize ? kb(entry.transferSize) + ' over the wire' : 'from cache'}), ` +
        `fetched in ${entry.duration.toFixed(0)} ms`,
    );
  }
  const memory = wasmExports?.memory;
  if (memory) {
    log(CAT.WASM, `Linear memory: ${fmtBytes(memory.buffer.byteLength)} (grows in 64 KiB pages)`);
    const exported = Object.keys(wasmExports).filter((k) => typeof wasmExports[k] === 'function');
    group(CAT.WASM, `${exported.length} functions exported by the module`, exported.join('\n'));
  }
}

// ---------------------------------------------------------------- JS↔Wasm boundary

/**
 * Wraps the Explorer so every method call, getter and setter crossing into Wasm
 * is counted. Once a second, if anything crossed, a one-line summary is logged.
 * Also watches linear memory and reports when it grows.
 */
export function instrument(explorer, wasmExports) {
  const counts = new Map();
  const bump = (name) => counts.set(name, (counts.get(name) ?? 0) + 1);
  let lastMemory = wasmExports?.memory?.buffer.byteLength ?? 0;

  setInterval(() => {
    if (!on(CAT.WASM)) {
      counts.clear();
      return;
    }
    const mem = wasmExports?.memory?.buffer.byteLength ?? 0;
    if (mem !== lastMemory) {
      log(CAT.WASM, `Linear memory grew: ${fmtBytes(lastMemory)} → ${fmtBytes(mem)}`);
      lastMemory = mem;
    }
    if (counts.size === 0) return;
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    const detail = [...counts].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(', ');
    log(CAT.WASM, `${total} JS→Wasm crossings in the last second: ${detail}`);
    counts.clear();
  }, 1000);

  return new Proxy(explorer, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof prop !== 'string' || prop.startsWith('__')) return value;
      if (typeof value === 'function') {
        return (...args) => {
          bump(`${prop}()`);
          return value.apply(target, args);
        };
      }
      bump(`get ${prop}`);
      return value;
    },
    set(target, prop, value) {
      bump(`set ${String(prop)}`);
      target[prop] = value;
      return true;
    },
  });
}

function fmtBytes(n) {
  return n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MiB` : `${(n / 1024).toFixed(0)} KiB`;
}
