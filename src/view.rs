//! Viewport math for the explorer: where the camera sits on the complex plane
//! and how pixels map onto it. Kept free of GPU and browser types so it can be
//! unit-tested natively with `cargo test`.
//!
//! The centre is double-double (~106 bits): past ~10¹⁵× zoom a single f64 can't
//! even represent the centre precisely enough to pan by one pixel.

use crate::dd::{Cdd, DD};

/// Complex-plane units per pixel when the whole set fits in a ~900 px tall view.
const HOME_SPAN: f64 = 3.0;

/// Which plane is shown: the main set (each pixel is c, z starts at 0) or a
/// Julia set (c is fixed, each pixel is the starting z).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Mode {
    Main,
    Julia,
}

/// The iteration rule. Values match the `formula` switch in `fractal.wgsl`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Formula {
    /// z → z² + c
    Mandelbrot = 0,
    /// z → (|Re z| − i|Im z|)² + c, mirrored so the ship sits upright
    BurningShip = 1,
    /// z → conj(z)² + c (the "Mandelbar")
    Tricorn = 2,
    /// z → zᵖ + c for any real power p
    Multibrot = 3,
}

impl Formula {
    pub fn from_index(i: u32) -> Self {
        match i {
            1 => Formula::BurningShip,
            2 => Formula::Tricorn,
            3 => Formula::Multibrot,
            _ => Formula::Mandelbrot,
        }
    }

    /// Where the home view is centred so the whole set is framed.
    fn home(self) -> (f64, f64) {
        match self {
            Formula::Mandelbrot => (-0.6, 0.0),
            Formula::BurningShip => (-0.5, 0.5),
            Formula::Tricorn => (-0.3, 0.0),
            Formula::Multibrot => (0.0, 0.0),
        }
    }
}

/// Arithmetic used by the shader. Values match `arith` in `fractal.wgsl`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Precision {
    /// Plain f32: ~24 bits, pixelates past ~10⁵× zoom.
    Fast = 0,
    /// Double-float (pairs of f32): ~48 bits, ~10–20× more work per iteration.
    Deep = 1,
    /// Perturbation: a double-double reference orbit from the CPU, and each
    /// pixel's difference from it in double-float. Sharp to ~10²⁸×.
    Perturbation = 2,
}

impl Precision {
    pub fn from_index(i: u32) -> Self {
        match i {
            1 => Precision::Deep,
            2 => Precision::Perturbation,
            _ => Precision::Fast,
        }
    }
}

/// Splits an f64 into an f32 plus the f32 closest to what's left over, so the
/// shader can rebuild ~48 of the 53 bits as hi + lo.
pub fn split_f64(x: f64) -> (f32, f32) {
    let hi = x as f32;
    (hi, (x - hi as f64) as f32)
}

pub const MIN_POWER: f64 = 1.5;
pub const MAX_POWER: f64 = 8.0;

#[derive(Clone, Debug)]
pub struct View {
    /// Complex-plane coordinate at the centre of the canvas, in double-double.
    pub center: Cdd,
    /// Complex-plane units per device pixel.
    pub scale: f64,
    /// Scale at "home", used to report the zoom factor.
    home_scale: f64,
    pub width: u32,
    pub height: u32,
    pub max_iter: u32,
    pub palette: u32,
    pub mode: Mode,
    pub julia_c: (f64, f64),
    pub formula: Formula,
    /// Exponent for Multibrot (ignored by the other formulas).
    pub power: f64,
    /// What the user asked for; see `effective_precision` for what is used.
    pub precision: Precision,
}

impl View {
    pub fn new(width: u32, height: u32) -> Self {
        let mut view = View {
            center: Cdd::default(),
            scale: 1.0,
            home_scale: 1.0,
            width: width.max(1),
            height: height.max(1),
            max_iter: 500,
            palette: 0,
            mode: Mode::Main,
            julia_c: (-0.8, 0.156),
            formula: Formula::Mandelbrot,
            power: 3.0,
            precision: Precision::Fast,
        };
        view.reset();
        view
    }

    /// Frames the whole set for the current formula and mode.
    pub fn reset(&mut self) {
        let (re, im) = match self.mode {
            Mode::Main => self.formula.home(),
            Mode::Julia => (0.0, 0.0),
        };
        self.center = Cdd::from_f64(re, im);
        let fit = HOME_SPAN / (self.width.min(self.height) as f64);
        self.scale = fit;
        self.home_scale = fit;
    }

