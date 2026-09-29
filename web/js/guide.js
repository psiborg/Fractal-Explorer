// Beginner guide: a short tour with "try it" buttons, plus a live description of
// whatever is currently on screen. Talks to the app only through the `app` object
// passed to createGuide(), so it has no knowledge of wgpu or the canvas.

const $ = (id) => document.getElementById(id);

// Destinations used by the tour (complex-plane centre and magnification).
const PLACES = {
  seahorse: { re: -0.7435, im: 0.1300, zoom: 250 },
  minibrot: { re: -1.7685, im: 0, zoom: 60 },
  deep: { re: -0.743643887, im: 0.1318259042, zoom: 30000 },
  wall: { re: -0.743643887, im: 0.1318259042, zoom: 4e5 },
  armada: { re: -1.762, im: 0.028, zoom: 20 },
  abyss: { re: -0.743643887037151, im: 0.131825904205330, zoom: 1e10 },
  // A boundary point verified against 220-bit arithmetic: rich detail at 10²⁰× with 2,000 iterations.
  perturbDive: { re: -0.673439290393659, reLo: 1.1287677835340987e-18, im: 0.31562619359577265, imLo: 2.5557350433499768e-17, zoom: 1e20 },
  neck: { re: -0.75, im: 0, zoom: 12 },
  feigenbaum: { re: -1.401155, im: 0, zoom: 60 },
  piNeck: { re: -0.75, im: 0.001, zoom: 300 },
};

const JULIAS = {
  rabbit: [-0.123, 0.745],
  dendrite: [0, 1],
  dust: [-0.8, 0.2],
};

/**
 * @param {object} app
 *   explorer, flyTo(place), setIterations(n), setPalette(i), cyclePalette(),
 *   setFormula(i), setPower(p), morphPower(from, to, ms), setPrecision(p),
 *   openSettings(), changed(), win (window-manager handle for this panel)
 */
