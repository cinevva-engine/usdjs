import test from 'node:test';
import assert from 'node:assert/strict';

import { UsdStage, SdfPath } from '../../dist/index.js';

test('UsdStage.composePrimIndexWithResolver: applies prepend references and prepend payload', async () => {
  const root = `#usda 1.0
(
  subLayers = [@./layout.usda@, @./animation.usda@]
  defaultPrim = "World"
)
def Xform "World" {
  def "Character" {
  }
}
`;

  const layout = `#usda 1.0
def Xform "World" {
  def "Character" (
    prepend references = @./model.usda@
  ) { }
}
`;

  const animation = `#usda 1.0
def Xform "World" {
  over "Character" (
    prepend payload = @./animCache.usda@
  ) { }
}
`;

  const model = `#usda 1.0
( defaultPrim = "Ball" )
def Sphere "Ball" { double radius = 11 }
`;

  const animCache = `#usda 1.0
( defaultPrim = "Ball" )
def Sphere "Ball" { double radius = 14 }
`;

  const files = new Map([
    ['/root.usda', root],
    ['/layout.usda', layout],
    ['/animation.usda', animation],
    ['/model.usda', model],
    ['/animCache.usda', animCache],
  ]);

  const resolver = {
    async readText(assetPath, fromIdentifier) {
      const baseDir = fromIdentifier.slice(0, fromIdentifier.lastIndexOf('/') + 1);
      const resolved = assetPath.startsWith('./') ? baseDir + assetPath.slice(2) : assetPath;
      const text = files.get(resolved);
      if (!text) throw new Error(`missing ${resolved}`);
      return { identifier: resolved, text };
    },
  };

  const stage = await UsdStage.openUSDAWithResolver(root, resolver, '/root.usda');
  const composed = await stage.composePrimIndexWithResolver(resolver);

  const character = composed.getPrim(SdfPath.parse('/World/Character'));
  assert.ok(character);

  // Our Pcp-lite grafts defaultPrim under the prim. For now this means Character gets Sphere typeName + radius.
  // Since payload is applied after references (via layer ordering), radius should be from animCache (14).
  assert.equal(character.typeName, 'Sphere');
  assert.equal(character.properties.get('radius').defaultValue, 14);
});