    /// Keeps the same region visible when the canvas changes size.
    pub fn resize(&mut self, width: u32, height: u32) {
        let (width, height) = (width.max(1), height.max(1));
        let ratio = self.width.min(self.height) as f64 / width.min(height) as f64;
        self.scale *= ratio;
        self.home_scale *= ratio;
        self.width = width;
        self.height = height;
    }

    /// The centre rounded to f64, for display and for code that doesn't need depth.
    pub fn center_f64(&self) -> (f64, f64) {
        (self.center.re.to_f64(), self.center.im.to_f64())
    }

    /// Converts a device-pixel position (origin top-left, y down) to a complex
    /// coordinate, rounded to f64.
    pub fn pixel_to_complex(&self, x: f64, y: f64) -> (f64, f64) {
        let (dx, dy) = self.pixel_offset(x, y);
        (
            (self.center.re + DD::new(dx)).to_f64(),
            (self.center.im + DD::new(dy)).to_f64(),
        )
    }

    /// Complex-plane offset of a pixel from the centre (y flipped: up is +im).
    fn pixel_offset(&self, x: f64, y: f64) -> (f64, f64) {
        (
            (x - self.width as f64 * 0.5) * self.scale,
            -(y - self.height as f64 * 0.5) * self.scale,
        )
    }

    /// Drags the image by a pixel delta (the point under the cursor follows it).
    pub fn pan(&mut self, dx: f64, dy: f64) {
        self.center.re = self.center.re - DD::new(dx * self.scale);
        self.center.im = self.center.im + DD::new(dy * self.scale);
    }

    /// Zooms by `factor` (>1 zooms in) while keeping the point under (x, y) fixed.
    pub fn zoom_at(&mut self, x: f64, y: f64, factor: f64) {
        if !factor.is_finite() || factor <= 0.0 {
            return;
        }
        let before = self.pixel_offset(x, y);
        self.scale /= factor;
        let after = self.pixel_offset(x, y);
        // The difference is small and exact enough in f64; the DD centre keeps the depth.
        self.center.re = self.center.re + DD::new(before.0 - after.0);
        self.center.im = self.center.im + DD::new(before.1 - after.1);
    }

    /// Magnification relative to the home view.
    pub fn zoom(&self) -> f64 {
        self.home_scale / self.scale
    }

    /// Jumps straight to a centre and magnification. The centre arrives as
    /// hi + lo pairs so deep-zoom positions survive the trip from JavaScript.
    pub fn set_view(&mut self, re: DD, im: DD, zoom: f64) {
        if re.is_finite() && im.is_finite() {
            self.center = Cdd::new(re, im);
        }
        if zoom.is_finite() && zoom > 0.0 {
            self.scale = self.home_scale / zoom;
        }
    }

    fn fractional_power(&self) -> bool {
        self.formula == Formula::Multibrot && (self.power - self.power.round()).abs() > 1e-9
    }

