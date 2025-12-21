import { SdfLayer } from '../sdf/layer.js';
import { parseUsdaToLayer } from '../usda/parser.js';
import { parseUsdcToLayer, isUsdcContent } from '../usdc/parser.js';
import type { UsdcParseOptions } from '../usdc/parser.js';

export interface UsdzParseOptions {
    identifier?: string;
}

/**
 * ZIP file entry structure
 */
interface ZipEntry {
    filename: string;
    compressedSize: number;
    uncompressedSize: number;
    compressionMethod: number; // 0 = stored, 8 = deflate
    localHeaderOffset: number;
    data?: Uint8Array; // Extracted file data
}

/**
 * Extract ZIP file structure using browser's DecompressionStream API.
 * This is a minimal ZIP parser that uses native browser APIs for decompression.
 */
async function parseZipStructure(data: Uint8Array): Promise<Map<string, ZipEntry>> {
    const entries = new Map<string, ZipEntry>();
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    
    // Find end of central directory record (EOCD)
    // EOCD signature: 0x06054b50
    // It's at the end of the file, but can have a comment, so search backwards
    let eocdOffset = -1;
    for (let i = data.length - 22; i >= 0; i--) {
        if (view.getUint32(i, true) === 0x06054b50) {
            eocdOffset = i;
            break;
        }
    }
    
    if (eocdOffset === -1) {
        throw new Error('Invalid ZIP file: End of central directory not found');
    }
    
    // Read EOCD
    const diskNumber = view.getUint16(eocdOffset + 4, true);
    const centralDirDisk = view.getUint16(eocdOffset + 6, true);
    const centralDirRecords = view.getUint16(eocdOffset + 8, true);
    const totalRecords = view.getUint16(eocdOffset + 10, true);
    const centralDirSize = view.getUint32(eocdOffset + 12, true);
    const centralDirOffset = view.getUint32(eocdOffset + 16, true);
    const commentLength = view.getUint16(eocdOffset + 20, true);
    
    // Read central directory
    let offset = centralDirOffset;
    for (let i = 0; i < totalRecords; i++) {
        // Central file header signature: 0x02014b50
        if (view.getUint32(offset, true) !== 0x02014b50) {
            throw new Error(`Invalid ZIP file: Central directory header not found at offset ${offset}`);
        }
        
        const versionMadeBy = view.getUint16(offset + 4, true);
        const versionNeeded = view.getUint16(offset + 6, true);
        const flags = view.getUint16(offset + 8, true);
        const compressionMethod = view.getUint16(offset + 10, true);
        const lastModTime = view.getUint16(offset + 12, true);
        const lastModDate = view.getUint16(offset + 14, true);
        const crc32 = view.getUint32(offset + 16, true);
        // Note: Central directory compressed/uncompressed sizes may be 0xFFFFFFFF for ZIP64
        // We'll read the actual sizes from the local file header instead
        const compressedSize = view.getUint32(offset + 20, true);
        const uncompressedSize = view.getUint32(offset + 24, true);
        const filenameLength = view.getUint16(offset + 28, true);
        const extraFieldLength = view.getUint16(offset + 30, true);
        const commentLength = view.getUint16(offset + 32, true);
        const diskNumberStart = view.getUint16(offset + 34, true);
        const internalAttrs = view.getUint16(offset + 36, true);
        const externalAttrs = view.getUint32(offset + 38, true);
        const localHeaderOffset = view.getUint32(offset + 42, true);
        
        offset += 46;
        
        // Read filename
        const filenameBytes = data.subarray(offset, offset + filenameLength);
        const filename = new TextDecoder('utf-8').decode(filenameBytes);
        offset += filenameLength + extraFieldLength + commentLength;
        
        // Store entry (normalize path separators)
        // Note: We store compressedSize/uncompressedSize from central dir for reference,
        // but extractZipEntry will read the actual sizes from the local header
        const normalizedFilename = filename.replace(/\\/g, '/');
        entries.set(normalizedFilename, {
            filename: normalizedFilename,
            compressedSize, // May be 0xFFFFFFFF for ZIP64, will be read from local header
            uncompressedSize, // May be 0xFFFFFFFF for ZIP64, will be read from local header
            compressionMethod,
            localHeaderOffset
        });
    }
    
    return entries;
}

/**
 * Extract a single file from ZIP using browser's DecompressionStream API
 */
