import test from 'node:test';
import assert from 'node:assert/strict';

import { UsdStage, SdfPath } from '../../dist/index.js';

test('USDA parser: builds prim hierarchy and simple properties', () => {
    const src = `#usda 1.0
(
  defaultPrim = "World"
)
def Xform "World" {
  token purpose = "proxy"
  def Scope "Geom" {
    def Mesh "Cube" {
      float size = 1
      bool visible = true
      token kind = component
      asset tex = @textures/albedo.png@
      int[] faceVertexCounts = [3, 3, 3, 3]
      point3f[] points = [(0,0,0), (1,0,0), (1,1,0)]
      texCoord2f[] primvars:st = [(0,0), (1,0)]
    }
  }
}
`;

    const stage = UsdStage.openUSDA(src);
    const paths = stage.listPrimPaths();

    assert.deepEqual(paths, ['/', '/World', '/World/Geom', '/World/Geom/Cube']);

    const layer = stage.rootLayer;
    const cube = layer.getPrim(SdfPath.parse('/World/Geom/Cube'));
    assert.ok(cube, 'Cube prim should exist');
    assert.equal(cube.typeName, 'Mesh');
    assert.equal(cube.properties.get('size').defaultValue, 1);
    assert.equal(cube.properties.get('visible').defaultValue, true);
    assert.deepEqual(cube.properties.get('kind').defaultValue, { type: 'token', value: 'component' });
    assert.deepEqual(cube.properties.get('tex').defaultValue, { type: 'asset', value: 'textures/albedo.png', __fromIdentifier: '<memory>' });

    assert.equal(cube.properties.get('faceVertexCounts').typeName, 'int[]');
    const fvc = cube.properties.get('faceVertexCounts').defaultValue;
    assert.ok(fvc && typeof fvc === 'object');
    if (fvc.type === 'typedArray') {
        assert.equal(fvc.elementType, 'int');
        assert.deepEqual(Array.from(fvc.value), [3, 3, 3, 3]);
    } else {
        assert.deepEqual(fvc, { type: 'array', elementType: 'int', value: [3, 3, 3, 3] });
    }

    const pts = cube.properties.get('points').defaultValue;
    assert.ok(pts && typeof pts === 'object');
    if (pts.type === 'typedArray') {
        assert.equal(pts.elementType, 'point3f');
        assert.deepEqual(Array.from(pts.value), [0, 0, 0, 1, 0, 0, 1, 1, 0]);
    } else {
        assert.equal(pts.type, 'array');
        assert.equal(pts.elementType, 'point3f');
        assert.equal(pts.value[0].type, 'tuple');
        assert.deepEqual(pts.value[0].value, [0, 0, 0]);
    }

    const st = cube.properties.get('primvars:st').defaultValue;
    assert.ok(st && typeof st === 'object');
    if (st.type === 'typedArray') {
        assert.equal(st.elementType, 'texCoord2f');
        assert.deepEqual(Array.from(st.value), [0, 0, 1, 0]);
    } else {
        assert.equal(st.type, 'array');
        assert.equal(st.elementType, 'texCoord2f');
    }
});

test('USDA parser: packs quat and matrix types into typed arrays', () => {
    const src = `#usda 1.0
def Xform "World" {
  quath orient = (1, 0, 0, 0)
  matrix4d xformOp:transform = ( (1,0,0,0), (0,1,0,0), (0,0,1,0), (0,0,0,1) )
  quatf[] rotations = [(1,0,0,0), (0,1,0,0)]
}
`;
    const stage = UsdStage.openUSDA(src);
    const world = stage.rootLayer.getPrim(SdfPath.parse('/World'));
    assert.ok(world);

    const orient = world.properties.get('orient')?.defaultValue;
    assert.ok(orient && typeof orient === 'object');
    assert.equal(orient.type, 'typedArray');
    assert.equal(orient.elementType, 'quath');
    assert.deepEqual(Array.from(orient.value), [1, 0, 0, 0]);

    const m = world.properties.get('xformOp:transform')?.defaultValue;
    assert.ok(m && typeof m === 'object');
    assert.equal(m.type, 'typedArray');
    assert.equal(m.elementType, 'matrix4d');
    assert.equal(m.value.length, 16);

    const rots = world.properties.get('rotations')?.defaultValue;
    assert.ok(rots && typeof rots === 'object');
    assert.equal(rots.type, 'typedArray');
    assert.equal(rots.elementType, 'quatf');
    assert.deepEqual(Array.from(rots.value), [1, 0, 0, 0, 0, 1, 0, 0]);
});

test('USDA parser: relationship-style property parses <SdfPath> value', () => {
    const src = `#usda 1.0
def Xform "World" {
  rel material:binding = </World/Looks/Mat> ( bindMaterialAs = "weakerThanDescendants" )
}
`;
    const stage = UsdStage.openUSDA(src);
    const world = stage.rootLayer.getPrim(SdfPath.parse('/World'));
    assert.ok(world);
    const rel = world.properties.get('material:binding');
    assert.ok(rel);
    assert.equal(rel.typeName, 'rel');
    assert.deepEqual(rel.defaultValue, { type: 'sdfpath', value: '/World/Looks/Mat' });
    assert.equal(rel.metadata.bindMaterialAs, 'weakerThanDescendants');
});


