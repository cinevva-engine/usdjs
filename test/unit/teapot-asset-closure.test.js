import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { UsdStage, resolveAssetPath } from '../../dist/index.js';

test(
  'teapotScene.usd: composition loads referenced assets (bounded reads, no <composed> resolution)',
  { timeout: 20000 },
  async () => {
    const entry =
      'test/corpus/external/usd-wg-assets/assets-main/intent-vfx/scenes/teapotScene.usd';
    const entryText = fs.readFileSync(entry, 'utf8');

    let reads = 0;
    const resolvedIds = new Set();
    const fromIds = new Set();

    const resolver = {
      async readText(assetPath, fromIdentifier) {
        reads++;
        fromIds.add(fromIdentifier ?? null);
        const resolved = resolveAssetPath(assetPath, fromIdentifier);
        resolvedIds.add(resolved);
        const text = fs.readFileSync(resolved, 'utf8');
        return { identifier: resolved, text };
      },
    };

    const stage = await UsdStage.openUSDAWithResolver(entryText, resolver, entry);
    await stage.composePrimIndexWithResolver(resolver);

    // Sanity: we should not spam the resolver; this used to be 1000+ reads for the teapot scene.
    assert.ok(reads > 0, 'Expected at least one resolver read');
    assert.ok(reads <= 200, `Expected bounded resolver reads, got ${reads}`);

    // Composition should never rely on '<composed>' as the base identifier for relative resolution.
    assert.ok(!fromIds.has('<composed>'), 'Expected no readText() calls with fromIdentifier="<composed>"');

    // Key expected assets in the teapot scene closure.
    const expectContains = (suffix) => {
      const ok = [...resolvedIds].some((p) => typeof p === 'string' && p.endsWith(suffix));
      assert.ok(ok, `Expected asset closure to include *${suffix}`);
    };

    expectContains('/intent-vfx/scenes/teapotScene_layout.usd');
    expectContains('/intent-vfx/scenes/teapotScene_camera.usd');
    expectContains('/intent-vfx/assets/teapot/teapot.usd');
    expectContains('/intent-vfx/assets/teapot/payload.usd');
    expectContains('/intent-vfx/assets/teapot/mtl.usd');
    expectContains('/intent-vfx/assets/teapot/geo.usd');
    expectContains('/intent-vfx/assets/teapot/geo/UtahTeapot.usd');

    // Guard against the classic bad resolution symptom (losing directory context).
    assert.ok(!resolvedIds.has('mtl.usd'), 'Expected not to resolve "./mtl.usd" to bare "mtl.usd"');
    assert.ok(!resolvedIds.has('geo.usd'), 'Expected not to resolve "./geo.usd" to bare "geo.usd"');
  }
);




