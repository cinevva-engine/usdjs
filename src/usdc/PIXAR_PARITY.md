### USDC parser Pixar parity notes

This document maps `usdjs`’s USDC (`.usdc`) decoding to Pixar’s reference implementation in OpenUSD.

#### Reference files (Pixar/OpenUSD)
- **ValueRep / structural reader**: `pxr/usd/sdf/crateFile.h`, `pxr/usd/sdf/crateFile.cpp`
- **TypeEnum numeric values**: `pxr/usd/sdf/crateDataTypes.h`
- **Integer compression API**: `pxr/usd/sdf/integerCoding.h` (+ implementation in `integerCoding.cpp`)

All OpenUSD sources referenced below are from the `pixaranimationstudios/openusd` repo (branch `dev`).

---

## ValueRep: bit layout and semantics

Pixar defines `Sdf_CrateFile::ValueRep` as a packed `uint64`:

- **bits 63..60**: flags
  - **IsArray**: bit 63
  - **IsInlined**: bit 62
  - **IsCompressed**: bit 61
  - **IsArrayEdit**: bit 60
- **bits 55..48**: `TypeEnum` (8-bit)
- **bits 47..0**: payload (48-bit)

See `ValueRep` in `pxr/usd/sdf/crateFile.h`.

In `usdjs`:
- We extract `type` with \((rep >> 48) & 0xFF\)
- We extract flags with \((rep >> 56) & 0xFF\), then interpret:
  - `0x80` array, `0x40` inlined, `0x20` compressed, `0x10` arrayEdit

Implementation: `packages/usdjs/src/usdc/parser.ts` (`decodeValueRep`).

---

## TypeEnum numeric values

Pixar’s `crateDataTypes.h` defines the authoritative enum values (changing them breaks compatibility).

`usdjs` mirrors these values in its internal `ValueType` enum (e.g. `TimeSamples=46`, `DoubleVector=48`).

---

## Structural sections (TOKENS/STRINGS/FIELDS/FIELDSETS/PATHS/SPECS)

Pixar’s `CrateFile::_ReadStructuralSections()` reads:
- `TOKENS`: token strings (compressed in newer versions)
- `STRINGS`: `TokenIndex[]` indirection table (strings are tokens)
- `FIELDS`: `Field{TokenIndex, ValueRep}` (compressed in newer versions)
- `FIELDSETS`: runs of `FieldIndex` terminated by a default index (compressed in newer versions)
- `PATHS`: compressed path tree arrays (pathIndexes / elementTokenIndexes / jumps)
- `SPECS`: compressed specs arrays (pathIndexes / fieldSetIndexes / specTypes)

See `pxr/usd/sdf/crateFile.cpp` (`_ReadTokens`, `_ReadStrings`, `_ReadFields`, `_ReadFieldSets`,
`_ReadCompressedPaths`, `_ReadSpecs`).

In `usdjs`, these are handled in `packages/usdjs/src/usdc/parser.ts` via `readTokens/readStrings/readFields/readFieldSets/readPaths/readSpecs`.

---

## TimeSamples encoding

Pixar encodes `TimeSamples` as:

- **int64**: relative offset to the `timesRep` ValueRep
- at `timesRep`: **ValueRep** for the times container (typically `DoubleVector`, i.e. `std::vector<double>`)
- **int64**: relative offset to the values area
- at values area: **uint64 numValues**, then **numValues contiguous ValueRep**

See `CrateFile::_Reader::Read<TimeSamples>()` in `pxr/usd/sdf/crateFile.cpp`.

In `usdjs`:
- We decode this layout and materialize a `Map<number, SdfValue>` attached to `SdfPropertySpec.timeSamples`.
- We intentionally match the *observable* USDA shape `usdcat` produces for stable comparisons.

Implementation: `packages/usdjs/src/usdc/parser.ts` (`ValueType.TimeSamples` case + `addProperty` wiring).

---

## Compressed float/double arrays (crate 0.6.0+)

Pixar supports compressed floating point arrays using:
- `'i'`: floats stored as compressed int32s
- `'t'`: lookup table + compressed indexes

See `_ReadPossiblyCompressedArray()` specializations in `pxr/usd/sdf/crateFile.cpp`.

In `usdjs`, we implement the same format for `float[]` and `double[]` and validate it against the external corpus.

---

## Known gaps (intentional for now)

- **ArrayEdits** (`ValueRep::IsArrayEdit`): not decoded as a first-class value yet.
- Some `TypeEnum` cases not exercised by our corpus are not fully implemented (e.g. `Spline`, `Relocates`, etc.).







