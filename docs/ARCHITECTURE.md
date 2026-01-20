# Architecture Guide

This document describes the internal structure of `@cinevva/usdjs` for contributors and integrators.

---

## Directory Structure

```
src/
├── index.ts              # Public exports
├── sdf/
│   ├── layer.ts          # SdfLayer, SdfPrimSpec, SdfValue types
│   └── path.ts           # SdfPath parsing and utilities
├── usda/
│   ├── lexer.ts          # USDA tokenizer
│   ├── parser.ts         # USDA -> SdfLayer parser
│   └── serializer.ts     # SdfLayer -> USDA text
├── usdc/
│   ├── parser.ts         # USDC binary parser
│   ├── serializer.ts     # SdfLayer -> USDC binary (minimal)
│   └── PIXAR_PARITY.md   # Binary format parity notes
├── usdz/
│   ├── parser.ts         # USDZ package parser
│   └── writer.ts         # USDZ package writer
├── usd/
│   ├── stage.ts          # UsdStage high-level API
│   ├── compose.ts        # Layer composition utilities
│   ├── composedView.ts   # Structural-sharing composed view
│   └── resolver.ts       # Asset path resolution
├── materialx/
│   └── parser.ts         # MaterialX XML -> SdfLayer (experimental)
└── worker/
    ├── rpc.ts            # Worker RPC utilities
    └── usd-core-worker.ts # Web Worker entry point
```

---

## Core Abstractions

### SdfLayer

The fundamental data structure. A layer is an in-memory representation of a USD file containing:

- **metadata**: Layer-level data (`defaultPrim`, `upAxis`, `subLayers`, etc.)
- **root**: A pseudo-root prim at `/` containing the prim hierarchy
- **prims**: Nested `SdfPrimSpec` objects with properties and children

```
SdfLayer
├── identifier: string
├── metadata: Record<string, SdfValue>
└── root: SdfPrimSpec
    ├── path: SdfPath
    ├── specifier: 'def' | 'over' | 'class'
    ├── typeName?: string
    ├── metadata?: Record<string, SdfValue>
    ├── properties?: Map<string, SdfPropertySpec>
    ├── children?: Map<string, SdfPrimSpec>
    └── variantSets?: Map<string, SdfVariantSetSpec>
```

### SdfPath

Represents a USD path. Two kinds:
- **Prim paths**: `/World/Mesh`
- **Property paths**: `/World/Mesh.points` or `/World/Mesh.points.connect`

The parser validates and canonicalizes paths. Use `SdfPath.parse()` for user input.

### SdfValue

A tagged union representing all USD value types. The `type` discriminator indicates how to interpret `value`:

| Type | Example |
|------|---------|
| `token` | `{ type: 'token', value: 'UsdPreviewSurface' }` |
| `asset` | `{ type: 'asset', value: '@./texture.png@' }` |
| `sdfpath` | `{ type: 'sdfpath', value: '</World/Mesh>' }` |
| `vec3f` | `{ type: 'vec3f', value: [1, 2, 3] }` |
| `matrix4d` | `{ type: 'matrix4d', value: [...16 numbers...] }` |
| `array` | `{ type: 'array', elementType: 'float', value: [...] }` |
| `typedArray` | `{ type: 'typedArray', elementType: 'float', value: Float32Array }` |
| `dict` | `{ type: 'dict', value: { key: ... } }` |

---

## Parsing Pipeline

### USDA (Text)

```
USDA Text → Lexer → Token Stream → Parser → SdfLayer
```

1. **Lexer** (`usda/lexer.ts`): Tokenizes USDA text into tokens (keywords, identifiers, numbers, strings, punctuation)
2. **Parser** (`usda/parser.ts`): Consumes tokens, builds `SdfPrimSpec` tree, handles metadata and properties

The parser is hand-written recursive descent. Key design choices:
- Single-pass (no AST intermediate)
- Preserves unknown metadata for round-trip fidelity
- Uses `typedArray` for large numeric arrays (memory optimization)

### USDC (Binary)

```
USDC Bytes → Header → Sections → Value Decoding → SdfLayer
```

1. **Header**: Validate magic (`PXR-USDC`), read version and table of contents
2. **Sections**: Read structural sections (TOKENS, STRINGS, FIELDS, FIELDSETS, PATHS, SPECS)
3. **Value Decoding**: Decode `ValueRep` packed uint64s into `SdfValue`

