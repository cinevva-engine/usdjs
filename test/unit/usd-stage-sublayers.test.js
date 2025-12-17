import test from 'node:test';
import assert from 'node:assert/strict';

import { UsdStage, SdfPath } from '../../dist/index.js';

test('UsdStage.openUSDAWithResolver: loads subLayers and composes prim index', async () => {
    // Root is strongest. Sublayers are weaker in our current Pcp-lite model.
    const root = `#usda 1.0
(
  subLayers = [@./a.usda@, @./b.usda@]
)
def Xform "World" {
  token purpose = "proxy"
}
`;

    const layerA = `#usda 1.0
def Xform "World" {
  token purpose = "render"
  def Scope "Geom" {}
}
`;

    const layerB = `#usda 1.0
def Xform "World" {
  token kind = component
}
`;

    const files = new Map([
        ['/root.usda', root],
        ['/a.usda', layerA],
        ['/b.usda', layerB],
    ]);

    const resolver = {
        async readText(assetPath, fromIdentifier) {
            // Resolve ./ relative to fromIdentifier directory
            const baseDir = fromIdentifier.slice(0, fromIdentifier.lastIndexOf('/') + 1);
            const resolved = assetPath.startsWith('./') ? baseDir + assetPath.slice(2) : assetPath;
            const text = files.get(resolved);
            if (!text) throw new Error(`missing ${resolved}`);
            return { identifier: resolved, text };
        },
    };

    const stage = await UsdStage.openUSDAWithResolver(root, resolver, '/root.usda');
    assert.equal(stage.layerStack.length, 3);

    const composed = stage.composePrimIndex();
    const world = composed.getPrim(SdfPath.parse('/World'));
    assert.ok(world);

    // root strongest wins for purpose
    assert.deepEqual(world.properties.get('purpose').defaultValue, 'proxy');
    // but we still see weaker-layer additions like /World/Geom and kind
    assert.ok(composed.getPrim(SdfPath.parse('/World/Geom')));
    assert.deepEqual(world.properties.get('kind').defaultValue, { type: 'token', value: 'component' });
});


