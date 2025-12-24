export type SdfPathKind = 'prim' | 'property';

/**
 * Minimal, strict-ish USD path implementation.
 *
 * Notes:
 * - This is a foundation module; it intentionally starts small and will expand.
 * - We focus on absolute prim paths and property paths (primPath.propertyName).
 */
export class SdfPath {
    private constructor(
        public readonly kind: SdfPathKind,
        public readonly primPath: string,
        public readonly propertyName: string | null,
        public readonly propertyField: string | null
    ) { }

    static readonly absoluteRoot = new SdfPath('prim', '/', null, null);

    static isValidIdentifier(name: string): boolean {
        // USD identifiers are more nuanced (namespaces, variants, etc).
        //
        // Foundation support:
        // - common identifiers and namespaced tokens: `foo`, `foo:bar`
        // - optional variant selections appended to prim names: `Prim{set=var}{set2=var2}`
        //
        // Note: Variant selections are not part of the identifier per se, but are valid
        // in SdfPath text. We accept them here so the corpus can parse.
        const baseIdent = /^[A-Za-z_][A-Za-z0-9_]*(?::[A-Za-z_][A-Za-z0-9_]*)*$/;
        const variantSel = /^\{[A-Za-z_][A-Za-z0-9_]*=[A-Za-z_][A-Za-z0-9_]*\}$/;

        if (baseIdent.test(name)) return true;

        // Try base identifier + one or more variant selections.
        const firstBrace = name.indexOf('{');
        if (firstBrace > 0) {
            const base = name.slice(0, firstBrace);
            if (!baseIdent.test(base)) return false;
            const rest = name.slice(firstBrace);
            // Split into `{...}` chunks.
            const chunks = rest.split('}').filter(Boolean).map((c) => c + '}');
            if (chunks.length === 0) return false;
            return chunks.every((c) => variantSel.test(c));
        }

        // Some crates may tokenize variant selections as separate path elements like `{set=var}`.
        // Accept one-or-more variant selection blocks as a "segment".
        if (name.startsWith('{') && name.endsWith('}')) {
            const chunks = name.split('}').filter(Boolean).map((c) => c + '}');
            return chunks.length > 0 && chunks.every((c) => variantSel.test(c));
        }

        return false;
    }

    static parse(path: string): SdfPath {
        if (path === '/') return SdfPath.absoluteRoot;
        if (!path || path[0] !== '/') throw new Error(`SdfPath must be absolute: ${path}`);

        // Property paths can include an optional "field" after a second dot:
        //   /Prim.prop
        //   /Prim.prop.connect
        const dot = path.indexOf('.');
        if (dot !== -1) {
            const prim = path.slice(0, dot);
            const rest = path.slice(dot + 1);
            if (!rest) throw new Error(`Invalid property path (empty property): ${path}`);
            const [prop, field, extra] = rest.split('.');
            if (!prop) throw new Error(`Invalid property path (empty property): ${path}`);
            if (extra !== undefined) throw new Error(`Invalid property path (too many fields): ${path}`);
            return SdfPath.property(prim, prop, field ?? null);
        }

        return SdfPath.prim(path);
    }

    static prim(absolutePrimPath: string): SdfPath {
        const p = SdfPath.normalizePrimPath(absolutePrimPath);
        return new SdfPath('prim', p, null, null);
    }

    static property(absolutePrimPath: string, propertyName: string, propertyField: string | null = null): SdfPath {
        const prim = SdfPath.normalizePrimPath(absolutePrimPath);
        if (!SdfPath.isValidIdentifier(propertyName)) {
            throw new Error(`Invalid property identifier: ${propertyName}`);
        }
        if (propertyField !== null && !SdfPath.isValidIdentifier(propertyField)) {
            throw new Error(`Invalid property field identifier: ${propertyField}`);
        }
        return new SdfPath('property', prim, propertyName, propertyField);
    }

    static child(parent: SdfPath, childName: string): SdfPath {
        if (parent.kind !== 'prim') throw new Error(`child() requires a prim path, got: ${parent.toString()}`);
        if (!SdfPath.isValidIdentifier(childName)) throw new Error(`Invalid prim identifier: ${childName}`);
        const base = parent.primPath === '/' ? '' : parent.primPath;
        return new SdfPath('prim', `${base}/${childName}`, null, null);
    }

    parent(): SdfPath | null {
        if (this.primPath === '/') return null;
        const parts = this.primPath.split('/').filter(Boolean);
        parts.pop();
        const p = '/' + parts.join('/');
        return new SdfPath('prim', p === '' ? '/' : p, null, null);
    }

    name(): string {
        if (this.primPath === '/') return '';
        const parts = this.primPath.split('/').filter(Boolean);
        return parts[parts.length - 1] ?? '';
    }

    toString(): string {
        if (this.kind === 'prim') return this.primPath;
        const base = `${this.primPath}.${this.propertyName}`;
        return this.propertyField ? `${base}.${this.propertyField}` : base;
    }

    private static normalizePrimPath(path: string): string {
        if (path === '/') return '/';
        if (!path || path[0] !== '/') throw new Error(`Prim path must be absolute: ${path}`);
        const parts = path.split('/').filter(Boolean);
        if (parts.length === 0) return '/';
        for (const part of parts) {
            if (!SdfPath.isValidIdentifier(part)) throw new Error(`Invalid prim identifier: ${part}`);
        }
        return '/' + parts.join('/');
    }
}


