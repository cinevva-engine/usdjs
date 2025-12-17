import test from 'node:test';
import assert from 'node:assert/strict';

import { UsdStage, SdfPath } from '../../dist/index.js';

test('USDA parser: layer + property metadata blocks', () => {
    const src = `#usda 1.0
(
  defaultPrim = "World"
  upAxis = "Y"
  variants = { string flavor = "vanilla" }
)
def Mesh "World" {
  normal3f[] primvars:normals = [(0,0,1)] ( interpolation = "vertex" )
}
`;

    const stage = UsdStage.openUSDA(src);
    assert.deepEqual(stage.rootLayer.metadata.defaultPrim, 'World');
    assert.deepEqual(stage.rootLayer.metadata.upAxis, 'Y');
    assert.equal(stage.rootLayer.metadata.variants.type, 'dict');
    assert.deepEqual(stage.rootLayer.metadata.variants.value.flavor, 'vanilla');

    const world = stage.rootLayer.getPrim(SdfPath.parse('/World'));
    assert.ok(world);
    const normals = world.properties.get('primvars:normals');
    assert.equal(normals.metadata.interpolation, 'vertex');
});


