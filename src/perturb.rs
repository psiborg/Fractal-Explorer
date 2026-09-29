//! Perturbation theory on the CPU side: picks a reference point and computes its
//! orbit in double-double, which the shader then uses to iterate each pixel's
//! (tiny) difference from it in double-float.
//!
//! Validated against 220-bit direct iteration (mpmath) at 10²⁰–10²⁵× zoom:
//! Mandelbrot and Tricorn agree on ~99.5–100% of pixels, integer Multibrot on
//! ~97–99%. The Burning Ship's abs() folds break single-reference perturbation,
//! so it isn't offered (see `View::perturbation_unavailable_reason`).

use crate::dd::{Cdd, DD};
use crate::view::{Formula, View};

/// |z|² above which an orbit has escaped. Matches BAILOUT_SQ in the shader.
pub const BAILOUT_SQ: f64 = 65536.0;

/// Candidates per side when probing for a good reference, and refinement levels.
const GRID: usize = 8;
const LEVELS: usize = 2;
/// Total double-double iterations the probe may spend (~30–60 ms in WebAssembly),
/// so a high iteration limit can't stall the page while a reference is chosen.
const PROBE_BUDGET: u64 = 4_000_000;

/// One step z → f(z) + c for the formulas that support perturbation.
#[inline]
fn step(z: Cdd, c: Cdd, formula: Formula, power: u32) -> Cdd {
    match formula {
        Formula::Tricorn => Cdd {
            re: z.re.sqr() - z.im.sqr() + c.re,
            im: c.im - (z.re * z.im).mul_f64(2.0),
        },
        Formula::BurningShip => {
            let (ax, ay) = (z.re.abs(), z.im.abs());
            Cdd {
                re: ax.sqr() - ay.sqr() + c.re,
                im: c.im - (ax * ay).mul_f64(2.0),
            }
        }
        Formula::Multibrot => {
            let mut w = z;
            for _ in 1..power.max(2) {
                w = Cdd {
                    re: w.re * z.re - w.im * z.im,
                    im: w.re * z.im + w.im * z.re,
                };
            }
            Cdd {
                re: w.re + c.re,
                im: w.im + c.im,
            }
        }
        Formula::Mandelbrot => Cdd {
            re: z.re.sqr() - z.im.sqr() + c.re,
            im: (z.re * z.im).mul_f64(2.0) + c.im,
        },
    }
}

#[inline]
fn mag_sq(z: Cdd) -> f64 {
    z.re.hi * z.re.hi + z.im.hi * z.im.hi
}

/// Steps before c's orbit escapes (max_iter if it never does), iterated in double-double.
pub fn escape_time(c: Cdd, formula: Formula, power: u32, max_iter: u32) -> u32 {
    let mut z = Cdd::default();
    for n in 0..max_iter {
        z = step(z, c, formula, power);
        if mag_sq(z) > BAILOUT_SQ {
            return n + 1;
        }
    }
    max_iter
}

/// Picks a reference point for the view: the centre if its orbit survives all
/// iterations, otherwise the longest-surviving point on a grid over the view,
/// refined once around the best. A reference that escapes before the pixels
/// do forces early rebasing, which loses precision (see the module docs).
///
/// Returns the point, how long it survives, and how many candidates were tried.
pub fn choose_reference(
    centre: Cdd,
    span_re: f64,
    span_im: f64,
    formula: Formula,
    power: u32,
    max_iter: u32,
) -> (Cdd, u32, u32) {
    let mut best = centre;
    let mut best_n = escape_time(centre, formula, power, max_iter);
    let mut probes = 1;
    let mut spent = best_n as u64;
    let (mut origin, mut sx, mut sy) = (centre, span_re, span_im);
    for _ in 0..LEVELS {
        if best_n >= max_iter {
            break;
        }
        'grid: for i in 0..GRID {
            for j in 0..GRID {
                let fx = ((i as f64 + 0.5) / GRID as f64) - 0.5;
                let fy = ((j as f64 + 0.5) / GRID as f64) - 0.5;
                let p = Cdd::new(origin.re + DD::new(fx * sx), origin.im + DD::new(fy * sy));
                let n = escape_time(p, formula, power, max_iter);
                probes += 1;
                spent += n as u64;
                if n > best_n {
                    best = p;
                    best_n = n;
                    if n >= max_iter {
                        break 'grid;
                    }
                }
                if spent > PROBE_BUDGET {
                    break 'grid;
                }
            }
        }
        origin = best;
        sx /= GRID as f64;
        sy /= GRID as f64;
    }
    (best, best_n, probes)
}

