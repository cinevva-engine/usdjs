import { SdfLayer, type SdfPrimSpec, type SdfPropertySpec } from '../sdf/layer.js';
import { SdfPath } from '../sdf/path.js';

function mergePropertySpecStrongOverWeak(dst: SdfPropertySpec, src: SdfPropertySpec): void {
    // `src` is stronger than `dst`.
    // - typeName: treat as a strong opinion (overwrite)
    if (src.typeName) dst.typeName = src.typeName;
    // - defaultValue: overwrite if authored on src
    if (src.defaultValue !== undefined) dst.defaultValue = src.defaultValue;
    // - timeSamples: if src authors any, union with src winning per time key
    if (src.timeSamples && src.timeSamples.size > 0) {
        if (!dst.timeSamples || dst.timeSamples.size === 0) {
            dst.timeSamples = src.timeSamples;
        } else {
            const merged = new Map<number, any>();
            for (const [t, v] of dst.timeSamples.entries()) merged.set(t, v);
            for (const [t, v] of src.timeSamples.entries()) merged.set(t, v);
            dst.timeSamples = merged;
        }
    }
    // - metadata: strong wins per key
    if (src.metadata) {
        dst.metadata ??= {};
        for (const [k, v] of Object.entries(src.metadata)) (dst.metadata as any)[k] = v;
    }
}

function mergePropertySpecWeakIntoStrong(dstStrong: SdfPropertySpec, srcWeak: SdfPropertySpec): void {
    // `srcWeak` is weaker than `dstStrong`.
    if ((!dstStrong.typeName || dstStrong.typeName === 'unknown') && srcWeak.typeName) dstStrong.typeName = srcWeak.typeName;
    if (dstStrong.defaultValue === undefined && srcWeak.defaultValue !== undefined) dstStrong.defaultValue = srcWeak.defaultValue;

    if (srcWeak.timeSamples && srcWeak.timeSamples.size > 0) {
        if (!dstStrong.timeSamples || dstStrong.timeSamples.size === 0) {
            dstStrong.timeSamples = srcWeak.timeSamples;
        } else {
            for (const [t, v] of srcWeak.timeSamples.entries()) {
                if (!dstStrong.timeSamples.has(t)) dstStrong.timeSamples.set(t, v);
            }
        }
    }

    if (srcWeak.metadata) {
        dstStrong.metadata ??= {};
        for (const [k, v] of Object.entries(srcWeak.metadata)) {
            if (!(k in dstStrong.metadata)) (dstStrong.metadata as any)[k] = v;
        }
    }
}

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

    // properties: merge per-property so stronger opinions don't accidentally drop weaker fields
    // like `timeSamples` when only some fields are overridden.
    if (srcPrim.properties) {
        dstPrim.properties ??= new Map();
        for (const [k, srcProp] of srcPrim.properties.entries()) {
            const dstProp = dstPrim.properties.get(k);
            if (!dstProp) {
                dstPrim.properties.set(k, srcProp);
                continue;
            }
            mergePropertySpecStrongOverWeak(dstProp, srcProp);
        }
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

    // properties: fill missing keys; if property exists on strong, fill missing fields
    // (notably `timeSamples`) without overwriting stronger values.
    if (srcWeak.properties) {
        dstStrong.properties ??= new Map();
        for (const [k, srcProp] of srcWeak.properties.entries()) {
            const dstProp = dstStrong.properties.get(k);
            if (!dstProp) {
                dstStrong.properties.set(k, srcProp);
                continue;
            }
            mergePropertySpecWeakIntoStrong(dstProp, srcProp);
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


