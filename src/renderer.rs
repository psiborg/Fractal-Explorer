//! Everything that touches the GPU: device setup, the render pipeline, the
//! uniform buffer, and drawing a frame. Target-agnostic — it takes a surface
//! that `lib.rs` created from the browser canvas.

use std::sync::Arc;

use wgpu::util::DeviceExt;

use crate::debug::{self, FRAME, WGPU, WGSL};
use crate::dlog;
use crate::selftest::{self, SelfTest};
use crate::timer::GpuTimer;
use crate::view::Uniforms;

/// The double-float library is prepended: WGSL has no #include.
/// Reference orbit entries the GPU buffer holds: max iterations + Z₀.
pub const ORBIT_CAPACITY: u64 = crate::MAX_ITERATIONS as u64 + 1;

pub const SHADER_SOURCE: &str = concat!(
    include_str!("../shaders/df.wgsl"),
    "\n",
    include_str!("../shaders/fractal.wgsl")
);

pub struct Renderer {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    pipeline: wgpu::RenderPipeline,
    uniform_buffer: wgpu::Buffer,
    orbit_buffer: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
    adapter_info: wgpu::AdapterInfo,
    surface_caps: wgpu::SurfaceCapabilities,
    compilation: String,
    frames: u64,
    selftest: SelfTest,
    timer: Option<GpuTimer>,
}

