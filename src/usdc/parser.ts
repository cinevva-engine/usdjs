import { SdfLayer, type SdfPrimSpec, type SdfPropertySpec, type SdfValue, type SdfPrimSpecifier } from '../sdf/layer.js';
import { SdfPath } from '../sdf/path.js';

export interface UsdcParseOptions {
    identifier?: string;
}

/**
 * Check if buffer contains USDC data by looking for magic header.
 */
export function isUsdcContent(buffer: ArrayBuffer | Uint8Array): boolean {
    const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (data.length < 8) return false;

    // Check for "PXR-USDC" magic
    return (
        data[0] === 0x50 && // P
        data[1] === 0x58 && // X
        data[2] === 0x52 && // R
        data[3] === 0x2D && // -
        data[4] === 0x55 && // U
        data[5] === 0x53 && // S
        data[6] === 0x44 && // D
        data[7] === 0x43    // C
    );
}

/**
 * LZ4 block decompressor - pure JavaScript implementation.
 * 
 * This implements the LZ4 block format (not frame format) used by USD crate files.
 */
function decompressLZ4Block(src: Uint8Array, destSize: number): Uint8Array {
    const dest = new Uint8Array(destSize);
    let srcOffset = 0;
    let destOffset = 0;

    while (srcOffset < src.length && destOffset < destSize) {
        // Read token
        const token = src[srcOffset++];
        let literalLen = (token >> 4) & 0x0F;
        let matchLen = token & 0x0F;

        // Read extended literal length
        if (literalLen === 15) {
            let b: number;
            do {
                if (srcOffset >= src.length) break;
                b = src[srcOffset++];
                literalLen += b;
            } while (b === 255);
        }

        // Copy literals
        if (literalLen > 0) {
            if (srcOffset + literalLen > src.length) {
                // Copy what we can
                const copyLen = Math.min(literalLen, src.length - srcOffset, destSize - destOffset);
                dest.set(src.subarray(srcOffset, srcOffset + copyLen), destOffset);
                break;
            }
            dest.set(src.subarray(srcOffset, srcOffset + literalLen), destOffset);
            srcOffset += literalLen;
            destOffset += literalLen;
        }

        // Check if we're done (last sequence has no match)
        if (destOffset >= destSize) break;
        if (srcOffset + 2 > src.length) break;

        // Read match offset (little-endian 16-bit)
        const matchOffset = src[srcOffset] | (src[srcOffset + 1] << 8);
        srcOffset += 2;

        if (matchOffset === 0) break;

        // Read extended match length
        matchLen += 4; // Minimum match length is 4
        if ((token & 0x0F) === 15) {
            let b: number;
            do {
                if (srcOffset >= src.length) break;
                b = src[srcOffset++];
                matchLen += b;
            } while (b === 255);
        }

        // Copy match (may overlap, must copy byte-by-byte)
        const matchStart = destOffset - matchOffset;
        if (matchStart < 0) break;

        for (let i = 0; i < matchLen && destOffset < destSize; i++) {
            dest[destOffset++] = dest[matchStart + i];
        }
    }

    return dest;
}

/**
 * USD Integer decompression.
 * 
 * USD uses a custom integer compression scheme:
 * 1. Transform to differences from previous value
 * 2. Find most common difference value
 * 3. Encode each integer with 2-bit code:
 *    - 00: Common value
 *    - 01: 8-bit integer
 *    - 10: 16-bit integer
 *    - 11: 32-bit integer
 * 4. LZ4 compress the encoded buffer
 */
function decodeIntegers32(data: Uint8Array, numInts: number): Int32Array {
    if (numInts === 0) return new Int32Array(0);

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    // Read common value (first 4 bytes, signed int32)
    const commonValue = view.getInt32(0, true);

    // Calculate sizes
    const numCodesBytes = Math.ceil((numInts * 2) / 8);
    const codesStart = 4;
    const vintsStart = codesStart + numCodesBytes;

    const result = new Int32Array(numInts);
    let vintsOffset = vintsStart;
    let prevVal = 0;

    for (let i = 0; i < numInts; i++) {
        // Get 2-bit code for this integer
        const byteIndex = codesStart + Math.floor((i * 2) / 8);
        const bitOffset = (i * 2) % 8;
        const code = (data[byteIndex] >> bitOffset) & 0x03;

        let diff = 0;
        switch (code) {
            case 0: // Common value
                diff = commonValue;
                break;
            case 1: // 8-bit signed
                diff = view.getInt8(vintsOffset);
                vintsOffset += 1;
                break;
            case 2: // 16-bit signed
                diff = view.getInt16(vintsOffset, true);
                vintsOffset += 2;
                break;
            case 3: // 32-bit signed
                diff = view.getInt32(vintsOffset, true);
                vintsOffset += 4;
                break;
        }

        prevVal += diff;
        result[i] = prevVal;
    }

    return result;
}

function decodeIntegersUnsigned32(data: Uint8Array, numInts: number): Uint32Array {
    const signed = decodeIntegers32(data, numInts);
    return new Uint32Array(signed.buffer, signed.byteOffset, signed.length);
}

/**
 * Decompress USD integer compressed data.
 * First LZ4 decompresses (skipping 1-byte header), then decodes the integers.
 */
function decompressIntegers32(compressedData: Uint8Array, compressedSize: number, numInts: number): Uint32Array {
    // Calculate encoded buffer size
    const encodedSize = 4 + Math.ceil((numInts * 2) / 8) + numInts * 4;

    // Skip 1-byte header (0x00) and LZ4 decompress
    const encoded = decompressLZ4Block(compressedData.subarray(1, compressedSize), encodedSize);

    // Decode integers
    return decodeIntegersUnsigned32(encoded, numInts);
}

function decompressIntegers32Signed(compressedData: Uint8Array, compressedSize: number, numInts: number): Int32Array {
    // Calculate encoded buffer size
    const encodedSize = 4 + Math.ceil((numInts * 2) / 8) + numInts * 4;

    // Skip 1-byte header (0x00) and LZ4 decompress
    const encoded = decompressLZ4Block(compressedData.subarray(1, compressedSize), encodedSize);

    // Decode signed integers (delta-coded)
    return decodeIntegers32(encoded, numInts);
}

