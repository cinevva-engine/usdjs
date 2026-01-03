import test from 'node:test';
import assert from 'node:assert/strict';

import {
  __usdcTest_parseValueRep,
  __usdcTest_decodeTimeSamplesLayout,
  __usdcTest_decodeCompressedFloatArray,
} from '../../dist/index.js';

function u64le(n) {
  const b = new Uint8Array(8);
  const v = new DataView(b.buffer);
  v.setBigUint64(0, BigInt(n), true);
  return b;
}

function i64le(n) {
  const b = new Uint8Array(8);
  const v = new DataView(b.buffer);
  v.setBigInt64(0, BigInt(n), true);
  return b;
}

function i32le(n) {
  const b = new Uint8Array(4);
  const v = new DataView(b.buffer);
  v.setInt32(0, n | 0, true);
  return b;
}

function lz4LiteralBlock(literals) {
  // Minimal LZ4 block for our decoder: one literal-only sequence.
  // token: high nibble literalLen, low nibble matchLen (0).
  if (literals.length >= 15) throw new Error('test helper only supports <15 literal bytes');
  return new Uint8Array([literals.length << 4, ...literals]);
}

function makeCompressedIntsPayloadForSingleValue(v) {
  // Our integer decompressor expects:
  // - 1 byte header (0x00)
  // - LZ4 block that expands to encodedSize bytes
  // encodedSize for numInts=1 is 4 + ceil(2/8)=1 + 1*4 = 9 bytes.
  // We only need:
  // - commonValue (int32) = v
  // - codes byte = 0 (use common)
  // - remaining bytes ignored
  const encoded = new Uint8Array([
    ...i32le(v),
    0x00, // codes byte -> 2-bit code 0
    0x00, 0x00, 0x00, 0x00, // spare
  ]);
  assert.equal(encoded.length, 9);
  const lz4 = lz4LiteralBlock(encoded);
  return new Uint8Array([0x00, ...lz4]); // 1-byte header + LZ4 block
}

test('USDC: ValueRep bit layout matches Pixar (crateFile.h)', () => {
  const payload = 0x1234n;
  const type = 8n; // Float
  const flags =
    0x80n | // IsArray (bit 63)
    0x40n | // IsInlined (bit 62)
    0x20n | // IsCompressed (bit 61)
    0x10n;  // IsArrayEdit (bit 60)
  const rep = (flags << 56n) | (type << 48n) | payload;
  const parsed = __usdcTest_parseValueRep(rep);
  assert.equal(parsed.payload, payload);
  assert.equal(parsed.type, Number(type));
  assert.ok(parsed.isArray);
  assert.ok(parsed.isInlined);
  assert.ok(parsed.isCompressed);
  assert.ok(parsed.isArrayEdit);
});

test('USDC: TimeSamples layout matches Pixar (crateFile.cpp reader)', () => {
  // Build a tiny in-memory layout:
  // offset 0: int64 rel1 -> timesRep at +16
  // offset 16: u64 timesRep
  // offset 24: int64 rel2 -> values at +16 (i.e. 40)
  // offset 40: u64 numValues=2
  // offset 48: 2x u64 valueReps
  const timesRep = 0x111n;
  const v0 = 0x222n;
  const v1 = 0x333n;

  const buf = new Uint8Array(64);
  buf.set(i64le(16), 0); // rel1
  new DataView(buf.buffer).setBigUint64(16, timesRep, true);
  buf.set(i64le(16), 24); // rel2 from pOffset2(=24) to pValues(=40)
  buf.set(u64le(2), 40); // numValues
  new DataView(buf.buffer).setBigUint64(48, v0, true);
  new DataView(buf.buffer).setBigUint64(56, v1, true);

  const decoded = __usdcTest_decodeTimeSamplesLayout({
    data: buf,
    offset: 0,
    decodeValueRep: (rep) => {
      if (rep === timesRep) return { type: 'typedArray', elementType: 'double', value: new Float64Array([1.0, 2.0]) };
      if (rep === v0) return 'A';
      if (rep === v1) return 'B';
      return null;
    },
  });

  assert.equal(decoded.get(1.0), 'A');
  assert.equal(decoded.get(2.0), 'B');
});

test('USDC: compressed float array decoding supports Pixar i/t modes (crateFile.cpp)', () => {
  // Build a synthetic compressed float array payload for count=1.
  // Layout expected by our decoder helper:
  // base: code byte ('i' or 't')
  // - for 'i': u64 compressedSize, then compressed int payload
  // - for 't': u32 lutSize, lut floats, u64 compressedSize, then compressed uint payload

  // 'i' => integer 7 -> float 7.0
  const compI = makeCompressedIntsPayloadForSingleValue(7);
  const dataI = new Uint8Array(1 + 8 + compI.length);
  dataI[0] = 'i'.charCodeAt(0);
  dataI.set(u64le(compI.length), 1);
  dataI.set(compI, 9);
  const outI = __usdcTest_decodeCompressedFloatArray({ element: 'float', data: dataI, base: 0, count: 1 });
  assert.equal(outI.length, 1);
  assert.equal(outI[0], 7);

  // 't' => lut [0.25, 0.5], index=1 -> 0.5
  const compIdx = makeCompressedIntsPayloadForSingleValue(1);
  const dataT = new Uint8Array(1 + 4 + 8 + 8 + compIdx.length);
  dataT[0] = 't'.charCodeAt(0);
  new DataView(dataT.buffer).setUint32(1, 2, true); // lutSize
  new DataView(dataT.buffer).setFloat32(5, 0.25, true);
  new DataView(dataT.buffer).setFloat32(9, 0.5, true);
  dataT.set(u64le(compIdx.length), 13); // compressedSize
  dataT.set(compIdx, 21);
  const outT = __usdcTest_decodeCompressedFloatArray({ element: 'float', data: dataT, base: 0, count: 1 });
  assert.equal(outT.length, 1);
  assert.equal(outT[0], 0.5);
});







