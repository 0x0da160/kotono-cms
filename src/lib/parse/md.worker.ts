/// <reference lib="webworker" />
/**
 * 解析層（仕様 16.1.1）：フォルダハンドル・通信を持たず、受け取った文字列だけを解析する。
 */
import { extractMediaRefs, parseMarkdown } from "../core/markdown-parse";
import { ARTICLE_MAX_BYTES } from "../core/budgets";

type Req = { id: number; op: "tree"; body: string } | { id: number; op: "refs"; body: string; cover: string | null };

self.onmessage = (event: MessageEvent<unknown>) => {
  const m = event.data as Partial<Req> | null;
  // 型・長さを検証する（32.1.1）
  if (
    m === null ||
    typeof m !== "object" ||
    typeof m.id !== "number" ||
    typeof m.body !== "string" ||
    m.body.length > ARTICLE_MAX_BYTES ||
    (m.op !== "tree" && m.op !== "refs")
  )
    return;
  if (m.op === "tree") self.postMessage({ id: m.id, result: parseMarkdown(m.body) });
  else {
    const cover = (m as { cover?: unknown }).cover;
    self.postMessage({ id: m.id, result: extractMediaRefs(m.body, typeof cover === "string" ? cover : null) });
  }
};
