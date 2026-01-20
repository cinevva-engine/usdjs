## `@cinevva/usdjs`

[![CI](https://github.com/cinevva-engine/usdjs/actions/workflows/ci.yml/badge.svg)](https://github.com/cinevva-engine/usdjs/actions/workflows/ci.yml)
[![Docs](https://github.com/cinevva-engine/usdjs/actions/workflows/docs.yml/badge.svg)](https://cinevva-engine.github.io/usdjs/)

A reference-quality OpenUSD implementation in pure TypeScript. We're building toward full spec correctness, verified against Pixar's source code.

It parses and serializes USDA (text), USDC (binary crate), and USDZ (package) files. The composition engine handles sublayers, references, payloads, variants, and inherits. It runs in modern browsers and Node.js without native addons or WebAssembly.

### The Goal

We want the definitive USD implementation for JavaScript. Not a "good enough" subset, but a correct, complete runtime you can trust for production workflows.

### How We Get There

**Corpus-driven development.** We test against real USD files from the USD Working Group, NVIDIA, Apple, and community assets. This keeps us focused on what actually matters while building toward completeness.

**Verified against Pixar source.** Our USDC parser is cross-referenced with Pixar's C++ implementation. When there's ambiguity in behavior, we match what OpenUSD does. See `src/usdc/PIXAR_PARITY.md` for the detailed mapping.

**Incremental correctness.** We'd rather have fewer features that work correctly than more features that work "mostly."

### Current State

The core is solid. USDA and USDC parsing handles real-world files from major DCC tools. Composition covers the patterns you'll encounter in production assets.

What's still in progress:

**Composition completeness.** Specializes, relocates, and value clips aren't implemented yet.

**Schema APIs.** Typed `UsdGeom` and `UsdShade` APIs are planned but not prioritized over core correctness.

**USDC writer.** Reading is mature. Writing covers common authoring cases but isn't at full parity.

**Security.** No formal audit yet. Sandbox untrusted files.

The API may change before 1.0 as we expand coverage and refine based on real usage.

### Install

Once published:

```bash
npm i @cinevva/usdjs
```

Until then, install from GitHub:

```bash
npm i github:cinevva/usdjs
```

### Quick start

```ts
import { UsdStage, parseUsdaToLayer, parseUsdcToLayer } from '@cinevva/usdjs';

// USDA (text)
const stageA = UsdStage.openUSDA(usdaText, 'scene.usda');

// USDC (binary)
const layerB = parseUsdcToLayer(usdcBytes, { identifier: 'scene.usdc' });
```

### Documentation

The docs cover features, formats, composition details, and how this compares to other approaches:

`docs/FEATURES.md` has the feature and support matrix.

`docs/FORMATS.md` explains USDA, USDC, and USDZ specifics.

`docs/COMPOSITION.md` covers what composition features work.

`docs/COMPARISON.md` puts this in context with WASM viewers, Three.js loaders, and native tools.

`docs/CORPUS_AND_LICENSES.md` explains the test files and their licenses.

`src/usdc/PIXAR_PARITY.md` documents how the USDC parser maps to Pixar's reference implementation.

### License

Code is MIT (see `LICENSE`).

Test corpora under `test/corpus/external/` remain under their own licenses. See `docs/CORPUS_AND_LICENSES.md` for details.
