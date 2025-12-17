import { SdfLayer, type SdfPrimSpec, type SdfPropertySpec, type SdfValue } from '../sdf/layer.js';
import { SdfPath } from '../sdf/path.js';
import { parseUsdaToLayer } from '../usda/parser.js';
import { parseMaterialXToLayer, isMaterialXContent } from '../materialx/parser.js';
import { composeLayerStack, mergePrimSpec, mergePrimSpecWeakIntoStrong } from './compose.js';
import { type UsdResolver } from './resolver.js';

/**
 * Parse text content to an SdfLayer, auto-detecting format (USDA or MaterialX XML).
 */
function parseTextToLayer(text: string, identifier: string): SdfLayer {
    // Check if this looks like MaterialX XML
    if (isMaterialXContent(text)) {
        return parseMaterialXToLayer(text, { identifier });
    }
    // Default to USDA parsing
    return parseUsdaToLayer(text, { identifier });
}

export class UsdStage {
    private constructor(
        public readonly rootLayer: SdfLayer,
        public readonly layerStack: SdfLayer[]
    ) { }

    static openUSDA(src: string, identifier = '<memory>'): UsdStage {
        const layer = parseUsdaToLayer(src, { identifier });
        return new UsdStage(layer, [layer]);
    }

    static async openUSDAWithResolver(src: string, resolver: UsdResolver, identifier = '<memory>'): Promise<UsdStage> {
        const root = parseUsdaToLayer(src, { identifier });
        const stack: SdfLayer[] = [root];

        const subLayers = extractSubLayerAssetPaths(root.metadata?.subLayers);
        for (const assetPath of subLayers) {
            const { identifier: subId, text } = await resolver.readText(assetPath, root.identifier);
            const subLayer = parseTextToLayer(text, subId);
            stack.push(subLayer);
        }

        return new UsdStage(root, stack);
    }

    /**
     * Returns prim paths in depth-first order (foundation helper for testing and viewport bootstrap).
     */
    listPrimPaths(): string[] {
        const out: string[] = [];
        const walk = (p: { path: SdfPath; children?: Map<string, any> }) => {
            out.push(p.path.toString());
            if (!p.children) return;
            for (const child of p.children.values()) walk(child);
        };
        walk(this.rootLayer.root);
        return out;
    }

    /**
     * Returns a composed prim index layer (Pcp-lite).
     *
     * Layers are applied weak-to-strong by stacking:
     * - sublayers (weaker) ... up to root layer (strongest)
     *
     * Note: this is an intentionally minimal placeholder that will be replaced
     * by real composition arcs (Pcp) over time.
     */
    composePrimIndex(): SdfLayer {
        // subLayers are authored as weakest -> strongest.
        // Our layerStack is [root, subLayer0, subLayer1, ...], so weakToStrong is [...sublayers, root].
        const weakToStrong = [...this.layerStack.slice(1), this.rootLayer];
        return composeLayerStack(weakToStrong);
    }

