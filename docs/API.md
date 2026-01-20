# API Reference

Complete API reference for `@cinevva/usdjs`.

---

## Table of Contents

- [UsdStage](#usdstage)
- [SdfLayer](#sdflayer)
- [SdfPath](#sdfpath)
- [Parsing Functions](#parsing-functions)
- [Serialization Functions](#serialization-functions)
- [Composition Functions](#composition-functions)
- [Resolver Interface](#resolver-interface)
- [Type Definitions](#type-definitions)

---

## UsdStage

The primary entry point for opening and working with USD files.

### Static Methods

#### `UsdStage.openUSDA(src, identifier?)`

Open a USDA (text) file.

```typescript
static openUSDA(src: string, identifier?: string): UsdStage
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `src` | `string` | — | USDA text content |
| `identifier` | `string` | `'<memory>'` | Layer identifier (typically filename) |

**Example:**
```typescript
const stage = UsdStage.openUSDA(usdaText, 'scene.usda');
```

---

#### `UsdStage.openUSDC(buffer, identifier?)`

Open a USDC (binary crate) file.

```typescript
static openUSDC(buffer: ArrayBuffer | Uint8Array, identifier?: string): UsdStage
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `buffer` | `ArrayBuffer \| Uint8Array` | — | Binary USDC data |
| `identifier` | `string` | `'<memory>'` | Layer identifier |

**Example:**
```typescript
const response = await fetch('/model.usdc');
const buffer = await response.arrayBuffer();
const stage = UsdStage.openUSDC(buffer, 'model.usdc');
```

---

#### `UsdStage.openUSDZ(buffer, identifier?)`

Open a USDZ (ZIP package) file. **Async**.

```typescript
static async openUSDZ(buffer: ArrayBuffer | Uint8Array, identifier?: string): Promise<UsdStage>
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `buffer` | `ArrayBuffer \| Uint8Array` | — | USDZ file data |
| `identifier` | `string` | `'<memory>'` | Layer identifier |

**Example:**
```typescript
const stage = await UsdStage.openUSDZ(usdzBuffer, 'model.usdz');
```

---

#### `UsdStage.open(data, identifier?)`

Auto-detect format (USDA text or USDC binary) and open.

```typescript
static open(data: string | ArrayBuffer | Uint8Array, identifier?: string): UsdStage
```

> **Note:** For USDZ files, use `openUSDZ()` instead.

**Example:**
```typescript
// Works with both text and binary
const stage = UsdStage.open(data, 'scene.usd');
```

---

#### `UsdStage.openUSDAWithResolver(src, resolver, identifier?)`

Open a USDA file and resolve sublayers. **Async**.

```typescript
static async openUSDAWithResolver(
    src: string, 
    resolver: UsdResolver, 
    identifier?: string
): Promise<UsdStage>
```

**Example:**
```typescript
const stage = await UsdStage.openUSDAWithResolver(
    usdaText, 
    myResolver, 
    '/scenes/root.usda'
);
```

---

### Instance Methods

#### `stage.listPrimPaths()`

Returns all prim paths in depth-first order.

```typescript
listPrimPaths(): string[]
```

**Example:**
```typescript
const paths = stage.listPrimPaths();
// ['/', '/World', '/World/Mesh', '/World/Light']
```

---

#### `stage.composePrimIndex()`

Compose sublayers and return a flattened layer.

```typescript
composePrimIndex(): SdfLayer
```

**Example:**
```typescript
const composed = stage.composePrimIndex();
const prim = composed.getPrim(SdfPath.parse('/World'));
```

---

#### `stage.composePrimIndexWithResolver(resolver)`

Full composition with external arc expansion. **Async**.

Resolves and expands:
- References (`prepend references = @./file.usda@`)
- Payloads (`prepend payload = @./file.usda@`)
- Variants (`variants = { "lod" = "high" }`)
- Inherits (`prepend inherits = </SomeClass>`)

```typescript
async composePrimIndexWithResolver(resolver: UsdResolver): Promise<SdfLayerLike>
```

**Example:**
```typescript
const composed = await stage.composePrimIndexWithResolver(resolver);
```

---

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `rootLayer` | `SdfLayer` | The root layer of the stage |
| `layerStack` | `SdfLayer[]` | All layers in the stack (root + sublayers) |

---

## SdfLayer

In-memory representation of a USD layer.

### Constructor

```typescript
new SdfLayer(identifier: string)
```

### Methods

#### `layer.getPrim(path)`

Get a prim by path.

```typescript
getPrim(path: SdfPath): SdfPrimSpec | null
```

**Example:**
```typescript
const prim = layer.getPrim(SdfPath.parse('/World/Mesh'));
```

---

#### `layer.ensurePrim(path, specifier?)`

Get or create a prim at the given path.

```typescript
ensurePrim(path: SdfPath, specifier?: SdfPrimSpecifier): SdfPrimSpec
```

**Example:**
```typescript
const prim = layer.ensurePrim(SdfPath.parse('/World/NewPrim'), 'def');
```

---

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `identifier` | `string` | Layer identifier (filename or URI) |
| `metadata` | `Record<string, SdfValue>` | Layer-level metadata (`defaultPrim`, `upAxis`, etc.) |
| `root` | `SdfPrimSpec` | Root prim (pseudo-root at `/`) |

---

## SdfPath

USD path utilities.

### Static Methods

#### `SdfPath.parse(pathString)`

Parse a path string into an SdfPath.

```typescript
static parse(pathString: string): SdfPath
```

**Example:**
```typescript
const primPath = SdfPath.parse('/World/Mesh');
const propPath = SdfPath.parse('/World/Mesh.points');
```

---

#### `SdfPath.absoluteRoot`

The absolute root path (`/`).

```typescript
static readonly absoluteRoot: SdfPath
```

---

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `kind` | `'prim' \| 'property'` | Path type |
| `primPath` | `string` | The prim component (e.g., `/World/Mesh`) |
| `propertyName` | `string \| null` | Property name if property path |
| `fieldName` | `string \| null` | Field name (e.g., `.connect` suffix) |

### Methods

#### `path.toString()`

Convert back to string representation.

```typescript
toString(): string
```

---

## Parsing Functions

### `parseUsdaToLayer(src, options?)`

Parse USDA text to an SdfLayer.

```typescript
function parseUsdaToLayer(src: string, options?: { identifier?: string }): SdfLayer
```

**Example:**
```typescript
import { parseUsdaToLayer } from '@cinevva/usdjs';

const layer = parseUsdaToLayer(usdaText, { identifier: 'scene.usda' });
```

---

### `parseUsdcToLayer(buffer, options?)`

Parse USDC binary to an SdfLayer.

```typescript
function parseUsdcToLayer(
    buffer: ArrayBuffer | Uint8Array, 
    options?: { identifier?: string }
): SdfLayer
```

**Example:**
```typescript
import { parseUsdcToLayer } from '@cinevva/usdjs';

const layer = parseUsdcToLayer(usdcBuffer, { identifier: 'scene.usdc' });
```

---

### `parseUsdzToLayer(buffer, options?)`

Parse USDZ package to an SdfLayer. **Async**.

```typescript
async function parseUsdzToLayer(
    buffer: ArrayBuffer | Uint8Array, 
    options?: { identifier?: string }
): Promise<SdfLayer>
```

---

### `parseMaterialXToLayer(xml, options?)`

Parse MaterialX XML to an SdfLayer (experimental).

```typescript
function parseMaterialXToLayer(
    xml: string, 
    options?: { identifier?: string }
): SdfLayer
```

---

### Detection Helpers

```typescript
function isUsdzContent(buffer: ArrayBuffer | Uint8Array): boolean
function isMaterialXContent(text: string): boolean
```

---

## Serialization Functions

### `serializeLayerToUsda(layer)`

Serialize an SdfLayer to USDA text.

```typescript
function serializeLayerToUsda(layer: SdfLayer): string
```

**Example:**
```typescript
import { parseUsdaToLayer, serializeLayerToUsda } from '@cinevva/usdjs';

const layer = parseUsdaToLayer(originalUsda);
// ... modify layer ...
const outputUsda = serializeLayerToUsda(layer);
```

---

### `serializeLayerToUsdc(layer)`

Serialize an SdfLayer to USDC binary. **Minimal implementation**.

```typescript
function serializeLayerToUsdc(layer: SdfLayer): Uint8Array
```

> **Note:** The USDC writer covers common authoring cases but is not feature-complete.

---

## Composition Functions

### `composeLayerStack(layers, identifier?)`

Compose multiple layers into one (weak-to-strong order).

```typescript
function composeLayerStack(layers: SdfLayer[], identifier?: string): SdfLayer
```

**Example:**
```typescript
import { composeLayerStack } from '@cinevva/usdjs';

// layers[0] is weakest, layers[n-1] is strongest
const composed = composeLayerStack([weakLayer, strongLayer], 'composed.usda');
```

---

### `resolveAssetPath(assetPath, fromIdentifier)`

Resolve a relative asset path against a base identifier.

```typescript
function resolveAssetPath(assetPath: string, fromIdentifier: string): string
```

**Example:**
```typescript
import { resolveAssetPath } from '@cinevva/usdjs';

const resolved = resolveAssetPath('./textures/diffuse.png', '/models/scene.usda');
// '/models/textures/diffuse.png'
```

---

## Resolver Interface

The resolver interface for loading external assets during composition.

```typescript
interface UsdResolver {
    /**
     * Read an asset as text (for USDA) or return a pre-parsed layer.
     * 
     * @param assetPath - The asset path to resolve (may be relative)
     * @param fromIdentifier - The identifier of the layer requesting this asset
     * @returns Object with either `text` (string) or `layer` (SdfLayer), plus `identifier`
     */
    readText(
        assetPath: string, 
        fromIdentifier: string
    ): Promise<{ 
        text?: string; 
        layer?: SdfLayer; 
        identifier: string 
    }>;
}
```

### Example Implementation (Browser)

```typescript
const browserResolver: UsdResolver = {
    async readText(assetPath, fromIdentifier) {
        const resolved = resolveAssetPath(assetPath, fromIdentifier);
        const response = await fetch(resolved);
        
        // Handle binary formats
        if (resolved.endsWith('.usdc')) {
            const buffer = await response.arrayBuffer();
            const layer = parseUsdcToLayer(buffer, { identifier: resolved });
            return { layer, identifier: resolved };
        }
        
        // Handle text formats
        const text = await response.text();
        return { text, identifier: resolved };
    }
};
```

### Example Implementation (Node.js)

```typescript
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const nodeResolver: UsdResolver = {
    async readText(assetPath, fromIdentifier) {
        const basePath = dirname(fromIdentifier);
        const resolved = resolve(basePath, assetPath);
        
        if (resolved.endsWith('.usdc')) {
            const buffer = await readFile(resolved);
            const layer = parseUsdcToLayer(buffer, { identifier: resolved });
            return { layer, identifier: resolved };
        }
        
        const text = await readFile(resolved, 'utf-8');
        return { text, identifier: resolved };
    }
};
```

---

## Type Definitions

### SdfValue

The universal value type used throughout the library.

```typescript
type SdfValue =
    | null
    | boolean
    | number
    | string
    | { type: 'token'; value: string }
    | { type: 'asset'; value: string }
    | { type: 'sdfpath'; value: string }
    | { type: 'reference'; assetPath: string; targetPath?: string }
    | { type: 'vec2f' | 'vec3f' | 'vec4f'; value: number[] }
    | { type: 'matrix4d'; value: number[] }
    | { type: 'tuple'; value: SdfValue[] }
    | { type: 'array'; elementType: string; value: SdfValue[] }
    | { type: 'typedArray'; elementType: string; value: Float32Array | Float64Array | Int32Array | Uint32Array }
    | { type: 'dict'; value: Record<string, SdfValue> }
    | { type: 'raw'; value: string };
```

---

### SdfPrimSpec

A prim specification in a layer.

```typescript
interface SdfPrimSpec {
    path: SdfPath;
    specifier: 'def' | 'over' | 'class';
    typeName?: string;  // e.g., "Xform", "Mesh", "Material"
    metadata?: Record<string, SdfValue>;
    properties?: Map<string, SdfPropertySpec>;
    children?: Map<string, SdfPrimSpec>;
    variantSets?: Map<string, SdfVariantSetSpec>;
}
```

---

### SdfPropertySpec

A property specification.

```typescript
interface SdfPropertySpec {
    path: SdfPath;
    typeName: string;  // e.g., "float3", "token", "asset"
    variability?: 'uniform' | 'varying' | 'config';
    defaultValue?: SdfValue;
    timeSamples?: Map<number, SdfValue>;
    metadata?: Record<string, SdfValue>;
}
```

---

### SdfVariantSetSpec

A variant set specification.

```typescript
interface SdfVariantSetSpec {
    name: string;
    variants: Map<string, SdfPrimSpec>;
}
```

---

### SdfLayerLike

Minimal layer interface (used for composed views).

```typescript
interface SdfLayerLike {
    identifier: string;
    metadata: Record<string, SdfValue>;
    root: SdfPrimSpec;
    getPrim(path: SdfPath): SdfPrimSpec | null;
}
```

---

## USDA Lexer (Advanced)

For custom parsing workflows, the lexer is also exported.

```typescript
import { UsdaLexer, TokenType } from '@cinevva/usdjs';

const lexer = new UsdaLexer(usdaText);
for (const token of lexer) {
    console.log(token.type, token.value);
}
```

---

## USDZ Utilities

### `writeUsdz(entries)`

Write a USDZ package from entries.

```typescript
function writeUsdz(entries: UsdzEntry[]): Uint8Array

interface UsdzEntry {
    path: string;
    data: Uint8Array;
}
```

**Example:**
```typescript
import { writeUsdz, serializeLayerToUsda } from '@cinevva/usdjs';

const usdaBytes = new TextEncoder().encode(serializeLayerToUsda(layer));
const textureBytes = await fetch('/texture.png').then(r => r.arrayBuffer());

const usdzData = writeUsdz([
    { path: 'scene.usda', data: new Uint8Array(usdaBytes) },
    { path: 'texture.png', data: new Uint8Array(textureBytes) },
]);
```
