import { readFileSync } from 'fs';
import { performance } from 'perf_hooks';
import { parseUsdcToLayer } from '../../dist/index.js';

const filePath = process.argv[2];
if (!filePath) {
    console.error('Usage: node usdc-detailed-profile.mjs <path-to-usdc-file>');
    process.exit(1);
}

const buffer = readFileSync(filePath);
const fileSizeMB = (buffer.length / 1024 / 1024).toFixed(2);

console.log(`\n=== USDC Parser Detailed Hot Spot Analysis ===`);
console.log(`File: ${filePath}`);
console.log(`Size: ${fileSizeMB} MB (${buffer.length.toLocaleString()} bytes)\n`);

// We'll manually instrument the parser by reading the source
// For now, let's do multiple runs and measure different aspects

const iterations = 20;
const measurements = {
    fullParse: [],
    justParse: []
};

console.log(`Running ${iterations} iterations...\n`);

// Warmup
for (let i = 0; i < 3; i++) {
    parseUsdcToLayer(buffer);
}

// Measure full parse
for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    const layer = parseUsdcToLayer(buffer);
    const end = performance.now();
    measurements.fullParse.push(end - start);
    
    if (i === 0) {
        const paths = [];
        const walk = (p) => {
            paths.push(p.path.toString());
            if (p.children) {
                for (const child of p.children.values()) walk(child);
            }
        };
        walk(layer.root);
        console.log(`Parsed ${paths.length} prim paths`);
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

const parseStats = stats(measurements.fullParse);

console.log(`\n=== Parse Performance ===\n`);
console.log(`Min:    ${parseStats.min.toFixed(3)} ms`);
console.log(`Max:    ${parseStats.max.toFixed(3)} ms`);
console.log(`Avg:    ${parseStats.avg.toFixed(3)} ms`);
console.log(`Median: ${parseStats.median.toFixed(3)} ms`);
console.log(`P95:    ${parseStats.p95.toFixed(3)} ms`);
console.log(`P99:    ${parseStats.p99.toFixed(3)} ms`);

const throughputMBps = (buffer.length / 1024 / 1024) / (parseStats.avg / 1000);
console.log(`\nThroughput: ${throughputMBps.toFixed(1)} MB/s`);

// Analyze buffer operations
console.log(`\n=== Buffer Analysis ===`);
console.log(`Buffer size: ${buffer.length.toLocaleString()} bytes`);
console.log(`Average parse time: ${parseStats.avg.toFixed(3)} ms`);
console.log(`Bytes per ms: ${(buffer.length / parseStats.avg).toLocaleString()}`);

// Estimate operations
const estimatedOps = buffer.length * 10; // Rough estimate
const opsPerMs = estimatedOps / parseStats.avg;
console.log(`Estimated ops/sec: ${(opsPerMs * 1000).toLocaleString()}`);

console.log(`\n=== Recommendations ===`);
if (parseStats.avg > 10) {
    console.log(`⚠ Parse time is >10ms - consider optimization`);
} else if (parseStats.avg > 5) {
    console.log(`⚠ Parse time is >5ms - may benefit from optimization`);
} else {
    console.log(`✓ Parse time is <5ms - good performance`);
}

if (throughputMBps < 100) {
    console.log(`⚠ Throughput <100 MB/s - consider optimization`);
} else if (throughputMBps < 200) {
    console.log(`⚠ Throughput <200 MB/s - may benefit from optimization`);
} else {
    console.log(`✓ Throughput >200 MB/s - good performance`);
}

console.log(`\nTo identify specific hot spots, run with:`);
console.log(`  node --cpu-prof --cpu-prof-dir=/tmp usdc-profile.mjs ${filePath}`);
console.log(`Then analyze the .cpuprofile file with Chrome DevTools or clinic.js`);