    /**
     * Compose prim index and apply a minimal reference/payload expansion pass.
     *
     * Supported (Pcp-lite):
     * - `prepend references = @./file.usda@`
     * - `prepend payload = @./file.usda@`
     *
     * This grafts the referenced/payloaded layer's defaultPrim (or first root child) into the target prim.
     */
    async composePrimIndexWithResolver(resolver: UsdResolver): Promise<SdfLayer> {
        const composed = this.composePrimIndex();

        // Phase 1: Apply variant selections FIRST so variant children become part of the composed layer.
        // This is needed because variant prims may have references that need expansion.
        applyVariantSelections(composed);

        // Phase 1.5: Apply internal references within the composed layer.
        // Important for stages like `Teapot/DrawModes.usd` which uses `append references = </World/SomePrim>`
        // to create drawMode duplicates inside the same layer.
        applyInternalReferences(composed);
        // Internal references may bring in new variant sets that need processing.
        applyVariantSelections(composed);

        // Phase 2: Walk composed prims and expand arcs.
        // First, collect arcs from original layerStack opinions (for prims authored directly in the stage).
        const primPaths = listPrimPaths(composed.root);
        for (const primPathStr of primPaths) {
            if (primPathStr === '/') continue;
            const p = SdfPath.parse(primPathStr);
            const dstPrim = composed.getPrim(p);
            if (!dstPrim) continue;

            // Apply arcs in weak->strong order across layerStack opinions.
            const arcOps = this.collectArcOpsForPrim(p);
            for (const op of arcOps) {
                const { identifier: refId, text } = await resolver.readText(op.assetPath, op.fromIdentifier);
                const layer = parseTextToLayer(text, refId);
                // Recursively expand arcs inside the loaded layer (payload-of-payload, reference chains, etc.).
                // This is required for samples like `simple_mesh_sphere_payload_nest.usda`.
                await expandArcsInLayer(layer, resolver);
                // Use targetPath if specified (e.g., @file@</Path>), otherwise use defaultPrim
                const srcPrim = pickSourcePrim(layer, op.targetPath);
                if (!srcPrim) continue;
                // Graft the referenced/payloaded prim into dstPrim with proper path remapping.
                // This keeps imported prims under `dstPrim` (instead of "hoisting" them to their original /World paths)
                // and remaps embedded SdfPaths (e.g. material bindings, shader connects) accordingly.
                const grafted = clonePrimWithRemappedPaths(srcPrim, dstPrim.path.primPath, srcPrim.path.primPath);
                mergePrimSpec(dstPrim, grafted);
            }

            // Also check for arcs directly on the composed prim's metadata.
            // This handles prims that came from variant selection (their refs won't be found in the layerStack).
            const composedArcOps = collectArcOpsFromPrimMetadata(dstPrim, composed.identifier);
            for (const op of composedArcOps) {
                const { identifier: refId, text } = await resolver.readText(op.assetPath, op.fromIdentifier);
                const layer = parseTextToLayer(text, refId);
                await expandArcsInLayer(layer, resolver);
                // Use targetPath if specified (e.g., @file@</Path>), otherwise use defaultPrim
                const srcPrim = pickSourcePrim(layer, op.targetPath);
                if (!srcPrim) continue;
                const grafted = clonePrimWithRemappedPaths(srcPrim, dstPrim.path.primPath, srcPrim.path.primPath);
                // Referenced/payloaded prim opinions should be WEAKER than the referencing prim.
                // Keep existing opinions on dstPrim (e.g. `variants = {...}` selections) and only fill missing data.
                mergePrimSpecWeakIntoStrong(dstPrim, grafted);
            }
        }

        // Phase 3: Apply variant selections AGAIN after arc expansion.
        // Variant content may come from referenced/payloaded layers (e.g. geo.usda with mesh inside variants).
        applyVariantSelections(composed);

        return composed;
    }

    private collectArcOpsForPrim(primPath: SdfPath): ArcOp[] {
        const layersWeakToStrong = [...this.layerStack.slice(1), this.rootLayer];
        const ops: ArcOp[] = [];
        for (const layer of layersWeakToStrong) {
            const prim = layer.getPrim(primPath);
            if (!prim || !prim.metadata) continue;
            const refs = extractArcRefs(prim.metadata.references);
            const pays = extractArcRefs(prim.metadata.payload);
            for (const a of refs) ops.push({ kind: 'references', assetPath: a.assetPath, targetPath: a.targetPath, fromIdentifier: layer.identifier });
            for (const a of pays) ops.push({ kind: 'payload', assetPath: a.assetPath, targetPath: a.targetPath, fromIdentifier: layer.identifier });
        }
        return ops;
    }
}

function extractSubLayerAssetPaths(v: SdfValue | undefined): string[] {
    if (!v || typeof v !== 'object') return [];
    if (v.type !== 'array') return [];
    const out: string[] = [];
    for (const el of v.value) {
        if (el && typeof el === 'object' && el.type === 'asset') out.push(el.value);
    }
    return out;
}

function listPrimPaths(root: any): string[] {
    const out: string[] = [];
    const walk = (p: any) => {
        out.push(p.path.toString());
        if (!p.children) return;
        for (const c of p.children.values()) walk(c);
    };
    walk(root);
    return out;
}

function pickDefaultPrim(layer: SdfLayer): any | null {
    const dp = layer.metadata?.defaultPrim;
    if (typeof dp === 'string') {
        const p = SdfPath.parse('/' + dp);
        return layer.getPrim(p);
    }
    // Fallback: first child under root
    const first = layer.root.children?.values().next().value ?? null;
    return first;
}

/**
 * Pick the source prim for a reference/payload arc.
 * If targetPath is specified (e.g., @file@</Path>), use that.
 * Otherwise, use the layer's defaultPrim.
 */
function pickSourcePrim(layer: SdfLayer, targetPath?: string): any | null {
    if (targetPath) {
        const p = SdfPath.parse(targetPath);
        return layer.getPrim(p);
    }
    return pickDefaultPrim(layer);
}

