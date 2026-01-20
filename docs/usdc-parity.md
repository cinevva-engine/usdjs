# USDC Parser Parity Notes

This document maps `@cinevva/usdjs`'s USDC (`.usdc`) decoding to Pixar's reference implementation in OpenUSD.

## Reference Files (Pixar/OpenUSD)

- **ValueRep / structural reader**: `pxr/usd/sdf/crateFile.h`, `pxr/usd/sdf/crateFile.cpp`
- **TypeEnum numeric values**: `pxr/usd/sdf/crateDataTypes.h`
- **Integer compression API**: `pxr/usd/sdf/integerCoding.h` (+ implementation in `integerCoding.cpp`)

All OpenUSD sources referenced below are from the `pixaranimationstudios/openusd` repo (branch `dev`).

---

## ValueRep: Bit Layout and Semantics

Pixar defines `Sdf_CrateFile::ValueRep` as a packed `uint64`:

| Bits | Name | Description |
|------|------|-------------|
| 63 | IsArray | Value is an array |
| 62 | IsInlined | Value is inlined in the payload |
| 61 | IsCompressed | Value uses compression |
| 60 | IsArrayEdit | Value is an array edit operation |
| 55..48 | TypeEnum | 8-bit type identifier |
| 47..0 | Payload | 48-bit payload (offset or inlined value) |

See `ValueRep` in `pxr/usd/sdf/crateFile.h`.

### In @cinevva/usdjs

We extract `type` with `(rep >> 48) & 0xFF` and flags with `(rep >> 56) & 0xFF`:

- `0x80` → array
- `0x40` → inlined
- `0x20` → compressed
- `0x10` → arrayEdit

Implementation: `src/usdc/parser.ts` (`decodeValueRep`).

---

## TypeEnum Numeric Values

Pixar's `crateDataTypes.h` defines the authoritative enum values (changing them breaks compatibility).

`@cinevva/usdjs` mirrors these values in its internal `ValueType` enum:

| Type | Value | Notes |
|------|-------|-------|
| `Invalid` | 0 | |
| `Bool` | 1 | |
| `UChar` | 2 | |
| `Int` | 3 | |
| `UInt` | 4 | |
| `Int64` | 5 | |
| `UInt64` | 6 | |
| `Half` | 7 | |
| `Float` | 8 | |
| `Double` | 9 | |
| `String` | 10 | |
| `Token` | 11 | |
| `AssetPath` | 12 | |
| `Matrix2d` | 13 | |
| `Matrix3d` | 14 | |
| `Matrix4d` | 15 | |
| `Quatd` | 16 | |
| `Quatf` | 17 | |
| `Quath` | 18 | |
| `Vec2d` | 19 | |
| `Vec2f` | 20 | |
| `Vec2h` | 21 | |
| `Vec2i` | 22 | |
| `Vec3d` | 23 | |
| `Vec3f` | 24 | |
| `Vec3h` | 25 | |
| `Vec3i` | 26 | |
| `Vec4d` | 27 | |
| `Vec4f` | 28 | |
| `Vec4h` | 29 | |
| `Vec4i` | 30 | |
| `Dictionary` | 31 | |
| `TokenListOp` | 32 | |
| `StringListOp` | 33 | |
| `PathListOp` | 34 | |
| `ReferenceListOp` | 35 | |
| `IntListOp` | 36 | |
| `Int64ListOp` | 37 | |
| `UIntListOp` | 38 | |
| `UInt64ListOp` | 39 | |
| `PathVector` | 40 | |
| `TokenVector` | 41 | |
| `Specifier` | 42 | |
| `Permission` | 43 | |
| `Variability` | 44 | |
| `VariantSelectionMap` | 45 | |
| `TimeSamples` | 46 | |
| `Payload` | 47 | |
| `DoubleVector` | 48 | |
| `LayerOffsetVector` | 49 | |
| `StringVector` | 50 | |
| `ValueBlock` | 51 | |
| `Value` | 52 | |
| `UnregisteredValue` | 53 | |
| `UnregisteredValueListOp` | 54 | |
| `PayloadListOp` | 55 | |

---

## Structural Sections

Pixar's `CrateFile::_ReadStructuralSections()` reads:

| Section | Description |
|---------|-------------|
| `TOKENS` | Token strings (compressed in newer versions) |
| `STRINGS` | `TokenIndex[]` indirection table |
| `FIELDS` | `Field{TokenIndex, ValueRep}` pairs |
| `FIELDSETS` | Runs of `FieldIndex` terminated by default index |
| `PATHS` | Compressed path tree arrays |
| `SPECS` | Compressed specs arrays |

See `pxr/usd/sdf/crateFile.cpp` (`_ReadTokens`, `_ReadStrings`, `_ReadFields`, `_ReadFieldSets`, `_ReadCompressedPaths`, `_ReadSpecs`).

In `@cinevva/usdjs`, these are handled in `src/usdc/parser.ts` via `readTokens/readStrings/readFields/readFieldSets/readPaths/readSpecs`.

---

## TimeSamples Encoding

Pixar encodes `TimeSamples` as:

1. **int64**: relative offset to the `timesRep` ValueRep
2. At `timesRep`: **ValueRep** for the times container (typically `DoubleVector`)
3. **int64**: relative offset to the values area
4. At values area: **uint64 numValues**, then **numValues contiguous ValueRep**

See `CrateFile::_Reader::Read<TimeSamples>()` in `pxr/usd/sdf/crateFile.cpp`.

### In @cinevva/usdjs

- We decode this layout and materialize a `Map<number, SdfValue>` attached to `SdfPropertySpec.timeSamples`
- We match the observable USDA shape `usdcat` produces for stable comparisons

Implementation: `src/usdc/parser.ts` (`ValueType.TimeSamples` case + `addProperty` wiring).

---

## Compressed Float/Double Arrays (Crate 0.6.0+)

Pixar supports compressed floating point arrays using:

| Code | Method |
|------|--------|
| `'i'` | Floats stored as compressed int32s |
| `'t'` | Lookup table + compressed indexes |

See `_ReadPossiblyCompressedArray()` specializations in `pxr/usd/sdf/crateFile.cpp`.

In `@cinevva/usdjs`, we implement the same format for `float[]` and `double[]` and validate against the external corpus.

---

## Known Gaps (Intentional)

- **ArrayEdits** (`ValueRep::IsArrayEdit`): not decoded as a first-class value yet
- Some `TypeEnum` cases not exercised by our corpus are not fully implemented (e.g., `Spline`, `Relocates`)

These will be addressed as real-world files requiring them are encountered.
