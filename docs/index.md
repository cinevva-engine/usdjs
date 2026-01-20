---
layout: home

hero:
  name: "@cinevva/usdjs"
  text: Reference-Quality OpenUSD
  tagline: A spec-correct USD implementation in pure TypeScript. Verified against Pixar source.
  actions:
    - theme: brand
      text: Get Started
      link: /QUICKSTART
    - theme: alt
      text: View on GitHub
      link: https://github.com/cinevva-engine/usdjs

features:
  - icon: 🎯
    title: Spec-Correct
    details: We verify behavior against Pixar's C++ implementation. When there's ambiguity, we match OpenUSD.
  - icon: 📦
    title: All USD Formats
    details: Read and write USDA (text), USDC (binary crate), and USDZ (package). No WASM required.
  - icon: 🔗
    title: Full Composition
    details: Sublayers, references, payloads, variants, and inherits. Working toward complete Pcp parity.
  - icon: ⚡
    title: Corpus-Validated
    details: Tested against real files from USD-WG, NVIDIA, Apple, and community assets.
---

## Quick Example

```typescript
import { UsdStage } from '@cinevva/usdjs';

// Parse a USDA file
const stage = UsdStage.openUSDA(`#usda 1.0
def Xform "World" {
    def Mesh "Cube" {
        float3[] points = [(-1,-1,-1), (1,1,1)]
    }
}`);

// List all prims
console.log(stage.listPrimPaths());
// ['/', '/World', '/World/Cube']
```

## Installation

```bash
npm install @cinevva/usdjs
```

## What's Supported

| Feature | Status |
|---------|--------|
| USDA parsing | ✅ Full |
| USDC parsing | ✅ Real-world compatible |
| USDZ parsing | ✅ Full |
| Sublayers | ✅ |
| References | ✅ |
| Payloads | ✅ |
| Variants | ✅ |
| Inherits | ✅ |
| Specializes | ❌ Not yet |
| Value clips | ❌ Not yet |

## Ecosystem

<div class="ecosystem-cards">

### [@cinevva/usdjs-viewer](https://cinevva-engine.github.io/usdjs-viewer/)
Three.js-based browser viewer for visual validation and debugging.

### [@cinevva/usdjs-renderer](https://cinevva-engine.github.io/usdjs-renderer/)
Headless PNG rendering via Playwright for regression testing.

</div>

## Current Progress

The core runtime is solid and handles production files from major DCC tools. We're actively working toward full OpenUSD parity.

**Done:** USDA/USDC/USDZ parsing, sublayers, references, payloads, variants, inherits.

**In progress:** Specializes, relocates, value clips, full Pcp prim indexing.

**Planned:** Typed UsdGeom/UsdShade APIs, complete USDC write support.

See [FEATURES.md](/FEATURES) for the full roadmap.

<style>
.ecosystem-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 1rem;
  margin-top: 1.5rem;
}

.ecosystem-cards h3 {
  margin-top: 0;
}
</style>
