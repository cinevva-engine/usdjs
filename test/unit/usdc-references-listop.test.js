import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { UsdStage } from '../../dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const corpusRoot = path.join(__dirname, '../corpus/external');

test('USDC parser: decodes prepend references listOp (Industrial_NVD Pallets_A1.usd)', async () => {
  const usdPath = path.join(
    corpusRoot,
    'Industrial_NVD@10012/Assets/ArchVis/Industrial/Piles/Pallets_A1.usd',
  );
  if (!existsSync(usdPath)) {
    console.log('Skipping: Pallets_A1.usd not found');
    return;
  }

  const buffer = readFileSync(usdPath);
  const stage = UsdStage.open(buffer, usdPath);

  const world = stage.rootLayer.root.children.get('World');
  assert.ok(world, 'World prim should exist');

  const palletC1 = world.children.get('Pallet_C1');
  assert.ok(palletC1, 'Pallet_C1 prim should exist');

  const inst = palletC1.children.get('Pallet_C1');
  assert.ok(inst, 'Pallet_C1/Pallet_C1 prim should exist');

  const refs = inst.metadata?.references;
  assert.ok(refs, 'references metadata should exist');

  // Expect listOp dict form:
  // { type:'dict', value:{ op:{type:'token', value:'prepend'}, value:{ type:'array', ... } } }
  assert.equal(refs.type, 'dict');
  assert.equal(refs.value?.op?.type, 'token');
  assert.equal(refs.value?.op?.value, 'prepend');

  const inner = refs.value?.value;
  assert.ok(inner, 'listOp should contain inner value');
  assert.equal(inner.type, 'array');
  assert.equal(inner.elementType, 'reference');
  assert.ok(Array.isArray(inner.value) && inner.value.length >= 1, 'references array should have items');

  const first = inner.value[0];
  assert.equal(first.type, 'reference');
  assert.equal(first.assetPath, '../Pallets/Pallet_C1.usd');
});




