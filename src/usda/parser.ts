import { SdfLayer, type SdfPrimSpecifier, type SdfValue, type SdfPropertySpec, type SdfPrimSpec, type SdfVariantSetSpec } from '../sdf/layer.js';
import { SdfPath } from '../sdf/path.js';
import { UsdaLexer, type UsdaToken } from './lexer.js';

function tupleArityForElementType(elementType: string): { n: 2 | 3 | 4; kind: 'f32' | 'f64' } | null {
    // Conservative whitelist for now (covers the biggest heap offenders).
    // USD commonly uses these in geometry:
    // - point3f[], normal3f[], vector3f[], color3f[], texCoord2f[]
    // Also allow generic suffix patterns like *2f/*3f/*4f and *2d/*3d/*4d.
    // matrix4* is 4x4 (16 numbers), not a 4-tuple; handled separately.
    if (elementType === 'matrix4d' || elementType === 'matrix4f' || elementType === 'matrix4h') return null;

    // Quaternions (USD stores as (real, i, j, k) == (w, x, y, z)).
    if (elementType === 'quatd') return { n: 4, kind: 'f64' };
    if (elementType === 'quatf' || elementType === 'quath') return { n: 4, kind: 'f32' };

    const m = /([234])([fd])$/.exec(elementType);
    if (m) {
        const n = Number(m[1]) as 2 | 3 | 4;
        const kind = m[2] === 'd' ? 'f64' : 'f32';
        return { n, kind };
    }
    if (elementType === 'texCoord2f') return { n: 2, kind: 'f32' };
    if (elementType === 'texCoord2d') return { n: 2, kind: 'f64' };
    return null;
}

type PackedNumericArray = Float32Array | Float64Array | Int32Array | Uint32Array;

function grow<T extends PackedNumericArray>(arr: T): T {
    const next = new (arr.constructor as any)(Math.max(16, arr.length * 2)) as T;
    next.set(arr);
    return next;
}

export interface UsdaParseOptions {
    identifier?: string;
}

/**
 * USDA parser (foundation subset).
 *
 * Currently supports:
 * - `def|over|class <TypeName> "<PrimName>" { ... }`
 * - nested prims
 * - property assignments: `<typeName> <propName> = <value>`
 * - scalar values: string, number, identifier-as-token (token-ish), @asset@
 * - timeSamples: `<type> <propName>.timeSamples = { 0: <value>, 100: <value> }`
 *
 * TODO (next):
 * - metadata blocks `( ... )` at layer/prim/property
 * - arrays, tuples, dictionaries
 * - property metadata `( interpolation = "vertex" )`
 */
export function parseUsdaToLayer(src: string, opts: UsdaParseOptions = {}): SdfLayer {
    const layer = new SdfLayer(opts.identifier ?? '<memory>');
    const lexer = new UsdaLexer(src, { emitNewlines: false, emitNumberStrings: false });
    const p = new Parser(lexer, layer);
    p.parseLayer();
    return layer;
}

class Parser {
    private tok: UsdaToken;

    constructor(
        private readonly lexer: UsdaLexer,
        private readonly layer: SdfLayer
    ) {
        this.tok = this.lexer.next();
    }

    parseLayer(): void {
        // Skip optional header like `#usda 1.0` which the lexer treats as comment.
        // Parse optional top-level metadata block `( ... )` into layer.metadata.
        // Safety: limit iterations to prevent infinite loops from malformed input
        let metadataBlockCount = 0;
        while (this.isPunct('(') && metadataBlockCount < 100) {
            const offsetBefore = this.tok.offset;
            this.parseMetadataBlockInto(this.layer.metadata);
            // Safety check: ensure token advanced (if it didn't, we'd loop forever)
            if (this.tok.offset === offsetBefore && this.isPunct('(')) {
                this.next(); // Force advance to prevent infinite loop
                break;
            }
            metadataBlockCount++;
        }

        // Parse prims until EOF
        while (!this.isKind('eof')) {
            if (this.isKind('identifier') && (this.tok.value === 'def' || this.tok.value === 'over' || this.tok.value === 'class')) {
                this.parsePrim(SdfPath.absoluteRoot);
                continue;
            }
            // Unknown token at top-level: advance to avoid infinite loops.
            this.next();
        }
    }

