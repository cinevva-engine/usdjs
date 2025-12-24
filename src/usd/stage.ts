import { SdfLayer, type SdfPrimSpec, type SdfPropertySpec, type SdfValue } from '../sdf/layer.js';
import { SdfPath } from '../sdf/path.js';
import { parseUsdaToLayer } from '../usda/parser.js';
import { parseUsdcToLayer } from '../usdc/parser.js';
import { parseUsdzToLayer, isUsdzContent } from '../usdz/parser.js';
import { parseMaterialXToLayer, isMaterialXContent } from '../materialx/parser.js';
import { composeLayerStack, mergePrimSpec, mergePrimSpecWeakIntoStrong } from './compose.js';
import { resolveAssetPath, type UsdResolver } from './resolver.js';

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

    /**
     * Open a USDC (binary crate format) file.
     * 
     * @param buffer - ArrayBuffer or Uint8Array containing the USDC file data
     * @param identifier - Optional identifier for the layer (defaults to '<memory>')
     * @returns UsdStage containing the parsed layer
     */
    static openUSDC(buffer: ArrayBuffer | Uint8Array, identifier = '<memory>'): UsdStage {
        const layer = parseUsdcToLayer(buffer, { identifier });
        return new UsdStage(layer, [layer]);
    }

    /**
     * Open a USDZ (ZIP archive) file.
     * Uses browser's native DecompressionStream API for deflate decompression.
     * 
     * @param buffer - ArrayBuffer or Uint8Array containing the USDZ file data
     * @param identifier - Optional identifier for the layer (defaults to '<memory>')
     * @returns Promise<UsdStage> containing the parsed layer
     */
    static async openUSDZ(buffer: ArrayBuffer | Uint8Array, identifier = '<memory>'): Promise<UsdStage> {
        const layer = await parseUsdzToLayer(buffer, { identifier });
        return new UsdStage(layer, [layer]);
    }

    /**
     * Auto-detect USD format (USDA text or USDC binary) and open.
     * Note: For USDZ files, use openUSDZ() instead (async).
     * 
     * @param data - String (USDA) or ArrayBuffer/Uint8Array (USDC)
     * @param identifier - Optional identifier for the layer
     * @returns UsdStage containing the parsed layer
     */
    static open(data: string | ArrayBuffer | Uint8Array, identifier = '<memory>'): UsdStage {
        if (typeof data === 'string') {
            return UsdStage.openUSDA(data, identifier);
        }

        // Check for USDC magic header "PXR-USDC"
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        if (bytes.length >= 8 &&
            bytes[0] === 0x50 && // P
            bytes[1] === 0x58 && // X
            bytes[2] === 0x52 && // R
            bytes[3] === 0x2D && // -
            bytes[4] === 0x55 && // U
            bytes[5] === 0x53 && // S
            bytes[6] === 0x44 && // D
            bytes[7] === 0x43) { // C
            return UsdStage.openUSDC(bytes, identifier);
        }

        // Try as text (USDA)
        const text = new TextDecoder('utf-8').decode(bytes);
        return UsdStage.openUSDA(text, identifier);
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
        // Preserve a stable identifier for correct relative path resolution during later arc expansion.
        return composeLayerStack(weakToStrong, this.rootLayer.identifier);
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
        // Cache parsed (and arc-expanded) layers by identifier. Real-world scenes (like the teapot grid)
        // can reference the same asset dozens of times; without caching, we repeatedly parse/expand the
        // same files and the viewer can appear to hang.
        const layerCache = new Map<string, SdfLayer>();
        const expandedLayerIds = new Set<string>();
        const composed = this.composePrimIndex();
        const protoPathByKey = new Map<string, string>();
        let protoCounter = 0;

        /**
         * Read+parse a layer with aggressive caching keyed by the *resolved identifier*.
         *
         * Why: `resolver.readText()` typically does both resolution and I/O (fetch/fs). Even if we cache the parsed
         * `SdfLayer`, calling `readText()` repeatedly for the same `(assetPath, fromIdentifier)` can flood the browser
         * with network requests (appearing "stuck") for heavily-instanced scenes like the teapot grid.
         */
        const readLayerCached = async (assetPath: string, fromIdentifier: string): Promise<SdfLayer> => {
            const resolvedGuess = resolveAssetPath(assetPath, fromIdentifier);
            const cachedGuess = layerCache.get(resolvedGuess);
            if (cachedGuess) return cachedGuess;

            const { identifier: id, text } = await resolver.readText(assetPath, fromIdentifier);
            const cached = layerCache.get(id);
            if (cached) {
                // Also alias by our resolved guess (helps when resolver normalizes differently).
                if (!layerCache.has(resolvedGuess)) layerCache.set(resolvedGuess, cached);
                return cached;
            }
            const layer = parseTextToLayer(text, id);
            layerCache.set(id, layer);
            if (!layerCache.has(resolvedGuess)) layerCache.set(resolvedGuess, layer);
            return layer;
        };

        const ensurePathParents = (l: SdfLayer, primPath: string): void => {
            const parts = primPath.split('/').filter(Boolean);
            if (parts.length <= 1) return;
            for (let i = 0; i < parts.length - 1; i++) {
                const p = '/' + parts.slice(0, i + 1).join('/');
                l.ensurePrim(SdfPath.parse(p), 'def');
            }
        };

        const attachPrimAtPath = (l: SdfLayer, prim: SdfPrimSpec): void => {
            const p = prim.path.primPath;
            if (p === '/' || !p.startsWith('/')) return;
            ensurePathParents(l, p);
            const parts = p.split('/').filter(Boolean);
            let cur = l.root;
            for (let i = 0; i < parts.length; i++) {
                const name = parts[i]!;
                if (!cur.children) cur.children = new Map();
                if (i === parts.length - 1) {
                    cur.children.set(name, prim);
                    return;
                }
                let next = cur.children.get(name);
                if (!next) {
                    next = l.ensurePrim(SdfPath.parse('/' + parts.slice(0, i + 1).join('/')), 'def');
                    cur.children.set(name, next);
                }
                cur = next;
            }
        };

        const isInstanceablePrim = (p: SdfPrimSpec): boolean => {
            const md = p.metadata ?? {};
            const v = (md as any).instanceable;
            return v === true || (typeof v === 'number' && v !== 0);
        };

        // Phase 1: Apply variant selections FIRST so variant children become part of the composed layer.
        // This is needed because variant prims may have references that need expansion.
        applyVariantSelections(composed);

        // Phase 1.5: Apply internal references within the composed layer.
        // Important for stages like `Teapot/DrawModes.usd` which uses `append references = </World/SomePrim>`
        // to create drawMode duplicates inside the same layer.
        applyInternalReferences(composed);
        // Apply inherits within the composed layer (common for animation cycles and class-based authoring).
        applyInherits(composed);
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

            // Accumulate arcs separately so later (stronger) arcs can override earlier (weaker) arcs,
            // while still keeping authored opinions on `dstPrim` strongest.
            const arcAccum: SdfPrimSpec = {
                path: SdfPath.parse(dstPrim.path.primPath),
                specifier: 'def',
                metadata: {},
                properties: new Map(),
                children: new Map(),
            };

            // Apply arcs in weak->strong order across layerStack opinions.
            const arcOps = this.collectArcOpsForPrim(p);
            for (const op of arcOps) {
                // Prototype instancing: if this prim is instanceable and has an external reference,
                // don't graft the whole asset into every instance. Instead, materialize one prototype
                // under `/__usdjs_prototypes/...` and convert the instance's references metadata to an
                // internal sdfpath reference. The viewer can render these efficiently.
                if (op.kind === 'references' && isInstanceablePrim(dstPrim)) {
                    const isExternalRef = typeof op.assetPath === 'string' && op.assetPath.length > 0 && !op.assetPath.startsWith('/');
                    if (isExternalRef) {
                        const k = `${op.assetPath}|${op.targetPath ?? ''}|${op.fromIdentifier}`;
                        let protoPath = protoPathByKey.get(k);
                        if (!protoPath) {
                            protoCounter++;
                            protoPath = `/__usdjs_prototypes/p${protoCounter}`;
                            protoPathByKey.set(k, protoPath);

                            const layer = await readLayerCached(op.assetPath, op.fromIdentifier);
                            await expandArcsInLayer(layer, resolver, undefined, layerCache, expandedLayerIds);
                            const srcPrim = pickSourcePrim(layer, op.targetPath);
                            if (srcPrim) {
                                const protoPrim = clonePrimWithRemappedPaths(srcPrim, protoPath, srcPrim.path.primPath);
                                attachPrimAtPath(composed, protoPrim);
                            }
                        }

                        dstPrim.metadata ??= {};
                        (dstPrim.metadata as any).references = { type: 'sdfpath', value: protoPath };
                        continue;
                    }
                }

                const layer = await readLayerCached(op.assetPath, op.fromIdentifier);
                // Recursively expand arcs inside the loaded layer (payload-of-payload, reference chains, etc.).
                // This is required for samples like `simple_mesh_sphere_payload_nest.usda`.
                await expandArcsInLayer(layer, resolver, undefined, layerCache, expandedLayerIds);
                // Use targetPath if specified (e.g., @file@</Path>), otherwise use defaultPrim
                const srcPrim = pickSourcePrim(layer, op.targetPath);
                if (!srcPrim) continue;
                // Graft the referenced/payloaded prim into dstPrim with proper path remapping.
                // This keeps imported prims under `dstPrim` (instead of "hoisting" them to their original /World paths)
                // and remaps embedded SdfPaths (e.g. material bindings, shader connects) accordingly.
                const grafted = clonePrimWithRemappedPaths(srcPrim, dstPrim.path.primPath, srcPrim.path.primPath);
                // Compose arcs among themselves (weak->strong). We'll merge into dstPrim at the end as weak opinions.
                mergePrimSpec(arcAccum, grafted);
            }

            // Also check for arcs directly on the composed prim's metadata.
            // This handles prims that came from variant selection (their refs won't be found in the layerStack).
            const composedArcOps = collectArcOpsFromPrimMetadata(dstPrim, composed.identifier);
            for (const op of composedArcOps) {
                if (op.kind === 'references' && isInstanceablePrim(dstPrim)) {
                    const isExternalRef = typeof op.assetPath === 'string' && op.assetPath.length > 0 && !op.assetPath.startsWith('/');
                    if (isExternalRef) {
                        const k = `${op.assetPath}|${op.targetPath ?? ''}|${op.fromIdentifier}`;
                        let protoPath = protoPathByKey.get(k);
                        if (!protoPath) {
                            protoCounter++;
                            protoPath = `/__usdjs_prototypes/p${protoCounter}`;
                            protoPathByKey.set(k, protoPath);

                            const layer = await readLayerCached(op.assetPath, op.fromIdentifier);
                            await expandArcsInLayer(layer, resolver, undefined, layerCache, expandedLayerIds);
                            const srcPrim = pickSourcePrim(layer, op.targetPath);
                            if (srcPrim) {
                                const protoPrim = clonePrimWithRemappedPaths(srcPrim, protoPath, srcPrim.path.primPath);
                                attachPrimAtPath(composed, protoPrim);
                            }
                        }

                        dstPrim.metadata ??= {};
                        (dstPrim.metadata as any).references = { type: 'sdfpath', value: protoPath };
                        continue;
                    }
                }

                const layer = await readLayerCached(op.assetPath, op.fromIdentifier);
                await expandArcsInLayer(layer, resolver, undefined, layerCache, expandedLayerIds);
                // Use targetPath if specified (e.g., @file@</Path>), otherwise use defaultPrim
                const srcPrim = pickSourcePrim(layer, op.targetPath);
                if (!srcPrim) continue;
                const grafted = clonePrimWithRemappedPaths(srcPrim, dstPrim.path.primPath, srcPrim.path.primPath);
                // Compose arcs among themselves (weak->strong). We'll merge into dstPrim at the end as weak opinions.
                mergePrimSpec(arcAccum, grafted);
            }

            // Finally apply the composed arc opinions as WEAK, so authored opinions on dstPrim remain strongest.
            mergePrimSpecWeakIntoStrong(dstPrim, arcAccum);
        }

        // Inherits often targets classes that themselves reference/payload external content (e.g. teapot animCycle).
        // Apply after arc expansion so inherited prims carry the expanded opinions.
        applyInherits(composed);

        // Phase 3: Apply variant selections AGAIN after arc expansion.
        // Variant content may come from referenced/payloaded layers (e.g. geo.usda with mesh inside variants).
        applyVariantSelections(composed);
        // Variant selection can also introduce internal references (common pattern for duplicating subtrees,
        // e.g. multiple wheels referencing a single wheel asset prim). Re-apply internal references at the end
        // so those authored `</Prim>` refs get resolved into real children/geometry.
        applyInternalReferences(composed);
        applyVariantSelections(composed);

        // Phase 4: Variant selection can introduce NEW external arcs (references/payloads) inside the selected
        // variant content (e.g. wheelVariants.usda defines wheelBlackAsset as a def with a reference to an asset file).
        // Our earlier arc expansion pass couldn't see those prims because they didn't exist until variants were applied.
        // Run a final in-layer arc expansion pass to graft those assets in.
        // IMPORTANT: Use rootLayer identifier for subLayer resolution, not '<composed>' which breaks relative paths
        await expandArcsInLayer(composed, resolver, this.rootLayer.identifier, layerCache, expandedLayerIds);
        // And apply inherits one last time in case variant/arc expansion introduced new inherited class opinions.
        applyInherits(composed);

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
            for (const a of refs) ops.push({ kind: 'references', assetPath: a.assetPath, targetPath: a.targetPath, fromIdentifier: a.fromIdentifier ?? layer.identifier });
            for (const a of pays) ops.push({ kind: 'payload', assetPath: a.assetPath, targetPath: a.targetPath, fromIdentifier: a.fromIdentifier ?? layer.identifier });
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
type ExtractedArc = { assetPath: string; targetPath?: string; fromIdentifier?: string };

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
    for (const a of refs) ops.push({ kind: 'references', assetPath: a.assetPath, targetPath: a.targetPath, fromIdentifier: a.fromIdentifier ?? fromIdentifier });
    for (const a of pays) ops.push({ kind: 'payload', assetPath: a.assetPath, targetPath: a.targetPath, fromIdentifier: a.fromIdentifier ?? fromIdentifier });
    return ops;
}

