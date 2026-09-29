// Escape-time fractal fragment shader: Mandelbrot, Burning Ship, Tricorn and
// Multibrot, each in main-set or Julia mode. One full-screen triangle; every
// pixel iterates its formula independently.
//
// Three kinds of arithmetic (params.arith):
//   0 fast: plain f32.
//   1 deep: double-float (see df.wgsl, prepended to this file), using the lo
//     halves of the centre, scale and Julia constant that the fast path ignores.
//   2 perturbation: the CPU computes one reference orbit in double-double; each
//     pixel iterates only its difference from it, in double-float, rebasing to
//     the start of the reference when that difference stops being small
//     (Zhuoran, 2021). Main sets of Mandelbrot, Tricorn and integer Multibrot.

struct Params {
    center_hi: vec2<f32>,   // complex coordinate at canvas centre (hi part)
    center_lo: vec2<f32>,   // ...and the rounding error hi couldn't hold
    resolution: vec2<f32>,  // canvas size in device pixels
    julia_hi: vec2<f32>,    // constant c for Julia mode
    julia_lo: vec2<f32>,
    scale_hi: f32,          // complex units per pixel
    scale_lo: f32,
    max_iter: u32,
    palette: u32,
    mode: u32,              // 0 = main set (pixel is c), 1 = Julia (pixel is z0)
    formula: u32,           // 0 Mandelbrot, 1 Burning Ship, 2 Tricorn, 3 Multibrot
    power: f32,             // Multibrot exponent
    arith: u32,             // 0 fast, 1 deep, 2 perturbation ("precision" is a WGSL keyword)
    ref_off_re: vec2<f32>,  // view centre minus reference point, double-float
    ref_off_im: vec2<f32>,
    ref_len: u32,           // entries in ref_orbit
    _pad: u32,
};

struct Escape {
    n: u32,        // iterations before escaping (max_iter if it never did)
    mag_sq: f32,   // |z|² at escape, for smooth colouring
};

@group(0) @binding(0) var<uniform> params: Params;
// Reference orbit Z₀ = 0, Z₁, … as (re_hi, re_lo, im_hi, im_lo).
@group(0) @binding(1) var<storage, read> ref_orbit: array<vec4<f32>>;

@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    // Oversized triangle covering the viewport: (-1,-1), (3,-1), (-1,3).
    let x = f32((i << 1u) & 2u) * 2.0 - 1.0;
    let y = f32(i & 2u) * 2.0 - 1.0;
    return vec4<f32>(x, y, 0.0, 1.0);
}

const TAU: f32 = 6.28318530718;
const BAILOUT_SQ: f32 = 65536.0; // large radius gives smoother banding

// Inigo Quilez cosine palettes: a + b * cos(2π(c·t + d)).
fn palette(t: f32, which: u32) -> vec3<f32> {
    var a = vec3<f32>(0.5, 0.5, 0.5);
    var b = vec3<f32>(0.5, 0.5, 0.5);
    var c = vec3<f32>(1.0, 1.0, 1.0);
    var d = vec3<f32>(0.0, 0.10, 0.20);
    switch which {
        case 1u: { // phosphor green
            a = vec3<f32>(0.25, 0.60, 0.30); b = vec3<f32>(0.25, 0.40, 0.25);
            c = vec3<f32>(1.0, 1.0, 1.0);    d = vec3<f32>(0.50, 0.50, 0.50);
        }
        case 2u: { // amber
            a = vec3<f32>(0.60, 0.40, 0.12); b = vec3<f32>(0.40, 0.30, 0.10);
            c = vec3<f32>(1.0, 1.0, 1.0);    d = vec3<f32>(0.50, 0.52, 0.55);
        }
        case 3u: { // fire
            a = vec3<f32>(0.5, 0.3, 0.2);    b = vec3<f32>(0.5, 0.4, 0.3);
            c = vec3<f32>(1.0, 1.0, 0.5);    d = vec3<f32>(0.0, 0.15, 0.25);
        }
        default: { // classic ocean-to-gold
            a = vec3<f32>(0.5, 0.5, 0.5);    b = vec3<f32>(0.5, 0.5, 0.5);
            c = vec3<f32>(1.0, 1.0, 1.0);    d = vec3<f32>(0.00, 0.10, 0.20);
        }
    }
    return a + b * cos(TAU * (c * t + d));
}

// Cheap early-out for the main cardioid and period-2 bulb (Mandelbrot only).
fn in_main_body(c: vec2<f32>) -> bool {
    let q = (c.x - 0.25) * (c.x - 0.25) + c.y * c.y;
    let cardioid = q * (q + (c.x - 0.25)) <= 0.25 * c.y * c.y;
    let bulb = (c.x + 1.0) * (c.x + 1.0) + c.y * c.y <= 0.0625;
    return cardioid || bulb;
}

