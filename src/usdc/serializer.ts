/**
 * USDC Serializer (minimal crate writer).
 *
 * Goal: produce a `.usdc` byte stream that our `parseUsdcToLayer()` can read back.
 *
 * Notes:
 * - This is a *minimal* authoring implementation: we write structural sections uncompressed
 *   (TOKENS/STRINGS/FIELDS/FIELDSETS/PATHS/SPECS) and store value payloads in a DATA region.
 * - The parser supports this uncompressed form (see PATHS/SPECS fallbacks).
 * - We intentionally focus on the value types needed for engine/editor authoring:
 *   - layer metadata (defaultPrim, upAxis, metersPerUnit, customLayerData dict)
 *   - prim specifier/typeName + metadata passthrough
 *   - attribute defaults (bool/int/float/double/string/token/asset, vec2/3/4f, matrix4d)
 *   - numeric arrays (int/uint/float/double, vec2/3/4f arrays via typedArray)
 *   - timeSamples (Map<number, SdfValue>)
 *   - relationship/connection targets as explicit PathListOp when encoded as `array<sdfpath>`
 */

import { SdfPath } from '../sdf/path.js';
import { SdfLayer, type SdfPrimSpec, type SdfPropertySpec, type SdfValue } from '../sdf/layer.js';

export interface UsdcSerializeOptions {
    /** Crate version to write (defaults to 0.10.0, supported by our parser). */
    version?: { major: number; minor: number; patch: number };
    /** Enable LZ4 + integer compression for structural sections and numeric arrays (default: true). */
    compress?: boolean;
}

const DEFAULT_VERSION = { major: 0, minor: 10, patch: 0 };

// Mirror internal enums in `usdc/parser.ts`.
const enum ValueType {
    Invalid = 0,
    Bool = 1,
    Int = 3,
    UInt = 4,
    Int64 = 5,
    UInt64 = 6,
    Float = 8,
    Double = 9,
    String = 10,
    Token = 11,
    AssetPath = 12,
    Matrix4d = 15,
    Vec2f = 20,
    Vec3f = 24,
    Vec4f = 28,
    Vec2d = 19,
    Vec3d = 23,
    Vec4d = 27,
    Dictionary = 31,
    PathListOp = 34,
    ReferenceListOp = 35,
    Specifier = 42,
    Variability = 44,
    TimeSamples = 46,
    DoubleVector = 48,
    ValueBlock = 51,
    PayloadListOp = 55,
    PathVector = 40,
    TokenVector = 41,
}

const enum SpecType {
    Attribute = 1,
    Prim = 6,
    PseudoRoot = 7,
    Relationship = 8,
}

type Field = { tokenIndex: number; valueRep: bigint };
type Spec = { pathIndex: number; fieldSetIndex: number; specType: number };

class ByteWriter {
    private buf = new Uint8Array(1024);
    private dv = new DataView(this.buf.buffer);
    private _length = 0;

    get length(): number {
        return this._length;
    }

    toUint8Array(): Uint8Array {
        return this.buf.subarray(0, this._length);
    }

    private ensure(extra: number): void {
        const need = this._length + extra;
        if (need <= this.buf.length) return;
        let next = this.buf.length;
        while (next < need) next *= 2;
        const nb = new Uint8Array(next);
        nb.set(this.buf);
        this.buf = nb;
        this.dv = new DataView(this.buf.buffer);
    }

    align(n: number): void {
        const pad = (n - (this._length % n)) % n;
        if (pad) this.writeZeros(pad);
    }

    writeZeros(n: number): void {
        this.ensure(n);
        this.buf.fill(0, this._length, this._length + n);
        this._length += n;
    }

    writeUint8(v: number): void {
        this.ensure(1);
        this.buf[this._length++] = v & 0xFF;
    }

    writeInt32(v: number): void {
        this.ensure(4);
        this.dv.setInt32(this._length, v, true);
        this._length += 4;
    }

    writeUint32(v: number): void {
        this.ensure(4);
        this.dv.setUint32(this._length, v >>> 0, true);
        this._length += 4;
    }

    writeFloat32(v: number): void {
        this.ensure(4);
        this.dv.setFloat32(this._length, v, true);
        this._length += 4;
    }

    writeFloat64(v: number): void {
        this.ensure(8);
        this.dv.setFloat64(this._length, v, true);
        this._length += 8;
    }

    writeBigInt64(v: bigint): void {
        this.ensure(8);
        this.dv.setBigInt64(this._length, v, true);
        this._length += 8;
    }

    writeBigUint64(v: bigint): void {
        this.ensure(8);
        this.dv.setBigUint64(this._length, v, true);
        this._length += 8;
    }

    setBigUint64At(offset: number, v: bigint): void {
        if (offset < 0 || offset + 8 > this._length) throw new Error('setBigUint64At out of range');
        this.dv.setBigUint64(offset, v, true);
    }

    getBigUint64At(offset: number): bigint {
        if (offset < 0 || offset + 8 > this._length) throw new Error('getBigUint64At out of range');
        return this.dv.getBigUint64(offset, true);
    }

    writeBytes(bytes: Uint8Array): void {
        this.ensure(bytes.length);
        this.buf.set(bytes, this._length);
        this._length += bytes.length;
    }

    writeFixedString(s: string, len: number): void {
        const enc = new TextEncoder().encode(s);
        this.ensure(len);
        const n = Math.min(enc.length, len);
        this.buf.set(enc.subarray(0, n), this._length);
        if (n < len) this.buf.fill(0, this._length + n, this._length + len);
        this._length += len;
    }
}

class TokenTables {
    tokens: string[] = ['']; // reserve index 0 so we can safely negate token indices for property path elements
    tokenToIndex = new Map<string, number>([['', 0]]);

    // STRINGS table is an indirection array of tokenIndex values.
    stringIndices: number[] = [];
    stringToStringIndex = new Map<string, number>();

    tokenIndex(s: string): number {
        const key = s ?? '';
        const hit = this.tokenToIndex.get(key);
        if (hit !== undefined) return hit;
        const idx = this.tokens.length;
        this.tokens.push(key);
        this.tokenToIndex.set(key, idx);
        return idx;
    }

    stringIndex(s: string): number {
        const key = s ?? '';
        const hit = this.stringToStringIndex.get(key);
        if (hit !== undefined) return hit;
        const ti = this.tokenIndex(key);
        const si = this.stringIndices.length;
        this.stringIndices.push(ti);
        this.stringToStringIndex.set(key, si);
        return si;
    }
}

function makeValueRep(opts: { type: ValueType; flags?: number; payload48: bigint }): bigint {
    const type = BigInt(opts.type & 0xFF);
    const flags = BigInt(opts.flags ?? 0);
    const payload = opts.payload48 & ((1n << 48n) - 1n);
    return payload | (type << 48n) | (flags << 56n);
}

function float32Bits(v: number): number {
    const buf = new ArrayBuffer(4);
    const dv = new DataView(buf);
    dv.setFloat32(0, v, true);
    return dv.getUint32(0, true);
}

/**
 * LZ4 block compressor (not frame format).
 *
 * This is a straightforward implementation sufficient for crate sections:
 * - emits standard sequences: literals + (optional) match
 * - supports offsets up to 65535
 * - favors correctness over optimal compression ratio
 */
