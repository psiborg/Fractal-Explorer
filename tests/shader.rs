//! Parses and validates the WGSL with naga, the same shader compiler wgpu uses,
//! so shader errors show up in `cargo test` instead of the browser console.

#[test]
fn fractal_wgsl_is_valid() {
    let source = concat!(
        include_str!("../shaders/df.wgsl"),
        "\n",
        include_str!("../shaders/fractal.wgsl")
    );
    let module = naga::front::wgsl::parse_str(source)
        .unwrap_or_else(|e| panic!("{}", e.emit_to_string(source)));
    naga::valid::Validator::new(
        naga::valid::ValidationFlags::all(),
        naga::valid::Capabilities::empty(),
    )
    .validate(&module)
    .unwrap_or_else(|e| panic!("{}", e.emit_to_string(source)));

    // The uniform struct must stay 96 bytes to match `view::Uniforms`.
    let params = module
        .types
        .iter()
        .find(|(_, t)| t.name.as_deref() == Some("Params"))
        .expect("Params struct");
    assert_eq!(params.1.inner.size(module.to_ctx()), 96);
}

#[test]
fn selftest_wgsl_is_valid() {
    let source = concat!(
        include_str!("../shaders/df.wgsl"),
        "\n",
        include_str!("../shaders/selftest.wgsl")
    );
    let module = naga::front::wgsl::parse_str(source)
        .unwrap_or_else(|e| panic!("{}", e.emit_to_string(source)));
    naga::valid::Validator::new(
        naga::valid::ValidationFlags::all(),
        naga::valid::Capabilities::empty(),
    )
    .validate(&module)
    .unwrap_or_else(|e| panic!("{}", e.emit_to_string(source)));
}
