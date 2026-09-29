// Fractal Explorer front end: owns the canvas, input, HUD, menu, settings and guide.
// All fractal state and GPU work live in the Rust/wgpu module.

import init, { Explorer } from '../libs/fractal/fractal_explorer.js';
import * as debug from './debug.js';
import { CAT } from './debug.js';
import { createGuide } from './guide.js';
import { createPlaces } from './places.js';
import { createInsight } from './insight.js';
import { createWindowManager } from './windows.js';
import { createAbout } from './about.js';

const $ = (id) => document.getElementById(id);
const canvas = $('view');
const ui = {
  panel: $('panel'), led: $('led'), gpu: $('gpu'), mode: $('mode'),
  center: $('center'), zoom: $('zoom'), frame: $('frame'), precision: $('precision'),
  iter: $('iter'), iterOut: $('iter-out'), palette: $('palette'),
  formula: $('formula'), power: $('power'), powerOut: $('power-out'), powerRow: $('power-row'),
  precisionMode: $('precision-mode'), precisionNote: $('precision-note'), gpuTime: $('gpu-time'),
  menuBtn: $('menu-btn'), menu: $('menu'), settings: $('settings'),
};

const PALETTES = 4;
const FORMULAS = ['Mandelbrot', 'Burning Ship', 'Tricorn', 'Multibrot'];
const PRECISIONS = ['Fast (f32)', 'Deep (double-float)', 'Perturbation'];
let explorer;
let guide;
let places;
let insight;
let wm;
let panels;
let about;
let gpuInfo = {};
let lastPointer = { x: 0, y: 0 };   // device pixels, for keyboard Julia pick
let lastFrameAt = 0;
let hudDirty = true;
let flight = null;                  // active fly-to animation, cancelled by user input
let morph = null;                   // active Multibrot power animation
let lastGpuMs = null;

main().catch(fail);

