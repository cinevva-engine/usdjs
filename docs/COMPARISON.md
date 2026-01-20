## Comparison table (community context)

This table is intentionally “engineering oriented”: it focuses on what you actually get when trying to use USD on the web.

### Summary

| Approach | Runs in browser | Native JS/TS | USDC | USDZ | Composition breadth | Notes |
|---|---:|---:|---:|---:|---:|---|
| **OpenUSD (C++ reference)** | ❌ | ❌ | ✅ | ✅ | ✅ | Gold standard; not browser-native. |
| **WASM OpenUSD viewers** | ✅ | ❌ | ✅ | ✅ | ✅/⚠️ | Great breadth; often needs COOP/COEP for threads. |
| **TinyUSDZ (C++/WASM)** | ✅ | ❌ | ✅ | ✅ | ⚠️ | Practical loader; composition/material breadth depends on build. |
| **Three.js `USDLoader`** | ✅ | ✅ | ⚠️ | ✅ | ❌/⚠️ | A good baseline for simple USDZ flows; not a full USD runtime. |
| **`@cinevva/usdjs` (this repo)** | ✅ | ✅ | ✅ | ✅ | ⚠️ | Targets a “useful subset” in pure JS/TS. |

### References

- OpenUSD formats / FAQ: `https://openusd.org/release/usdfaq.html`
- USDZ specification: `https://openusd.org/release/spec_usdz.html`
- Three.js USDLoader docs: `https://threejs.org/docs/pages/USDLoader.html`
- Needle USD viewer (OpenUSD in the browser): `https://github.com/needle-tools/usd-viewer`
- TinyUSDZ: `https://github.com/lighttransport/tinyusdz`
- Rust `openusd` crate USDC module (reference for crate structure): `https://docs.rs/openusd/latest/openusd/usdc/index.html`

