import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { UsdaLexer } from '../../dist/index.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const externalRoot = path.join(here, 'external');

function listFilesRecursive(dir, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) listFilesRecursive(p, out);
        else out.push(p);
    }
    return out;
}

test('external corpus: USDA lexer smoke (all .usda <= 2MB)', () => {
    if (!fs.existsSync(externalRoot)) {
        test.skip('external corpus not downloaded (run `npm run corpus:fetch`)');
        return;
    }

    const files = listFilesRecursive(externalRoot).filter((p) => p.toLowerCase().endsWith('.usda'));
    if (files.length === 0) {
        test.skip('no external .usda files found (run `npm run corpus:fetch`)');
        return;
    }

    let tested = 0;
    for (const file of files) {
        const stat = fs.statSync(file);
        if (stat.size > 2 * 1024 * 1024) continue; // keep it fast
        const src = fs.readFileSync(file, 'utf8');
        const lex = new UsdaLexer(src);
        // Must reach EOF without throwing.
        while (true) {
            const t = lex.next();
            if (t.kind === 'eof') break;
        }
        tested++;
    }

    assert.ok(tested > 0, 'Expected to test at least one .usda file (all were >2MB?)');
});