async function main() {
  debug.mark('page script start');
  if (!('gpu' in navigator)) {
    throw new Error('This browser does not expose WebGPU. Try a current Chrome, Edge, Safari or Firefox.');
  }
  await preflight();
  debug.mark('WebGPU preflight (JS)');

  let wasm;
  try {
    wasm = await init();
  } catch (err) {
    throw stageError('Wasm module failed to load', err);
  }
  debug.mark('fetch + compile + instantiate Wasm');
  debug.applyToWasm();
  debug.reportWasmModule(wasm);

  sizeCanvas(canvas.clientWidth * devicePixelRatio, canvas.clientHeight * devicePixelRatio);
  let raw;
  try {
    raw = await Explorer.create(canvas);
  } catch (err) {
    throw stageError('Renderer failed to start', err);
  }
  debug.mark('Explorer.create (wgpu adapter, device, pipeline)');
  explorer = debug.instrument(raw, wasm);

  ui.gpu.textContent = explorer.adapterName || 'WebGPU';
  ui.gpu.title = 'Browsers often hide the exact GPU name for privacy.';
  if (!explorer.hasGpuTimer) {
    ui.gpuTime.textContent = 'n/a';
    ui.gpuTime.title = 'This browser/GPU does not offer WebGPU timestamp queries.';
  }
  debug.log(CAT.WGSL, `Double-float self-test (from JS): ${explorer.deepVerified ? 'passed' : 'FAILED'}: ${explorer.selfTestSummary}`);

  observeResize();
  bindPointer();
  bindWheel();
  bindKeys();
  bindPanel();
  bindMenu();
  bindSettings();

  // Panels: each is a window that can float, dock to an edge, minimize or close.
  wm = createWindowManager({
    load: () => debug.settings.layout,
    save: (layout) => { debug.settings.layout = layout; debug.saveSettings(); },
  });
  const controlsWin = wm.register('controls', {
    el: ui.panel, width: 300, dock: 'left', order: 0, open: true, sheet: 'top',
  });
  const guideWin = wm.register('guide', {
    el: $('guide'), width: 360, dock: 'right', order: 0, open: false,
    onClose: () => {
      debug.settings.guideSeen = true;
      debug.saveSettings();
    },
  });
  const placesWin = wm.register('places', {
    el: $('places'), width: 360, dock: 'right', order: 1, open: false,
    onOpen: () => places?.refresh(),
  });
  const insightWin = wm.register('insight', {
    // Earlier versions stored this panel's visibility separately; respect it once.
    el: $('insight'), width: 560, dock: 'bottom', order: 0, open: debug.settings.insight !== false, sheet: 'passive',
    onOpen: () => { $('set-insight').checked = true; insight?.update(); },
    onClose: () => { $('set-insight').checked = false; },
    onMinimize: () => insight?.update(),
  });
  panels = { controls: controlsWin };

  guide = createGuide({
    explorer,
    flyTo,
    setIterations,
    setPalette,
    setFormula,
    setPower,
    setPrecision,
    morphPower,
    cyclePalette: () => setPalette((explorer.palette + 1) % PALETTES),
    openSettings,
    changed,
    win: guideWin,
  });
  insight = createInsight({
    explorer,
    canvasPixels: () => canvas.width * canvas.height,
    win: insightWin,
  });
  places = createPlaces({
    capture: captureView,
    thumbnail,
    goTo,
    win: placesWin,
  });
  wm.layout();
  about = createAbout({ explorer, canvas, gpuInfo });
  $('set-insight').checked = insightWin.isOpen();
  if (debug.settings.guideOnStart && !debug.settings.guideSeen) guide.open();

  requestAnimationFrame(tick);
  debug.mark('UI wired, first frame scheduled');
  debug.reportStartup();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

// ---------------------------------------------------------------- diagnostics

/** Probes WebGPU from JS first, so failures name the step that went wrong. */
async function preflight() {
  let adapter;
  try {
    adapter = await navigator.gpu.requestAdapter();
  } catch (err) {
    throw new Error(`navigator.gpu.requestAdapter() threw: ${err.message ?? err}`);
  }
  if (!adapter) {
    throw new Error(
      'The browser supports WebGPU but returned no GPU adapter. Usually this means hardware ' +
      'acceleration is off, or the GPU or driver is blocklisted. Open chrome://gpu (or edge://gpu) ' +
      'and check the "WebGPU" line, and make sure "Use graphics acceleration when available" is on.',
    );
  }
  const info = adapter.info ?? {};
  gpuInfo = info;
  debug.log(CAT.APP, 'WebGPU adapter as seen from JS:', {
    vendor: info.vendor, architecture: info.architecture,
    device: info.device, description: info.description,
    fallback: info.isFallbackAdapter ?? adapter.isFallbackAdapter,
  });
  try {
    const device = await adapter.requestDevice();
    device.destroy();
  } catch (err) {
    throw stageError('GPU device request failed', err);
  }
}

// ---------------------------------------------------------------- frame loop

function tick(now) {
  if (flight) stepFlight(now);
  if (morph) stepMorph(now);

  const logFrame = debug.on(CAT.FRAME);
  const t0 = logFrame ? performance.now() : 0;
  const drew = explorer.render();
  if (drew) {
    if (logFrame) {
      debug.log(CAT.FRAME, `render() returned after ${(performance.now() - t0).toFixed(2)} ms of CPU time; the GPU finishes asynchronously`);
    }
    // Only meaningful while frames are back-to-back (dragging, zooming).
    if (now - lastFrameAt < 250) {
      const ms = now - lastFrameAt;
      ui.frame.textContent = `${ms.toFixed(1)} ms · ${Math.round(1000 / ms)} fps`;
    }
    lastFrameAt = now;
    ui.led.classList.add('on');
  } else if (now - lastFrameAt > 120) {
    ui.led.classList.remove('on');
  }
  pollGpuTime();
  if (hudDirty) updateHud();
  requestAnimationFrame(tick);
}

/** Shows the GPU's own time for the last measured frame (vsync doesn't hide this one). */
function pollGpuTime() {
  const ms = explorer.pollGpuTime();
  if (ms < 0 || ms === lastGpuMs) return;
  lastGpuMs = ms;
  // Chrome rounds timestamps to 0.1 ms unless its WebGPU developer features are enabled.
  ui.gpuTime.textContent = ms < 0.1 ? '< 0.1 ms' : `${ms.toFixed(ms < 10 ? 2 : 1)} ms`;
  debug.log(CAT.FRAME, `GPU time ${ms.toFixed(3)} ms (${PRECISIONS[explorer.effectivePrecision]})`);
}

function changed() {
  hudDirty = true;
}

function updateHud() {
  hudDirty = false;
  const julia = explorer.isJulia;
  const f = explorer.formula;
  const name = f === 3 ? `Multibrot p=${explorer.power.toFixed(2)}` : FORMULAS[f];
  ui.mode.textContent = julia
    ? `${name} Julia, c = ${fmtComplex(explorer.juliaRe, explorer.juliaIm, 4)}`
    : name;
  ui.center.textContent = fmtCenter();
  ui.zoom.textContent = fmtZoom(explorer.zoom);
  ui.precision.hidden = !explorer.atPrecisionLimit;
  ui.precision.textContent = [
    'f32 precision limit reached: the image will pixelate. Press D (or pick Deep or Perturb) for more precision.',
    'Double-float limit reached (~10¹⁰×+): the image will pixelate again. Pick Perturb to go deeper.',
    'Perturbation limit reached (~10²⁸×): past this the 106-bit centre and the f32 exponent run out.',
  ][explorer.effectivePrecision];
  updatePrecisionNote();
  insight?.update();
}

// ---------------------------------------------------------------- saved places

/** Everything needed to come back to exactly this view. */
function captureView() {
  return {
    formula: explorer.formula,
    power: explorer.power,
    julia: explorer.isJulia,
    jre: explorer.juliaRe,
    jim: explorer.juliaIm,
    re: explorer.centerRe,
    reLo: explorer.centerReLo,
    im: explorer.centerIm,
    imLo: explorer.centerImLo,
    zoom: explorer.zoom,
    iter: explorer.maxIterations,
    palette: explorer.palette,
    precision: explorer.precision,
  };
}

/**
 * Small JPEG of the current view. A WebGPU canvas can only be copied while its
 * current frame hasn't been handed to the compositor yet, so this draws a fresh
 * frame and copies it within the same task.
 */
function thumbnail() {
  try {
    explorer.invalidate();
    explorer.render();
    const w = 192, h = 120;
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const scale = Math.max(w / canvas.width, h / canvas.height);
    const sw = w / scale, sh = h / scale;
    out.getContext('2d').drawImage(canvas, (canvas.width - sw) / 2, (canvas.height - sh) / 2, sw, sh, 0, 0, w, h);
    return out.toDataURL('image/jpeg', 0.82);
  } catch (err) {
    debug.log(CAT.APP, 'Could not capture a thumbnail:', err);
    return null;
  }
}

/** Restores a saved view: settings first, then flies to the saved centre and zoom. */
async function goTo(s) {
  cancelFlight();
  if (explorer.formula !== s.formula) setFormula(s.formula);
  if (s.formula === 3) setPower(s.power);
  setPrecision(s.precision);
  setIterations(s.iter);
  setPalette(s.palette);
  if (s.julia) {
    if (!explorer.isJulia || explorer.juliaRe !== s.jre || explorer.juliaIm !== s.jim) {
      explorer.showJulia(s.jre, s.jim);
    }
  } else if (explorer.isJulia) {
    explorer.showMandelbrot();
  }
  changed();
  // Longer flights for bigger zoom changes, so deep dives stay watchable.
  const decades = Math.abs(Math.log10(s.zoom / explorer.zoom));
  await flyTo({ re: s.re, reLo: s.reLo ?? 0, im: s.im, imLo: s.imLo ?? 0, zoom: s.zoom },
    Math.min(5000, 900 + decades * 350));
}

// ---------------------------------------------------------------- fly-to animation

/**
 * Animates to a centre and zoom. Zoom is interpolated logarithmically and the
 * centre follows the zoom, so the destination stays steady on screen as it grows.
 */
function flyTo({ re, reLo = 0, im, imLo = 0, zoom }, ms = 1800) {
  cancelFlight();
  const from = {
    re: explorer.centerRe, reLo: explorer.centerReLo, im: explorer.centerIm, imLo: explorer.centerImLo,
    zoom: explorer.zoom,
  };
  // Distance to travel, kept as f64 (it's large when there's far to go, and the
  // shrinking remainder near the end is what needs precision).
  const dist = { re: (re - from.re) + (reLo - from.reLo), im: (im - from.im) + (imLo - from.imLo) };
  debug.log(CAT.APP, `Flying to ${fmtComplex(re, im, 6)} at ${fmtZoom(zoom)}`);
  return new Promise((resolve) => {
    flight = { from, to: { re, reLo, im, imLo, zoom }, dist, start: performance.now(), ms, resolve };
  });
}

function stepFlight(now) {
  const { from, to, start, ms } = flight;
  const t = Math.min(1, (now - start) / ms);
  const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2; // easeInOutCubic
  const zoom = Math.exp(Math.log(from.zoom) + (Math.log(to.zoom) - Math.log(from.zoom)) * e);
  // Move the centre in proportion to how much of the scale change is done.
  const inv0 = 1 / from.zoom, inv1 = 1 / to.zoom;
  const s = Math.abs(inv1 - inv0) > 1e-12 ? (inv0 - 1 / zoom) / (inv0 - inv1) : e;
  // Written as "target minus what's left", so the target's extra digits (lo) arrive
  // exactly at the end: vital when landing at 10²⁰× and beyond.
  const left = 1 - s;
  explorer.setView(to.re, to.reLo - flight.dist.re * left, to.im, to.imLo - flight.dist.im * left, zoom);
  changed();
  if (t >= 1) {
    const done = flight.resolve;
    flight = null;
    done();
  }
}

/** Sweeps the Multibrot power so you can watch lobes appear. */
function morphPower(from, to, ms = 4000) {
  cancelFlight();
  setPower(from);
  return new Promise((resolve) => {
    morph = { from, to, start: performance.now(), ms, resolve };
  });
}

function stepMorph(now) {
  const t = Math.min(1, (now - morph.start) / morph.ms);
  const e = 0.5 - Math.cos(Math.PI * t) / 2;
  setPower(morph.from + (morph.to - morph.from) * e);
  if (t >= 1) {
    const done = morph.resolve;
    morph = null;
    done();
  }
}

function cancelFlight() {
  if (morph) {
    const done = morph.resolve;
    morph = null;
    done();
  }
  if (!flight) return;
  const done = flight.resolve;
  flight = null;
  done();
}

// ---------------------------------------------------------------- sizing

function sizeCanvas(w, h) {
  const max = explorer ? explorer.maxDimension : 8192;
  canvas.width = Math.max(1, Math.min(max, Math.round(w)));
  canvas.height = Math.max(1, Math.min(max, Math.round(h)));
}

function observeResize() {
  const ro = new ResizeObserver(([entry]) => {
    // Prefer exact device-pixel sizes to keep the image 1:1 with the screen.
    const dp = entry.devicePixelContentBoxSize?.[0];
    const w = dp ? dp.inlineSize : entry.contentRect.width * devicePixelRatio;
    const h = dp ? dp.blockSize : entry.contentRect.height * devicePixelRatio;
    sizeCanvas(w, h);
    debug.log(CAT.APP, `Canvas resized to ${canvas.width}×${canvas.height} device px (devicePixelRatio ${devicePixelRatio})`);
    explorer.resize(canvas.width, canvas.height);
    changed();
  });
  try {
    ro.observe(canvas, { box: 'device-pixel-content-box' });
  } catch {
    ro.observe(canvas);
  }
}

/** Client (CSS px) coordinates → canvas device pixels. */
function toDevice(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (clientX - r.left) * (canvas.width / r.width),
    y: (clientY - r.top) * (canvas.height / r.height),
  };
}

