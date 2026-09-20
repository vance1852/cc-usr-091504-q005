// Runs inside a worker thread: opens its OWN connection to the same SQLite
// file, reports ready, waits on the shared gate, then performs one guarded
// operation. The readiness handshake guarantees every worker is already
// blocked on the gate when it opens, so the transactions genuinely overlap.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { submitRequest, financePay } from '../src/services/requests.js';
import { approveRefund } from '../src/services/refunds.js';

if (!isMainThread && parentPort) {
  const { dbFile, op, ready, gate, payload } = workerData as {
    dbFile: string;
    op: 'submit' | 'pay' | 'paySameKey' | 'refund';
    ready: Int32Array;
    gate: Int32Array;
    payload: any;
  };
  const db = openDb(dbFile);

  // Report readiness, then block until the main thread opens the gate.
  Atomics.add(ready, 0, 1);
  Atomics.wait(gate, 0, 0, 15000);

  try {
    let result: any = null;
    if (op === 'submit') {
      submitRequest(db, payload.actorId, payload.requestId);
      result = { ok: true };
    } else if (op === 'pay') {
      result = financePay(db, payload.actorId, payload.requestId, payload.idemKey);
    } else if (op === 'paySameKey') {
      result = financePay(db, payload.actorId, payload.requestId, 'SAME-KEY-1');
    } else if (op === 'refund') {
      result = approveRefund(db, payload.actorId, payload.refundId, payload.idemKey);
    }
    parentPort.postMessage({ ok: true, result });
  } catch (err: any) {
    parentPort.postMessage({ ok: false, code: err.code ?? err.message, message: err.message });
  }
}

export function runWorkers(
  file: string,
  specs: Array<{ op: string; payload: any }>,
): Promise<Array<{ ok: boolean; code?: string; result?: any; message?: string }>> {
  const ready = new Int32Array(new SharedArrayBuffer(4));
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const workerFile = fileURLToPath(new URL('./concurrent-worker.ts', import.meta.url));
  return new Promise((resolve, reject) => {
    const outcomes: any[] = new Array(specs.length);
    let done = 0;
    specs.forEach((spec, i) => {
      const worker = new Worker(workerFile, {
        workerData: { dbFile: file, op: spec.op, ready, gate, payload: spec.payload },
        execArgv: ['--import', 'tsx'],
      });
      worker.once('message', (msg) => {
        outcomes[i] = msg;
        done += 1;
        if (done === specs.length) resolve(outcomes);
      });
      worker.once('error', reject);
    });
    // Open the gate only once every worker has reported ready.
    const deadline = Date.now() + 15000;
    const tick = () => {
      if (Atomics.load(ready, 0) >= specs.length) {
        // Store first so a worker that has not reached wait() yet returns
        // immediately ("not-equal"), then wake everyone already blocked.
        Atomics.store(gate, 0, 1);
        Atomics.notify(gate, 0);
      } else if (Date.now() < deadline) {
        setTimeout(tick, 2);
      } else {
        reject(new Error('workers did not become ready in time'));
      }
    };
    setTimeout(tick, 5);
  });
}
