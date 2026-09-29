// Window manager for the app's panels: every panel can float anywhere, dock to
// the left, right or bottom edge (stacking with other panels docked there),
// minimize to its title bar, or close. Layout is saved and restored.
//
// A panel is any element with a `.win__head` title bar. The manager adds the
// minimize and close buttons to it and makes it the drag handle.
//
// On narrow screens (phones) dragging is off: the controls sit at the top and
// the other panels become bottom sheets, one at a time.

const $ = (sel) => document.querySelector(sel);

const SNAP = 56;          // px from a screen edge that docks a dragged panel
const DRAG_START = 5;     // px of movement before a press on the title bar becomes a drag
const MARGIN = 12;        // gap between panels and the screen edges
const TOP_RIGHT = 64;     // right dock starts below the menu button
const SIDE_MAX = 380;     // side docks never get wider than this, even for wide panels
const MOBILE = matchMedia('(max-width: 720px)');

/**
 * @param {object} io  load() → saved layout object or null; save(layout)
 */
export function createWindowManager(io) {
  const docks = { left: $('#dock-left'), right: $('#dock-right'), bottom: $('#dock-bottom') };
  const layer = $('#float-layer');
  const preview = $('#dock-preview');
  const windows = new Map();
  const saved = io.load() ?? {};
  let topZ = 20;

  MOBILE.addEventListener('change', layout);
  window.addEventListener('resize', () => layout());

  // ---------------------------------------------------------------- registration

  /**
   * @param {string} id
   * @param {object} opts
   *   el, width (px), dock ('left' | 'right' | 'bottom' | null), order, open (default visibility),
   *   sheet ('sheet' | 'passive' | 'top' on phones), onOpen(), onClose(), onMinimize(min)
   */
  function register(id, options) {
    const opts = { sheet: 'sheet', ...options };
    const el = opts.el;
    const head = el.querySelector('.win__head');
    const defaults = { dock: opts.dock ?? null, order: opts.order ?? 0, x: null, y: null, open: opts.open ?? true, min: false };
    const w = { id, el, head, opts, defaults, state: { ...defaults, ...sanitize(saved[id]) } };
    windows.set(id, w);

    el.classList.add('win');
    el.dataset.win = id;
    el.dataset.sheet = opts.sheet;
    el.style.setProperty('--win-w', `${opts.width}px`);

    const buttons = document.createElement('div');
    buttons.className = 'win__buttons';
    buttons.append(
      button('–', 'Minimize', () => minimize(id, !w.state.min), 'min'),
      button('×', 'Close', () => close(id), 'close'),
    );
    head.append(buttons);
    head.title = 'Drag to move or dock · double-click to minimize';

    head.addEventListener('pointerdown', (e) => startDrag(e, w));
    head.addEventListener('dblclick', (e) => {
      if (!e.target.closest('button, input, a')) minimize(id, !w.state.min);
    });
    el.addEventListener('pointerdown', () => raise(w), true);

    return {
      open: () => open(id),
      close: () => close(id),
      toggle: () => (w.state.open ? close(id) : open(id)),
      isOpen: () => w.state.open,
      minimize: (min) => minimize(id, min),
      isMinimized: () => w.state.min,
    };
  }

  function button(label, title, onClick, kind) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `win__btn win__btn--${kind}`;
    b.textContent = label;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  }

  // ---------------------------------------------------------------- state changes

  function open(id) {
    const w = windows.get(id);
    const wasOpen = w.state.open;
    w.state.open = true;
    w.state.min = false;
    // Phones show one bottom sheet at a time.
    if (MOBILE.matches && w.opts.sheet === 'sheet') {
      for (const other of windows.values()) {
        if (other !== w && other.opts.sheet === 'sheet' && other.state.open) {
          other.state.open = false;
          other.opts.onClose?.();
        }
      }
    }
    raise(w);
    layout();
    if (!wasOpen) w.opts.onOpen?.();
  }

  function close(id) {
    const w = windows.get(id);
    if (!w.state.open) return;
    w.state.open = false;
    layout();
    w.opts.onClose?.();
  }

  function minimize(id, min) {
    const w = windows.get(id);
    w.state.min = min;
    layout();
    w.opts.onMinimize?.(min);
  }

  function raise(w) {
    if (w.state.dock && !MOBILE.matches) return;
    w.el.style.zIndex = String(++topZ);
    if (topZ > 40) {
      // Renumber so floating panels stay below the menu and dialogs.
      const floating = [...windows.values()].filter((x) => x.el.style.zIndex)
        .sort((a, b) => a.el.style.zIndex - b.el.style.zIndex);
      topZ = 20;
      for (const x of floating) x.el.style.zIndex = String(++topZ);
    }
  }

  /** Puts every panel back where it started. */
  function reset() {
    for (const w of windows.values()) {
      const wasOpen = w.state.open;
      w.state = { ...w.defaults, open: w.state.open };
      w.el.style.zIndex = '';
      if (wasOpen !== w.state.open) (w.state.open ? w.opts.onOpen : w.opts.onClose)?.();
    }
    layout();
  }

  // ---------------------------------------------------------------- layout

  /** Moves every panel into its dock or the floating layer and saves the layout. */
  function layout() {
    const mobile = MOBILE.matches;
    document.body.classList.toggle('wm-mobile', mobile);

    const byDock = { left: [], right: [], bottom: [] };
    for (const w of windows.values()) {
      const { el, state } = w;
      el.hidden = !state.open;
      el.classList.toggle('minimized', state.min);
      el.querySelector('.win__btn--min').textContent = state.min ? '▢' : '–';
      el.querySelector('.win__btn--min').title = state.min ? 'Restore' : 'Minimize';
      document.body.classList.toggle(`win-open-${w.id}`, state.open);

      if (mobile || !state.dock) {
        el.classList.remove('docked');
        el.classList.toggle('floating', !mobile);
        if (el.parentElement !== layer) layer.append(el);
        if (mobile) {
          el.style.left = el.style.top = '';
        } else {
          placeFloating(w);
        }
      } else {
        byDock[state.dock].push(w);
      }
    }

    for (const [edge, list] of Object.entries(byDock)) {
      list.sort((a, b) => a.state.order - b.state.order);
      list.forEach((w, i) => {
        w.state.order = i;
        w.el.classList.add('docked');
        w.el.classList.remove('floating');
        w.el.style.left = w.el.style.top = w.el.style.zIndex = '';
        docks[edge].append(w.el); // append in order, which also reorders existing children
      });
    }

    // Side docks take the width of their widest open panel; the bottom dock fills
    // the gap between them.
    const width = (edge) => Math.min(SIDE_MAX, Math.max(0, ...byDock[edge].filter((w) => w.state.open).map((w) => w.opts.width)));
    const root = document.documentElement.style;
    const left = mobile ? 0 : width('left');
    const right = mobile ? 0 : width('right');
    root.setProperty('--dock-left-w', `${left}px`);
    root.setProperty('--dock-right-w', `${right}px`);
    root.setProperty('--dock-bottom-left', `${left ? left + MARGIN * 2 : MARGIN}px`);
    root.setProperty('--dock-bottom-right', `${right ? right + MARGIN * 2 : MARGIN}px`);

    const anySheet = [...windows.values()].some((w) => w.state.open && w.opts.sheet === 'sheet');
    document.body.classList.toggle('sheet-open', anySheet);

    io.save(Object.fromEntries([...windows.values()].map((w) => [w.id, { ...w.state }])));
  }

  /** Positions a floating panel, giving it a sensible spot the first time and keeping it on screen. */
  function placeFloating(w) {
    const { el, state } = w;
    const width = Math.min(w.opts.width, innerWidth - MARGIN * 2);
    if (state.x == null || state.y == null) {
      state.x = (innerWidth - width) / 2;
      state.y = Math.max(MARGIN, innerHeight * 0.15);
    }
    const h = el.hidden ? 40 : Math.max(40, el.offsetHeight || 40);
    state.x = clamp(state.x, MARGIN - width + 80, innerWidth - 80);  // keep a grab-able strip visible
    state.y = clamp(state.y, 0, innerHeight - Math.min(h, 44));
    el.style.left = `${Math.round(state.x)}px`;
    el.style.top = `${Math.round(state.y)}px`;
    if (!el.style.zIndex) el.style.zIndex = String(++topZ);
  }

  // ---------------------------------------------------------------- dragging

  function startDrag(e, w) {
    if (MOBILE.matches || e.button !== 0 || e.target.closest('button, input, a, select')) return;
    const { el, state } = w;
    const start = { x: e.clientX, y: e.clientY };
    let rect = el.getBoundingClientRect();
    let offset = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    let dragging = false;
    let target = null; // { edge, index } while hovering a dock zone
    // Listen on the window rather than capturing on the title bar: undocking moves the
    // panel to another parent, and the browser drops pointer capture when that happens.
    e.preventDefault();

    const move = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      if (!dragging) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_START) return;
        dragging = true;
        document.body.classList.add('wm-dragging');
        if (state.dock) {
          // Pull the panel out of its dock, keeping the grab point under the pointer.
          state.dock = null;
          state.x = rect.left;
          state.y = rect.top;
          layout();
          rect = el.getBoundingClientRect();
          offset = { x: Math.min(offset.x, rect.width - 20), y: Math.min(offset.y, 30) };
        }
        raise(w);
      }
      state.x = ev.clientX - offset.x;
      state.y = ev.clientY - offset.y;
      el.style.left = `${Math.round(state.x)}px`;
      el.style.top = `${Math.round(state.y)}px`;
      target = dockTarget(w, ev.clientX, ev.clientY);
      showPreview(w, target);
    };

    const end = (ev) => {
      if (ev.pointerId !== e.pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      document.body.classList.remove('wm-dragging');
      preview.hidden = true;
      if (!dragging) return;
      if (target) {
        const list = [...windows.values()]
          .filter((x) => x !== w && x.state.dock === target.edge)
          .sort((a, b) => a.state.order - b.state.order);
        list.splice(target.index, 0, w);
        list.forEach((x, i) => { x.state.order = i; });
        state.dock = target.edge;
      }
      layout();
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  /** Which dock (and where in it) the pointer is over, or null. */
  function dockTarget(w, x, y) {
    let edge = null;
    if (x < SNAP) edge = 'left';
    else if (x > innerWidth - SNAP) edge = 'right';
    else if (y > innerHeight - SNAP) edge = 'bottom';
    if (!edge) return null;
    const others = [...windows.values()]
      .filter((o) => o !== w && o.state.open && o.state.dock === edge)
      .sort((a, b) => a.state.order - b.state.order);
    let index = others.length;
    for (let i = 0; i < others.length; i++) {
      const r = others[i].el.getBoundingClientRect();
      const before = edge === 'bottom' ? x < r.left + r.width / 2 : y < r.top + r.height / 2;
      if (before) { index = i; break; }
    }
    return { edge, index };
  }

  function showPreview(w, target) {
    if (!target) {
      preview.hidden = true;
      return;
    }
    const docked = (edge) => [...windows.values()].filter((o) => o !== w && o.state.open && o.state.dock === edge);
    const sideWidth = (edge) => Math.min(SIDE_MAX, Math.max(w.opts.width, ...docked(edge).map((o) => o.opts.width)));
    let r;
    if (target.edge === 'left') {
      r = { x: MARGIN, y: MARGIN, w: sideWidth('left'), h: innerHeight - MARGIN * 2 };
    } else if (target.edge === 'right') {
      const width = sideWidth('right');
      r = { x: innerWidth - MARGIN - width, y: TOP_RIGHT, w: width, h: innerHeight - TOP_RIGHT - MARGIN };
    } else {
      const l = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dock-bottom-left')) || MARGIN;
      const rr = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dock-bottom-right')) || MARGIN;
      r = { x: l, y: innerHeight - MARGIN - 160, w: innerWidth - l - rr, h: 160 };
    }
    Object.assign(preview.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    preview.hidden = false;
  }

  return { register, layout, reset, open, close };
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** Accepts only well-formed saved state, so a corrupt entry can't break the layout. */
function sanitize(s) {
  if (!s || typeof s !== 'object') return {};
  const out = {};
  if (s.dock === null || ['left', 'right', 'bottom'].includes(s.dock)) out.dock = s.dock;
  for (const k of ['order', 'x', 'y']) if (s[k] === null || Number.isFinite(s[k])) out[k] = s[k];
  for (const k of ['open', 'min']) if (typeof s[k] === 'boolean') out[k] = s[k];
  return out;
}