// One step of the selected formula: returns the next z.
fn iterate(z: vec2<f32>, c: vec2<f32>) -> vec2<f32> {
    switch params.formula {
        case 1u: {
            // Burning Ship: fold z into one quadrant before squaring. The imaginary
            // part is negated (a mirror image of the textbook formula) so the ship
            // sits upright with +im pointing up, and the HUD coordinates stay honest.
            let a = abs(z);
            return vec2<f32>(a.x * a.x - a.y * a.y, -2.0 * a.x * a.y) + c;
        }
        case 2u: {
            // Tricorn: square the complex conjugate of z.
            return vec2<f32>(z.x * z.x - z.y * z.y, -2.0 * z.x * z.y) + c;
        }
        case 3u: {
            // Multibrot: z^p in polar form, so any real power works.
            let r2 = dot(z, z);
            if r2 == 0.0 { return c; }
            let r = pow(r2, 0.5 * params.power);
            let theta = atan2(z.y, z.x) * params.power;
            return r * vec2<f32>(cos(theta), sin(theta)) + c;
        }
        default: {
            return vec2<f32>(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
        }
    }
}

// ---------------------------------------------------------------- fast path (f32)

fn escape_fast(d: vec2<f32>) -> Escape {
    let offset = d * params.scale_hi;
    let p = params.center_hi + vec2<f32>(offset.x, -offset.y);

    var z: vec2<f32>;
    var c: vec2<f32>;
    if params.mode == 1u {
        z = p;
        c = params.julia_hi;
    } else {
        if params.formula == 0u && in_main_body(p) {
            return Escape(params.max_iter, 0.0);
        }
        z = vec2<f32>(0.0, 0.0);
        c = p;
    }

    var n: u32 = 0u;
    var mag_sq = dot(z, z);
    loop {
        if n >= params.max_iter || mag_sq > BAILOUT_SQ { break; }
        z = iterate(z, c);
        mag_sq = dot(z, z);
        n = n + 1u;
    }
    return Escape(n, mag_sq);
}

// ---------------------------------------------------------------- deep path (double-float)

fn iterate_df(z: DfComplex, c: DfComplex) -> DfComplex {
    switch params.formula {
        case 1u: {
            // Burning Ship (mirrored, as in iterate()).
            let ax = df_abs(z.re);
            let ay = df_abs(z.im);
            return DfComplex(
                df_add(df_sub(df_sqr(ax), df_sqr(ay)), c.re),
                df_sub(c.im, df_mul2(df_mul(ax, ay))),
            );
        }
        case 2u: {
            // Tricorn: conjugate, then square.
            return DfComplex(
                df_add(df_sub(df_sqr(z.re), df_sqr(z.im)), c.re),
                df_sub(c.im, df_mul2(df_mul(z.re, z.im))),
            );
        }
        case 3u: {
            // Multibrot, integer powers only (Rust falls back to fast for fractional
            // ones, which need pow/atan2 and have no double-float equivalent here).
            var w = z;
            let p = u32(params.power);
            for (var k = 1u; k < p; k = k + 1u) {
                w = dfc_mul(w, z);
            }
            return DfComplex(df_add(w.re, c.re), df_add(w.im, c.im));
        }
        default: {
            return DfComplex(
                df_add(df_sub(df_sqr(z.re), df_sqr(z.im)), c.re),
                df_add(df_mul2(df_mul(z.re, z.im)), c.im),
            );
        }
    }
}

fn escape_deep(d: vec2<f32>) -> Escape {
    // Pixel offsets are small whole-and-half numbers, exact in f32; all the precision
    // is in the centre and scale, which arrive as hi/lo pairs.
    let scale = vec2<f32>(params.scale_hi, params.scale_lo);
    let p = DfComplex(
        df_add(vec2<f32>(params.center_hi.x, params.center_lo.x), df_mul(df(d.x), scale)),
        df_sub(vec2<f32>(params.center_hi.y, params.center_lo.y), df_mul(df(d.y), scale)),
    );

    var z: DfComplex;
    var c: DfComplex;
    if params.mode == 1u {
        z = p;
        c = DfComplex(
            vec2<f32>(params.julia_hi.x, params.julia_lo.x),
            vec2<f32>(params.julia_hi.y, params.julia_lo.y),
        );
    } else {
        // The f32 bulb test is only trustworthy while pixels are coarser than f32
        // resolution; deeper than that, every pixel is near the boundary anyway.
        if params.formula == 0u && params.scale_hi > 1e-6 && in_main_body(vec2<f32>(p.re.x, p.im.x)) {
            return Escape(params.max_iter, 0.0);
        }
        z = DfComplex(df(0.0), df(0.0));
        c = p;
    }

    var n: u32 = 0u;
    var mag_sq = z.re.x * z.re.x + z.im.x * z.im.x;
    loop {
        if n >= params.max_iter || mag_sq > BAILOUT_SQ { break; }
        z = iterate_df(z, c);
        // The escape test doesn't need extra precision: hi parts are enough.
        mag_sq = z.re.x * z.re.x + z.im.x * z.im.x;
        n = n + 1u;
    }
    return Escape(n, mag_sq);
}

// ---------------------------------------------------------------- perturbation (reference orbit + double-float deltas)

fn ref_at(m: u32) -> DfComplex {
    let v = ref_orbit[m];
    return DfComplex(v.xy, v.zw);
}

fn dfc_add(a: DfComplex, b: DfComplex) -> DfComplex {
    return DfComplex(df_add(a.re, b.re), df_add(a.im, b.im));
}

// f(Z + dz) − f(Z) for the reference value Z, without the "+ dc" term.
fn perturb_step(z: DfComplex, dz: DfComplex) -> DfComplex {
    switch params.formula {
        case 2u: {
            // Tricorn: conj((Z+dz)²) − conj(Z²) = conj((2Z + dz)·dz)
            let a = DfComplex(df_add(df_mul2(z.re), dz.re), df_add(df_mul2(z.im), dz.im));
            let p = dfc_mul(a, dz);
            return DfComplex(p.re, df_neg(p.im));
        }
        case 3u: {
            // Multibrot, integer p: with W = Zᵏ and D = (Z+dz)ᵏ − Zᵏ,
            //   D ← dz·W + (Z + dz)·D,  W ← W·Z   (no cancellation, so no precision loss)
            var w = z;
            var dd = dz;
            let s = dfc_add(z, dz);
            let p = u32(params.power);
            for (var k = 1u; k < p; k = k + 1u) {
                dd = dfc_add(dfc_mul(dz, w), dfc_mul(s, dd));
                w = dfc_mul(w, z);
            }
            return dd;
        }
        default: {
            // Mandelbrot: (Z+dz)² − Z² = (2Z + dz)·dz
            let a = DfComplex(df_add(df_mul2(z.re), dz.re), df_add(df_mul2(z.im), dz.im));
            return dfc_mul(a, dz);
        }
    }
}

fn escape_perturb(d: vec2<f32>) -> Escape {
    if params.ref_len < 2u {
        return escape_deep(d); // no reference uploaded yet
    }
    if params.formula == 0u && params.scale_hi > 1e-6
        && in_main_body(params.center_hi + vec2<f32>(d.x, -d.y) * params.scale_hi) {
        return Escape(params.max_iter, 0.0);
    }

    // This pixel's c relative to the reference: (view centre − reference) + pixel offset.
    let scale = vec2<f32>(params.scale_hi, params.scale_lo);
    let dc = DfComplex(
        df_add(params.ref_off_re, df_mul(df(d.x), scale)),
        df_sub(params.ref_off_im, df_mul(df(d.y), scale)),
    );

    var dz = DfComplex(df(0.0), df(0.0));
    var m = 0u;
    var n = 0u;
    var mag_sq = 0.0;
    let last = params.ref_len - 1u;
    loop {
        if n >= params.max_iter { break; }
        dz = dfc_add(perturb_step(ref_at(m), dz), dc);
        m = m + 1u;
        n = n + 1u;
        // The pixel's actual value, for the escape test and colouring.
        let z = dfc_add(ref_at(m), dz);
        mag_sq = z.re.x * z.re.x + z.im.x * z.im.x;
        if mag_sq > BAILOUT_SQ { break; }
        // Rebase: once the difference is larger than the value itself (or the
        // reference has run out), restart from Z₀ = 0 with the full value as the
        // difference. This replaces classic glitch detection.
        let dz_sq = dz.re.x * dz.re.x + dz.im.x * dz.im.x;
        if mag_sq < dz_sq || m >= last {
            dz = z;
            m = 0u;
        }
    }
    return Escape(n, mag_sq);
}

// ---------------------------------------------------------------- colouring

fn escape_at(d: vec2<f32>) -> Escape {
    switch params.arith {
        case 1u: { return escape_deep(d); }
        case 2u: { return escape_perturb(d); }
        default: { return escape_fast(d); }
    }
}

// Test entry point: writes the raw escape count (low byte, high byte) instead of
// a colour, so automated tests can compare the GPU's results with a reference.
@fragment
fn fs_debug_escape(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
    let e = escape_at(frag.xy - 0.5 * params.resolution);
    return vec4<f32>(f32(e.n & 255u) / 255.0, f32((e.n >> 8u) & 255u) / 255.0, 0.0, 1.0);
}

@fragment
fn fs_main(@builtin(position) frag: vec4<f32>) -> @location(0) vec4<f32> {
    // frag.xy is in pixels, origin top-left, y down — same convention as view.rs.
    let e = escape_at(frag.xy - 0.5 * params.resolution);

    if e.n >= params.max_iter {
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }
    let n = e.n;
    let mag_sq = e.mag_sq;

    // Continuous (smooth) iteration count removes the stepped bands. Near
    // infinity each step raises |z| to the formula's degree, hence log(degree).
    var degree = 2.0;
    if params.formula == 3u { degree = params.power; }
    let log_zn = log(mag_sq) * 0.5;
    let nu = log(log_zn / log(2.0)) / log(degree);
    let smooth_n = f32(n) + 1.0 - nu;

    let s = max(smooth_n, 0.0);
    // sqrt keeps colour bands a similar width as you zoom deeper; the fade
    // darkens quickly-escaping points so detail near the boundary stands out.
    let t = sqrt(s) * 0.18;
    let fade = 1.0 - exp(-s * 0.12);
    return vec4<f32>(clamp(palette(t, params.palette) * fade, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}
