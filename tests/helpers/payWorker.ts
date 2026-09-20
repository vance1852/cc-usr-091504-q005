import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { openDb } from '../../src/db/db.js';
import * as Requests from '../../src/services/requests.js';

/**
 * 模拟另一个进程/节点：独立连接打开同一个 SQLite 文件执行一个工作流动作，
 * 用于验证 BEGIN IMMEDIATE 串行化下的并发防超额。
 */
if (!isMainThread && parentPort) {
  const { dbPath, action, requestId, actor, eventId } = workerData as any;
  const db = openDb(dbPath);
  parentPort.on('message', (msg: string) => {
    if (msg !== 'start') return;
    try {
      if (action === 'pay') {
        const r = Requests.financePay(db, requestId, actor, { eventId });
        parentPort!.postMessage({ ok: true, idempotent: r.idempotent });
      } else if (action === 'submit') {
        Requests.submit(db, requestId, actor);
        parentPort!.postMessage({ ok: true });
      } else {
        parentPort!.postMessage({ ok: false, code: 'UNKNOWN_ACTION' });
      }
    } catch (e: any) {
      parentPort!.postMessage({ ok: false, code: e.code ?? 'ERROR', message: e.message });
    }
  });
}

function runWorker(dbPath: string, action: string, payload: Record<string, unknown>) {
  return new Promise<any>((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { dbPath, action, ...payload },
      execArgv: ['--import', 'tsx'],
    });
    worker.on('message', (m) => {
      worker.terminate();
      resolve(m);
    });
    worker.on('error', reject);
    worker.postMessage('start');
  });
}

export function startPayWorker(dbPath: string, requestId: string, actor: any, eventId: string) {
  return runWorker(dbPath, 'pay', { requestId, actor, eventId });
}

export function startSubmitWorker(dbPath: string, requestId: string, actor: any) {
  return runWorker(dbPath, 'submit', { requestId, actor });
}