/**
 * Extract arc references from metadata, including optional target paths.
 * Supports both simple asset paths (@file@) and references with targets (@file@</Path>).
 */
function extractArcRefs(v: SdfValue | undefined): ExtractedArc[] {
    if (!v) return [];
    if (typeof v === 'object' && v.type === 'asset') {
        const fromIdentifier = typeof (v as any).__fromIdentifier === 'string' ? (v as any).__fromIdentifier : undefined;
        return [{ assetPath: v.value, fromIdentifier }];
    }
    if (typeof v === 'object' && v.type === 'reference') {
        const fromIdentifier = typeof (v as any).__fromIdentifier === 'string' ? (v as any).__fromIdentifier : undefined;
        return [{
            assetPath: v.assetPath,
            targetPath: typeof (v as any).targetPath === 'string' ? (v as any).targetPath : undefined,
            fromIdentifier
        }];
    }
    if (typeof v === 'object' && v.type === 'array') {
        return v.value.flatMap((x) => {
            if (x && typeof x === 'object' && x.type === 'asset') {
                const fromIdentifier = typeof (x as any).__fromIdentifier === 'string' ? (x as any).__fromIdentifier : undefined;
                return [{ assetPath: x.value, fromIdentifier }];
            }
            if (x && typeof x === 'object' && x.type === 'reference') {
                const fromIdentifier = typeof (x as any).__fromIdentifier === 'string' ? (x as any).__fromIdentifier : undefined;
                return [{ assetPath: x.assetPath, targetPath: typeof (x as any).targetPath === 'string' ? (x as any).targetPath : undefined, fromIdentifier }];
            }
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
    const normalizeInternalPath = (p: string): string => {
        // Internal references in USDA are commonly written as `</Prim/Path>` (angle-bracketed).
        // Our SdfPath parser expects plain `/Prim/Path`, so strip wrappers.
        if (p.startsWith('<') && p.endsWith('>')) return p.slice(1, -1);
        return p;
    };

    if (typeof v === 'object' && v.type === 'sdfpath') return [normalizeInternalPath(v.value)];
    // Internal references can also come through our parser as "reference" objects with an empty assetPath
    // and a targetPath pointing at a prim in the same layer, e.g. `append references = </World/Foo>`.
    if (typeof v === 'object' && v.type === 'reference') {
        const ap = (v as any).assetPath;
        const tp = (v as any).targetPath;
        if ((!ap || ap === '') && typeof tp === 'string') {
            const norm = normalizeInternalPath(tp);
            if (norm.startsWith('/')) return [norm];
        }
    }
    if (typeof v === 'object' && v.type === 'array') {
        return v.value.flatMap((x) => {
            if (!x || typeof x !== 'object') return [];
            if ((x as any).type === 'sdfpath') return [normalizeInternalPath((x as any).value)];
            if ((x as any).type === 'reference') {
                const ap = (x as any).assetPath;
                const tp = (x as any).targetPath;
                if ((!ap || ap === '') && typeof tp === 'string') {
                    const norm = normalizeInternalPath(tp);
                    if (norm.startsWith('/')) return [norm];
                }
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

async function expandArcsInLayer(
    layer: SdfLayer,
    resolver: UsdResolver,
    baseIdentifierForSubLayers?: string,
    layerCache?: Map<string, SdfLayer>,
    expandedLayerIds?: Set<string>
): Promise<void> {
    // If the caller provided a cross-call cache, skip layers we've already fully expanded.
    if (expandedLayerIds?.has(layer.identifier)) return;
    // Expand arcs (references/payload) authored inside `layer` itself.
    // Unlike `UsdStage.collectArcOpsForPrim` (which consults the stage's layerStack),
    // this handles nested arcs inside referenced/payloaded layers.
    const applied = new Set<string>();
    const inProgress = new Set<string>(); // recursion guard by layer identifier
    const subLayersApplied = new Set<string>(); // guard per layer identifier (avoid re-composing same layer)
    const debug = false;

    // Prototype instancing support for `instanceable = true` + external references.
    // We materialize the referenced asset once under `/__usdjs_prototypes/...` and convert instance prims
    // to internal references to that prototype. The viewer already knows how to render instanceable prims
    // with internal sdfpath references without fully expanding them.
    const prototypePathByKey: Map<string, string> =
        ((layer as any).__usdjsPrototypePathByKey ??= new Map<string, string>());
    let prototypeCounter = ((layer as any).__usdjsPrototypeCounter ??= 0) as number;

    const ensurePathParents = (l: SdfLayer, primPath: string): void => {
        const parts = primPath.split('/').filter(Boolean);
        if (parts.length <= 1) return;
        // ensure all parents exist as placeholders
        for (let i = 0; i < parts.length - 1; i++) {
            const p = '/' + parts.slice(0, i + 1).join('/');
            l.ensurePrim(SdfPath.parse(p), 'def');
        }
    };

    const attachPrimAtPath = (l: SdfLayer, prim: SdfPrimSpec): void => {
        const p = prim.path.primPath;
        if (p === '/' || !p.startsWith('/')) return;
        ensurePathParents(l, p);
        const parts = p.split('/').filter(Boolean);
        let cur = l.root;
        for (let i = 0; i < parts.length; i++) {
            const name = parts[i]!;
            if (!cur.children) cur.children = new Map();
            if (i === parts.length - 1) {
                cur.children.set(name, prim);
                return;
            }
            let next = cur.children.get(name);
            if (!next) {
                next = l.ensurePrim(SdfPath.parse('/' + parts.slice(0, i + 1).join('/')), 'def');
                cur.children.set(name, next);
            }
            cur = next;
        }
    };

    const isInstanceablePrim = (p: SdfPrimSpec): boolean => {
        const md = p.metadata ?? {};
        const v = (md as any).instanceable;
        return v === true || (typeof v === 'number' && v !== 0);
    };

    const walk = async (curLayer: SdfLayer, baseId?: string): Promise<void> => {
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
                // Use baseId for composed layers (which have identifier '<composed>'), otherwise use curLayer.identifier
                const resolveId = (baseId && curLayer.identifier === '<composed>') ? baseId : curLayer.identifier;
                for (const subPath of subLayerAssetPaths) {
                    const resolvedGuess = resolveAssetPath(subPath, resolveId);
                    let subLayer = layerCache?.get(resolvedGuess);
                    if (!subLayer) {
                        const { identifier: subId, text: subText } = await resolver.readText(subPath, resolveId);
                        subLayer = layerCache?.get(subId);
                        if (!subLayer) {
                            subLayer = parseTextToLayer(subText, subId);
                            layerCache?.set(subId, subLayer);
                        }
                        if (!layerCache?.has(resolvedGuess)) layerCache?.set(resolvedGuess, subLayer);
                    }
                    await walk(subLayer, baseId);
                    subLayers.push(subLayer);
                }

                const composed = composeLayerStack([...subLayers, curLayer], curLayer.identifier);

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
        // Inherits can also bring in additional authored opinions that include arcs/variants.
        applyInherits(curLayer);

        // Apply variant selections again after internal references are resolved.
        applyVariantSelections(curLayer);

        const primPaths = listPrimPaths(curLayer.root);
        for (const primPathStr of primPaths) {
            if (primPathStr === '/') continue;
            const p = SdfPath.parse(primPathStr);
            const dstPrim = curLayer.getPrim(p);
            if (!dstPrim || !dstPrim.metadata) continue;

            // Accumulate arcs separately so later (stronger) arcs can override earlier (weaker) arcs,
            // while keeping authored opinions on dstPrim strongest.
            let arcAccum: SdfPrimSpec | null = null;
            const ensureArcAccum = (): SdfPrimSpec => {
                if (arcAccum) return arcAccum;
                arcAccum = {
                    path: SdfPath.parse(dstPrim.path.primPath),
                    specifier: 'def',
                    metadata: {},
                    properties: new Map(),
                    children: new Map(),
                };
                return arcAccum;
            };

            const refs = extractArcRefs(dstPrim.metadata.references);
            const pays = extractArcRefs(dstPrim.metadata.payload);

            // For composed layers, use the provided baseId for relative resolution instead of '<composed>'.
            const layerResolveId = (baseId && curLayer.identifier === '<composed>') ? baseId : curLayer.identifier;

            // Apply references first, then payloads (matches common authoring expectations for these samples).
            const all: Array<{ kind: 'references' | 'payload'; assetPath: string; targetPath?: string; fromIdentifier: string }> = [
                ...refs.map((a) => ({ kind: 'references' as const, assetPath: a.assetPath, targetPath: a.targetPath, fromIdentifier: a.fromIdentifier ?? layerResolveId })),
                ...pays.map((a) => ({ kind: 'payload' as const, assetPath: a.assetPath, targetPath: a.targetPath, fromIdentifier: a.fromIdentifier ?? layerResolveId })),
            ];

            for (const op of all) {
                const key = `${curLayer.identifier}|${primPathStr}|${op.kind}|${op.assetPath}`;
                if (applied.has(key)) continue;
                applied.add(key);

                // Persistently guard against re-expanding the same arc on the same prim.
                // We call expandArcsInLayer multiple times across composition phases; without a per-prim marker,
                // the same `references/payload` can be grafted repeatedly (exploding work / appearing like an infinite loop).
                const expanded: Set<string> = ((dstPrim as any).__usdjsExpandedArcs ??= new Set<string>());
                const expandedKey = `${op.kind}|${op.assetPath}|${op.targetPath ?? ''}|${op.fromIdentifier}`;
                if (expanded.has(expandedKey)) continue;
                expanded.add(expandedKey);

                // If this is an instanceable prim with an external reference, convert to prototype + internal reference.
                // This avoids grafting the full teapot subtree thousands of times (which can freeze the browser).
                if (op.kind === 'references' && isInstanceablePrim(dstPrim)) {
                    const isExternalRef = typeof op.assetPath === 'string' && op.assetPath.length > 0 && !op.assetPath.startsWith('/');
                    if (isExternalRef) {
                        const protoKey = `${op.assetPath}|${op.targetPath ?? ''}|${op.fromIdentifier}`;
                        let protoPath = prototypePathByKey.get(protoKey);
                        if (!protoPath) {
                            prototypeCounter++;
                            (layer as any).__usdjsPrototypeCounter = prototypeCounter;
                            protoPath = `/__usdjs_prototypes/p${prototypeCounter}`;
                            prototypePathByKey.set(protoKey, protoPath);

                            const { identifier: childId, text } = await resolver.readText(op.assetPath, op.fromIdentifier);
                            let childLayer = layerCache?.get(childId);
                            if (!childLayer) {
                                childLayer = parseTextToLayer(text, childId);
                                layerCache?.set(childId, childLayer);
                            }
                            await walk(childLayer, baseId);

                            const srcPrim = pickSourcePrim(childLayer, op.targetPath);
                            if (srcPrim) {
                                const protoPrim = clonePrimWithRemappedPaths(srcPrim, protoPath, srcPrim.path.primPath);
                                attachPrimAtPath(curLayer, protoPrim);
                            }
                        }

                        // Point this prim at the prototype via internal sdfpath reference so the viewer can render it.
                        dstPrim.metadata ??= {};
                        (dstPrim.metadata as any).references = { type: 'sdfpath', value: protoPath };
                        // Keep instanceable flag as-is. Do NOT graft anything into this prim.
                        continue;
                    }
                }

                const resolvedGuess = resolveAssetPath(op.assetPath, op.fromIdentifier);
                let childLayer = layerCache?.get(resolvedGuess);
                if (!childLayer) {
                    const { identifier: childId, text } = await resolver.readText(op.assetPath, op.fromIdentifier);
                    childLayer = layerCache?.get(childId);
                    if (!childLayer) {
                        childLayer = parseTextToLayer(text, childId);
                        layerCache?.set(childId, childLayer);
                    }
                    if (!layerCache?.has(resolvedGuess)) layerCache?.set(resolvedGuess, childLayer);
                }

                // Handle sublayers in the child layer (e.g., payload file that references geom/look sublayers)
                const childSubLayers = extractSubLayerAssetPaths(childLayer.metadata?.subLayers);
                if (childSubLayers.length > 0) {
                    const subLayerStack: SdfLayer[] = [];
                    const childIdentifier = childLayer.identifier;
                    for (const subPath of childSubLayers) {
                        const resolvedGuess2 = resolveAssetPath(subPath, childIdentifier);
                        let subLayer = layerCache?.get(resolvedGuess2);
                        if (!subLayer) {
                            const { identifier: subId, text: subText } = await resolver.readText(subPath, childIdentifier);
                            subLayer = layerCache?.get(subId);
                            if (!subLayer) {
                                subLayer = parseTextToLayer(subText, subId);
                                layerCache?.set(subId, subLayer);
                            }
                            if (!layerCache?.has(resolvedGuess2)) layerCache?.set(resolvedGuess2, subLayer);
                        }
                        // Recursively expand arcs in each sublayer
                        await walk(subLayer, baseId);
                        subLayerStack.push(subLayer);
                    }
                    // Compose sublayers (weak to strong) then childLayer on top (strongest)
                    // Preserve the child's identifier so relative subLayer refs keep resolving correctly.
                    childLayer = composeLayerStack([...subLayerStack, childLayer], childLayer.identifier);
                }

                // Recursively expand arcs in the child layer before grafting it in.
                await walk(childLayer, baseId);

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
                // Compose arcs among themselves (weak->strong). We'll merge into dstPrim after all ops.
                mergePrimSpec(ensureArcAccum(), grafted);
            }

            // Apply accumulated arc opinions (weak) so authored opinions on dstPrim remain strongest.
            if (arcAccum) mergePrimSpecWeakIntoStrong(dstPrim, arcAccum);
        }

        // Apply inherits after arc expansion so classes that reference/payload external layers contribute real opinions.
        applyInherits(curLayer);

        // Apply variant selections AGAIN after arc expansion to handle variants from loaded layers.
        applyVariantSelections(curLayer);
        // Variants inside referenced/payloaded layers can introduce additional internal references.
        // Apply internal refs again so those subtrees become visible in the composed result.
        applyInternalReferences(curLayer);
        applyVariantSelections(curLayer);

        inProgress.delete(curLayer.identifier);
    };

    await walk(layer, baseIdentifierForSubLayers);
    expandedLayerIds?.add(layer.identifier);
}

/**
 * Apply internal references (like </Some/Prim>) within a layer.
 * This finds prims that reference other prims in the same layer and merges them.
 */
function applyInternalReferences(layer: SdfLayer): void {
    const prims = listPrimSpecs(layer.root);
    // Track a coarse "strength" marker for Pcp-lite ordering decisions.
    // - Prim specs authored locally in this layer default to strength=2
    // - Prim specs introduced via internal references default to strength=1
    //
    // Important: `applyInternalReferences` may run multiple times. Do not overwrite existing markers.
    for (const p of prims) {
        const anyP = p as any;
        if (typeof anyP.__usdjsStrength !== 'number') anyP.__usdjsStrength = 2;
    }

    const markStrengthRecursive = (p: any, strength: number): void => {
        const anyP = p as any;
        if (typeof anyP.__usdjsStrength !== 'number') anyP.__usdjsStrength = strength;
        if (!p.children) return;
        for (const c of p.children.values()) markStrengthRecursive(c, strength);
    };

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
            // Anything coming from an internal reference is considered weaker than locally-authored prim specs.
            markStrengthRecursive(grafted as any, 1);
            // Internal references should not overwrite opinions authored on the referencing prim.
            mergePrimSpecWeakIntoStrong(prim, grafted);
        }
    }
}

/**
 * Apply inherits (class-based authoring) within a layer.
 *
 * Example (common in usd-wg-assets teapot):
 *   over "SomePrim" ( prepend inherits = </SomeClass> ) { }
 *
 * In USD, inherits brings in opinions from the class prim. We treat inherited opinions as WEAK
 * relative to opinions authored on the inheriting prim.
 */
function applyInherits(layer: SdfLayer): void {
    const prims = listPrimSpecs(layer.root);
    for (const prim of prims) {
        if (!prim.metadata) continue;
        const inheritPaths = extractInternalRefPaths((prim.metadata as any).inherits);
        if (inheritPaths.length === 0) continue;
        // With USD's prepend semantics, the FIRST item in the list has HIGHEST priority.
        // Apply weaker inherits first, then stronger ones on top, so iterate in REVERSE order.
        const inheritsInComposeOrder = [...inheritPaths].reverse();
        for (const inheritPath of inheritsInComposeOrder) {
            const srcPrim = layer.getPrim(SdfPath.parse(inheritPath));
            if (!srcPrim) continue;
            // Clone with path remapping: class opinions should apply as-if authored on the inheriting prim.
            const grafted = clonePrimWithRemappedPaths(srcPrim, prim.path.primPath, srcPrim.path.primPath);
            // Pcp-lite nuance:
            // In practice (see usd-wg-assets `inherit_and_specialize.usda`), an inherited class opinion can be
            // *stronger* than the inheriting prim's opinions when the class prim is overridden at a stronger site
            // (e.g. local override inside a referencing prim) while the inheriting prim comes from a weaker site
            // (e.g. introduced via internal reference).
            //
            // We approximate this by comparing coarse per-prim strength markers.
            const dstStrength = typeof (prim as any).__usdjsStrength === 'number' ? (prim as any).__usdjsStrength : 2;
            const srcStrength = typeof (srcPrim as any).__usdjsStrength === 'number' ? (srcPrim as any).__usdjsStrength : 2;
            if (srcStrength > dstStrength) {
                // Treat inherited opinions as stronger in this case.
                mergePrimSpec(prim, grafted);
            } else {
                // Default: inherited opinions are weaker than the inheriting prim's authored opinions.
                mergePrimSpecWeakIntoStrong(prim, grafted);
            }
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
                        : selection && typeof selection === 'object' && (selection.type === 'token' || selection.type === 'string')
                            ? (selection as any).value
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