    private parsePrim(parent: SdfPath): void {
        const specifier = this.expectIdentifierOneOf(['def', 'over', 'class']) as SdfPrimSpecifier;
        // USD allows omitting the explicit typeName in some cases (commonly `over "PrimName"`).
        // If the next token is a string, treat it as the prim name and leave typeName undefined.
        let typeName: string | undefined;
        let primName: string;
        if (this.isKind('identifier')) {
            typeName = this.expectIdentifier('Expected typeName after prim specifier');
            primName = this.expectString('Expected prim name string');
        } else {
            primName = this.expectString('Expected prim name string');
        }

        const primPath = SdfPath.child(parent, primName);
        const prim = this.layer.ensurePrim(primPath, specifier);
        if (typeName) prim.typeName = typeName;

        // Optional metadata block: `(...)` (skip for now)
        if (this.isPunct('(')) this.parseMetadataBlockInto(prim.metadata ?? (prim.metadata = {}));

        this.expectPunct('{', 'Expected "{" to open prim body');

        while (!this.isPunct('}') && !this.isKind('eof')) {
            // Nested prim
            if (this.isKind('identifier') && (this.tok.value === 'def' || this.tok.value === 'over' || this.tok.value === 'class')) {
                this.parsePrim(primPath);
                continue;
            }

            // Variant sets: variantSet "name" = { "variant" { ... } ... }
            if (this.isKind('identifier') && this.tok.value === 'variantSet') {
                this.parseVariantSetInto(prim, primPath);
                continue;
            }

            // Property assignment: <type> <name> = <value>
            if (this.isKind('identifier')) {
                // Optional variability or "custom" qualifier.
                // We keep these as metadata for now; they will become first-class later.
                let qualifier: string | null = null;
                if (this.tok.value === 'uniform' || this.tok.value === 'varying' || this.tok.value === 'custom') {
                    qualifier = this.tok.value;
                    this.next();
                    if (!this.isKind('identifier')) {
                        // malformed; fall back to skipping
                        continue;
                    }
                }

                const { typeName: typeTok, baseType, isArrayType } = this.readTypeName();

                if (this.isKind('identifier')) {
                    const propName = this.tok.value;
                    this.next();

                    // Optional field: `outputs:surface.connect = ...` or `xformOp:translate.timeSamples = ...`
                    let fieldName: string | null = null;
                    if (this.isPunct('.')) {
                        this.next();
                        if (this.isKind('identifier')) {
                            fieldName = this.tok.value;
                            this.next();
                        }
                    }

                    // Optional property metadata `( ... )` can appear after value in USD, but we'll handle later.
                    if (this.isPunct('=')) {
                        this.next();

                        // Special handling for .timeSamples field - parse into timeSamples map
                        if (fieldName === 'timeSamples') {
                            const timeSamples = this.parseTimeSamples({ baseType, isArrayType });
                            const propPath = SdfPath.property(primPath.primPath, propName);
                            // Check if property already exists (e.g. has a defaultValue)
                            let spec = prim.properties?.get(propName);
                            if (spec) {
                                spec.timeSamples = timeSamples;
                            } else {
                                spec = {
                                    path: propPath,
                                    typeName: typeTok,
                                    timeSamples,
                                    metadata: {},
                                };
                                if (qualifier) spec.metadata = { ...(spec.metadata ?? {}), qualifier: { type: 'token', value: qualifier } };
                                if (!prim.properties) prim.properties = new Map();
                                prim.properties.set(propName, spec);
                            }
                            // Skip optional trailing metadata block
                            if (this.isPunct('(')) this.parseMetadataBlockInto(spec.metadata ?? (spec.metadata = {}));
                            continue;
                        }

                        const value = this.parseValue({ baseType, isArrayType });
                        const propKey = fieldName ? `${propName}.${fieldName}` : propName;
                        const propPath = SdfPath.property(primPath.primPath, propName, fieldName);
                        const spec: SdfPropertySpec = {
                            path: propPath,
                            typeName: typeTok,
                            defaultValue: value,
                            metadata: {},
                        };
                        if (qualifier) spec.metadata = { ...(spec.metadata ?? {}), qualifier: { type: 'token', value: qualifier } };
                        if (!prim.properties) prim.properties = new Map();
                        prim.properties.set(propKey, spec);

                        // Skip optional trailing metadata block: `( interpolation = "vertex" )` etc.
                        if (this.isPunct('(')) this.parseMetadataBlockInto(spec.metadata ?? (spec.metadata = {}));
                        continue;
                    }

                    // Declaration without authored value (e.g. `token outputs:out` or `float inputs:shaping:cone:softness`)
                    // Still create the property spec, but without a defaultValue
                    const propKey = fieldName ? `${propName}.${fieldName}` : propName;
                    const propPath = SdfPath.property(primPath.primPath, propName, fieldName);
                    const spec: SdfPropertySpec = {
                        path: propPath,
                        typeName: typeTok,
                        // defaultValue is undefined for declarations without values
                        metadata: {},
                    };
                    if (qualifier) spec.metadata = { ...(spec.metadata ?? {}), qualifier: { type: 'token', value: qualifier } };
                    if (!prim.properties) prim.properties = new Map();
                    prim.properties.set(propKey, spec);

                    // Property metadata can still appear: `float prop (customData = {...})`
                    if (this.isPunct('(')) this.parseMetadataBlockInto(spec.metadata ?? (spec.metadata = {}));
                    continue;
                }
            }

            // Fallback: skip token
            this.next();
        }

        this.expectPunct('}', 'Expected "}" to close prim body');
    }