impl Renderer {
    pub async fn new(
        instance: &wgpu::Instance,
        surface: wgpu::Surface<'static>,
        width: u32,
        height: u32,
    ) -> Result<Self, String> {
        dlog!(
            WGPU,
            "Requesting adapter (power preference: HighPerformance)"
        );
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                // Ask for the discrete GPU over integrated graphics. Chrome on Windows
                // ignores this hint (and logs a console warning saying so); there the
                // GPU is chosen by Windows' per-app graphics setting instead.
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: Some(&surface),
                ..Default::default()
            })
            .await
            .map_err(|e| format!("No suitable GPU adapter: {e}"))?;

        let adapter_info = adapter.get_info();
        dlog!(
            WGPU,
            "Adapter: backend={:?} type={:?} vendor={:#x} name={:?}",
            adapter_info.backend,
            adapter_info.device_type,
            adapter_info.vendor,
            adapter_info.name
        );
        debug::group(
            WGPU,
            "Adapter features",
            &format!("{:#?}", adapter.features()),
        );
        debug::group(
            WGPU,
            "Adapter limits (what this GPU could give us)",
            &format!("{:#?}", adapter.limits()),
        );

        // WebGPU's baseline limits are guaranteed on every adapter; only the
        // texture size is raised to whatever this GPU supports.
        let required_limits = wgpu::Limits::default().using_resolution(adapter.limits());
        dlog!(
            WGPU,
            "Requesting device with WebGPU default limits (max texture {}px)",
            required_limits.max_texture_dimension_2d
        );
        // Timestamp queries let us measure GPU time per frame, when offered.
        let required_features = adapter.features() & wgpu::Features::TIMESTAMP_QUERY;
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("fractal device"),
                required_features,
                required_limits,
                ..Default::default()
            })
            .await
            .map_err(|e| format!("Could not open GPU device: {e}"))?;
        dlog!(
            WGPU,
            "Device ready; features enabled: {:?}",
            device.features()
        );

        // Always surface GPU errors: without these handlers, a validation error in
        // the browser only shows up as a terse, easy-to-miss console warning.
        device.on_uncaptured_error(Arc::new(|err| {
            debug::error(WGPU, &format!("Uncaptured GPU error: {err}"));
        }));
        device.set_device_lost_callback(|reason, message| {
            debug::error(WGPU, &format!("GPU device lost ({reason:?}): {message}"));
        });

        let selftest = selftest::run(&device, &queue).await;
        if selftest.passed {
            dlog!(WGSL, "Double-float self-test passed: {}", selftest.summary);
        } else {
            debug::warn(
                WGSL,
                &format!("Double-float self-test failed: {}", selftest.summary),
            );
        }

        let timer = GpuTimer::new(&device, &queue);
        dlog!(
            WGPU,
            "GPU frame timing: {}",
            if timer.is_some() {
                "available (timestamp-query)"
            } else {
                "unavailable (adapter has no timestamp-query)"
            }
        );

        let surface_caps = surface.get_capabilities(&adapter);
        debug::group(WGPU, "Surface capabilities", &format!("{surface_caps:#?}"));
        let mut config = surface
            .get_default_config(&adapter, width.max(1), height.max(1))
            .ok_or("Surface is not supported by this adapter")?;
        // The shader writes display-ready colours, so avoid an sRGB target that
        // would gamma-encode them a second time.
        if let Some(format) = surface_caps.formats.iter().copied().find(|f| !f.is_srgb()) {
            config.format = format;
        }
        config.present_mode = wgpu::PresentMode::Fifo;
        surface.configure(&device, &config);
        dlog!(
            WGPU,
            "Surface configured: {}×{} {:?}, present mode {:?}, alpha {:?}",
            config.width,
            config.height,
            config.format,
            config.present_mode,
            config.alpha_mode
        );

        // Catch validation errors from resource creation so a bad shader or
        // layout fails startup with a real message instead of a black canvas.
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);

        debug::group(
            WGSL,
            &format!(
                "Shader source: fractal.wgsl ({} bytes)",
                SHADER_SOURCE.len()
            ),
            SHADER_SOURCE,
        );
        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("fractal.wgsl"),
            source: wgpu::ShaderSource::Wgsl(SHADER_SOURCE.into()),
        });
        let compilation = describe_compilation(&shader.get_compilation_info().await);
        dlog!(WGSL, "Compiled by the browser: {compilation}");

        dlog!(
            WGSL,
            "Uniform buffer `Params`: {} bytes at @group(0) @binding(0), visible to the fragment stage",
            std::mem::size_of::<Uniforms>()
        );
        let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("params"),
            contents: bytemuck::bytes_of(&<Uniforms as bytemuck::Zeroable>::zeroed()),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

        // Perturbation's reference orbit: one vec4 (re_hi, re_lo, im_hi, im_lo) per step,
        // sized for the largest iteration count the app allows.
        let orbit_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("reference orbit"),
            size: ORBIT_CAPACITY * 16,
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        dlog!(
            WGSL,
            "Reference orbit buffer: {} KiB storage at @group(0) @binding(1), array<vec4<f32>>",
            ORBIT_CAPACITY * 16 / 1024
        );

        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("params layout"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Storage { read_only: true },
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("params bind group"),
            layout: &bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniform_buffer.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: orbit_buffer.as_entire_binding(),
                },
            ],
        });

        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("fractal layout"),
            bind_group_layouts: &[Some(&bind_group_layout)],
            immediate_size: 0,
        });

        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("fractal pipeline"),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                buffers: &[],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: config.format,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });

        if let Some(err) = scope.pop().await {
            return Err(format!(
                "GPU validation failed while building the pipeline: {err}"
            ));
        }
        dlog!(
            WGPU,
            "Render pipeline ready: vs_main → fs_main, 1 triangle, target {:?}",
            config.format
        );

        Ok(Renderer {
            surface,
            device,
            queue,
            config,
            pipeline,
            uniform_buffer,
            orbit_buffer,
            bind_group,
            adapter_info,
            surface_caps,
            compilation,
            frames: 0,
            selftest,
            timer,
        })
    }

    pub fn adapter_name(&self) -> String {
        if self.adapter_info.name.is_empty() {
            format!("{:?}", self.adapter_info.backend)
        } else {
            self.adapter_info.name.clone()
        }
    }

    /// Uploads a perturbation reference orbit (at most ORBIT_CAPACITY entries).
    pub fn upload_orbit(&self, orbit: &[[f32; 4]]) {
        let n = orbit.len().min(ORBIT_CAPACITY as usize);
        self.queue
            .write_buffer(&self.orbit_buffer, 0, bytemuck::cast_slice(&orbit[..n]));
    }

    pub fn max_dimension(&self) -> u32 {
        self.device.limits().max_texture_dimension_2d
    }

    pub fn frames(&self) -> u64 {
        self.frames
    }

    pub fn selftest(&self) -> &SelfTest {
        &self.selftest
    }

    /// Latest GPU time for one frame, in ms; None if timing is unavailable or
    /// no measurement has arrived yet.
    pub fn gpu_time_ms(&mut self) -> Option<f64> {
        let timer = self.timer.as_mut()?;
        timer.collect();
        timer.last_ms()
    }

    pub fn has_timer(&self) -> bool {
        self.timer.is_some()
    }

    pub fn resize(&mut self, width: u32, height: u32) {
        let max = self.max_dimension();
        self.config.width = width.clamp(1, max);
        self.config.height = height.clamp(1, max);
        self.surface.configure(&self.device, &self.config);
        dlog!(
            WGPU,
            "Surface reconfigured to {}×{} ({} Mpixel per frame)",
            self.config.width,
            self.config.height,
            (self.config.width as f64 * self.config.height as f64 / 1e6 * 100.0).round() / 100.0
        );
    }

    pub fn render(&mut self, uniforms: &Uniforms) {
        let frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(frame) => frame,
            wgpu::CurrentSurfaceTexture::Suboptimal(frame) => {
                dlog!(WGPU, "Surface texture is suboptimal; drawing anyway");
                frame
            }
            wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Lost => {
                // Canvas was resized or lost under us: reconfigure and draw next frame.
                dlog!(
                    WGPU,
                    "Surface outdated or lost; reconfiguring and skipping frame"
                );
                self.surface.configure(&self.device, &self.config);
                return;
            }
            other => {
                dlog!(WGPU, "Skipping frame: {other:?}");
                return;
            }
        };

        self.frames += 1;
        if let Some(timer) = self.timer.as_mut() {
            timer.collect();
        }
        let timed = self.timer.as_ref().is_some_and(GpuTimer::ready_to_measure);
        dlog!(
            FRAME,
            "#{}: write {}-byte uniforms → encode 1 render pass (3 vertices) → submit → present | {:?}",
            self.frames,
            std::mem::size_of::<Uniforms>(),
            uniforms
        );

        self.queue
            .write_buffer(&self.uniform_buffer, 0, bytemuck::bytes_of(uniforms));

        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("frame"),
            });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("fractal pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: if timed {
                    self.timer.as_ref().map(GpuTimer::pass_writes)
                } else {
                    None
                },
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &self.bind_group, &[]);
            pass.draw(0..3, 0..1);
        }
        if timed && let Some(timer) = &self.timer {
            timer.resolve(&mut encoder);
        }
        self.queue.submit(Some(encoder.finish()));
        self.queue.present(frame);
        if timed && let Some(timer) = &self.timer {
            timer.after_submit();
        }
    }

    /// Prints the full GPU state to the console, regardless of debug flags.
    pub fn dump(&self, uniforms: &Uniforms) {
        debug::force_group(WGPU, "Adapter info", &format!("{:#?}", self.adapter_info));
        debug::force_group(
            WGPU,
            "Device features",
            &format!("{:#?}", self.device.features()),
        );
        debug::force_group(
            WGPU,
            "Device limits (granted)",
            &format!("{:#?}", self.device.limits()),
        );
        debug::force_group(
            WGPU,
            "Surface capabilities",
            &format!("{:#?}", self.surface_caps),
        );
        debug::force_group(
            WGPU,
            "Surface configuration",
            &format!("{:#?}", self.config),
        );
        debug::force_group(
            WGSL,
            &format!(
                "Shader: fractal.wgsl ({} bytes) — {}",
                SHADER_SOURCE.len(),
                self.compilation
            ),
            SHADER_SOURCE,
        );
        debug::force_group(
            WGSL,
            "Current uniforms (Params)",
            &format!(
                "{uniforms:#?}\nraw bytes: {:02x?}",
                bytemuck::bytes_of(uniforms)
            ),
        );
        debug::force_group(FRAME, "Frames rendered", &self.frames.to_string());
        debug::force_group(
            WGSL,
            &format!(
                "Double-float self-test: {}",
                if self.selftest.passed {
                    "passed"
                } else {
                    "FAILED"
                }
            ),
            &self.selftest.summary,
        );
        debug::force_group(
            FRAME,
            "GPU time for the last timed frame",
            &match (&self.timer, self.timer.as_ref().and_then(GpuTimer::last_ms)) {
                (None, _) => "unavailable: no timestamp-query on this adapter".to_string(),
                (Some(_), None) => "no measurement yet".to_string(),
                (Some(_), Some(ms)) => format!("{ms:.3} ms"),
            },
        );
    }
}

/// Summarises the browser's shader compiler output. Errors and warnings are
/// always printed, since they matter whether or not debugging is on.
fn describe_compilation(info: &wgpu::CompilationInfo) -> String {
    let mut errors = 0;
    let mut warnings = 0;
    for msg in &info.messages {
        let location = msg
            .location
            .map(|l| format!(" (line {}, col {})", l.line_number, l.line_position))
            .unwrap_or_default();
        let text = format!("{:?}{location}: {}", msg.message_type, msg.message);
        match msg.message_type {
            wgpu::CompilationMessageType::Error => {
                errors += 1;
                debug::error(WGSL, &text);
            }
            wgpu::CompilationMessageType::Warning => {
                warnings += 1;
                debug::warn(WGSL, &text);
            }
            wgpu::CompilationMessageType::Info => dlog!(WGSL, "{text}"),
        }
    }
    format!(
        "{errors} error(s), {warnings} warning(s), {} message(s) total",
        info.messages.len()
    )
}
