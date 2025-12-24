import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { UsdStage } from '../src/usd/stage.ts';
import { parseUsdaToLayer } from '../src/usda/parser.ts';
import { isUsdcContent } from '../src/usdc/parser.ts';

function isPlainObject(v) {
  return !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
}

function normSdfValue(v) {
  if (typeof v === 'number' && Number.isFinite(v) && !Number.isInteger(v)) {
    // Canonicalize floating-point noise between binary USDC and decimal USDA (usdcat) representations.
    // This keeps the test strict for integers while allowing stable float/double comparisons.
    return Math.round(v * 1e12) / 1e12;
  }
  // Strip parser-added metadata fields that don't exist in usdcat output.
  if (Array.isArray(v)) return v.map(normSdfValue);
  if (!v || typeof v !== 'object') return v;

  // Common usdjs SdfValue shapes
  if (v.type === 'reference') {
    const out = { ...v };
    delete out.__fromIdentifier;
    for (const k of Object.keys(out)) out[k] = normSdfValue(out[k]);
    return out;
  }
  if (v.type === 'asset') {
    const out = { ...v };
    delete out.__fromIdentifier;
    for (const k of Object.keys(out)) out[k] = normSdfValue(out[k]);
    return out;
  }
  if (v.type === 'array') {
    return { type: 'array', elementType: v.elementType, value: (v.value ?? []).map(normSdfValue) };
  }
  if (v.type === 'tuple') {
    return { type: 'tuple', value: (v.value ?? []).map(normSdfValue) };
  }
  if (v.type === 'dict') {
    const entries = Object.entries(v.value ?? {}).sort(([a], [b]) => a.localeCompare(b));
    return { type: 'dict', value: Object.fromEntries(entries.map(([k, val]) => [k, normSdfValue(val)])) };
  }

  // Typed arrays: compare by content
  if (v.type === 'typedArray') {
    return { type: 'typedArray', elementType: v.elementType, value: Array.from(v.value ?? []).map(normSdfValue) };
  }

  // token/sdfpath/vec/matrix: keep shape
  if ('type' in v && 'value' in v) {
    const out = { ...v };
    out.value = normSdfValue(out.value);
    return out;
  }

  if (isPlainObject(v)) {
    const entries = Object.entries(v).sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries.map(([k, val]) => [k, normSdfValue(val)]));
  }

  return v;
}

function shallowDiffObj(a, b, pathStr, out) {
  const ak = Object.keys(a ?? {}).sort();
  const bk = Object.keys(b ?? {}).sort();
  for (const k of ak) {
    if (!(k in (b ?? {}))) out.push(`${pathStr}: missing in B: ${k}`);
  }
  for (const k of bk) {
    if (!(k in (a ?? {}))) out.push(`${pathStr}: missing in A: ${k}`);
  }
}

function compareMaps(aMap, bMap, pathStr, out, valueCmp) {
  const aKeys = Array.from(aMap?.keys?.() ?? []).sort();
  const bKeys = Array.from(bMap?.keys?.() ?? []).sort();
  for (const k of aKeys) if (!bMap?.has?.(k)) out.push(`${pathStr}: missing in B: ${k}`);
  for (const k of bKeys) if (!aMap?.has?.(k)) out.push(`${pathStr}: missing in A: ${k}`);
  for (const k of aKeys) {
    if (!bMap?.has?.(k)) continue;
    valueCmp(aMap.get(k), bMap.get(k), `${pathStr}.${k}`, out);
  }
}

function cmpValue(a, b, pathStr, out) {
  const na = normSdfValue(a);
  const nb = normSdfValue(b);
  const sa = JSON.stringify(na);
  const sb = JSON.stringify(nb);
  if (sa !== sb) {
    out.push(`${pathStr}: value mismatch\n  A=${sa}\n  B=${sb}`);
  }
}

