import test from 'node:test';
import assert from 'node:assert/strict';

import { UsdStage, SdfPath } from '../../dist/index.js';

test('composePrimIndexWithResolver: applies variants selection to properties', async () => {
  const src = `#usda 1.0
def Xform "World" {
  def Sphere "Sphere" (
    variants = { string size = "small" }
  ) {
    double radius = 1
    variantSet "size" = {
      "small" { double radius = 2 }
      "large" { double radius = 10 }
    }
  }
}
`;

  // No external loads needed; resolver unused.
  const resolver = { async readText() { throw new Error('unexpected'); } };
  const stage = UsdStage.openUSDA(src, '/mem.usda');
  const composed = await stage.composePrimIndexWithResolver(resolver);
  const sphere = composed.getPrim(SdfPath.parse('/World/Sphere'));
  assert.ok(sphere);
  assert.equal(sphere.properties.get('radius').defaultValue, 2);
});