type ArcOp = { kind: 'references' | 'payload'; assetPath: string; targetPath?: string; fromIdentifier: string };

/**
 * Represents an extracted arc reference with optional target path.
 */
type ExtractedArc = { assetPath: string; targetPath?: string };

/**
 * Collect arc ops directly from a prim's metadata.
 * This is used for prims that came from variant selection where their references
 * won't be found in the original layerStack.
 */
function collectArcOpsFromPrimMetadata(prim: SdfPrimSpec, fromIdentifier: string): ArcOp[] {
    const ops: ArcOp[] = [];
    if (!prim.metadata) return ops;
    const refs = extractArcRefs(prim.metadata.references);
    const pays = extractArcRefs(prim.metadata.payload);
    for (const a of refs) ops.push({ kind: 'references', assetPath: a.assetPath, targetPath: a.targetPath, fromIdentifier });
    for (const a of pays) ops.push({ kind: 'payload', assetPath: a.assetPath, targetPath: a.targetPath, fromIdentifier });
    return ops;
}

/**
 * Extract arc references from metadata, including optional target paths.
 * Supports both simple asset paths (@file@) and references with targets (@file@</Path>).
 */
function extractArcRefs(v: SdfValue | undefined): ExtractedArc[] {
    if (!v) return [];
    if (typeof v === 'object' && v.type === 'asset') return [{ assetPath: v.value }];
    if (typeof v === 'object' && v.type === 'reference') return [{ assetPath: v.assetPath, targetPath: v.targetPath }];
    if (typeof v === 'object' && v.type === 'array') {
        return v.value.flatMap((x) => {
            if (x && typeof x === 'object' && x.type === 'asset') return [{ assetPath: x.value }];
            if (x && typeof x === 'object' && x.type === 'reference') return [{ assetPath: x.assetPath, targetPath: x.targetPath }];
            return [];
        });
    }
    // listOp representation from metadata parsing: { type:'dict', value:{ op: token, value: <SdfValue> } }
    if (typeof v === 'object' && v.type === 'dict') {
        const inner = v.value?.value as any;
        if (inner) return extractArcRefs(inner);
    }
    return [];
}

/** Legacy function for backward compatibility - extracts just asset paths without target info */
function extractArcAssetPaths(v: SdfValue | undefined): string[] {
    return extractArcRefs(v).map(r => r.assetPath);
}

/**
 * Extract internal SdfPath references (like </Some/Prim>) from references metadata.
 * These reference prims within the same layer rather than external files.
 */
function extractInternalRefPaths(v: SdfValue | undefined): string[] {
    if (!v) return [];
    if (typeof v === 'object' && v.type === 'sdfpath') return [v.value];
    // Internal references can also come through our parser as "reference" objects with an empty assetPath
    // and a targetPath pointing at a prim in the same layer, e.g. `append references = </World/Foo>`.
    if (typeof v === 'object' && v.type === 'reference') {
        const ap = (v as any).assetPath;
        const tp = (v as any).targetPath;
        if ((!ap || ap === '') && typeof tp === 'string' && tp.startsWith('/')) return [tp];
    }
    if (typeof v === 'object' && v.type === 'array') {
        return v.value.flatMap((x) => {
            if (!x || typeof x !== 'object') return [];
            if ((x as any).type === 'sdfpath') return [(x as any).value];
            if ((x as any).type === 'reference') {
                const ap = (x as any).assetPath;
                const tp = (x as any).targetPath;
                if ((!ap || ap === '') && typeof tp === 'string' && tp.startsWith('/')) return [tp];
            }
            return [];
        });
    }
    // listOp representation from metadata parsing: { type:'dict', value:{ op: token, value: <SdfValue> } }
    if (typeof v === 'object' && v.type === 'dict') {
        const inner = v.value?.value as any;
        if (inner) return extractInternalRefPaths(inner);
    }
    return [];
}

function remapSdfPathString(path: string, srcRoot: string, dstRoot: string): string {
    // Preserve property suffix (e.g. `/World/Looks/Mat/Shader.outputs:out`)
    if (path.startsWith('.')) return path; // relative property paths: don't remap
    const dot = path.indexOf('.');
    const primPart = dot >= 0 ? path.slice(0, dot) : path;
    const suffix = dot >= 0 ? path.slice(dot) : '';

    if (primPart === srcRoot) return dstRoot + suffix;
    if (primPart.startsWith(srcRoot + '/')) return dstRoot + primPart.slice(srcRoot.length) + suffix;
    return path;
}

