// "What you're looking at": a live, plain-language description of the current
// view (named regions, whether the centre escapes, connected vs dust Julia sets,
// Boll's π at the neck) plus how much work the GPU is doing for the frame.
// Lives in its own floating panel, independent of the guide.

const $ = (id) => document.getElementById(id);

/**
 * @param {object} app  explorer, canvasPixels(), win (window-manager handle for this panel)
 */
export function createInsight(app) {
  const ui = {
    where: $('seeing-where'), stats: $('seeing-stats'), tip: $('seeing-tip'), summary: $('insight-summary'),
  };
  const isVisible = () => app.win.isOpen();

  /** Refreshes the text. Cheap; call whenever the view changes. */
  function update() {
    if (!isVisible()) return;
    const e = app.explorer;
    const view = {
      julia: e.isJulia, re: e.centerRe, im: e.centerIm, zoom: e.zoom,
      iter: e.maxIterations, atLimit: e.atPrecisionLimit, jre: e.juliaRe, jim: e.juliaIm,
      formula: e.formula, power: e.power, deep: e.deepActive, arith: e.effectivePrecision, refLen: e.refLength,
    };
    const { where, tip } = describe(view);
    ui.where.innerHTML = where;
    // When minimized, the title bar shows the first sentence only.
    ui.summary.textContent = app.win.isMinimized() ? firstSentence(ui.where.textContent) : '';
    const px = app.canvasPixels();
    ui.stats.textContent =
      `This frame: ${(px / 1e6).toFixed(1)} million pixels × up to ${view.iter.toLocaleString()} ` +
      `iterations = up to ${fmtBig(px * view.iter)} z² + c steps, run in parallel on your GPU` +
      (view.arith === 2
        ? `, each tracking only its difference from a ${(view.refLen - 1).toLocaleString()}-step reference orbit calculated on the CPU.`
        : view.deep ? ', each in double-float (roughly 10–20× the arithmetic of Fast).' : '.');
    ui.tip.hidden = !tip;
    ui.tip.innerHTML = tip ?? '';
  }

  return {
    show: () => app.win.open(),
    hide: () => app.win.close(),
    toggle: () => (isVisible() ? app.win.close() : app.win.open()),
    isVisible,
    update,
  };
}

function firstSentence(text) {
  const m = text.match(/^.*?[.!?](\s|$)/);
  return (m ? m[0] : text).trim();
}

// ---------------------------------------------------------------- description

const NAMES = ['Mandelbrot set', 'Burning Ship', 'Tricorn', 'Multibrot set'];

/**
 * Returns how many steps the orbit of z needs to escape, or Infinity if it stays
 * bounded. Mirrors `iterate()` in fractal.wgsl, in f64.
 */
function escapeTime(zr, zi, cr, ci, max, formula = 0, power = 2) {
  const bailout = Math.max(4, 2 ** (2 / Math.max(power - 1, 0.5)));
  for (let n = 0; n < max; n++) {
    const r2 = zr * zr + zi * zi;
    if (r2 > bailout) return n;
    let x, y;
    if (formula === 1) {
      const ax = Math.abs(zr), ay = Math.abs(zi);
      x = ax * ax - ay * ay; y = -2 * ax * ay;
    } else if (formula === 2) {
      x = zr * zr - zi * zi; y = -2 * zr * zi;
    } else if (formula === 3) {
      const r = r2 ** (power / 2), t = Math.atan2(zi, zr) * power;
      x = r2 === 0 ? 0 : r * Math.cos(t); y = r2 === 0 ? 0 : r * Math.sin(t);
    } else {
      x = zr * zr - zi * zi; y = 2 * zr * zi;
    }
    zr = x + cr;
    zi = y + ci;
  }
  return Infinity;
}

const REGIONS = [
  { re: -1.401155, im: 0, r: 0.02, minZoom: 10,
    text: 'This is the <b>Feigenbaum point</b>, c ≈ −1.4012, where the period-doubling bulbs pile up. To its left along the spike, the matching population model is chaotic.' },
  { re: -0.75, im: 0, r: 0.01, minZoom: 8,
    text: 'This is the <b>neck</b> at −0.75, where the main cardioid meets the period-2 disc. In the population model it\'s r = 3, where the population first starts alternating between two values.' },
  { re: -1.7549, im: 0, r: 0.03, minZoom: 15,
    text: 'You\'re looking at a <b>mini Mandelbrot</b> on the main spike: a near-copy of the whole set, repeated at a smaller scale.' },
  { re: -0.75, im: 0.1, r: 0.09, minZoom: 3,
    text: 'This is <b>Seahorse Valley</b>, the crease between the main cardioid and the period-2 bulb. Its spirals look like seahorse tails.' },
  { re: -0.75, im: -0.1, r: 0.09, minZoom: 3,
    text: 'This is the lower <b>Seahorse Valley</b>, a mirror image of the upper one. The set is symmetric about the real axis.' },
  { re: 0.28, im: 0, r: 0.06, minZoom: 3,
    text: 'This is <b>Elephant Valley</b>, near the cusp of the main cardioid. Zoom along its edge for trunk-like spirals.' },
];

