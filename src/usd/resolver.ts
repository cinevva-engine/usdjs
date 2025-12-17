export interface UsdResolver {
    /**
     * Read a USDA layer by asset path.
     *
     * - `assetPath` can be relative to the requesting layer.
     * - Return `identifier` should be a stable, canonical ID for caching (e.g. resolved absolute path).
     */
    readText(assetPath: string, fromIdentifier?: string): Promise<{ identifier: string; text: string }>;
}

/**
 * Minimal path resolver helper for layer-relative asset paths.
 * Works for POSIX-ish paths used in USD assets.
 */
export function resolveAssetPath(assetPath: string, fromIdentifier?: string): string {
    // If absolute-ish, return as-is.
    if (assetPath.startsWith('/') || assetPath.match(/^[A-Za-z]+:\/\//)) return assetPath;
    if (!fromIdentifier) return assetPath;

    // If the requesting layer is itself a URL (e.g. http(s)://...), resolve relative assets as URLs.
    // The path-join logic below intentionally collapses empty segments, which would corrupt `http://`
    // into `http:/` (and break proxy routing + texture loads).
    if (fromIdentifier.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//)) {
        try {
            return new URL(assetPath, fromIdentifier).toString();
        } catch {
            // fall through to path-based resolution
        }
    }

    // Strip file component from fromIdentifier and join.
    const base = fromIdentifier.replace(/\\/g, '/');
    const dir = base.includes('/') ? base.slice(0, base.lastIndexOf('/') + 1) : '';
    const joined = dir + assetPath;

    // Normalize ./ and ../
    const parts = joined.split('/').filter((p) => p.length > 0);
    const out: string[] = [];
    for (const p of parts) {
        if (p === '.') continue;
        if (p === '..') out.pop();
        else out.push(p);
    }
    const prefix = joined.startsWith('/') ? '/' : '';
    return prefix + out.join('/');
}