    /// Why Deep can't be used right now, if it can't.
    pub fn deep_unavailable_reason(&self) -> Option<&'static str> {
        self.fractional_power().then_some(
            "fractional Multibrot powers need pow/atan2, which have no double-float version",
        )
    }

    /// Why Perturbation can't be used right now, if it can't.
    pub fn perturbation_unavailable_reason(&self) -> Option<&'static str> {
        if self.mode == Mode::Julia {
            Some(
                "Julia sets would need a second reference orbit, so perturbation covers the main sets only",
            )
        } else if self.formula == Formula::BurningShip {
            Some("the Burning Ship's abs() folds make a single reference orbit unreliable")
        } else if self.fractional_power() {
            self.deep_unavailable_reason()
        } else {
            None
        }
    }

    /// What the shader will actually use: the requested precision if possible,
    /// otherwise the best one that is.
    pub fn effective_precision(&self) -> Precision {
        let deep_ok = self.deep_unavailable_reason().is_none();
        match self.precision {
            Precision::Perturbation if self.perturbation_unavailable_reason().is_none() => {
                Precision::Perturbation
            }
            Precision::Perturbation | Precision::Deep if deep_ok => Precision::Deep,
            _ => Precision::Fast,
        }
    }

    /// Why the requested precision isn't the one in use (None if it is).
    pub fn fallback_reason(&self) -> Option<&'static str> {
        if self.effective_precision() == self.precision {
            return None;
        }
        match self.precision {
            Precision::Perturbation => self.perturbation_unavailable_reason(),
            Precision::Deep => self.deep_unavailable_reason(),
            Precision::Fast => None,
        }
    }

    /// Past this zoom the arithmetic runs out and the image turns blocky:
    /// ~10⁵× for f32, ~10¹¹× for double-float, ~10²⁸× for perturbation (limited
    /// by the double-double centre and reference, and f32's exponent range).
    pub fn at_precision_limit(&self) -> bool {
        let (re, im) = self.center_f64();
        let magnitude = re.abs().max(im.abs()).max(1.0);
        match self.effective_precision() {
            Precision::Fast => self.scale < magnitude * f32::EPSILON as f64,
            Precision::Deep => self.scale < magnitude * 2f64.powi(-44),
            Precision::Perturbation => {
                self.scale < magnitude * 2f64.powi(-100) || self.scale < 1e-36
            }
        }
    }

    /// Uniforms for this view. The perturbation fields (reference offset and
    /// orbit length) are filled in by the caller that owns the reference.
    pub fn uniforms(&self) -> Uniforms {
        let (jx, jx_lo) = split_f64(self.julia_c.0);
        let (jy, jy_lo) = split_f64(self.julia_c.1);
        let (scale_hi, scale_lo) = split_f64(self.scale);
        let [cx, cx_lo] = self.center.re.to_f32_pair();
        let [cy, cy_lo] = self.center.im.to_f32_pair();
        Uniforms {
            center_hi: [cx, cy],
            center_lo: [cx_lo, cy_lo],
            resolution: [self.width as f32, self.height as f32],
            julia_hi: [jx, jy],
            julia_lo: [jx_lo, jy_lo],
            scale_hi,
            scale_lo,
            max_iter: self.max_iter,
            palette: self.palette,
            mode: match self.mode {
                Mode::Main => 0,
                Mode::Julia => 1,
            },
            formula: self.formula as u32,
            power: self.power as f32,
            arith: self.effective_precision() as u32,
            ref_off_re: [0.0; 2],
            ref_off_im: [0.0; 2],
            ref_len: 0,
            _pad: 0,
        }
    }
}

/// Mirrors `struct Params` in `shaders/fractal.wgsl` byte-for-byte.
#[repr(C)]
#[derive(Clone, Copy, Debug, bytemuck::Pod, bytemuck::Zeroable)]
pub struct Uniforms {
    pub center_hi: [f32; 2],
    pub center_lo: [f32; 2],
    pub resolution: [f32; 2],
    pub julia_hi: [f32; 2],
    pub julia_lo: [f32; 2],
    pub scale_hi: f32,
    pub scale_lo: f32,
    pub max_iter: u32,
    pub palette: u32,
    pub mode: u32,
    pub formula: u32,
    pub power: f32,
    /// 0 fast, 1 deep, 2 perturbation (not `precision`: that's a WGSL keyword).
    pub arith: u32,
    /// View centre minus the reference point, as double-float (hi, lo) pairs.
    pub ref_off_re: [f32; 2],
    pub ref_off_im: [f32; 2],
    /// Entries in the reference orbit buffer.
    pub ref_len: u32,
    pub _pad: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uniforms_match_wgsl_layout() {
        assert_eq!(std::mem::size_of::<Uniforms>(), 96);
    }

    #[test]
    fn zoom_keeps_point_under_cursor() {
        let mut v = View::new(800, 600);
        let target = v.pixel_to_complex(123.0, 456.0);
        v.zoom_at(123.0, 456.0, 3.7);
        let after = v.pixel_to_complex(123.0, 456.0);
        assert!((target.0 - after.0).abs() < 1e-12);
        assert!((target.1 - after.1).abs() < 1e-12);
        assert!((v.zoom() - 3.7).abs() < 1e-9);
    }

    #[test]
    fn pan_moves_content_with_pointer() {
        let mut v = View::new(800, 600);
        let p = v.pixel_to_complex(100.0, 100.0);
        v.pan(50.0, -20.0);
        let q = v.pixel_to_complex(150.0, 80.0);
        assert!((p.0 - q.0).abs() < 1e-12 && (p.1 - q.1).abs() < 1e-12);
    }

    #[test]
    fn deep_pan_and_zoom_keep_precision() {
        // At 10²⁰× one pixel is ~10⁻²³: far below f64's resolution near 0.74.
        let mut v = View::new(1000, 1000);
        let start = Cdd::new(
            DD::from_sum(-0.743_643_887_037_158_7, -3.6e-17),
            DD::new(0.131_825_904_205_311_98),
        );
        v.set_view(start.re, start.im, 1e20);
        v.pan(10.0, 0.0);
        let moved = (start.re - v.center.re).to_f64();
        assert!(
            (moved - 10.0 * v.scale).abs() < v.scale * 1e-6,
            "panned by 10 px: {moved:e}"
        );
        v.pan(-10.0, 0.0);
        assert!((v.center.re - start.re).to_f64().abs() < v.scale * 1e-6);
        // Zooming at a corner keeps that point fixed to within a tiny fraction of a pixel.
        let corner = (v.center.re + DD::new(-500.0 * v.scale)).to_f64();
        v.zoom_at(0.0, 500.0, 4.0);
        let corner_after = (v.center.re + DD::new(-500.0 * v.scale)).to_f64();
        assert!((corner - corner_after).abs() < 1e-30);
    }

