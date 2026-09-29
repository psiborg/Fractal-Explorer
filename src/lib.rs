//! WebAssembly entry point. JavaScript creates an `Explorer` from a canvas,
//! forwards pointer/wheel input to it, and calls `render()` when something changed.

mod dd;
pub mod debug;
mod perturb;
mod renderer;
mod selftest;
mod timer;
mod view;

use wasm_bindgen::prelude::*;
use web_sys::HtmlCanvasElement;

use dd::DD;
use debug::{WASM, WGPU};
use perturb::ReferenceManager;
use renderer::Renderer;
use view::{Formula, Mode, Precision, View};

/// Highest iteration count the app allows (also sizes the reference orbit buffer).
pub const MAX_ITERATIONS: u32 = 20_000;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
    debug::install_logger();
}

/// Sets which debug categories log to the console (bit flags; see `debug.rs`).
#[wasm_bindgen(js_name = setDebugFlags)]
pub fn set_debug_flags(flags: u32) {
    debug::set_flags(flags);
    dlog!(WASM, "Debug flags set to {flags:#07b}");
}

#[wasm_bindgen]
pub struct Explorer {
    renderer: Renderer,
    view: View,
    reference: ReferenceManager,
    dirty: bool,
}

#[wasm_bindgen]
impl Explorer {
    /// Builds the GPU pipeline for `canvas`. Use `await Explorer.create(canvas)`.
    pub async fn create(canvas: HtmlCanvasElement) -> Result<Explorer, JsValue> {
        let (width, height) = (canvas.width(), canvas.height());
        dlog!(
            WASM,
            "Explorer::create called from JS with a {width}×{height} canvas (HtmlCanvasElement passed as an externref)"
        );
        let instance = wgpu::Instance::default();
        let surface = create_surface(&instance, canvas)?;
        let renderer = Renderer::new(&instance, surface, width, height)
            .await
            .map_err(|e| JsValue::from_str(&e))?;
        dlog!(
            WASM,
            "Explorer ready: the struct lives in Wasm linear memory ({} bytes); JS holds only a pointer to it",
            std::mem::size_of::<Explorer>()
        );
        Ok(Explorer {
            renderer,
            view: View::new(width, height),
            reference: ReferenceManager::default(),
            dirty: true,
        })
    }

    /// Jumps to a centre and magnification. Each coordinate is given as hi + lo
    /// (two f64s whose sum is the value), so deep-zoom positions keep ~106 bits.
    #[wasm_bindgen(js_name = setView)]
    pub fn set_view(&mut self, re: f64, re_lo: f64, im: f64, im_lo: f64, zoom: f64) {
        self.view
            .set_view(DD::from_sum(re, re_lo), DD::from_sum(im, im_lo), zoom);
        self.dirty = true;
    }

    /// Shows the Julia set for the constant c = re + im·i.
    #[wasm_bindgen(js_name = showJulia)]
    pub fn show_julia(&mut self, re: f64, im: f64) {
        dlog!(WASM, "showJulia({re}, {im})");
        self.view.julia_c = (re, im);
        self.view.mode = Mode::Julia;
        self.view.reset();
        self.dirty = true;
    }

    /// Prints adapter, limits, surface, shader and uniform state to the console.
    #[wasm_bindgen(js_name = dumpState)]
    pub fn dump_state(&self) {
        self.renderer.dump(&self.view.uniforms());
        debug::force_group(
            WASM,
            "View state (on the Rust side; centre in double-double)",
            &format!("{:#?}", self.view),
        );
        debug::force_group(
            WGPU,
            "Perturbation reference",
            &match self.reference.current() {
                Some(r) => format!(
                    "{r:#?}\noffset from view centre: {:?}",
                    self.reference.offset(&self.view)
                ),
                None => "none computed yet (Perturbation not in use)".to_string(),
            },
        );
    }

    /// Number of frames actually drawn since startup.
    #[wasm_bindgen(getter)]
    pub fn frames(&self) -> f64 {
        self.renderer.frames() as f64
    }

    /// Call after changing the canvas's backing size (device pixels).
    pub fn resize(&mut self, width: u32, height: u32) {
        dlog!(WASM, "resize({width}, {height})");
        self.renderer.resize(width, height);
        self.view.resize(width, height);
        self.dirty = true;
    }

    /// Draws a frame if anything changed since the last one. Returns true if it drew.
    pub fn render(&mut self) -> bool {
        if !self.dirty {
            return false;
        }
        let mut uniforms = self.view.uniforms();
        if self.view.effective_precision() == Precision::Perturbation {
            if let Some(orbit) = self.reference.update(&self.view) {
                self.renderer.upload_orbit(&orbit);
                if let Some(r) = self.reference.current() {
                    dlog!(
                        WGPU,
                        "Perturbation reference: {} orbit steps uploaded ({} KiB); survives {} of {} iterations; {} candidate(s) probed",
                        r.len,
                        r.len as usize * 16 / 1024,
                        r.survives,
                        self.view.max_iter,
                        r.probes
                    );
                }
            }
            let off = self.reference.offset(&self.view);
            uniforms.ref_off_re = off.re.to_f32_pair();
            uniforms.ref_off_im = off.im.to_f32_pair();
            uniforms.ref_len = self.reference.current().map_or(0, |r| r.len);
        }
        self.renderer.render(&uniforms);
        self.dirty = false;
        true
    }

