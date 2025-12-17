import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { UsdaLexer } from '../../dist/index.js';

function makeLargeUsda({ repeats }) {
    const chunk = `#usda 1.0
(
    defaultPrim = "World"
)
def Xform "World" {
  def Scope "Geom" {
    def Mesh "M" {
      int[] faceVertexCounts = [3, 3, 3, 3]
      int[] faceVertexIndices = [0,1,2, 0,2,3, 4,5,6, 4,6,7]
      point3f[] points = [(0,0,0), (1,0,0), (1,1,0), (0,1,0), (0,0,1), (1,0,1), (1,1,1), (0,1,1)]
      normal3f[] primvars:normals = [(0,0,1)] ( interpolation = "vertex" )
      texCoord2f[] primvars:st = [(0,0), (1,0), (1,1), (0,1)] ( interpolation = "vertex" )
      token purpose = "proxy"
    }
  }
}
`;
    return chunk.repeat(repeats);
}

test('perf: USDA lexer throughput (catastrophic regression guard)', () => {
    // Keep runtime bounded in CI/local. This produces a few MB.
    // Use a multi-megabyte input so timing noise doesn't dominate.
    const src = makeLargeUsda({ repeats: 12000 });
    const bytes = Buffer.byteLength(src, 'utf8');

    const t0 = performance.now();
    const lex = new UsdaLexer(src);
    let n = 0;
    while (true) {
        const tok = lex.next();
        n++;
        if (tok.kind === 'eof') break;
    }
    const t1 = performance.now();
    const ms = Math.max(1, t1 - t0);
    const mbPerSec = (bytes / (1024 * 1024)) / (ms / 1000);

    // This threshold is intentionally generous; it’s meant to catch obvious slowdowns
    // (e.g. accidental O(n^2) behavior), not micro-optimizations.
    //
    // If you see failures on very slow machines/CI, raise it slightly but keep a guard.
    // Very generous: this is only meant to catch catastrophic regressions.
    const minMbPerSec = 0.5;
    assert.ok(
        mbPerSec >= minMbPerSec,
        `USDA lexer too slow: ${mbPerSec.toFixed(2)} MB/s (< ${minMbPerSec} MB/s), tokens=${n}, bytes=${bytes}`
    );
});


