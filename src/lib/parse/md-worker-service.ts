/**
 * 終了可能な Worker での Markdown 解析（仕様 16.1.1・34.2：1処理2秒）。
 * 時間上限を超えたら Worker を終了し、次の要求で作り直す。古い要求の結果は採用しない。
 */
import { MD_MAX_MS } from "../core/budgets";
import { refsFromTree, type MdParse, type MediaRefs } from "../core/markdown";
import type { MdService } from "./md-service";
import MdWorker from "./md.worker?worker&inline";

export class WorkerMdService implements MdService {
  private worker: Worker | null = null;
  private seq = 0;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly timeoutMs = MD_MAX_MS) {}

  private ensure(): Worker {
    this.worker ??= new MdWorker();
    return this.worker;
  }

  private kill(): void {
    this.worker?.terminate();
    this.worker = null;
  }

  private call<T>(msg: Record<string, unknown>, onTimeout: () => T, onFail: (m: string) => T): Promise<T> {
    const run = () =>
      new Promise<T>((resolve) => {
        let w: Worker;
        try {
          w = this.ensure();
        } catch {
          resolve(onFail("Markdown の解析処理（Worker）を起動できません。"));
          return;
        }
        const id = ++this.seq;
        const timer = setTimeout(() => {
          cleanup();
          // 同じイベントループの事後判定ではなく、Worker を終了して打ち切る（34.2）
          this.kill();
          resolve(onTimeout());
        }, this.timeoutMs);
        const onMessage = (e: MessageEvent<unknown>) => {
          const d = e.data as { id?: unknown; result?: unknown } | null;
          if (d === null || typeof d !== "object" || d.id !== id) return;
          cleanup();
          resolve(d.result as T);
        };
        const onError = (e: ErrorEvent) => {
          e.preventDefault();
          cleanup();
          this.kill();
          resolve(onFail("Markdown の解析処理が異常終了しました。"));
        };
        const cleanup = () => {
          clearTimeout(timer);
          w.removeEventListener("message", onMessage);
          w.removeEventListener("error", onError);
        };
        w.addEventListener("message", onMessage);
        w.addEventListener("error", onError);
        w.postMessage({ ...msg, id });
      });
    const p = this.tail.then(run, run);
    this.tail = p.catch(() => undefined);
    return p;
  }

  tree(body: string): Promise<MdParse> {
    return this.call<MdParse>(
      { op: "tree", body },
      () => ({ ok: false, reason: "timeout", message: "Markdown の解析が時間上限（2秒）を超えたため打ち切りました。" }),
      (message) => ({ ok: false, reason: "unavailable", message }),
    );
  }

  refs(body: string, coverSrc: string | null): Promise<MediaRefs> {
    return this.call<MediaRefs>(
      { op: "refs", body, cover: coverSrc },
      () => refsFromTree(null, coverSrc, "参照の解析が時間上限を超えました。"),
      (m) => refsFromTree(null, coverSrc, m),
    );
  }
}