    /// Forces the next `render()` to draw (e.g. for benchmarking).
    pub fn invalidate(&mut self) {
        self.dirty = true;
    }

    pub fn pan(&mut self, dx: f64, dy: f64) {
        self.view.pan(dx, dy);
        self.dirty = true;
    }

    #[wasm_bindgen(js_name = zoomAt)]
    pub fn zoom_at(&mut self, x: f64, y: f64, factor: f64) {
        self.view.zoom_at(x, y, factor);
        self.dirty = true;
    }

    pub fn reset(&mut self) {
        self.view.reset();
        self.dirty = true;
    }

    #[wasm_bindgen(setter, js_name = maxIterations)]
    pub fn set_max_iterations(&mut self, n: u32) {
        self.view.max_iter = n.clamp(16, MAX_ITERATIONS);
        self.dirty = true;
    }

    #[wasm_bindgen(getter, js_name = maxIterations)]
    pub fn max_iterations(&self) -> u32 {
        self.view.max_iter
    }

    #[wasm_bindgen(setter)]
    pub fn set_palette(&mut self, index: u32) {
        self.view.palette = index % 4;
        self.dirty = true;
    }

    #[wasm_bindgen(getter)]
    pub fn palette(&self) -> u32 {
        self.view.palette
    }

    /// Switches to the Julia set whose constant c is the point under (x, y).
    #[wasm_bindgen(js_name = juliaAt)]
    pub fn julia_at(&mut self, x: f64, y: f64) {
        self.view.julia_c = self.view.pixel_to_complex(x, y);
        self.view.mode = Mode::Julia;
        self.view.reset();
        self.dirty = true;
    }

    /// Iteration rule: 0 Mandelbrot, 1 Burning Ship, 2 Tricorn, 3 Multibrot.
    /// Changing it returns to the main set's home view.
    #[wasm_bindgen(setter)]
    pub fn set_formula(&mut self, index: u32) {
        let formula = Formula::from_index(index);
        dlog!(WASM, "formula = {formula:?}");
        if formula != self.view.formula {
            self.view.formula = formula;
            self.view.mode = Mode::Main;
            self.view.reset();
            self.dirty = true;
        }
    }

    #[wasm_bindgen(getter)]
    pub fn formula(&self) -> u32 {
        self.view.formula as u32
    }

    /// Multibrot exponent, clamped to 1.5–8. Keeps the current view.
    #[wasm_bindgen(setter)]
    pub fn set_power(&mut self, p: f64) {
        if p.is_finite() {
            self.view.power = p.clamp(view::MIN_POWER, view::MAX_POWER);
            self.dirty = true;
        }
    }

    #[wasm_bindgen(getter)]
    pub fn power(&self) -> f64 {
        self.view.power
    }

    /// Arithmetic: 0 fast (f32), 1 deep (double-float), 2 perturbation. Keeps the view.
    #[wasm_bindgen(setter)]
    pub fn set_precision(&mut self, p: u32) {
        self.view.precision = Precision::from_index(p);
        dlog!(
            WASM,
            "precision = {:?} (effective: {:?})",
            self.view.precision,
            self.view.effective_precision()
        );
        self.dirty = true;
    }

    /// What was requested (see `effectivePrecision` for what is actually in use).
    #[wasm_bindgen(getter)]
    pub fn precision(&self) -> u32 {
        self.view.precision as u32
    }

    /// What the shader is really using: 0 fast, 1 deep, 2 perturbation.
    #[wasm_bindgen(getter, js_name = effectivePrecision)]
    pub fn effective_precision(&self) -> u32 {
        self.view.effective_precision() as u32
    }

    /// True when the shader is iterating in double-float (Deep, or Perturbation's deltas).
    #[wasm_bindgen(getter, js_name = deepActive)]
    pub fn deep_active(&self) -> bool {
        self.view.effective_precision() != Precision::Fast
    }

    /// Why the requested precision isn't the one in use (empty if it is).
    #[wasm_bindgen(getter, js_name = precisionFallbackReason)]
    pub fn precision_fallback_reason(&self) -> String {
        self.view.fallback_reason().unwrap_or("").to_string()
    }

    /// Steps in the current perturbation reference orbit (0 if none).
    #[wasm_bindgen(getter, js_name = refLength)]
    pub fn ref_length(&self) -> u32 {
        self.reference.current().map_or(0, |r| r.len)
    }

