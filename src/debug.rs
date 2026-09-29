//! Opt-in console logging of what happens under the hood.
//!
//! Categories are bit flags set from the Settings dialog (mirrored in
//! `web/js/debug.js`). Validation errors and device loss are always reported,
//! whatever the flags, because they mean something is actually broken.

use std::sync::atomic::{AtomicU32, Ordering};

/// Adapter, device, limits, surface configuration, resource creation.
pub const WGPU: u32 = 1 << 0;
/// Shader source, compilation messages, uniform layout.
pub const WGSL: u32 = 1 << 1;
/// One line per rendered frame: surface status and uniforms. Noisy.
pub const FRAME: u32 = 1 << 2;
/// Rust-side view of the JS↔Wasm boundary (calls into `Explorer`).
pub const WASM: u32 = 1 << 3;
/// wgpu's own `log` crate output (debug level).
pub const WGPU_INTERNAL: u32 = 1 << 4;

static FLAGS: AtomicU32 = AtomicU32::new(0);
static LOGGER: ConsoleLogger = ConsoleLogger;

pub fn set_flags(flags: u32) {
    FLAGS.store(flags, Ordering::Relaxed);
    log::set_max_level(if flags & WGPU_INTERNAL != 0 {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Warn
    });
}

pub fn flags() -> u32 {
    FLAGS.load(Ordering::Relaxed)
}

pub fn enabled(category: u32) -> bool {
    flags() & category != 0
}

/// Routes the `log` crate (used inside wgpu) to the browser console. Call once.
pub fn install_logger() {
    if log::set_logger(&LOGGER).is_ok() {
        log::set_max_level(log::LevelFilter::Warn);
    }
}

/// Logs `$($arg)*` under `$cat` only when that category is switched on.
/// The message is only formatted when it will actually be printed.
#[macro_export]
macro_rules! dlog {
    ($cat:expr, $($arg:tt)*) => {
        if $crate::debug::enabled($cat) {
            $crate::debug::line($cat, &format!($($arg)*));
        }
    };
}

/// Prints a collapsed console group: a one-line title with `body` inside.
pub fn group(category: u32, title: &str, body: &str) {
    if enabled(category) {
        force_group(category, title, body);
    }
}

pub fn line(category: u32, message: &str) {
    emit(Level::Log, category, message);
}

pub fn force_group(category: u32, title: &str, body: &str) {
    emit(Level::GroupStart, category, title);
    emit(Level::Log, 0, body);
    emit(Level::GroupEnd, 0, "");
}

pub fn warn(category: u32, message: &str) {
    emit(Level::Warn, category, message);
}

pub fn error(category: u32, message: &str) {
    emit(Level::Error, category, message);
}

fn tag(category: u32) -> (&'static str, &'static str) {
    match category {
        WGPU => ("wgpu", "#ffb347"),
        WGSL => ("wgsl", "#4fd1c5"),
        FRAME => ("frame", "#9aa3ad"),
        WASM => ("wasm", "#b794f4"),
        WGPU_INTERNAL => ("wgpu-log", "#f6ad55"),
        _ => ("fractal", "#57e389"),
    }
}

#[derive(Clone, Copy)]
enum Level {
    Log,
    Warn,
    Error,
    GroupStart,
    GroupEnd,
}

#[cfg(target_arch = "wasm32")]
fn emit(level: Level, category: u32, message: &str) {
    use wasm_bindgen::JsValue;
    use web_sys::console;

    if let Level::GroupEnd = level {
        console::group_end();
        return;
    }
    if category == 0 {
        console::log_1(&JsValue::from_str(message));
        return;
    }
    let (name, colour) = tag(category);
    let fmt = JsValue::from_str(&format!("%c[{name}]%c {message}"));
    let style = JsValue::from_str(&format!("color:{colour};font-weight:bold"));
    let reset = JsValue::from_str("");
    match level {
        Level::Log => console::log_3(&fmt, &style, &reset),
        Level::Warn => console::warn_3(&fmt, &style, &reset),
        Level::Error => console::error_3(&fmt, &style, &reset),
        Level::GroupStart => console::group_collapsed_3(&fmt, &style, &reset),
        Level::GroupEnd => unreachable!(),
    }
}

// Native builds (cargo test) have no browser console.
#[cfg(not(target_arch = "wasm32"))]
fn emit(level: Level, category: u32, message: &str) {
    let (name, _) = tag(category);
    match level {
        Level::GroupEnd => {}
        _ => eprintln!("[{name}] {message}"),
    }
}

struct ConsoleLogger;

impl log::Log for ConsoleLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::max_level()
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let message = format!("{} {}: {}", record.level(), record.target(), record.args());
        match record.level() {
            log::Level::Error => error(WGPU_INTERNAL, &message),
            log::Level::Warn => warn(WGPU_INTERNAL, &message),
            _ => line(WGPU_INTERNAL, &message),
        }
    }

    fn flush(&self) {}
}
