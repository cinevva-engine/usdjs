## `@cinevva/usdjs`

`@cinevva/usdjs` is a **pure TypeScript/JavaScript** implementation of a **practical subset** of **OpenUSD (USD)** core functionality:

- **USDA** (text) parsing + serialization
- **USDC** (“crate”, binary) parsing + *minimal* serialization
- **USDZ** parsing + writing utilities (browser-first)
- A small **composition layer** (“Pcp-lite”) targeting common real-world assets: sublayers, references/payloads, variants, inherits

It runs in **modern browsers** and **Node.js** and does **not** require native addons or WebAssembly.

### Status (brutally honest)

This is **not a full OpenUSD replacement**. It is intentionally small, corpus-driven, and biased toward “works on real files” over spec-completeness.

You should expect:

- **Incomplete composition**: no full Pcp prim indexing parity, no specializes/relocates/clips/value clips.
- **Minimal schema layer**: this is mostly **Sdf/Layers + composition + value decoding**. Typed `UsdGeom`/`UsdShade` APIs are not a goal (yet).
- **Minimal USDC writer**: reading is the priority; writing covers common cases we need, not full authoring parity.
- **API churn**: until 1.0, the public API may change based on real corpus findings.
- **No security audit**: don’t use this to process untrusted files in security-sensitive contexts without sandboxing.

If you need “everything USD”, use Pixar’s OpenUSD (native) or a WASM build.

### Install

Once published:

```bash
npm i @cinevva/usdjs
```

Until then, you can install from GitHub:

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

- **Feature / support matrix**: `docs/FEATURES.md`
- **Format notes (USDA/USDC/USDZ)**: `docs/FORMATS.md`
- **Composition notes**: `docs/COMPOSITION.md`
- **Comparisons (JS vs WASM vs Three.js loaders)**: `docs/COMPARISON.md`
- **Corpus + licensing notes**: `docs/CORPUS_AND_LICENSES.md`
- **USDC crate parity notes**: `src/usdc/PIXAR_PARITY.md`

### License

- Code: **MIT** (see `LICENSE`)
- Test corpora: external corpora under `test/corpus/external/` remain under their **own licenses** (see `docs/CORPUS_AND_LICENSES.md`).

