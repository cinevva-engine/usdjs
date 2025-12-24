import { readFileSync } from 'fs';
import { performance } from 'perf_hooks';
import { UsdStage } from '../../dist/index.js';

const filePath = process.argv[2];
if (!filePath) {
    console.error('Usage: node usdc-benchmark.mjs <path-to-usdc-file>');
    process.exit(1);
}

const buffer = readFileSync(filePath);
const fileSizeMB = (buffer.length / 1024 / 1024).toFixed(2);

console.log(`\n=== USDC Parser Performance Benchmark ===`);
console.log(`File: ${filePath}`);
console.log(`Size: ${fileSizeMB} MB (${buffer.length.toLocaleString()} bytes)\n`);

// Warmup
console.log('Warming up...');
for (let i = 0; i < 3; i++) {
    UsdStage.openUSDC(buffer);
}

// Benchmark with detailed timing
const iterations = 10;
const timings = {
    total: [],
    parse: [],
    paths: [],
    metadata: []
};

console.log(`Running ${iterations} iterations...\n`);

for (let i = 0; i < iterations; i++) {
    const startTotal = performance.now();
    
    const parseStart = performance.now();
    const stage = UsdStage.openUSDC(buffer);
    const parseEnd = performance.now();
    
    const pathsStart = performance.now();
    const paths = stage.listPrimPaths();
    const pathsEnd = performance.now();
    
    const metadataStart = performance.now();
    const metadata = stage.rootLayer.metadata;
    const metadataEnd = performance.now();
    
    const endTotal = performance.now();
    
    timings.total.push(endTotal - startTotal);
    timings.parse.push(parseEnd - parseStart);
    timings.paths.push(pathsEnd - pathsStart);
    timings.metadata.push(metadataEnd - metadataStart);
    
    if (i === 0) {
        console.log(`First parse results:`);
        console.log(`  Prims: ${paths.length}`);
        console.log(`  Metadata keys: ${Object.keys(metadata || {}).length}`);
    }
}

// Calculate statistics
function stats(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const sum = values.reduce((a, b) => a + b, 0);
    return {
        min: sorted[0],
        max: sorted[sorted.length - 1],
        avg: sum / values.length,
        median: sorted[Math.floor(sorted.length / 2)],
        p95: sorted[Math.floor(sorted.length * 0.95)],
        p99: sorted[Math.floor(sorted.length * 0.99)]
    };
}

const totalStats = stats(timings.total);
const parseStats = stats(timings.parse);
const pathsStats = stats(timings.paths);
const metadataStats = stats(timings.metadata);

console.log(`\n=== Performance Results ===\n`);

console.log(`Total Time (ms):`);
console.log(`  Min:    ${totalStats.min.toFixed(2)}`);
console.log(`  Max:    ${totalStats.max.toFixed(2)}`);
console.log(`  Avg:    ${totalStats.avg.toFixed(2)}`);
console.log(`  Median: ${totalStats.median.toFixed(2)}`);
console.log(`  P95:    ${totalStats.p95.toFixed(2)}`);
console.log(`  P99:    ${totalStats.p99.toFixed(2)}`);

console.log(`\nParse Time (ms):`);
console.log(`  Min:    ${parseStats.min.toFixed(2)}`);
console.log(`  Max:    ${parseStats.max.toFixed(2)}`);
console.log(`  Avg:    ${parseStats.avg.toFixed(2)}`);
console.log(`  Median: ${parseStats.median.toFixed(2)}`);
console.log(`  P95:    ${parseStats.p95.toFixed(2)}`);
console.log(`  P99:    ${parseStats.p99.toFixed(2)}`);

console.log(`\nPaths Time (ms):`);
console.log(`  Min:    ${pathsStats.min.toFixed(2)}`);
console.log(`  Max:    ${pathsStats.max.toFixed(2)}`);
console.log(`  Avg:    ${pathsStats.avg.toFixed(2)}`);
console.log(`  Median: ${pathsStats.median.toFixed(2)}`);

console.log(`\nMetadata Time (ms):`);
console.log(`  Min:    ${metadataStats.min.toFixed(2)}`);
console.log(`  Max:    ${metadataStats.max.toFixed(2)}`);
console.log(`  Avg:    ${metadataStats.avg.toFixed(2)}`);
console.log(`  Median: ${metadataStats.median.toFixed(2)}`);

// Calculate throughput
const avgThroughputMBps = (buffer.length / 1024 / 1024) / (parseStats.avg / 1000);
console.log(`\n=== Throughput ===`);
console.log(`Average: ${avgThroughputMBps.toFixed(1)} MB/s`);

// Breakdown
const parsePercent = (parseStats.avg / totalStats.avg) * 100;
const pathsPercent = (pathsStats.avg / totalStats.avg) * 100;
const metadataPercent = (metadataStats.avg / totalStats.avg) * 100;
const otherPercent = 100 - parsePercent - pathsPercent - metadataPercent;

console.log(`\n=== Time Breakdown ===`);
console.log(`Parse:    ${parsePercent.toFixed(1)}%`);
console.log(`Paths:    ${pathsPercent.toFixed(1)}%`);
console.log(`Metadata: ${metadataPercent.toFixed(1)}%`);
console.log(`Other:    ${otherPercent.toFixed(1)}%`);