function lz4CompressBlock(src: Uint8Array): Uint8Array {
    // Early out: tiny buffers are best left as literals-only.
    if (src.length < 16) {
        const out = new ByteWriter();
        // token: litLen in high nibble, matchLen=0 in low nibble
        const litLen = src.length;
        if (litLen < 15) out.writeUint8((litLen << 4) | 0);
        else {
            out.writeUint8((15 << 4) | 0);
            let n = litLen - 15;
            while (n >= 255) { out.writeUint8(255); n -= 255; }
            out.writeUint8(n);
        }
        out.writeBytes(src);
        return out.toUint8Array();
    }

    const out = new ByteWriter();
    const hashSize = 1 << 16;
    const head = new Int32Array(hashSize);
    head.fill(-1);

    const hash = (p: number): number => {
        const v =
            (src[p] ?? 0) |
            ((src[p + 1] ?? 0) << 8) |
            ((src[p + 2] ?? 0) << 16) |
            ((src[p + 3] ?? 0) << 24);
        // Knuth multiplicative hash
        return ((v * 2654435761) >>> 16) & (hashSize - 1);
    };

    let anchor = 0;
    let i = 0;
    const lastLiterals = src.length - 5;
    while (i <= lastLiterals) {
        const h = hash(i);
        const ref = head[h];
        head[h] = i;

        if (ref >= 0 && (i - ref) <= 0xFFFF) {
            // Check for match
            let mlen = 0;
            while (i + mlen < src.length && src[ref + mlen] === src[i + mlen]) {
                mlen++;
            }
            if (mlen >= 4) {
                const litLen = i - anchor;
                // token
                const litNib = Math.min(litLen, 15);
                const matchNib = Math.min(mlen - 4, 15);
                out.writeUint8((litNib << 4) | matchNib);
                // litLen ext
                if (litLen >= 15) {
                    let n = litLen - 15;
                    while (n >= 255) { out.writeUint8(255); n -= 255; }
                    out.writeUint8(n);
                }
                // literals
                if (litLen > 0) out.writeBytes(src.subarray(anchor, i));
                // offset
                const off = i - ref;
                out.writeUint8(off & 0xFF);
                out.writeUint8((off >>> 8) & 0xFF);
                // matchLen ext
                if (mlen - 4 >= 15) {
                    let n = (mlen - 4) - 15;
                    while (n >= 255) { out.writeUint8(255); n -= 255; }
                    out.writeUint8(n);
                }
                // advance
                i += mlen;
                anchor = i;
                // update hash table for the bytes we skipped (simple approach)
                const stop = Math.min(i, src.length - 4);
                for (let p = i - mlen + 1; p < stop; p++) head[hash(p)] = p;
                continue;
            }
        }
        i++;
    }

    // last literals
    const litLen = src.length - anchor;
    if (litLen >= 0) {
        const litNib = Math.min(litLen, 15);
        out.writeUint8((litNib << 4) | 0);
        if (litLen >= 15) {
            let n = litLen - 15;
            while (n >= 255) { out.writeUint8(255); n -= 255; }
            out.writeUint8(n);
        }
        if (litLen > 0) out.writeBytes(src.subarray(anchor));
    }

    return out.toUint8Array();
}

function lz4WithUsdHeader(src: Uint8Array): Uint8Array {
    // USD crate stores LZ4 blocks prefixed by a 1-byte header (0x00).
    const block = lz4CompressBlock(src);
    const out = new Uint8Array(1 + block.length);
    out[0] = 0x00;
    out.set(block, 1);
    return out;
}

/**
 * USD IntegerCompression encoder for uint32 streams.
 * Produces the byte blob expected by `decompressIntegers32()` / `decodeIntegers32()` in the parser.
 */
function usdIntegerCompressU32(values: Uint32Array): Uint8Array {
    const n = values.length;
    const numCodesBytes = Math.ceil((n * 2) / 8);
    // The decoder always LZ4-decompresses into this "worst-case" sized buffer.
    const encodedSize = 4 + numCodesBytes + n * 4;
    const encoded = new Uint8Array(encodedSize);
    const dv = new DataView(encoded.buffer);

    // Delta coding
    const diffs = new Int32Array(n);
    let prev = 0;
    for (let i = 0; i < n; i++) {
        const v = values[i] ?? 0;
        const diff = (v - prev) | 0;
        diffs[i] = diff;
        prev = v;
    }

    // Find the most common diff value.
    const counts = new Map<number, number>();
    for (let i = 0; i < n; i++) {
        const d = diffs[i] | 0;
        counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    let commonValue = 0;
    let best = -1;
    for (const [k, c] of counts.entries()) {
        if (c > best) { best = c; commonValue = k | 0; }
    }

    dv.setInt32(0, commonValue | 0, true);

    const codesStart = 4;
    const vintsStart = codesStart + numCodesBytes;
    let vintsOffset = vintsStart;

    const setCode = (idx: number, code: number): void => {
        const byteIndex = codesStart + Math.floor((idx * 2) / 8);
        const bitOffset = (idx * 2) % 8;
        encoded[byteIndex] = (encoded[byteIndex] ?? 0) | ((code & 0x03) << bitOffset);
    };

    for (let i = 0; i < n; i++) {
        const d = diffs[i] | 0;
        if (d === commonValue) {
            setCode(i, 0);
            continue;
        }
        if (d >= -128 && d <= 127) {
            setCode(i, 1);
            dv.setInt8(vintsOffset, d);
            vintsOffset += 1;
            continue;
        }
        if (d >= -32768 && d <= 32767) {
            setCode(i, 2);
            dv.setInt16(vintsOffset, d, true);
            vintsOffset += 2;
            continue;
        }
        setCode(i, 3);
        dv.setInt32(vintsOffset, d, true);
        vintsOffset += 4;
    }

    // LZ4 compress + USD 1-byte header
    return lz4WithUsdHeader(encoded);
}

type PathNode = {
    kind: 'root' | 'prim' | 'prop';
    name: string;
    pathIndex: number;
    children: Map<string, PathNode>;
};

function buildPathTree(allPaths: string[], pathToIndex: Map<string, number>): PathNode {
    const root: PathNode = { kind: 'root', name: '', pathIndex: pathToIndex.get('/') ?? 0, children: new Map() };

    for (const p of allPaths) {
        if (!p || p === '/') continue;
        const sp = SdfPath.parse(p);
        // Ensure prim segments
        const primParts = sp.primPath.split('/').filter(Boolean);
        let cur = root;
        let curPrimPath = '';
        for (const part of primParts) {
            curPrimPath = curPrimPath === '' ? `/${part}` : `${curPrimPath}/${part}`;
            const key = `prim:${part}`;
            let next = cur.children.get(key);
            if (!next) {
                next = {
                    kind: 'prim',
                    name: part,
                    pathIndex: pathToIndex.get(curPrimPath)!,
                    children: new Map(),
                };
                cur.children.set(key, next);
            }
            cur = next;
        }

        if (sp.kind === 'property') {
            const prop = sp.propertyName ?? '';
            const propPath = `${sp.primPath}.${prop}`;
            const key = `prop:${prop}`;
            let next = cur.children.get(key);
            if (!next) {
                next = {
                    kind: 'prop',
                    name: prop,
                    pathIndex: pathToIndex.get(propPath)!,
                    children: new Map(),
                };
                cur.children.set(key, next);
            }
            cur = next;

            if (sp.propertyField) {
                const field = sp.propertyField;
                const fieldPath = `${propPath}.${field}`;
                const fkey = `prop:${field}`;
                let fnode = cur.children.get(fkey);
                if (!fnode) {
                    fnode = {
                        kind: 'prop',
                        name: field,
                        pathIndex: pathToIndex.get(fieldPath)!,
                        children: new Map(),
                    };
                    cur.children.set(fkey, fnode);
                }
            }
        }
    }

    return root;
}

function computeSubtreeSize(n: PathNode): number {
    let total = 1;
    const kids = Array.from(n.children.values());
    for (const c of kids) total += computeSubtreeSize(c);
    return total;
}

function encodePathsSection(opts: { root: PathNode; tables: TokenTables }): { pathIndexes: number[]; elementTokenIndexes: number[]; jumps: number[] } {
    const { root, tables } = opts;
    const pathIndexes: number[] = [];
    const elementTokenIndexes: number[] = [];
    const jumps: number[] = [];

    const visit = (node: PathNode, hasSibling: boolean): void => {
        pathIndexes.push(node.pathIndex >>> 0);
        if (node.kind === 'root') {
            elementTokenIndexes.push(0);
        } else if (node.kind === 'prim') {
            elementTokenIndexes.push(tables.tokenIndex(node.name));
        } else {
            const ti = tables.tokenIndex(node.name);
            elementTokenIndexes.push(-ti);
        }

        const children = Array.from(node.children.values());
        const hasChild = children.length > 0;
        if (hasChild) {
            // Precompute subtree size so we can fill jump for the "has child + sibling" case.
            const subtreeSize = computeSubtreeSize(node);
            if (hasSibling) jumps.push(subtreeSize);
            else jumps.push(-1);
            // Visit children in stable order by their full key (Map insertion order is stable, but we want deterministic across construction).
            const sorted = children.slice().sort((a, b) => `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`));
            for (let i = 0; i < sorted.length; i++) {
                visit(sorted[i]!, i < sorted.length - 1);
            }
        } else {
            if (hasSibling) jumps.push(0);
            else jumps.push(-2);
        }
    };

    visit(root, false);
    if (pathIndexes.length !== elementTokenIndexes.length || pathIndexes.length !== jumps.length) {
        throw new Error('Internal error: PATHS arrays misaligned');
    }
    return { pathIndexes, elementTokenIndexes, jumps };
}

