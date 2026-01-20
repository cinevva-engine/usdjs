# Quick Start Guide

Get `@cinevva/usdjs` running in your project in under 5 minutes.

---

## Installation

```bash
npm install @cinevva/usdjs
```

Or install from GitHub directly:

```bash
npm install github:cinevva-engine/usdjs
```

---

## Basic Usage

### Opening a USDA (Text) File

```typescript
import { UsdStage } from '@cinevva/usdjs';

const usda = `#usda 1.0
(
    defaultPrim = "World"
)

def Xform "World" {
    def Mesh "Cube" {
        float3[] points = [(-1,-1,-1), (1,-1,-1), (1,1,-1), (-1,1,-1)]
        int[] faceVertexCounts = [4]
        int[] faceVertexIndices = [0, 1, 2, 3]
    }
}`;

const stage = UsdStage.openUSDA(usda, 'scene.usda');

// List all prim paths
console.log(stage.listPrimPaths());
// Output: ['/', '/World', '/World/Cube']
```

### Opening a USDC (Binary) File

```typescript
import { UsdStage } from '@cinevva/usdjs';

// In browser: fetch as ArrayBuffer
const response = await fetch('/models/scene.usdc');
const buffer = await response.arrayBuffer();

const stage = UsdStage.openUSDC(buffer, 'scene.usdc');
```

### Opening a USDZ (Package) File

```typescript
import { UsdStage } from '@cinevva/usdjs';

const response = await fetch('/models/model.usdz');
const buffer = await response.arrayBuffer();

// Note: openUSDZ is async
const stage = await UsdStage.openUSDZ(buffer, 'model.usdz');
```

### Auto-Detecting Format

```typescript
import { UsdStage } from '@cinevva/usdjs';

// For text or binary (not USDZ):
const stage = UsdStage.open(data, 'scene.usd');
// Automatically detects USDA vs USDC based on content
```

---

## Reading Prim Data

```typescript
import { UsdStage, SdfPath } from '@cinevva/usdjs';

const stage = UsdStage.openUSDA(usda, 'scene.usda');
const composed = stage.composePrimIndex();

// Get a specific prim
const meshPath = SdfPath.parse('/World/Cube');
const meshPrim = composed.getPrim(meshPath);

if (meshPrim) {
    console.log('Type:', meshPrim.typeName);      // "Mesh"
    console.log('Specifier:', meshPrim.specifier); // "def"
    
    // Read properties
    const points = meshPrim.properties?.get('points');
    if (points?.defaultValue) {
        console.log('Points:', points.defaultValue);
    }
}
```

---

## Composition with External References

When your USD file references other files, use a resolver:

```typescript
import { UsdStage, parseUsdaToLayer, resolveAssetPath } from '@cinevva/usdjs';

// Define a resolver that fetches external files
const resolver = {
    async readText(assetPath: string, fromIdentifier: string) {
        const resolved = resolveAssetPath(assetPath, fromIdentifier);
        const response = await fetch(resolved);
        const text = await response.text();
        return { text, identifier: resolved };
    }
};

// Open with composition
const rootUsda = await fetch('/scenes/root.usda').then(r => r.text());
const stage = await UsdStage.openUSDAWithResolver(rootUsda, resolver, '/scenes/root.usda');

// Full composition (expands references, payloads, variants)
const composed = await stage.composePrimIndexWithResolver(resolver);
```

---

## Lower-Level Parsing

For more control, use the parsing functions directly:

```typescript
import { 
    parseUsdaToLayer,
    parseUsdcToLayer,
    parseUsdzToLayer,
    serializeLayerToUsda
} from '@cinevva/usdjs';

// Parse USDA text to an SdfLayer
const layer = parseUsdaToLayer(usdaText, { identifier: 'scene.usda' });

// Access layer metadata
console.log('Default prim:', layer.metadata.defaultPrim);
console.log('Up axis:', layer.metadata.upAxis);

// Traverse the prim tree
function walkPrims(prim, depth = 0) {
    console.log('  '.repeat(depth) + prim.path.toString());
    if (prim.children) {
        for (const child of prim.children.values()) {
            walkPrims(child, depth + 1);
        }
    }
}
walkPrims(layer.root);

// Serialize back to USDA
const roundTripped = serializeLayerToUsda(layer);
```

---

## Working with Time Samples

```typescript
const usda = `#usda 1.0
def Xform "Animated" {
    double3 xformOp:translate.timeSamples = {
        0: (0, 0, 0),
        24: (10, 0, 0),
        48: (10, 10, 0),
    }
    uniform token[] xformOpOrder = ["xformOp:translate"]
}`;

const stage = UsdStage.openUSDA(usda, 'anim.usda');
const prim = stage.composePrimIndex().getPrim(SdfPath.parse('/Animated'));

const translateProp = prim?.properties?.get('xformOp:translate');
if (translateProp?.timeSamples) {
    for (const [time, value] of translateProp.timeSamples) {
        console.log(`Frame ${time}:`, value);
    }
}
```

---

## Browser Example (Minimal)

```html
<!DOCTYPE html>
<html>
<head>
    <script type="module">
        import { UsdStage } from 'https://esm.sh/@cinevva/usdjs';
        
        const usda = `#usda 1.0
        def Sphere "MySphere" {
            double radius = 2.0
        }`;
        
        const stage = UsdStage.openUSDA(usda);
        document.body.textContent = 
            'Prims: ' + stage.listPrimPaths().join(', ');
    </script>
</head>
<body></body>
</html>
```

---

## Node.js Example

```javascript
import { readFileSync } from 'node:fs';
import { UsdStage } from '@cinevva/usdjs';

const buffer = readFileSync('./model.usdc');
const stage = UsdStage.openUSDC(buffer, 'model.usdc');

console.log('Prims:', stage.listPrimPaths());
```

---

## Next Steps

- **[API.md](./API.md)** — Full API reference
- **[COMPOSITION.md](./COMPOSITION.md)** — Understanding composition arcs
- **[FEATURES.md](./FEATURES.md)** — What's supported and what's not