    private parseValue(ctx?: { baseType: string; isArrayType: boolean }): SdfValue {
        // Arrays: [a, b, c] or [(0,0,0), (1,1,1)]
        if (this.isPunct('[')) {
            const arr = this.parseArray(ctx?.baseType ?? 'unknown');
            return arr;
        }

        // Special-case: pack matrix4* and quat* scalar values into typed arrays.
        // This is common in xforms (`xformOp:transform`) and animation (`orient`, rotations).
        if (this.isPunct('(') && ctx && !ctx.isArrayType) {
            const bt = ctx.baseType;
            if (bt === 'matrix4d' || bt === 'matrix4f' || bt === 'matrix4h') {
                const m = this.parsePackedMatrix4Scalar(bt);
                if (m) return m;
            }
            if (bt === 'quatd' || bt === 'quatf' || bt === 'quath') {
                const q = this.parsePackedQuatScalar(bt);
                if (q) return q;
            }
        }

        // Tuples: (a, b, c)
        if (this.isPunct('(')) {
            return this.parseTuple();
        }

        // Dictionaries: { ... }
        if (this.isPunct('{')) {
            return this.parseDict();
        }

        if (this.isKind('string')) {
            const v = this.tok.value;
            this.next();
            return v;
        }

        if (this.isKind('number')) {
            const tok = this.tok;
            this.next();
            const n = tok.numberValue;
            if (typeof n === 'number' && Number.isFinite(n)) return n;
            // Fallback: allocate only if needed.
            if (typeof tok.spanStart === 'number' && typeof tok.spanEnd === 'number') {
                const s = this.lexer.slice(tok.spanStart, tok.spanEnd);
                const nn = Number(s);
                return Number.isFinite(nn) ? nn : s;
            }
            const s = tok.value;
            const nn = Number(s);
            return Number.isFinite(nn) ? nn : s;
        }

        if (this.isKind('path')) {
            const assetPath = this.tok.value;
            this.next();
            // Check for optional target prim path: @file@</Target/Path>
            // Note: references/payloads can also have an arg list after them, e.g.
            // `@file.usd@</Prim> (offset = 2, scale = 1)` (SdfLayerOffset).
            if (this.isKind('sdfpath')) {
                const targetPath = this.tok.value;
                this.next();
                const args = this.isPunct('(') ? this.parseParenArgList() : null;
                const base: any = { type: 'reference', assetPath, targetPath, __fromIdentifier: this.layer.identifier };
                return args ? { ...base, ...args } : base;
            }
            const args = this.isPunct('(') ? this.parseParenArgList() : null;
            // If an arg list follows an asset path, treat it as a (non-targeted) reference-style object.
            // This is important inside metadata blocks where listOps like `prepend references = @file@ (offset=...)`
            // are common in real-world USD (and in the usd-wg-assets corpus).
            if (args) return { type: 'reference', assetPath, __fromIdentifier: this.layer.identifier, ...args } as any;
            return { type: 'asset', value: assetPath, __fromIdentifier: this.layer.identifier } as any;
        }

        if (this.isKind('sdfpath')) {
            const v = this.tok.value;
            this.next();
            return { type: 'sdfpath', value: v };
        }

        if (this.isKind('identifier')) {
            // Treat as token-ish. Also recognize booleans.
            const v = this.tok.value;
            this.next();
            if (v === 'true') return true;
            if (v === 'false') return false;
            return { type: 'token', value: v };
        }

        // Unknown: return null and advance
        this.next();
        return null;
    }

    private parseArray(elementType: string): SdfValue {
        this.expectPunct('[', 'Expected "["');
        // Fast path: parse numeric arrays directly into packed typed arrays (avoid allocating tuple objects).
        const packed = this.parsePackedNumericArrayMaybe(elementType);
        if (packed) {
            this.expectPunct(']', 'Expected "]"');
            return packed;
        }

        // Generic fallback (keeps original structure).
        const values: SdfValue[] = [];
        while (!this.isKind('eof') && !this.isPunct(']')) {
            if (this.isPunct(',')) {
                this.next();
                continue;
            }
            values.push(this.parseValue());
            if (this.isPunct(',')) this.next();
        }
        this.expectPunct(']', 'Expected "]"');
        return { type: 'array', elementType, value: values };
    }

