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
        
        return this.buildLayer(identifier);
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
                    } else if (['upAxis', 'metersPerUnit', 'documentation', 'framesPerSecond', 
                                'startTimeCode', 'endTimeCode', 'timeCodesPerSecond'].includes(name)) {
                        (layer.metadata as Record<string, SdfValue>)[name] = value;
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
        // Value representation encoding (64 bits) - format varies:
        // Format 1 (arrays): Bits 51-57 = type (7 bits), Bit 48 = isInlined, Bit 49 = isArray
        // Format 2 (non-arrays): Bits 48-55 = type (8 bits), Bit 56 = isInlined, Bit 57 = isArray
        
        const payload = valueRep & ((1n << 48n) - 1n);
        
        // Try format 2 first (non-array format, works for most values)
        let type = Number((valueRep >> 48n) & 0xFFn) as ValueType;
        let isInlined = (valueRep >> 56n & 1n) === 1n;
        let isArray = (valueRep >> 57n & 1n) === 1n;
        
        // If type is invalid or out of range, try format 1 (array format)
        if (type === 0 || type > 56) {
            type = Number((valueRep >> 51n) & 0x7Fn) as ValueType;
            isInlined = (valueRep >> 48n & 1n) === 1n;
            isArray = (valueRep >> 49n & 1n) === 1n;
        }
        
        // For inlined values, payload contains the value (lower 32 bits used for small values)
        const inlineValue = Number(payload & 0xFFFFFFFFn);
        
        // For non-inlined values, payload is an offset into the file
        const offset = Number(payload);
        
        // Validate offset for non-inlined values before accessing
        if (!isInlined && offset >= this.data.length) {
            return null;
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
                    return { type: 'matrix4d', value: values };
                }
                if (offset + 16 * 8 > this.data.length) return null;
                const values: number[] = [];
                for (let i = 0; i < 16; i++) {
                    values.push(this.view.getFloat64(offset + i * 8, true));
                }
                return { type: 'matrix4d', value: values };
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
                // Dictionary - return empty for now
                return { type: 'dict', value: {} };
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
        if (specValue === 'over') specifier = 'over';
        else if (specValue === 'class') specifier = 'class';
        
        const prim = layer.ensurePrim(sdfPath, specifier);
        
        // Set type name
        const typeName = fields.get('typeName');
        if (typeName && typeof typeName === 'object' && (typeName as any).type === 'token') {
            prim.typeName = (typeName as any).value;
        } else if (typeof typeName === 'string') {
            prim.typeName = typeName;
        }
        
        // Copy metadata fields
        for (const [name, value] of fields) {
            if (name !== 'specifier' && name !== 'typeName' && name !== 'primChildren' && name !== 'properties') {
                if (!prim.metadata) prim.metadata = {};
                (prim.metadata as Record<string, SdfValue>)[name] = value;
            }
        }
    }

    private addProperty(layer: SdfLayer, path: string, fields: Map<string, SdfValue>, specType: SpecType): void {
        // Parse property path: /Prim/Path.propertyName
        const dotIndex = path.lastIndexOf('.');
        if (dotIndex === -1) return;
        
        const primPath = path.slice(0, dotIndex);
        const propName = path.slice(dotIndex + 1);
        
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
            path: SdfPath.property(primPath, propName, null),
            typeName,
            metadata: {},
        };
        
        // Get default value
        const defaultValue = fields.get('default');
        if (defaultValue !== undefined) {
            propSpec.defaultValue = defaultValue;
        }
        
        // Copy other fields as metadata
        for (const [name, value] of fields) {
            if (name !== 'typeName' && name !== 'default') {
                if (!propSpec.metadata) propSpec.metadata = {};
                (propSpec.metadata as Record<string, SdfValue>)[name] = value;
            }
        }
        
        prim.properties.set(propName, propSpec);
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
