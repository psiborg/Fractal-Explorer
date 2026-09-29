// About dialog: what the app is, what it's built with, live details about this
// machine's GPU setup (with a copy button for bug reports), and credits.

const $ = (id) => document.getElementById(id);

// Keep in step with `version` in Cargo.toml.
export const APP = {
  name: 'Fractal Explorer',
  version: '0.1.0',
  author: 'psiborg',
  repo: 'https://github.com/psiborg/Fractal-Explorer',
};

/**
 * @param {object} app  explorer, canvas, gpuInfo (adapter.info from the JS preflight)
 */
export function createAbout(app) {
  const dialog = $('about');
  const copyBtn = $('about-copy');

  $('about-version').textContent = `Version ${APP.version}`;
  const repo = $('about-repo');
  repo.href = APP.repo;
  repo.title = `${APP.author}/${APP.repo.split('/').pop()} on GitHub`;

  copyBtn.addEventListener('click', async () => {
    const text = diagnostics().map(([k, v]) => `${k}: ${v}`).join('\n');
    const ok = await copy(text);
    copyBtn.textContent = ok ? 'Copied ✓' : 'Copy failed';
    setTimeout(() => { copyBtn.textContent = 'Copy diagnostics'; }, 1800);
  });

  /** Live facts about this browser and GPU, shown in the dialog and copied for bug reports. */
  function diagnostics() {
    const e = app.explorer;
    const gpu = app.gpuInfo ?? {};
    const gpuName = [gpu.vendor, gpu.architecture, gpu.description].filter(Boolean).join(' · ') || 'not disclosed by the browser';
    return [
      ['App', `${APP.name} ${APP.version}`],
      ['Source', APP.repo],
      ['GPU', gpuName],
      ['wgpu adapter', e.adapterName || 'WebGPU'],
      ['Precision in use', ['Fast (f32)', 'Deep (double-float)', 'Perturbation'][e.effectivePrecision]],
      ['Deep precision', e.deepVerified
        ? `verified, ${Math.round(e.deepBits)} bits (f32: 24)`
        : `self-test failed: ${e.selfTestSummary}`],
      ['GPU timing', e.hasGpuTimer ? 'available (timestamp-query)' : 'not available'],
      ['Canvas', `${app.canvas.width}×${app.canvas.height} device px @ ${devicePixelRatio}× pixel ratio`],
      ['Frames drawn', Number(e.frames).toLocaleString()],
      ['Browser', browserName()],
    ];
  }

  function open() {
    const list = $('about-system');
    list.replaceChildren(...diagnostics().filter(([k]) => k !== 'App' && k !== 'Source').flatMap(([k, v]) => {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      return [dt, dd];
    }));
    dialog.showModal();
  }

  return { open };
}

function browserName() {
  const brands = navigator.userAgentData?.brands
    ?.filter((b) => !/not.a.brand/i.test(b.brand))
    .map((b) => `${b.brand} ${b.version}`);
  const platform = navigator.userAgentData?.platform;
  if (brands?.length) return `${brands.join(', ')}${platform ? ` on ${platform}` : ''}`;
  return navigator.userAgent;
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers, or clipboard permission denied: fall back to a hidden textarea.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
