import test from 'node:test';
import assert from 'node:assert/strict';

import { SdfPath } from '../../dist/index.js';

test('SdfPath.parse: root and prim paths', () => {
    assert.equal(SdfPath.parse('/').toString(), '/');
    assert.equal(SdfPath.parse('/World').toString(), '/World');
    assert.equal(SdfPath.parse('/World/Geom').toString(), '/World/Geom');
});

test('SdfPath.parse: property paths', () => {
    assert.equal(SdfPath.parse('/World.xformOp:translate').toString(), '/World.xformOp:translate');
    assert.equal(SdfPath.parse('/World.outputs:surface.connect').toString(), '/World.outputs:surface.connect');
});

test('SdfPath.child + parent + name', () => {
    const world = SdfPath.parse('/World');
    const geom = SdfPath.child(world, 'Geom');
    assert.equal(geom.toString(), '/World/Geom');
    assert.equal(geom.name(), 'Geom');
    assert.equal(geom.parent()?.toString(), '/World');
    assert.equal(world.parent()?.toString(), '/');
});

test('SdfPath validation rejects invalid identifiers', () => {
    assert.throws(() => SdfPath.parse('/1bad'), /Invalid prim identifier/);
    assert.throws(() => SdfPath.parse('/World.'), /empty property/);
    assert.throws(() => SdfPath.parse('/World.bad-prop'), /Invalid property identifier/);
});


