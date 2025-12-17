import test from 'node:test';
import assert from 'node:assert/strict';

import { UsdStage, SdfPath } from '../../dist/index.js';

test('USDA parser: variantSet blocks are captured', () => {
    const src = `#usda 1.0
def Xform "World" {
  def Sphere "Sphere" (
    variants = { string size = "small" }
    prepend variantSets = "size"
  ) {
    double radius = 1
    variantSet "size" = {
      "large" { double radius = 10 }
      "small" { double radius = 2 }
    }
  }
}
`;

    const stage = UsdStage.openUSDA(src);
    const sphere = stage.rootLayer.getPrim(SdfPath.parse('/World/Sphere'));
    assert.ok(sphere);
    assert.ok(sphere.variantSets?.has('size'));
    const vs = sphere.variantSets.get('size');
    assert.ok(vs.variants.has('large'));
    assert.equal(vs.variants.get('large').properties.get('radius').defaultValue, 10);
});

test('USDA parser: sdfpath targets and property fields (.connect)', () => {
    const src = `#usda 1.0
def Material "M" {
  token outputs:surface.connect = </M/S.outputs:surface>
}
`;

    const stage = UsdStage.openUSDA(src);
    const mat = stage.rootLayer.getPrim(SdfPath.parse('/M'));
    assert.ok(mat);
    const spec = mat.properties.get('outputs:surface.connect');
    assert.ok(spec);
    assert.equal(spec.path.toString(), '/M.outputs:surface.connect');
    assert.deepEqual(spec.defaultValue, { type: 'sdfpath', value: '/M/S.outputs:surface' });
});


