// Saved places: bookmarks of a complete view (formula, Julia constant, centre,
// zoom, iterations, palette, precision) with a thumbnail and an editable name.
// Stored in localStorage; export/import as JSON to move them between browsers.
//
// Talks to the app only through the `app` object passed to createPlaces().

const $ = (id) => document.getElementById(id);

const STORAGE_KEY = 'fractal-explorer.places';
const FORMULAS = ['Mandelbrot', 'Burning Ship', 'Tricorn', 'Multibrot'];
const MAX_NAME = 60;

/**
 * @param {object} app
 *   capture() → state, thumbnail() → data URL or null, goTo(state) → Promise,
 *   win (window-manager handle for this panel)
 */
export function createPlaces(app) {
  const ui = {
    root: $('places'), list: $('places-list'), empty: $('places-empty'), count: $('places-count'),
    save: $('places-save'), exportBtn: $('places-export'), importBtn: $('places-import'), file: $('places-file'),
    toast: $('toast'), toastText: $('toast-text'), toastAction: $('toast-action'),
  };

  let places = load();
  let toastTimer = 0;

  ui.save.addEventListener('click', () => save());
  ui.exportBtn.addEventListener('click', exportJson);
  ui.importBtn.addEventListener('click', () => ui.file.click());
  ui.file.addEventListener('change', importJson);

  // ---------------------------------------------------------------- storage

  function load() {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
      return Array.isArray(data?.places) ? data.places.filter(isValidPlace) : [];
    } catch {
      return [];
    }
  }

  /** Persists the list. If storage is full, drops the oldest thumbnails and retries. */
  function persist() {
    const write = () => localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, places }));
    try {
      write();
      return true;
    } catch {
      // Thumbnails are the bulk of the data; the views themselves are tiny.
      for (const p of [...places].reverse()) {
        if (!p.thumb) continue;
        p.thumb = null;
        try {
          write();
          showToast('Storage is full, so some older thumbnails were removed.');
          return true;
        } catch { /* keep trimming */ }
      }
      showToast('Could not save: browser storage is unavailable or full.');
      return false;
    }
  }

  // ---------------------------------------------------------------- actions

  /** Saves the current view and opens its name for editing straight away. */
  function save() {
    const state = app.capture();
    const place = {
      id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: uniqueName(defaultName(state)),
      created: new Date().toISOString(),
      thumb: app.thumbnail(),
      state,
    };
    places.unshift(place);
    persist();
    open();
    render(place.id);
    startRename(place.id);
  }

  function update(id) {
    const place = places.find((p) => p.id === id);
    if (!place) return;
    place.state = app.capture();
    place.thumb = app.thumbnail();
    place.updated = new Date().toISOString();
    persist();
    render(id);
    showToast(`Updated "${place.name}" to the current view.`);
  }

  function remove(id) {
    const index = places.findIndex((p) => p.id === id);
    if (index < 0) return;
    const [removed] = places.splice(index, 1);
    persist();
    render();
    showToast(`Deleted "${removed.name}".`, 'Undo', () => {
      places.splice(Math.min(index, places.length), 0, removed);
      persist();
      render(removed.id);
    });
  }

  function rename(id, name) {
    const place = places.find((p) => p.id === id);
    const clean = name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
    if (!place || !clean || clean === place.name) return;
    place.name = clean;
    persist();
  }

  function startRename(id) {
    const li = ui.list.querySelector(`[data-id="${CSS.escape(id)}"]`);
    const label = li?.querySelector('.place__name');
    if (!label) return;
    const place = places.find((p) => p.id === id);
    const input = document.createElement('input');
    input.className = 'place__rename';
    input.value = place.name;
    input.maxLength = MAX_NAME;
    input.setAttribute('aria-label', 'Place name');
    label.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      if (commit) rename(id, input.value);
      render(id);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // keep app shortcuts (and Esc-closes-drawer) out of the text box
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }

  async function go(id) {
    const place = places.find((p) => p.id === id);
    if (place) await app.goTo(place.state);
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify({ v: 1, places }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const d = new Date();
    const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    a.download = `fractal-places-${local}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function importJson() {
    const file = ui.file.files?.[0];
    ui.file.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const incoming = (Array.isArray(data) ? data : data?.places ?? []).filter(isValidPlace);
      if (incoming.length === 0) {
        showToast('That file has no valid saved places in it.');
        return;
      }
      const known = new Set(places.map((p) => p.id));
      const fresh = incoming.filter((p) => !known.has(p.id));
      places = [...fresh, ...places];
      persist();
      render();
      showToast(fresh.length
        ? `Imported ${fresh.length} place${fresh.length === 1 ? '' : 's'}.`
        : 'Nothing new to import: all of those places are already saved.');
    } catch {
      showToast('That file isn’t a saved-places export.');
    }
  }

  // ---------------------------------------------------------------- rendering

  function render(highlightId) {
    ui.count.textContent = places.length ? String(places.length) : '';
    ui.empty.hidden = places.length > 0;
    ui.exportBtn.disabled = places.length === 0;
    ui.list.replaceChildren(...places.map((p) => placeItem(p, p.id === highlightId)));
  }

  function placeItem(place, fresh) {
    const li = document.createElement('li');
    li.className = 'place' + (fresh ? ' fresh' : '');
    li.dataset.id = place.id;

    const thumb = document.createElement('button');
    thumb.className = 'place__thumb';
    thumb.title = 'Go to this place';
    thumb.setAttribute('aria-label', `Go to ${place.name}`);
    if (place.thumb) thumb.style.backgroundImage = `url("${place.thumb}")`;
    thumb.addEventListener('click', () => go(place.id));

    const info = document.createElement('div');
    info.className = 'place__info';

    const name = document.createElement('div');
    name.className = 'place__name';
    name.textContent = place.name;
    name.title = 'Double-click to rename';
    name.addEventListener('dblclick', () => startRename(place.id));

    const meta = document.createElement('div');
    meta.className = 'place__meta';
    meta.textContent = describe(place.state);
    meta.title = `Saved ${new Date(place.created).toLocaleString()}`;

    const actions = document.createElement('div');
    actions.className = 'place__actions';
    for (const [label, run, cls, title] of [
      ['Go', () => go(place.id), '', 'Fly to this place'],
      ['Rename', () => startRename(place.id), '', 'Rename (or double-click the name)'],
      ['Update', () => update(place.id), '', 'Replace with the current view'],
      ['Delete', () => remove(place.id), 'danger', 'Delete (you can undo)'],
    ]) {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      if (cls) b.className = cls;
      b.addEventListener('click', run);
      actions.append(b);
    }

    info.append(name, meta, actions);
    li.append(thumb, info);
    return li;
  }

  function showToast(text, actionLabel, action) {
    clearTimeout(toastTimer);
    ui.toastText.textContent = text;
    ui.toastAction.hidden = !actionLabel;
    ui.toastAction.textContent = actionLabel ?? '';
    ui.toastAction.onclick = action ? () => { action(); hideToast(); } : null;
    ui.toast.hidden = false;
    toastTimer = setTimeout(hideToast, actionLabel ? 7000 : 3500);
  }

  function hideToast() {
    ui.toast.hidden = true;
  }

  // ---------------------------------------------------------------- open / close

  // Visibility, minimizing and placement belong to the window manager.
  function open() {
    app.win.open();
    render();
  }

  const close = () => app.win.close();
  const isOpen = () => app.win.isOpen();

  function uniqueName(base) {
    const names = new Set(places.map((p) => p.name));
    if (!names.has(base)) return base;
    for (let i = 2; ; i++) if (!names.has(`${base} (${i})`)) return `${base} (${i})`;
  }

  render();
  return { open, close, toggle: () => (isOpen() ? close() : open()), isOpen, save, refresh: () => render() };
}

// ---------------------------------------------------------------- helpers

function formulaName(s) {
  return s.formula === 3 ? `Multibrot p=${+s.power.toFixed(2)}` : FORMULAS[s.formula] ?? 'Fractal';
}

function fmtZoom(z) {
  return z < 1e4 ? `${z < 10 ? z.toFixed(1) : Math.round(z)}×` : `${z.toExponential(1)}×`;
}

function defaultName(s) {
  if (s.julia) {
    const sign = s.jim < 0 ? '−' : '+';
    return `${formulaName(s)} Julia, c = ${s.jre.toFixed(3)} ${sign} ${Math.abs(s.jim).toFixed(3)}i`;
  }
  return `${formulaName(s)} at ${fmtZoom(s.zoom)}`;
}

function describe(s) {
  return [
    formulaName(s) + (s.julia ? ' Julia' : ''),
    fmtZoom(s.zoom),
    `${s.iter} iter`,
    s.precision === 1 ? 'Deep' : s.precision === 2 ? 'Perturb' : null,
  ].filter(Boolean).join(' · ');
}

/** Guards against corrupt storage and hand-edited or foreign import files. */
function isValidPlace(p) {
  const s = p?.state;
  const finite = (...xs) => xs.every((x) => typeof x === 'number' && Number.isFinite(x));
  return typeof p?.id === 'string' && typeof p.name === 'string' && s &&
    finite(s.formula, s.power, s.re, s.im, s.zoom, s.iter, s.palette, s.precision, s.jre, s.jim) &&
    typeof s.julia === 'boolean' && s.zoom > 0 &&
    (s.reLo === undefined || finite(s.reLo)) && (s.imLo === undefined || finite(s.imLo)) &&
    (p.thumb == null || (typeof p.thumb === 'string' && p.thumb.startsWith('data:image/')));
}
