import fs from 'node:fs';
import path from 'node:path';

import { parseUsdaToLayer } from '../dist/index.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const pkgRoot = path.resolve(here, '..');
const externalRoot = path.join(pkgRoot, 'test', 'corpus', 'external');
const curatedPath = path.join(pkgRoot, 'test', 'corpus', 'curated-parser-files.json');

function listFilesRecursive(dir, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) listFilesRecursive(p, out);
        else out.push(p);
    }
    return out;
}

function rel(p) {
    return path.relative(pkgRoot, p).split(path.sep).join('/');
}

function readJson(p) {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJson(p, v) {
    fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
}

async function main() {
    if (!fs.existsSync(externalRoot)) {
        console.error('External corpus not found. Run `npm run corpus:fetch` first.');
        process.exit(1);
    }

    const files = listFilesRecursive(externalRoot).filter((p) => p.toLowerCase().endsWith('.usda'));
    const ok = [];
    let tried = 0;

    for (const file of files) {
        const stat = fs.statSync(file);
        if (stat.size > 512 * 1024) continue; // curate small files first
        const src = fs.readFileSync(file, 'utf8');
        tried++;
        try {
            parseUsdaToLayer(src, { identifier: rel(file) });
            ok.push(rel(file));
            if (ok.length >= 50) break; // keep curated set manageable
        } catch {
            // ignore
        }
    }

    const curated = readJson(curatedPath);
    curated.files = ok;
    curated.generatedAt = new Date().toISOString();
    curated.tried = tried;
    writeJson(curatedPath, curated);

    console.log(`Curated ${ok.length} / tried ${tried} USDA files into ${rel(curatedPath)}`);
    if (ok.length === 0) {
        console.warn('No files parsed successfully with current parser subset. Expand parser and re-run curation.');
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});


