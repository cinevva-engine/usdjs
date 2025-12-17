import { SdfLayer, type SdfPrimSpec } from '../sdf/layer.js';
import { SdfPath } from '../sdf/path.js';

/**
 * Pcp-lite composition: build a composed prim index by stacking layers.
 *
 * This is intentionally minimal:
 * - supports only prim existence + typeName and basic property map merges
 * - `def` creates, `over` modifies if exists (or creates a placeholder)
 * - no payload/reference arcs yet (those will change the layer stack itself)
 */
export function composeLayerStack(layersWeakToStrong: SdfLayer[], identifier = '<composed>'): SdfLayer {
    // Important: the composed layer identifier participates in relative asset resolution.
    // Callers should pass through a stable identifier (usually the strongest layer's identifier)
    // when composing subLayers, otherwise relative paths like `./mtl.usd` will resolve incorrectly.
    const composed = new SdfLayer(identifier);

    // Merge in order: weakest → strongest.
    for (const layer of layersWeakToStrong) {
        mergePrimSpec(composed.root, layer.root);
        // layer-level metadata: strongest wins (we overwrite as we go)
        for (const [k, v] of Object.entries(layer.metadata ?? {})) {
            composed.metadata[k] = v;
        }
    }

    return composed;
}

export function mergePrimSpec(dstPrim: SdfPrimSpec, srcPrim: SdfPrimSpec): void {
    // Do not overwrite root path/specifier; root is synthetic.
    if (dstPrim.path.primPath !== '/' || srcPrim.path.primPath !== '/') {
        // typeName: stronger opinion wins
        if (srcPrim.typeName) dstPrim.typeName = srcPrim.typeName;
        // metadata: stronger wins per key
        if (srcPrim.metadata) {
            dstPrim.metadata ??= {};
            for (const [k, v] of Object.entries(srcPrim.metadata)) dstPrim.metadata[k] = v;
        }
    }

    // properties: stronger wins by key
    if (srcPrim.properties) {
        dstPrim.properties ??= new Map();
        for (const [k, v] of srcPrim.properties.entries()) dstPrim.properties.set(k, v);
    }

    // variantSets: merge by set name; variants inside set merge by variant name.
    if ((srcPrim as any).variantSets) {
        (dstPrim as any).variantSets ??= new Map();
        const dstVS: Map<string, any> = (dstPrim as any).variantSets;
        const srcVS: Map<string, any> = (srcPrim as any).variantSets;
        for (const [setName, set] of srcVS.entries()) {
            const existing = dstVS.get(setName);
            if (!existing) {
                dstVS.set(setName, set);
                continue;
            }
            existing.variants ??= new Map();
            for (const [variantName, variantPrim] of set.variants.entries()) {
                existing.variants.set(variantName, variantPrim);
            }
        }
    }

    // children: recurse
    if (srcPrim.children) {
        dstPrim.children ??= new Map();
        for (const [childName, srcChild] of srcPrim.children.entries()) {
            let dstChild = dstPrim.children.get(childName);
            if (!dstChild) {
                dstChild = {
                    path: SdfPath.parse(srcChild.path.primPath),
                    specifier: 'def',
                    typeName: srcChild.typeName,
                    metadata: {},
                    properties: new Map(),
                    children: new Map(),
                };
                dstPrim.children.set(childName, dstChild);
            }
            mergePrimSpec(dstChild, srcChild);
        }
    }
}

/**
 * Merge a *weaker* prim spec into a *stronger* prim spec.
 *
 * This is the inverse of `mergePrimSpec()`:
 * - existing opinions on `dstStrong` win
 * - only missing fields are filled from `srcWeak`
 *
 * This is useful when grafting referenced prims into a referencing prim,
 * where the referencing site should remain stronger (e.g. keep `variants = {...}` selections).
 */
export function mergePrimSpecWeakIntoStrong(dstStrong: SdfPrimSpec, srcWeak: SdfPrimSpec): void {
    // typeName: fill only if missing on strong
    if (!dstStrong.typeName && srcWeak.typeName) dstStrong.typeName = srcWeak.typeName;

    // metadata: fill only missing keys on strong
    if (srcWeak.metadata) {
        dstStrong.metadata ??= {};
        for (const [k, v] of Object.entries(srcWeak.metadata)) {
            if (!(k in dstStrong.metadata)) (dstStrong.metadata as any)[k] = v;
        }
    }

    // properties: fill only missing keys on strong
    if (srcWeak.properties) {
        dstStrong.properties ??= new Map();
        for (const [k, v] of srcWeak.properties.entries()) {
            if (!dstStrong.properties.has(k)) dstStrong.properties.set(k, v);
        }
    }

    // variantSets: union; strong wins if set/variant already exists
    if ((srcWeak as any).variantSets) {
        (dstStrong as any).variantSets ??= new Map();
        const dstVS: Map<string, any> = (dstStrong as any).variantSets;
        const srcVS: Map<string, any> = (srcWeak as any).variantSets;
        for (const [setName, set] of srcVS.entries()) {
            const existing = dstVS.get(setName);
            if (!existing) {
                dstVS.set(setName, set);
                continue;
            }
            existing.variants ??= new Map();
            for (const [variantName, variantPrim] of set.variants.entries()) {
                if (!existing.variants.has(variantName)) existing.variants.set(variantName, variantPrim);
            }
        }
    }

    // children: fill missing children; recurse for existing
    if (srcWeak.children) {
        dstStrong.children ??= new Map();
        for (const [childName, srcChild] of srcWeak.children.entries()) {
            const dstChild = dstStrong.children.get(childName);
            if (!dstChild) {
                dstStrong.children.set(childName, srcChild);
                continue;
            }
            mergePrimSpecWeakIntoStrong(dstChild, srcChild);
        }
    }
}


