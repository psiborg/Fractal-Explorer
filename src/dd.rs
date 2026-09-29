//! Double-double ("DD") arithmetic on the CPU: a value is the unevaluated sum
//! hi + lo of two f64s, giving ~106 bits of mantissa. Used for the view centre
//! (a single f64 can't even locate the centre past ~10¹⁵× zoom) and for the
//! perturbation reference orbit.
//!
//! Uses Dekker's split rather than `f64::mul_add`, which is a slow software
//! routine on wasm32 (baseline WebAssembly has no fused multiply-add).

use std::ops::{Add, Mul, Neg, Sub};

const SPLITTER: f64 = 134_217_729.0; // 2^27 + 1

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct DD {
    pub hi: f64,
    pub lo: f64,
}

#[inline]
fn two_sum(a: f64, b: f64) -> (f64, f64) {
    let s = a + b;
    let bb = s - a;
    (s, (a - (s - bb)) + (b - bb))
}

#[inline]
fn quick_two_sum(a: f64, b: f64) -> (f64, f64) {
    let s = a + b;
    (s, b - (s - a))
}

#[inline]
fn split(a: f64) -> (f64, f64) {
    let t = SPLITTER * a;
    let hi = t - (t - a);
    (hi, a - hi)
}

#[inline]
fn two_prod(a: f64, b: f64) -> (f64, f64) {
    let p = a * b;
    let (ah, al) = split(a);
    let (bh, bl) = split(b);
    (p, ((ah * bh - p) + ah * bl + al * bh) + al * bl)
}

impl DD {
    pub fn new(x: f64) -> Self {
        DD { hi: x, lo: 0.0 }
    }

    /// Builds a normalised DD from any two f64s whose exact sum is the value.
    pub fn from_sum(a: f64, b: f64) -> Self {
        let (hi, lo) = two_sum(a, b);
        DD { hi, lo }
    }

    pub fn to_f64(self) -> f64 {
        self.hi + self.lo
    }

    pub fn is_finite(self) -> bool {
        self.hi.is_finite() && self.lo.is_finite()
    }

    pub fn abs(self) -> Self {
        if self.hi < 0.0 { -self } else { self }
    }

    pub fn sqr(self) -> Self {
        let (p, e) = two_prod(self.hi, self.hi);
        let e = e + 2.0 * self.hi * self.lo;
        let (hi, lo) = quick_two_sum(p, e);
        DD { hi, lo }
    }

    pub fn mul_f64(self, b: f64) -> Self {
        let (p, e) = two_prod(self.hi, b);
        let e = e + self.lo * b;
        let (hi, lo) = quick_two_sum(p, e);
        DD { hi, lo }
    }

    /// Splits into two f32s (hi + lo) for the GPU's double-float arithmetic.
    pub fn to_f32_pair(self) -> [f32; 2] {
        let hi = self.hi as f32;
        let lo = ((self.hi - hi as f64) + self.lo) as f32;
        [hi, lo]
    }

    /// Decimal digits after the point, for displaying deep-zoom coordinates.
    pub fn to_decimal(self, digits: usize) -> String {
        let negative = self.hi < 0.0;
        let mut x = self.abs();
        let int = x.hi.floor();
        x = x - DD::new(int);
        if x.hi < 0.0 {
            // hi rounded up to an integer while lo is negative
            x = x + DD::new(1.0);
            return format_digits(negative, int - 1.0, x, digits);
        }
        format_digits(negative, int, x, digits)
    }
}

fn format_digits(negative: bool, int: f64, mut frac: DD, digits: usize) -> String {
    let mut s = String::with_capacity(digits + 24);
    if negative {
        s.push('-');
    }
    s.push_str(&format!("{int:.0}"));
    if digits > 0 {
        s.push('.');
        for _ in 0..digits {
            frac = frac.mul_f64(10.0);
            let mut d = frac.hi.floor();
            frac = frac - DD::new(d);
            if frac.hi < 0.0 {
                d -= 1.0;
                frac = frac + DD::new(1.0);
            }
            s.push(char::from(b'0' + d.clamp(0.0, 9.0) as u8));
        }
    }
    s
}

impl Add for DD {
    type Output = DD;
    fn add(self, b: DD) -> DD {
        let (s, e) = two_sum(self.hi, b.hi);
        let (t, f) = two_sum(self.lo, b.lo);
        let (s, e) = quick_two_sum(s, e + t);
        let (hi, lo) = quick_two_sum(s, e + f);
        DD { hi, lo }
    }
}

impl Neg for DD {
    type Output = DD;
    fn neg(self) -> DD {
        DD {
            hi: -self.hi,
            lo: -self.lo,
        }
    }
}

impl Sub for DD {
    type Output = DD;
    fn sub(self, b: DD) -> DD {
        self + (-b)
    }
}

impl Mul for DD {
    type Output = DD;
    fn mul(self, b: DD) -> DD {
        let (p, e) = two_prod(self.hi, b.hi);
        let e = e + (self.hi * b.lo + self.lo * b.hi);
        let (hi, lo) = quick_two_sum(p, e);
        DD { hi, lo }
    }
}

/// A complex number in double-double.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Cdd {
    pub re: DD,
    pub im: DD,
}

impl Cdd {
    pub fn new(re: DD, im: DD) -> Self {
        Cdd { re, im }
    }

    pub fn from_f64(re: f64, im: f64) -> Self {
        Cdd::new(DD::new(re), DD::new(im))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_about_106_bits() {
        // (1/3 as DD) · 3 should be within ~1e-31 of 1.
        // Build 1/3 to ~106 bits: hi = f64(1/3), lo = exact residual (1 − 3·hi)/3.
        let hi = 1.0 / 3.0;
        let (p, e) = two_prod(3.0, hi);
        let third = DD::from_sum(hi, ((1.0 - p) - e) / 3.0);
        let one = third * DD::new(3.0);
        assert!((one - DD::new(1.0)).to_f64().abs() < 1e-30);
        // Adding a tiny value that f64 alone would lose.
        let x = DD::new(1.0) + DD::new(1e-25);
        assert_eq!(x.hi, 1.0);
        assert!((x.lo - 1e-25).abs() < 1e-40);
    }

    #[test]
    fn sqr_matches_mul() {
        let x = DD::from_sum(-0.743_643_887_037_158_7, 3.1e-17);
        let a = x.sqr();
        let b = x * x;
        assert!((a - b).to_f64().abs() < 1e-31);
    }

    #[test]
    fn decimal_digits_beyond_f64() {
        let x = DD::from_sum(-0.743_643_887_037_158_7, 1.0e-20);
        let s = x.to_decimal(22);
        assert!(s.starts_with("-0.74364388703715"), "{s}");
        assert_eq!(DD::new(2.5).to_decimal(3), "2.500");
        assert_eq!(DD::new(-0.125).to_decimal(4), "-0.1250");
    }

    #[test]
    fn f32_pair_rebuilds_the_value() {
        let x = DD::from_sum(0.131_825_904_205_311_97, 4.9e-18);
        let [hi, lo] = x.to_f32_pair();
        let rebuilt = hi as f64 + lo as f64;
        assert!((rebuilt - x.to_f64()).abs() < 1e-14);
    }
}
