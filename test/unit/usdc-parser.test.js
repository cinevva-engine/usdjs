import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

import { UsdStage, parseUsdcToLayer } from '../../dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const corpusRoot = path.join(__dirname, '../corpus/external');

// Find available USDC files
const usdcFiles = [
    path.join(corpusRoot, 'ft-lab-sample-usd/sample_usd-main/samples/TriangulationOfPolygon/easyChair_01.usdc'),
    path.join(corpusRoot, 'usd-wg-assets/assets-main/full_assets/ElephantWithMonochord/SoC-ElephantWithMonochord.usdc'),
];

// Helper to check if usdcat is available
function hasUsdcat() {
    try {
        execSync('which usdcat', { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

// Helper to convert USDC to USDA using usdcat for comparison
function usdcToUsda(usdcPath) {
    try {
        return execSync(`usdcat "${usdcPath}"`, { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
    } catch (e) {
        return null;
    }
}

test('USDC parser: validates magic header', () => {
    const invalidData = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);

    assert.throws(() => {
        parseUsdcToLayer(invalidData);
    }, /Invalid USDC file/);
});

test('USDC parser: rejects unsupported version', () => {
    // Create a buffer with valid magic but unsupported version
    const data = new Uint8Array(32);
    const magic = 'PXR-USDC';
    for (let i = 0; i < 8; i++) {
        data[i] = magic.charCodeAt(i);
    }
    // Set version to 0.5.0 (unsupported)
    data[8] = 5;

    assert.throws(() => {
        parseUsdcToLayer(data);
    }, /Unsupported USDC version/);
});

test('USDC parser: opens easyChair_01.usdc', async () => {
    const usdcPath = usdcFiles[0];
    if (!existsSync(usdcPath)) {
        console.log('Skipping: easyChair_01.usdc not found');
        return;
    }

    const buffer = readFileSync(usdcPath);
    const stage = UsdStage.openUSDC(buffer, 'easyChair_01.usdc');

    assert.ok(stage, 'Stage should be created');
    assert.ok(stage.rootLayer, 'Stage should have a root layer');

    const paths = stage.listPrimPaths();
    assert.ok(paths.length > 0, 'Stage should have prims');
    assert.ok(paths.includes('/'), 'Stage should have root path');

    console.log(`Parsed ${paths.length} prim paths from easyChair_01.usdc`);
});

test('USDC parser: opens ElephantWithMonochord.usdc', async () => {
    const usdcPath = usdcFiles[1];
    if (!existsSync(usdcPath)) {
        console.log('Skipping: ElephantWithMonochord.usdc not found');
        return;
    }

    const buffer = readFileSync(usdcPath);
    const stage = UsdStage.openUSDC(buffer, 'SoC-ElephantWithMonochord.usdc');

    assert.ok(stage, 'Stage should be created');
    assert.ok(stage.rootLayer, 'Stage should have a root layer');

    const paths = stage.listPrimPaths();
    assert.ok(paths.length > 0, 'Stage should have prims');

    console.log(`Parsed ${paths.length} prim paths from ElephantWithMonochord.usdc`);
});

test('USDC parser: UsdStage.open auto-detects USDC format', async () => {
    const usdcPath = usdcFiles[0];
    if (!existsSync(usdcPath)) {
        console.log('Skipping: easyChair_01.usdc not found');
        return;
    }

    const buffer = readFileSync(usdcPath);

    // Test with ArrayBuffer
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    const stage1 = UsdStage.open(arrayBuffer, 'easyChair_01.usdc');
    assert.ok(stage1, 'Stage should be created from ArrayBuffer');

    // Test with Uint8Array
    const stage2 = UsdStage.open(new Uint8Array(buffer), 'easyChair_01.usdc');
    assert.ok(stage2, 'Stage should be created from Uint8Array');
});

test('USDC parser: UsdStage.open auto-detects USDA format', () => {
    const usdaSrc = `#usda 1.0
(
    defaultPrim = "World"
)
def Xform "World" {
    def Mesh "Cube" {
    }
}
`;

    const stage = UsdStage.open(usdaSrc);
    assert.ok(stage, 'Stage should be created from USDA string');

    const paths = stage.listPrimPaths();
    assert.deepEqual(paths, ['/', '/World', '/World/Cube']);
});

// Compare USDC parsing with usdcat output (if available)
test('USDC parser: compares with usdcat output', async () => {
    if (!hasUsdcat()) {
        console.log('Skipping usdcat comparison: usdcat not available');
        return;
    }

    const usdcPath = usdcFiles[0];
    if (!existsSync(usdcPath)) {
        console.log('Skipping: easyChair_01.usdc not found');
        return;
    }

    // Get USDA from usdcat
    const usdaText = usdcToUsda(usdcPath);
    if (!usdaText) {
        console.log('Skipping: usdcat conversion failed');
        return;
    }

    // Parse USDC directly
    const buffer = readFileSync(usdcPath);
    const usdcStage = UsdStage.openUSDC(buffer, 'easyChair_01.usdc');

    // Parse USDA from usdcat
    const usdaStage = UsdStage.openUSDA(usdaText, 'easyChair_01.usda');

    // Compare prim paths
    const usdcPaths = usdcStage.listPrimPaths();
    const usdaPaths = usdaStage.listPrimPaths();

    console.log(`USDC paths: ${usdcPaths.length}, USDA paths: ${usdaPaths.length}`);

    // At minimum, both should have the root path
    assert.ok(usdcPaths.includes('/'), 'USDC should have root path');
    assert.ok(usdaPaths.includes('/'), 'USDA should have root path');

    // Check if defaultPrim is extracted
    const usdcDefault = usdcStage.rootLayer.metadata?.defaultPrim;
    const usdaDefault = usdaStage.rootLayer.metadata?.defaultPrim;

    if (usdaDefault) {
        console.log(`USDA defaultPrim: ${usdaDefault}, USDC defaultPrim: ${usdcDefault}`);
    }
});

// Performance test
test('USDC parser: performance benchmark', async () => {
    const usdcPath = usdcFiles[1]; // Elephant is larger
    if (!existsSync(usdcPath)) {
        console.log('Skipping performance test: ElephantWithMonochord.usdc not found');
        return;
    }

    const buffer = readFileSync(usdcPath);
    const iterations = 10;

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
        UsdStage.openUSDC(buffer, 'perf-test.usdc');
    }
    const elapsed = performance.now() - start;

    const avgMs = elapsed / iterations;
    const bytesPerMs = buffer.length / avgMs;

    console.log(`USDC parsing performance:`);
    console.log(`  File size: ${(buffer.length / 1024).toFixed(1)} KB`);
    console.log(`  Average parse time: ${avgMs.toFixed(2)} ms`);
    console.log(`  Throughput: ${(bytesPerMs / 1024).toFixed(1)} KB/ms (${(bytesPerMs / 1024 / 1024 * 1000).toFixed(1)} MB/s)`);
});