function walkPrims(root: SdfPrimSpec): SdfPrimSpec[] {
    const out: SdfPrimSpec[] = [];
    const visit = (p: SdfPrimSpec): void => {
        for (const c of p.children?.values?.() ?? []) visit(c);
        if (p.path.primPath !== '/') out.push(p);
    };
    visit(root);
    out.sort((a, b) => a.path.toString().localeCompare(b.path.toString()));
    return out;
}

function walkProperties(prim: SdfPrimSpec): SdfPropertySpec[] {
    const out: SdfPropertySpec[] = [];
    for (const p of prim.properties?.values?.() ?? []) out.push(p);
    out.sort((a, b) => a.path.toString().localeCompare(b.path.toString()));
    return out;
}

function isTypedArray(v: any): v is { type: 'typedArray'; elementType: string; value: any } {
    return !!v && typeof v === 'object' && v.type === 'typedArray' && v.value;
}

function isArrayValue(v: any): v is { type: 'array'; elementType: string; value: any[] } {
    return !!v && typeof v === 'object' && v.type === 'array' && Array.isArray(v.value);
}

function isDictValue(v: any): v is { type: 'dict'; value: Record<string, SdfValue> } {
    return !!v && typeof v === 'object' && v.type === 'dict' && v.value && typeof v.value === 'object';
}

function isTokenValue(v: any): v is { type: 'token'; value: string } {
    return !!v && typeof v === 'object' && v.type === 'token' && typeof v.value === 'string';
}

function isAssetValue(v: any): v is { type: 'asset'; value: string } {
    return !!v && typeof v === 'object' && v.type === 'asset' && typeof v.value === 'string';
}

function isVecfValue(v: any): v is { type: 'vec2f' | 'vec3f' | 'vec4f'; value: number[] } {
    return !!v && typeof v === 'object' && (v.type === 'vec2f' || v.type === 'vec3f' || v.type === 'vec4f') && Array.isArray(v.value);
}