// ---------------------------------------------------------------- input

function bindPointer() {
  const pointers = new Map();
  let pinch = null; // { dist, mid }

  const midpoint = () => {
    const [a, b] = [...pointers.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, dist: Math.hypot(a.x - b.x, a.y - b.y) };
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    cancelFlight();
    closeMenu();
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, toDevice(e.clientX, e.clientY));
    canvas.classList.add('dragging');
    if (pointers.size === 2) pinch = midpoint();
  });

  canvas.addEventListener('pointermove', (e) => {
    const p = toDevice(e.clientX, e.clientY);
    lastPointer = p;
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    pointers.set(e.pointerId, p);

    if (pointers.size === 1) {
      explorer.pan(p.x - prev.x, p.y - prev.y);
      changed();
    } else if (pointers.size === 2 && pinch) {
      const now = midpoint();
      explorer.pan(now.x - pinch.x, now.y - pinch.y);
      if (pinch.dist > 0) explorer.zoomAt(now.x, now.y, now.dist / pinch.dist);
      pinch = now;
      changed();
    }
  });

  const release = (e) => {
    pointers.delete(e.pointerId);
    pinch = pointers.size === 2 ? midpoint() : null;
    if (pointers.size === 0) canvas.classList.remove('dragging');
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);

  canvas.addEventListener('dblclick', (e) => {
    cancelFlight();
    const p = toDevice(e.clientX, e.clientY);
    explorer.zoomAt(p.x, p.y, e.shiftKey ? 0.25 : 4);
    changed();
  });

  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    cancelFlight();
    const p = toDevice(e.clientX, e.clientY);
    if (!explorer.isJulia) {
      explorer.juliaAt(p.x, p.y);
      changed();
    }
  });
}