function remapSdfValue(v: SdfValue, srcRoot: string, dstRoot: string): SdfValue {
    if (v === null) return v;
    if (typeof v !== 'object') return v;
    if ((v as any).type === 'sdfpath' && typeof (v as any).value === 'string') {
        return { type: 'sdfpath', value: remapSdfPathString((v as any).value, srcRoot, dstRoot) } as any;
    }
    if ((v as any).type === 'array' && Array.isArray((v as any).value)) {
        return { type: 'array', value: (v as any).value.map((x: any) => remapSdfValue(x, srcRoot, dstRoot)) } as any;
    }
    if ((v as any).type === 'tuple' && Array.isArray((v as any).value)) {
        return { type: 'tuple', value: (v as any).value.map((x: any) => remapSdfValue(x, srcRoot, dstRoot)) } as any;
    }
    if ((v as any).type === 'dict' && (v as any).value && typeof (v as any).value === 'object') {
        // Two possibilities in our parser:
        // - regular dict: { type:'dict', value: Record<string,SdfValue> }
        // - listOp dict: { type:'dict', value: { op: token, value: <SdfValue> } }
        const obj = (v as any).value as Record<string, any>;
        const out: Record<string, any> = {};
        for (const [k, vv] of Object.entries(obj)) out[k] = remapSdfValue(vv as any, srcRoot, dstRoot);
        return { type: 'dict', value: out } as any;
    }
    // token/asset etc: keep as-is
    return v;
}

function clonePropSpecWithRemap(
    key: string,
    spec: SdfPropertySpec,
    newPrimPath: string,
    srcRoot: string,
    dstRoot: string
): SdfPropertySpec {
    const lastDot = key.lastIndexOf('.');
    const propName = lastDot > 0 ? key.slice(0, lastDot) : key;
    const fieldName = lastDot > 0 ? key.slice(lastDot + 1) : null;
    const path = SdfPath.property(newPrimPath, propName, fieldName);
    const out: SdfPropertySpec = {
        path,
        typeName: spec.typeName,
        defaultValue: spec.defaultValue !== undefined ? remapSdfValue(spec.defaultValue as any, srcRoot, dstRoot) : undefined,
        metadata: {},
    };
    if (spec.metadata) {
        out.metadata = {};
        for (const [k, v] of Object.entries(spec.metadata)) out.metadata[k] = remapSdfValue(v as any, srcRoot, dstRoot) as any;
    }
    return out;
}

function clonePrimWithRemappedPaths(src: SdfPrimSpec, dstPrimPath: string, srcRoot: string): SdfPrimSpec {
    // Map srcRoot -> dstPrimPath for all embedded SdfPaths and re-root prim/property paths.
    const dstRoot = dstPrimPath;

    const clone = (p: SdfPrimSpec, newPath: string): SdfPrimSpec => {
        const out: SdfPrimSpec = {
            path: SdfPath.parse(newPath),
            specifier: p.specifier,
            typeName: p.typeName,
            metadata: {},
            properties: new Map(),
            children: new Map(),
        };

        if (p.metadata) {
            out.metadata = {};
            for (const [k, v] of Object.entries(p.metadata)) out.metadata[k] = remapSdfValue(v as any, srcRoot, dstRoot) as any;
        }

        if (p.properties) {
            out.properties = new Map();
            for (const [k, spec] of p.properties.entries()) {
                out.properties.set(k, clonePropSpecWithRemap(k, spec, newPath, srcRoot, dstRoot));
            }
        }

        if (p.children) {
            out.children = new Map();
            for (const [name, child] of p.children.entries()) {
                const childPath = newPath === '/' ? `/${name}` : `${newPath}/${name}`;
                out.children.set(name, clone(child, childPath));
            }
        }

        // Clone variantSets if present (critical for internal references to prims with variants)
        if ((p as any).variantSets) {
            const srcVS: Map<string, any> = (p as any).variantSets;
            const dstVS: Map<string, any> = new Map();
            for (const [setName, set] of srcVS.entries()) {
                const clonedVariants: Map<string, SdfPrimSpec> = new Map();
                if (set.variants) {
                    for (const [variantName, variantPrim] of set.variants.entries()) {
                        // Variant prims are rooted at the parent prim, so clone them with the new path
                        clonedVariants.set(variantName, clone(variantPrim, newPath));
                    }
                }
                dstVS.set(setName, { variants: clonedVariants });
            }
            (out as any).variantSets = dstVS;
        }

        return out;
    };

    return clone(src, dstPrimPath);
}

