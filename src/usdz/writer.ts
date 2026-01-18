import { SdfLayer } from '../sdf/layer.js';
import { serializeLayerToUsda, type UsdaSerializeOptions } from '../usda/serializer.js';
import { serializeLayerToUsdc, type UsdcSerializeOptions } from '../usdc/serializer.js';

export interface UsdzEntryInput {
    /**
     * Archive path (always forward slashes). Do not start with '/'.
     * Example: "textures/albedo.png"
     */
    path: string;
    /** File payload */
    data: string | Uint8Array | ArrayBuffer;
}

export interface UsdzWriteOptions {
    /**
     * Alignment requirement from the USDZ spec (default: 64).
     * This aligns the start of each file's data (not the header).
     */
    alignBytes?: number;
}

export interface SerializeLayerToUsdzOptions {
    /** Default: 'usda' */
    layerFormat?: 'usda' | 'usdc';
    /** Override the root layer filename inside the package. Defaults to "defaultLayer.usda"/"defaultLayer.usdc". */
    defaultLayerName?: string;
    /** Additional files to include in the package (textures, sublayers, etc). */
    files?: UsdzEntryInput[];
    /** USDA serializer options (only used when layerFormat='usda') */
    usda?: UsdaSerializeOptions;
    /** USDC serializer options (only used when layerFormat='usdc') */
    usdc?: UsdcSerializeOptions;
    /** USDZ packaging options */
    usdz?: UsdzWriteOptions;
}

type NormalizedEntry = { path: string; data: Uint8Array };

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

    writeZeros(n: number): void {
        this.ensure(n);
        this.buf.fill(0, this._length, this._length + n);
        this._length += n;
    }

    writeUint16(v: number): void {
        this.ensure(2);
        this.dv.setUint16(this._length, v & 0xffff, true);
        this._length += 2;
    }

    writeUint32(v: number): void {
        this.ensure(4);
        this.dv.setUint32(this._length, v >>> 0, true);
        this._length += 4;
    }

    writeBytes(bytes: Uint8Array): void {
        this.ensure(bytes.length);
        this.buf.set(bytes, this._length);
        this._length += bytes.length;
    }
}

// --- CRC32 (ZIP requires it in headers; USDZ is "stored only" so CRC is cheap to compute) ---
const CRC32_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[i] = c >>> 0;
    }
    return t;
})();