function cmpProp(aProp, bProp, pathStr, out) {
  if (!aProp || !bProp) return;
  if (aProp.typeName !== bProp.typeName) out.push(`${pathStr}.typeName: ${aProp.typeName} vs ${bProp.typeName}`);
  if ((aProp.variability ?? null) !== (bProp.variability ?? null)) out.push(`${pathStr}.variability: ${aProp.variability} vs ${bProp.variability}`);
  cmpValue(aProp.defaultValue ?? null, bProp.defaultValue ?? null, `${pathStr}.defaultValue`, out);
  shallowDiffObj(aProp.metadata ?? {}, bProp.metadata ?? {}, `${pathStr}.metadataKeys`, out);
  // Time samples: just compare keys + raw values
  const aTs = aProp.timeSamples;
  const bTs = bProp.timeSamples;
  const aK = Array.from(aTs?.keys?.() ?? []).sort((x, y) => x - y);
  const bK = Array.from(bTs?.keys?.() ?? []).sort((x, y) => x - y);
  if (JSON.stringify(aK) !== JSON.stringify(bK)) out.push(`${pathStr}.timeSamples.keys mismatch: A=${JSON.stringify(aK)} B=${JSON.stringify(bK)}`);
  for (const t of aK) {
    if (!bTs?.has?.(t)) continue;
    cmpValue(aTs.get(t), bTs.get(t), `${pathStr}.timeSamples[${t}]`, out);
  }
}

function cmpPrim(aPrim, bPrim, pathStr, out) {
  if (!aPrim || !bPrim) return;
  if ((aPrim.specifier ?? null) !== (bPrim.specifier ?? null)) out.push(`${pathStr}.specifier: ${aPrim.specifier} vs ${bPrim.specifier}`);
  if ((aPrim.typeName ?? null) !== (bPrim.typeName ?? null)) out.push(`${pathStr}.typeName: ${aPrim.typeName} vs ${bPrim.typeName}`);
  shallowDiffObj(aPrim.metadata ?? {}, bPrim.metadata ?? {}, `${pathStr}.metadataKeys`, out);

  compareMaps(aPrim.properties, bPrim.properties, `${pathStr}.properties`, out, cmpProp);
  compareMaps(aPrim.children, bPrim.children, `${pathStr}.children`, out, (ac, bc, childPath, out2) => {
    cmpPrim(ac, bc, childPath, out2);
  });

  // Variant sets (if any)
  compareMaps(aPrim.variantSets, bPrim.variantSets, `${pathStr}.variantSets`, out, (aVs, bVs, vsPath, out2) => {
    if (!aVs || !bVs) return;
    if (aVs.name !== bVs.name) out2.push(`${vsPath}.name: ${aVs.name} vs ${bVs.name}`);
    compareMaps(aVs.variants, bVs.variants, `${vsPath}.variants`, out2, (ap, bp, vp, out3) => cmpPrim(ap, bp, vp, out3));
  });
}

function cmpLayer(aLayer, bLayer) {
  const out = [];
  shallowDiffObj(aLayer.metadata ?? {}, bLayer.metadata ?? {}, 'layer.metadataKeys', out);
  // compare metadata values for shared keys
  for (const k of Object.keys(aLayer.metadata ?? {})) {
    if (!(k in (bLayer.metadata ?? {}))) continue;
    cmpValue(aLayer.metadata[k], bLayer.metadata[k], `layer.metadata.${k}`, out);
  }
  cmpPrim(aLayer.root, bLayer.root, 'layer.root', out);
  return out;
}

function walk(dir, out, ignoreDirNames = new Set(['.thumbs', 'node_modules'])) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ignoreDirNames.has(ent.name)) continue;
      walk(p, out, ignoreDirNames);
    } else if (ent.isFile()) {
      out.push(p);
    }
  }
}