async function expandArcsInLayer(layer: SdfLayer, resolver: UsdResolver): Promise<void> {
    // Expand arcs (references/payload) authored inside `layer` itself.
    // Unlike `UsdStage.collectArcOpsForPrim` (which consults the stage's layerStack),
    // this handles nested arcs inside referenced/payloaded layers.
    const applied = new Set<string>();
    const inProgress = new Set<string>(); // recursion guard by layer identifier
    const subLayersApplied = new Set<string>(); // guard per layer identifier (avoid re-composing same layer)
    const debug = false;

    const walk = async (curLayer: SdfLayer): Promise<void> => {
        if (inProgress.has(curLayer.identifier)) return; // prevent cycles A -> B -> A
        inProgress.add(curLayer.identifier);

        // Phase 0: Compose subLayers into this layer (common for payload layers that contain no prims themselves).
        // USD subLayers are authored weakest -> strongest. The current layer is the strongest in its own stack.
        if (!subLayersApplied.has(curLayer.identifier)) {
            subLayersApplied.add(curLayer.identifier);
            const subLayerAssetPaths = extractSubLayerAssetPaths(curLayer.metadata?.subLayers);
            if (subLayerAssetPaths.length > 0) {
                if (debug) {
                    console.debug(
                        `[expandArcsInLayer] layer=${curLayer.identifier} composing subLayers=[${subLayerAssetPaths.join(', ')}]`
                    );
                }
                const subLayers: SdfLayer[] = [];
                for (const subPath of subLayerAssetPaths) {
                    const { identifier: subId, text: subText } = await resolver.readText(subPath, curLayer.identifier);
                    const subLayer = parseTextToLayer(subText, subId);
                    await walk(subLayer);
                    subLayers.push(subLayer);
                }

                const composed = composeLayerStack([...subLayers, curLayer]);

                // Overwrite `curLayer` in-place so outer callers still hold the same object reference.
                // Note: `SdfLayer.root` and `SdfLayer.metadata` are readonly references, but their contents are mutable.
                curLayer.root.typeName = composed.root.typeName;
                curLayer.root.specifier = composed.root.specifier;
                curLayer.root.metadata = composed.root.metadata;
                curLayer.root.properties = composed.root.properties;
                curLayer.root.children = composed.root.children;
                (curLayer.root as any).variantSets = (composed.root as any).variantSets;

                for (const k of Object.keys(curLayer.metadata)) delete (curLayer.metadata as any)[k];
                for (const [k, v] of Object.entries(composed.metadata ?? {})) (curLayer.metadata as any)[k] = v;
            }
        }

        // Apply variant selections before expanding arcs so variant children become part of the layer.
        applyVariantSelections(curLayer);

        // First pass: Apply internal references (</SomePrim>) within the same layer.
        // This must happen before external arc expansion since internal refs may bring in content
        // that has external references or variant sets.
        applyInternalReferences(curLayer);

        // Apply variant selections again after internal references are resolved.
        applyVariantSelections(curLayer);

        const primPaths = listPrimPaths(curLayer.root);
        for (const primPathStr of primPaths) {
            if (primPathStr === '/') continue;
            const p = SdfPath.parse(primPathStr);
            const dstPrim = curLayer.getPrim(p);
            if (!dstPrim || !dstPrim.metadata) continue;

            const refs = extractArcRefs(dstPrim.metadata.references);
            const pays = extractArcRefs(dstPrim.metadata.payload);

            // Apply references first, then payloads (matches common authoring expectations for these samples).
            const all: Array<{ kind: 'references' | 'payload'; assetPath: string; targetPath?: string }> = [
                ...refs.map((a) => ({ kind: 'references' as const, assetPath: a.assetPath, targetPath: a.targetPath })),
                ...pays.map((a) => ({ kind: 'payload' as const, assetPath: a.assetPath, targetPath: a.targetPath })),
            ];

            for (const op of all) {
                const key = `${curLayer.identifier}|${primPathStr}|${op.kind}|${op.assetPath}`;
                if (applied.has(key)) continue;
                applied.add(key);

                const { identifier: childId, text } = await resolver.readText(op.assetPath, curLayer.identifier);
                let childLayer = parseTextToLayer(text, childId);

                // Handle sublayers in the child layer (e.g., payload file that references geom/look sublayers)
                const childSubLayers = extractSubLayerAssetPaths(childLayer.metadata?.subLayers);
                if (childSubLayers.length > 0) {
                    const subLayerStack: SdfLayer[] = [];
                    for (const subPath of childSubLayers) {
                        const { identifier: subId, text: subText } = await resolver.readText(subPath, childId);
                        const subLayer = parseTextToLayer(subText, subId);
                        // Recursively expand arcs in each sublayer
                        await walk(subLayer);
                        subLayerStack.push(subLayer);
                    }
                    // Compose sublayers (weak to strong) then childLayer on top (strongest)
                    childLayer = composeLayerStack([...subLayerStack, childLayer]);
                }

                // Recursively expand arcs in the child layer before grafting it in.
                await walk(childLayer);

                // Use targetPath if specified (e.g., @file@</Path>), otherwise use defaultPrim
                const srcPrim = pickSourcePrim(childLayer, op.targetPath);
                if (!srcPrim) {
                    const dp = childLayer.metadata?.defaultPrim;
                    if (debug) {
                        console.debug(
                            `[expandArcsInLayer] graft skipped: no srcPrim found. childLayer=${childLayer.identifier} targetPath=${op.targetPath ?? 'n/a'} defaultPrim=${typeof dp === 'string' ? dp : 'n/a'}`
                        );
                    }
                }
                if (!srcPrim) continue;
                const grafted = clonePrimWithRemappedPaths(srcPrim, dstPrim.path.primPath, srcPrim.path.primPath);
                mergePrimSpec(dstPrim, grafted);
            }
        }

        // Apply variant selections AGAIN after arc expansion to handle variants from loaded layers.
        applyVariantSelections(curLayer);

        inProgress.delete(curLayer.identifier);
    };

    await walk(layer);
}

