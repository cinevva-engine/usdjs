import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { parseUsdaToLayer } from '../../dist/index.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const pkgRoot = path.resolve(here, '..', '..');
const curatedPath = path.join(pkgRoot, 'test', 'corpus', 'curated-ftlab-parser-files.json');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('external corpus: ft-lab curated USDA parser smoke (bounded)', () => {
  if (!fs.existsSync(curatedPath)) {
    test.skip('ft-lab curated list missing (run `npm run corpus:curate:ftlab`)');
    return;
  }
  const curated = readJson(curatedPath);
  const files = Array.isArray(curated.files) ? curated.files : [];
  if (files.length === 0) {
    test.skip('ft-lab curated list empty (run `npm run corpus:curate:ftlab`)');
    return;
  }

  // Bound runtime even if curated list is large.
  const maxToTest = 80;
  const subset = files.slice(0, maxToTest);

  let ok = 0;
  for (const rel of subset) {
    const abs = path.join(pkgRoot, rel);
    if (!fs.existsSync(abs)) continue;
    const src = fs.readFileSync(abs, 'utf8');
    parseUsdaToLayer(src, { identifier: rel });
    ok++;
  }
  assert.ok(ok > 0, 'expected to parse at least one ft-lab curated file');
});


