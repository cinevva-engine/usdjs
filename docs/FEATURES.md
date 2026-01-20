# Feature Roadmap

We're building toward complete OpenUSD parity. This page tracks what's done, what's in progress, and what's planned.

Each feature is verified against Pixar's reference implementation. When behavior is ambiguous, we match what OpenUSD does.

## Formats

| Format | Read | Write | Notes |
|---|---:|---:|---|
| **USDA** (`.usda`, text) | ✅ | ✅ | Parser + serializer. Designed for diff-friendly round-trips. |
| **USD** (`.usd`) | ✅ | ✅ | Treated as either USDA (text) or USDC (binary) depending on header (`PXR-USDC`). |
| **USDC** (`.usdc`, "crate") | ✅ | ⚠️ | Reader aims for real-world compatibility. Writer is minimal and covers common authoring types. |
| **USDZ** (`.usdz`) | ✅ | ✅ | Browser-first ZIP parsing/writing utilities. See `docs/FORMATS.md` for details. |

## Composition

We're implementing full Pcp (Prim composition) behavior. Current status:

| Feature | Status | Notes |
|---|---:|---|
| Sublayers (`subLayers`) | ✅ Done | Strength ordering matches OpenUSD. |
| References | ✅ Done | Internal and external references. |
| Payloads | ✅ Done | Sync expansion. Streaming policies planned. |
| Variants (`variantSets`, `variants`) | ✅ Done | Selection and expansion. |
| Inherits (`inherits`) | ✅ Done | Class opinion inheritance. |
| Specializes | 🔜 Planned | On roadmap. |
| Relocates | 🔜 Planned | On roadmap. |
| Value clips | 🔜 Planned | On roadmap. |
| Full Pcp prim indexing | 🔄 In progress | Incremental work toward full parity. |

## Schema APIs

The core runtime (SDF/Layers + composition + value decoding) is the foundation. Typed schema APIs come next.

| Area | Status | Notes |
|---|---:|---|
| SdfPath | ✅ Done | Path parsing, canonicalization, utilities. |
| SdfLayer in-memory model | ✅ Done | Prims, properties, metadata, timeSamples. |
| UsdStage convenience API | ✅ Done | File loading, composition, resolver integration. |
| UsdGeom typed API | 🔜 Planned | Mesh, Xform, Camera, etc. |
| UsdShade typed API | 🔜 Planned | Material, Shader, etc. |
| UsdSkel typed API | 🔜 Planned | Skeleton, animation. |
| MaterialX parsing | ✅ Done | XML to layer conversion for material workflows. |

## Value Types

| Category | Status | Notes |
|---|---:|---|
| Scalars (bool/int/float/double/string/token/asset) | ✅ Done | Full support. |
| Tuples / vectors | ✅ Done | All vec2/3/4 variants, float and double. |
| Matrices | ✅ Done | Matrix4d, verified against OpenUSD. |
| Arrays (numeric + token/path arrays) | ✅ Done | Including USDC compression. |
| Dictionaries | ✅ Done | Nested dictionary support. |
| ListOps (references/payloads/path list ops) | ✅ Done | Prepend, append, delete semantics. |
| Array edits (`ValueRep::IsArrayEdit`) | 🔜 Planned | Currently parsed as raw values. |

## Environments

| Environment | Status | Notes |
|---|---:|---|
| Browser (modern) | ✅ | Designed for browser-first parsing and utilities. |
| Node.js | ✅ | Used for tests and tooling. |
| WASM required | ❌ | Not required. Pure JS/TS. |