async function extractZipEntry(
    data: Uint8Array,
    entry: ZipEntry
): Promise<Uint8Array> {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let offset = entry.localHeaderOffset;
    
    // Local file header signature: 0x04034b50
    if (view.getUint32(offset, true) !== 0x04034b50) {
        throw new Error(`Invalid ZIP file: Local file header not found at offset ${offset}`);
    }
    
    const versionNeeded = view.getUint16(offset + 4, true);
    const flags = view.getUint16(offset + 6, true);
    const compressionMethod = view.getUint16(offset + 8, true);
    const lastModTime = view.getUint16(offset + 10, true);
    const lastModDate = view.getUint16(offset + 12, true);
    const crc32 = view.getUint32(offset + 14, true); // CRC32 is at offset 14-17 (4 bytes)
    const compressedSize = view.getUint32(offset + 18, true); // Compressed size is at offset 18-21 (4 bytes)
    const uncompressedSize = view.getUint32(offset + 22, true); // Uncompressed size is at offset 22-25 (4 bytes)
    const filenameLength = view.getUint16(offset + 26, true); // Filename length is at offset 26-27 (2 bytes)
    const extraFieldLength = view.getUint16(offset + 28, true); // Extra field length is at offset 28-29 (2 bytes)
    
    // Calculate data start offset
    // Local file header is 30 bytes + filename + extra field
    const dataStartOffset = offset + 30 + filenameLength + extraFieldLength;
    
    // Validate bounds
    if (dataStartOffset + compressedSize > data.length) {
        throw new Error(
            `Invalid ZIP file: File data extends beyond buffer. ` +
            `Data start: ${dataStartOffset}, Size: ${compressedSize}, Buffer length: ${data.length}`
        );
    }
    
    // Read compressed data
    const compressedData = data.subarray(dataStartOffset, dataStartOffset + compressedSize);
    
    // Decompress if needed
    if (compressionMethod === 0) {
        // Stored (no compression)
        // Verify we got the expected amount of data
        if (compressedData.length !== compressedSize) {
            throw new Error(
                `Invalid ZIP file: Expected ${compressedSize} bytes, got ${compressedData.length}`
            );
        }
        return compressedData;
    } else if (compressionMethod === 8) {
        // Deflate compression - use browser's DecompressionStream API
        const stream = new DecompressionStream('deflate');
        const writer = stream.writable.getWriter();
        const reader = stream.readable.getReader();
        
        // Write compressed data - ensure it's a proper BufferSource
        // Create a copy with a regular ArrayBuffer to avoid SharedArrayBuffer issues
        const compressedBuffer = new Uint8Array(compressedData).buffer as ArrayBuffer;
        writer.write(compressedBuffer);
        writer.close();
        
        // Read decompressed data
        const chunks: Uint8Array[] = [];
        let done = false;
        while (!done) {
            const { value, done: streamDone } = await reader.read();
            done = streamDone;
            if (value) {
                chunks.push(value);
            }
        }
        
        // Combine chunks
        const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const result = new Uint8Array(totalLength);
        let pos = 0;
        for (const chunk of chunks) {
            result.set(chunk, pos);
            pos += chunk.length;
        }
        
        return result;
    } else {
        throw new Error(`Unsupported compression method: ${compressionMethod}`);
    }
}

/**
 * Find the root USD file in a USDZ archive.
 * According to USDZ spec, it should be the first .usd, .usda, or .usdc file.
 */
function findRootUsdFile(entries: Map<string, ZipEntry>): string | null {
    const usdExtensions = ['.usd', '.usda', '.usdc'];
    
    // Sort entries by filename to ensure consistent ordering
    const sortedEntries = Array.from(entries.keys()).sort();
    
    for (const filename of sortedEntries) {
        const ext = filename.toLowerCase().substring(filename.lastIndexOf('.'));
        if (usdExtensions.includes(ext)) {
            return filename;
        }
    }
    
    return null;
}

/**
 * Parse a USDZ file (ZIP archive containing USD files and assets).
 * Uses browser's native DecompressionStream API for deflate decompression.
 * 
 * @param buffer - ArrayBuffer or Uint8Array containing the USDZ file data
 * @param opts - Parse options
 * @returns SdfLayer containing the parsed root USD file
 */
export async function parseUsdzToLayer(
    buffer: ArrayBuffer | Uint8Array,
    opts: UsdzParseOptions = {}
): Promise<SdfLayer> {
    const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    
    // Verify ZIP magic header (PK)
    if (data.length < 4 || data[0] !== 0x50 || data[1] !== 0x4B) {
        throw new Error('Invalid USDZ file: Not a valid ZIP archive');
    }
    
    // Parse ZIP structure
    const entries = await parseZipStructure(data);
    
    if (entries.size === 0) {
        throw new Error('Invalid USDZ file: ZIP archive is empty');
    }
    
    // Find root USD file
    const rootUsdFile = findRootUsdFile(entries);
    if (!rootUsdFile) {
        throw new Error('Invalid USDZ file: No USD file found in archive');
    }
    
    // Extract root USD file
    const rootEntry = entries.get(rootUsdFile);
    if (!rootEntry) {
        throw new Error(`USDZ file entry not found: ${rootUsdFile}`);
    }
    
    const rootData = await extractZipEntry(data, rootEntry);
    
    // Parse the root USD file (auto-detect format)
    const identifier = opts.identifier || rootUsdFile;
    
    if (isUsdcContent(rootData)) {
        // Binary USDC format
        return parseUsdcToLayer(rootData, { identifier });
    } else {
        // ASCII USDA format
        const text = new TextDecoder('utf-8').decode(rootData);
        return parseUsdaToLayer(text, { identifier });
    }
}

/**
 * Check if buffer contains USDZ data by looking for ZIP magic header.
 */
export function isUsdzContent(buffer: ArrayBuffer | Uint8Array): boolean {
    const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (data.length < 4) return false;
    
    // Check for ZIP magic header "PK" (0x50 0x4B)
    return data[0] === 0x50 && data[1] === 0x4B;
}

