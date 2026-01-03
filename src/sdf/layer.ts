import { SdfPath } from './path.js';

export type SdfValue =
    | null
    | boolean
    | number
    | string
    | { type: 'token'; value: string }
    // Allow extra fields so we can attach origin info during parsing (e.g. `__fromIdentifier`)
    | { type: 'asset'; value: string;[k: string]: any }
    | { type: 'sdfpath'; value: string }
    /**
     * Reference/payload arc value.
     *
     * - `@file.usd@` (no targetPath)
     * - `@file.usd@</Prim>` (targetPath)
     * - optional arg list: `@file.usd@ (offset = 2, scale = 1)` (represented as extra fields)
     */
    | { type: 'reference'; assetPath: string; targetPath?: string;[k: string]: any }
    | { type: 'vec2f' | 'vec3f' | 'vec4f'; value: number[] }
    | { type: 'matrix4d'; value: number[] }
    | { type: 'tuple'; value: SdfValue[] }
    | { type: 'array'; elementType: string; value: SdfValue[] }
    /**
     * Packed numeric arrays (memory/perf optimization).
     *
     * Used by the USDA parser for large numeric arrays like:
     * - `int[]`, `float[]`, `double[]`
     * - `point3f[]`, `normal3f[]`, `texCoord2f[]`, etc (packed as flat arrays)
     */
    | { type: 'typedArray'; elementType: string; value: Float32Array | Float64Array | Int32Array | Uint32Array }
    | { type: 'dict'; value: Record<string, SdfValue> }
    /**
     * Raw/opaque value for round-trip preservation.
     * 
     * Used when we encounter USD constructs we don't fully understand but want to
     * preserve for serialization. The raw string is written verbatim to USDA output.
     */
    | { type: 'raw'; value: string };

export type SdfPrimSpecifier = 'def' | 'over' | 'class';

export interface SdfVariantSetSpec {
    name: string;
    variants: Map<string, SdfPrimSpec>;
}

export interface SdfPropertySpec {
    path: SdfPath; // must be property path
    typeName: string; // e.g. "float3", "token", "string"
    variability?: 'uniform' | 'varying' | 'config';
    defaultValue?: SdfValue;
    timeSamples?: Map<number, SdfValue>;
    metadata?: Record<string, SdfValue>;
}

export interface SdfPrimSpec {
    path: SdfPath; // must be prim path
    specifier: SdfPrimSpecifier;
    typeName?: string; // e.g. "Xform", "Mesh"
    metadata?: Record<string, SdfValue>;
    properties?: Map<string, SdfPropertySpec>;
    children?: Map<string, SdfPrimSpec>;
    variantSets?: Map<string, SdfVariantSetSpec>;
}

/**
 * Minimal layer surface used by the viewer/runtime.
 *
 * We expose this as an interface so we can return structural-sharing layer views
 * without materializing/cloning full prim graphs.
 */
export interface SdfLayerLike {
    identifier: string;
    metadata: Record<string, SdfValue>;
    root: SdfPrimSpec;
    getPrim(path: SdfPath): SdfPrimSpec | null;
}

/**
 * Minimal in-memory layer model.
 * Eventually we will need a richer "spec" model closer to Pixar Sdf.
 */
export class SdfLayer implements SdfLayerLike {
    /** Layer-level metadata (e.g. defaultPrim, upAxis). */
    readonly metadata: Record<string, SdfValue> = {};
    readonly root: SdfPrimSpec;

    constructor(public readonly identifier: string) {
        this.root = {
            path: SdfPath.absoluteRoot,
            specifier: 'def',
            typeName: 'Scope',
            children: new Map(),
            properties: new Map(),
            metadata: {},
        };
    }

    getPrim(path: SdfPath): SdfPrimSpec | null {
        if (path.kind !== 'prim') throw new Error(`getPrim expects prim path, got ${path.toString()}`);
        if (path.primPath === '/') return this.root;
        const parts = path.primPath.split('/').filter(Boolean);
        let cur: SdfPrimSpec = this.root;
        for (const name of parts) {
            const next = cur.children?.get(name) ?? null;
            if (!next) return null;
            cur = next;
        }
        return cur;
    }

    ensurePrim(path: SdfPath, specifier: SdfPrimSpecifier = 'def'): SdfPrimSpec {
        if (path.kind !== 'prim') throw new Error(`ensurePrim expects prim path, got ${path.toString()}`);
        if (path.primPath === '/') return this.root;
        const parts = path.primPath.split('/').filter(Boolean);
        let cur: SdfPrimSpec = this.root;
        for (const name of parts) {
            if (!cur.children) cur.children = new Map();
            let next = cur.children.get(name);
            if (!next) {
                next = {
                    path: SdfPath.parse((cur.path.primPath === '/' ? '' : cur.path.primPath) + '/' + name),
                    specifier,
                    children: new Map(),
                    properties: new Map(),
                    metadata: {},
                };
                cur.children.set(name, next);
            }
            cur = next;
        }
        return cur;
    }
}


