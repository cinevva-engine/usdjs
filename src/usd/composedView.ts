import { SdfPath } from '../sdf/path.js';
import type { SdfLayer, SdfLayerLike, SdfPrimSpec, SdfPropertySpec, SdfValue, SdfVariantSetSpec } from '../sdf/layer.js';
import type { UsdResolver } from './resolver.js';

export type SourceSite = {
  /** Source prim spec (shared, immutable-ish) */
  prim: SdfPrimSpec;
  /** Path root in the source prim tree that should be remapped */
  srcRoot: string;
  /** Destination root path this source is being applied onto */
  dstRoot: string;
  /** Higher means stronger */
  strength: number;
  /** Optional: the identifier/layer this opinion came from (debug) */
  fromIdentifier?: string;
};

export type ComposeContext = {
  /** Layers weak-to-strong (USD sublayers weakest → root strongest) */
  layersWeakToStrong: SdfLayer[];
  resolver: UsdResolver;
  /** Identifier used to resolve relative assets when composed layer identifier is synthetic */
  baseIdentifier: string;

  // caches
  primViewCache: Map<string, PrimView>;
  /** Preloaded external arc sites per destination prim path (weak opinions) */
  externalArcSites: Map<string, SourceSite[]>;
  /** Strong metadata overrides per destination prim path (no remap; already in destination coordinates) */
  metadataOverrides: Map<string, Record<string, SdfValue>>;
  /** Guard for internal recursion (internal refs/inherits) */
  inProgress: Set<string>;

  // helpers from stage.ts (passed in to avoid circular deps)
  resolveAssetPath: (assetPath: string, fromIdentifier?: string) => string;
  extractArcRefs: (v: SdfValue | undefined) => Array<{ assetPath: string; targetPath?: string; fromIdentifier?: string }>;
  extractInternalRefPaths: (v: SdfValue | undefined) => string[];
  pickSourcePrim: (layer: SdfLayer, targetPath?: string) => SdfPrimSpec | null;
  remapSdfValue: (v: SdfValue, srcRoot: string, dstRoot: string) => SdfValue;
};

/**
 * A tiny Map-like view that preserves authored order.
 *
 * - Keys are ordered by strongest source's insertion order first, then missing keys appended
 *   from the next sources in order, etc.
 * - Values are computed lazily.
 *
 * We intentionally implement only the subset of Map used by the codebase.
 */
class MapView<V> {
  private keysCache: string[] | null = null;
  private valueCache: Map<string, V> | null = null;

  constructor(
    private readonly getOrderedKeys: () => string[],
    private readonly getValueForKey: (k: string) => V | undefined,
  ) {}

  private ensureKeys(): string[] {
    if (!this.keysCache) this.keysCache = this.getOrderedKeys();
    return this.keysCache;
  }