function bindWheel() {
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    cancelFlight();
    const lines = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const delta = e.deltaY * lines;
    // Trackpad pinch arrives as ctrl+wheel with small deltas; make it snappier.
    const k = e.ctrlKey ? 0.01 : 0.0015;
    const p = toDevice(e.clientX, e.clientY);
    explorer.zoomAt(p.x, p.y, Math.exp(-delta * k));
    changed();
  }, { passive: false });
}

function bindKeys() {
  window.addEventListener('keydown', (e) => {
    if (document.querySelector('dialog[open]')) return; // dialogs handle their own keys (Esc closes them)
    if (e.key === 'Escape') {
      if (!ui.menu.hidden) closeMenu();
      else if (places.isOpen()) places.close();
      else if (guide.isOpen()) guide.close();
      return;
    }
    if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key.toLowerCase()) {
      case 'r': explorer.reset(); break;
      case 'm': explorer.showMandelbrot(); break;
      case 'j': if (!explorer.isJulia) explorer.juliaAt(lastPointer.x, lastPointer.y); break;
      case 'p': setPalette((explorer.palette + 1) % PALETTES); break;
      case 'f': setFormula((explorer.formula + 1) % FORMULAS.length); break;
      case 'd': setPrecision((explorer.precision + 1) % PRECISIONS.length); break;
      case '[': setIterations(explorer.maxIterations / 1.25); break;
      case ']': setIterations(explorer.maxIterations * 1.25); break;
      case 'h': panels.controls.toggle(); break;
      case 'g': guide.toggle(); break;
      case 's': places.save(); break;
      case 'b': places.toggle(); break;
      case 'i': insight.toggle(); break;
      case '+': case '=': zoomCentre(1.5); break;
      case '-': zoomCentre(1 / 1.5); break;
      default: return;
    }
    cancelFlight();
    e.preventDefault();
    changed();
  });
}