function encodeValue(
    v: SdfValue,
    ctx: {
        tables: TokenTables;
        data: ByteWriter;
        dataValueRepOffsets: number[];
        pathToIndex: Map<string, number>;
        declaredTypeName?: string;
        compress?: boolean;
        listOpKind?: 'references' | 'payload';
    }
): bigint {
    const { tables, data, pathToIndex } = ctx;

    if (v === null) {
        return makeValueRep({ type: ValueType.ValueBlock, flags: 0, payload48: 0n });
    }
    if (typeof v === 'boolean') {
        return makeValueRep({ type: ValueType.Bool, flags: 0x40, payload48: BigInt(v ? 1 : 0) });
    }
    if (typeof v === 'number') {
        // Encode based on declared type when present.
        const tn = ctx.declaredTypeName ?? '';
        if (tn === 'float' || tn.startsWith('float')) {
            return makeValueRep({ type: ValueType.Float, flags: 0x40, payload48: BigInt(float32Bits(v)) });
        }
        if (tn === 'double' || tn.startsWith('double')) {
            const off = data.length;
            data.writeFloat64(v);
            return makeValueRep({ type: ValueType.Double, flags: 0, payload48: BigInt(off) });
        }
        if (tn === 'uint') {
            return makeValueRep({ type: ValueType.UInt, flags: 0x40, payload48: BigInt((v >>> 0)) });
        }
        if (tn === 'int') {
            return makeValueRep({ type: ValueType.Int, flags: 0x40, payload48: BigInt((v | 0) >>> 0) });
        }
        if (tn === 'int64') {
            const off = data.length;
            data.writeBigInt64(BigInt(Math.trunc(v)));
            return makeValueRep({ type: ValueType.Int64, flags: 0, payload48: BigInt(off) });
        }
        if (tn === 'uint64') {
            const off = data.length;
            data.writeBigUint64(BigInt(Math.trunc(v)));
            return makeValueRep({ type: ValueType.UInt64, flags: 0, payload48: BigInt(off) });
        }
        // Default numeric encoding: prefer Int when safe integer, else Double.
        if (Number.isInteger(v) && v >= -2147483648 && v <= 2147483647) {
            return makeValueRep({ type: ValueType.Int, flags: 0x40, payload48: BigInt((v | 0) >>> 0) });
        }
        const off = data.length;
        data.writeFloat64(v);
        return makeValueRep({ type: ValueType.Double, flags: 0, payload48: BigInt(off) });
    }
    if (typeof v === 'string') {
        const si = tables.stringIndex(v);
        return makeValueRep({ type: ValueType.String, flags: 0x40, payload48: BigInt(si >>> 0) });
    }
    if (isTokenValue(v)) {
        const ti = tables.tokenIndex(v.value);
        return makeValueRep({ type: ValueType.Token, flags: 0x40, payload48: BigInt(ti >>> 0) });
    }
    if (isAssetValue(v)) {
        const ti = tables.tokenIndex(v.value);
        return makeValueRep({ type: ValueType.AssetPath, flags: 0x40, payload48: BigInt(ti >>> 0) });
    }
    if (isVecfValue(v)) {
        const dim = v.type === 'vec2f' ? 2 : v.type === 'vec3f' ? 3 : 4;
        const type = v.type === 'vec2f' ? ValueType.Vec2f : v.type === 'vec3f' ? ValueType.Vec3f : ValueType.Vec4f;
        const off = data.length;
        for (let i = 0; i < dim; i++) data.writeFloat32(Number(v.value[i] ?? 0));
        return makeValueRep({ type, flags: 0, payload48: BigInt(off) });
    }
    if (v && typeof v === 'object' && (v as any).type === 'tuple' && Array.isArray((v as any).value)) {
        const arr = (v as any).value as any[];
        const nums = arr.map((x) => typeof x === 'number' ? x : 0);
        const tn = ctx.declaredTypeName ?? '';
        const dim = nums.length;
        // double2/3/4 -> Vec*d
        if ((tn.startsWith('double') || tn.includes('double')) && (dim === 2 || dim === 3 || dim === 4)) {
            const vt = dim === 2 ? ValueType.Vec2d : dim === 3 ? ValueType.Vec3d : ValueType.Vec4d;
            const off = data.length;
            for (let i = 0; i < dim; i++) data.writeFloat64(Number(nums[i] ?? 0));
            return makeValueRep({ type: vt, flags: 0, payload48: BigInt(off) });
        }
        // float2/3/4 -> Vec*f
        if ((tn.startsWith('float') || tn.includes('float') || tn.endsWith('f')) && (dim === 2 || dim === 3 || dim === 4)) {
            const vt = dim === 2 ? ValueType.Vec2f : dim === 3 ? ValueType.Vec3f : ValueType.Vec4f;
            const off = data.length;
            for (let i = 0; i < dim; i++) data.writeFloat32(Number(nums[i] ?? 0));
            return makeValueRep({ type: vt, flags: 0, payload48: BigInt(off) });
        }
        // Fallback: encode as double vec when 2..4
        if (dim === 2 || dim === 3 || dim === 4) {
            const vt = dim === 2 ? ValueType.Vec2d : dim === 3 ? ValueType.Vec3d : ValueType.Vec4d;
            const off = data.length;
            for (let i = 0; i < dim; i++) data.writeFloat64(Number(nums[i] ?? 0));
            return makeValueRep({ type: vt, flags: 0, payload48: BigInt(off) });
        }
    }
    if (v && typeof v === 'object' && (v as any).type === 'matrix4d') {
        const arr = (v as any).value as number[];
        const off = data.length;
        for (let i = 0; i < 16; i++) data.writeFloat64(Number(arr[i] ?? 0));
        return makeValueRep({ type: ValueType.Matrix4d, flags: 0, payload48: BigInt(off) });
    }
    if (isTypedArray(v)) {
        // Attempt to encode vecNf arrays when declared type indicates a packed vec array.
        const declared = ctx.declaredTypeName;
        const buf = v.value as Float32Array | Float64Array | Int32Array | Uint32Array;
        const elementType = String(v.elementType ?? '');

        const writeArrayHeader = (count: number): number => {
            const off = data.length;
            data.writeBigUint64(BigInt(count));
            return off;
        };

        const encodeScalarArray = (type: ValueType, writeElem: (x: number) => void): bigint => {
            const count = buf.length;
            const off = writeArrayHeader(count);
            const wantCompress = ctx.compress === true;
            if (!wantCompress) {
                for (let i = 0; i < count; i++) writeElem(Number((buf as any)[i] ?? 0));
                return makeValueRep({ type, flags: 0x80, payload48: BigInt(off) });
            }
            // Compressed arrays are only implemented in the parser for Int/UInt and Float/Double scalar arrays.
            if (type === ValueType.Int || type === ValueType.UInt) {
                // Layout for compressed int/uint arrays (matches parser):
                // [u64 count][u64 compressedSize][compressedBlob]
                // where compressedBlob is USD integer compression with 1-byte header + LZ4 block.
                const valuesU32 = new Uint32Array(count);
                for (let i = 0; i < count; i++) valuesU32[i] = Number((buf as any)[i] ?? 0) >>> 0;
                const comp = usdIntegerCompressU32(valuesU32);
                data.writeBigUint64(BigInt(comp.length));
                data.writeBytes(comp);
                return makeValueRep({ type, flags: 0x80 | 0x20, payload48: BigInt(off) });
            }
            if (type === ValueType.Float || type === ValueType.Double) {
                // Use 't' mode (lookup table + compressed indices) which preserves exact values:
                // float:  [u64 count]['t'][u32 lutSize][lut float32*][u64 compressedSize][compressed uint32 idxs]
                // double: [u64 count]['t'][u32 lutSize][lut float64*][u64 compressedSize][compressed uint32 idxs]
                const idxs = new Uint32Array(count);
                const lut: number[] = [];
                const map = new Map<number, number>(); // key: float32 bits for float; stable hash for doubles

                if (type === ValueType.Float) {
                    for (let i = 0; i < count; i++) {
                        const x = Number((buf as any)[i] ?? 0);
                        const bits = float32Bits(x) >>> 0;
                        const hit = map.get(bits);
                        if (hit !== undefined) {
                            idxs[i] = hit >>> 0;
                        } else {
                            const next = lut.length;
                            lut.push(x);
                            map.set(bits, next);
                            idxs[i] = next >>> 0;
                        }
                    }
                } else {
                    // Double: use float64 bit pattern as key via DataView.
                    const tmp = new ArrayBuffer(8);
                    const dv = new DataView(tmp);
                    const keyFor = (x: number): number => {
                        dv.setFloat64(0, x, true);
                        // Fold to 32-bit hash (lossy but adequate for a map key in practice here).
                        const lo = dv.getUint32(0, true);
                        const hi = dv.getUint32(4, true);
                        return (lo ^ hi) >>> 0;
                    };
                    // Collision safety: fall back to linear check when hash collides.
                    const buckets = new Map<number, number[]>();
                    for (let i = 0; i < count; i++) {
                        const x = Number((buf as any)[i] ?? 0);
                        const h = keyFor(x);
                        const b = buckets.get(h);
                        if (b) {
                            let found = -1;
                            for (const j of b) {
                                if (Object.is(lut[j]!, x)) { found = j; break; }
                            }
                            if (found >= 0) {
                                idxs[i] = found >>> 0;
                            } else {
                                const next = lut.length;
                                lut.push(x);
                                b.push(next);
                                idxs[i] = next >>> 0;
                            }
                        } else {
                            const next = lut.length;
                            lut.push(x);
                            buckets.set(h, [next]);
                            idxs[i] = next >>> 0;
                        }
                    }
                }

                const comp = usdIntegerCompressU32(idxs);
                data.writeUint8(116); // 't'
                data.writeUint32(lut.length >>> 0);
                if (type === ValueType.Float) {
                    for (const x of lut) data.writeFloat32(x);
                } else {
                    for (const x of lut) data.writeFloat64(x);
                }
                data.writeBigUint64(BigInt(comp.length));
                data.writeBytes(comp);
                return makeValueRep({ type, flags: 0x80 | 0x20, payload48: BigInt(off) });
            }
            // Fallback: uncompressed
            for (let i = 0; i < count; i++) writeElem(Number((buf as any)[i] ?? 0));
            return makeValueRep({ type, flags: 0x80, payload48: BigInt(off) });
        };

        // Vec arrays: when declared ends with [] and is a float vec type (point3f[], texCoord2f[], etc).
        if (typeof declared === 'string' && declared.endsWith('[]') && buf instanceof Float32Array) {
            const base = declared.slice(0, -2);
            const dim =
                base.endsWith('2f') ? 2 :
                    base.endsWith('3f') ? 3 :
                        base.endsWith('4f') ? 4 : null;
            if (dim) {
                const count = Math.floor(buf.length / dim);
                const vt = dim === 2 ? ValueType.Vec2f : dim === 3 ? ValueType.Vec3f : ValueType.Vec4f;
                const off = writeArrayHeader(count);
                // Payload layout for vec arrays: count entries, each entry is dim float32.
                for (let i = 0; i < count * dim; i++) data.writeFloat32(Number(buf[i] ?? 0));
                return makeValueRep({ type: vt, flags: 0x80, payload48: BigInt(off) });
            }
        }

        if (buf instanceof Int32Array) return encodeScalarArray(ValueType.Int, (x) => data.writeInt32(x | 0));
        if (buf instanceof Uint32Array) return encodeScalarArray(ValueType.UInt, (x) => data.writeUint32(x >>> 0));
        if (buf instanceof Float32Array) return encodeScalarArray(ValueType.Float, (x) => data.writeFloat32(x));
        if (buf instanceof Float64Array) return encodeScalarArray(ValueType.Double, (x) => data.writeFloat64(x));

        // Fallback: treat as empty.
        return makeValueRep({ type: ValueType.ValueBlock, flags: 0, payload48: 0n });
    }
    if (isArrayValue(v)) {
        if (v.elementType === 'token') {
            const vals = v.value.map((x) => (isTokenValue(x) ? x.value : (typeof x === 'string' ? x : '')));
            const off = data.length;
            data.writeBigUint64(BigInt(vals.length));
            for (const s of vals) data.writeUint32(tables.tokenIndex(s));
            return makeValueRep({ type: ValueType.Token, flags: 0x80, payload48: BigInt(off) });
        }
        if (v.elementType === 'tokenVector') {
            // Non-array ValueType.TokenVector: [u64 n][u32 tokenIndex[n]]
            const vals = v.value.map((x: any) => (isTokenValue(x) ? x.value : (typeof x === 'string' ? x : '')));
            const off = data.length;
            data.writeBigUint64(BigInt(vals.length));
            for (const s of vals) data.writeUint32(tables.tokenIndex(s));
            return makeValueRep({ type: ValueType.TokenVector, flags: 0, payload48: BigInt(off) });
        }
        if (v.elementType === 'pathVector') {
            // Non-array ValueType.PathVector: [u64 n][u32 pathIndex[n]]
            const vals = v.value
                .map((x: any) => (x && typeof x === 'object' && x.type === 'sdfpath') ? String(x.value ?? '') : (typeof x === 'string' ? x : ''))
                .filter(Boolean);
            const off = data.length;
            data.writeBigUint64(BigInt(vals.length));
            for (const p of vals) data.writeUint32((pathToIndex.get(String(p)) ?? 0) >>> 0);
            return makeValueRep({ type: ValueType.PathVector, flags: 0, payload48: BigInt(off) });
        }
        if (v.elementType === 'sdfpath') {
            // Encode as explicit PathListOp so parser yields array<sdfpath>.
            const paths = v.value
                .map((x) => (x && typeof x === 'object' && (x as any).type === 'sdfpath' ? (x as any).value : ''))
                .filter(Boolean);
            const off = data.length;
            data.writeUint8(0x03); // isExplicit + hasExplicit
            data.writeBigUint64(BigInt(paths.length));
            for (const p of paths) {
                const pi = pathToIndex.get(String(p));
                data.writeUint32((pi ?? 0) >>> 0);
            }
            return makeValueRep({ type: ValueType.PathListOp, flags: 0, payload48: BigInt(off) });
        }
        if (v.elementType === 'reference') {
            // Encode as explicit reference list op (ReferenceListOp).
            const entries = v.value
                .map((x: any) => (x && typeof x === 'object' && x.type === 'reference') ? x : null)
                .filter(Boolean) as any[];
            const off = data.length;
            data.writeUint8(0x03); // isExplicit + hasExplicit
            data.writeBigUint64(BigInt(entries.length));
            for (const e of entries) {
                const assetPath = String(e.assetPath ?? '');
                const targetPath = typeof e.targetPath === 'string' ? String(e.targetPath) : '';
                const asi = tables.stringIndex(assetPath);
                const pi = targetPath ? (pathToIndex.get(targetPath) ?? 0) : 0;
                data.writeUint32(asi >>> 0);
                data.writeUint32(pi >>> 0);
            }
            const listType = ctx.listOpKind === 'payload' ? ValueType.PayloadListOp : ValueType.ReferenceListOp;
            return makeValueRep({ type: listType, flags: 0, payload48: BigInt(off) });
        }
        // Fallback: encode unknown arrays as blocked.
        return makeValueRep({ type: ValueType.ValueBlock, flags: 0, payload48: 0n });
    }
    if (v && typeof v === 'object' && (v as any).type === 'reference') {
        // Encode a single reference as an explicit listOp with 1 entry.
        const e: any = v as any;
        const off = data.length;
        data.writeUint8(0x03); // isExplicit + hasExplicit
        data.writeBigUint64(1n);
        const assetPath = String(e.assetPath ?? '');
        const targetPath = typeof e.targetPath === 'string' ? String(e.targetPath) : '';
        const asi = tables.stringIndex(assetPath);
        const pi = targetPath ? (pathToIndex.get(targetPath) ?? 0) : 0;
        data.writeUint32(asi >>> 0);
        data.writeUint32(pi >>> 0);
        const listType = ctx.listOpKind === 'payload' ? ValueType.PayloadListOp : ValueType.ReferenceListOp;
        return makeValueRep({ type: listType, flags: 0, payload48: BigInt(off) });
    }
    if (isDictValue(v)) {
        // Distinguish between real VtDictionary vs our listOp dict shape:
        // { type:'dict', value:{ op: token, value: <SdfValue> } }
        const maybeOp: any = (v as any).value?.op;
        const maybeInner: any = (v as any).value?.value;
        const opStr =
            typeof maybeOp === 'string' ? maybeOp :
                (maybeOp && typeof maybeOp === 'object' && maybeOp.type === 'token') ? maybeOp.value :
                    null;
        if (opStr && maybeInner !== undefined) {
            const toBits = (op: string): { bits: number; kind: 'explicit' | 'prepend' | 'append' | 'add' | 'delete' | 'ordered' } => {
                if (op === 'prepend') return { bits: 0x20, kind: 'prepend' };
                if (op === 'append') return { bits: 0x40, kind: 'append' };
                if (op === 'add') return { bits: 0x04, kind: 'add' };
                if (op === 'delete') return { bits: 0x08, kind: 'delete' };
                if (op === 'order' || op === 'ordered') return { bits: 0x10, kind: 'ordered' };
                // treat unknown as explicit
                return { bits: 0x03, kind: 'explicit' };
            };

            // ListOp of sdfpaths -> PathListOp.
            if (maybeInner && typeof maybeInner === 'object' && ((maybeInner.type === 'sdfpath') || (maybeInner.type === 'array' && maybeInner.elementType === 'sdfpath'))) {
                const { bits } = toBits(opStr);
                const off = data.length;
                // Explicit encoding requires both IsExplicit and HasExplicit
                const header = opStr === 'explicit' ? 0x03 : bits;
                data.writeUint8(header);
                const arr: any[] =
                    maybeInner.type === 'sdfpath'
                        ? [{ type: 'sdfpath', value: maybeInner.value }]
                        : (maybeInner.value ?? []);
                data.writeBigUint64(BigInt(arr.length));
                for (const it of arr) {
                    const p = it && typeof it === 'object' && it.type === 'sdfpath' ? String(it.value ?? '') : '';
                    data.writeUint32((pathToIndex.get(p) ?? 0) >>> 0);
                }
                return makeValueRep({ type: ValueType.PathListOp, flags: 0, payload48: BigInt(off) });
            }

            // ListOp of references/payloads -> ReferenceListOp / PayloadListOp.
            if (maybeInner && (
                (typeof maybeInner === 'object' && (maybeInner.type === 'reference' || (maybeInner.type === 'array' && maybeInner.elementType === 'reference') || maybeInner.type === 'asset')) ||
                typeof maybeInner === 'string'
            )) {
                const listType = ctx.listOpKind === 'payload' ? ValueType.PayloadListOp : ValueType.ReferenceListOp;
                const { bits } = toBits(opStr);
                const off = data.length;
                const header = opStr === 'explicit' ? 0x03 : bits;
                data.writeUint8(header);
                const arr: any[] = (() => {
                    if (typeof maybeInner === 'string') return [{ type: 'reference', assetPath: maybeInner }];
                    if (maybeInner.type === 'asset') return [{ type: 'reference', assetPath: String(maybeInner.value ?? '') }];
                    if (maybeInner.type === 'reference') return [maybeInner];
                    return (maybeInner.value ?? []);
                })();
                data.writeBigUint64(BigInt(arr.length));
                for (const it of arr) {
                    const assetPath = String(it?.assetPath ?? '');
                    const targetPath = typeof it?.targetPath === 'string' ? String(it.targetPath) : '';
                    const asi = tables.stringIndex(assetPath);
                    const pi = targetPath ? (pathToIndex.get(targetPath) ?? 0) : 0;
                    data.writeUint32(asi >>> 0);
                    data.writeUint32(pi >>> 0);
                }
                return makeValueRep({ type: listType, flags: 0, payload48: BigInt(off) });
            }
        }

        const entries = Object.entries(v.value ?? {});
        const off = data.length;
        data.writeBigUint64(BigInt(entries.length));
        for (const [k, vv] of entries) {
            const keyStringIndex = tables.stringIndex(k);
            data.writeUint32(keyStringIndex >>> 0);
            const offsetLoc = data.length;
            // Place the trailing ValueRep immediately after this int64 => rel=8.
            data.writeBigInt64(8n);
            const rep = encodeValue(vv as any, ctx);
            const repPos = data.length;
            data.writeBigUint64(rep);
            ctx.dataValueRepOffsets.push(repPos);
            // Stream position naturally advances (matches parser logic).
            // Note: no alignment requirements here (DataView supports unaligned loads).
            void offsetLoc;
        }
        return makeValueRep({ type: ValueType.Dictionary, flags: 0, payload48: BigInt(off) });
    }

    // Unknown: preserve as blocked.
    return makeValueRep({ type: ValueType.ValueBlock, flags: 0, payload48: 0n });
}

