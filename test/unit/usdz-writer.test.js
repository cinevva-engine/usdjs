import test from 'node:test';
import assert from 'node:assert/strict';

import { parseUsdaToLayer, UsdStage, serializeLayerToUsdz } from '../../dist/index.js';

function readU16(view, off) {
  return view.getUint16(off, true);
}

function readU32(view, off) {
  return view.getUint32(off, true);
}

function inspectLocalHeaders(usdzBytes) {
  const data = usdzBytes instanceof Uint8Array ? usdzBytes : new Uint8Array(usdzBytes);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const out = [];
  let off = 0;
  while (off + 4 <= data.length) {
    const sig = readU32(view, off);
    if (sig !== 0x04034b50) break; // stop at central directory

    const compression = readU16(view, off + 8);
    const crc32 = readU32(view, off + 14);
    const compSize = readU32(view, off + 18);
    const uncompSize = readU32(view, off + 22);
    const nameLen = readU16(view, off + 26);
    const extraLen = readU16(view, off + 28);

    const nameStart = off + 30;
    const nameEnd = nameStart + nameLen;
    const extraEnd = nameEnd + extraLen;
    const dataStart = extraEnd;
    const dataEnd = dataStart + compSize;

    const name = new TextDecoder('utf-8').decode(data.subarray(nameStart, nameEnd));
    out.push({
      off,
      name,
      compression,
      crc32,
      compSize,
      uncompSize,
      extraLen,
      dataStart,
      dataEnd,
    });

    off = dataEnd;
  }
  return out;
}

test('USDZ writer: creates an uncompressed, aligned package that can be parsed back', async () => {
  const input = `#usda 1.0
(
    defaultPrim = "World"
)

def Xform "World" {
    def Sphere "Ball" {
        double radius = 10
    }
}
`;

  const layer = parseUsdaToLayer(input, { identifier: '<test>' });
  const usdz = serializeLayerToUsdz(layer, {
    layerFormat: 'usda',
    // include a second file so we validate alignment for multiple entries
    files: [{ path: 'textures/placeholder.txt', data: 'hello' }],
  });

  assert.ok(usdz instanceof Uint8Array);
  assert.ok(usdz.length > 0);

  // Basic ZIP magic
  assert.equal(usdz[0], 0x50);
  assert.equal(usdz[1], 0x4b);

  // Inspect local headers: stored-only + 64-byte alignment
  const entries = inspectLocalHeaders(usdz);
  assert.equal(entries.length, 2);

  assert.equal(entries[0].name, 'defaultLayer.usda');
  for (const e of entries) {
    assert.equal(e.compression, 0, `entry ${e.name} must be stored (no compression)`);
    assert.equal(e.compSize, e.uncompSize, `entry ${e.name} stored sizes must match`);
    assert.equal(e.dataStart % 64, 0, `entry ${e.name} data must start at 64-byte boundary`);
    assert.ok(e.crc32 !== 0 || e.compSize === 0, `entry ${e.name} should have a CRC32`);
  }

  // Round-trip through our USDZ parser/stage
  const stage = await UsdStage.openUSDZ(usdz, '<mem.usdz>');
  assert.ok(stage.rootLayer);
  assert.equal(stage.rootLayer.metadata?.defaultPrim, 'World');

  const paths = stage.listPrimPaths();
  assert.ok(paths.includes('/World'));
  assert.ok(paths.includes('/World/Ball'));
});