    /// How many iterations the reference point survives before escaping.
    #[wasm_bindgen(getter, js_name = refSurvives)]
    pub fn ref_survives(&self) -> u32 {
        self.reference.current().map_or(0, |r| r.survives)
    }

    /// Whether the startup self-test found double-float working on this GPU.
    #[wasm_bindgen(getter, js_name = deepVerified)]
    pub fn deep_verified(&self) -> bool {
        self.renderer.selftest().passed
    }

    /// Bits of precision the self-test measured for double-float on this GPU.
    #[wasm_bindgen(getter, js_name = deepBits)]
    pub fn deep_bits(&self) -> f64 {
        self.renderer.selftest().bits
    }

    #[wasm_bindgen(getter, js_name = selfTestSummary)]
    pub fn self_test_summary(&self) -> String {
        self.renderer.selftest().summary.clone()
    }

    /// Latest GPU time per frame in ms, or -1 if unavailable or not measured yet.
    /// Also collects a pending measurement, so call it once per animation frame.
    #[wasm_bindgen(js_name = pollGpuTime)]
    pub fn poll_gpu_time(&mut self) -> f64 {
        self.renderer.gpu_time_ms().unwrap_or(-1.0)
    }

    #[wasm_bindgen(getter, js_name = hasGpuTimer)]
    pub fn has_gpu_timer(&self) -> bool {
        self.renderer.has_timer()
    }

    /// Leaves Julia mode and shows the main set for the current formula.
    #[wasm_bindgen(js_name = showMandelbrot)]
    pub fn show_mandelbrot(&mut self) {
        self.view.mode = Mode::Main;
        self.view.reset();
        self.dirty = true;
    }

    #[wasm_bindgen(getter, js_name = isJulia)]
    pub fn is_julia(&self) -> bool {
        self.view.mode == Mode::Julia
    }

    #[wasm_bindgen(getter, js_name = centerRe)]
    pub fn center_re(&self) -> f64 {
        self.view.center.re.hi
    }

    #[wasm_bindgen(getter, js_name = centerIm)]
    pub fn center_im(&self) -> f64 {
        self.view.center.im.hi
    }

    /// The part of the centre's real coordinate below f64 precision (hi + lo = value).
    #[wasm_bindgen(getter, js_name = centerReLo)]
    pub fn center_re_lo(&self) -> f64 {
        self.view.center.re.lo
    }

    #[wasm_bindgen(getter, js_name = centerImLo)]
    pub fn center_im_lo(&self) -> f64 {
        self.view.center.im.lo
    }

    /// The centre as decimal text with `digits` places, beyond f64's ~16.
    #[wasm_bindgen(js_name = centerText)]
    pub fn center_text(&self, digits: usize) -> Vec<String> {
        let digits = digits.min(34);
        vec![
            self.view.center.re.to_decimal(digits),
            self.view.center.im.to_decimal(digits),
        ]
    }

    #[wasm_bindgen(getter, js_name = juliaRe)]
    pub fn julia_re(&self) -> f64 {
        self.view.julia_c.0
    }

    #[wasm_bindgen(getter, js_name = juliaIm)]
    pub fn julia_im(&self) -> f64 {
        self.view.julia_c.1
    }

    #[wasm_bindgen(getter)]
    pub fn zoom(&self) -> f64 {
        self.view.zoom()
    }

    #[wasm_bindgen(getter, js_name = atPrecisionLimit)]
    pub fn at_precision_limit(&self) -> bool {
        self.view.at_precision_limit()
    }

    /// GPU name as reported by the browser (often blank or generic for privacy).
    #[wasm_bindgen(getter, js_name = adapterName)]
    pub fn adapter_name(&self) -> String {
        self.renderer.adapter_name()
    }

    /// Largest canvas side the device accepts, so JS can cap its backing size.
    #[wasm_bindgen(getter, js_name = maxDimension)]
    pub fn max_dimension(&self) -> u32 {
        self.renderer.max_dimension()
    }
}

#[cfg(target_arch = "wasm32")]
fn create_surface(
    instance: &wgpu::Instance,
    canvas: HtmlCanvasElement,
) -> Result<wgpu::Surface<'static>, JsValue> {
    instance
        .create_surface(wgpu::SurfaceTarget::Canvas(canvas))
        .map_err(|e| JsValue::from_str(&format!("Could not create WebGPU surface: {e}")))
}

// Canvas surfaces only exist on wasm32. This stub lets `cargo check` and
// `cargo test` run natively for the renderer and viewport code.
#[cfg(not(target_arch = "wasm32"))]
fn create_surface(
    _instance: &wgpu::Instance,
    _canvas: HtmlCanvasElement,
) -> Result<wgpu::Surface<'static>, JsValue> {
    Err(JsValue::from_str(
        "Build for wasm32-unknown-unknown to run in the browser",
    ))
}
