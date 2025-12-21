import { readFileSync } from 'fs';
import { performance } from 'perf_hooks';
import { parseUsdcToLayer } from '../../dist/index.js';

const filePath = process.argv[2];
if (!filePath) {
    console.error('Usage: node usdc-profile.mjs <path-to-usdc-file>');
    process.exit(1);
}

const buffer = readFileSync(filePath);
const fileSizeMB = (buffer.length / 1024 / 1024).toFixed(2);

console.log(`\n=== USDC Parser Hot Spot Analysis ===`);
console.log(`File: ${filePath}`);
console.log(`Size: ${fileSizeMB} MB (${buffer.length.toLocaleString()} bytes)\n`);

// Import the parser to access internal methods if needed
// For now, we'll use the public API and add timing hooks

// Warmup
for (let i = 0; i < 3; i++) {
    parseUsdcToLayer(buffer);
}

// Detailed profiling
const iterations = 5;
const measurements = [];

for (let iter = 0; iter < iterations; iter++) {
    const marks = {};
    
    // Mark start
    marks.start = performance.now();
    
    // Parse
    marks.parseStart = performance.now();
    const layer = parseUsdcToLayer(buffer);
    marks.parseEnd = performance.now();
    
    // Access paths
    marks.pathsStart = performance.now();
    const root = layer.root;
    const paths = [];
    const walk = (p) => {
        paths.push(p.path.toString());
        if (p.children) {
            for (const child of p.children.values()) walk(child);
        }
    };
    walk(root);
    marks.pathsEnd = performance.now();
    
    // Access metadata
    marks.metadataStart = performance.now();
    const metadata = layer.metadata;
    marks.metadataEnd = performance.now();
    
    marks.end = performance.now();
    
    measurements.push({
        total: marks.end - marks.start,
        parse: marks.parseEnd - marks.parseStart,
        paths: marks.pathsEnd - marks.pathsStart,
        metadata: marks.metadataEnd - marks.metadataStart,
        other: (marks.end - marks.start) - (marks.parseEnd - marks.parseStart) - 
               (marks.pathsEnd - marks.pathsStart) - (marks.metadataEnd - marks.metadataStart)
    });
    
    if (iter === 0) {
        console.log(`First parse:`);
        console.log(`  Prims: ${paths.length}`);
        console.log(`  Metadata keys: ${Object.keys(metadata || {}).length}`);
    }
}

// Calculate averages
const avg = {
    total: measurements.reduce((sum, m) => sum + m.total, 0) / measurements.length,
    parse: measurements.reduce((sum, m) => sum + m.parse, 0) / measurements.length,
    paths: measurements.reduce((sum, m) => sum + m.paths, 0) / measurements.length,
    metadata: measurements.reduce((sum, m) => sum + m.metadata, 0) / measurements.length,
    other: measurements.reduce((sum, m) => sum + m.other, 0) / measurements.length
};

console.log(`\n=== Hot Spot Analysis ===\n`);

const total = avg.total;
console.log(`Total Time: ${total.toFixed(2)} ms\n`);

const breakdown = [
    { name: 'Parse', time: avg.parse, percent: (avg.parse / total) * 100 },
    { name: 'Paths', time: avg.paths, percent: (avg.paths / total) * 100 },
    { name: 'Metadata', time: avg.metadata, percent: (avg.metadata / total) * 100 },
    { name: 'Other', time: avg.other, percent: (avg.other / total) * 100 }
].sort((a, b) => b.time - a.time);

for (const item of breakdown) {
    const barLength = Math.round(item.percent / 2);
    const bar = '█'.repeat(barLength);
    console.log(`${item.name.padEnd(10)} ${item.time.toFixed(2).padStart(8)} ms (${item.percent.toFixed(1).padStart(5)}%) ${bar}`);
}

console.log(`\n=== Recommendations ===`);
const hotSpots = breakdown.filter(item => item.percent > 10);
if (hotSpots.length > 0) {
    console.log(`Hot spots (>10% of total time):`);
    for (const spot of hotSpots) {
        console.log(`  - ${spot.name}: ${spot.percent.toFixed(1)}%`);
    }
} else {
    console.log(`No significant hot spots detected.`);
}

// Throughput
const throughputMBps = (buffer.length / 1024 / 1024) / (avg.parse / 1000);
console.log(`\nParse Throughput: ${throughputMBps.toFixed(1)} MB/s`);

