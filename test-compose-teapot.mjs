import fs from 'node:fs';
import { UsdStage, resolveAssetPath } from './dist/index.js';

const entry = 'test/corpus/external/usd-wg-assets/assets-main/intent-vfx/scenes/teapotScene.usd';
const entryText = fs.readFileSync(entry, 'utf8');

let reads = 0;
const resolver = {
  async readText(assetPath, fromIdentifier) {
    reads++;
    const resolved = resolveAssetPath(assetPath, fromIdentifier);
    if (reads % 50 === 0) {
      console.log(`[resolver] reads=${reads} last=${assetPath} from=${fromIdentifier} -> ${resolved}`);
    }
    const text = fs.readFileSync(resolved, 'utf8');
    return { identifier: resolved, text };
  }
};

console.log('openUSDAWithResolver...');
const t0 = Date.now();
const stage = await UsdStage.openUSDAWithResolver(entryText, resolver, entry);
console.log('open ok ms=', Date.now() - t0, 'stack=', stage.layerStack.length, 'reads=', reads);

console.log('composePrimIndexWithResolver...');
const t1 = Date.now();
const composed = await stage.composePrimIndexWithResolver(resolver);
console.log('compose ok ms=', Date.now() - t1, 'reads=', reads);

// Count prims
const list = stage.listPrimPaths();
console.log('stage prim paths=', list.length);
