import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUsdaToLayer, SdfPath } from '../../dist/index.js';

test('USDA parser: prevents infinite loop in parseLayer with malformed metadata blocks', { timeout: 5000 }, () => {
    // Test case 1: Multiple consecutive opening parentheses that could cause infinite loop
    // if parseMetadataBlockInto doesn't advance properly
    const src1 = `#usda 1.0
(
  defaultPrim = "World"
)
(
  upAxis = "Y"
)
(
  metersPerUnit = 1.0
)
def Xform "World" {
}
`;

    // Should parse without hanging
    const startTime = Date.now();
    const layer1 = parseUsdaToLayer(src1, { identifier: '<test1>' });
    const elapsed1 = Date.now() - startTime;
    
    assert.ok(layer1, 'Layer should be created');
    assert.equal(layer1.identifier, '<test1>');
    assert.ok(layer1.root, 'Root prim should exist');
    // Should complete quickly (not hang)
    assert.ok(elapsed1 < 1000, `Parsing should complete quickly, took ${elapsed1}ms`);
});

test('USDA parser: prevents infinite loop with unclosed metadata block', { timeout: 5000 }, () => {
    // Test case 2: Unclosed metadata block - parser should handle gracefully
    const src2 = `#usda 1.0
(
  defaultPrim = "World"
  upAxis = "Y"
  # Missing closing paren - should not cause infinite loop
def Xform "World" {
}
`;

    // Should parse without hanging (may throw error, but shouldn't loop)
    const startTime = Date.now();
    let layer2;
    let error2;
    try {
        layer2 = parseUsdaToLayer(src2, { identifier: '<test2>' });
    } catch (e) {
        error2 = e;
    }
    const elapsed2 = Date.now() - startTime;
    
    // Either parses successfully or throws error quickly (not infinite loop)
    assert.ok(elapsed2 < 1000, `Parsing should complete quickly, took ${elapsed2}ms`);
    // If it throws, that's fine - we just don't want infinite loop
});

test('USDA parser: prevents infinite loop with many metadata blocks', { timeout: 5000 }, () => {
    // Test case 3: Many metadata blocks (tests the 100-block limit)
    let src3 = '#usda 1.0\n';
    for (let i = 0; i < 150; i++) {
        src3 += `(
  test${i} = ${i}
)
`;
    }
    src3 += 'def Xform "World" {\n}\n';

    const startTime = Date.now();
    const layer3 = parseUsdaToLayer(src3, { identifier: '<test3>' });
    const elapsed3 = Date.now() - startTime;
    
    assert.ok(layer3, 'Layer should be created');
    // Should complete quickly due to 100-block limit
    assert.ok(elapsed3 < 1000, `Parsing should complete quickly, took ${elapsed3}ms`);
});

test('USDA parser: handles metadata block that does not advance token', { timeout: 5000 }, () => {
    // Test case 4: Metadata block that might not advance token properly
    // This tests the safety check that ensures token offset advances
    const src4 = `#usda 1.0
(
  defaultPrim = "World"
)
def Xform "World" {
  token test = "value"
}
`;

    const startTime = Date.now();
    const layer4 = parseUsdaToLayer(src4, { identifier: '<test4>' });
    const elapsed4 = Date.now() - startTime;
    
    assert.ok(layer4, 'Layer should be created');
    const world = layer4.getPrim(SdfPath.parse('/World'));
    assert.ok(world, 'World prim should exist');
    assert.ok(world.properties?.get('test'), 'Property should exist');
    assert.ok(elapsed4 < 1000, `Parsing should complete quickly, took ${elapsed4}ms`);
});

test('USDA parser: handles empty metadata blocks', { timeout: 5000 }, () => {
    // Test case 5: Empty metadata blocks
    const src5 = `#usda 1.0
(
)
(
)
def Xform "World" {
}
`;

    const startTime = Date.now();
    const layer5 = parseUsdaToLayer(src5, { identifier: '<test5>' });
    const elapsed5 = Date.now() - startTime;
    
    assert.ok(layer5, 'Layer should be created');
    assert.ok(elapsed5 < 1000, `Parsing should complete quickly, took ${elapsed5}ms`);
});

test('USDA parser: handles metadata blocks with only commas', { timeout: 5000 }, () => {
    // Test case 6: Metadata blocks with only commas/semicolons (should skip and not loop)
    const src6 = `#usda 1.0
(
  , , , ; ; ;
)
def Xform "World" {
}
`;

    const startTime = Date.now();
    const layer6 = parseUsdaToLayer(src6, { identifier: '<test6>' });
    const elapsed6 = Date.now() - startTime;
    
    assert.ok(layer6, 'Layer should be created');
    assert.ok(elapsed6 < 1000, `Parsing should complete quickly, took ${elapsed6}ms`);
});