/// The reference orbit Z₀ = 0, Z₁, … up to and including the step where it
/// escapes (or max_iter). Each entry is [re_hi, re_lo, im_hi, im_lo] as f32,
/// matching `array<vec4<f32>>` in the shader.
pub fn reference_orbit(c: Cdd, formula: Formula, power: u32, max_iter: u32) -> Vec<[f32; 4]> {
    let mut out = Vec::with_capacity(max_iter as usize + 1);
    let mut z = Cdd::default();
    out.push([0.0; 4]);
    for _ in 0..max_iter {
        z = step(z, c, formula, power);
        let [rh, rl] = z.re.to_f32_pair();
        let [ih, il] = z.im.to_f32_pair();
        out.push([rh, rl, ih, il]);
        if mag_sq(z) > BAILOUT_SQ {
            break;
        }
    }
    out
}

/// The reference currently on the GPU, and what it was computed for.
#[derive(Clone, Debug)]
pub struct Reference {
    pub point: Cdd,
    pub len: u32,
    pub survives: u32,
    pub probes: u32,
    formula: Formula,
    power: u32,
    max_iter: u32,
    scale: f64,
}

/// Decides when the reference orbit must be recomputed. Recomputing costs a few
/// milliseconds (more when probing for a better point), so it's kept while it
/// stays usable: same formula and iterations, and within a screen of the view.
#[derive(Default)]
pub struct ReferenceManager {
    current: Option<Reference>,
}

impl ReferenceManager {
    /// Returns a fresh orbit to upload if the reference had to change.
    pub fn update(&mut self, view: &View) -> Option<Vec<[f32; 4]>> {
        let span_re = view.scale * view.width as f64;
        let span_im = view.scale * view.height as f64;
        let power = view.power.round().max(2.0) as u32;
        let stale = match &self.current {
            None => true,
            Some(r) => {
                let off = self.offset_from(r, view);
                let distance = off.re.to_f64().hypot(off.im.to_f64());
                r.formula != view.formula
                    || r.power != power
                    || r.max_iter != view.max_iter
                    // Too far away: pixel offsets would swamp f32 precision.
                    || distance > span_re.max(span_im)
                    // Escaped early and we've zoomed in a lot: look for a better one.
                    || (r.survives < r.max_iter && r.scale / view.scale > 4.0)
            }
        };
        if !stale {
            return None;
        }
        let (point, survives, probes) = choose_reference(
            view.center,
            span_re,
            span_im,
            view.formula,
            power,
            view.max_iter,
        );
        let orbit = reference_orbit(point, view.formula, power, view.max_iter);
        self.current = Some(Reference {
            point,
            len: orbit.len() as u32,
            survives,
            probes,
            formula: view.formula,
            power,
            max_iter: view.max_iter,
            scale: view.scale,
        });
        Some(orbit)
    }

    pub fn current(&self) -> Option<&Reference> {
        self.current.as_ref()
    }

    /// View centre minus the reference point.
    pub fn offset(&self, view: &View) -> Cdd {
        self.current
            .as_ref()
            .map(|r| self.offset_from(r, view))
            .unwrap_or_default()
    }