export function createGuide(app) {
  const ui = {
    root: $('guide'), step: $('guide-step'), heading: $('guide-heading'), text: $('guide-text'),
    actions: $('guide-actions'), prev: $('guide-prev'), next: $('guide-next'), dots: $('guide-dots'),
    chapters: $('guide-chapters'), body: $('guide-body'),
  };

  // Tour destinations are Mandelbrot coordinates, so switch back to it first.
  const mandelbrot = () => {
    if (app.explorer.formula !== 0) app.setFormula(0);
    else if (app.explorer.isJulia) app.explorer.showMandelbrot();
  };
  const go = (place) => {
    mandelbrot();
    return app.flyTo(PLACES[place]);
  };
  const julia = (name) => {
    if (app.explorer.formula !== 0) app.setFormula(0);
    app.explorer.showJulia(...JULIAS[name]);
    app.changed();
  };

  // ---------------------------------------------------------------- chapter 1: fractals & the maths
  const intro = [
    {
      title: 'What is a fractal?',
      html: `
        <p>A <b>fractal</b> is a shape that keeps showing new detail however far you zoom in. Often the small
        parts echo the whole: a fern's frond looks like a small fern, and a branch like a small tree. That
        property is called <b>self-similarity</b>.</p>
        <p>Benoit Mandelbrot coined the word in 1975, from the Latin <i>fractus</i>, "broken". He pointed out
        that mountains, coastlines, clouds and lightning aren't smooth: they stay rough at every scale, and
        classical geometry of lines and circles has no good way to describe them.</p>
        <p>Nature is full of fractals: Romanesco broccoli, river networks, blood vessels, the branching
        airways of your lungs. Natural ones stop after a handful of levels; mathematical ones go on
        forever.</p>`,
      actions: [['See self-similarity', () => go('minibrot')]],
    },
    {
      title: 'Measuring roughness',
      html: () => `
        ${kochFigure()}
        <p>The <b>Koch curve</b> starts as a line. At each step, the middle third of every segment is replaced
        by two sides of a triangle. Repeat forever and the curve becomes infinitely long, yet still fits in a
        small box.</p>
        <p><b>Dimension</b> measures how a shape fills space. Shrink a line to ⅓ and you need 3 copies to
        rebuild it: 3 = 3¹, so dimension 1. A square needs 9 = 3² copies: dimension 2. The Koch curve needs
        4 copies at ⅓ size, so 4 = 3<sup><i>D</i></sup>, giving <i>D</i> = log 4 ⁄ log 3 ≈ <b>1.26</b>:
        more than a line, less than a surface.</p>
        <p>Measured this way, the west coast of Britain comes out at about 1.25. The boundary of the
        Mandelbrot set is so crinkled that its dimension is exactly <b>2</b>, as Mitsuhiro Shishikura proved
        in 1998.</p>`,
      actions: [['Zoom into the boundary', () => go('seahorse')]],
    },
    {
      title: 'Complex numbers in a minute',
      html: `
        <p>The Mandelbrot set lives on the <b>complex plane</b>. A complex number <i>a</i> + <i>b</i>i is
        just a point: <i>a</i> across, <i>b</i> up. The one new ingredient is i, a number whose square
        is −1.</p>
        <p>What makes them useful here is what multiplication does to points: <b>distances multiply and
        angles add</b>. So squaring <i>z</i> squares its distance from 0 and doubles its angle. Each step of
        <i>z</i> → <i>z</i>² + <i>c</i> is a <b>stretch and a twist</b>, then a shift by <i>c</i>.</p>
        <p>Points nearer 0 than 1 shrink when squared; points farther out grow. Once <i>z</i> is more than 2
        from 0 it's guaranteed to fly off to infinity, which is why the whole set fits inside a circle of
        radius 2, and why the app can stop counting as soon as a point gets that far.</p>`,
      actions: [['Show the whole set', () => { mandelbrot(); app.explorer.reset(); app.changed(); }]],
    },
    {
      title: 'Iteration and chaos',
      html: `
        <p>Feeding an answer back into the same rule is called <b>iteration</b>, and it's how many real
        systems evolve. In 1976 the biologist Robert May studied a simple population model,
        <i>x</i> → <i>r x</i>(1 − <i>x</i>): next year's population worked out from this year's.</p>
        <p>For low growth rates <i>r</i> the population settles to one value. At <i>r</i> = 3 it starts
        alternating between two values, then four, then eight, splitting faster and faster until at
        <i>r</i> ≈ 3.57 it becomes <b>chaotic</b>: fully determined by the rule, yet unpredictable in
        practice.</p>
        <p>That model is the Mandelbrot rule in disguise, with <i>c</i> = <i>r</i>/2 − <i>r</i>²/4. Along the
        real axis, each bulb of the set is one of those splits: <i>r</i> = 3 is the neck at −0.75, and the
        onset of chaos is the point −1.4012, where the spike begins. The bulbs shrink by a ratio approaching
        4.669…, the <b>Feigenbaum constant</b>, a number that also turns up in experiments on fluids and
        electronic circuits.</p>`,
      actions: [
        ['The first split (r = 3)', () => go('neck')],
        ['Where chaos begins', async () => { app.setIterations(1500); await go('feigenbaum'); }],
      ],
    },
    {
      title: 'Surprises inside the set',
      html: `
        <p><b>π is hiding in it.</b> In 1991 Dave Boll noticed that if you start just above the neck, at
        −0.75 + ε<i>i</i>, the number of steps before escaping, multiplied by ε, gets closer and closer to π.
        The button flies to ε = 0.001; the card below does the multiplication.</p>
        <p><b>It's all one piece.</b> The filaments look like scattered dust, but Adrien Douady and John
        Hubbard proved in 1982 that the set is connected.</p>
        <p><b>Nobody knows its exact area.</b> Estimates put it at about 1.5066, but no formula is known.</p>
        <p><b>Its biggest open question</b> is whether the set is "locally connected" (the MLC conjecture).
        If it is, its whole structure would be understood. Research on these dynamics contributed to Fields
        Medals for Jean-Christophe Yoccoz (1994) and Curtis McMullen (1998).</p>`,
      actions: [['Find π', async () => { app.setIterations(5000); await go('piNeck'); }]],
    },
    {
      title: 'Where fractals are useful',
      html: `
        <ul>
          <li><b>Antennas.</b> A fractal-shaped antenna packs a long, wiggly conductor into a small space and
          can receive several frequency bands at once. Designs like this have been used in phones and radio
          equipment.</li>
          <li><b>Computer graphics.</b> Mountains, clouds and textures in films and games are made by layering
          noise at many scales, a fractal recipe. <i>Star Trek II</i> (1982) used fractal terrain for its
          "Genesis" planet sequence.</li>
          <li><b>Medicine and biology.</b> Lungs and blood vessels branch fractally to reach every cell with
          little material. Researchers measure the fractal dimension of retinal blood vessels or tumour
          outlines as a way to study disease.</li>
          <li><b>Earth science.</b> Coastlines, river networks and fault systems are fractal, and how often
          earthquakes happen at each size follows a power law with the same scale-free character.</li>
          <li><b>Finance.</b> In 1963 Mandelbrot showed that cotton prices make big jumps far more often than
          bell-curve models predict. "Fat-tailed" models of market risk grew out of that work.</li>
        </ul>
        <p>The Mandelbrot set itself is pure mathematics, but the ideas it made famous (iteration,
        sensitivity to tiny changes, fractional dimension) are used right across science.</p>`,
      actions: [],
    },
  ];

  // ---------------------------------------------------------------- chapter 2: using the app
  const tour = [
    {
      title: 'What is this picture?',
      html: `
        <p>Every pixel is a <b>complex number</b> <i>c</i> (horizontal = real part, vertical = imaginary part).</p>
        <p>For each one, start with <i>z</i> = 0 and repeat one rule: <b><i>z</i> → <i>z</i>² + <i>c</i></b>.</p>
        <p>If <i>z</i> stays small forever, the pixel is <b>in the Mandelbrot set</b> and drawn black.
        If it flies off towards infinity, it's coloured by <i>how fast</i> it escaped.</p>
        <p>That one rule makes everything you'll see.</p>`,
      actions: [['Show the whole set', () => { mandelbrot(); app.explorer.reset(); app.changed(); }]],
    },
    {
      title: 'The action is at the edge',
      html: `
        <p>Deep inside the black, points stay trapped; far outside, they escape instantly. All the
        detail lives on the <b>boundary</b>, where tiny changes to <i>c</i> flip the outcome.</p>
        <p><b>Drag</b> to move, <b>scroll</b> or <b>pinch</b> to zoom, <b>double-click</b> to dive in.</p>
        <p>The crease between the big heart shape and the round bulb is called <b>Seahorse Valley</b>.</p>`,
      actions: [['Fly to Seahorse Valley', () => go('seahorse')]],
    },
    {
      title: 'It never runs out',
      html: `
        <p>Zoom into the boundary and new shapes keep appearing, at every scale. Mathematically there's no
        bottom.</p>
        <p>Look along the thin spike to the left of the set: it's studded with <b>mini Mandelbrots</b>,
        near-perfect copies of the whole thing, each with its own spikes and copies.</p>`,
      actions: [['Find a mini Mandelbrot', () => go('minibrot')]],
    },
    {
      title: 'Iterations: how hard to look',
      html: `
        <p>A computer can't iterate forever, so it gives up after a fixed number of steps
        (the <b>Iterations</b> slider) and calls the point black.</p>
        <p>Zoomed out, 500 is plenty. Zoomed in, points near the edge take thousands of steps to escape, so too
        few iterations shows <b>black blobs</b> where there should be detail.</p>
        <p>Try the same spot at 100 and then 1,500 iterations.</p>`,
      actions: [
        ['Go deep (100 iterations)', async () => { app.setIterations(100); await go('deep'); }],
        ['Raise to 1,500', () => app.setIterations(1500)],
      ],
    },
    {
      title: 'Julia sets: the other half',
      html: `
        <p>Flip the rule around: keep <i>c</i> fixed, and let each pixel be the <b>starting</b> <i>z</i>.
        That gives a <b>Julia set</b>, and every point <i>c</i> has its own.</p>
        <p>The Mandelbrot set is a map of them: pick <i>c</i> <b>inside</b> the black and its Julia set is
        one connected piece; pick it <b>outside</b> and it shatters into dust.</p>
        <p><b>Right-click</b> anywhere on the Mandelbrot set (or press <kbd>J</kbd>) to see that point's Julia set.</p>`,
      actions: [
        ['Douady rabbit', () => julia('rabbit')],
        ['Dendrite', () => julia('dendrite')],
        ['Dust', () => julia('dust')],
        ['Back to Mandelbrot', () => { mandelbrot(); app.explorer.showMandelbrot(); app.changed(); }],
      ],
    },
    {
      title: 'Change the formula',
      html: `
        <p><i>z</i>² + <i>c</i> is just one rule. Small changes to it give completely different worlds
        (pick them in the <b>Formula</b> buttons, or press <kbd>F</kbd>):</p>
        <p><b>Burning Ship</b> takes the absolute value of both parts of <i>z</i> before squaring. It folds
        the plane, and the result looks like a ship in flames, with an armada of small ships on the
        horizon.</p>
        <p><b>Tricorn</b> squares the <i>mirror image</i> (complex conjugate) of <i>z</i>, giving three
        corners instead of a cardioid.</p>
        <p><b>Multibrot</b> uses <i>z</i><sup><i>p</i></sup> + <i>c</i>. Each step up in power adds another
        lobe: power <i>p</i> has <i>p</i> − 1 of them. The power can be fractional, so you can watch the
        shape morph.</p>
        <p>Right-click works with every formula, so each one has its own Julia sets too.</p>`,
      actions: [
        ['Burning Ship', () => app.setFormula(1)],
        ['Visit the armada', async () => { app.setFormula(1); await app.flyTo(PLACES.armada); }],
        ['Tricorn', () => app.setFormula(2)],
        ['Multibrot, p = 3', () => { app.setFormula(3); app.setPower(3); }],
        ['Morph p from 2 to 6', () => { app.setFormula(3); app.morphPower(2, 6, 5000); }],
      ],
    },
    {
      title: 'Colour is a choice',
      html: `
        <p>The maths only gives each pixel a number: how many steps it took to escape. The colours are an
        artistic mapping from that number, smoothed so you don't see hard bands.</p>
        <p>Black always means "didn't escape within the iteration limit".</p>`,
      actions: [['Next palette', () => app.cyclePalette()]],
    },
    {
      title: 'How your GPU draws this',
      html: `
        <p>Every pixel's calculation is independent, which is exactly what a GPU is built for. Thousands of
        cores run the same small program, the <b>fragment shader</b> written in <b>WGSL</b>, on different
        pixels at the same time.</p>
        <p>The app logic is <b>Rust</b> compiled to <b>WebAssembly</b>. It keeps track of where you're
        looking, and each frame it sends just 48 bytes to the GPU through <b>wgpu</b>, which drives the
        browser's WebGPU API.</p>
        <p>Developers can watch this happen: turn on debug logging in Settings and open the browser console.</p>`,
      actions: [['Open Settings', () => app.openSettings()]],
    },
    {
      title: 'The precision wall',
      html: `
        <p>In <b>Fast</b> mode the shader uses 32-bit floats, which hold about 7 significant digits. Around
        100,000× zoom, neighbouring pixels round to the <b>same number</b>, and the image turns into blocks.</p>
        <p><b>Deep</b> mode (press <kbd>D</kbd>) stores every number as a <i>pair</i> of floats: the main value
        plus the tiny part it couldn't hold. That's about 48 bits, enough to stay sharp past
        10,000,000,000×. Each step costs 10–20× more arithmetic, so watch <b>GPU time</b> in the panel
        rise.</p>
        <p><b>Perturb</b> goes further still. The CPU calculates one <i>reference</i> point's orbit in 106-bit
        arithmetic, and the GPU works out only how each pixel <i>differs</i> from it. Those differences are
        tiny, so they fit in ordinary floats, and the image stays sharp to about 10²⁸×.</p>
        <p>It covers the Mandelbrot set, the Tricorn and whole-number Multibrot powers. The Burning Ship's
        folds and Julia sets fall back to Deep.</p>`,
      actions: [
        ['Show me the wall (Fast)', async () => {
          mandelbrot(); app.setPrecision(0); app.setIterations(1500); await app.flyTo(PLACES.wall);
        }],
        ['Switch to Deep', () => app.setPrecision(1)],
        ['Dive to 10¹⁰× in Deep', async () => {
          mandelbrot(); app.setPrecision(1); app.setIterations(3000); await app.flyTo(PLACES.abyss, 4000);
        }],
        ['Dive to 10²⁰× with Perturb', async () => {
          mandelbrot(); app.setPrecision(2); app.setIterations(2000); await app.flyTo(PLACES.perturbDive, 6000);
        }],
      ],
    },
  ];

  const CHAPTERS = ['Fractals & the maths', 'Using the app'];
  const steps = [
    ...intro.map((step) => ({ ...step, chapter: 0 })),
    ...tour.map((step) => ({ ...step, chapter: 1 })),
  ];
  const chapterStart = (c) => steps.findIndex((step) => step.chapter === c);
  const chapterPages = (c) => steps.filter((step) => step.chapter === c);

  // Page counts on the chapter tabs.
  for (const b of ui.chapters.querySelectorAll('button[data-c]')) {
    b.querySelector('.count').textContent = String(chapterPages(+b.dataset.c).length);
  }

  let index = 0;

  ui.chapters.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-c]');
    if (b) show(chapterStart(+b.dataset.c));
  });
  ui.dots.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]');
    if (b) show(+b.dataset.i);
  });
  ui.prev.addEventListener('click', () => show(index - 1));
  ui.next.addEventListener('click', () => (index === steps.length - 1 ? close() : show(index + 1)));

  function show(i) {
    index = Math.max(0, Math.min(steps.length - 1, i));
    const step = steps[index];
    const start = chapterStart(step.chapter);
    const pages = chapterPages(step.chapter);
    const page = index - start + 1;

    for (const b of ui.chapters.querySelectorAll('button[data-c]')) {
      b.setAttribute('aria-pressed', String(+b.dataset.c === step.chapter));
    }
    ui.step.textContent = `Page ${page} of ${pages.length}`;
    // Dots for this chapter only; each one's tooltip is its page title.
    ui.dots.replaceChildren(...pages.map((p, j) => {
      const b = document.createElement('button');
      b.dataset.i = String(start + j);
      b.title = p.title;
      b.setAttribute('aria-label', `Page ${j + 1}: ${p.title}`);
      b.setAttribute('aria-current', String(start + j === index));
      return b;
    }));

    ui.heading.textContent = step.title;
    ui.text.innerHTML = typeof step.html === 'function' ? step.html() : step.html;
    ui.actions.replaceChildren(...step.actions.map(([label, run]) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', run);
      return b;
    }));
    ui.actions.hidden = step.actions.length === 0;
    ui.body.scrollTop = 0;

    ui.prev.disabled = index === 0;
    const last = index === steps.length - 1;
    const endOfChapter = !last && steps[index + 1].chapter !== step.chapter;
    ui.next.textContent = last ? 'Finish' : endOfChapter ? `Next: ${CHAPTERS[steps[index + 1].chapter]} ›` : 'Next ›';
    ui.next.classList.toggle('primary', last || endOfChapter);
  }

  // Visibility, minimizing and placement belong to the window manager.
  const open = () => app.win.open();
  const close = () => app.win.close();
  const isOpen = () => app.win.isOpen();

  show(0);
  return { open, close, toggle: () => (isOpen() ? close() : open()), isOpen };
}

