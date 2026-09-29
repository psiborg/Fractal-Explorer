//! Measures how long the GPU spends drawing each frame, using WebGPU timestamp
//! queries. Optional: only created when the adapter offers `timestamp-query`.
//!
//! Only one measurement is in flight at a time. Results arrive asynchronously
//! (the readback buffer is mapped a frame or two later), so `collect()` picks
//! them up on a later call.
//!
//! Chrome rounds timestamps to 100 µs by default to limit timing attacks;
//! launching it with `--enable-webgpu-developer-features` gives full resolution.

use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};

const IDLE: u8 = 0;
const PENDING: u8 = 1;
const READY: u8 = 2;

pub struct GpuTimer {
    query_set: wgpu::QuerySet,
    resolve: wgpu::Buffer,
    readback: wgpu::Buffer,
    state: Arc<AtomicU8>,
    period_ns: f32,
    last_ms: Option<f64>,
}

impl GpuTimer {
    pub fn new(device: &wgpu::Device, queue: &wgpu::Queue) -> Option<Self> {
        if !device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
            return None;
        }
        let query_set = device.create_query_set(&wgpu::QuerySetDescriptor {
            label: Some("frame timestamps"),
            ty: wgpu::QueryType::Timestamp,
            count: 2,
        });
        let resolve = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("timestamp resolve"),
            size: 16,
            usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC,
            mapped_at_creation: false,
        });
        let readback = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("timestamp readback"),
            size: 16,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        Some(GpuTimer {
            query_set,
            resolve,
            readback,
            state: Arc::new(AtomicU8::new(IDLE)),
            period_ns: queue.get_timestamp_period(),
            last_ms: None,
        })
    }

    /// True when no measurement is in flight, so this frame can be timed.
    pub fn ready_to_measure(&self) -> bool {
        self.state.load(Ordering::Acquire) == IDLE
    }

    pub fn pass_writes(&self) -> wgpu::RenderPassTimestampWrites<'_> {
        wgpu::RenderPassTimestampWrites {
            query_set: &self.query_set,
            beginning_of_pass_write_index: Some(0),
            end_of_pass_write_index: Some(1),
        }
    }

    /// Records the copy of the two timestamps into the readback buffer.
    pub fn resolve(&self, encoder: &mut wgpu::CommandEncoder) {
        encoder.resolve_query_set(&self.query_set, 0..2, &self.resolve, 0);
        encoder.copy_buffer_to_buffer(&self.resolve, 0, &self.readback, 0, 16);
    }

    /// Starts the asynchronous readback; call after `queue.submit`.
    pub fn after_submit(&self) {
        self.state.store(PENDING, Ordering::Release);
        let state = self.state.clone();
        self.readback
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                state.store(if result.is_ok() { READY } else { IDLE }, Ordering::Release);
            });
    }

    /// Picks up a finished measurement, if there is one.
    pub fn collect(&mut self) {
        if self.state.load(Ordering::Acquire) != READY {
            return;
        }
        let stamps: Option<[u64; 2]> =
            self.readback.slice(..).get_mapped_range().ok().map(|view| {
                let words: &[u64] = bytemuck::cast_slice(&view);
                [words[0], words[1]]
            });
        self.readback.unmap();
        if let Some([start, end]) = stamps
            && end >= start
        {
            self.last_ms = Some((end - start) as f64 * self.period_ns as f64 / 1e6);
        }
        self.state.store(IDLE, Ordering::Release);
    }

    pub fn last_ms(&self) -> Option<f64> {
        self.last_ms
    }
}
