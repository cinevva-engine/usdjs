import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { UsdStage, SdfPath } from '../../dist/index.js';

function readDisplayColor03(prim) {
  const prop = prim?.properties?.get('primvars:displayColor');
  const dv = prop?.defaultValue;
  // Parser may represent this as raw JS arrays or as SdfValue structures.
  if (Array.isArray(dv) && dv.length > 0) return dv[0];
  if (dv && typeof dv === 'object' && dv.type === 'typedArray' && dv.value) {
    // color3f[] is commonly stored as a typed array in our parser.
    // For a single authored color, dv.value is a Float32Array of length 3.
    return Array.from(dv.value);
  }
  if (dv && typeof dv === 'object' && dv.type === 'array' && Array.isArray(dv.value) && dv.value.length > 0) {
    const first = dv.value[0];
    if (Array.isArray(first)) return first;
    if (first && typeof first === 'object' && first.type === 'tuple' && Array.isArray(first.value)) return first.value;
  }
  if (dv && typeof dv === 'object' && dv.type === 'tuple' && Array.isArray(dv.value)) return dv.value;
  return null;
}

function assertColorNear(actual, expected, eps = 1e-6) {
  assert.ok(actual, 'expected a color');
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < expected.length; i++) {
    assert.ok(Math.abs(actual[i] - expected[i]) <= eps, `channel ${i} expected ${expected[i]} got ${actual[i]}`);
  }
}

test('usd-wg-assets: inherit_and_specialize internal reference + inherits matches usdrecord (top-right green)', async () => {
  const pkgRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const file = path.join(
    pkgRoot,
    'test',
    'corpus',
    'external',
    'usd-wg-assets',
    'assets-main',
    'test_assets',
    'foundation',
    'stage_composition',
    'inherit_and_specialize.usda'
  );

  if (!fs.existsSync(file)) {
    test.skip('external corpus not downloaded');
    return;
  }

  const src = fs.readFileSync(file, 'utf8');
  // This asset uses internal references only; resolver should not be invoked.
  const resolver = {
    async readText() {
      throw new Error('unexpected resolver.readText() for internal reference test');
    },
  };

  const stage = await UsdStage.openUSDAWithResolver(src, resolver, file);
  const composed = await stage.composePrimIndexWithResolver(resolver);

  const srcPrim = composed.getPrim(SdfPath.parse('/World/cubeSceneReferenced/source'));
  const specializesPrim = composed.getPrim(SdfPath.parse('/World/cubeSceneReferenced/specializes'));
  const inheritsPrim = composed.getPrim(SdfPath.parse('/World/cubeSceneReferenced/inherits'));
  assert.ok(srcPrim);
  assert.ok(specializesPrim);
  assert.ok(inheritsPrim);

  // usdrecord 22.08 screenshot shows:
  // - cubeSceneReferenced/source is green
  // - cubeSceneReferenced/specializes is yellow
  // - cubeSceneReferenced/inherits is green
  assertColorNear(readDisplayColor03(srcPrim), [0, 0.8, 0]);
  assertColorNear(readDisplayColor03(specializesPrim), [0.8, 0.8, 0]);
  assertColorNear(readDisplayColor03(inheritsPrim), [0, 0.8, 0]);
});