    private parsePackedQuatScalar(elementType: 'quatd' | 'quatf' | 'quath'): SdfValue | null {
        // quat* is authored as (w, x, y, z) (USD stores real first).
        const kind: 'f64' | 'f32' = elementType === 'quatd' ? 'f64' : 'f32';
        const out = kind === 'f64' ? new Float64Array(4) : new Float32Array(4);
        if (!this.isPunct('(')) return null;
        this.next(); // '('
        for (let k = 0; k < 4; k++) {
            if (this.isPunct(',')) this.next();
            const n = this.readNumberTokenFast();
            if (n === null) return null;
            out[k] = n;
            if (this.isPunct(',')) this.next();
        }
        this.expectPunct(')', 'Expected ")" to close quat');
        return { type: 'typedArray', elementType, value: out };
    }

    private parsePackedMatrix4Scalar(elementType: 'matrix4d' | 'matrix4f' | 'matrix4h'): SdfValue | null {
        const kind: 'f64' | 'f32' = elementType === 'matrix4d' ? 'f64' : 'f32';
        const out = kind === 'f64' ? new Float64Array(16) : new Float32Array(16);
        if (!this.isPunct('(')) return null;
        this.next(); // '(' (outer)

        // Two common encodings:
        // 1) Nested rows: ( (r0...), (r1...), (r2...), (r3...) )
        // 2) Flat 16-tuple: (r0c0, r0c1, ... r3c3)
        if (this.isPunct('(')) {
            let w = 0;
            for (let row = 0; row < 4; row++) {
                this.expectPunct('(', 'Expected "(" to open matrix row');
                for (let k = 0; k < 4; k++) {
                    if (this.isPunct(',')) this.next();
                    const n = this.readNumberTokenFast();
                    if (n === null) return null;
                    out[w++] = n;
                    if (this.isPunct(',')) this.next();
                }
                this.expectPunct(')', 'Expected ")" to close matrix row');
                if (this.isPunct(',')) this.next();
            }
            this.expectPunct(')', 'Expected ")" to close matrix');
            return { type: 'typedArray', elementType, value: out };
        }

        for (let k = 0; k < 16; k++) {
            if (this.isPunct(',')) this.next();
            const n = this.readNumberTokenFast();
            if (n === null) return null;
            out[k] = n;
            if (this.isPunct(',')) this.next();
        }
        this.expectPunct(')', 'Expected ")" to close matrix');
        return { type: 'typedArray', elementType, value: out };
    }

