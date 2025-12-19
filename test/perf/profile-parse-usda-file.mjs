import fs from 'node:fs';
import { performance } from 'node:perf_hooks';

import { parseUsdaToLayer } from '../../dist/index.js';

function parseArgs(argv) {
  const args = { file: null, iters: 20, warmup: 2, gc: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!args.file && !a.startsWith('--')) {
      args.file = a;
      continue;
    }
    if (a === '--iters') args.iters = Number(argv[++i]);
    else if (a === '--warmup') args.warmup = Number(argv[++i]);
    else if (a === '--gc') args.gc = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

const args = parseArgs(process.argv);
if (args.help || !args.file) {
  console.log(
    [
      'Usage:',
      '  node --cpu-prof --cpu-prof-name <out.cpuprofile> packages/usdjs/test/perf/profile-parse-usda-file.mjs <file.usd[a]> [--iters N] [--warmup N] [--gc]',
      '',
      'Notes:',
      '  - Use a large file (e.g. teapot_animCycle.usd) so profiling samples are meaningful.',
      '  - --gc will call global.gc() between iterations (requires --expose-gc).',
    ].join('\n')
  );
  process.exit(args.file ? 0 : 2);
}

const file = args.file;
const src = fs.readFileSync(file, 'utf8');
const bytes = Buffer.byteLength(src, 'utf8');

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

let lastLayer = null;
const t0 = performance.now();
for (let i = 0; i < args.iters; i++) {
  doGC();
  lastLayer = parseUsdaToLayer(src, { identifier: file });
}
const t1 = performance.now();

// keep result alive
if (!lastLayer) throw new Error('unexpected: parser returned null layer');

const ms = t1 - t0;
console.log(
  JSON.stringify(
    {
      file,
      sizeBytes: bytes,
      warmup: args.warmup,
      iters: args.iters,
      gcRequested: args.gc,
      gcAvailable: canGC,
      totalMs: ms,
      msPerIter: ms / Math.max(1, args.iters),
    },
    null,
    2
  )
);


