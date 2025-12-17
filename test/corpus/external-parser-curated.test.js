import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { parseUsdaToLayer } from '../../dist/index.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const pkgRoot = path.resolve(here, '..', '..');
const externalRoot = path.join(pkgRoot, 'test', 'corpus', 'external');
const curatedPath = path.join(pkgRoot, 'test', 'corpus', 'curated-parser-files.json');

function readJson(p) {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('external corpus: curated USDA parser smoke', () => {
    if (!fs.existsSync(externalRoot)) {
        test.skip('external corpus not downloaded (run `npm run corpus:fetch`)');
        return;
    }
    if (!fs.existsSync(curatedPath)) {
        test.skip('curated list missing');
        return;
    }
    const curated = readJson(curatedPath);
    const files = Array.isArray(curated.files) ? curated.files : [];
    if (files.length === 0) {
        test.skip('no curated parser files; run `npm run corpus:curate` after fetching corpus');
        return;
    }

    let ok = 0;
    for (const rel of files) {
        const abs = path.join(pkgRoot, rel);
        if (!fs.existsSync(abs)) continue;
        const src = fs.readFileSync(abs, 'utf8');
        try {
            parseUsdaToLayer(src, { identifier: rel });
        } catch (e) {
            const err = /** @type {any} */ (e);
            const msg = err?.message ?? String(e);
            throw new Error(`Failed to parse curated USDA file: ${rel}\n${msg}`);
        }
        ok++;
    }

    assert.ok(ok > 0, 'expected to parse at least one curated file');
});


