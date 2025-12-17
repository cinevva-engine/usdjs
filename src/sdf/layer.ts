import { SdfPath } from './path.js';

export type SdfValue =
    | null
    | boolean
    | number
    | string
    | { type: 'token'; value: string }
    | { type: 'asset'; value: string }
    | { type: 'sdfpath'; value: string }
    | { type: 'reference'; assetPath: string; targetPath: string }
    | { type: 'vec2f' | 'vec3f' | 'vec4f'; value: number[] }
    | { type: 'matrix4d'; value: number[] }
    | { type: 'tuple'; value: SdfValue[] }
    | { type: 'array'; elementType: string; value: SdfValue[] }
    | { type: 'dict'; value: Record<string, SdfValue> };

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
 * Minimal in-memory layer model.
 * Eventually we will need a richer "spec" model closer to Pixar Sdf.
 */
export class SdfLayer {
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