    private parsePackedNumericArrayMaybe(elementType: string): SdfValue | null {
        // matrix4*[]: pack as flat 16*N typed array (row-major as-authored).
        if (elementType === 'matrix4d' || elementType === 'matrix4f' || elementType === 'matrix4h') {
            const kind: 'f64' | 'f32' = elementType === 'matrix4d' ? 'f64' : 'f32';
            let out = kind === 'f64' ? (new Float64Array(256 * 16) as PackedNumericArray) : (new Float32Array(256 * 16) as PackedNumericArray);
            let len = 0;
            while (!this.isKind('eof') && !this.isPunct(']')) {
                if (this.isPunct(',')) { this.next(); continue; }
                if (!this.isPunct('(')) return null;
                this.next(); // '(' outer

                if (this.isPunct('(')) {
                    for (let row = 0; row < 4; row++) {
                        this.expectPunct('(', 'Expected "(" to open matrix row');
                        for (let k = 0; k < 4; k++) {
                            if (this.isPunct(',')) this.next();
                            const num = this.readNumberTokenFast();
                            if (num === null) return null;
                            if (len >= out.length) out = grow(out);
                            out[len++] = num;
                            if (this.isPunct(',')) this.next();
                        }
                        this.expectPunct(')', 'Expected ")" to close matrix row');
                        if (this.isPunct(',')) this.next();
                    }
                    this.expectPunct(')', 'Expected ")" to close matrix');
                } else {
                    for (let k = 0; k < 16; k++) {
                        if (this.isPunct(',')) this.next();
                        const num = this.readNumberTokenFast();
                        if (num === null) return null;
                        if (len >= out.length) out = grow(out);
                        out[len++] = num;
                        if (this.isPunct(',')) this.next();
                    }
                    this.expectPunct(')', 'Expected ")" to close matrix');
                }

                if (this.isPunct(',')) this.next();
            }
            return { type: 'typedArray', elementType, value: out.slice(0, len) as any };
        }

        // Scalar numeric arrays
        if (elementType === 'float' || elementType === 'half') {
            let out = new Float32Array(256);
            let len = 0;
            while (!this.isKind('eof') && !this.isPunct(']')) {
                if (this.isPunct(',')) { this.next(); continue; }
                const n = this.readNumberTokenFast();
                if (n === null) return null;
                if (len >= out.length) out = grow(out);
                out[len++] = n;
                if (this.isPunct(',')) this.next();
            }
            return { type: 'typedArray', elementType, value: out.slice(0, len) };
        }
        if (elementType === 'double') {
            let out = new Float64Array(256);
            let len = 0;
            while (!this.isKind('eof') && !this.isPunct(']')) {
                if (this.isPunct(',')) { this.next(); continue; }
                const n = this.readNumberTokenFast();
                if (n === null) return null;
                if (len >= out.length) out = grow(out);
                out[len++] = n;
                if (this.isPunct(',')) this.next();
            }
            return { type: 'typedArray', elementType, value: out.slice(0, len) };
        }
        if (elementType === 'int') {
            let out = new Int32Array(256);
            let len = 0;
            while (!this.isKind('eof') && !this.isPunct(']')) {
                if (this.isPunct(',')) { this.next(); continue; }
                const n = this.readNumberTokenFast();
                if (n === null) return null;
                if (len >= out.length) out = grow(out);
                out[len++] = n | 0;
                if (this.isPunct(',')) this.next();
            }
            return { type: 'typedArray', elementType, value: out.slice(0, len) };
        }
        if (elementType === 'uint') {
            let out = new Uint32Array(256);
            let len = 0;
            while (!this.isKind('eof') && !this.isPunct(']')) {
                if (this.isPunct(',')) { this.next(); continue; }
                const n = this.readNumberTokenFast();
                if (n === null) return null;
                if (len >= out.length) out = grow(out);
                out[len++] = (n >>> 0);
                if (this.isPunct(',')) this.next();
            }
            return { type: 'typedArray', elementType, value: out.slice(0, len) };
        }

        // Tuple arrays (2/3/4) of numeric values
        const tuple = tupleArityForElementType(elementType);
        if (!tuple) return null;

        const n = tuple.n;
        if (tuple.kind === 'f64') {
            let out = new Float64Array(256 * n);
            let len = 0; // number of numeric scalars written
            while (!this.isKind('eof') && !this.isPunct(']')) {
                if (this.isPunct(',')) { this.next(); continue; }
                if (!this.isPunct('(')) return null;
                this.next(); // consume '('
                for (let k = 0; k < n; k++) {
                    if (this.isPunct(',')) this.next();
                    const num = this.readNumberTokenFast();
                    if (num === null) return null;
                    if (len >= out.length) out = grow(out);
                    out[len++] = num;
                    if (this.isPunct(',')) this.next();
                }
                this.expectPunct(')', 'Expected ")" to close tuple');
                if (this.isPunct(',')) this.next();
            }
            return { type: 'typedArray', elementType, value: out.slice(0, len) };
        } else {
            let out = new Float32Array(256 * n);
            let len = 0;
            while (!this.isKind('eof') && !this.isPunct(']')) {
                if (this.isPunct(',')) { this.next(); continue; }
                if (!this.isPunct('(')) return null;
                this.next(); // consume '('
                for (let k = 0; k < n; k++) {
                    if (this.isPunct(',')) this.next();
                    const num = this.readNumberTokenFast();
                    if (num === null) return null;
                    if (len >= out.length) out = grow(out);
                    out[len++] = num;
                    if (this.isPunct(',')) this.next();
                }
                this.expectPunct(')', 'Expected ")" to close tuple');
                if (this.isPunct(',')) this.next();
            }
            return { type: 'typedArray', elementType, value: out.slice(0, len) };
        }
    }

    private readNumberTokenFast(): number | null {
        if (this.tok.kind !== 'number') return null;
        const tok = this.tok;
        const n = tok.numberValue;
        this.next();
        if (typeof n === 'number' && Number.isFinite(n)) return n;
        // Rare fallback: if numberValue is missing/NaN, fall back to parsing the token string.
        const s =
            typeof tok.spanStart === 'number' && typeof tok.spanEnd === 'number'
                ? this.lexer.slice(tok.spanStart, tok.spanEnd)
                : tok.value;
        const nn = Number(s);
        return Number.isFinite(nn) ? nn : null;
    }

    private parseTuple(): SdfValue {
        this.expectPunct('(', 'Expected "("');
        const values: SdfValue[] = [];
        while (!this.isKind('eof') && !this.isPunct(')')) {
            if (this.isPunct(',')) {
                this.next();
                continue;
            }
            values.push(this.parseValue());
            if (this.isPunct(',')) this.next();
        }
        this.expectPunct(')', 'Expected ")"');
        return { type: 'tuple', value: values };
    }

