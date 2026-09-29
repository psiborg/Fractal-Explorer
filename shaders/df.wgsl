// Double-float ("df") arithmetic: each value is a vec2<f32> holding an unevaluated
// sum hi + lo, where lo carries the bits that didn't fit in hi. That gives about
// 48 bits of mantissa from two 24-bit f32s, at roughly 10–20× the cost per operation.
//
// Based on Dekker (1971) and Knuth's TwoSum. Deliberately avoids fma(): on D3D12,
// WGSL's fma can compile to `mad`, which isn't guaranteed to be fused, and an unfused
// fma would silently zero the error terms. The startup self-test
// (shaders/selftest.wgsl) checks on the real GPU that the extra bits survive.
//
// This file is prepended to fractal.wgsl and selftest.wgsl by the Rust side.

// Splits an f32 into two halves of ~12 bits each, so their products are exact.
const DF_SPLITTER: f32 = 4097.0; // 2^12 + 1

// a + b exactly, as (sum, rounding error).
fn two_sum(a: f32, b: f32) -> vec2<f32> {
    let s = a + b;
    let bb = s - a;
    let err = (a - (s - bb)) + (b - bb);
    return vec2<f32>(s, err);
}

// Same, but only valid when |a| >= |b|. Cheaper; used to renormalise.
fn quick_two_sum(a: f32, b: f32) -> vec2<f32> {
    let s = a + b;
    let err = b - (s - a);
    return vec2<f32>(s, err);
}

fn df_split(a: f32) -> vec2<f32> {
    let t = DF_SPLITTER * a;
    let hi = t - (t - a);
    return vec2<f32>(hi, a - hi);
}

// a * b exactly, as (product, rounding error).
fn two_prod(a: f32, b: f32) -> vec2<f32> {
    let p = a * b;
    let sa = df_split(a);
    let sb = df_split(b);
    let err = ((sa.x * sb.x - p) + sa.x * sb.y + sa.y * sb.x) + sa.y * sb.y;
    return vec2<f32>(p, err);
}

fn df(a: f32) -> vec2<f32> {
    return vec2<f32>(a, 0.0);
}

fn df_add(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
    var s = two_sum(a.x, b.x);
    let t = two_sum(a.y, b.y);
    s.y = s.y + t.x;
    s = quick_two_sum(s.x, s.y);
    s.y = s.y + t.y;
    return quick_two_sum(s.x, s.y);
}

fn df_neg(a: vec2<f32>) -> vec2<f32> {
    return -a;
}

fn df_sub(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
    return df_add(a, -b);
}

fn df_mul(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
    var p = two_prod(a.x, b.x);
    p.y = p.y + (a.x * b.y + a.y * b.x);
    return quick_two_sum(p.x, p.y);
}

fn df_sqr(a: vec2<f32>) -> vec2<f32> {
    var p = two_prod(a.x, a.x);
    p.y = p.y + 2.0 * a.x * a.y;
    return quick_two_sum(p.x, p.y);
}

// Multiplying by 2 is exact in binary floating point, so it needs no error term.
fn df_mul2(a: vec2<f32>) -> vec2<f32> {
    return 2.0 * a;
}

fn df_abs(a: vec2<f32>) -> vec2<f32> {
    return select(a, -a, a.x < 0.0);
}

// Complex numbers in double-float: re and im are each a df value.
struct DfComplex {
    re: vec2<f32>,
    im: vec2<f32>,
};

fn dfc_mul(a: DfComplex, b: DfComplex) -> DfComplex {
    return DfComplex(
        df_sub(df_mul(a.re, b.re), df_mul(a.im, b.im)),
        df_add(df_mul(a.re, b.im), df_mul(a.im, b.re)),
    );
}
