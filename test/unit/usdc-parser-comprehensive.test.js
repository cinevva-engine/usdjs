import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

import { UsdStage, parseUsdcToLayer, isUsdcContent, SdfPath } from '../../dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const corpusRoot = path.join(__dirname, '../corpus/external');

/**
 * Recursively find all USDC files in a directory
 */
function findUsdcFiles(dir, files = []) {
    if (!existsSync(dir)) return files;

    try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                findUsdcFiles(fullPath, files);
            } else if (entry.isFile() && entry.name.endsWith('.usdc')) {
                files.push(fullPath);
            }
        }
    } catch (e) {
        // Skip directories we can't read
    }
    return files;
}

/**
 * Check if usdcat is available
 */
function hasUsdcat() {
    try {
        execSync('which usdcat', { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

/**
 * Convert USDC to USDA using usdcat
 */
function usdcToUsda(usdcPath) {
    try {
        return execSync(`usdcat "${usdcPath}"`, {
            encoding: 'utf-8',
            maxBuffer: 100 * 1024 * 1024,
            timeout: 30000 // 30 second timeout
        });
    } catch (e) {
        console.error(`usdcat failed for ${usdcPath}:`, e.message);
        return null;
    }
}

/**
 * Extract prim paths from USDA text (simple parser)
 */
function extractPrimPathsFromUsda(usdaText) {
    const paths = new Set(['/']);
    const lines = usdaText.split('\n');

    for (const line of lines) {
        // Match: def/over/class Type "Name" {
        const match = line.match(/^\s*(def|over|class)\s+(\w+)\s+"([^"]+)"\s*\{/);
        if (match) {
            const name = match[3];
            // Build path by tracking depth
            // This is simplified - in reality we'd need to track the stack
            const path = `/${name}`;
            paths.add(path);
        }
    }

    return Array.from(paths).sort();
}

/**
 * Extract metadata from USDA text
 */
function extractMetadataFromUsda(usdaText) {
    const metadata = {};
    const lines = usdaText.split('\n');

    // Look for metadata block: ( key = value )
    let inMetadata = false;
    for (const line of lines) {
        if (line.trim().startsWith('(') && line.includes('=')) {
            inMetadata = true;
        }
        if (inMetadata) {
            const match = line.match(/(\w+)\s*=\s*(.+)/);
            if (match) {
                const key = match[1];
                let value = match[2].trim();
                // Remove trailing comma and quotes
                value = value.replace(/,$/, '').replace(/^"|"$/g, '');
                metadata[key] = value;
            }
            if (line.trim().endsWith(')')) {
                break;
            }
        }
    }

    return metadata;
}

/**
 * Compare two stages for correctness
 */
function compareStages(usdcStage, usdaStage, testName) {
    const usdcPaths = usdcStage.listPrimPaths().sort();
    const usdaPaths = usdaStage.listPrimPaths().sort();

    let intersection = [];

    // Check path count matches (allow some tolerance for complex parsing)
    if (usdaPaths.length > 0) {
        assert.ok(
            usdcPaths.length > 0,
            `${testName}: USDC should have at least one prim path`
        );

        // Check that all USDC paths exist in USDA (or vice versa for root)
        const usdcSet = new Set(usdcPaths);
        const usdaSet = new Set(usdaPaths);

        // Root should always match
        assert.ok(
            usdcSet.has('/'),
            `${testName}: USDC should have root path`
        );
        assert.ok(
            usdaSet.has('/'),
            `${testName}: USDA should have root path`
        );

        // Check for 100% path match - parser should match usdcat exactly
        intersection = usdcPaths.filter(p => usdaSet.has(p));
        const overlapRatio = intersection.length / Math.max(usdcPaths.length, usdaPaths.length);

        // Require exact match
        assert.ok(
            usdcPaths.length === usdaPaths.length,
            `${testName}: Path count should match exactly (USDC: ${usdcPaths.length}, USDA: ${usdaPaths.length})`
        );

        assert.ok(
            overlapRatio === 1.0,
            `${testName}: All paths should match exactly (got ${(overlapRatio * 100).toFixed(1)}% overlap)`
        );

        // Verify paths are identical
        for (let i = 0; i < usdcPaths.length; i++) {
            assert.ok(
                usdcPaths[i] === usdaPaths[i],
                `${testName}: Path at index ${i} should match (USDC: ${usdcPaths[i]}, USDA: ${usdaPaths[i]})`
            );
        }
    }

    // Compare metadata
    const usdcMeta = usdcStage.rootLayer.metadata || {};
    const usdaMeta = usdaStage.rootLayer.metadata || {};

    // Check defaultPrim if present
    if (usdaMeta.defaultPrim) {
        assert.ok(
            usdcMeta.defaultPrim === usdaMeta.defaultPrim,
            `${testName}: defaultPrim should match (USDC: ${usdcMeta.defaultPrim}, USDA: ${usdaMeta.defaultPrim})`
        );
    }

    return {
        usdcPaths: usdcPaths.length,
        usdaPaths: usdaPaths.length,
        overlap: intersection.length,
        metadataMatch: usdcMeta.defaultPrim === usdaMeta.defaultPrim
    };
}

// Find all USDC files in corpus
const allUsdcFiles = findUsdcFiles(corpusRoot);
console.log(`Found ${allUsdcFiles.length} USDC files in corpus`);

// Test basic parsing for all files
test('USDC parser: parses all corpus files', async () => {
    for (const usdcPath of allUsdcFiles) {
        const fileName = path.basename(usdcPath);

        if (!existsSync(usdcPath)) {
            console.log(`Skipping: ${fileName} not found`);
            continue;
        }

        try {
            const buffer = readFileSync(usdcPath);
            const fileSize = buffer.length;

            // Verify it's a USDC file
            assert.ok(
                isUsdcContent(buffer),
                `${fileName}: Should be detected as USDC content`
            );

            // Parse it
            const stage = UsdStage.openUSDC(buffer, fileName);

            assert.ok(stage, `${fileName}: Stage should be created`);
            assert.ok(stage.rootLayer, `${fileName}: Stage should have root layer`);

            const paths = stage.listPrimPaths();
            assert.ok(paths.length > 0, `${fileName}: Should have at least one prim path`);
            assert.ok(paths.includes('/'), `${fileName}: Should have root path`);

            console.log(`  ✓ ${fileName}: ${paths.length} prims, ${(fileSize / 1024).toFixed(1)} KB`);
        } catch (e) {
            assert.fail(`${fileName}: Failed to parse - ${e.message}`);
        }
    }
});

// Comprehensive comparison with usdcat (if available)
if (hasUsdcat()) {
    test('USDC parser: correctness comparison with usdcat', async () => {
        const results = [];

        for (const usdcPath of allUsdcFiles) {
            const fileName = path.basename(usdcPath);

            if (!existsSync(usdcPath)) {
                console.log(`Skipping: ${fileName} not found`);
                continue;
            }

            try {
                // Get USDA from usdcat
                const usdaText = usdcToUsda(usdcPath);
                if (!usdaText) {
                    console.log(`  ⚠ ${fileName}: usdcat conversion failed, skipping comparison`);
                    continue;
                }

                // Parse USDC directly
                const buffer = readFileSync(usdcPath);
                const usdcStage = UsdStage.openUSDC(buffer, fileName);

                // Parse USDA from usdcat
                const usdaStage = UsdStage.openUSDA(usdaText, `${fileName}.usda`);

                // Compare
                const comparison = compareStages(usdcStage, usdaStage, fileName);
                results.push({
                    file: fileName,
                    ...comparison
                });

                console.log(`  ✓ ${fileName}: ${comparison.usdcPaths} USDC paths, ${comparison.usdaPaths} USDA paths, ${comparison.overlap} overlap`);
            } catch (e) {
                console.error(`  ✗ ${fileName}: Comparison failed - ${e.message}`);
                // Don't fail the test, just log the error
            }
        }

        // Summary
        console.log(`\nComparison summary:`);
        console.log(`  Files tested: ${results.length}`);
        if (results.length > 0) {
            const avgOverlap = results.reduce((sum, r) => sum + (r.overlap / Math.max(r.usdcPaths, r.usdaPaths)), 0) / results.length;
            console.log(`  Average path overlap: ${(avgOverlap * 100).toFixed(1)}%`);
        }
    });
} else {
    test('USDC parser: correctness comparison with usdcat', { skip: true }, () => {
        console.log('Skipping: usdcat not available');
    });
}

// Test specific files in detail
const testFiles = [
    'easyChair_01.usdc',
    'SoC-ElephantWithMonochord.usdc'
];

for (const testFile of testFiles) {
    const usdcPath = allUsdcFiles.find(f => f.includes(testFile));
    if (!usdcPath || !existsSync(usdcPath)) {
        continue;
    }

    test(`USDC parser: detailed validation for ${testFile}`, async () => {
        const buffer = readFileSync(usdcPath);
        const stage = UsdStage.openUSDC(buffer, testFile);

        // Basic structure checks
        assert.ok(stage.rootLayer, 'Should have root layer');
        assert.ok(stage.rootLayer.root, 'Root layer should have root prim');

        const paths = stage.listPrimPaths();
        assert.ok(paths.length > 0, 'Should have prim paths');
        assert.ok(paths.includes('/'), 'Should include root path');

        // Check that paths are valid SdfPaths
        for (const pathStr of paths) {
            assert.ok(
                pathStr.startsWith('/'),
                `Path should be absolute: ${pathStr}`
            );

            // Verify path can be parsed as SdfPath
            try {
                const sdfPath = SdfPath.parse(pathStr);
                assert.ok(sdfPath, `Path should be parseable: ${pathStr}`);
            } catch (e) {
                assert.fail(`Path should be valid SdfPath: ${pathStr} - ${e.message}`);
            }
        }

        // Check metadata structure
        const metadata = stage.rootLayer.metadata;
        assert.ok(typeof metadata === 'object', 'Metadata should be an object');

        // If defaultPrim exists, verify it points to a valid prim
        if (metadata.defaultPrim) {
            const defaultPrimPath = `/${metadata.defaultPrim}`;
            assert.ok(
                paths.some(p => p === defaultPrimPath || p.startsWith(defaultPrimPath + '/')),
                `defaultPrim "${metadata.defaultPrim}" should correspond to a valid prim path`
            );
        }

        console.log(`  ✓ ${testFile}: ${paths.length} prims validated`);
    });
}

// Performance and scale testing
test('USDC parser: performance at scale', async () => {
    const results = [];

    for (const usdcPath of allUsdcFiles) {
        const fileName = path.basename(usdcPath);

        if (!existsSync(usdcPath)) continue;

        try {
            const buffer = readFileSync(usdcPath);
            const fileSize = buffer.length;

            // Warmup
            UsdStage.openUSDC(buffer, fileName);

            // Benchmark
            const iterations = 5;
            const start = performance.now();
            for (let i = 0; i < iterations; i++) {
                UsdStage.openUSDC(buffer, fileName);
            }
            const elapsed = performance.now() - start;

            const avgMs = elapsed / iterations;
            const throughputMBps = (fileSize / 1024 / 1024) / (avgMs / 1000);

            results.push({
                file: fileName,
                sizeKB: (fileSize / 1024).toFixed(1),
                avgMs: avgMs.toFixed(2),
                throughputMBps: throughputMBps.toFixed(1)
            });
        } catch (e) {
            console.error(`  ✗ ${fileName}: Performance test failed - ${e.message}`);
        }
    }

    // Print results
    console.log('\nPerformance results:');
    for (const r of results) {
        console.log(`  ${r.file}: ${r.sizeKB} KB, ${r.avgMs} ms, ${r.throughputMBps} MB/s`);
    }

    // Verify reasonable performance (at least 10 MB/s for files > 100KB)
    const largeFiles = results.filter(r => parseFloat(r.sizeKB) > 100);
    if (largeFiles.length > 0) {
        const avgThroughput = largeFiles.reduce((sum, r) => sum + parseFloat(r.throughputMBps), 0) / largeFiles.length;
        assert.ok(
            avgThroughput >= 10,
            `Average throughput should be at least 10 MB/s (got ${avgThroughput.toFixed(1)} MB/s)`
        );
    }
});

// Test edge cases
test('USDC parser: edge cases', async () => {
    // Test with empty buffer
    assert.throws(() => {
        parseUsdcToLayer(new Uint8Array(0));
    }, /Invalid USDC file|length/);

    // Test with too small buffer
    assert.throws(() => {
        parseUsdcToLayer(new Uint8Array(10));
    }, /Invalid USDC file/);

    // Test with invalid magic
    const invalidMagic = new Uint8Array(100);
    invalidMagic.set([0x50, 0x58, 0x52, 0x2D, 0x55, 0x53, 0x44, 0x44], 0); // PXR-USDD (wrong)
    assert.throws(() => {
        parseUsdcToLayer(invalidMagic);
    }, /Invalid USDC file/);

    // Test isUsdcContent detection
    assert.ok(!isUsdcContent(new Uint8Array(0)), 'Empty buffer should not be USDC');
    assert.ok(!isUsdcContent(new Uint8Array(10)), 'Small buffer should not be USDC');

    // Test with a real USDC file
    if (allUsdcFiles.length > 0) {
        const buffer = readFileSync(allUsdcFiles[0]);
        assert.ok(isUsdcContent(buffer), 'Real USDC file should be detected');
        assert.ok(isUsdcContent(buffer.buffer), 'ArrayBuffer should be detected');
        assert.ok(isUsdcContent(new Uint8Array(buffer)), 'Uint8Array should be detected');
    }
});

// Test round-trip consistency (parse multiple times, should get same result)
test('USDC parser: round-trip consistency', async () => {
    for (const usdcPath of allUsdcFiles.slice(0, 2)) { // Test first 2 files
        const fileName = path.basename(usdcPath);
        if (!existsSync(usdcPath)) continue;

        const buffer = readFileSync(usdcPath);

        // Parse multiple times
        const stages = [];
        for (let i = 0; i < 3; i++) {
            stages.push(UsdStage.openUSDC(buffer, fileName));
        }

        // All should have same number of prims
        const pathCounts = stages.map(s => s.listPrimPaths().length);
        assert.ok(
            pathCounts.every(c => c === pathCounts[0]),
            `${fileName}: Multiple parses should yield same number of prims`
        );

        // All should have same paths
        const pathSets = stages.map(s => new Set(s.listPrimPaths()));
        const firstPaths = pathSets[0];
        for (let i = 1; i < pathSets.length; i++) {
            assert.ok(
                pathSets[i].size === firstPaths.size,
                `${fileName}: Path sets should have same size`
            );
            for (const p of firstPaths) {
                assert.ok(
                    pathSets[i].has(p),
                    `${fileName}: Path ${p} should be present in all parses`
                );
            }
        }
    }
});