    private parseMetadataBlockInto(target: Record<string, SdfValue>): void {
        this.expectPunct('(', 'Expected "(" to open metadata block');
        while (!this.isKind('eof') && !this.isPunct(')')) {
            // Allow commas and stray tokens
            if (this.isPunct(',') || this.isPunct(';')) {
                this.next();
                continue;
            }
            if (this.tok.kind === 'identifier') {
                const first = this.tok.value;
                // listOp keywords: prepend/append/add/delete/reorder
                if (first === 'prepend' || first === 'append' || first === 'add' || first === 'delete' || first === 'reorder') {
                    this.next();
                    if (this.tok.kind === 'identifier') {
                        const key = this.tok.value;
                        this.next();
                        if (this.isPunct('=')) {
                            this.next();
                            const val = this.parseValue();
                            target[key] = { type: 'dict', value: { op: { type: 'token', value: first }, value: val } };
                            continue;
                        }
                    }
                } else {
                    const key = first;
                    this.next();
                    if (this.isPunct('=')) {
                        this.next();
                        const val = this.parseValue();
                        target[key] = val;
                        continue;
                    }
                }
            }
            // Skip unrecognized token to avoid infinite loops
            this.next();
        }
        this.expectPunct(')', 'Expected ")" to close metadata block');
    }

    /**
     * Parse a simple parenthesized argument list used in USD for reference/payload layer offsets:
     * `(..., offset = <number>, scale = <number>, ...)`
     *
     * This is NOT the same as a tuple value. It behaves like a mini metadata block attached to a value.
     */
    private parseParenArgList(): Record<string, SdfValue> {
        const out: Record<string, SdfValue> = {};
        this.expectPunct('(', 'Expected "(" to open arg list');
        while (!this.isKind('eof') && !this.isPunct(')')) {
            if (this.isPunct(',') || this.isPunct(';')) {
                this.next();
                continue;
            }
            if (this.tok.kind === 'identifier') {
                const key = this.tok.value;
                this.next();
                if (this.isPunct('=')) {
                    this.next();
                    out[key] = this.parseValue();
                    continue;
                }
                // Bare identifier: treat as token-ish true flag
                out[key] = { type: 'token', value: key };
                continue;
            }
            // Skip unrecognized token to avoid infinite loops
            this.next();
        }
        this.expectPunct(')', 'Expected ")" to close arg list');
        return out;
    }

    private parseVariantSetInto(targetPrim: SdfPrimSpec, primPath: SdfPath): void {
        this.expectIdentifierOneOf(['variantSet']); // consume keyword
        const setName = this.expectString('Expected variantSet name string');
        this.expectPunct('=', 'Expected "=" after variantSet name');
        this.expectPunct('{', 'Expected "{" after variantSet "="');

        const set: SdfVariantSetSpec = { name: setName, variants: new Map() };
        if (!targetPrim.variantSets) targetPrim.variantSets = new Map();
        targetPrim.variantSets.set(setName, set);

        while (!this.isKind('eof') && !this.isPunct('}')) {
            if (this.isPunct(',') || this.isPunct(';')) {
                this.next();
                continue;
            }

            if (this.tok.kind === 'string') {
                const variantName = this.tok.value;
                this.next();

                const variantPrim: SdfPrimSpec = {
                    path: primPath,
                    specifier: 'over',
                    metadata: {},
                    properties: new Map(),
                    children: new Map(),
                };

                // Optional metadata block before variant body: "variantName" ( ... ) { ... }
                if (this.isPunct('(')) {
                    this.parseMetadataBlockInto(variantPrim.metadata ?? (variantPrim.metadata = {}));
                }

                this.expectPunct('{', 'Expected "{" after variant name');

                while (!this.isKind('eof') && !this.isPunct('}')) {
                    // Nested variant sets are legal inside variant bodies (e.g. modelVariant contains shadingVariant).
                    // We must parse them so composition can later apply nested selections.
                    if (this.isKind('identifier') && this.tok.value === 'variantSet') {
                        this.parseVariantSetInto(variantPrim, primPath);
                        continue;
                    }
                    // allow nested prims and property assignments inside variant body
                    if (this.isKind('identifier') && (this.tok.value === 'def' || this.tok.value === 'over' || this.tok.value === 'class')) {
                        // Parse nested prim into the variant prim's children, not the global layer structure
                        this.parsePrimIntoParent(variantPrim, primPath);
                        continue;
                    }
                    if (this.isKind('identifier')) {
                        const { typeName: typeTok, baseType, isArrayType } = this.readTypeName();
                        if (this.isKind('identifier')) {
                            const propName = this.tok.value;
                            this.next();
                            if (this.isPunct('=')) {
                                this.next();
                                const value = this.parseValue({ baseType, isArrayType });
                                const propPath = SdfPath.property(primPath.primPath, propName);
                                const spec: SdfPropertySpec = { path: propPath, typeName: typeTok, defaultValue: value, metadata: {} };
                                variantPrim.properties?.set(propName, spec);
                                if (this.isPunct('(')) this.parseMetadataBlockInto(spec.metadata ?? (spec.metadata = {}));
                                continue;
                            }

                            // declaration without value inside variant
                            continue;
                        }
                    }
                    this.next();
                }

                this.expectPunct('}', 'Expected "}" to close variant body');
                set.variants.set(variantName, variantPrim);
                continue;
            }

            this.next();
        }

        this.expectPunct('}', 'Expected "}" to close variantSet block');
    }

