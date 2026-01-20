# Comparison

How does `@cinevva/usdjs` compare to other USD implementations?

## Our Position

We're building a **reference-quality USD implementation in pure TypeScript**. The goal is spec-correct behavior, verified against Pixar's source code.

Most browser USD solutions fall into two camps: WASM ports (full-featured but complex to deploy) or simple loaders (easy but incomplete). We're aiming for a third option: native JavaScript with full correctness.

## Comparison

| Approach | Browser | Native JS | USDC | Composition | Notes |
|---|---:|---:|---:|---:|---|
| **Pixar OpenUSD** | ❌ | ❌ | ✅ | ✅ | The reference. What we verify against. |
| **WASM OpenUSD** | ✅ | ❌ | ✅ | ✅ | Full-featured. Needs COOP/COEP headers. |
| **TinyUSDZ** | ✅ | ❌ | ✅ | ⚠️ | C++/WASM loader. Good for viewing. |
| **Three.js USDLoader** | ✅ | ✅ | ⚠️ | ❌ | Simple USDZ loading. Not a runtime. |
| **@cinevva/usdjs** | ✅ | ✅ | ✅ | 🔄 | Aiming for full parity. Pure TS. |

🔄 = actively expanding toward full parity

## References

[OpenUSD formats / FAQ](https://openusd.org/release/usdfaq.html)

[USDZ specification](https://openusd.org/release/spec_usdz.html)

[Three.js USDLoader docs](https://threejs.org/docs/pages/USDLoader.html)

[Needle USD viewer (OpenUSD in the browser)](https://github.com/needle-tools/usd-viewer)

[TinyUSDZ](https://github.com/lighttransport/tinyusdz)

[Rust `openusd` crate USDC module](https://docs.rs/openusd/latest/openusd/usdc/index.html)
