## Composition (what `@cinevva/usdjs` supports)

OpenUSD composition (Pcp) is deep. `@cinevva/usdjs` implements a **practical subset** that targets common real-world assets and keeps the API small.

### Supported (today)

- **Sublayers** (`subLayers`)
- **References** (common authoring patterns)
- **Payloads** (supported in the arc expansion path)
- **Variants**
- **Inherits** (class opinions)
- **Internal references** (`</PrimPath>` style) used for instancing-like patterns in some assets

### Not supported (yet)

- Full **Pcp** prim indexing / caching parity
- **Specializes**
- **Relocates**
- **Clips**

### Design intent

- Prefer **deterministic behavior** and “works on real assets” over implementing every edge case up front.
- Preserve unknown metadata/fields so downstream tools can round-trip without losing information.