function bindPanel() {
  ui.iter.addEventListener('input', () => setIterations(+ui.iter.value));
  ui.palette.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-p]');
    if (btn) setPalette(+btn.dataset.p);
  });
  ui.formula.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-f]');
    if (btn) { cancelFlight(); setFormula(+btn.dataset.f); }
  });
  ui.precisionMode.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-d]');
    if (btn) setPrecision(+btn.dataset.d);
  });
  ui.power.addEventListener('input', () => { cancelFlight(); setPower(+ui.power.value); });
  $('reset').addEventListener('click', () => { cancelFlight(); explorer.reset(); changed(); });
  $('mandel').addEventListener('click', () => { cancelFlight(); explorer.showMandelbrot(); changed(); });
  $('save-place').addEventListener('click', () => places.save());
}

// ---------------------------------------------------------------- menu & settings

function bindMenu() {
  ui.menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (ui.menu.hidden) openMenu();
    else closeMenu();
  });
  ui.menu.addEventListener('click', (e) => {
    const item = e.target.closest('[data-action]');
    if (!item) return;
    closeMenu();
    switch (item.dataset.action) {
      case 'controls': panels.controls.open(); break;
      case 'guide': guide.open(); break;
      case 'places': places.open(); break;
      case 'insight': insight.show(); break;
      case 'reset-layout': wm.reset(); break;
      case 'settings': openSettings(); break;
      case 'dump': dumpState(); break;
      case 'about': about.open(); break;
    }
  });
  document.addEventListener('click', (e) => {
    if (!ui.menu.hidden && !ui.menu.contains(e.target)) closeMenu();
  });
}