function encodeTimeSamples(
    ts: Map<number, SdfValue>,
    ctx: { tables: TokenTables; data: ByteWriter; dataValueRepOffsets: number[]; pathToIndex: Map<string, number>; declaredTypeName?: string; compress?: boolean }
): bigint {
    const entries = Array.from(ts.entries()).sort((a, b) => a[0] - b[0]);
    const times = entries.map((e) => e[0]);
    const values = entries.map((e) => e[1]);

    // Encode times vector (DoubleVector payload).
    const timesPayloadOff = ctx.data.length;
    ctx.data.writeBigUint64(BigInt(times.length));
    for (const t of times) ctx.data.writeFloat64(t);
    const timesRep = makeValueRep({ type: ValueType.DoubleVector, flags: 0, payload48: BigInt(timesPayloadOff) });

    // Encode values reps (each may point elsewhere in DATA).
    const valuesReps: bigint[] = values.map((v) => encodeValue(v, ctx as any));

    // TimeSamples blob:
    // p0: int64 rel1 -> timesRep (we place timesRep at p0+16)
    // pTimes: u64 timesRep
    // pOffset2: int64 rel2 -> values area (we place values area at pOffset2+8)
    // pValues: u64 numValues, then numValues ValueRep
    const p0 = ctx.data.length;
    ctx.data.writeBigInt64(16n);
    ctx.data.writeZeros(8); // reserved/padding between the two rel offsets (keeps layout simple)
    const pTimes = ctx.data.length;
    ctx.data.writeBigUint64(timesRep);
    ctx.dataValueRepOffsets.push(pTimes);
    const pOffset2 = ctx.data.length;
    ctx.data.writeBigInt64(8n);
    const pValues = ctx.data.length;
    ctx.data.writeBigUint64(BigInt(valuesReps.length));
    for (const vr of valuesReps) {
        const repPos = ctx.data.length;
        ctx.data.writeBigUint64(vr);
        ctx.dataValueRepOffsets.push(repPos);
    }
    void pTimes; void pOffset2; void pValues;

    return makeValueRep({ type: ValueType.TimeSamples, flags: 0, payload48: BigInt(p0) });
}