  get size(): number {
    return this.ensureKeys().length;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  get(key: string): V | undefined {
    this.valueCache ??= new Map();
    const cached = this.valueCache.get(key);
    if (cached !== undefined) return cached;
    const v = this.getValueForKey(key);
    if (v !== undefined) this.valueCache.set(key, v);
    return v;
  }

  keys(): IterableIterator<string> {
    return this.ensureKeys()[Symbol.iterator]();
  }

  *values(): IterableIterator<V> {
    for (const k of this.ensureKeys()) {
      const v = this.get(k);
      if (v !== undefined) yield v;
    }
  }

  *entries(): IterableIterator<[string, V]> {
    for (const k of this.ensureKeys()) {
      const v = this.get(k);
      if (v !== undefined) yield [k, v];
    }
  }

  [Symbol.iterator](): IterableIterator<[string, V]> {
    return this.entries();
  }

  forEach(cb: (value: V, key: string, map: any) => void): void {
    for (const [k, v] of this.entries()) cb(v, k, this as any);
  }
}

function unionKeysAuthoredOrder(
  sitesStrongToWeak: SourceSite[],
  getMap: (p: SdfPrimSpec) => Map<string, any> | undefined,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of sitesStrongToWeak) {
    const m = getMap(s.prim);
    if (!m) continue;
    for (const k of m.keys()) {
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

/**
 * Property view: merges per-field, strong-over-weak, and remaps embedded SdfValues lazily.
 */
class PropertyView implements SdfPropertySpec {
  path: SdfPath;

  private computedTypeName: string | null = null;
  private computedDefaultValue: SdfValue | undefined | null = null;
  private computedTimeSamples: Map<number, SdfValue> | undefined | null = null;
  private metadataCache: Map<string, SdfValue | undefined> | null = null;
  private metadataProxy: Record<string, SdfValue> | undefined = undefined;

  constructor(
    private readonly primPath: string,
    private readonly propKey: string,
    private readonly specsStrongToWeak: Array<{ spec: SdfPropertySpec; site: SourceSite }>,
    private readonly remap: (v: SdfValue, srcRoot: string, dstRoot: string) => SdfValue,
  ) {
    const lastDot = propKey.lastIndexOf('.');
    const propName = lastDot > 0 ? propKey.slice(0, lastDot) : propKey;
    const fieldName = lastDot > 0 ? propKey.slice(lastDot + 1) : null;
    // Fast/unsafe path creation is fine here; we are constructing valid paths from parsed keys.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.path = (SdfPath as any).propertyUnsafe ? (SdfPath as any).propertyUnsafe(primPath, propName, fieldName) : SdfPath.property(primPath, propName, fieldName);
  }

  get typeName(): string {
    if (this.computedTypeName !== null) return this.computedTypeName;
    for (const { spec } of this.specsStrongToWeak) {
      if (spec.typeName) {
        this.computedTypeName = spec.typeName;
        return spec.typeName;
      }
    }
    this.computedTypeName = 'unknown';
    return 'unknown';
  }

  get defaultValue(): SdfValue | undefined {
    if (this.computedDefaultValue !== null) return this.computedDefaultValue ?? undefined;
    for (const { spec, site } of this.specsStrongToWeak) {
      if (spec.defaultValue !== undefined) {
        const v = site.srcRoot === site.dstRoot ? spec.defaultValue : this.remap(spec.defaultValue as any, site.srcRoot, site.dstRoot);
        this.computedDefaultValue = v;
        return v;
      }
    }
    this.computedDefaultValue = undefined;
    return undefined;
  }

  get timeSamples(): Map<number, SdfValue> | undefined {
    if (this.computedTimeSamples !== null) return this.computedTimeSamples ?? undefined;
    // Merge strong-over-weak per time key.
    const merged = new Map<number, SdfValue>();
    let any = false;
    // iterate weak->strong so strong overwrites
    for (let i = this.specsStrongToWeak.length - 1; i >= 0; i--) {
      const { spec, site } = this.specsStrongToWeak[i]!;
      const ts = spec.timeSamples;
      if (!ts || ts.size === 0) continue;
      any = true;
      for (const [t, v0] of ts.entries()) {
        const v = site.srcRoot === site.dstRoot ? v0 : this.remap(v0 as any, site.srcRoot, site.dstRoot);
        merged.set(t, v);
      }
    }
    this.computedTimeSamples = any ? merged : undefined;
    return this.computedTimeSamples ?? undefined;
  }

  get metadata(): Record<string, SdfValue> | undefined {
    if (this.metadataProxy) return this.metadataProxy;
    const cache = (this.metadataCache ??= new Map());
    const handler: ProxyHandler<any> = {
      get: (_t, prop) => {
        if (typeof prop !== 'string') return undefined;
        if (cache.has(prop)) return cache.get(prop);
        for (const { spec, site } of this.specsStrongToWeak) {
          const md = spec.metadata;
          if (!md) continue;
          if (!(prop in md)) continue;
          const raw = (md as any)[prop] as SdfValue;
          const v = site.srcRoot === site.dstRoot ? raw : this.remap(raw, site.srcRoot, site.dstRoot);
          cache.set(prop, v);
          return v;
        }
        cache.set(prop, undefined);
        return undefined;
      },
      has: (_t, prop) => {
        if (typeof prop !== 'string') return false;
        return this.metadata?.[prop] !== undefined;
      },
      ownKeys: () => {
        const keys: string[] = [];
        const seen = new Set<string>();
        for (const { spec } of this.specsStrongToWeak) {
          const md = spec.metadata;
          if (!md) continue;
          for (const k of Object.keys(md)) {
            if (seen.has(k)) continue;
            seen.add(k);
            keys.push(k);
          }
        }
        return keys;
      },
      getOwnPropertyDescriptor: (_t, prop) => {
        if (typeof prop !== 'string') return undefined;
        return { enumerable: true, configurable: true };
      },
    };
    this.metadataProxy = new Proxy({}, handler) as any;
    return this.metadataProxy;
  }
}

/**
 * Prim view: structural-sharing overlay of multiple source prims applied at a destination path.
 *
 * - Preserves authored order by ordering keys from strongest sources first.
 * - Does NOT clone child/property graphs.
 */
export class PrimView implements SdfPrimSpec {
  path: SdfPath;
  specifier: 'def' | 'over' | 'class' = 'def';

  private sitesStrongToWeak: SourceSite[];

  private metadataCache: Map<string, SdfValue | undefined> | null = null;
  private metadataProxy: Record<string, SdfValue> | undefined = undefined;

  private childrenView: MapView<SdfPrimSpec> | null = null;
  private propsView: MapView<SdfPropertySpec> | null = null;

  private computedTypeName: string | undefined | null = null;
  private computedVariantSets: Map<string, SdfVariantSetSpec> | undefined | null = null;

  constructor(
    private readonly ctx: ComposeContext,
    public readonly primPath: string,
    sitesStrongToWeak: SourceSite[],
  ) {
    // Fast/unsafe path creation is fine here; constructed paths are valid by construction.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.path = (SdfPath as any).primUnsafe ? (SdfPath as any).primUnsafe(primPath) : SdfPath.prim(primPath);
    this.sitesStrongToWeak = sitesStrongToWeak;
  }

  get typeName(): string | undefined {
    if (this.computedTypeName !== null) return this.computedTypeName ?? undefined;
    // Important: typeName can be introduced via arcs (external refs/payloads, internal refs, inherits/specializes).
    // If we only consult the base layer-stack sites, we can end up with properties from arcs but a missing typeName.
    const sites = this.sitesWithArcsApplied();
    for (const s of sites) {
      if (s.prim.typeName) {
        this.computedTypeName = s.prim.typeName;
        return s.prim.typeName;
      }
    }
    this.computedTypeName = undefined;
    return undefined;
  }

  get variantSets(): Map<string, SdfVariantSetSpec> | undefined {
    if (this.computedVariantSets !== null) return this.computedVariantSets ?? undefined;
    // Use strongest available variantSets; this preserves authored order and matches "strong wins" semantics.
    for (const s of this.sitesStrongToWeak) {
      const vs = (s.prim as any).variantSets as Map<string, SdfVariantSetSpec> | undefined;
      if (vs && vs.size > 0) {
        this.computedVariantSets = vs;
        return vs;
      }
    }
    this.computedVariantSets = undefined;
    return undefined;
  }

  get metadata(): Record<string, SdfValue> | undefined {
    if (this.metadataProxy) return this.metadataProxy;
    const cache = (this.metadataCache ??= new Map());
    const handler: ProxyHandler<any> = {
      get: (_t, prop) => {
        if (typeof prop !== 'string') return undefined;
        if (cache.has(prop)) return cache.get(prop);
        // Strong overrides win.
        const o = this.ctx.metadataOverrides.get(this.primPath);
        if (o && prop in o) {
          const v = (o as any)[prop] as SdfValue;
          cache.set(prop, v);
          return v;
        }
        for (const s of this.sitesStrongToWeak) {
          const md = s.prim.metadata;
          if (!md) continue;
          if (!(prop in md)) continue;
          const raw = (md as any)[prop] as SdfValue;
          const v = s.srcRoot === s.dstRoot ? raw : this.ctx.remapSdfValue(raw, s.srcRoot, s.dstRoot);
          cache.set(prop, v);
          return v;
        }
        cache.set(prop, undefined);
        return undefined;
      },
      ownKeys: () => {
        const keys: string[] = [];
        const seen = new Set<string>();
        const o = this.ctx.metadataOverrides.get(this.primPath);
        if (o) {
          for (const k of Object.keys(o)) {
            if (seen.has(k)) continue;
            seen.add(k);
            keys.push(k);
          }
        }
        for (const s of this.sitesStrongToWeak) {
          const md = s.prim.metadata;
          if (!md) continue;
          for (const k of Object.keys(md)) {
            if (seen.has(k)) continue;
            seen.add(k);
            keys.push(k);
          }
        }
        return keys;
      },
      getOwnPropertyDescriptor: (_t, prop) => {
        if (typeof prop !== 'string') return undefined;
        return { enumerable: true, configurable: true };
      },
    };
    this.metadataProxy = new Proxy({}, handler) as any;
    return this.metadataProxy;
  }

  get children(): Map<string, SdfPrimSpec> | undefined {
    if (this.childrenView) return this.childrenView as any;
    const sites = this.sitesWithArcsApplied();
    const keys = () => unionKeysAuthoredOrder(sites, (p) => p.children);
    const getChild = (name: string): SdfPrimSpec | undefined => {
      const childSites: SourceSite[] = [];
      for (const s of sites) {
        const c = s.prim.children?.get(name);
        if (!c) continue;
        childSites.push({ ...s, prim: c });
      }
      if (childSites.length === 0) return undefined;
      return getPrimView(this.ctx, this.childPath(name), childSites);
    };
    this.childrenView = new MapView(keys, getChild);
    return this.childrenView as any;
  }

  get properties(): Map<string, SdfPropertySpec> | undefined {
    if (this.propsView) return this.propsView as any;
    const sites = this.sitesWithArcsApplied();
    const keys = () => unionKeysAuthoredOrder(sites, (p) => p.properties);
    const getProp = (k: string): SdfPropertySpec | undefined => {
      const specs: Array<{ spec: SdfPropertySpec; site: SourceSite }> = [];
      for (const s of sites) {
        const ps = s.prim.properties?.get(k);
        if (!ps) continue;
        specs.push({ spec: ps, site: s });
      }
      if (specs.length === 0) return undefined;
      return new PropertyView(this.primPath, k, specs, this.ctx.remapSdfValue);
    };
    this.propsView = new MapView(keys, getProp);
    return this.propsView as any;
  }

  private childPath(name: string): string {
    return this.primPath === '/' ? `/${name}` : `${this.primPath}/${name}`;
  }

  /**
   * Compute the effective sites for this prim including:
   * - base layer-stack opinions
   * - variant selections (strong)
   * - internal references/inherits (weak by default)
   * - external references/payloads (weak)
   *
   * This is cached by the PrimView instance via reuse of MapView caches, not globally.
   */
  private sitesWithArcsApplied(): SourceSite[] {
    // We keep this simple and safe: compute additional sources based on currently-visible metadata.
    // Importantly, we preserve authored order by appending weaker sources at the end (strong-first list).
    const base = this.sitesStrongToWeak;
    const out: SourceSite[] = [...base];

    // 1) Variant selection: treat selected variant prim as STRONGEST.
    const vs = this.variantSets;
    const variantsMeta = this.metadata?.variants;
    if (vs && variantsMeta && typeof variantsMeta === 'object' && (variantsMeta as any).type === 'dict') {
      const selDict = (variantsMeta as any).value as Record<string, any> | undefined;
      if (selDict) {
        for (const [setName, set] of vs.entries()) {
          const selection = selDict[setName];
          const variantName =
            typeof selection === 'string'
              ? selection
              : selection && typeof selection === 'object' && ((selection as any).type === 'token' || (selection as any).type === 'string')
                ? (selection as any).value
                : null;
          if (!variantName) continue;
          const variantPrim = set.variants.get(variantName);
          if (!variantPrim) continue;
          // Insert as strongest (front), preserving authored priority.
          out.unshift({
            prim: variantPrim,
            srcRoot: variantPrim.path.primPath,
            dstRoot: this.primPath,
            strength: (out[0]?.strength ?? 0) + 1,
            fromIdentifier: 'variant',
          });
        }
      }
    }

    // 2) Internal refs: weaker than local. Apply in reverse (prepend semantics => first is strongest).
    const internalRefs = this.ctx.extractInternalRefPaths(this.metadata?.references);
    if (internalRefs.length) {
      for (const p of [...internalRefs].reverse()) {
        const refPrim = this.ctx.primViewCache.get(p)?.asSourcePrim() ?? null;
        // If we don't have a primView yet, resolve it through the composed layer (may recurse).
        const ref = getPrimViewForPath(this.ctx, p);
        const srcPrim = ref?.asSourcePrim() ?? null;
        if (!srcPrim) continue;
        out.push({
          prim: srcPrim,
          srcRoot: srcPrim.path.primPath,
          dstRoot: this.primPath,
          strength: -1, // weak
          fromIdentifier: 'internalRef',
        });
      }
    }

    // 3) Specializes: weak by default (specializes should not override local opinions).
    const specializes = this.ctx.extractInternalRefPaths((this.metadata as any)?.specializes);
    if (specializes.length) {
      for (const p of [...specializes].reverse()) {
        const ref = getPrimViewForPath(this.ctx, p);
        const srcPrim = ref?.asSourcePrim() ?? null;
        if (!srcPrim) continue;
        out.push({
          prim: srcPrim,
          srcRoot: srcPrim.path.primPath,
          dstRoot: this.primPath,
          strength: -1,
          fromIdentifier: 'specializes',
        });
      }
    }

    // 4) Inherits:
    // In USD, inherited opinions are generally weaker than local authored opinions on the inheriting prim.
    // However, in practice (see usd-wg-assets `inherit_and_specialize.usda`), an inherited class can be
    // overridden at a *stronger* site (e.g. local override inside a referencing prim) while the inheriting
    // prim itself comes from a *weaker* site (e.g. introduced via internal reference).
    //
    // We approximate this by comparing coarse base-site strengths:
    // - if the inherited source prim is present in a stronger base site than the inheriting prim,
    //   treat inherited opinions as stronger (insert before base sites).
    // - otherwise, keep inherited opinions weak (append).
    const inherits = this.ctx.extractInternalRefPaths((this.metadata as any)?.inherits);
    if (inherits.length) {
      const strongestBaseStrengthFor = (primPath: string): number => {
        try {
          const sdf = SdfPath.parse(primPath);
          for (let i = this.ctx.layersWeakToStrong.length - 1; i >= 0; i--) {
            const layer = this.ctx.layersWeakToStrong[i]!;
            const p = layer.getPrim(sdf);
            if (p) return i;
          }
        } catch {
          // ignore
        }
        return -1_000_000;
      };

      const dstStrength = out[0]?.strength ?? 0;
      for (const p of [...inherits].reverse()) {
        const ref = getPrimViewForPath(this.ctx, p);
        const srcPrim = ref?.asSourcePrim() ?? null;
        if (!srcPrim) continue;
        const srcStrength = strongestBaseStrengthFor(p);
        const site: SourceSite = {
          prim: srcPrim,
          srcRoot: srcPrim.path.primPath,
          dstRoot: this.primPath,
          strength: srcStrength > dstStrength ? dstStrength + 1 : -1,
          fromIdentifier: 'inherits',
        };
        if (srcStrength > dstStrength) out.unshift(site);
        else out.push(site);
      }
    }

    // 5) External refs/payloads: applied from a preloaded table (weak opinions).
    const ext = this.ctx.externalArcSites.get(this.primPath);
    if (ext && ext.length) out.push(...ext);

    return out;
  }

  /** For internal resolution helpers; returns the strongest source prim. */
  asSourcePrim(): SdfPrimSpec | null {
    return this.sitesStrongToWeak[0]?.prim ?? null;
  }
}

export function getPrimView(ctx: ComposeContext, primPath: string, sitesStrongToWeak: SourceSite[]): PrimView {
  // Compose cache key: primPath + identities of strongest source prims.
  // We keep it simple and safe: cache by primPath only for now (stage-level view cache),
  // assuming a single composed layer context.
  const existing = ctx.primViewCache.get(primPath);
  if (existing) return existing;
  const v = new PrimView(ctx, primPath, sitesStrongToWeak);
  ctx.primViewCache.set(primPath, v);
  return v;
}

export function getPrimViewForPath(ctx: ComposeContext, primPath: string): PrimView | null {
  const p = primPath === '/' ? '/' : primPath;
  // Build base sites from layer stack at this primPath
  const sdfPath = SdfPath.parse(p);
  const sites: SourceSite[] = [];
  // strongest-first
  for (let i = ctx.layersWeakToStrong.length - 1; i >= 0; i--) {
    const layer = ctx.layersWeakToStrong[i]!;
    const prim = layer.getPrim(sdfPath);
    if (!prim) continue;
    sites.push({
      prim,
      srcRoot: prim.path.primPath,
      dstRoot: p,
      strength: i,
      fromIdentifier: layer.identifier,
    });
  }
  if (sites.length === 0) return null;
  return getPrimView(ctx, p, sites);
}

/**
 * Layer view: a structural-sharing layer surface compatible with the viewer/runtime.
 *
 * - `root` is a `PrimView` over the layerStack roots.
 * - `metadata` is a strong-over-weak proxy over layer metadata.
 */
export class LayerView implements SdfLayerLike {
  readonly metadata: Record<string, SdfValue>;
  readonly root: SdfPrimSpec;

  private metadataCache = new Map<string, SdfValue | undefined>();

  constructor(public readonly identifier: string, private readonly ctx: ComposeContext) {
    const rootView = getPrimViewForPath(ctx, '/') ?? getPrimView(ctx, '/', [{
      prim: { path: SdfPath.absoluteRoot, specifier: 'def', typeName: 'Scope', metadata: {}, properties: new Map(), children: new Map() } as any,
      srcRoot: '/',
      dstRoot: '/',
      strength: 0
    }]);
    this.root = rootView;

    const handler: ProxyHandler<any> = {
      get: (_t, prop) => {
        if (typeof prop !== 'string') return undefined;
        if (this.metadataCache.has(prop)) return this.metadataCache.get(prop);
        // Strongest layer wins.
        for (let i = ctx.layersWeakToStrong.length - 1; i >= 0; i--) {
          const l = ctx.layersWeakToStrong[i]!;
          if (l.metadata && prop in l.metadata) {
            const v = (l.metadata as any)[prop] as SdfValue;
            this.metadataCache.set(prop, v);
            return v;
          }
        }
        this.metadataCache.set(prop, undefined);
        return undefined;
      },
      ownKeys: () => {
        const keys: string[] = [];
        const seen = new Set<string>();
        for (let i = ctx.layersWeakToStrong.length - 1; i >= 0; i--) {
          const l = ctx.layersWeakToStrong[i]!;
          for (const k of Object.keys(l.metadata ?? {})) {
            if (seen.has(k)) continue;
            seen.add(k);
            keys.push(k);
          }
        }
        return keys;
      },
      getOwnPropertyDescriptor: (_t, prop) => {
        if (typeof prop !== 'string') return undefined;
        return { enumerable: true, configurable: true };
      },
    };
    this.metadata = new Proxy({}, handler);
  }

  getPrim(path: SdfPath): SdfPrimSpec | null {
    const p = path.kind === 'prim' ? path.primPath : path.primPath;
    // Fast path: base layer-stack lookup.
    const direct = getPrimViewForPath(this.ctx, p);
    if (direct) return direct;

    // Slow path: resolve via traversing the composed root's child views.
    // This allows `getPrim()` to find prims introduced via internal refs / inherits / specializes
    // even when no base layer has a spec authored at that exact path.
    if (p === '/') return this.root;
    const parts = p.split('/').filter(Boolean);
    let cur: any = this.root;
    for (const name of parts) {
      const children = cur?.children;
      if (!children || typeof children.get !== 'function') return null;
      const next = children.get(name);
      if (!next) return null;
      cur = next;
    }
    return cur as any;
  }
}