    fn offset_from(&self, r: &Reference, view: &View) -> Cdd {
        Cdd::new(view.center.re - r.point.re, view.center.im - r.point.im)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(re: f64, im: f64) -> Cdd {
        Cdd::new(DD::new(re), DD::new(im))
    }

    #[test]
    fn escape_time_matches_plain_f64_at_shallow_depth() {
        let f64_escape = |cx: f64, cy: f64| {
            let (mut x, mut y) = (0.0f64, 0.0f64);
            for n in 0..500 {
                let nx = x * x - y * y + cx;
                y = 2.0 * x * y + cy;
                x = nx;
                if x * x + y * y > BAILOUT_SQ {
                    return n + 1;
                }
            }
            500
        };
        for (cx, cy) in [(-0.75, 0.1), (0.3, 0.5), (-1.25, 0.02), (-0.1, 0.65)] {
            assert_eq!(
                escape_time(c(cx, cy), Formula::Mandelbrot, 2, 500),
                f64_escape(cx, cy)
            );
        }
        assert_eq!(escape_time(c(0.0, 0.0), Formula::Mandelbrot, 2, 500), 500);
    }

    #[test]
    fn deep_orbit_matches_high_precision_values() {
        // Reference values from 220-bit mpmath for
        // c = -0.743643887037158704752191506114774 + 0.131825904205311970493132056385139i.
        let centre = Cdd::new(
            DD::from_sum(-0.743_643_887_037_158_7, -3.628_952_515_063_387e-17),
            DD::from_sum(0.131_825_904_205_311_98, -1.289_280_775_495_667_5e-17),
        );
        let orbit = reference_orbit(centre, Formula::Mandelbrot, 2, 200);
        assert_eq!(orbit.len(), 201, "this point stays bounded for 200 steps");
        // Z₁ = c exactly; Z₂ = c² + c.
        let z1 = orbit[1];
        assert!((z1[0] as f64 + z1[1] as f64 - (-0.743_643_887_037_158_7)).abs() < 1e-14);
        let (cx, cy) = (-0.743_643_887_037_158_7f64, 0.131_825_904_205_311_98f64);
        let z2 = orbit[2];
        let want = (cx * cx - cy * cy + cx, 2.0 * cx * cy + cy);
        assert!((z2[0] as f64 + z2[1] as f64 - want.0).abs() < 1e-13);
        assert!((z2[2] as f64 + z2[3] as f64 - want.1).abs() < 1e-13);
        // Later steps, against mpmath (the f32 pair holds ~48 bits, so ~1e-14).
        for (n, re, im) in [
            (50, -0.616_010_857_554_749_4, 0.256_407_710_706_614_8),
            (150, -0.259_116_055_344_438_93, -0.421_548_210_031_161_4),
        ] {
            let z = orbit[n];
            assert!((z[0] as f64 + z[1] as f64 - re).abs() < 1e-12, "Z{n}.re");
            assert!((z[2] as f64 + z[3] as f64 - im).abs() < 1e-12, "Z{n}.im");
        }
    }

    #[test]
    fn reference_prefers_points_that_survive() {
        // A view centred just outside the main cardioid: the centre escapes, but
        // the grid finds a point inside the set.
        let centre = c(0.26, 0.0);
        let before = escape_time(centre, Formula::Mandelbrot, 2, 1000);
        assert!(before < 1000);
        let (reference, survives, probes) =
            choose_reference(centre, 0.05, 0.05, Formula::Mandelbrot, 2, 1000);
        assert!(survives > before);
        assert!(probes > 1);
        assert!((reference.re.to_f64() - 0.26).abs() <= 0.025);
    }

    #[test]
    fn manager_reuses_the_reference_until_it_must_change() {
        let mut view = View::new(800, 600);
        view.set_view(DD::new(-0.75), DD::new(0.1), 1e6);
        view.max_iter = 400;
        let mut m = ReferenceManager::default();
        assert!(m.update(&view).is_some(), "first call computes");
        assert!(m.update(&view).is_none(), "unchanged view reuses it");
        view.pan(30.0, 0.0);
        assert!(m.update(&view).is_none(), "small pan reuses it");
        let off = m.offset(&view);
        assert!((off.re.to_f64() + 30.0 * view.scale).abs() < view.scale * 1e-6);
        view.pan(5000.0, 0.0);
        assert!(
            m.update(&view).is_some(),
            "moving several screens away recomputes"
        );
        view.max_iter = 500;
        assert!(m.update(&view).is_some(), "changing iterations recomputes");
        view.formula = Formula::Tricorn;
        assert!(m.update(&view).is_some(), "changing formula recomputes");
    }

    #[test]
    fn orbit_stops_where_the_reference_escapes() {
        let orbit = reference_orbit(c(2.0, 2.0), Formula::Mandelbrot, 2, 100);
        assert!(orbit.len() < 10);
        let last = orbit[orbit.len() - 1];
        assert!((last[0] as f64).powi(2) + (last[2] as f64).powi(2) > BAILOUT_SQ);
    }
}