    /**
     * Parse a prim definition and add it as a child to the given parent prim,
     * rather than to the global layer structure. This is used for variant children.
     */
    private parsePrimIntoParent(parentPrim: SdfPrimSpec, parentPath: SdfPath): void {
        const specifier = this.expectIdentifierOneOf(['def', 'over', 'class']) as SdfPrimSpecifier;
        let typeName: string | undefined;
        let primName: string;
        if (this.isKind('identifier')) {
            typeName = this.expectIdentifier('Expected typeName after prim specifier');
            primName = this.expectString('Expected prim name string');
        } else {
            primName = this.expectString('Expected prim name string');
        }

        const childPath = SdfPath.child(parentPath, primName);
        const prim: SdfPrimSpec = {
            path: childPath,
            specifier,
            typeName,
            metadata: {},
            properties: new Map(),
            children: new Map(),
        };

        // Add to parent's children map
        if (!parentPrim.children) parentPrim.children = new Map();
        parentPrim.children.set(primName, prim);

        // Optional metadata block
        if (this.isPunct('(')) this.parseMetadataBlockInto(prim.metadata ?? (prim.metadata = {}));

        this.expectPunct('{', 'Expected "{" to open prim body');

        while (!this.isPunct('}') && !this.isKind('eof')) {
            // Nested prim - recursively add to this prim's children
            if (this.isKind('identifier') && (this.tok.value === 'def' || this.tok.value === 'over' || this.tok.value === 'class')) {
                this.parsePrimIntoParent(prim, childPath);
                continue;
            }

            // Variant sets
            if (this.isKind('identifier') && this.tok.value === 'variantSet') {
                this.parseVariantSetInto(prim, childPath);
                continue;
            }

            // Property assignment
            if (this.isKind('identifier')) {
                let qualifier: string | null = null;
                if (this.tok.value === 'uniform' || this.tok.value === 'varying' || this.tok.value === 'custom') {
                    qualifier = this.tok.value;
                    this.next();
                    if (!this.isKind('identifier')) continue;
                }

                const { typeName: typeTok, baseType, isArrayType } = this.readTypeName();

                if (this.isKind('identifier')) {
                    const propName = this.tok.value;
                    this.next();

                    let fieldName: string | null = null;
                    if (this.isPunct('.')) {
                        this.next();
                        if (this.isKind('identifier')) {
                            fieldName = this.tok.value;
                            this.next();
                        }
                    }

                    if (this.isPunct('=')) {
                        this.next();

                        // Special handling for .timeSamples field
                        if (fieldName === 'timeSamples') {
                            const timeSamples = this.parseTimeSamples({ baseType, isArrayType });
                            const propPath = SdfPath.property(childPath.primPath, propName);
                            let spec = prim.properties?.get(propName);
                            if (spec) {
                                spec.timeSamples = timeSamples;
                            } else {
                                spec = {
                                    path: propPath,
                                    typeName: typeTok,
                                    timeSamples,
                                    metadata: {},
                                };
                                if (qualifier) spec.metadata = { ...(spec.metadata ?? {}), qualifier: { type: 'token', value: qualifier } };
                                if (!prim.properties) prim.properties = new Map();
                                prim.properties.set(propName, spec);
                            }
                            if (this.isPunct('(')) this.parseMetadataBlockInto(spec.metadata ?? (spec.metadata = {}));
                            continue;
                        }

                        const value = this.parseValue({ baseType, isArrayType });
                        const propKey = fieldName ? `${propName}.${fieldName}` : propName;
                        const propPath = SdfPath.property(childPath.primPath, propName, fieldName);
                        const spec: SdfPropertySpec = {
                            path: propPath,
                            typeName: typeTok,
                            defaultValue: value,
                            metadata: {},
                        };
                        if (qualifier) spec.metadata = { ...(spec.metadata ?? {}), qualifier: { type: 'token', value: qualifier } };
                        if (!prim.properties) prim.properties = new Map();
                        prim.properties.set(propKey, spec);
                        if (this.isPunct('(')) this.parseMetadataBlockInto(spec.metadata ?? (spec.metadata = {}));
                        continue;
                    }

                    // Declaration without value
                    const propKey = fieldName ? `${propName}.${fieldName}` : propName;
                    const propPath = SdfPath.property(childPath.primPath, propName, fieldName);
                    const spec: SdfPropertySpec = {
                        path: propPath,
                        typeName: typeTok,
                        metadata: {},
                    };
                    if (qualifier) spec.metadata = { ...(spec.metadata ?? {}), qualifier: { type: 'token', value: qualifier } };
                    if (!prim.properties) prim.properties = new Map();
                    prim.properties.set(propKey, spec);
                    if (this.isPunct('(')) this.parseMetadataBlockInto(spec.metadata ?? (spec.metadata = {}));
                    continue;
                }
            }

            this.next();
        }

        this.expectPunct('}', 'Expected "}" to close prim body');
    }

