export type RpcRequest = {
    id: string;
    method: string;
    params: unknown;
};

export type RpcResponse =
    | { id: string; ok: true; result: unknown }
    | { id: string; ok: false; error: { message: string; stack?: string } };

export type RpcHandler = (method: string, params: unknown) => unknown | Promise<unknown>;

/**
 * Client-side helper to call a Worker with a simple request/response protocol.
 */
export class WorkerRpcClient {
    private nextId = 1;
    private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

    constructor(private readonly worker: Worker) {
        worker.addEventListener('message', (evt: MessageEvent) => {
            const msg = evt.data as RpcResponse;
            if (!msg || typeof msg !== 'object' || !('id' in msg)) return;
            const p = this.pending.get(msg.id);
            if (!p) return;
            this.pending.delete(msg.id);
            if (msg.ok) p.resolve(msg.result);
            else p.reject(Object.assign(new Error(msg.error.message), { stack: msg.error.stack }));
        });
    }

    call<T = unknown>(method: string, params: unknown): Promise<T> {
        const id = String(this.nextId++);
        const req: RpcRequest = { id, method, params };
        return new Promise<T>((resolve, reject) => {
            // Store erasured handlers; we re-cast at the boundary when resolving.
            this.pending.set(id, { resolve: resolve as unknown as (v: unknown) => void, reject });
            this.worker.postMessage(req);
        });
    }
}

/**
 * Worker-side helper to respond to the same protocol.
 */
export function attachWorkerRpcServer(handler: RpcHandler): void {
    self.addEventListener('message', async (evt: MessageEvent) => {
        const req = evt.data as RpcRequest;
        if (!req || typeof req !== 'object' || typeof req.id !== 'string' || typeof req.method !== 'string') return;
        try {
            const result = await handler(req.method, req.params);
            const res: RpcResponse = { id: req.id, ok: true, result };
            (self as unknown as Worker).postMessage(res);
        } catch (err) {
            const e = err as Error;
            const res: RpcResponse = {
                id: req.id,
                ok: false,
                error: { message: e?.message ?? String(err), stack: e?.stack },
            };
            (self as unknown as Worker).postMessage(res);
        }
    });
}


