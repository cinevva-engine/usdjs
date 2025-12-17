# USD Working Group Assets Corpus

This corpus contains official USD test assets from [usd-wg/assets](https://github.com/usd-wg/assets), the ASWF USD Assets Working Group repository.

## Web Catalog

You can browse and preview these assets live at [usd-assets.needle.tools](https://usd-assets.needle.tools/), which renders USD using USD-WASM.

## Structure

### Test Assets (`test_assets/`)

Unit test assets with documentation and reference screenshots:

- **_common/** - Shared test utilities (teapot, axis, animated cube)
- **schemaTests/usdGeom/** - Geometry schema tests
  - **primitives/** - Capsule, cone, cube, cylinder, sphere
  - **meshes/** - Various mesh configurations (subdiv, normals, sidedness)
  - **transforms/** - Transform hierarchy tests
  - **extent/** - Bounding box tests
- **foundation/** - Core USD feature tests
  - **stage_composition/** - Sublayers, references, payloads, inherits
  - **stage_configuration/** - upAxis, metersPerUnit, framesPerSecond, timeCodes
- **MaterialXTest/** - MaterialX shader examples
- **NormalsTextureBiasAndScale/** - Normal map bias/scale tests
- **AlphaBlendModeTest/** - Alpha blending tests
- **AlphaBlendSortTest/** - Alpha sorting tests
- **TextureCoordinateTest/** - UV coordinate tests
- **TextureFileFormatTests/** - JPEG, PNG format tests
- **TextureTransformTest/** - Texture transform tests
- **References/** - Reference composition tests
- **RelationshipEncapsulationTests/** - Relationship scope tests
- **RoughnessTest/** - PBR roughness tests
- **USDZ/** - Animated USDZ samples (AnimatedCube, BrainStem, CesiumMan, etc.)

### Full Assets (`full_assets/`)

Production-like example assets:

- **McUsd/** - McDonald's-themed USD scene
- **ElephantWithMonochord/** - Animated elephant with musical instrument
- **CarbonFrameBike/** - High-detail bicycle model (USDZ)
- **SubdivisionSurfaces/** - Subdivision surface examples
- **OpenChessSet/** - Full chess set with pieces (payload structure)
- **Teapot/** - Utah teapot with materials and payloads
- **StandardShaderBall/** - Industry-standard shader ball scene
- **UsdCookie/** - Cookie-shaped USD logo
- **Vehicles/** - Mini car kit with variants

### Documentation (`docs/`)

- **CompositionPuzzles/** - Educational composition problem/solution pairs
- **PrimvarInterpolation/** - Primvar interpolation documentation
- **asset-structure-guidelines.md** - Best practices for USD asset structure

### Intent VFX Examples (`intent-vfx/`)

Pipeline-oriented examples showing common VFX workflows:

- Asset structure with geo/mtl/payload layers
- Scene composition with layout and overrides
- Animation cycles

## Reference Images

Reference images are available in:
- `thumbnails/` - Clean thumbnail renders
- `screenshots/` - Full screenshots (often with `_usdrecord_22.08` suffix)
- `cards/` - Six-view card images (XPos, XNeg, YPos, YNeg, ZPos, ZNeg)

## Usage

### Finding Samples

See `CORPUS_INDEX.json` for a complete categorized index of all USD files.

### Running Parser Tests

The corpus is used for parser testing. See:
- `curated-usdwg-parser-files.json` - Curated subset for viewer integration

### File Counts

- **Total USD files**: ~280
- **Test assets**: ~124
- **Full assets**: ~93

## Notes

- Most assets use CC0 or permissive licenses (check individual README files)
- Assets are designed for testing and education, not production use
- File sizes are intentionally limited (<30MB for largest full asset)
- Screenshots show expected rendering in usdview/usdrecord

## Source

Original repository: https://github.com/usd-wg/assets

This corpus is maintained as a test asset collection for the USD.js parser and viewer.