    private parseDict(): SdfValue {
        this.expectPunct('{', 'Expected "{" to open dict');
        const value: Record<string, SdfValue> = {};

        while (!this.isKind('eof') && !this.isPunct('}')) {
            if (this.isPunct(',') || this.isPunct(';')) {
                this.next();
                continue;
            }

            // Dict entries in USDA often look like: `string size = "small"`
            // We parse: [optional typeName] key = value
            if (this.tok.kind === 'identifier') {
                const first = this.tok.value;
                this.next();

                // If next is identifier, then `first` was a type name and next is key.
                let key = first;
                if (this.tok.kind === 'identifier') {
                    key = this.tok.value;
                    this.next();
                }

                if (this.isPunct('=')) {
                    this.next();
                    value[key] = this.parseValue();
                    continue;
                }
            }

            // Fallback: skip
            this.next();
        }

        this.expectPunct('}', 'Expected "}" to close dict');
        return { type: 'dict', value };
    }

    /**
     * Parse timeSamples block: `{ 0: (0,0,0), 100: (100,0,0) }`
     * Returns a Map<number, SdfValue> mapping time codes to values.
     */
    private parseTimeSamples(ctx?: { baseType: string; isArrayType: boolean }): Map<number, SdfValue> {
        this.expectPunct('{', 'Expected "{" to open timeSamples block');
        const samples = new Map<number, SdfValue>();

        while (!this.isKind('eof') && !this.isPunct('}')) {
            if (this.isPunct(',') || this.isPunct(';')) {
                this.next();
                continue;
            }

            // Parse time code (number)
            if (this.isKind('number')) {
                const tok = this.tok;
                const time =
                    typeof tok.numberValue === 'number' && Number.isFinite(tok.numberValue)
                        ? tok.numberValue
                        : typeof tok.spanStart === 'number' && typeof tok.spanEnd === 'number'
                            ? Number(this.lexer.slice(tok.spanStart, tok.spanEnd))
                            : Number(tok.value);
                this.next();

                // Expect colon
                if (this.isPunct(':')) {
                    this.next();
                    const value = this.parseValue(ctx);
                    samples.set(time, value);
                    // Optional trailing comma
                    if (this.isPunct(',')) this.next();
                    continue;
                }
            }

            // Fallback: skip unrecognized tokens
            this.next();
        }

        this.expectPunct('}', 'Expected "}" to close timeSamples block');
        return samples;
    }

    private readTypeName(): { typeName: string; baseType: string; isArrayType: boolean } {
        const base = this.expectIdentifier('Expected type name');
        let typeName = base;
        let isArrayType = false;
        // Support bracket suffixes: `type[]`
        if (this.isPunct('[')) {
            this.next();
            this.expectPunct(']', 'Expected "]" after "[" in type name');
            typeName = `${base}[]`;
            isArrayType = true;
        }
        return { typeName, baseType: base, isArrayType };
    }

    private next(): void {
        this.tok = this.lexer.next();
    }

    private isKind(kind: UsdaToken['kind']): boolean {
        return this.tok.kind === kind;
    }

    private isPunct(p: string): boolean {
        return this.tok.kind === 'punct' && this.tok.value === p;
    }

    private expectPunct(p: string, msg: string): void {
        if (!this.isPunct(p)) throw new Error(`${msg} at ${this.tok.line}:${this.tok.col} (got ${this.tok.kind} ${JSON.stringify(this.tok.value)})`);
        this.next();
    }

    private expectIdentifier(msg: string): string {
        if (this.tok.kind !== 'identifier') throw new Error(`${msg} at ${this.tok.line}:${this.tok.col}`);
        const v = this.tok.value;
        this.next();
        return v;
    }

    private expectString(msg: string): string {
        if (this.tok.kind !== 'string') throw new Error(`${msg} at ${this.tok.line}:${this.tok.col}`);
        const v = this.tok.value;
        this.next();
        return v;
    }

    private expectIdentifierOneOf(values: string[]): string {
        if (this.tok.kind !== 'identifier' || !values.includes(this.tok.value)) {
            throw new Error(`Expected one of ${values.join(', ')} at ${this.tok.line}:${this.tok.col}`);
        }
        const v = this.tok.value;
        this.next();
        return v;
    }
}


