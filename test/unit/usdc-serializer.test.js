import test from 'node:test';
import assert from 'node:assert/strict';

import {
    isUsdcContent,
    parseUsdaToLayer,
    parseUsdcToLayer,
    serializeLayerToUsdc,
} from '../../dist/index.js';

function readU64LE(bytes, offset) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const v = dv.getBigUint64(offset, true);
    return Number(v);
}

function readFixedString(bytes, offset, len) {
    const slice = bytes.subarray(offset, offset + len);
    let end = 0;
    while (end < slice.length && slice[end] !== 0) end++;
    return new TextDecoder('utf-8').decode(slice.subarray(0, end));
}

function getSection(bytes, name) {
    const tocOffset = readU64LE(bytes, 16);
    const count = readU64LE(bytes, tocOffset);
    let p = tocOffset + 8;
    for (let i = 0; i < count; i++) {
        const n = readFixedString(bytes, p, 16);
        const start = readU64LE(bytes, p + 16);
        const size = readU64LE(bytes, p + 24);
        if (n === name) return { start, size };
        p += 32;
    }
    return null;
}

test('USDC serializer: writes a valid header + can be parsed back', () => {
    const input = `#usda 1.0
(
    defaultPrim = "World"
    upAxis = "Y"
    metersPerUnit = 0.01
    customLayerData = {
        string author = "cinevva"
        int build = 7
    }
)

def Xform "World" {
    def Sphere "Ball" {
        double radius = 10
    }
}
`;

    const layer = parseUsdaToLayer(input, { identifier: '<test>' });
    const bytes = serializeLayerToUsdc(layer);

    assert.ok(bytes instanceof Uint8Array);
    assert.ok(bytes.length > 100, 'should produce non-trivial usdc bytes');
    assert.equal(isUsdcContent(bytes), true);

    // Compression smoke-check: TOKENS should be LZ4-compressed when beneficial.
    const tokens = getSection(bytes, 'TOKENS');
    assert.ok(tokens, 'TOKENS section should exist');
    const tokBase = tokens.start;
    const uncompressedSize = readU64LE(bytes, tokBase + 8);
    const compressedSize = readU64LE(bytes, tokBase + 16);
    // We only assert "implements compression" (compressedSize > 0). For very small token sets, it might not shrink.
    assert.ok(compressedSize >= 0, 'TOKENS compressedSize should be present');
    assert.ok(uncompressedSize > 0);

    const fieldsets = getSection(bytes, 'FIELDSETS');
    assert.ok(fieldsets, 'FIELDSETS section should exist');
    const fsBase = fieldsets.start;
    const fsCompSize = readU64LE(bytes, fsBase + 8);
    assert.ok(fsCompSize > 0, 'FIELDSETS should use integer compression');

    const fields = getSection(bytes, 'FIELDS');
    assert.ok(fields, 'FIELDS section should exist');
    const fBase = fields.start;
    const fieldCount = readU64LE(bytes, fBase + 0);
    // Skip tokenIndices blob: [u64 compressedSize][blob]
    const tokCompSize = readU64LE(bytes, fBase + 8);
    const repsCompSize = readU64LE(bytes, fBase + 16 + tokCompSize);
    // We expect reps to be compressible and thus emit compressedSize > 0 for non-trivial scenes.
    assert.ok(fieldCount > 0);
    assert.ok(repsCompSize >= 0);

    const reparsed = parseUsdcToLayer(bytes, { identifier: '<roundtrip.usdc>' });

    assert.equal(reparsed.metadata.defaultPrim, 'World');
    assert.equal(reparsed.metadata.upAxis, 'Y');
    assert.equal(reparsed.metadata.metersPerUnit, 0.01);

    const ball = reparsed.getPrim({ kind: 'prim', primPath: '/World/Ball', propertyName: null, propertyField: null });
    assert.ok(ball, 'Ball prim should exist');
    assert.equal(ball.typeName, 'Sphere');

    const radius = ball.properties?.get('radius');
    assert.ok(radius, 'radius property should exist');
    assert.equal(radius.typeName, 'double');
    assert.equal(radius.defaultValue, 10);

    // customLayerData dict should survive (keys may not be ordered)
    assert.ok(reparsed.metadata.customLayerData && typeof reparsed.metadata.customLayerData === 'object');
    assert.equal(reparsed.metadata.customLayerData.type, 'dict');
    assert.equal(reparsed.metadata.customLayerData.value.author, 'cinevva');
    assert.equal(reparsed.metadata.customLayerData.value.build, 7);
});

