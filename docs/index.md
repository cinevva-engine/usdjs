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
  - title: Spec-Correct
    details: Behavior verified against Pixar's C++ implementation. When there's ambiguity, we match OpenUSD.
    icon:
      src: /icons/check-circle.svg
  - title: All USD Formats
    details: Read and write USDA (text), USDC (binary crate), and USDZ (package). No WASM required.
    icon:
      src: /icons/file-stack.svg
  - title: Full Composition
    details: Sublayers, references, payloads, variants, and inherits. Working toward complete Pcp parity.
    icon:
      src: /icons/layers.svg
  - title: Corpus-Validated
    details: Tested against real files from USD-WG, NVIDIA, Apple, and community assets.
    icon:
      src: /icons/shield-check.svg
---

## Try It Live

See `@cinevva/usdjs` in action with the full Three.js-based viewer:

<UsdPlayground />

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

| Category | Feature | Status | Details |
|----------|---------|:------:|---------|
| **Formats** | USDA (text) | <span class="status-badge status-done">Done</span> | Full parser and serializer with round-trip fidelity |
| | USDC (binary) | <span class="status-badge status-done">Done</span> | Handles Blender, Maya, Houdini exports |
| | USDZ (package) | <span class="status-badge status-done">Done</span> | Browser-native ZIP extraction |
| **Composition** | Sublayers | <span class="status-badge status-done">Done</span> | Recursive stacking with correct LIVRPS ordering |
| | References | <span class="status-badge status-done">Done</span> | Internal and external with default prim support |
| | Payloads | <span class="status-badge status-done">Done</span> | Synchronous expansion on stage open |
| | Variants | <span class="status-badge status-done">Done</span> | Full variantSets and selection |
| | Inherits | <span class="status-badge status-done">Done</span> | Class-based opinion inheritance |
| | Specializes | <span class="status-badge status-planned">Planned</span> | On roadmap |
| | Value clips | <span class="status-badge status-planned">Planned</span> | On roadmap |
| **Value Types** | Scalars, vectors, matrices | <span class="status-badge status-done">Done</span> | All GfVec/GfMatrix types |
| | Arrays + compression | <span class="status-badge status-done">Done</span> | LZ4 + delta encoding for USDC |

<div class="feature-link">
  <a href="./FEATURES">View Full Features Matrix →</a>
</div>

## Ecosystem

<div class="ecosystem-cards">
  <div class="ecosystem-card">
    <h3><a href="https://cinevva-engine.github.io/usdjs-viewer/">@cinevva/usdjs-viewer</a></h3>
    <p>Three.js-based browser viewer for visual validation and debugging.</p>
  </div>
  <div class="ecosystem-card">
    <h3><a href="https://cinevva-engine.github.io/usdjs-renderer/">@cinevva/usdjs-renderer</a></h3>
    <p>Headless PNG rendering via Playwright for regression testing.</p>
  </div>
</div>

## Current Progress

The core runtime is solid and handles production files from major DCC tools. We're actively working toward full OpenUSD parity.

**Done:** USDA/USDC/USDZ parsing, sublayers, references, payloads, variants, inherits.

**In progress:** Specializes, relocates, value clips, full Pcp prim indexing.

**Planned:** Typed UsdGeom/UsdShade APIs, complete USDC write support.

<style>
.ecosystem-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 1rem;
  margin-top: 1.5rem;
}

.ecosystem-card {
  padding: 1rem 1.25rem;
  background: var(--vp-c-bg-soft);
  border-radius: 8px;
  border: 1px solid var(--vp-c-divider);
}

.ecosystem-card h3 {
  margin-top: 0;
  margin-bottom: 0.5rem;
}

.ecosystem-card p {
  margin: 0;
  color: var(--vp-c-text-2);
}

.ecosystem-card a {
  color: var(--vp-c-brand-1);
  text-decoration: none;
}

.ecosystem-card a:hover {
  text-decoration: underline;
}

.feature-link {
  margin-top: 1.5rem;
  text-align: center;
}

.feature-link a {
  display: inline-block;
  padding: 0.6rem 1.25rem;
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-brand-1);
  border-radius: 8px;
  color: var(--vp-c-brand-1);
  font-weight: 600;
  text-decoration: none;
  transition: all 0.15s ease;
}

.feature-link a:hover {
  background: var(--vp-c-brand-1);
  color: white;
}
</style>