function openMenu() {
  ui.menu.hidden = false;
  ui.menuBtn.setAttribute('aria-expanded', 'true');
  ui.menu.querySelector('button')?.focus();
}

function closeMenu() {
  if (ui.menu.hidden) return;
  ui.menu.hidden = true;
  ui.menuBtn.setAttribute('aria-expanded', 'false');
}

function bindSettings() {
  const master = $('set-debug');
  const guideStart = $('set-guide-start');
  const cats = [...document.querySelectorAll('#set-cats input[data-cat]')];

  const render = () => {
    const s = debug.settings;
    master.checked = s.debug;
    guideStart.checked = s.guideOnStart;
    for (const box of cats) {
      box.checked = (s.categories & +box.dataset.cat) !== 0;
      box.disabled = !s.debug;
    }
    $('set-cats').classList.toggle('disabled', !s.debug);
  };

  master.addEventListener('change', () => {
    debug.settings.debug = master.checked;
    debug.saveSettings();
    render();
    if (master.checked) {
      console.info(
        '%c[fractal]%c Debug logging on. Startup details appear after a reload; use "Dump GPU state now" to see them immediately.',
        'color:#57e389;font-weight:bold', '',
      );
    }
  });
  $('set-insight').addEventListener('change', (e) => (e.target.checked ? insight.show() : insight.hide()));
  guideStart.addEventListener('change', () => {
    debug.settings.guideOnStart = guideStart.checked;
    if (guideStart.checked) debug.settings.guideSeen = false;
    debug.saveSettings();
  });
  for (const box of cats) {
    box.addEventListener('change', () => {
      const bit = +box.dataset.cat;
      debug.settings.categories = box.checked
        ? debug.settings.categories | bit
        : debug.settings.categories & ~bit;
      debug.saveSettings();
    });
  }
  $('set-dump').addEventListener('click', dumpState);
  $('set-reload').addEventListener('click', () => location.reload());
  $('set-reset-layout').addEventListener('click', () => wm.reset());
  ui.settings.addEventListener('close', () => canvas.focus?.());

  render();
}

function openSettings() {
  ui.settings.showModal();
}

function dumpState() {
  console.info('%c[fractal]%c GPU state dump', 'color:#57e389;font-weight:bold', '');
  explorer.dumpState();
}

// ---------------------------------------------------------------- shared setters

function setIterations(n) {
  explorer.maxIterations = Math.round(n);
  const actual = explorer.maxIterations;
  ui.iter.value = String(Math.min(actual, +ui.iter.max));
  ui.iterOut.textContent = String(actual);
  changed();
}