/**
 * Apply internal references (like </Some/Prim>) within a layer.
 * This finds prims that reference other prims in the same layer and merges them.
 */
function applyInternalReferences(layer: SdfLayer): void {
    const prims = listPrimSpecs(layer.root);
    for (const prim of prims) {
        if (!prim.metadata) continue;
        const internalRefs = extractInternalRefPaths(prim.metadata.references);
        if (internalRefs.length === 0) continue;
        // With USD's prepend semantics, the FIRST item in the list has HIGHEST priority.
        // We apply weaker refs first, then stronger ones on top, so iterate in REVERSE order.
        const refsInComposeOrder = [...internalRefs].reverse();
        // NOTE: keep this silent by default; use a debugger when working on composition.
        for (const refPath of refsInComposeOrder) {
            const srcPrim = layer.getPrim(SdfPath.parse(refPath));
            if (!srcPrim) continue;
            // Clone the referenced prim with path remapping and merge into the target.
            const grafted = clonePrimWithRemappedPaths(srcPrim, prim.path.primPath, srcPrim.path.primPath);
            // Internal references should not overwrite opinions authored on the referencing prim.
            mergePrimSpecWeakIntoStrong(prim, grafted);
        }
    }
}

function applyVariantSelections(layer: SdfLayer): void {
    // Keep applying until no more changes occur (handles nested variants).
    // A variant may add new variantSets that need processing.
    const appliedSelections = new Set<string>(); // Track "primPath:setName:variantName"

    let madeChanges = true;
    while (madeChanges) {
        madeChanges = false;
        const prims = listPrimSpecs(layer.root);
        for (const prim of prims) {
            if (!prim.variantSets || !prim.metadata) continue;
            const variantsMeta = prim.metadata.variants;
            if (!variantsMeta || typeof variantsMeta !== 'object' || variantsMeta.type !== 'dict') continue;

            for (const [setName, set] of prim.variantSets.entries()) {
                const selection = variantsMeta.value?.[setName];
                const variantName =
                    typeof selection === 'string'
                        ? selection
                        : selection && typeof selection === 'object' && selection.type === 'token'
                            ? selection.value
                            : null;
                if (!variantName) continue;

                const key = `${prim.path.primPath}:${setName}:${variantName}`;
                if (appliedSelections.has(key)) continue; // Already applied

                const variantPrim = set.variants.get(variantName);
                if (!variantPrim) continue;

                appliedSelections.add(key);
                mergePrimSpec(prim, variantPrim);
                madeChanges = true; // A variant was applied, need to re-check for nested ones
            }
        }
    }
}

function listPrimSpecs(root: any): any[] {
    const out: any[] = [];
    const walk = (p: any) => {
        out.push(p);
        if (!p.children) return;
        for (const c of p.children.values()) walk(c);
    };
    walk(root);
    return out;
}