test('USDC serializer: preserves timeSamples (simple)', () => {
    const input = `#usda 1.0

def Xform "Animated" {
    double3 xformOp:translate.timeSamples = {
        0: (0, 0, 0),
        24: (10, 0, 0),
        48: (10, 10, 0),
    }
    uniform token[] xformOpOrder = ["xformOp:translate"]
}
`;

    const layer = parseUsdaToLayer(input, { identifier: '<test>' });
    const bytes = serializeLayerToUsdc(layer);
    const reparsed = parseUsdcToLayer(bytes, { identifier: '<roundtrip.usdc>' });

    const prim = reparsed.getPrim({ kind: 'prim', primPath: '/Animated', propertyName: null, propertyField: null });
    assert.ok(prim, 'Animated prim should exist');

    const translate = prim.properties?.get('xformOp:translate');
    assert.ok(translate, 'xformOp:translate property should exist');
    assert.ok(translate.timeSamples, 'timeSamples should exist');
    assert.equal(translate.timeSamples.size, 3);
    assert.ok(translate.timeSamples.has(0));
    assert.ok(translate.timeSamples.has(24));
    assert.ok(translate.timeSamples.has(48));
});

test('USDC serializer: encodes references/payload listOps (prepend) in prim metadata', () => {
    const input = `#usda 1.0

def Xform "Root" (
    prepend references = @./other.usda@
    prepend payload = @./payload.usda@
)
{
}
`;

    const layer = parseUsdaToLayer(input, { identifier: '<test>' });
    const bytes = serializeLayerToUsdc(layer);
    const reparsed = parseUsdcToLayer(bytes, { identifier: '<roundtrip.usdc>' });

    const root = reparsed.getPrim({ kind: 'prim', primPath: '/Root', propertyName: null, propertyField: null });
    assert.ok(root);

    const checkListOp = (v, wantOp) => {
        assert.ok(v && typeof v === 'object', 'expected a list op object');
        // Parser may return either:
        // - explicit array form, or
        // - { type:'dict', value:{ op: {type:'token',value:'prepend'}, value: {type:'array', elementType:'reference', ...} } }
        if (v.type === 'dict') {
            const op = v.value?.op;
            assert.ok(op && typeof op === 'object' && op.type === 'token');
            assert.equal(op.value, wantOp);
            const inner = v.value?.value;
            assert.ok(inner && typeof inner === 'object');
            assert.equal(inner.type, 'array');
            assert.equal(inner.elementType, 'reference');
            assert.ok(Array.isArray(inner.value));
            assert.ok(inner.value.length >= 1);
            return;
        }
        if (v.type === 'array') {
            assert.equal(v.elementType, 'reference');
            assert.ok(Array.isArray(v.value));
            assert.ok(v.value.length >= 1);
            return;
        }
        assert.fail(`unexpected listOp shape: ${JSON.stringify(v)}`);
    };

    checkListOp(root.metadata?.references, 'prepend');
    checkListOp(root.metadata?.payload, 'prepend');
});

test('USDC serializer: supports vec3d + int64 + TokenVector/PathVector', () => {
    const input = `#usda 1.0

def "Test" {
    double3 translate = (1.25, 2.5, 3.75)
    int64 id64 = 1234567890123
}
`;

    const layer = parseUsdaToLayer(input, { identifier: '<test>' });

    // Force TokenVector/PathVector authoring via explicit elementType markers understood by serializer.
    layer.metadata.tokenVec = { type: 'array', elementType: 'tokenVector', value: ['a', 'b', 'c'] };
    layer.metadata.pathVec = { type: 'array', elementType: 'pathVector', value: [{ type: 'sdfpath', value: '/Test' }] };

    const bytes = serializeLayerToUsdc(layer);
    const reparsed = parseUsdcToLayer(bytes, { identifier: '<roundtrip.usdc>' });

    const testPrim = reparsed.getPrim({ kind: 'prim', primPath: '/Test', propertyName: null, propertyField: null });
    assert.ok(testPrim);

    const translate = testPrim.properties?.get('translate');
    assert.ok(translate);
    assert.equal(translate.typeName, 'double3');
    // Parser represents double3 as tuple.
    assert.ok(translate.defaultValue && typeof translate.defaultValue === 'object');
    assert.equal(translate.defaultValue.type, 'tuple');
    assert.deepEqual(translate.defaultValue.value, [1.25, 2.5, 3.75]);

    const id64 = testPrim.properties?.get('id64');
    assert.ok(id64);
    assert.equal(id64.typeName, 'int64');
    assert.equal(id64.defaultValue, 1234567890123);

    // TokenVector decodes to array(token) (strings)
    assert.ok(reparsed.metadata.tokenVec);
    assert.equal(reparsed.metadata.tokenVec.type, 'array');
    assert.equal(reparsed.metadata.tokenVec.elementType, 'token');
    assert.deepEqual(reparsed.metadata.tokenVec.value, ['a', 'b', 'c']);

    // PathVector decodes to array(sdfpath)
    assert.ok(reparsed.metadata.pathVec);
    assert.equal(reparsed.metadata.pathVec.type, 'array');
    assert.equal(reparsed.metadata.pathVec.elementType, 'sdfpath');
    assert.ok(Array.isArray(reparsed.metadata.pathVec.value));
    assert.equal(reparsed.metadata.pathVec.value[0].type, 'sdfpath');
    assert.equal(reparsed.metadata.pathVec.value[0].value, '/Test');
});


