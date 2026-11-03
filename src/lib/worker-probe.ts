import ProbeWorker from "./probe.worker?worker&inline";

/**
 * インラインWorkerを起動し、応答が返るかを確認する。
 * 仕様 16.1.1: Worker 利用が file 起動で成立することも技術ゲート（TG08・TG09）の対象。
 */
export function probeWorker(timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new ProbeWorker();
    } catch {
      resolve(false);
      return;
    }
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      worker.terminate();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    worker.onmessage = (event: MessageEvent<{ echo?: unknown }>) => finish(event.data.echo === "ping");
    worker.onerror = (event) => {
      event.preventDefault();
      finish(false);
    };
    worker.postMessage("ping");
  });
}
