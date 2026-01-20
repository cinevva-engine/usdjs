# Examples

Practical code examples for common `@cinevva/usdjs` use cases.

---

## Table of Contents

- [Reading Mesh Data](#reading-mesh-data)
- [Working with Materials](#working-with-materials)
- [Handling Transforms](#handling-transforms)
- [Animation and Time Samples](#animation-and-time-samples)
- [Composition Workflows](#composition-workflows)
- [Creating USD from Scratch](#creating-usd-from-scratch)
- [Converting Between Formats](#converting-between-formats)
- [Browser Integration](#browser-integration)
- [Node.js Scripts](#nodejs-scripts)

---

## Reading Mesh Data

### Extract Vertices and Faces

```typescript
import { UsdStage, SdfPath } from '@cinevva/usdjs';

async function readMesh(stage: UsdStage, primPath: string) {
    const composed = stage.composePrimIndex();
    const prim = composed.getPrim(SdfPath.parse(primPath));
    
    if (!prim || prim.typeName !== 'Mesh') {
        throw new Error('Not a mesh');
    }
    
    const props = prim.properties;
    
    // Get points (vertices)
    const pointsProp = props?.get('points');
    const points = pointsProp?.defaultValue;
    
    // Get face topology
    const faceCountsProp = props?.get('faceVertexCounts');
    const faceIndicesProp = props?.get('faceVertexIndices');
    
    // Get normals (if present)
    const normalsProp = props?.get('normals');
    
    // Get UVs (commonly named 'primvars:st' or 'primvars:UVMap')
    const uvProp = props?.get('primvars:st') || props?.get('primvars:UVMap');
    
    return {
        points: extractNumericArray(points),
        faceVertexCounts: extractIntArray(faceCountsProp?.defaultValue),
        faceVertexIndices: extractIntArray(faceIndicesProp?.defaultValue),
        normals: normalsProp ? extractNumericArray(normalsProp.defaultValue) : null,
        uvs: uvProp ? extractNumericArray(uvProp.defaultValue) : null,
    };
}

function extractNumericArray(value: any): number[] | Float32Array | Float64Array | null {
    if (!value) return null;
    if (value.type === 'typedArray') return value.value;
    if (value.type === 'array') return value.value.flat();
    return null;
}

function extractIntArray(value: any): number[] | Int32Array | null {
    if (!value) return null;
    if (value.type === 'typedArray') return value.value;
    if (value.type === 'array') return value.value;
    return null;
}
```

---

## Working with Materials

### Find Material Bindings

```typescript
import { UsdStage, SdfPath } from '@cinevva/usdjs';

function findMaterialBinding(prim: any): string | null {
    // Check for material:binding relationship
    const bindingProp = prim.properties?.get('material:binding');
    if (bindingProp?.defaultValue?.type === 'sdfpath') {
        return bindingProp.defaultValue.value;
    }
    
    // Check metadata (some exporters put it here)
    const bindingMeta = prim.metadata?.['material:binding'];
    if (bindingMeta?.type === 'sdfpath') {
        return bindingMeta.value;
    }
    
    return null;
}

function readMaterial(layer: any, materialPath: string) {
    const prim = layer.getPrim(SdfPath.parse(materialPath));
    if (!prim) return null;
    
    const result: any = {
        path: materialPath,
        type: prim.typeName,
        properties: {},
    };
    
    // Find shader prims (children of type Shader)
    if (prim.children) {
        for (const [name, child] of prim.children) {
            if (child.typeName === 'Shader') {
                result.shaders = result.shaders || {};
                result.shaders[name] = readShader(child);
            }
        }
    }
    
    return result;
}

function readShader(shaderPrim: any) {
    const shader: any = {
        type: null,
        inputs: {},
        outputs: {},
    };
    
    // Get shader type from info:id
    const infoId = shaderPrim.properties?.get('info:id');
    if (infoId?.defaultValue?.type === 'token') {
        shader.type = infoId.defaultValue.value;
    }
    
    // Collect inputs (properties starting with 'inputs:')
    for (const [key, prop] of shaderPrim.properties || []) {
        if (key.startsWith('inputs:')) {
            const inputName = key.slice(7);
            shader.inputs[inputName] = prop.defaultValue;
        }
        if (key.startsWith('outputs:')) {
            const outputName = key.slice(8);
            shader.outputs[outputName] = prop.defaultValue;
        }
    }
    
    return shader;
}
```

---

## Handling Transforms

### Read Transform Operations

```typescript
function readTransform(prim: any): { matrix: number[] } | null {
    const props = prim.properties;
    if (!props) return null;
    
    // Check for xformOpOrder
    const opOrderProp = props.get('xformOpOrder');
    if (!opOrderProp?.defaultValue) return null;
    
    const opOrder = extractTokenArray(opOrderProp.defaultValue);
    if (!opOrder) return null;
    
    // Build transform by applying operations in order
    let matrix = identityMatrix();
    
    for (const op of opOrder) {
        const opValue = props.get(op)?.defaultValue;
        if (!opValue) continue;
        
        if (op.includes('translate')) {
            matrix = multiplyMatrices(matrix, translateMatrix(opValue));
        } else if (op.includes('rotateX')) {
            matrix = multiplyMatrices(matrix, rotateXMatrix(opValue));
        } else if (op.includes('rotateY')) {
            matrix = multiplyMatrices(matrix, rotateYMatrix(opValue));
        } else if (op.includes('rotateZ')) {
            matrix = multiplyMatrices(matrix, rotateZMatrix(opValue));
        } else if (op.includes('scale')) {
            matrix = multiplyMatrices(matrix, scaleMatrix(opValue));
        } else if (op.includes('transform')) {
            // Full 4x4 matrix
            if (opValue.type === 'matrix4d') {
                matrix = multiplyMatrices(matrix, opValue.value);
            }
        }
    }
    
    return { matrix };
}

function extractTokenArray(value: any): string[] | null {
    if (!value) return null;
    if (value.type === 'array') {
        return value.value.map((v: any) => 
            typeof v === 'string' ? v : v.value
        );
    }
    return null;
}

// Matrix helpers (simplified)
function identityMatrix(): number[] {
    return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
}

function translateMatrix(v: any): number[] {
    const [x, y, z] = v.type === 'tuple' ? v.value : v.value || [0,0,0];
    return [1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1];
}

function scaleMatrix(v: any): number[] {
    const [x, y, z] = v.type === 'tuple' ? v.value : v.value || [1,1,1];
    return [x,0,0,0, 0,y,0,0, 0,0,z,0, 0,0,0,1];
}
```

---

## Animation and Time Samples

### Read Animated Property

```typescript
import { UsdStage, SdfPath } from '@cinevva/usdjs';

function readAnimatedProperty(layer: any, primPath: string, propName: string) {
    const prim = layer.getPrim(SdfPath.parse(primPath));
    const prop = prim?.properties?.get(propName);
    
    if (!prop) return null;
    
    // Check for time samples
    if (prop.timeSamples && prop.timeSamples.size > 0) {
        const samples: Array<{ time: number; value: any }> = [];
        
        for (const [time, value] of prop.timeSamples) {
            samples.push({ time, value });
        }
        
        // Sort by time
        samples.sort((a, b) => a.time - b.time);
        
        return {
            type: 'animated',
            samples,
            startTime: samples[0].time,
            endTime: samples[samples.length - 1].time,
        };
    }
    
    // Static value
    return {
        type: 'static',
        value: prop.defaultValue,
    };
}

// Interpolate value at arbitrary time
function sampleAtTime(samples: Array<{ time: number; value: any }>, t: number): any {
    if (samples.length === 0) return null;
    if (samples.length === 1) return samples[0].value;
    
    // Find bracketing samples
    let before = samples[0];
    let after = samples[samples.length - 1];
    
    for (let i = 0; i < samples.length - 1; i++) {
        if (samples[i].time <= t && samples[i + 1].time >= t) {
            before = samples[i];
            after = samples[i + 1];
            break;
        }
    }
    
    // Linear interpolation (for numeric values)
    const alpha = (t - before.time) / (after.time - before.time);
    return lerpValue(before.value, after.value, alpha);
}

function lerpValue(a: any, b: any, t: number): any {
    if (typeof a === 'number' && typeof b === 'number') {
        return a + (b - a) * t;
    }
    if (a?.type === 'tuple' && b?.type === 'tuple') {
        return {
            type: 'tuple',
            value: a.value.map((v: number, i: number) => v + (b.value[i] - v) * t)
        };
    }
    // Fallback: step interpolation
    return t < 0.5 ? a : b;
}
```

---

## Composition Workflows

### Load Scene with References

```typescript
import { UsdStage, resolveAssetPath, parseUsdaToLayer, parseUsdcToLayer } from '@cinevva/usdjs';

async function loadCompleteScene(rootUrl: string) {
    const resolver = {
        async readText(assetPath: string, fromIdentifier: string) {
            const resolved = resolveAssetPath(assetPath, fromIdentifier);
            const response = await fetch(resolved);
            
            if (resolved.endsWith('.usdc') || resolved.endsWith('.usd')) {
                const buffer = await response.arrayBuffer();
                // Check for USDC magic
                const bytes = new Uint8Array(buffer);
                if (bytes[0] === 0x50 && bytes[1] === 0x58) { // 'PX'
                    const layer = parseUsdcToLayer(buffer, { identifier: resolved });
                    return { layer, identifier: resolved };
                }
            }
            
            const text = await response.text();
            return { text, identifier: resolved };
        }
    };
    
    const rootText = await fetch(rootUrl).then(r => r.text());
    const stage = await UsdStage.openUSDAWithResolver(rootText, resolver, rootUrl);
    
    // Full composition
    const composed = await stage.composePrimIndexWithResolver(resolver);
    
    return composed;
}
```

### Handle Variant Selections

```typescript
function getVariantSelections(prim: any): Map<string, string> {
    const selections = new Map<string, string>();
    
    const variantsMeta = prim.metadata?.variants;
    if (variantsMeta?.type === 'dict') {
        for (const [setName, selection] of Object.entries(variantsMeta.value)) {
            const value = typeof selection === 'string' 
                ? selection 
                : (selection as any).value;
            selections.set(setName, value);
        }
    }
    
    return selections;
}

function getAvailableVariants(prim: any): Map<string, string[]> {
    const available = new Map<string, string[]>();
    
    if (prim.variantSets) {
        for (const [setName, set] of prim.variantSets) {
            available.set(setName, Array.from(set.variants.keys()));
        }
    }
    
    return available;
}
```

---

## Creating USD from Scratch

### Build a Simple Scene

```typescript
import { SdfLayer, SdfPath, serializeLayerToUsda } from '@cinevva/usdjs';

function createSimpleScene(): string {
    const layer = new SdfLayer('scene.usda');
    
    // Set layer metadata
    (layer.metadata as any).defaultPrim = 'World';
    (layer.metadata as any).upAxis = { type: 'token', value: 'Y' };
    
    // Create root prim
    const world = layer.ensurePrim(SdfPath.parse('/World'), 'def');
    world.typeName = 'Xform';
    
    // Add a cube
    const cube = layer.ensurePrim(SdfPath.parse('/World/Cube'), 'def');
    cube.typeName = 'Mesh';
    cube.properties = new Map();
    
    // Add points
    cube.properties.set('points', {
        path: SdfPath.parse('/World/Cube.points'),
        typeName: 'point3f[]',
        defaultValue: {
            type: 'array',
            elementType: 'point3f',
            value: [
                { type: 'tuple', value: [-1, -1, -1] },
                { type: 'tuple', value: [1, -1, -1] },
                { type: 'tuple', value: [1, 1, -1] },
                { type: 'tuple', value: [-1, 1, -1] },
                // ... more vertices
            ]
        }
    });
    
    // Serialize to USDA
    return serializeLayerToUsda(layer);
}
```

---

## Converting Between Formats

### USDC to USDA

```typescript
import { parseUsdcToLayer, serializeLayerToUsda } from '@cinevva/usdjs';

async function usdcToUsda(usdcUrl: string): Promise<string> {
    const response = await fetch(usdcUrl);
    const buffer = await response.arrayBuffer();
    
    const layer = parseUsdcToLayer(buffer, { identifier: usdcUrl });
    return serializeLayerToUsda(layer);
}
```

### Create USDZ Package

```typescript
import { parseUsdaToLayer, serializeLayerToUsda, writeUsdz } from '@cinevva/usdjs';

async function createUsdzPackage(
    layer: SdfLayer, 
    textures: Map<string, Uint8Array>
): Promise<Uint8Array> {
    const entries = [];
    
    // Add main layer
    const usdaText = serializeLayerToUsda(layer);
    entries.push({
        path: 'scene.usda',
        data: new TextEncoder().encode(usdaText),
    });
    
    // Add textures
    for (const [path, data] of textures) {
        entries.push({ path, data });
    }
    
    return writeUsdz(entries);
}
```

---

## Browser Integration

### Drag and Drop

```html
<div id="dropzone">Drop USD file here</div>

<script type="module">
import { UsdStage } from '@cinevva/usdjs';

const dropzone = document.getElementById('dropzone');

dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
});

dropzone.addEventListener('drop', async (e) => {
    e.preventDefault();
    
    const file = e.dataTransfer.files[0];
    const buffer = await file.arrayBuffer();
    
    let stage;
    if (file.name.endsWith('.usdz')) {
        stage = await UsdStage.openUSDZ(buffer, file.name);
    } else {
        stage = UsdStage.open(buffer, file.name);
    }
    
    console.log('Loaded prims:', stage.listPrimPaths());
});
</script>
```

### File Input

```html
<input type="file" id="usdFile" accept=".usd,.usda,.usdc,.usdz">

<script type="module">
import { UsdStage } from '@cinevva/usdjs';

document.getElementById('usdFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const buffer = await file.arrayBuffer();
    const stage = UsdStage.open(buffer, file.name);
    
    // Process the stage...
});
</script>
```

---

## Node.js Scripts

### Batch Processing

```javascript
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { parseUsdcToLayer, serializeLayerToUsda } from '@cinevva/usdjs';

function convertDirectory(inputDir, outputDir) {
    const files = readdirSync(inputDir);
    
    for (const file of files) {
        if (extname(file) !== '.usdc') continue;
        
        const inputPath = join(inputDir, file);
        const outputPath = join(outputDir, file.replace('.usdc', '.usda'));
        
        const buffer = readFileSync(inputPath);
        const layer = parseUsdcToLayer(buffer, { identifier: inputPath });
        const usda = serializeLayerToUsda(layer);
        
        writeFileSync(outputPath, usda);
        console.log(`Converted: ${file}`);
    }
}
```

### Validation Script

```javascript
import { readFileSync } from 'node:fs';
import { UsdStage, parseUsdaToLayer, parseUsdcToLayer } from '@cinevva/usdjs';

function validateUsdFile(filepath) {
    const buffer = readFileSync(filepath);
    
    try {
        const stage = UsdStage.open(buffer, filepath);
        const prims = stage.listPrimPaths();
        
        console.log(`✓ ${filepath}`);
        console.log(`  Prims: ${prims.length}`);
        console.log(`  Root: ${prims.slice(0, 5).join(', ')}${prims.length > 5 ? '...' : ''}`);
        
        return { valid: true, primCount: prims.length };
    } catch (error) {
        console.log(`✗ ${filepath}`);
        console.log(`  Error: ${error.message}`);
        
        return { valid: false, error: error.message };
    }
}
```

---

## See Also

- [API.md](./API.md) — Complete API reference
- [COMPOSITION.md](./COMPOSITION.md) — Composition engine details
- [FEATURES.md](./FEATURES.md) — What's supported
