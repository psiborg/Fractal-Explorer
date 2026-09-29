// Startup self-test for double-float arithmetic (df.wgsl is prepended).
//
// Shader compilers are allowed some freedom with floating point, and a compiler
// that rewrites (s - a) - b as 0, or fuses a*b - p into one rounding, silently
// destroys the error terms double-float depends on. This runs the real operations
// on the real GPU with inputs only known at runtime, so Rust can measure how many
// bits of precision actually survive the browser's shader pipeline.

@group(0) @binding(0) var<storage, read> inputs: array<vec2<f32>, 2>;
@group(0) @binding(1) var<storage, read_write> outputs: array<vec2<f32>, 4>;

@compute @workgroup_size(1)
fn main() {
    let a = inputs[0];
    let b = inputs[1];
    outputs[0] = df_mul(a, b);
    outputs[1] = df_add(a, b);
    outputs[2] = df_sqr(a);
    // Raw error term of a single product: zero here means the compiler broke TwoProd.
    outputs[3] = two_prod(a.x, b.x);
}