/** The first four stages of the Koch curve, drawn as a small inline SVG. */
function kochFigure() {
  // 2 × 2 grid. A segment of length L rises at most L·√3/6 ≈ 0.29·L, so 140-wide cells need ~41px.
  const cellW = 150, cellH = 62, L = 136;
  const koch = (a, b, depth) => {
    if (depth === 0) return [a];
    const [dx, dy] = [(b[0] - a[0]) / 3, (b[1] - a[1]) / 3];
    const p1 = [a[0] + dx, a[1] + dy];
    const p3 = [a[0] + 2 * dx, a[1] + 2 * dy];
    // Peak: the middle third rotated by −60°, which points up on screen.
    const p2 = [p1[0] + dx / 2 + dy * Math.sqrt(3) / 2, p1[1] + dy / 2 - dx * Math.sqrt(3) / 2];
    return [...koch(a, p1, depth - 1), ...koch(p1, p2, depth - 1), ...koch(p2, p3, depth - 1), ...koch(p3, b, depth - 1)];
  };
  const cells = [0, 1, 2, 3].map((d) => {
    const x = (d % 2) * cellW + (cellW - L) / 2;
    const y = Math.floor(d / 2) * cellH + 46;
    const pts = [...koch([x, y], [x + L, y], d), [x + L, y]];
    return `<polyline points="${pts.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ')}" class="koch__line"/>` +
      `<text x="${x + L / 2}" y="${y + 12}" text-anchor="middle" class="koch__label">step ${d}${d === 3 ? ' … ∞' : ''}</text>`;
  });
  return `<figure class="koch"><svg viewBox="0 0 ${cellW * 2} ${cellH * 2}" role="img" aria-label="The Koch curve at steps 0 to 3">${cells.join('')}</svg></figure>`;
}