function sha1Short(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function parseArgs(argv) {
  const args = {
    root: 'packages/usdjs/test/corpus/external',
    // Extensions to include (comma-separated via --exts). Defaults to "all USD layer-like files".
    exts: '.usd,.usda,.usdc',
    concurrency: 2,
    limit: 0,
    outDir: 'temp/usdcat_compare/all',
    logPath: 'temp/usdcat_compare/compare_all_external_usd.log',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = argv[++i];
    else if (a === '--ext') args.exts = argv[++i]; // backwards compat: single ext
    else if (a === '--exts') args.exts = argv[++i];
    else if (a === '--concurrency') args.concurrency = Number(argv[++i] ?? '2');
    else if (a === '--limit') args.limit = Number(argv[++i] ?? '0');
    else if (a === '--outDir') args.outDir = argv[++i];
    else if (a === '--logPath') args.logPath = argv[++i];
  }
  if (!Number.isFinite(args.concurrency) || args.concurrency < 1) args.concurrency = 1;
  if (!Number.isFinite(args.limit) || args.limit < 0) args.limit = 0;
  return args;
}

function safeRel(p) {
  return p.split(path.sep).join('/');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  ensureDir(path.dirname(args.logPath));
  ensureDir(args.outDir);

  const all = [];
  walk(args.root, all);
  const exts = String(args.exts ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  let files = all.filter((p) => exts.some((ext) => p.endsWith(ext)));
  files.sort();
  if (args.limit > 0) files = files.slice(0, args.limit);

  const log = [];
  log.push(`=== usdcat compare all ===`);
  log.push(`root: ${args.root}`);
  log.push(`exts: ${args.exts}`);
  log.push(`count: ${files.length}`);
  log.push(`concurrency: ${args.concurrency}`);
  log.push(`outDir: ${args.outDir}`);
  log.push('');

  let ok = 0;
  let failed = 0;
  let errored = 0;

  const failures = [];

  let idx = 0;
  const workers = Array.from({ length: args.concurrency }, async () => {
    while (true) {
      const myIdx = idx++;
      if (myIdx >= files.length) return;
      const file = files[myIdx];
      const rel = safeRel(file);

      try {
        const buf = fs.readFileSync(file);

        // Parse original using usdjs, selecting USDC vs USDA based on magic.
        let stageOk = true;
        let layerA = null;
        try {
          const stage = isUsdcContent(buf) ? UsdStage.openUSDC(buf, rel) : UsdStage.openUSDA(buf.toString('utf8'), rel);
          layerA = stage.rootLayer;
        } catch (e) {
          stageOk = false;
        }

        // usdcat -> USDA
        let usdcatOk = true;
        let layerB = null;
        const outName = `${path.basename(file)}.${sha1Short(rel)}.usda`;
        const outPath = path.join(args.outDir, outName);
        try {
          execFileSync('usdcat', ['-o', outPath, file], { stdio: 'ignore' });
          const usdcatText = fs.readFileSync(outPath, 'utf8');
          layerB = parseUsdaToLayer(usdcatText, { identifier: outPath });
        } catch (e) {
          usdcatOk = false;
        }

        if (!stageOk && !usdcatOk) {
          ok++;
          if ((ok + failed + errored) % 50 === 0) {
            log.push(`[progress] done=${ok + failed + errored}/${files.length} ok=${ok} failed=${failed} err=${errored}`);
          }
          // Both reject the file (expected for some USD-WG invalid-stage-configuration tests).
          continue;
        }

        if (stageOk && !usdcatOk) {
          failed++;
          log.push(`FAIL ${rel} (usdcat failed but usdjs succeeded)`);
          continue;
        }
        if (!stageOk && usdcatOk) {
          failed++;
          log.push(`FAIL ${rel} (usdjs failed but usdcat succeeded)`);
          continue;
        }

        const diffs = cmpLayer(layerA, layerB);
        if (diffs.length === 0) {
          ok++;
          if ((ok + failed + errored) % 50 === 0) {
            log.push(`[progress] done=${ok + failed + errored}/${files.length} ok=${ok} failed=${failed} err=${errored}`);
          }
          continue;
        }

        failed++;
        failures.push({ file: rel, diffCount: diffs.length, top: diffs.slice(0, 3) });
        log.push(`FAIL ${rel} (diffs=${diffs.length})`);
        for (const d of diffs.slice(0, 10)) {
          log.push(`  - ${d.split('\n')[0]}`);
        }
      } catch (e) {
        errored++;
        const msg = e && typeof e === 'object' && 'message' in e ? e.message : String(e);
        log.push(`ERROR ${rel}: ${msg}`);
      }
    }
  });

  await Promise.all(workers);

  log.push('');
  log.push(`=== summary ===`);
  log.push(`ok=${ok}`);
  log.push(`failed=${failed}`);
  log.push(`errored=${errored}`);
  log.push('');
  if (failures.length) {
    log.push('=== top failures (first 50) ===');
    for (const f of failures.slice(0, 50)) {
      log.push(`${f.file} (diffs=${f.diffCount})`);
      for (const d of f.top) log.push(`  ${d.split('\n')[0]}`);
    }
  }

  fs.writeFileSync(args.logPath, log.join('\n') + '\n', 'utf8');

  console.log(`done. ok=${ok} failed=${failed} errored=${errored}`);
  console.log(`log: ${args.logPath}`);
}

await main();