function describe(v) {
  const limitTip = !v.atLimit ? null : v.arith === 2
    ? 'You\'ve reached the limit of <b>perturbation</b> here: about 10²⁸×, where the 106-bit centre and the f32 exponent run out.'
    : v.deep
    ? 'You\'ve reached the limit of <b>double-float</b> too: past about 10¹⁰× even 48 bits can\'t separate neighbouring pixels.'
    : 'You\'ve hit the <b>precision wall</b>: 32-bit floats can\'t tell neighbouring pixels apart any more. Press <kbd>D</kbd> to switch to <b>Deep</b> precision.';

  // This description's own maths is plain f64, which can't resolve the view past ~10¹³×.
  const tooDeep = v.zoom > 1e13;
  const setName = v.formula === 3 ? `Multibrot set (p = ${v.power.toFixed(2)})` : NAMES[v.formula];

  if (v.julia) {
    const inside = escapeTime(0, 0, v.jre, v.jim, 2000, v.formula, v.power) === Infinity;
    const c = fmtC(v.jre, v.jim);
    const lead = `The <b>Julia set</b> for <i>c</i> = ${c}, using the ${setName} formula.`;
    let where;
    if (v.formula === 1) {
      // No connectedness theorem for the Burning Ship: its rule isn't complex-analytic.
      where = `${lead} That <i>c</i> is ${inside ? 'inside' : 'outside'} the Burning Ship. Unlike the Mandelbrot set, that doesn't reliably predict whether this Julia set is one piece.`;
    } else {
      where = inside
        ? `${lead} That <i>c</i> is inside the ${setName}, so this Julia set is <b>connected</b>: all one piece.`
        : `${lead} That <i>c</i> is outside the ${setName}, so this Julia set is <b>disconnected dust</b>: infinitely many separate specks.`;
    }
    return { where, tip: limitTip ?? 'Press <kbd>M</kbd> to return to the main set and right-click somewhere else.' };
  }

  if (v.formula !== 0) {
    const home = {
      1: 'The whole <b>Burning Ship</b>. The black hull is the set itself; the flames are points that escape slowly. Look along the thin line to the left: it\'s an armada of tiny ships.',
      2: 'The whole <b>Tricorn</b>, or "Mandelbar". Squaring the mirror image of <i>z</i> turns the Mandelbrot cardioid into three corners, and its mini copies come out distorted rather than exact.',
      3: multibrotHome(v.power),
    };
    if (v.zoom < 2) return { where: home[v.formula], tip: limitTip ?? 'Right-click a point near the edge to see its Julia set.' };
    const n = tooDeep ? null : escapeTime(0, 0, v.re, v.im, v.iter, v.formula, v.power);
    const centre = tooDeep
      ? deepNote(v)
      : n === Infinity
        ? 'The centre point stays bounded, so it\'s drawn black.'
        : `The centre point escapes after <b>${n}</b> step${n === 1 ? '' : 's'}.`;
    return { where: `You're zoomed in <b>${fmtZoom(v.zoom)}</b> on the ${setName}. ${centre}`, tip: limitTip };
  }

  if (v.zoom < 2) {
    return {
      where: 'The <b>whole Mandelbrot set</b>. The black heart shape is the <b>main cardioid</b>, the disc to its left is the <b>period-2 bulb</b>, and the spike on the far left runs along the real axis to −2.',
      tip: 'Try zooming into the crease between the heart and the disc.',
    };
  }

  const region = REGIONS.find((r) => v.zoom >= r.minZoom && Math.hypot(v.re - r.re, v.im - r.im) < r.r);
  const n = tooDeep ? null : escapeTime(0, 0, v.re, v.im, v.iter);
  const centre = tooDeep
    ? deepNote(v)
    : n === Infinity
      ? `The point at the centre of the screen didn't escape within ${v.iter.toLocaleString()} steps, so it's drawn black (in the set, as far as we can tell).`
      : `The point at the centre of the screen escapes after <b>${n}</b> step${n === 1 ? '' : 's'}.`;
  let where = `${region ? region.text : `You're zoomed in <b>${fmtZoom(v.zoom)}</b> on the boundary.`} ${centre}`;
  // Boll's π: just above the neck, steps × distance above the axis approaches π.
  const eps = Math.abs(v.im);
  if (n !== null && Math.abs(v.re + 0.75) < 1e-6 && eps > 0 && eps < 0.05) {
    where += n === Infinity
      ? ' Raise <b>Iterations</b> until the centre escapes, and its step count will reveal π.'
      : ` <b>${n.toLocaleString()} steps × ${+eps.toPrecision(3)} = ${(n * eps).toFixed(4)}</b>, close to π = 3.1416.`;
  }

  let tip = limitTip;
  if (!tip && v.zoom > 2000 && v.iter < 1000) {
    tip = 'At this depth, black blobs may just be points that need more steps. Try raising <b>Iterations</b> (or press <kbd>]</kbd>).';
  }
  return { where, tip };
}

function deepNote(v) {
  const how = v.arith === 2
    ? '<b>perturbation</b>: one 106-bit reference orbit plus each pixel\'s tiny difference from it'
    : '<b>double-float</b> arithmetic';
  return `At this depth even 64-bit numbers can't tell neighbouring pixels apart; the image comes from ${how}.`;
}

function multibrotHome(p) {
  const lead = `The whole <b>Multibrot set</b> for power ${p.toFixed(2)}.`;
  if (Number.isInteger(+p.toFixed(2))) {
    const lobes = Math.round(p) - 1;
    return `${lead} Its main body has ${lobes} lobe${lobes === 1 ? '' : 's'} and ${lobes}-fold symmetry.`;
  }
  const lo = Math.floor(p - 1), hi = Math.ceil(p - 1);
  return `${lead} A fractional power sits between ${lo} and ${hi} lobes, with a seam where the angle wraps around the negative real axis.`;
}

function fmtC(re, im) {
  return `${re.toFixed(4)} ${im < 0 ? '−' : '+'} ${Math.abs(im).toFixed(4)}i`;
}

function fmtZoom(z) {
  return z < 1e4 ? `${Math.round(z).toLocaleString()}×` : `${z.toExponential(1)}×`;
}

function fmtBig(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} billion`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} million`;
  return n.toLocaleString();
}
