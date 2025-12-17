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

test('external corpus: PayloadAndReference puzzle composes Character (smoke)', async () => {
  if (!fs.existsSync(externalRoot)) {
    test.skip('external corpus not downloaded');
    return;
  }

  const shot = path.join(
    externalRoot,
    'usd-wg-assets',
    'assets-main',
    'docs',
    'CompositionPuzzles',
    'PayloadAndReference',
    'problem',
    'shot.usda'
  );
  if (!fs.existsSync(shot)) {
    test.skip('expected corpus file missing');
    return;
  }

  const src = fs.readFileSync(shot, 'utf8');
  const resolver = {
    async readText(assetPath, fromIdentifier) {
      const resolved = resolveAssetPath(assetPath, fromIdentifier);
      const abs = path.isAbsolute(resolved) ? resolved : path.join(pkgRoot, resolved);
      const text = fs.readFileSync(abs, 'utf8');
      return { identifier: abs, text };
    },
  };

  const stage = await UsdStage.openUSDAWithResolver(src, resolver, shot);
  const composed = await stage.composePrimIndexWithResolver(resolver);

  // Assert the prim exists after composition. (Exact radius semantics will evolve with full Pcp.)
  const character = composed.getPrim(SdfPath.parse('/World/Character'));
  assert.ok(character);
});


