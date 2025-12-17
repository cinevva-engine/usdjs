import fs from 'node:fs';
import path from 'node:path';

import { parseUsdaToLayer } from '../dist/index.js';

const here = path.dirname(new URL(import.meta.url).pathname);
const pkgRoot = path.resolve(here, '..');

const ftRoot = path.join(
  pkgRoot,
  'test',
  'corpus',
  'external',
  'ft-lab-sample-usd',
  'sample_usd-main'
);

const curatedPath = path.join(pkgRoot, 'test', 'corpus', 'curated-ftlab-parser-files.json');

const LIMIT = Number(process.env.LIMIT ?? '250');
const MAX_BYTES = Number(process.env.MAX_BYTES ?? String(2 * 1024 * 1024));

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
  if (!fs.existsSync(ftRoot)) {
    console.error(`ft-lab corpus not found at ${ftRoot}. Run \`npm run corpus:fetch\` first.`);
    process.exit(1);
  }

  const files = listFilesRecursive(ftRoot)
    .filter((p) => p.toLowerCase().endsWith('.usda'))
    .sort();

  const ok = [];
  let tried = 0;

  for (const file of files) {
    const stat = fs.statSync(file);
    if (stat.size > MAX_BYTES) continue;
    tried++;
    const src = fs.readFileSync(file, 'utf8');
    try {
      parseUsdaToLayer(src, { identifier: rel(file) });
      ok.push(rel(file));
      if (ok.length >= LIMIT) break;
    } catch {
      // ignore
    }
  }

  const curated = fs.existsSync(curatedPath)
    ? readJson(curatedPath)
    : { version: 1, source: 'ft-lab/sample_usd', files: [] };

  curated.files = ok;
  curated.generatedAt = new Date().toISOString();
  curated.tried = tried;
  curated.limit = LIMIT;
  curated.maxBytes = MAX_BYTES;

  writeJson(curatedPath, curated);
  console.log(`Curated ${ok.length} / tried ${tried} ft-lab USDA files into ${rel(curatedPath)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


