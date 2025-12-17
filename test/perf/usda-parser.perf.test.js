import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { parseUsdaToLayer, SdfPath } from '../../dist/index.js';

function makeLargeUsda({ repeats }) {
    const chunk = `#usda 1.0
(
  defaultPrim = "World"
)
def Xform "World" {
  token purpose = "proxy"
  def Scope "Geom" {
    def Mesh "M" {
      int[] faceVertexCounts = [3, 3, 3, 3]
      int[] faceVertexIndices = [0,1,2, 0,2,3, 4,5,6, 4,6,7]
      point3f[] points = [(0,0,0), (1,0,0), (1,1,0), (0,1,0)]
      texCoord2f[] primvars:st = [(0,0), (1,0), (1,1), (0,1)] ( interpolation = "vertex" )
      token kind = component
    }
  }
}
`;
    return chunk.repeat(repeats);
}

test('perf: USDA parser throughput (catastrophic regression guard)', () => {
    // A few MB of input; should stay fast.
    // Use a multi-megabyte input so timing noise doesn't dominate.
    const src = makeLargeUsda({ repeats: 12000 });
    const bytes = Buffer.byteLength(src, 'utf8');

    const t0 = performance.now();
    const layer = parseUsdaToLayer(src);
    const t1 = performance.now();

    // basic sanity: ensure World exists so the parser did real work
    assert.ok(layer.getPrim(SdfPath.parse('/World')));

    const ms = Math.max(1, t1 - t0);
    const mbPerSec = (bytes / (1024 * 1024)) / (ms / 1000);

    // Generous guard: catch O(n^2) regressions.
    // Very generous: this is only meant to catch catastrophic regressions.
    const minMbPerSec = 0.25;
    assert.ok(
        mbPerSec >= minMbPerSec,
        `USDA parser too slow: ${mbPerSec.toFixed(2)} MB/s (< ${minMbPerSec} MB/s), bytes=${bytes}`
    );
});


