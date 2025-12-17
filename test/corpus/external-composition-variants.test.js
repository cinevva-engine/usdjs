import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { UsdStage, SdfPath } from '../../dist/index.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const pkgRoot = path.resolve(here, '..', '..');
const externalRoot = path.join(pkgRoot, 'test', 'corpus', 'external');

function resolveAssetPath(assetPath, fromIdentifier) {
  if (assetPath.startsWith('/') || assetPath.match(/^[A-Za-z]+:\/\//)) return assetPath;
  const base = fromIdentifier.replace(/\\/g, '/');
  const dir = base.includes('/') ? base.slice(0, base.lastIndexOf('/') + 1) : '';
  const joined = dir + assetPath;
  const parts = joined.split('/').filter((p) => p.length > 0);
  const out = [];
  for (const p of parts) {
    if (p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  const prefix = joined.startsWith('/') ? '/' : '';
  return prefix + out.join('/');
}

test('external corpus: VariantSetAndLocal1 puzzle applies selected variant (smoke)', async () => {
  if (!fs.existsSync(externalRoot)) {
    test.skip('external corpus not downloaded');
    return;
  }

  const file = path.join(
    externalRoot,
    'usd-wg-assets',
    'assets-main',
    'docs',
    'CompositionPuzzles',
    'VariantSetAndLocal1',
    'puzzle_1.usda'
  );
  if (!fs.existsSync(file)) {
    test.skip('expected corpus file missing');
    return;
  }

  const src = fs.readFileSync(file, 'utf8');
  const resolver = {
    async readText(assetPath, fromIdentifier) {
      const resolved = resolveAssetPath(assetPath, fromIdentifier);
      const abs = path.isAbsolute(resolved) ? resolved : path.join(pkgRoot, resolved);
      const text = fs.readFileSync(abs, 'utf8');
      return { identifier: abs, text };
    },
  };

  const stage = await UsdStage.openUSDAWithResolver(src, resolver, file);
  const composed = await stage.composePrimIndexWithResolver(resolver);
  const sphere = composed.getPrim(SdfPath.parse('/World/Sphere'));
  assert.ok(sphere);
  // In this puzzle, the selected variant is "small" which sets radius=2.
  assert.equal(sphere.properties.get('radius').defaultValue, 2);
});


