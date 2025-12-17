import { attachWorkerRpcServer } from './rpc.js';
import { UsdStage } from '../usd/stage.js';

type OpenUsdaParams = { src: string; identifier?: string };

let stage: UsdStage | null = null;

attachWorkerRpcServer(async (method, params) => {
  if (method === 'openUSDA') {
    const p = params as OpenUsdaParams;
    stage = UsdStage.openUSDA(p.src, p.identifier ?? '<memory>');
    return { ok: true };
  }

  if (method === 'listPrimPaths') {
    if (!stage) throw new Error('Stage not opened');
    return stage.listPrimPaths();
  }

  throw new Error(`Unknown method: ${method}`);
});


