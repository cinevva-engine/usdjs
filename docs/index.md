---
layout: home

hero:
  name: "@cinevva/usdjs"
  text: Pure TypeScript OpenUSD
  tagline: Parse, compose, and serialize USD files in the browser—no WASM required.
  actions:
    - theme: brand
      text: Get Started
      link: /QUICKSTART
    - theme: alt
      text: View on GitHub
      link: https://github.com/cinevva-engine/usdjs

features:
  - icon: 📦
    title: All USD Formats
    details: Read USDA (text), USDC (binary crate), and USDZ (package). Write USDA and minimal USDC.
  - icon: 🔗
    title: Composition Engine
    details: Practical "Pcp-lite" supporting sublayers, references, payloads, variants, and inherits.
  - icon: 🌐
    title: Browser-First
    details: Zero native dependencies. Works in modern browsers and Node.js out of the box.
  - icon: ⚡
    title: Corpus-Driven
    details: Validated against real-world USD files from USD-WG, NVIDIA, and community assets.
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

### [@cinevva/usdjs-viewer](https://github.com/cinevva-engine/usdjs-viewer)
Three.js-based browser viewer for visual validation and debugging.

### [@cinevva/usdjs-renderer](https://github.com/cinevva-engine/usdjs-renderer)
Headless PNG rendering via Playwright for regression testing.

</div>

## Honest Assessment

This is **not** a full OpenUSD replacement. It's a practical subset for web applications:

- ✅ Works on real files from major DCC tools
- ✅ Handles common composition patterns
- ❌ No full Pcp prim indexing parity
- ❌ No UsdGeom/UsdShade typed APIs (yet)

If you need everything USD, use Pixar's native tools or a WASM build.

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