    #[test]
    fn set_view_round_trips() {
        let mut v = View::new(800, 600);
        v.set_view(DD::new(-0.745), DD::new(0.113), 250.0);
        assert_eq!(v.center_f64(), (-0.745, 0.113));
        assert!((v.zoom() - 250.0).abs() < 1e-9);
        v.set_view(DD::new(f64::NAN), DD::new(0.0), -1.0); // ignored
        assert!((v.zoom() - 250.0).abs() < 1e-9);
    }

    #[test]
    fn each_formula_has_its_own_home() {
        let mut v = View::new(800, 600);
        v.formula = Formula::BurningShip;
        v.reset();
        assert_eq!(v.center_f64(), (-0.5, 0.5));
        assert_eq!(v.uniforms().formula, 1);
        v.mode = Mode::Julia;
        v.reset();
        assert_eq!(v.center_f64(), (0.0, 0.0));
        assert_eq!(Formula::from_index(99), Formula::Mandelbrot);
    }

    #[test]
    fn split_keeps_far_more_than_f32() {
        let x = -0.743_643_887_037_151_f64;
        let (hi, lo) = split_f64(x);
        let rebuilt = hi as f64 + lo as f64;
        assert!(((rebuilt - x) / x).abs() < 1e-14);
        assert!(((hi as f64 - x) / x).abs() > 1e-10); // hi alone is only f32-accurate
    }

    #[test]
    fn deep_falls_back_for_fractional_multibrot() {
        let mut v = View::new(800, 600);
        v.precision = Precision::Deep;
        assert_eq!(v.effective_precision(), Precision::Deep);
        v.formula = Formula::Multibrot;
        v.power = 3.0;
        assert_eq!(v.uniforms().arith, 1);
        v.power = 3.5;
        assert_eq!(v.effective_precision(), Precision::Fast);
        assert!(v.deep_unavailable_reason().is_some());
    }

    #[test]
    fn perturbation_falls_back_where_it_is_unreliable() {
        let mut v = View::new(800, 600);
        v.precision = Precision::Perturbation;
        assert_eq!(v.effective_precision(), Precision::Perturbation);
        assert!(v.fallback_reason().is_none());
        v.formula = Formula::Tricorn;
        assert_eq!(v.effective_precision(), Precision::Perturbation);
        v.formula = Formula::BurningShip;
        assert_eq!(v.effective_precision(), Precision::Deep);
        assert!(v.fallback_reason().unwrap().contains("Burning Ship"));
        v.formula = Formula::Mandelbrot;
        v.mode = Mode::Julia;
        assert_eq!(v.effective_precision(), Precision::Deep);
        v.mode = Mode::Main;
        v.formula = Formula::Multibrot;
        v.power = 4.0;
        assert_eq!(v.effective_precision(), Precision::Perturbation);
        v.power = 4.5;
        assert_eq!(v.effective_precision(), Precision::Fast);
        assert_eq!(Precision::from_index(2), Precision::Perturbation);
    }

    #[test]
    fn each_precision_moves_the_wall() {
        let mut v = View::new(1000, 1000);
        let (re, im) = (DD::new(-0.7436), DD::new(0.1318));
        v.set_view(re, im, 1e6);
        assert!(v.at_precision_limit());
        v.precision = Precision::Deep;
        assert!(!v.at_precision_limit());
        v.set_view(re, im, 1e13);
        assert!(v.at_precision_limit());
        v.precision = Precision::Perturbation;
        assert!(!v.at_precision_limit());
        v.set_view(re, im, 1e25);
        assert!(!v.at_precision_limit());
        v.set_view(re, im, 1e31);
        assert!(v.at_precision_limit());
    }

    #[test]
    fn resize_preserves_zoom() {
        let mut v = View::new(800, 600);
        v.zoom_at(400.0, 300.0, 10.0);
        v.resize(1600, 1200);
        assert!((v.zoom() - 10.0).abs() < 1e-9);
    }
}
