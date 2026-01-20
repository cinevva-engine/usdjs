## Feature / support matrix

This is a **practical** compatibility matrix for `@cinevva/usdjs`. It’s intended to answer “will my USD file work?” rather than restate the full OpenUSD spec.

### Formats

| Format | Read | Write | Notes |
|---|---:|---:|---|
| **USDA** (`.usda`, text) | ✅ | ✅ | Parser + serializer. Intended for diff-friendly round-trips. |
| **USD** (`.usd`) | ✅ | ✅ | `.usd` is treated as either USDA (text) or USDC (binary) depending on header (`PXR-USDC`). |
| **USDC** (`.usdc`, “crate”) | ✅ | ⚠️ | Reader aims for real-world compatibility; writer is minimal (covers common authoring types we need). |
| **USDZ** (`.usdz`) | ✅ | ✅ | Browser-first ZIP parsing/writing utilities; see `docs/FORMATS.md`. |

### Composition (“Pcp-lite”)

| Feature | Status | Notes |
|---|---:|---|
| Sublayers (`subLayers`) | ✅ | Strength ordering supported. |
| References | ✅ | Common patterns supported. |
| Payloads | ✅ | Supported in the “arc expansion” path; large-scene streaming policies are out of scope here. |
| Variants (`variantSets`, `variants` selection) | ✅ | Applies variant selections from metadata. |
| Inherits (`inherits`) | ✅ | Supported (internal class opinions). |
| Specializes | ❌ | Not implemented. |
| Relocates | ❌ | Not implemented. |
| Value clips | ❌ | Not implemented. |
| Full Pcp prim indexing | ❌ | Goal is “useful subset”, not full parity. |

### Schema / interpretation

`@cinevva/usdjs` is primarily an **SDF/Layers + composition + value decoding** library. Schema-level interpretation is intentionally minimal.

| Area | Status | Notes |
|---|---:|---|
| SdfPath | ✅ | Core path canonicalization utilities. |
| SdfLayer in-memory model | ✅ | Prims/properties/metadata + timeSamples. |
| UsdStage convenience API | ✅ | Helpers for opening files and composing with resolvers. |
| UsdGeom typed API | ❌ | Not provided as a full schema layer (yet). |
| UsdShade typed API | ❌ | Not provided as a full schema layer (yet). |
| MaterialX parsing | ✅ | Minimal MaterialX XML → layer parsing (for practical viewer workflows). |

### Value types (high-level)

| Category | Status | Notes |
|---|---:|---|
| Scalars (bool/int/float/double/string/token/asset) | ✅ | Used heavily in real corpora. |
| Tuples / vectors | ✅ | Float and double tuples used for points/normals/colors/etc. |
| Matrices | ✅ | Matrix4d supported. |
| Arrays (numeric + token/path arrays) | ✅ | Includes compressed float/double arrays in USDC where used by corpora. |
| Dictionaries | ✅ | Encoded/decoded as structured objects. |
| ListOps (references/payloads/path list ops) | ✅ | Practical subset used in real assets. |
| Array edits (`ValueRep::IsArrayEdit`) | ❌ | Parsed as raw values; not represented as first-class array edits. |

### Environments

| Environment | Status | Notes |
|---|---:|---|
| Browser (modern) | ✅ | Designed for browser-first parsing and utilities. |
| Node.js | ✅ | Used for tests and tooling. |
| WASM required | ❌ | Not required. |