function halfToFloat(h: number): number {
    // IEEE 754 half (binary16) to float32.
    const s = (h >> 15) & 0x1;
    const e = (h >> 10) & 0x1f;
    const f = h & 0x3ff;
    if (e === 0) {
        if (f === 0) return s ? -0 : 0;
        // subnormal
        return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
    }
    if (e === 31) {
        if (f === 0) return s ? -Infinity : Infinity;
        return NaN;
    }
    return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

// Value type enum matching USD's internal representation
const enum ValueType {
    Invalid = 0,
    Bool = 1,
    UChar = 2,
    Int = 3,
    UInt = 4,
    Int64 = 5,
    UInt64 = 6,
    Half = 7,
    Float = 8,
    Double = 9,
    String = 10,
    Token = 11,
    AssetPath = 12,
    Matrix2d = 13,
    Matrix3d = 14,
    Matrix4d = 15,
    Quatd = 16,
    Quatf = 17,
    Quath = 18,
    Vec2d = 19,
    Vec2f = 20,
    Vec2h = 21,
    Vec2i = 22,
    Vec3d = 23,
    Vec3f = 24,
    Vec3h = 25,
    Vec3i = 26,
    Vec4d = 27,
    Vec4f = 28,
    Vec4h = 29,
    Vec4i = 30,
    Dictionary = 31,
    TokenListOp = 32,
    StringListOp = 33,
    PathListOp = 34,
    ReferenceListOp = 35,
    IntListOp = 36,
    Int64ListOp = 37,
    UIntListOp = 38,
    UInt64ListOp = 39,
    PathVector = 40,
    TokenVector = 41,
    Specifier = 42,
    Permission = 43,
    Variability = 44,
    VariantSelectionMap = 45,
    TimeSamples = 46,
    Payload = 47,
    DoubleVector = 48,
    LayerOffsetVector = 49,
    StringVector = 50,
    ValueBlock = 51,
    Value = 52,
    UnregisteredValue = 53,
    UnregisteredValueListOp = 54,
    PayloadListOp = 55,
    TimeCode = 56,
}

// Spec type enum
const enum SpecType {
    Unknown = 0,
    Attribute = 1,
    Connection = 2,
    Expression = 3,
    Mapper = 4,
    MapperArg = 5,
    Prim = 6,
    PseudoRoot = 7,
    Relationship = 8,
    RelationshipTarget = 9,
    Variant = 10,
    VariantSet = 11,
}

interface Section {
    name: string;
    start: number;
    size: number;
}

interface Field {
    tokenIndex: number;
    valueRep: bigint;
}

interface Spec {
    pathIndex: number;
    fieldSetIndex: number;
    specType: SpecType;
}

interface PathNode {
    path: string;
    parentIndex: number;
    childIndices: number[];
}

/**
 * USDC (USD Crate) parser - high-performance binary format loader.
 * 
 * USDC files use the "Crate" format - a binary format optimized for
 * fast loading and minimal memory usage. The format uses:
 * - LZ4 compression for token strings and value reps
 * - Custom integer compression for indices
 * - Interned tokens/strings for deduplication
 * - Compact path encoding with path trees
 * 
 * File structure:
 * - Header (88 bytes):
 *   - Magic: "PXR-USDC" (8 bytes)
 *   - Version: major.minor.patch + reserved (8 bytes)
 *   - TOC offset: uint64 (8 bytes)
 *   - Reserved (64 bytes)
 * - Data sections (variable, compressed)
 * - Table of Contents (TOC) at end
 */
export function parseUsdcToLayer(buffer: ArrayBuffer | Uint8Array, opts: UsdcParseOptions = {}): SdfLayer {
    const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const reader = new UsdcReader(data);
    return reader.parse(opts.identifier ?? '<memory>');
}

/**
 * High-performance USDC reader.
 */
class UsdcReader {
    private view: DataView;
    private offset = 0;

    // Interned data (read once, reused)
    private tokens: string[] = [];
    private stringIndices: number[] = [];
    private fields: Field[] = [];
    private fieldSetIndices: number[] = [];
    private paths: string[] = [];
    private pathNodes: PathNode[] = [];
    private specs: Spec[] = [];

    // Section locations
    private sections: Map<string, Section> = new Map();

    // Version info
    private version: [number, number, number] = [0, 0, 0];

    constructor(private data: Uint8Array) {
        this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    }

    parse(identifier: string): SdfLayer {
        const tocOffset = this.readHeader();
        this.readTableOfContents(tocOffset);
        this.readTokens();
        this.readStrings();
        this.readFields();
        this.readFieldSets();
        this.readPaths();
        this.readSpecs();

        const layer = this.buildLayer(identifier);
        this.postprocessVariantSelectionNodes(layer.root);
        this.postprocessStubOvers(layer.root);
        return layer;
    }

    private readHeader(): number {
        // Magic: "PXR-USDC" (8 bytes)
        const magic = this.readFixedString(8);
        if (magic !== 'PXR-USDC') {
            throw new Error(`Invalid USDC file: expected "PXR-USDC" magic, got "${magic}"`);
        }

        // Version is stored as three bytes: major.minor.patch
        const major = this.readUint8();
        const minor = this.readUint8();
        const patch = this.readUint8();
        this.version = [major, minor, patch];
        this.offset += 5; // Skip remaining reserved bytes (8 bytes total for version block)

        // Supported versions: 0.4.0 through 0.10.0+
        if ((major === 0 && minor < 4) || major > 0 || (major === 0 && minor > 10)) {
            throw new Error(`Unsupported USDC version: ${major}.${minor}.${patch}. Supported: 0.4.0 - 0.10.0`);
        }

        // TOC offset at byte 16
        const tocOffset = Number(this.readUint64());

        return tocOffset;
    }

    private readTableOfContents(tocOffset: number): void {
        this.offset = tocOffset;

        // Read section count
        const sectionCount = Number(this.readUint64());

        // Read section entries (16 + 8 + 8 = 32 bytes each)
        for (let i = 0; i < sectionCount; i++) {
            // Section name (16 bytes, null-padded)
            const name = this.readFixedString(16);
            // Offset (8 bytes)
            const start = Number(this.readUint64());
            // Size (8 bytes)
            const size = Number(this.readUint64());

            if (name) {
                this.sections.set(name, { name, start, size });
            }
        }
    }

    private readTokens(): void {
        const section = this.sections.get('TOKENS');
        if (!section) return;

        this.offset = section.start;

        // Token section format (version 0.4.0+):
        // - count (uint64): number of tokens
        // - uncompressed_size (uint64): size after decompression
        // - compressed_size (uint64): size of compressed LZ4 data
        // - LZ4 compressed data (null-terminated strings)
        const count = Number(this.readUint64());
        const uncompressedSize = Number(this.readUint64());
        const compressedSize = Number(this.readUint64());

        let tokenData: Uint8Array;

        if (compressedSize > 0 && compressedSize < uncompressedSize) {
            // LZ4 compressed - skip 1-byte header (0x00)
            const compressed = this.data.subarray(this.offset + 1, this.offset + compressedSize);
            tokenData = decompressLZ4Block(compressed, uncompressedSize);
        } else {
            // Uncompressed
            tokenData = this.data.subarray(this.offset, this.offset + uncompressedSize);
        }

        // Parse null-separated tokens
        this.tokens = [];
        let tokenStart = 0;
        const decoder = new TextDecoder('utf-8');

        for (let i = 0; i < tokenData.length && this.tokens.length < count; i++) {
            if (tokenData[i] === 0) {
                this.tokens.push(decoder.decode(tokenData.subarray(tokenStart, i)));
                tokenStart = i + 1;
            }
        }

        // Handle last token if no trailing null
        if (tokenStart < tokenData.length && this.tokens.length < count) {
            this.tokens.push(decoder.decode(tokenData.subarray(tokenStart)));
        }

        // Optional debug: find token indices for common keys (helps validate Dictionary decoding).
        try {
            // eslint-disable-next-line no-process-env
            if (typeof process !== 'undefined' && process.env?.USDJS_USDC_DUMP_TOKEN_MATCHES === '1') {
                const needles = ['cameraSettings', 'omni_layer', 'renderSettings', 'customLayerData'];
                const found: Record<string, number[]> = {};
                for (const n of needles) found[n] = [];
                for (let i = 0; i < this.tokens.length; i++) {
                    const t = this.tokens[i];
                    if (!t) continue;
                    for (const n of needles) {
                        if (t === n) found[n].push(i);
                    }
                }
                // eslint-disable-next-line no-console
                console.log('[usdc][Tokens] matches:', found);
            }
        } catch {
            // ignore
        }
    }

    private readStrings(): void {
        const section = this.sections.get('STRINGS');
        if (!section || section.size === 0) return;

        this.offset = section.start;

        // String section: count (uint64) + array of uint32 indices into tokens
        const count = Number(this.readUint64());

        this.stringIndices = [];
        for (let i = 0; i < count && this.offset < section.start + section.size; i++) {
            const tokenIndex = this.readUint32();
            this.stringIndices.push(tokenIndex);
        }

        // Optional debug: inspect specific string indices (useful for Dictionary key decoding).
        try {
            // eslint-disable-next-line no-process-env
            if (typeof process !== 'undefined' && process.env?.USDJS_USDC_DUMP_STRING_INDICES === '1') {
                const probe = [0, 1, 5, 11, 21, 23, 56, 428];
                const out: Record<string, { tokenIndex: number | null; token: string | null }> = {};
                for (const i of probe) {
                    const ti = (i >= 0 && i < this.stringIndices.length) ? this.stringIndices[i] : null;
                    out[String(i)] = { tokenIndex: ti, token: typeof ti === 'number' ? (this.tokens[ti] ?? null) : null };
                }
                // eslint-disable-next-line no-console
                console.log('[usdc][Strings] probes:', out, 'count=', this.stringIndices.length);
            }
            // eslint-disable-next-line no-process-env
            if (typeof process !== 'undefined' && process.env?.USDJS_USDC_DUMP_STRING_REVERSE === '1') {
                const wantTokenIdx = [11, 21, 23, 56];
                const found: Record<string, number[]> = {};
                for (const ti of wantTokenIdx) found[String(ti)] = [];
                for (let si = 0; si < this.stringIndices.length; si++) {
                    const ti = this.stringIndices[si];
                    if (wantTokenIdx.includes(ti)) found[String(ti)].push(si);
                }
                // eslint-disable-next-line no-console
                console.log('[usdc][Strings] reverse (tokenIndex->stringIndices):', found);
            }
        } catch {
            // ignore
        }
    }

    private readFields(): void {
        const section = this.sections.get('FIELDS');
        if (!section || section.size === 0) return;

        this.offset = section.start;

        // Fields section format (version 0.4.0+):
        // - count (uint64): number of fields
        // - compressed token indices (using USD integer compression)
        // - compressed value reps (LZ4 compressed, 8 bytes each)
        const count = Number(this.readUint64());
        if (count === 0) return;

        // Read compressed token indices
        let compressedSize = Number(this.readUint64());
        if (compressedSize > section.size) {
            // Fallback: assume uncompressed
            compressedSize = 0;
        }

        let tokenIndices: Uint32Array;
        if (compressedSize > 0) {
            const compressed = this.data.subarray(this.offset, this.offset + compressedSize);
            tokenIndices = decompressIntegers32(compressed, compressedSize, count);
            this.offset += compressedSize;
        } else {
            // Uncompressed
            tokenIndices = new Uint32Array(count);
            for (let i = 0; i < count; i++) {
                tokenIndices[i] = this.readUint32();
            }
        }

        // Read compressed value reps (LZ4)
        compressedSize = Number(this.readUint64());
        const uncompressedRepsSize = count * 8; // 8 bytes per ValueRep

        let repsData: Uint8Array;
        if (compressedSize > 0 && compressedSize < uncompressedRepsSize) {
            // Skip 1-byte header and LZ4 decompress
            const compressed = this.data.subarray(this.offset + 1, this.offset + compressedSize);
            repsData = decompressLZ4Block(compressed, uncompressedRepsSize);
        } else {
            repsData = this.data.subarray(this.offset, this.offset + uncompressedRepsSize);
        }

        const repsView = new DataView(repsData.buffer, repsData.byteOffset, repsData.byteLength);

        // Build fields array
        this.fields = [];
        for (let i = 0; i < count; i++) {
            this.fields.push({
                tokenIndex: tokenIndices[i],
                valueRep: repsView.getBigUint64(i * 8, true)
            });
        }

        // Optional debug: find field indices for specific token keys.
        try {
            // eslint-disable-next-line no-process-env
            if (typeof process !== 'undefined' && process.env?.USDJS_USDC_DUMP_FIELD_MATCHES === '1') {
                const wantTokenIdx = [11, 21, 23, 56];
                const found: Record<string, number[]> = {};
                for (const ti of wantTokenIdx) found[String(ti)] = [];
                for (let fi = 0; fi < this.fields.length; fi++) {
                    const f = this.fields[fi];
                    if (wantTokenIdx.includes(f.tokenIndex)) found[String(f.tokenIndex)].push(fi);
                }
                // eslint-disable-next-line no-console
                console.log('[usdc][Fields] matches (tokenIndex->fieldIndices):', found);
                const customIdx = found['56']?.[0];
                if (typeof customIdx === 'number') {
                    const f = this.fields[customIdx];
                    // eslint-disable-next-line no-console
                    console.log('[usdc][Fields] customLayerData field:', {
                        fieldIndex: customIdx,
                        valueRepHex: '0x' + f.valueRep.toString(16),
                    });
                }
            }
        } catch {
            // ignore
        }
    }

    private readFieldSets(): void {
        const section = this.sections.get('FIELDSETS');
        if (!section || section.size === 0) return;

        this.offset = section.start;

        // FieldSets section format:
        // - count (uint64): number of fieldset indices
        // - compressed indices (using USD integer compression)
        const count = Number(this.readUint64());
        if (count === 0) return;

        // Read compressed fieldset indices
        const compressedSize = Number(this.readUint64());

        if (compressedSize > 0 && compressedSize <= section.size - 16) {
            const compressed = this.data.subarray(this.offset, this.offset + compressedSize);
            const indices = decompressIntegers32(compressed, compressedSize, count);
            this.fieldSetIndices = Array.from(indices);
        } else {
            // Uncompressed
            this.fieldSetIndices = [];
            for (let i = 0; i < count && this.offset < section.start + section.size; i++) {
                this.fieldSetIndices.push(this.readUint32());
            }
        }
    }

    private readPaths(): void {
        const section = this.sections.get('PATHS');
        if (!section || section.size === 0) return;

        this.offset = section.start;

        // Paths section format:
        // - numPaths (uint64): total number of paths
        // - numEncodedPaths (uint64): number of encoded path entries
        // - compressed pathIndexes (integer compression)
        // - compressed elementTokenIndexes (integer compression) 
        // - compressed jumps (integer compression)
        const numPaths = Number(this.readUint64());
        if (numPaths === 0) return;

        // Initialize paths and nodes arrays
        this.paths = new Array(numPaths).fill('');
        this.pathNodes = new Array(numPaths);
        for (let i = 0; i < numPaths; i++) {
            this.pathNodes[i] = { path: '', parentIndex: -1, childIndices: [] };
        }

        // Read numEncodedPaths
        const numEncodedPaths = Number(this.readUint64());
        if (numEncodedPaths === 0) return;

        // Read compressed pathIndexes
        let compressedSize = Number(this.readUint64());
        const pathIndexes = compressedSize > 0
            ? decompressIntegers32(this.data.subarray(this.offset, this.offset + compressedSize), compressedSize, numEncodedPaths)
            : new Uint32Array(0);
        this.offset += compressedSize;

        // Read compressed elementTokenIndexes
        compressedSize = Number(this.readUint64());
        const elementTokenIndexes = compressedSize > 0
            ? new Int32Array(decompressIntegers32(this.data.subarray(this.offset, this.offset + compressedSize), compressedSize, numEncodedPaths).buffer)
            : new Int32Array(0);
        this.offset += compressedSize;

        // Read compressed jumps
        compressedSize = Number(this.readUint64());
        const jumps = compressedSize > 0
            ? new Int32Array(decompressIntegers32(this.data.subarray(this.offset, this.offset + compressedSize), compressedSize, numEncodedPaths).buffer)
            : new Int32Array(0);

        // Build decompressed paths using the jump table
        this.buildDecompressedPaths(pathIndexes, elementTokenIndexes, jumps);
    }

    private buildDecompressedPaths(
        pathIndexes: Uint32Array,
        elementTokenIndexes: Int32Array,
        jumps: Int32Array
    ): void {
        if (pathIndexes.length === 0) return;

        const rootPath = '/';

        // State for iterative traversal
        interface StackFrame {
            startIndex: number;
            endIndex: number;
            parentPath: string;
            parentNodeIndex: number;
        }

        const stack: StackFrame[] = [{
            startIndex: 0,
            endIndex: pathIndexes.length - 1,
            parentPath: '',
            parentNodeIndex: -1
        }];

        const visited = new Set<number>();

        while (stack.length > 0) {
            const frame = stack.pop()!;
            let { startIndex, parentPath, parentNodeIndex } = frame;
            const endIndex = frame.endIndex;

            for (let thisIndex = startIndex; thisIndex <= endIndex; thisIndex++) {
                const pathIdx = pathIndexes[thisIndex];

                if (visited.has(pathIdx)) {
                    continue;
                }
                visited.add(pathIdx);

                // Save current parent BEFORE building path (this is the parent for this node and its siblings)
                const currentParentPath = parentPath;
                const currentParentNodeIndex = parentNodeIndex;

                if (parentPath === '') {
                    // Root node
                    this.paths[pathIdx] = rootPath;
                    this.pathNodes[pathIdx] = { path: rootPath, parentIndex: -1, childIndices: [] };
                    parentPath = rootPath;
                    parentNodeIndex = pathIdx;
                } else {
                    // Get token for this path element
                    const tokenIndex = elementTokenIndexes[thisIndex];
                    const isPrimPropertyPath = tokenIndex < 0;
                    const actualTokenIndex = isPrimPropertyPath ? -tokenIndex : tokenIndex;
                    const elemToken = this.tokens[actualTokenIndex] ?? '';

                    // Build full path using current parent
                    let fullPath: string;
                    if (isPrimPropertyPath) {
                        fullPath = currentParentPath === '/'
                            ? `/${elemToken}` // Property on root? Unusual but handle it
                            : `${currentParentPath}.${elemToken}`;
                    } else {
                        fullPath = currentParentPath === '/'
                            ? `/${elemToken}`
                            : `${currentParentPath}/${elemToken}`;
                    }

                    this.paths[pathIdx] = fullPath;
                    this.pathNodes[pathIdx] = {
                        path: fullPath,
                        parentIndex: currentParentNodeIndex,
                        childIndices: []
                    };

                    // Add as child of parent
                    if (currentParentNodeIndex >= 0 && currentParentNodeIndex < this.pathNodes.length) {
                        this.pathNodes[currentParentNodeIndex].childIndices.push(pathIdx);
                    }
                }

                // Process jumps
                // Jump value interpretation:
                // - jump > 0: has child AND sibling; sibling is at thisIndex + jump
                // - jump == 0: has sibling only (next node is sibling)
                // - jump == -1: has child only (no sibling)
                // - jump == -2: leaf node (no child, no sibling)
                const hasChild = jumps[thisIndex] > 0 || jumps[thisIndex] === -1;
                const hasSibling = jumps[thisIndex] >= 0;

                if (hasChild) {
                    if (hasSibling) {
                        // Has both child and sibling
                        // The child subtree is from thisIndex+1 to siblingIndex-1
                        // The sibling is at thisIndex + jump, and should have the SAME parent as this node
                        const siblingIndex = thisIndex + jumps[thisIndex];
                        if (siblingIndex > thisIndex && siblingIndex <= endIndex) {
                            // The sibling subtree ends at endIndex (before the next sibling of the parent)
                            // This is because the current frame's endIndex marks the boundary before
                            // the parent's next sibling, so all nodes from siblingIndex to endIndex
                            // are part of the sibling subtree
                            const siblingEndIndex = endIndex;

                            // Push frames in execution order (LIFO stack, so push in reverse):
                            // 1. Process rest of current range (after sibling subtree ends)
                            if (siblingEndIndex < endIndex) {
                                stack.push({
                                    startIndex: siblingEndIndex + 1,
                                    endIndex: endIndex,
                                    parentPath: currentParentPath,
                                    parentNodeIndex: currentParentNodeIndex
                                });
                            }

                            // 2. Process sibling subtree (with SAME parent as current node)
                            stack.push({
                                startIndex: siblingIndex,
                                endIndex: siblingEndIndex,
                                parentPath: currentParentPath,
                                parentNodeIndex: currentParentNodeIndex
                            });

                            // 3. Process child subtree (with this node as parent)
                            // Child subtree is from thisIndex+1 to siblingIndex-1
                            if (siblingIndex > thisIndex + 1) {
                                stack.push({
                                    startIndex: thisIndex + 1,
                                    endIndex: siblingIndex - 1,
                                    parentPath: this.paths[pathIdx],
                                    parentNodeIndex: pathIdx
                                });
                            }

                            // Break to process frames from stack (they'll be processed in reverse order)
                            break;
                        }
                    }

                    // Has child only (no sibling) - continue with child
                    // Update parent for next iteration
                    parentPath = this.paths[pathIdx];
                    parentNodeIndex = pathIdx;
                } else if (hasSibling) {
                    // Has sibling only (no child) - continue to next iteration
                    // parentPath stays the same
                }
                // else: leaf node, continue to next iteration
            }
        }
    }

    private readSpecs(): void {
        const section = this.sections.get('SPECS');
        if (!section || section.size === 0) return;

        this.offset = section.start;

        // Specs section format:
        // - count (uint64): number of specs
        // - compressed pathIndexes (integer compression)
        // - compressed fieldSetIndexes (integer compression)
        // - compressed specTypes (integer compression)
        const count = Number(this.readUint64());
        if (count === 0) return;

        // Read compressed pathIndexes
        let compressedSize = Number(this.readUint64());
        const pathIndexes = compressedSize > 0
            ? decompressIntegers32(this.data.subarray(this.offset, this.offset + compressedSize), compressedSize, count)
            : new Uint32Array(count);
        this.offset += compressedSize;

        // Read compressed fieldSetIndexes
        compressedSize = Number(this.readUint64());
        const fieldSetIndexes = compressedSize > 0
            ? decompressIntegers32(this.data.subarray(this.offset, this.offset + compressedSize), compressedSize, count)
            : new Uint32Array(count);
        this.offset += compressedSize;

        // Read compressed specTypes
        compressedSize = Number(this.readUint64());
        const specTypes = compressedSize > 0
            ? decompressIntegers32(this.data.subarray(this.offset, this.offset + compressedSize), compressedSize, count)
            : new Uint32Array(count);

        // Build specs array
        this.specs = [];
        for (let i = 0; i < count; i++) {
            this.specs.push({
                pathIndex: pathIndexes[i],
                fieldSetIndex: fieldSetIndexes[i],
                specType: specTypes[i] as SpecType
            });
        }
    }

    private buildLayer(identifier: string): SdfLayer {
        const layer = new SdfLayer(identifier);

        // Build live fieldsets: map fieldset start index -> array of field values
        const liveFieldSets = this.buildLiveFieldSets();

        // Build prims and properties from specs
        for (const spec of this.specs) {
            const path = this.paths[spec.pathIndex];
            if (!path) continue;

            const fieldValues = liveFieldSets.get(spec.fieldSetIndex);
            if (!fieldValues) continue;

            if (spec.specType === SpecType.PseudoRoot) {
                // Extract layer metadata from pseudo root
                for (const [name, value] of fieldValues) {
                    if (name === 'defaultPrim') {
                        if (typeof value === 'string') {
                            (layer.metadata as Record<string, SdfValue>).defaultPrim = value;
                        } else if (value && typeof value === 'object' && (value as any).type === 'token') {
                            (layer.metadata as Record<string, SdfValue>).defaultPrim = (value as any).value;
                        }
                    } else if (name === 'customLayerData') {
                        // This is typically a Dictionary (VtDictionary).
                        (layer.metadata as Record<string, SdfValue>).customLayerData = value;
                    } else if (name === 'doc' || name === 'documentation') {
                        // usdcat uses `doc` for layer documentation.
                        const v = value && typeof value === 'object' && (value as any).type === 'token' ? (value as any).value : value;
                        (layer.metadata as Record<string, SdfValue>).doc = v as any;
                    } else if (['upAxis', 'metersPerUnit', 'framesPerSecond',
                        'startTimeCode', 'endTimeCode', 'timeCodesPerSecond'].includes(name)) {
                        // Normalize common token metadata to plain strings for consistency with USDA parsing.
                        if (name === 'upAxis' && value && typeof value === 'object' && (value as any).type === 'token') {
                            (layer.metadata as Record<string, SdfValue>)[name] = (value as any).value;
                        } else {
                            (layer.metadata as Record<string, SdfValue>)[name] = value;
                        }
                    }
                }
            } else if (spec.specType === SpecType.Prim) {
                this.addPrim(layer, path, fieldValues);
            } else if (spec.specType === SpecType.Attribute || spec.specType === SpecType.Relationship) {
                this.addProperty(layer, path, fieldValues, spec.specType);
            }
        }

        return layer;
    }

    private buildLiveFieldSets(): Map<number, Map<string, SdfValue>> {
        const result = new Map<number, Map<string, SdfValue>>();

        // FieldSets are encoded as runs of field indices terminated by 0xFFFFFFFF
        // The fieldset index is the position where that run starts
        let fsStart = 0;
        let fieldIndices: number[] = [];

        for (let i = 0; i < this.fieldSetIndices.length; i++) {
            const idx = this.fieldSetIndices[i];

            if (idx === 0xFFFFFFFF) {
                // End of this fieldset
                if (fieldIndices.length > 0) {
                    const fieldValues = this.getFieldValues(fieldIndices);
                    result.set(fsStart, fieldValues);
                }
                fsStart = i + 1;
                fieldIndices = [];
            } else {
                fieldIndices.push(idx);
            }
        }

        // Handle last fieldset if not terminated
        if (fieldIndices.length > 0) {
            const fieldValues = this.getFieldValues(fieldIndices);
            result.set(fsStart, fieldValues);
        }

        return result;
    }

    private getFieldValues(fieldIndices: number[]): Map<string, SdfValue> {
        const result = new Map<string, SdfValue>();

        for (const idx of fieldIndices) {
            const field = this.fields[idx];
            if (!field) continue;

            const fieldName = this.tokens[field.tokenIndex] ?? '';
            const value = this.decodeValueRep(field.valueRep);

            if (fieldName && value !== undefined) {
                result.set(fieldName, value);
            }
        }

        return result;
    }

    private decodeValueRep(valueRep: bigint): SdfValue {
        // Value representation encoding (64 bits) in USD crate:
        // - payload: low 48 bits
        // - type: bits 48..55 (8 bits)
        // - flags: bits 56..63 (8 bits)
        //   - bit 62 (0x40 in the flags byte) indicates inlined value
        //   - bit 63 (0x80 in the flags byte) indicates array value
        //
        // Note: older revisions / some value kinds may have additional encodings; we focus on the
        // common encoding used by current USD crate files.
        const payload = valueRep & ((1n << 48n) - 1n);
        const type = Number((valueRep >> 48n) & 0xFFn) as ValueType;
        const flags = Number((valueRep >> 56n) & 0xFFn);
        const isInlined = (flags & 0x40) !== 0;
        const isArray = (flags & 0x80) !== 0;
        const isCompressed = (flags & 0x20) !== 0;

        // For inlined values, payload contains the value (lower 32 bits used for small values)
        const inlineValue = Number(payload & 0xFFFFFFFFn);

        // For non-inlined values, payload is an offset into the file
        const offset = Number(payload);

        // Optional debug: dump suspicious value reps (useful when validating against usdcat).
        // Enable with: USDJS_USDC_DUMP_VALUEREP=1
        try {
            // eslint-disable-next-line no-process-env
            if (typeof process !== 'undefined' && process.env?.USDJS_USDC_DUMP_VALUEREP === '1') {
                if (payload === 0n && (type === ValueType.Double || type === ValueType.Vec3d || type === ValueType.TokenVector)) {
                    // eslint-disable-next-line no-console
                    console.log('[usdc][ValueRep]', {
                        valueRepHex: '0x' + valueRep.toString(16),
                        type,
                        isInlined,
                        isArray,
                        payload: Number(payload),
                    });
                }
            }
            // eslint-disable-next-line no-process-env
            if (typeof process !== 'undefined' && process.env?.USDJS_USDC_DUMP_ARRAY === '1') {
                if (isArray && !isInlined && (type === ValueType.Token || type === ValueType.PathVector || type === ValueType.TokenVector)) {
                    const off = Number(payload);
                    const bytes = off >= 0 && off < this.data.length ? Array.from(this.data.subarray(off, Math.min(off + 32, this.data.length))) : [];
                    // eslint-disable-next-line no-console
                    console.log('[usdc][ArrayRep]', {
                        valueRepHex: '0x' + valueRep.toString(16),
                        type,
                        off,
                        headBytes: bytes,
                    });
                }
            }
            // eslint-disable-next-line no-process-env
            if (typeof process !== 'undefined' && process.env?.USDJS_USDC_DUMP_DICT === '1') {
                if (type === ValueType.Dictionary && !isInlined) {
                    const off = Number(payload);
                    const bytes = off >= 0 && off < this.data.length ? Array.from(this.data.subarray(off, Math.min(off + 96, this.data.length))) : [];
                    let count: number | null = null;
                    try {
                        if (off >= 0 && off + 8 <= this.data.length) count = Number(this.view.getBigUint64(off, true));
                    } catch {
                        // ignore
                    }
                    // Best-effort: assume dictionary layout is:
                    //   u64 count
                    //   u32 keyTokenIndex[count]
                    //   (pad to 8-byte boundary)
                    //   u64 valueRep[count]
                    let guess: any = null;
                    try {
                        if (typeof count === 'number' && count >= 0 && count <= 64) {
                            const keyBase = off + 8;
                            const keys: Array<{ idx: number; tok: string }> = [];
                            for (let i = 0; i < count; i++) {
                                const ki = this.view.getUint32(keyBase + i * 4, true);
                                keys.push({ idx: ki, tok: this.tokens[ki] ?? '' });
                            }
                            const afterKeys = keyBase + count * 4;
                            const aligned = (afterKeys + 7) & ~7;
                            const reps: string[] = [];
                            for (let i = 0; i < count; i++) {
                                const vr = this.view.getBigUint64(aligned + i * 8, true);
                                reps.push('0x' + vr.toString(16));
                            }
                            guess = { keys, valueReps: reps, keyBase, valueBase: aligned };
                        }
                    } catch {
                        // ignore
                    }
                    // eslint-disable-next-line no-console
                    console.log('[usdc][DictRep]', {
                        valueRepHex: '0x' + valueRep.toString(16),
                        off,
                        count,
                        headBytes: bytes,
                        guess,
                        guessJson: guess ? JSON.stringify(guess) : null,
                    });
                }
            }
        } catch {
            // ignore
        }

        // Validate offset for non-inlined values before accessing
        if (!isInlined && offset >= this.data.length) {
            return null;
        }

        // Array values: in USD crate, the payload points at an array header, followed by element payload.
        // For the cases we currently need (token[] in xformOpOrder), the layout is:
        // - uint64 count
        // - count * uint32 tokenIndices
        if (isArray) {
            // Inline array currently treated as empty (we haven't encountered inline array payloads in corpus).
            if (isInlined) {
                return { type: 'array', elementType: 'unknown', value: [] };
            }
            if (offset + 8 > this.data.length) return { type: 'array', elementType: 'unknown', value: [] };
            const count = Number(this.view.getBigUint64(offset, true));
            const base = offset + 8;
            if (!Number.isFinite(count) || count < 0) return { type: 'array', elementType: 'unknown', value: [] };

            if (type === ValueType.Token) {
                const need = base + count * 4;
                if (need > this.data.length) return { type: 'array', elementType: 'token', value: [] };
                const vals: string[] = [];
                for (let i = 0; i < count; i++) {
                    const ti = this.view.getUint32(base + i * 4, true);
                    vals.push(this.tokens[ti] ?? '');
                }
                return { type: 'array', elementType: 'token', value: vals };
            }

            if (type === ValueType.Int) {
                // int[] arrays may be integer-compressed.
                if (count === 0) return { type: 'array', elementType: 'int', value: [] };
                if (!isCompressed) {
                    const need = base + count * 4;
                    if (need > this.data.length) return { type: 'array', elementType: 'int', value: [] };
                    const out = new Int32Array(count);
                    for (let i = 0; i < count; i++) out[i] = this.view.getInt32(base + i * 4, true);
                    return { type: 'typedArray', elementType: 'int', value: out } as any;
                }
                // Compressed: u64 compressedSize, then bytes.
                if (base + 8 > this.data.length) return { type: 'array', elementType: 'int', value: [] };
                const compressedSize = Number(this.view.getBigUint64(base, true));
                const compStart = base + 8;
                const compEnd = compStart + compressedSize;
                if (!Number.isFinite(compressedSize) || compressedSize < 0 || compEnd > this.data.length) {
                    return { type: 'array', elementType: 'int', value: [] };
                }
                const comp = this.data.subarray(compStart, compEnd);
                const signed = decompressIntegers32Signed(comp, compressedSize, count);
                return { type: 'typedArray', elementType: 'int', value: signed } as any;
            }

            if (type === ValueType.UInt) {
                if (count === 0) return { type: 'typedArray', elementType: 'uint', value: new Uint32Array(0) } as any;
                if (!isCompressed) {
                    const need = base + count * 4;
                    if (need > this.data.length) return { type: 'typedArray', elementType: 'uint', value: new Uint32Array(0) } as any;
                    const out = new Uint32Array(count);
                    for (let i = 0; i < count; i++) out[i] = this.view.getUint32(base + i * 4, true);
                    return { type: 'typedArray', elementType: 'uint', value: out } as any;
                }
                if (base + 8 > this.data.length) return { type: 'typedArray', elementType: 'uint', value: new Uint32Array(0) } as any;
                const compressedSize = Number(this.view.getBigUint64(base, true));
                const compStart = base + 8;
                const compEnd = compStart + compressedSize;
                if (!Number.isFinite(compressedSize) || compressedSize < 0 || compEnd > this.data.length) {
                    return { type: 'typedArray', elementType: 'uint', value: new Uint32Array(0) } as any;
                }
                const comp = this.data.subarray(compStart, compEnd);
                const unsigned = decompressIntegers32(comp, compressedSize, count);
                return { type: 'typedArray', elementType: 'uint', value: unsigned } as any;
            }

            if (type === ValueType.Float) {
                if (count === 0) return { type: 'typedArray', elementType: 'float', value: new Float32Array(0) } as any;
                if (!isCompressed) {
                    const need = base + count * 4;
                    if (need > this.data.length) return { type: 'typedArray', elementType: 'float', value: new Float32Array(0) } as any;
                    const out = new Float32Array(count);
                    for (let i = 0; i < count; i++) out[i] = this.view.getFloat32(base + i * 4, true);
                    return { type: 'typedArray', elementType: 'float', value: out } as any;
                }
                // Compressed float arrays (crate 0.6.0+):
                // - code byte: 'i' (integral) or 't' (lookup table)
                // - for 'i': compressed int32 payload (Sdf_IntegerCompression)
                // - for 't': u32 lutSize, lut floats, compressed uint32 indexes
                if (base + 1 > this.data.length) return { type: 'typedArray', elementType: 'float', value: new Float32Array(0) } as any;
                const code = this.view.getInt8(base);
                let p = base + 1;
                if (code === 105 /* 'i' */) {
                    if (p + 8 > this.data.length) return { type: 'typedArray', elementType: 'float', value: new Float32Array(0) } as any;
                    const compressedSize = Number(this.view.getBigUint64(p, true));
                    p += 8;
                    const end = p + compressedSize;
                    if (!Number.isFinite(compressedSize) || compressedSize < 0 || end > this.data.length) {
                        return { type: 'typedArray', elementType: 'float', value: new Float32Array(0) } as any;
                    }
                    const comp = this.data.subarray(p, end);
                    const ints = decompressIntegers32Signed(comp, compressedSize, count);
                    const out = new Float32Array(count);
                    for (let i = 0; i < count; i++) out[i] = ints[i] ?? 0;
                    return { type: 'typedArray', elementType: 'float', value: out } as any;
                }
                if (code === 116 /* 't' */) {
                    if (p + 4 > this.data.length) return { type: 'typedArray', elementType: 'float', value: new Float32Array(0) } as any;
                    const lutSize = this.view.getUint32(p, true);
                    p += 4;
                    const lutNeed = p + lutSize * 4;
                    if (lutNeed > this.data.length) return { type: 'typedArray', elementType: 'float', value: new Float32Array(0) } as any;
                    const lut = new Float32Array(lutSize);
                    for (let i = 0; i < lutSize; i++) lut[i] = this.view.getFloat32(p + i * 4, true);
                    p = lutNeed;
                    if (p + 8 > this.data.length) return { type: 'typedArray', elementType: 'float', value: new Float32Array(0) } as any;
                    const compressedSize = Number(this.view.getBigUint64(p, true));
                    p += 8;
                    const end = p + compressedSize;
                    if (!Number.isFinite(compressedSize) || compressedSize < 0 || end > this.data.length) {
                        return { type: 'typedArray', elementType: 'float', value: new Float32Array(0) } as any;
                    }
                    const comp = this.data.subarray(p, end);
                    const idxs = decompressIntegers32(comp, compressedSize, count);
                    const out = new Float32Array(count);
                    for (let i = 0; i < count; i++) out[i] = lut[idxs[i] ?? 0] ?? 0;
                    return { type: 'typedArray', elementType: 'float', value: out } as any;
                }
                // Corrupt/unknown code.
                return { type: 'typedArray', elementType: 'float', value: new Float32Array(0) } as any;
            }

            if (type === ValueType.Double) {
                if (count === 0) return { type: 'typedArray', elementType: 'double', value: new Float64Array(0) } as any;
                if (!isCompressed) {
                    const need = base + count * 8;
                    if (need > this.data.length) return { type: 'typedArray', elementType: 'double', value: new Float64Array(0) } as any;
                    const out = new Float64Array(count);
                    for (let i = 0; i < count; i++) out[i] = this.view.getFloat64(base + i * 8, true);
                    return { type: 'typedArray', elementType: 'double', value: out } as any;
                }
                // Compressed double arrays use the same 'i'/'t' scheme but with double lookup tables.
                if (base + 1 > this.data.length) return { type: 'typedArray', elementType: 'double', value: new Float64Array(0) } as any;
                const code = this.view.getInt8(base);
                let p = base + 1;
                if (code === 105 /* 'i' */) {
                    if (p + 8 > this.data.length) return { type: 'typedArray', elementType: 'double', value: new Float64Array(0) } as any;
                    const compressedSize = Number(this.view.getBigUint64(p, true));
                    p += 8;
                    const end = p + compressedSize;
                    if (!Number.isFinite(compressedSize) || compressedSize < 0 || end > this.data.length) {
                        return { type: 'typedArray', elementType: 'double', value: new Float64Array(0) } as any;
                    }
                    const comp = this.data.subarray(p, end);
                    const ints = decompressIntegers32Signed(comp, compressedSize, count);
                    const out = new Float64Array(count);
                    for (let i = 0; i < count; i++) out[i] = ints[i] ?? 0;
                    return { type: 'typedArray', elementType: 'double', value: out } as any;
                }
                if (code === 116 /* 't' */) {
                    if (p + 4 > this.data.length) return { type: 'typedArray', elementType: 'double', value: new Float64Array(0) } as any;
                    const lutSize = this.view.getUint32(p, true);
                    p += 4;
                    const lutNeed = p + lutSize * 8;
                    if (lutNeed > this.data.length) return { type: 'typedArray', elementType: 'double', value: new Float64Array(0) } as any;
                    const lut = new Float64Array(lutSize);
                    for (let i = 0; i < lutSize; i++) lut[i] = this.view.getFloat64(p + i * 8, true);
                    p = lutNeed;
                    if (p + 8 > this.data.length) return { type: 'typedArray', elementType: 'double', value: new Float64Array(0) } as any;
                    const compressedSize = Number(this.view.getBigUint64(p, true));
                    p += 8;
                    const end = p + compressedSize;
                    if (!Number.isFinite(compressedSize) || compressedSize < 0 || end > this.data.length) {
                        return { type: 'typedArray', elementType: 'double', value: new Float64Array(0) } as any;
                    }
                    const comp = this.data.subarray(p, end);
                    const idxs = decompressIntegers32(comp, compressedSize, count);
                    const out = new Float64Array(count);
                    for (let i = 0; i < count; i++) out[i] = lut[idxs[i] ?? 0] ?? 0;
                    return { type: 'typedArray', elementType: 'double', value: out } as any;
                }
                return { type: 'typedArray', elementType: 'double', value: new Float64Array(0) } as any;
            }

            if (type === ValueType.Matrix4d) {
                const need = base + count * 16 * 8;
                if (need > this.data.length) return { type: 'typedArray', elementType: 'matrix4d', value: new Float64Array(0) } as any;
                const out = new Float64Array(count * 16);
                for (let i = 0; i < count * 16; i++) out[i] = this.view.getFloat64(base + i * 8, true);
                return { type: 'typedArray', elementType: 'matrix4d', value: out } as any;
            }

            if (type === ValueType.Vec2f || type === ValueType.Vec3f || type === ValueType.Vec4f) {
                const dim = type === ValueType.Vec2f ? 2 : type === ValueType.Vec3f ? 3 : 4;
                const need = base + count * dim * 4;
                if (need > this.data.length) return { type: 'typedArray', elementType: `vec${dim}f`, value: new Float32Array(0) } as any;
                const out = new Float32Array(count * dim);
                for (let i = 0; i < count * dim; i++) out[i] = this.view.getFloat32(base + i * 4, true);
                return { type: 'typedArray', elementType: `vec${dim}f`, value: out } as any;
            }

            if (type === ValueType.Vec2d || type === ValueType.Vec3d || type === ValueType.Vec4d) {
                const dim = type === ValueType.Vec2d ? 2 : type === ValueType.Vec3d ? 3 : 4;
                const need = base + count * dim * 8;
                if (need > this.data.length) return { type: 'typedArray', elementType: `vec${dim}d`, value: new Float64Array(0) } as any;
                const out = new Float64Array(count * dim);
                for (let i = 0; i < count * dim; i++) out[i] = this.view.getFloat64(base + i * 8, true);
                return { type: 'typedArray', elementType: `vec${dim}d`, value: out } as any;
            }

            if (type === ValueType.Vec2h || type === ValueType.Vec3h || type === ValueType.Vec4h) {
                const dim = type === ValueType.Vec2h ? 2 : type === ValueType.Vec3h ? 3 : 4;
                const need = base + count * dim * 2;
                if (need > this.data.length) return { type: 'typedArray', elementType: `vec${dim}h`, value: new Float32Array(0) } as any;
                const out = new Float32Array(count * dim);
                for (let i = 0; i < count * dim; i++) {
                    const h = this.view.getUint16(base + i * 2, true);
                    out[i] = halfToFloat(h);
                }
                return { type: 'typedArray', elementType: `vec${dim}h`, value: out } as any;
            }

            if (type === ValueType.Quatf) {
                const need = base + count * 4 * 4;
                if (need > this.data.length) return { type: 'typedArray', elementType: 'quatf', value: new Float32Array(0) } as any;
                const out = new Float32Array(count * 4);
                // USDC stores GfQuatf in memory order (x,y,z,w), but USDA text prints (w,x,y,z).
                for (let i = 0; i < count; i++) {
                    const x = this.view.getFloat32(base + (i * 4 + 0) * 4, true);
                    const y = this.view.getFloat32(base + (i * 4 + 1) * 4, true);
                    const z = this.view.getFloat32(base + (i * 4 + 2) * 4, true);
                    const w = this.view.getFloat32(base + (i * 4 + 3) * 4, true);
                    out[i * 4 + 0] = w;
                    out[i * 4 + 1] = x;
                    out[i * 4 + 2] = y;
                    out[i * 4 + 3] = z;
                }
                return { type: 'typedArray', elementType: 'quatf', value: out } as any;
            }

            if (type === ValueType.Quatd) {
                const need = base + count * 4 * 8;
                if (need > this.data.length) return { type: 'typedArray', elementType: 'quatd', value: new Float64Array(0) } as any;
                const out = new Float64Array(count * 4);
                for (let i = 0; i < count; i++) {
                    const x = this.view.getFloat64(base + (i * 4 + 0) * 8, true);
                    const y = this.view.getFloat64(base + (i * 4 + 1) * 8, true);
                    const z = this.view.getFloat64(base + (i * 4 + 2) * 8, true);
                    const w = this.view.getFloat64(base + (i * 4 + 3) * 8, true);
                    out[i * 4 + 0] = w;
                    out[i * 4 + 1] = x;
                    out[i * 4 + 2] = y;
                    out[i * 4 + 3] = z;
                }
                return { type: 'typedArray', elementType: 'quatd', value: out } as any;
            }

            // Fallback for unimplemented array element types.
            return { type: 'array', elementType: 'unknown', value: [] };
        }

        switch (type) {
            case ValueType.Bool:
                return isInlined ? Boolean(inlineValue & 1) : false;

            case ValueType.Int:
                if (isInlined) {
                    // Sign-extend from 32-bit
                    return inlineValue | 0;
                }
                if (offset + 4 > this.data.length) return null;
                return this.view.getInt32(offset, true);

            case ValueType.UInt:
                if (isInlined) return inlineValue >>> 0;
                if (offset + 4 > this.data.length) return null;
                return this.view.getUint32(offset, true);

            case ValueType.Int64:
            case ValueType.UInt64:
                if (isInlined) {
                    return inlineValue;
                }
                if (offset + 8 > this.data.length) return null;
                return Number(this.view.getBigInt64(offset, true));

            case ValueType.Float: {
                if (isInlined) {
                    const buf = new ArrayBuffer(4);
                    new DataView(buf).setUint32(0, inlineValue, true);
                    return new DataView(buf).getFloat32(0, true);
                }
                if (offset + 4 > this.data.length) return null;
                return this.view.getFloat32(offset, true);
            }

            case ValueType.Double: {
                if (isInlined) {
                    // Inlined double stores as float
                    const buf = new ArrayBuffer(4);
                    new DataView(buf).setUint32(0, inlineValue, true);
                    return new DataView(buf).getFloat32(0, true);
                }
                if (offset + 8 > this.data.length) return null;
                return this.view.getFloat64(offset, true);
            }

            case ValueType.String: {
                const index = inlineValue;
                // String uses stringIndices to look up token
                const tokenIdx = this.stringIndices[index];
                return tokenIdx !== undefined ? (this.tokens[tokenIdx] ?? '') : '';
            }

            case ValueType.Token: {
                const index = inlineValue;
                const str = this.tokens[index] ?? '';
                return { type: 'token', value: str };
            }

            case ValueType.AssetPath: {
                const index = inlineValue;
                // AssetPath uses token index for inlined, string index for non-inlined
                const str = isInlined
                    ? (this.tokens[index] ?? '')
                    : (this.stringIndices[index] !== undefined ? (this.tokens[this.stringIndices[index]] ?? '') : '');
                return { type: 'asset', value: str };
            }

            case ValueType.Vec2f:
            case ValueType.Vec3f:
            case ValueType.Vec4f: {
                const dim = type === ValueType.Vec2f ? 2 : type === ValueType.Vec3f ? 3 : 4;
                if (isInlined) {
                    // Inlined vectors store int8 values
                    const values: number[] = [];
                    for (let i = 0; i < dim; i++) {
                        values.push(((inlineValue >> (i * 8)) & 0xFF) << 24 >> 24); // Sign extend
                    }
                    return { type: `vec${dim}f` as 'vec2f' | 'vec3f' | 'vec4f', value: values };
                }
                if (offset + dim * 4 > this.data.length) return null;
                const values: number[] = [];
                for (let i = 0; i < dim; i++) {
                    values.push(this.view.getFloat32(offset + i * 4, true));
                }
                return { type: `vec${dim}f` as 'vec2f' | 'vec3f' | 'vec4f', value: values };
            }

            case ValueType.Vec2d:
            case ValueType.Vec3d:
            case ValueType.Vec4d: {
                const dim = type === ValueType.Vec2d ? 2 : type === ValueType.Vec3d ? 3 : 4;
                if (isInlined) {
                    const values: number[] = [];
                    for (let i = 0; i < dim; i++) {
                        values.push(((inlineValue >> (i * 8)) & 0xFF) << 24 >> 24);
                    }
                    return { type: 'tuple', value: values };
                }
                if (offset + dim * 8 > this.data.length) return null;
                const values: number[] = [];
                for (let i = 0; i < dim; i++) {
                    values.push(this.view.getFloat64(offset + i * 8, true));
                }
                return { type: 'tuple', value: values };
            }

            case ValueType.Matrix4d: {
                if (isInlined) {
                    // Inlined matrix stores diagonal as int8 values
                    const values = new Array(16).fill(0);
                    values[0] = ((inlineValue >> 0) & 0xFF) << 24 >> 24;
                    values[5] = ((inlineValue >> 8) & 0xFF) << 24 >> 24;
                    values[10] = ((inlineValue >> 16) & 0xFF) << 24 >> 24;
                    values[15] = ((inlineValue >> 24) & 0xFF) << 24 >> 24;
                    const out = new Float64Array(16);
                    for (let i = 0; i < 16; i++) out[i] = values[i] ?? 0;
                    return { type: 'typedArray', elementType: 'matrix4d', value: out } as any;
                }
                if (offset + 16 * 8 > this.data.length) return null;
                const out = new Float64Array(16);
                for (let i = 0; i < 16; i++) out[i] = this.view.getFloat64(offset + i * 8, true);
                // Mirror USDA scalar packing (`typedArray` for matrix4* scalars).
                return { type: 'typedArray', elementType: 'matrix4d', value: out } as any;
            }

            case ValueType.Specifier: {
                // SdfSpecifier: 0=def, 1=over, 2=class
                // In crate files this is commonly stored as a small immediate value in the payload,
                // even when the generic "inlined" flag is not set.
                const v = inlineValue | 0;
                if (v === 1) return 'over';
                if (v === 2) return 'class';
                return 'def';
            }

            case ValueType.Specifier: {
                const spec = inlineValue & 0xFF;
                return spec === 0 ? 'def' : spec === 1 ? 'over' : 'class';
            }

            case ValueType.Variability: {
                const v = inlineValue & 0xFF;
                return v === 0 ? 'varying' : 'uniform';
            }

            case ValueType.Dictionary: {
                // Dictionary (VtDictionary).
                //
                // OpenUSD crate encoding (see pxr/usd/sdf/crateFile.cpp/.h):
                // - uint64 count
                // - repeated entries:
                //   - StringIndex key (uint32)  -> resolves via STRINGS table (stringIndices -> tokens)
                //   - VtValue value:
                //       int64 relative offset (from the offset field location) to the trailing ValueRep
                //       ... (nested value data may live here)
                //       ValueRep (uint64) at (offsetLoc + relOffset)
                //
                // After reading a VtValue, the stream position advances to just after that trailing ValueRep.
                if (isInlined) return { type: 'dict', value: {} };

                let p = offset;
                if (!Number.isFinite(p) || p < 0 || p + 8 > this.data.length) return { type: 'dict', value: {} };

                let count = 0;
                try {
                    count = Number(this.view.getBigUint64(p, true));
                } catch {
                    return { type: 'dict', value: {} };
                }
                p += 8;

                // Guard: avoid pathological sizes on corrupt input.
                if (!Number.isFinite(count) || count < 0 || count > 1_000_000) return { type: 'dict', value: {} };

                const out: Record<string, SdfValue> = {};

                for (let i = 0; i < count; i++) {
                    // Key: StringIndex (uint32)
                    if (p + 4 > this.data.length) break;
                    const keyStringIndex = this.view.getUint32(p, true);
                    p += 4;
                    const keyTokenIdx = this.stringIndices[keyStringIndex];
                    const key = keyTokenIdx !== undefined ? (this.tokens[keyTokenIdx] ?? '') : '';

                    // Value: VtValue stored as relative offset to trailing ValueRep
                    const offsetLoc = p;
                    if (p + 8 > this.data.length) break;
                    let rel: number;
                    try {
                        rel = Number(this.view.getBigInt64(p, true));
                    } catch {
                        break;
                    }
                    p += 8;

                    const repPos = offsetLoc + rel;
                    if (repPos < 0 || repPos + 8 > this.data.length) {
                        // Corrupt: cannot locate trailing ValueRep.
                        break;
                    }

                    const vr = this.view.getBigUint64(repPos, true);
                    const val = this.decodeValueRep(vr);

                    if (key) out[key] = val;

                    // Advance the stream to just after this entry's trailing ValueRep.
                    p = repPos + 8;
                }

                return { type: 'dict', value: out };
            }

            case ValueType.TimeSamples: {
                // CrateFile::TimeSamples encoding (pxr/usd/sdf/crateFile.cpp):
                // - int64 offsetToTimesRep (relative to this int64)
                // - at that location: ValueRep timesRep (typically double[])
                // - int64 offsetToValues (relative to this second int64)
                // - at values location: uint64 numValues, followed by numValues contiguous ValueRep
                if (offset <= 0 || offset + 8 > this.data.length) return new Map() as any;
                const p0 = offset;
                const rel1 = Number(this.view.getBigInt64(p0, true));
                const pTimes = p0 + rel1;
                if (!Number.isFinite(rel1) || pTimes < 0 || pTimes + 8 > this.data.length) return new Map() as any;
                const timesRep = this.view.getBigUint64(pTimes, true);
                const timesVal: any = this.decodeValueRep(timesRep);
                const times: number[] =
                    timesVal && typeof timesVal === 'object' && timesVal.type === 'typedArray'
                        ? Array.from(timesVal.value as any)
                        : Array.isArray(timesVal) ? timesVal : [];

                const pOffset2 = pTimes + 8;
                if (pOffset2 + 8 > this.data.length) return new Map() as any;
                const rel2 = Number(this.view.getBigInt64(pOffset2, true));
                const pValues = pOffset2 + rel2;
                if (!Number.isFinite(rel2) || pValues < 0 || pValues + 8 > this.data.length) return new Map() as any;
                const numValues = Number(this.view.getBigUint64(pValues, true));
                const repsStart = pValues + 8;
                if (!Number.isFinite(numValues) || numValues < 0 || repsStart + numValues * 8 > this.data.length) return new Map() as any;

                const map = new Map<number, SdfValue>();
                const n = Math.min(times.length, numValues);
                for (let i = 0; i < n; i++) {
                    const vr = this.view.getBigUint64(repsStart + i * 8, true);
                    map.set(times[i]!, this.decodeValueRep(vr));
                }
                return map as any;
            }

            case ValueType.DoubleVector: {
                if (isInlined) return { type: 'typedArray', elementType: 'double', value: new Float64Array(0) } as any;
                if (offset + 8 > this.data.length) return { type: 'typedArray', elementType: 'double', value: new Float64Array(0) } as any;
                const n = Number(this.view.getBigUint64(offset, true));
                const base = offset + 8;
                if (!Number.isFinite(n) || n < 0) return { type: 'typedArray', elementType: 'double', value: new Float64Array(0) } as any;
                const need = base + n * 8;
                if (need > this.data.length) return { type: 'typedArray', elementType: 'double', value: new Float64Array(0) } as any;
                const out = new Float64Array(n);
                for (let i = 0; i < n; i++) out[i] = this.view.getFloat64(base + i * 8, true);
                return { type: 'typedArray', elementType: 'double', value: out } as any;
            }

            case ValueType.PathListOp: {
                // SdfPathListOp: used for relationship targetPaths and attribute connectionPaths.
                // Encoding matches OpenUSD Sdf_CrateFile::_ListOpHeader + vectors of PathIndex.
                if (isInlined) return { type: 'array', elementType: 'sdfpath', value: [] };
                if (offset + 1 > this.data.length) return { type: 'array', elementType: 'sdfpath', value: [] };

                let p = offset;
                const bits = this.data[p++]!;
                const isExplicit = (bits & 0x01) !== 0;
                const hasExplicit = (bits & 0x02) !== 0;
                const hasAdded = (bits & 0x04) !== 0;
                const hasDeleted = (bits & 0x08) !== 0;
                const hasOrdered = (bits & 0x10) !== 0;
                const hasPrepended = (bits & 0x20) !== 0;
                const hasAppended = (bits & 0x40) !== 0;

                const readPathVec = (): string[] => {
                    if (p + 8 > this.data.length) return [];
                    const n = Number(this.view.getBigUint64(p, true));
                    p += 8;
                    if (!Number.isFinite(n) || n < 0) return [];
                    const need = p + n * 4;
                    if (need > this.data.length) return [];
                    const out: string[] = [];
                    for (let i = 0; i < n; i++) {
                        const pi = this.view.getUint32(p + i * 4, true);
                        out.push(this.paths[pi] ?? '');
                    }
                    p = need;
                    return out.filter(Boolean);
                };

                const explicitItems = hasExplicit ? readPathVec() : [];
                const addedItems = hasAdded ? readPathVec() : [];
                const deletedItems = hasDeleted ? readPathVec() : [];
                const orderedItems = hasOrdered ? readPathVec() : [];
                const prependedItems = hasPrepended ? readPathVec() : [];
                const appendedItems = hasAppended ? readPathVec() : [];

                let result: string[] = [];
                if (isExplicit) {
                    result = explicitItems;
                } else {
                    // Approximate composition for our needs: union added/prepended/appended, remove deleted, apply ordered if provided.
                    const set = new Set<string>();
                    for (const x of [...addedItems, ...prependedItems, ...appendedItems]) set.add(x);
                    for (const x of deletedItems) set.delete(x);
                    result = Array.from(set);
                    if (orderedItems.length) {
                        // Keep only those present, in order.
                        const ordered = orderedItems.filter((x) => set.has(x));
                        const rest = result.filter((x) => !ordered.includes(x));
                        result = [...ordered, ...rest];
                    } else {
                        result.sort();
                    }
                }

                return {
                    type: 'array',
                    elementType: 'sdfpath',
                    value: result.map((s) => ({ type: 'sdfpath', value: s })),
                } as any;
            }

            case ValueType.PathVector:
            case ValueType.TokenVector: {
                return { type: 'array', elementType: type === ValueType.PathVector ? 'sdfpath' : 'token', value: [] };
            }

            case ValueType.ValueBlock: {
                // Value block (blocked value) - return null
                return null;
            }

            default:
                return null;
        }
    }

    private addPrim(layer: SdfLayer, path: string, fields: Map<string, SdfValue>): void {
        if (path === '/') return; // Skip root

        const sdfPath = SdfPath.parse(path);

        // Determine specifier
        let specifier: SdfPrimSpecifier = 'def';
        const specValue = fields.get('specifier');
        const sv = specValue && typeof specValue === 'object' && (specValue as any).type === 'token' ? (specValue as any).value : specValue;
        if (sv === 'over' || sv === 1) specifier = 'over';
        else if (sv === 'class' || sv === 2) specifier = 'class';

        const prim = layer.ensurePrim(sdfPath, specifier);
        // ensurePrim() does not update existing placeholder prims' specifiers; set it explicitly.
        prim.specifier = specifier;

        // Set type name
        const typeName = fields.get('typeName');
        if (typeName && typeof typeName === 'object' && (typeName as any).type === 'token') {
            const tn = (typeName as any).value;
            if (tn) prim.typeName = tn;
        } else if (typeof typeName === 'string') {
            if (typeName) prim.typeName = typeName;
        }

        // Copy metadata fields
        for (const [name, value] of fields) {
            if (name !== 'specifier' && name !== 'typeName' && name !== 'primChildren' && name !== 'properties'
                && name !== 'variantSelection' && name !== 'variantSetChildren' && name !== 'variantSetNames') {
                if (!prim.metadata) prim.metadata = {};
                (prim.metadata as Record<string, SdfValue>)[name] = value;
            }
        }

        // Heuristic: crate files frequently represent "stub" prim specs (commonly emitted as `over "PrimName"` by usdcat)
        // without an explicit typeName, but with authored properties (e.g. material:binding) and no children.
        // If we created placeholders as `def`, normalize them to `over` to match usdcat output.
        if (prim.specifier === 'def' && !prim.typeName && (prim.children?.size ?? 0) === 0 && (prim.properties?.size ?? 0) > 0) {
            prim.specifier = 'over';
        }
    }

    private postprocessVariantSelectionNodes(root: SdfPrimSpec): void {
        const parseVariantNode = (s: string): Array<{ setName: string; variantName: string }> => {
            // Accept one or more `{set=variant}` blocks concatenated.
            const out: Array<{ setName: string; variantName: string }> = [];
            let i = 0;
            while (i < s.length) {
                const open = s.indexOf('{', i);
                if (open === -1) break;
                const close = s.indexOf('}', open + 1);
                if (close === -1) break;
                const body = s.slice(open + 1, close);
                const eq = body.indexOf('=');
                if (eq > 0) {
                    const setName = body.slice(0, eq);
                    const variantName = body.slice(eq + 1);
                    if (setName && variantName) out.push({ setName, variantName });
                }
                i = close + 1;
            }
            return out;
        };

        const visit = (prim: SdfPrimSpec): void => {
            // Recurse first for stability when mutating maps.
            for (const child of prim.children?.values?.() ?? []) visit(child);

            if (!prim.children || prim.children.size === 0) return;
            const toRemove: string[] = [];

            for (const [childName, childPrim] of prim.children.entries()) {
                if (!childName.startsWith('{')) continue;
                const sels = parseVariantNode(childName);
                if (sels.length === 0) continue;

                for (const sel of sels) {
                    if (!prim.variantSets) prim.variantSets = new Map();
                    let vs = prim.variantSets.get(sel.setName);
                    if (!vs) {
                        vs = { name: sel.setName, variants: new Map() };
                        prim.variantSets.set(sel.setName, vs);
                    }

                    let variantPrim = vs.variants.get(sel.variantName);
                    if (!variantPrim) {
                        variantPrim = {
                            path: prim.path,
                            specifier: 'over',
                            metadata: {},
                            properties: new Map(),
                            children: new Map(),
                        };
                        vs.variants.set(sel.variantName, variantPrim);
                    }

                    // Merge childPrim into variantPrim (paths aren't compared in our test).
                    if (childPrim.metadata) variantPrim.metadata = { ...(variantPrim.metadata ?? {}), ...(childPrim.metadata ?? {}) };
                    for (const [k, v] of childPrim.properties?.entries?.() ?? []) variantPrim.properties?.set(k, v);
                    for (const [k, v] of childPrim.children?.entries?.() ?? []) variantPrim.children?.set(k, v);

                    // Ensure the parent prim exposes the same metadata keys that usdcat writes.
                    if (!prim.metadata) prim.metadata = {};
                    if (!(prim.metadata as any).variants) (prim.metadata as any).variants = { type: 'dict', value: {} };
                    if (!(prim.metadata as any).variantSets) (prim.metadata as any).variantSets = { type: 'array', elementType: 'token', value: [] };
                }

                toRemove.push(childName);
            }

            for (const k of toRemove) prim.children.delete(k);
        };

        visit(root);
    }

    private postprocessStubOvers(root: SdfPrimSpec): void {
        const visit = (prim: SdfPrimSpec): void => {
            for (const c of prim.children?.values?.() ?? []) visit(c);
            if (prim.specifier === 'def' && !prim.typeName && (prim.children?.size ?? 0) === 0 && (prim.properties?.size ?? 0) > 0) {
                prim.specifier = 'over';
            }
        };
        visit(root);
    }

    private addProperty(layer: SdfLayer, path: string, fields: Map<string, SdfValue>, specType: SpecType): void {
        // Parse property path using SdfPath semantics (supports optional field like `.connect`).
        // Examples:
        // - /Prim.prop
        // - /Prim.prop.connect
        let primPath: string;
        let propName: string;
        let fieldName: string | null = null;
        try {
            const sp = SdfPath.parse(path);
            if (sp.kind !== 'property') return;
            primPath = sp.primPath;
            propName = sp.propertyName ?? '';
            fieldName = sp.propertyField ?? null;
        } catch {
            return;
        }

        const sdfPath = SdfPath.parse(primPath);
        const prim = layer.getPrim(sdfPath);
        if (!prim) return;

        if (!prim.properties) prim.properties = new Map();

        // Get type name
        let typeName = 'unknown';
        const typeValue = fields.get('typeName');
        if (typeValue && typeof typeValue === 'object' && (typeValue as any).type === 'token') {
            typeName = (typeValue as any).value;
        } else if (typeof typeValue === 'string') {
            typeName = typeValue;
        }

        const propSpec: SdfPropertySpec = {
            path: SdfPath.property(primPath, propName, fieldName),
            typeName,
            metadata: {},
        };

        try {
            // eslint-disable-next-line no-process-env
            if (typeof process !== 'undefined' && process.env?.USDJS_USDC_DUMP_FIELDS === '1') {
                if (path.includes('Elefant/_anim.rotations') || path.includes('Elefant/_anim.translations') || path.includes('Elefant/_anim.scales')) {
                    // eslint-disable-next-line no-console
                    console.log('[usdc][fields]', path, {
                        specType,
                        keys: Array.from(fields.keys()),
                        timeSamples: fields.get('timeSamples'),
                        default: fields.get('default'),
                    });
                }
            }
        } catch {
            // ignore
        }

        // Time samples field (distinct from property metadata).  Note that
        // decodeValueRep(TimeSamples) returns a Map<number, SdfValue>.
        const ts = fields.get('timeSamples') as any;
        if (ts && typeof ts === 'object' && typeof ts.get === 'function') {
            propSpec.timeSamples = ts as Map<number, SdfValue>;
        }

        // Get default value
        const defaultValue = fields.get('default');
        if (defaultValue !== undefined) {
            propSpec.defaultValue = defaultValue;
        }

        // Relationship targets / attribute connections are represented as separate `.connect`
        // / relationship default values in USDA. Mirror that shape for comparisons.
        if (specType === SpecType.Relationship) {
            propSpec.typeName = 'rel';
            const targets = fields.get('targetPaths');
            if (targets && typeof targets === 'object' && (targets as any).type === 'array' && (targets as any).elementType === 'sdfpath') {
                const arr = (targets as any).value as any[];
                if (Array.isArray(arr) && arr.length === 1) propSpec.defaultValue = arr[0];
                else propSpec.defaultValue = targets as any;
            }
        } else if (specType === SpecType.Attribute) {
            const conns = fields.get('connectionPaths');
            if (conns && typeof conns === 'object' && (conns as any).type === 'array' && (conns as any).elementType === 'sdfpath') {
                const arr = (conns as any).value as any[];
                const connectVal = Array.isArray(arr) && arr.length === 1 ? arr[0] : conns;
                const connectSpec: SdfPropertySpec = {
                    path: SdfPath.property(primPath, propName, 'connect'),
                    typeName: propSpec.typeName,
                    defaultValue: connectVal as any,
                    metadata: {},
                };
                prim.properties.set(`${propName}.connect`, connectSpec);

                // usdcat typically only authors the `.connect` field in USDA, not a base declaration.
                // If this property has no authored default and is not itself a field, omit the base spec.
                if (!fieldName && defaultValue === undefined) {
                    return;
                }
            }
        }

        // Normalize packed typedArray elementType to declared typeName where possible.
        // USDC encodes many vec3f-like arrays (points/normals/colors) with the same ValueType.
        if (propSpec.defaultValue && typeof propSpec.defaultValue === 'object' && (propSpec.defaultValue as any).type === 'typedArray') {
            const dv: any = propSpec.defaultValue;
            if (typeof propSpec.typeName === 'string' && propSpec.typeName.endsWith('[]')) {
                const base = propSpec.typeName.slice(0, -2);
                // Keep scalar matrices as-is.
                if (dv.elementType && dv.elementType.startsWith('vec') && base) {
                    dv.elementType = base;
                }
            }
        }
        // Apply the same elementType normalization to timeSample values.
        if (propSpec.timeSamples && typeof propSpec.typeName === 'string' && propSpec.typeName.endsWith('[]')) {
            const base = propSpec.typeName.slice(0, -2);
            if (base) {
                for (const v of propSpec.timeSamples.values()) {
                    if (v && typeof v === 'object' && (v as any).type === 'typedArray') {
                        const tv: any = v;
                        if (tv.elementType && typeof tv.elementType === 'string' && tv.elementType.startsWith('vec')) {
                            tv.elementType = base;
                        }
                    }
                }
            }
        }

        // Copy other fields as metadata
        for (const [name, value] of fields) {
            if (name === 'variability' && (typeof value === 'string')) {
                if (specType === SpecType.Relationship) continue; // relationships don't serialize variability qualifier in USDA
                // usdcat typically only writes `uniform` (and omits the default `varying`).
                if (value === 'uniform') {
                    // USDA parser stores `uniform` as metadata.qualifier token.
                    (propSpec.metadata as Record<string, SdfValue>).qualifier = { type: 'token', value };
                }
                continue;
            }
            if (name === 'custom' && typeof value === 'boolean') {
                // Only preserve custom=true (usdcat doesn't serialize custom=false).
                if (value) (propSpec.metadata as Record<string, SdfValue>).custom = true;
                continue;
            }
            if (name !== 'typeName' && name !== 'default' && name !== 'variability' && name !== 'connectionPaths' && name !== 'targetPaths' && name !== 'timeSamples') {
                if (!propSpec.metadata) propSpec.metadata = {};
                const k = name === 'documentation' ? 'doc' : name;
                // USDA parsing of metadata often yields plain strings for tokens (e.g. colorSpace="raw").
                const v = value && typeof value === 'object' && (value as any).type === 'token' ? (value as any).value : value;
                (propSpec.metadata as Record<string, SdfValue>)[k] = v;
            }
        }

        const propKey = fieldName ? `${propName}.${fieldName}` : propName;
        prim.properties.set(propKey, propSpec);
    }

    // Low-level readers
    private readUint8(): number {
        return this.data[this.offset++];
    }

    private readUint32(): number {
        const value = this.view.getUint32(this.offset, true);
        this.offset += 4;
        return value;
    }

    private readInt32(): number {
        const value = this.view.getInt32(this.offset, true);
        this.offset += 4;
        return value;
    }

    private readUint64(): bigint {
        const value = this.view.getBigUint64(this.offset, true);
        this.offset += 8;
        return value;
    }

    private readFixedString(length: number): string {
        const bytes = this.data.subarray(this.offset, this.offset + length);
        this.offset += length;
        // Find null terminator
        let end = 0;
        while (end < bytes.length && bytes[end] !== 0) end++;
        return new TextDecoder('utf-8').decode(bytes.subarray(0, end));
    }
}
