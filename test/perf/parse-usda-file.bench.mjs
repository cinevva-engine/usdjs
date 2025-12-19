import fs from 'node:fs';
import { performance } from 'node:perf_hooks';

import { parseUsdaToLayer } from '../../dist/index.js';

function parseArgs(argv) {
    const args = { file: null, runs: 7, warmup: 2, gc: true };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (!args.file && !a.startsWith('--')) {
            args.file = a;
            continue;
        }
        if (a === '--runs') args.runs = Number(argv[++i]);
        else if (a === '--warmup') args.warmup = Number(argv[++i]);
        else if (a === '--no-gc') args.gc = false;
        else if (a === '--help' || a === '-h') args.help = true;
    }
    return args;
}

function percentile(sorted, p) {
    if (sorted.length === 0) return NaN;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return sorted[idx];
}

const args = parseArgs(process.argv);
if (args.help || !args.file) {
    console.log(
        [
            'Usage:',
            '  node --expose-gc packages/usdjs/test/perf/parse-usda-file.bench.mjs <file.usd> [--runs N] [--warmup N] [--no-gc]',
            '',
            'Notes:',
            '  - Default runs=7, warmup=2',
            '  - Use --expose-gc (recommended) so we can call global.gc() between runs.',
        ].join('\n')
    );
    process.exit(args.file ? 0 : 2);
}

const file = args.file;
const src = fs.readFileSync(file, 'utf8');
const bytes = Buffer.byteLength(src, 'utf8');
const mb = bytes / (1024 * 1024);

const canGC = typeof global.gc === 'function';
const doGC = () => {
    if (!args.gc) return;
    if (!canGC) return;
    global.gc();
};

for (let i = 0; i < args.warmup; i++) {
    doGC();
    parseUsdaToLayer(src, { identifier: file });
}

const runs = [];
for (let i = 0; i < args.runs; i++) {
    doGC();
    const mem0 = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    const layer = parseUsdaToLayer(src, { identifier: file });
    const t1 = performance.now();
    const mem1 = process.memoryUsage().heapUsed;
    runs.push({
        ms: t1 - t0,
        mbPerSec: mb / ((t1 - t0) / 1000),
        heapDeltaMB: (mem1 - mem0) / (1024 * 1024),
        rootChildren: layer?.root?.children?.size ?? 0,
    });
}

const msSorted = runs.map((r) => r.ms).slice().sort((a, b) => a - b);
const mbpsSorted = runs.map((r) => r.mbPerSec).slice().sort((a, b) => a - b);
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const avg = (xs) => sum(xs) / xs.length;

const summary = {
    file,
    sizeMB: mb,
    runs: args.runs,
    warmup: args.warmup,
    gcBetweenRuns: args.gc,
    gcAvailable: canGC,
    ms: {
        min: msSorted[0],
        avg: avg(msSorted),
        p50: percentile(msSorted, 0.5),
        p95: percentile(msSorted, 0.95),
        max: msSorted[msSorted.length - 1],
    },
    throughputMBps: {
        min: mbpsSorted[0],
        avg: avg(mbpsSorted),
        p50: percentile(mbpsSorted, 0.5),
        p95: percentile(mbpsSorted, 0.95),
        max: mbpsSorted[mbpsSorted.length - 1],
    },
    heapDeltaMB: {
        min: Math.min(...runs.map((r) => r.heapDeltaMB)),
        avg: avg(runs.map((r) => r.heapDeltaMB)),
        max: Math.max(...runs.map((r) => r.heapDeltaMB)),
    },
    sample: runs[0],
};

console.log(JSON.stringify({ summary, runs }, null, 2));


