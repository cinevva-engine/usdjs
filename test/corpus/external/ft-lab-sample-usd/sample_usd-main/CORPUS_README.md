# FT-Lab USD Sample Corpus

This corpus contains USD sample files from [ft-lab/sample_usd](https://github.com/ft-lab/sample_usd), organized by feature and functionality.

## Structure

### Samples (`samples/`)

USD files are organized by category/feature:

- **defaultPrim** - Default prim usage examples
- **hierarchy** - Scene hierarchy examples
- **metersPerUnit** - Unit system examples (cm, m, mm)
- **upAxis** - Up axis orientation (Y, Z)
- **primitive** - Basic primitive shapes
- **curves** - Basis curves
- **light** - Light types (point, spot, rect, dome)
- **doubleSided** - Double-sided geometry
- **variant** - Variant sets
- **pointInstancer** - Point instancer examples
- **skeleton** - Skeleton and joints
- **reference** - Reference and payload examples
- **instance** - Instance examples
- **mesh** - Mesh geometry (cubes, subdivisions, normals)
- **triangulation** - Polygon triangulation
- **material** - Material examples
  - **UsdPreviewSurface** - Standard USD preview surface materials
  - **OmniPBR** - NVIDIA Omniverse PBR materials
- **displayColor** - Display color examples
- **pointClouds** - Point cloud examples
- **displayName** - Display name examples (including UTF-8)
- **layer** - Layer composition
- **kind** - Kind metadata

### Documentation (`knowledges/`)

- ColorSpaceConversion.md - Color space conversion guide
- Lights.md - Lighting documentation
- LightingCalculation.md - Lighting calculation details

### Assets

- **Textures**: `samples/Material/textures/` - Shared texture assets
- **Light Maps**: `samples/light/` - HDR/EXR light maps

## Usage

### Finding Samples

See `CORPUS_INDEX.json` for a complete categorized index of all USD files.

### Running Parser Tests

The corpus is used for parser testing. See:
- `curated-ftlab-parser-files.json` - Curated subset for fast parser tests
- `scripts/curate-ftlab.mjs` - Curation script

### File Counts

- **Total USD files**: 64
- **Categories**: 22
- **Material examples**: 21 (14 UsdPreviewSurface + 7 OmniPBR)

## Notes

- All texture references use relative paths
- Some samples include companion images in `images/` subdirectories
- Binary USD files use `.usdc` extension, ASCII use `.usda`
- Materials are compatible with NVIDIA Omniverse

## Source

Original repository: https://github.com/ft-lab/sample_usd

This corpus is maintained as a test asset collection for the USD.js parser.