See `src/usdc/PIXAR_PARITY.md` for detailed bit-level documentation.

### USDZ (Package)

```
USDZ Bytes → ZIP Parser → Find Root Layer → Parse (USDA/USDC) → SdfLayer
```

USDZ is a ZIP with constraints:
- Stored (uncompressed) entries only
- 64-byte alignment for efficient memory mapping
- Root layer is typically first `.usd`/`.usda`/`.usdc` entry

---

## Composition Engine ("Pcp-lite")

The composition engine implements a practical subset of USD's Pcp (Prim composition):

### Layer Stack Composition

```typescript
// Layers are composed weak-to-strong
const composed = composeLayerStack([weakLayer, strongLayer], 'result.usda');
```

Composition merges:
- **Prim opinions**: Stronger specifiers win, metadata merges
- **Properties**: Stronger defaults/timeSamples win
- **Children**: Union of children, recursively composed

### Arc Expansion

`composePrimIndexWithResolver()` handles external arcs:

1. **References**: `prepend references = @./other.usda@</SomePrim>`
2. **Payloads**: `prepend payload = @./heavy.usda@`
3. **Variants**: `variants = { "lod" = "high" }`
4. **Inherits**: `prepend inherits = </SomeClass>`

**Not implemented:**
- Specializes
- Relocates
- Value clips

### Structural Sharing (LayerView)

For performance, `composePrimIndexWithResolver` returns a `LayerView` that shares structure with source layers rather than cloning the entire prim graph.

---

## Memory Considerations

### TypedArrays for Numeric Data

Large arrays (vertices, normals, UVs) use `Float32Array`/`Float64Array` instead of `number[]`:

```typescript
// Memory-efficient representation
{ type: 'typedArray', elementType: 'point3f', value: Float32Array }
```

This reduces GC pressure and memory footprint by ~4-8x for large meshes.

### Lazy Parsing

USDC parser can defer value decoding. Large timeSamples and array values are decoded on-demand when possible.

---

## Threading Model

The library is designed for use in Web Workers:

```
Main Thread                     Worker Thread
     │                               │
     │  postMessage(usdcBuffer)      │
     │ ─────────────────────────────>│
     │                               │ parseUsdcToLayer()
     │                               │ compose()
     │  postMessage(composed)        │
     │<───────────────────────────── │
     │                               │
```

`src/worker/` contains RPC utilities for this pattern.

---

## Serialization

### USDA Output

`serializeLayerToUsda()` produces human-readable, diff-friendly USDA:
- Consistent indentation
- Canonical property ordering
- Round-trip compatible (parse → modify → serialize → parse should yield equivalent data)

### USDC Output

`serializeLayerToUsdc()` is **minimal**—it writes valid USDC but doesn't implement:
- All TypeEnum cases
- Compression
- Optimized layout

Use USDA serialization unless you specifically need binary output.

---

## Error Handling

The library throws on parse errors with position information:

```typescript
try {
    parseUsdaToLayer(badUsda);
} catch (e) {
    // Error message includes line/column
    console.error(e.message);
}
```

For binary formats, errors include byte offsets where relevant.

---

## Extension Points

### Custom Resolvers

Implement `UsdResolver` to customize asset loading:

```typescript
const myResolver: UsdResolver = {
    async readText(assetPath, fromIdentifier) {
        // Custom logic: CDN, local cache, virtual filesystem, etc.
        return { text, identifier };
    }
};
```

### MaterialX Integration

`parseMaterialXToLayer()` converts MaterialX XML to USD layers. This is experimental and covers common material patterns.

---

## Testing Strategy

### Unit Tests (`test/unit/`)

Test individual functions and edge cases:
- Lexer token sequences
- Parser constructs
- Path parsing
- Value encoding/decoding

### Corpus Tests (`test/corpus/`)

Validate against real-world files:
- USD Working Group assets
- NVIDIA samples
- FT-Lab (Japanese VRM/VRChat community)

If corpus tests fail, it's likely a real compatibility issue.

### Performance Tests (`test/perf/`)

Benchmark critical paths:
- Large file parsing
- Composition
- Memory usage

---

## Contributing

1. **Find a real file** that demonstrates the issue
2. **Add a minimal test** reproducing the problem
3. **Fix the code** with the smallest possible change
4. **Verify** against the full corpus

See [CONTRIBUTING.md](https://github.com/cinevva-engine/usdjs/blob/main/CONTRIBUTING.md) for details.