function crc32(bytes: Uint8Array): number {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
        c = CRC32_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

function toBytes(data: string | Uint8Array | ArrayBuffer): Uint8Array {
    if (typeof data === 'string') return new TextEncoder().encode(data);
    if (data instanceof Uint8Array) return data;
    return new Uint8Array(data);
}

function normalizePath(p: string): string {
    const s = String(p ?? '').replace(/\\/g, '/');
    if (!s) throw new Error('USDZ entry path must be non-empty');
    if (s.startsWith('/')) throw new Error(`USDZ entry path must be relative (no leading '/'): ${s}`);
    if (s.includes('\0')) throw new Error(`USDZ entry path must not contain NUL: ${s}`);
    const parts = s.split('/');
    for (const part of parts) {
        if (!part) throw new Error(`USDZ entry path must not contain empty segments: ${s}`);
        if (part === '.' || part === '..') throw new Error(`USDZ entry path must not contain '.' or '..' segments: ${s}`);
    }
    return s;
}

function normalizeEntries(entries: UsdzEntryInput[]): NormalizedEntry[] {
    const out: NormalizedEntry[] = [];
    const seen = new Set<string>();
    for (const e of entries) {
        const p = normalizePath(e.path);
        if (seen.has(p)) throw new Error(`Duplicate USDZ entry path: ${p}`);
        seen.add(p);
        out.push({ path: p, data: toBytes(e.data) });
    }
    return out;
}

function alignExtraLenTo(alignBytes: number, absoluteDataStart: number): number {
    // We can only affect alignment by adding bytes to the local header extra field.
    const delta = (alignBytes - (absoluteDataStart % alignBytes)) % alignBytes;
    if (delta === 0) return 0;
    // ZIP extra field is a sequence of {u16 headerId, u16 dataSize, data...} structures.
    // Ensure the extra field is at least 4 bytes so it can contain one valid header.
    // If delta is too small, add one full alignment quantum (doesn't change modulo).
    if (delta < 4) return delta + alignBytes;
    return delta;
}

/**
 * Create a USDZ package as an uncompressed ZIP archive.
 *
 * Constraints (per OpenUSD USDZ spec):
 * - zero compression (method 0)
 * - unencrypted
 * - file data for each entry begins at a multiple of 64 bytes from beginning of package (default)
 *
 * Note: We use a single custom ZIP "extra field" per entry to pad each local header so that the
 * *following* file data begins on the desired alignment boundary.
 */
export function createUsdzPackage(entries: UsdzEntryInput[], opts: UsdzWriteOptions = {}): Uint8Array {
    const alignBytes = opts.alignBytes ?? 64;
    if (!Number.isInteger(alignBytes) || alignBytes <= 0) {
        throw new Error(`alignBytes must be a positive integer (got ${alignBytes})`);
    }

    const norm = normalizeEntries(entries);

    // Stable ordering: keep given order (important: default layer should be first).
    // However, deterministic output is useful: only sort when user didn't already order.
    // Here we keep caller order exactly.

    const enc = new TextEncoder();

    const w = new ByteWriter();

    type Central = {
        path: string;
        crc: number;
        size: number;
        localHeaderOffset: number;
    };

    const central: Central[] = [];

    for (const e of norm) {
        const nameBytes = enc.encode(e.path);
        const size = e.data.length >>> 0;
        if (e.data.length !== size) throw new Error(`USDZ entry too large (>4GiB): ${e.path}`);

        const localHeaderOffset = w.length;

        // Local file header (30 bytes fixed)
        // signature, verNeeded, flags, compression, modTime, modDate, crc32, compSize, uncompSize, nameLen, extraLen
        w.writeUint32(0x04034b50);
        w.writeUint16(20); // version needed to extract
        w.writeUint16(0); // general purpose bit flag (no encryption, no data descriptor)
        w.writeUint16(0); // compression method: 0=stored
        w.writeUint16(0); // last mod time
        w.writeUint16(0); // last mod date
        const c = crc32(e.data);
        w.writeUint32(c);
        w.writeUint32(size); // compressed size (stored)
        w.writeUint32(size); // uncompressed size
        w.writeUint16(nameBytes.length);

        // Compute padding via extra field so that (localHeaderOffset + 30 + nameLen + extraLen) is aligned.
        const baseDataStart = localHeaderOffset + 30 + nameBytes.length;
        const extraLen = alignExtraLenTo(alignBytes, baseDataStart);
        if (extraLen > 0xffff) throw new Error(`ZIP extra field too large for ${e.path} (extraLen=${extraLen})`);
        w.writeUint16(extraLen);

        // File name
        w.writeBytes(nameBytes);

        // Extra field padding (single custom field, then zero fill)
        if (extraLen > 0) {
            const headerId = 0xCAFE; // arbitrary private header id
            const dataSize = extraLen - 4;
            w.writeUint16(headerId);
            w.writeUint16(dataSize);
            if (dataSize > 0) w.writeZeros(dataSize);
        }

        // Sanity: data starts aligned
        if (w.length % alignBytes !== 0) {
            throw new Error(
                `USDZ alignment bug for ${e.path}: dataStart=${w.length} not multiple of ${alignBytes}`
            );
        }

        // File data (stored)
        w.writeBytes(e.data);

        central.push({ path: e.path, crc: c, size, localHeaderOffset });
    }

    const centralDirOffset = w.length;

    // Central directory
    for (const c of central) {
        const nameBytes = enc.encode(c.path);

        // Central file header (46 bytes fixed)
        w.writeUint32(0x02014b50);
        w.writeUint16(20); // version made by
        w.writeUint16(20); // version needed to extract
        w.writeUint16(0); // flags
        w.writeUint16(0); // compression=stored
        w.writeUint16(0); // mod time
        w.writeUint16(0); // mod date
        w.writeUint32(c.crc);
        w.writeUint32(c.size);
        w.writeUint32(c.size);
        w.writeUint16(nameBytes.length);
        w.writeUint16(0); // extra length (we keep all padding in local headers only)
        w.writeUint16(0); // comment length
        w.writeUint16(0); // disk number start
        w.writeUint16(0); // internal file attributes
        w.writeUint32(0); // external file attributes
        w.writeUint32(c.localHeaderOffset >>> 0);
        w.writeBytes(nameBytes);
    }

    const centralDirSize = w.length - centralDirOffset;

    // End of central directory (EOCD)
    if (central.length > 0xffff) throw new Error(`Too many USDZ entries (>${0xffff})`);
    if (centralDirOffset > 0xffffffff) throw new Error('USDZ too large (centralDirOffset requires ZIP64)');
    if (centralDirSize > 0xffffffff) throw new Error('USDZ too large (centralDirSize requires ZIP64)');

    w.writeUint32(0x06054b50);
    w.writeUint16(0); // disk number
    w.writeUint16(0); // central dir disk
    w.writeUint16(central.length);
    w.writeUint16(central.length);
    w.writeUint32(centralDirSize >>> 0);
    w.writeUint32(centralDirOffset >>> 0);
    w.writeUint16(0); // comment length

    return w.toUint8Array();
}

/**
 * Serialize a layer into a USDZ package.
 *
 * By default this writes `defaultLayer.usda` as the first entry in the archive, per spec.
 */
export function serializeLayerToUsdz(layer: SdfLayer, opts: SerializeLayerToUsdzOptions = {}): Uint8Array {
    const layerFormat = opts.layerFormat ?? 'usda';
    const defaultLayerName =
        opts.defaultLayerName ?? (layerFormat === 'usdc' ? 'defaultLayer.usdc' : 'defaultLayer.usda');

    const rootData =
        layerFormat === 'usdc'
            ? serializeLayerToUsdc(layer, opts.usdc)
            : new TextEncoder().encode(serializeLayerToUsda(layer, opts.usda));

    const extra = (opts.files ?? []).slice();

    // Ensure the default layer is first (spec requirement if you want `package.usdz` to open directly).
    const entries: UsdzEntryInput[] = [{ path: defaultLayerName, data: rootData }, ...extra];

    // Deterministic ordering for extra files (after default layer).
    if (entries.length > 2) {
        const first = entries[0]!;
        const rest = entries.slice(1).sort((a, b) => normalizePath(a.path).localeCompare(normalizePath(b.path)));
        return createUsdzPackage([first, ...rest], opts.usdz);
    }

    return createUsdzPackage(entries, opts.usdz);
}







