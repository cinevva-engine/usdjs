# @cinevva/usdjs Documentation

**Pure TypeScript/JavaScript OpenUSD (USD) implementation**

This documentation covers the core `@cinevva/usdjs` library—a browser-first, engine-agnostic USD parser and composition engine.

---

## Quick Navigation

| Document | Description |
|----------|-------------|
| [**QUICKSTART.md**](./QUICKSTART.md) | Get running in 5 minutes |
| [**API.md**](./API.md) | Complete API reference with examples |
| [**ARCHITECTURE.md**](./ARCHITECTURE.md) | Codebase structure for contributors |
| [**FEATURES.md**](./FEATURES.md) | Feature/support matrix |
| [**FORMATS.md**](./FORMATS.md) | USDA/USDC/USDZ format details |
| [**COMPOSITION.md**](./COMPOSITION.md) | Composition engine ("Pcp-lite") |
| [**COMPARISON.md**](./COMPARISON.md) | How this compares to alternatives |
| [**CORPUS_AND_LICENSES.md**](./CORPUS_AND_LICENSES.md) | Test corpus and third-party licenses |

### Implementation Details

| Document | Description |
|----------|-------------|
| [**../src/usdc/PIXAR_PARITY.md**](../src/usdc/PIXAR_PARITY.md) | USDC binary format parity notes |

---

## What is @cinevva/usdjs?

`@cinevva/usdjs` provides:

1. **Format Parsing**: Read USDA (text), USDC (binary "crate"), and USDZ (package) files
2. **Composition**: A practical subset of USD's composition engine (sublayers, references, payloads, variants, inherits)
3. **Value Decoding**: Scalars, vectors, matrices, arrays, time samples, dictionaries
4. **Serialization**: Write USDA text and minimal USDC binary

All in **pure TypeScript/JavaScript**—no native bindings, no WebAssembly required.

---

## Design Philosophy

### Corpus-Driven Development

Every feature is validated against real-world USD files from:
- USD Working Group assets
- NVIDIA tutorials and industrial samples
- Omniverse scene templates
- FT-Lab samples (Japanese VRM/VRChat community)

If a file from the real world doesn't parse correctly, that's a bug.

### Practical Subset

We implement what real assets need, not the full OpenUSD spec. This means:

- ✅ Sublayers, references, payloads, variants, inherits
- ✅ Common value types (scalars, vectors, matrices, arrays, time samples)
- ✅ USDC compressed arrays (floats, doubles, integers)
- ❌ Full Pcp prim indexing parity
- ❌ Specializes, relocates, value clips
- ❌ Full UsdGeom/UsdShade typed APIs

### Browser-First

The library is designed for browser environments:
- No Node.js-specific APIs in core paths
- Streaming-friendly parsing where possible
- Works with modern browsers' native APIs (TextDecoder, DecompressionStream)

---

## Getting Started

```bash
npm install @cinevva/usdjs
```

```typescript
import { UsdStage } from '@cinevva/usdjs';

// Open a USDA file
const stage = UsdStage.openUSDA(usdaText, 'scene.usda');

// List all prims
for (const path of stage.listPrimPaths()) {
  console.log(path);
}
```

See [QUICKSTART.md](./QUICKSTART.md) for more examples.

---

## Ecosystem

| Package | Purpose |
|---------|---------|
| **@cinevva/usdjs** | Core parsing, composition, serialization |
| **@cinevva/usdjs-viewer** | Three.js-based browser viewer |
| **@cinevva/usdjs-renderer** | Headless PNG rendering (Playwright) |

---

## License

MIT. See [LICENSE](../LICENSE).

Test corpora under `test/corpus/external/` retain their original licenses.
