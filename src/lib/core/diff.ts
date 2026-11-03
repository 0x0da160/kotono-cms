/**
 * 上限付きの原文行差分（仕様 12.2・34.2）。
 * 入力 1 MiB・20,000 行・処理 2 秒・描画 2,000 行。予算超過時は「差分なし」とせず省略理由を返す。
 */
import { DIFF_MAX_INPUT_BYTES, DIFF_MAX_LINES, DIFF_MAX_MS, DIFF_MAX_RENDER_LINES } from "./budgets";
import { utf8ByteLength } from "./bytes";

/** 編集距離の上限（メモリ O(D^2) を抑える。PROVISIONAL：仕様に個別値なし） */
export const DIFF_MAX_EDITS = 2_000;

export type DiffLine = { op: " " | "-" | "+"; text: string };

export type DiffResult =
  { ok: true; lines: DiffLine[]; truncated: boolean; changed: number } | { ok: false; reason: string };

/** Myers の O(ND) 差分。編集距離・時間に上限を設ける。 */
export function lineDiff(a: string, b: string, now: () => number = Date.now): DiffResult {
  if (utf8ByteLength(a) > DIFF_MAX_INPUT_BYTES || utf8ByteLength(b) > DIFF_MAX_INPUT_BYTES) {
    return { ok: false, reason: "差分の入力が上限（1 MiB）を超えるため省略しました。各版を退避して比較してください。" };
  }
  const x = a.split("\n");
  const y = b.split("\n");
  if (x.length > DIFF_MAX_LINES || y.length > DIFF_MAX_LINES) {
    return { ok: false, reason: `差分の行数が上限（${DIFF_MAX_LINES.toLocaleString()}行）を超えるため省略しました。` };
  }
  const n = x.length;
  const m = y.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // 各 d の処理前の v のうち [-d-1, d+1] だけを保持する（メモリ O(D^2)）
  const trace: Int32Array[] = [];
  const started = now();
  let found = false;
  outer: for (let d = 0; d <= max; d++) {
    if (d > DIFF_MAX_EDITS) {
      return {
        ok: false,
        reason: `変更行が多すぎるため差分を省略しました（上限 ${DIFF_MAX_EDITS.toLocaleString()} 行）。各版を退避して比較してください。`,
      };
    }
    if ((d & 63) === 0 && now() - started > DIFF_MAX_MS) {
      return { ok: false, reason: "差分の計算が時間上限（2秒）を超えたため省略しました。" };
    }
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let px: number;
      if (k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0))) px = v[offset + k + 1] ?? 0;
      else px = (v[offset + k - 1] ?? 0) + 1;
      let py = px - k;
      while (px < n && py < m && x[px] === y[py]) {
        px++;
        py++;
      }
      v[offset + k] = px;
      if (px >= n && py >= m) {
        found = true;
        break outer;
      }
    }
  }
  if (!found) return { ok: false, reason: "差分を計算できませんでした。" };
  // 逆順にたどって編集列を復元する
  const out: DiffLine[] = [];
  let px = n;
  let py = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const t = trace[d] as Int32Array;
    const at = (k: number) => t[k + d + 1] ?? 0;
    const k = px - py;
    let prevK: number;
    if (k === -d || (k !== d && at(k - 1) < at(k + 1))) prevK = k + 1;
    else prevK = k - 1;
    const prevX = d === 0 ? 0 : at(prevK);
    const prevY = d === 0 ? 0 : prevX - prevK;
    while (px > prevX && py > prevY) {
      out.push({ op: " ", text: x[px - 1] ?? "" });
      px--;
      py--;
    }
    if (d > 0) {
      if (px === prevX) out.push({ op: "+", text: y[py - 1] ?? "" });
      else out.push({ op: "-", text: x[px - 1] ?? "" });
    }
    px = prevX;
    py = prevY;
  }
  out.reverse();
  const changed = out.filter((l) => l.op !== " ").length;
  const truncated = out.length > DIFF_MAX_RENDER_LINES;
  return { ok: true, lines: truncated ? out.slice(0, DIFF_MAX_RENDER_LINES) : out, truncated, changed };
}
