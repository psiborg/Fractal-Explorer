//! Runs the double-float operations once on the real GPU and measures how many
//! bits of precision survive the browser's shader compiler.
//!
//! This matters because compilers may legally rewrite some floating-point
//! expressions, and the error terms double-float relies on look algebraically
//! like zero. If they get optimised away, "Deep" mode would silently be no better
//! than "Fast". The inputs arrive in a storage buffer, so nothing can be folded
//! at compile time.

use futures_channel::oneshot;
use wgpu::util::DeviceExt;

use crate::view::split_f64;

pub const SELFTEST_SOURCE: &str = concat!(
    include_str!("../shaders/df.wgsl"),
    "\n",
    include_str!("../shaders/selftest.wgsl")
);

/// Bits of precision below which Deep isn't meaningfully better than f32 (24 bits).
const PASS_BITS: f64 = 40.0;

#[derive(Clone, Debug)]
pub struct SelfTest {
    /// Worst-case bits of precision measured across multiply, add and square.
    pub bits: f64,
    pub passed: bool,
    pub summary: String,
}

pub async fn run(device: &wgpu::Device, queue: &wgpu::Queue) -> SelfTest {
    match run_inner(device, queue).await {
        Ok(test) => test,
        Err(e) => SelfTest {
            bits: 0.0,
            passed: false,
            summary: format!("self-test could not run: {e}"),
        },
    }
}

async fn run_inner(device: &wgpu::Device, queue: &wgpu::Queue) -> Result<SelfTest, String> {
    // Values with no short binary expansion, so every bit of the result matters.
    let (a_hi, a_lo) = split_f64(1.0 / 3.0);
    let (b_hi, b_lo) = split_f64(3.0 / 7.0);
    let a = a_hi as f64 + a_lo as f64;
    let b = b_hi as f64 + b_lo as f64;

    let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("selftest.wgsl"),
        source: wgpu::ShaderSource::Wgsl(SELFTEST_SOURCE.into()),
    });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("df self-test"),
        layout: None,
        module: &module,
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    });
    let input = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("self-test inputs"),
        contents: bytemuck::cast_slice(&[a_hi, a_lo, b_hi, b_lo]),
        usage: wgpu::BufferUsages::STORAGE,
    });
    let output = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("self-test outputs"),
        size: 32,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("self-test readback"),
        size: 32,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("self-test bind group"),
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: input.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: output.as_entire_binding(),
            },
        ],
    });

    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("self-test"),
    });
    {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("df self-test"),
            timestamp_writes: None,
        });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &bind_group, &[]);
        pass.dispatch_workgroups(1, 1, 1);
    }
    encoder.copy_buffer_to_buffer(&output, 0, &readback, 0, 32);
    queue.submit(Some(encoder.finish()));
    if let Some(err) = scope.pop().await {
        return Err(err.to_string());
    }

    // Reading GPU results back is asynchronous: the browser resolves the mapping
    // once the GPU has finished, and the callback wakes this future.
    let (tx, rx) = oneshot::channel();
    readback
        .slice(..)
        .map_async(wgpu::MapMode::Read, move |result| {
            let _ = tx.send(result);
        });
    rx.await
        .map_err(|_| "readback was cancelled".to_string())?
        .map_err(|e| e.to_string())?;
    let out: Vec<f32> = {
        let view = readback
            .slice(..)
            .get_mapped_range()
            .map_err(|e| e.to_string())?;
        bytemuck::cast_slice(&view).to_vec()
    };
    readback.unmap();

    let value = |i: usize| out[2 * i] as f64 + out[2 * i + 1] as f64;
    let rel = |got: f64, want: f64| ((got - want) / want).abs();
    let errors = [
        ("mul", rel(value(0), a * b)),
        ("add", rel(value(1), a + b)),
        ("sqr", rel(value(2), a * a)),
    ];
    let worst = errors.iter().map(|(_, e)| *e).fold(0.0, f64::max);
    let bits = if worst == 0.0 { 53.0 } else { -worst.log2() };
    let two_prod_error = out[7];
    let passed = bits >= PASS_BITS && two_prod_error != 0.0;

    let detail = errors
        .iter()
        .map(|(name, e)| format!("{name} {e:.1e}"))
        .collect::<Vec<_>>()
        .join(", ");
    let summary = if passed {
        format!(
            "{bits:.0} bits of precision on this GPU (f32 alone gives 24); relative errors: {detail}"
        )
    } else if two_prod_error == 0.0 {
        format!(
            "only {bits:.0} bits: the shader compiler removed the TwoProd error term, so Deep mode won't improve on Fast here ({detail})"
        )
    } else {
        format!("only {bits:.0} bits of precision, below the {PASS_BITS} expected ({detail})")
    };
    Ok(SelfTest {
        bits,
        passed,
        summary,
    })
}