export function serializeLayerToUsdc(layer: SdfLayer, opts: UsdcSerializeOptions = {}): Uint8Array {
    const version = opts.version ?? DEFAULT_VERSION;
    const compress = opts.compress !== false;

    const tables = new TokenTables();

    // Collect prims + properties.
    const prims = walkPrims(layer.root);

    // Path table
    const allPathStrings = new Set<string>();
    allPathStrings.add('/');
    for (const prim of prims) {
        allPathStrings.add(prim.path.toString());
        for (const prop of walkProperties(prim)) allPathStrings.add(prop.path.toString());
    }
    // Also include any explicit sdfpath values so we can encode PathListOp indices.
    const scanForPaths = (v: SdfValue): void => {
        if (!v) return;
        if (typeof v !== 'object') return;
        if ((v as any).type === 'sdfpath' && typeof (v as any).value === 'string') {
            allPathStrings.add((v as any).value);
            return;
        }
        if ((v as any).type === 'reference') {
            const tp = (v as any).targetPath;
            if (typeof tp === 'string' && tp) allPathStrings.add(tp);
            return;
        }
        if (isArrayValue(v) && v.elementType === 'sdfpath') {
            for (const it of v.value) scanForPaths(it as any);
        }
        if (isArrayValue(v) && v.elementType === 'reference') {
            for (const it of v.value) scanForPaths(it as any);
        }
        if (isDictValue(v)) {
            for (const vv of Object.values(v.value)) scanForPaths(vv as any);
        }
    };
    for (const val of Object.values(layer.metadata ?? {})) scanForPaths(val as any);
    for (const prim of prims) {
        for (const val of Object.values(prim.metadata ?? {})) scanForPaths(val as any);
        for (const prop of walkProperties(prim)) {
            for (const val of Object.values(prop.metadata ?? {})) scanForPaths(val as any);
            if (prop.defaultValue !== undefined) scanForPaths(prop.defaultValue);
            if (prop.timeSamples) for (const vv of prop.timeSamples.values()) scanForPaths(vv as any);
        }
    }

    const pathsSorted = Array.from(allPathStrings).filter(Boolean).sort((a, b) => a.localeCompare(b));
    // Ensure root is index 0.
    pathsSorted.splice(pathsSorted.indexOf('/'), 1);
    pathsSorted.unshift('/');

    const pathToIndex = new Map<string, number>();
    for (let i = 0; i < pathsSorted.length; i++) pathToIndex.set(pathsSorted[i]!, i);

    // Build PATHS encoding arrays (these also intern prim/property names into TOKENS).
    const tree = buildPathTree(pathsSorted, pathToIndex);
    const { pathIndexes, elementTokenIndexes, jumps } = encodePathsSection({ root: tree, tables });

    // Build DATA region (value payloads).
    const data = new ByteWriter();
    const dataValueRepOffsets: number[] = [];

    const fields: Field[] = [];
    const fieldSetIndices: number[] = [];
    const specs: Spec[] = [];

    const addFieldSet = (m: Map<string, { rep: bigint }>): number => {
        const start = fieldSetIndices.length;
        // Deterministic order by key
        const keys = Array.from(m.keys()).sort();
        for (const k of keys) {
            const f = m.get(k)!;
            const tokenIndex = tables.tokenIndex(k);
            const fieldIndex = fields.length;
            fields.push({ tokenIndex, valueRep: f.rep });
            fieldSetIndices.push(fieldIndex >>> 0);
        }
        fieldSetIndices.push(0xFFFFFFFF);
        return start;
    };

    // PseudoRoot spec (layer metadata)
    {
        const fm = new Map<string, { rep: bigint }>();
        for (const [k, v] of Object.entries(layer.metadata ?? {})) {
            // Most layer metadata is scalar/token/dict.
            fm.set(k, { rep: encodeValue(v as any, { tables, data, dataValueRepOffsets, pathToIndex, compress }) });
        }
        const fs = addFieldSet(fm);
        specs.push({ pathIndex: pathToIndex.get('/') ?? 0, fieldSetIndex: fs, specType: SpecType.PseudoRoot });
    }

    // Prim specs + property specs.
    for (const prim of prims) {
        const primFields = new Map<string, { rep: bigint }>();
        // specifier
        const sv = prim.specifier === 'over' ? 1 : prim.specifier === 'class' ? 2 : 0;
        primFields.set('specifier', { rep: makeValueRep({ type: ValueType.Specifier, flags: 0x40, payload48: BigInt(sv) }) });
        if (prim.typeName) {
            primFields.set('typeName', { rep: makeValueRep({ type: ValueType.Token, flags: 0x40, payload48: BigInt(tables.tokenIndex(prim.typeName)) }) });
        }
        for (const [k, v] of Object.entries(prim.metadata ?? {})) {
            const listOpKind = k === 'payload' ? 'payload' : k === 'references' ? 'references' : undefined;
            primFields.set(k, { rep: encodeValue(v as any, { tables, data, dataValueRepOffsets, pathToIndex, compress, listOpKind }) });
        }
        const primFs = addFieldSet(primFields);
        specs.push({
            pathIndex: pathToIndex.get(prim.path.toString())!,
            fieldSetIndex: primFs,
            specType: SpecType.Prim,
        });

        for (const prop of walkProperties(prim)) {
            const propFields = new Map<string, { rep: bigint }>();
            propFields.set('typeName', { rep: makeValueRep({ type: ValueType.Token, flags: 0x40, payload48: BigInt(tables.tokenIndex(prop.typeName ?? 'unknown')) }) });

            if (prop.variability) {
                // Our parser maps 0 -> varying, 1 -> uniform.
                const vv = prop.variability === 'uniform' ? 1 : 0;
                propFields.set('variability', { rep: makeValueRep({ type: ValueType.Variability, flags: 0x40, payload48: BigInt(vv) }) });
            }

            if (prop.timeSamples && prop.timeSamples.size > 0) {
                propFields.set('timeSamples', {
                    rep: encodeTimeSamples(prop.timeSamples, { tables, data, dataValueRepOffsets, pathToIndex, declaredTypeName: prop.typeName, compress }),
                });
            }

            // Relationships use targetPaths (PathListOp) rather than default.
            if (prop.typeName === 'rel') {
                const dv: any = prop.defaultValue;
                if (dv && typeof dv === 'object' && dv.type === 'sdfpath') {
                    const arr = { type: 'array', elementType: 'sdfpath', value: [dv] };
                    propFields.set('targetPaths', { rep: encodeValue(arr as any, { tables, data, dataValueRepOffsets, pathToIndex, compress }) });
                } else if (dv && typeof dv === 'object' && dv.type === 'array' && dv.elementType === 'sdfpath') {
                    propFields.set('targetPaths', { rep: encodeValue(dv as any, { tables, data, dataValueRepOffsets, pathToIndex, compress }) });
                }
            } else if (prop.defaultValue !== undefined) {
                propFields.set('default', { rep: encodeValue(prop.defaultValue, { tables, data, dataValueRepOffsets, pathToIndex, declaredTypeName: prop.typeName, compress }) });
            }

            for (const [k, v] of Object.entries(prop.metadata ?? {})) {
                // Mirror parser metadata mapping: `qualifier`/`custom` are handled there too.
                propFields.set(k, { rep: encodeValue(v as any, { tables, data, dataValueRepOffsets, pathToIndex, compress }) });
            }

            const propFs = addFieldSet(propFields);
            const isRel = prop.typeName === 'rel';
            specs.push({
                pathIndex: pathToIndex.get(prop.path.toString())!,
                fieldSetIndex: propFs,
                specType: isRel ? SpecType.Relationship : SpecType.Attribute,
            });
        }
    }

    // Now we have all tables; build section byte blobs.
    const sections: Array<{ name: string; bytes: Uint8Array }> = [];

    // TOKENS section: count + uncompressedSize + compressedSize(0) + tokenData (null-separated).
    {
        const w = new ByteWriter();
        const tokenBytes = new TextEncoder().encode(tables.tokens.join('\0') + '\0');
        const tokenComp = compress ? lz4WithUsdHeader(tokenBytes) : null;
        const useComp = !!tokenComp && tokenComp.length > 0 && tokenComp.length < tokenBytes.length;
        w.writeBigUint64(BigInt(tables.tokens.length));
        w.writeBigUint64(BigInt(tokenBytes.length));
        w.writeBigUint64(useComp ? BigInt(tokenComp.length) : 0n);
        w.writeBytes(useComp ? tokenComp : tokenBytes);
        sections.push({ name: 'TOKENS', bytes: w.toUint8Array() });
    }

    // STRINGS section: count + u32 tokenIndex[count]
    {
        const w = new ByteWriter();
        w.writeBigUint64(BigInt(tables.stringIndices.length));
        for (const ti of tables.stringIndices) w.writeUint32(ti >>> 0);
        sections.push({ name: 'STRINGS', bytes: w.toUint8Array() });
    }

    // We'll build FIELDS after we know the absolute DATA start (so we can relocate offsets).

    // FIELDSETS section: count + (optional) integer-compressed indices
    {
        const w = new ByteWriter();
        w.writeBigUint64(BigInt(fieldSetIndices.length));
        if (compress) {
            const u = new Uint32Array(fieldSetIndices.length);
            for (let i = 0; i < fieldSetIndices.length; i++) u[i] = fieldSetIndices[i] >>> 0;
            const comp = usdIntegerCompressU32(u);
            w.writeBigUint64(BigInt(comp.length));
            w.writeBytes(comp);
        } else {
            w.writeBigUint64(0n);
            for (const idx of fieldSetIndices) w.writeUint32(idx >>> 0);
        }
        sections.push({ name: 'FIELDSETS', bytes: w.toUint8Array() });
    }

    // PATHS section: numPaths + numEncodedPaths + (optional) integer-compressed arrays
    {
        const w = new ByteWriter();
        w.writeBigUint64(BigInt(pathsSorted.length));
        w.writeBigUint64(BigInt(pathIndexes.length));

        if (compress) {
            const pIdx = new Uint32Array(pathIndexes.length);
            for (let i = 0; i < pathIndexes.length; i++) pIdx[i] = pathIndexes[i] >>> 0;
            const compP = usdIntegerCompressU32(pIdx);
            w.writeBigUint64(BigInt(compP.length));
            w.writeBytes(compP);

            const eIdx = new Uint32Array(elementTokenIndexes.length);
            for (let i = 0; i < elementTokenIndexes.length; i++) eIdx[i] = (elementTokenIndexes[i] | 0) >>> 0;
            const compE = usdIntegerCompressU32(eIdx);
            w.writeBigUint64(BigInt(compE.length));
            w.writeBytes(compE);

            const jIdx = new Uint32Array(jumps.length);
            for (let i = 0; i < jumps.length; i++) jIdx[i] = (jumps[i] | 0) >>> 0;
            const compJ = usdIntegerCompressU32(jIdx);
            w.writeBigUint64(BigInt(compJ.length));
            w.writeBytes(compJ);
        } else {
            w.writeBigUint64(0n);
            for (const x of pathIndexes) w.writeUint32(x >>> 0);

            w.writeBigUint64(0n);
            for (const x of elementTokenIndexes) w.writeInt32(x | 0);

            w.writeBigUint64(0n);
            for (const x of jumps) w.writeInt32(x | 0);
        }

        sections.push({ name: 'PATHS', bytes: w.toUint8Array() });
    }

    // SPECS section: count + (optional) integer-compressed arrays
    {
        const w = new ByteWriter();
        w.writeBigUint64(BigInt(specs.length));

        if (compress) {
            const a = new Uint32Array(specs.length);
            const b = new Uint32Array(specs.length);
            const c = new Uint32Array(specs.length);
            for (let i = 0; i < specs.length; i++) {
                const s = specs[i]!;
                a[i] = s.pathIndex >>> 0;
                b[i] = s.fieldSetIndex >>> 0;
                c[i] = s.specType >>> 0;
            }
            const compA = usdIntegerCompressU32(a);
            const compB = usdIntegerCompressU32(b);
            const compC = usdIntegerCompressU32(c);
            w.writeBigUint64(BigInt(compA.length));
            w.writeBytes(compA);
            w.writeBigUint64(BigInt(compB.length));
            w.writeBytes(compB);
            w.writeBigUint64(BigInt(compC.length));
            w.writeBytes(compC);
        } else {
            w.writeBigUint64(0n);
            for (const s of specs) w.writeUint32(s.pathIndex >>> 0);

            w.writeBigUint64(0n);
            for (const s of specs) w.writeUint32(s.fieldSetIndex >>> 0);

            w.writeBigUint64(0n);
            for (const s of specs) w.writeUint32(s.specType >>> 0);
        }

        sections.push({ name: 'SPECS', bytes: w.toUint8Array() });
    }

    // Compute DATA start (absolute) and relocate all non-inlined ValueReps:
    // - in the top-level FIELDS table
    // - in any nested ValueReps stored inside the DATA region (Dictionary, TimeSamples, etc).
    const headerSize = 88;
    const sectionsSizeWithoutFields = sections.reduce((a, s) => a + s.bytes.length, 0);
    const repsBytesLen = fields.length * 8;
    // Token indices blob (compressed or raw) - used to compute stable FIELDS section size before relocation.
    const tokenIdxBlob = (() => {
        if (!compress) {
            const w = new ByteWriter();
            for (const f of fields) w.writeUint32(f.tokenIndex >>> 0);
            return w.toUint8Array();
        }
        const u = new Uint32Array(fields.length);
        for (let i = 0; i < fields.length; i++) u[i] = fields[i]!.tokenIndex >>> 0;
        return usdIntegerCompressU32(u);
    })();
    // Layout: u64 count + u64 tokenIndexCompressedSize + blob + u64 valueRepsCompressedSize(0) + repsBytes
    const fieldsSectionSize = 8 + 8 + tokenIdxBlob.length + 8 + repsBytesLen;
    const dataStartAbs = headerSize + sectionsSizeWithoutFields + fieldsSectionSize;

    const relocateValueRep = (vr: bigint): bigint => {
        const payload = vr & ((1n << 48n) - 1n);
        const type = (vr >> 48n) & 0xFFn;
        const flags = (vr >> 56n) & 0xFFn;
        const isInlined = (Number(flags) & 0x40) !== 0;
        if (isInlined) return vr;
        // ValueBlock uses payload=0; relocation is harmless but keep stable.
        const nextPayload = payload + BigInt(dataStartAbs);
        return (nextPayload & ((1n << 48n) - 1n)) | (type << 48n) | (flags << 56n);
    };

    for (const f of fields) f.valueRep = relocateValueRep(f.valueRep);
    for (const pos of dataValueRepOffsets) {
        const old = data.getBigUint64At(pos);
        const next = relocateValueRep(old);
        data.setBigUint64At(pos, next);
    }

    // FIELDS section: count + tokenIndexBlob (maybe compressed) + valueRepsBlob (optionally LZ4-compressed, padded to keep section size stable)
    {
        const w = new ByteWriter();
        w.writeBigUint64(BigInt(fields.length));

        // token indices: optionally integer-compressed
        w.writeBigUint64(compress ? BigInt(tokenIdxBlob.length) : 0n);
        w.writeBytes(tokenIdxBlob);

        // value reps: optionally LZ4-compressed with USD 1-byte header.
        // Important: keep the section size stable by padding to the uncompressed size.
        const repsBytesLen = fields.length * 8;
        const repsBytes = new Uint8Array(repsBytesLen);
        const repsView = new DataView(repsBytes.buffer);
        for (let i = 0; i < fields.length; i++) {
            repsView.setBigUint64(i * 8, fields[i]!.valueRep, true);
        }
        const repsComp = compress ? lz4WithUsdHeader(repsBytes) : null;
        const useComp = !!repsComp && repsComp.length > 0 && repsComp.length < repsBytesLen;
        w.writeBigUint64(useComp ? BigInt(repsComp.length) : 0n);
        if (useComp) {
            w.writeBytes(repsComp);
            w.writeZeros(repsBytesLen - repsComp.length);
        } else {
            w.writeBytes(repsBytes);
        }

        // Insert FIELDS in canonical order after STRINGS (matches parser read order).
        const insertAt = sections.findIndex((s) => s.name === 'STRINGS');
        if (insertAt === -1) sections.unshift({ name: 'FIELDS', bytes: w.toUint8Array() });
        else sections.splice(insertAt + 1, 0, { name: 'FIELDS', bytes: w.toUint8Array() });
    }

    // Compose final file: header + sections + DATA + TOC.
    const file = new ByteWriter();

    // Header (88 bytes)
    file.writeFixedString('PXR-USDC', 8);
    file.writeUint8(version.major);
    file.writeUint8(version.minor);
    file.writeUint8(version.patch);
    file.writeZeros(5); // reserved version bytes
    const tocOffsetPos = file.length;
    file.writeBigUint64(0n); // patched later
    file.writeZeros(64); // reserved
    if (file.length !== 88) throw new Error(`Internal error: header size=${file.length}, expected 88`);
    void tocOffsetPos;

    // Write sections and record their offsets for TOC.
    const tocEntries: Array<{ name: string; start: number; size: number }> = [];
    for (const s of sections) {
        const start = file.length;
        file.writeBytes(s.bytes);
        const end = file.length;
        tocEntries.push({ name: s.name, start, size: end - start });
    }

    // DATA region (payloads referenced by ValueReps)
    const dataStart = file.length;
    file.writeBytes(data.toUint8Array());
    void dataStart;

    // TOC
    const tocOffset = file.length;
    const toc = new ByteWriter();
    toc.writeBigUint64(BigInt(tocEntries.length));
    for (const e of tocEntries) {
        toc.writeFixedString(e.name, 16);
        toc.writeBigUint64(BigInt(e.start));
        toc.writeBigUint64(BigInt(e.size));
    }
    file.writeBytes(toc.toUint8Array());

    // Patch header's TOC offset
    // (We can't easily "seek" in ByteWriter; patch via view on final buffer.)
    const out = file.toUint8Array();
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    dv.setBigUint64(16, BigInt(tocOffset), true);

    return out;
}