function setPalette(i) {
  explorer.palette = i;
  for (const btn of ui.palette.querySelectorAll('button')) {
    btn.setAttribute('aria-pressed', String(+btn.dataset.p === i));
  }
  changed();
}

/** Switches formula; the Rust side returns to that set's home view. */
function setFormula(i) {
  explorer.formula = i;
  for (const btn of ui.formula.querySelectorAll('button')) {
    btn.setAttribute('aria-pressed', String(+btn.dataset.f === i));
  }
  ui.powerRow.hidden = i !== 3;
  debug.log(CAT.APP, `Formula → ${FORMULAS[i]}`);
  changed();
}

function setPrecision(p) {
  explorer.precision = p;
  for (const btn of ui.precisionMode.querySelectorAll('button')) {
    btn.setAttribute('aria-pressed', String(+btn.dataset.d === p));
  }
  lastGpuMs = null;
  debug.log(CAT.APP, `Precision → ${PRECISIONS[p]}`);
  changed();
}

/** Explains what the chosen precision is doing, or why a fallback is in use. */
function updatePrecisionNote() {
  const note = ui.precisionNote;
  let text = '';
  let bad = false;
  const chosen = explorer.precision;
  const used = explorer.effectivePrecision;
  if (chosen !== 0) {
    if (used !== chosen) {
      text = `Using ${PRECISIONS[used]}: ${explorer.precisionFallbackReason}.`;
    } else if (!explorer.deepVerified) {
      text = `Self-test: ${explorer.selfTestSummary}.`;
      bad = true;
    } else if (used === 2) {
      const len = explorer.refLength;
      text = len
        ? `Reference orbit: ${(len - 1).toLocaleString()} steps, calculated on the CPU in 106-bit arithmetic` +
          (explorer.refSurvives < explorer.maxIterations ? ' (it escapes before the iteration limit; a few pixels may glitch).' : '.')
        : 'Reference orbit: calculated on the next frame.';
    } else {
      text = `Self-test: ${Math.round(explorer.deepBits)} bits of precision on this GPU (f32: 24).`;
    }
  }
  note.hidden = !text;
  note.textContent = text;
  note.classList.toggle('bad', bad);
}

function setPower(p) {
  explorer.power = p;
  const actual = explorer.power;
  ui.power.value = String(actual);
  ui.powerOut.textContent = actual.toFixed(2);
  changed();
}

function zoomCentre(factor) {
  explorer.zoomAt(canvas.width / 2, canvas.height / 2, factor);
}

// ---------------------------------------------------------------- helpers

/** The centre, with as many digits as the zoom level needs (beyond f64 when deep). */
function fmtCenter() {
  const digits = Math.min(32, Math.max(4, Math.ceil(Math.log10(explorer.zoom)) + 4));
  if (digits <= 15) return fmtComplex(explorer.centerRe, explorer.centerIm, digits);
  const [re, im] = explorer.centerText(digits);
  return `${re} ${im.startsWith('-') ? '−' : '+'} ${im.replace(/^-/, '')}i`;
}

function fmtComplex(re, im, digits) {
  const sign = im < 0 ? '−' : '+';
  return `${re.toFixed(digits)} ${sign} ${Math.abs(im).toFixed(digits)}i`;
}

function fmtZoom(z) {
  return z < 1e4 ? `${z.toFixed(z < 10 ? 2 : 0)}×` : `${z.toExponential(2)}×`;
}

/** Tags an error with the startup stage that produced it, keeping the original as `cause`. */
function stageError(stage, cause) {
  const detail = cause?.message ?? String(cause);
  const err = new Error(`${stage}: ${detail}`, { cause });
  err.stage = stage;
  return err;
}

function fail(err) {
  console.error(err);
  if (err?.cause) console.error('Caused by:', err.cause);
  ui.led?.classList.add('err');
  $('fatal-msg').textContent = String(err?.message ?? err);
  if (err?.stage) document.querySelector('#fatal h2').textContent = err.stage;
  $('fatal').hidden = false;
}
