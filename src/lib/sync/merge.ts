/**
 * 同期時の簡易マージ（仕様 3.2 第40.5節、ADR-0006 第8.5節）。
 *
 * - パスごとの三方向比較：片側だけの変更はその側、両側が同じならそのまま、それ以外は競合。
 * - 記事（content/articles/<ID>/index.md）だけ、行単位の三方向マージを試みる。変更範囲が重なれば競合。
 *   frontmatter は 1 キー 1 行の行として扱う（片側だけが変えたキーはその値）。両側が変えた `updatedAt` は新しい方。
 *   `id`・`createdAt` が食い違えば競合のまま。
 * - 画像・設定・その他のファイルは自動では合わせない。
 * ネイティブ Git より保守的でよい（自動で合わせるものを競合にするのは可、逆は不可）。
 */
import { lineDiff } from "../core/diff";

export interface Side {
  readonly oid: string;
  readonly mode: string;
}

export type PathResult =
  | { kind: "take"; from: "local" | "remote"; item: Side | null }
  | { kind: "merged"; bytes: Uint8Array; mode: string }
  | { kind: "conflict"; reason: string };

/** パスごとの三方向比較（内容の読み込みが要る自動マージは呼び出し側） */
export function classify(base: Side | null, local: Side | null, remote: Side | null): PathResult | "text" {
  const same = (a: Side | null, b: Side | null) =>
    a === null ? b === null : b !== null && a.oid === b.oid && a.mode === b.mode;
  if (same(local, remote)) return { kind: "take", from: "local", item: local };
  if (same(base, local)) return { kind: "take", from: "remote", item: remote };
  if (same(base, remote)) return { kind: "take", from: "local", item: local };
  if (local === null || remote === null)
    return { kind: "conflict", reason: local === null ? "手元で削除、リモートで変更" : "手元で変更、リモートで削除" };
  if (local.mode !== remote.mode) return { kind: "conflict", reason: "ファイルの種類が両側で違います" };
  return "text";
}

export const ARTICLE_FILE = /^content\/articles\/[^/]+\/index\.md$/;

interface Hunk {
  /** 祖先の行範囲 [start, end) */
  start: number;
  end: number;
  lines: string[];
}

function hunks(base: string[], other: string): Hunk[] | null {
  const d = lineDiff(base.join("\n"), other);
  if (!d.ok || d.truncated) return null;
  const out: Hunk[] = [];
  let i = 0;
  let cur: Hunk | null = null;
  for (const l of d.lines) {
    if (l.op === " ") {
      if (cur) out.push(cur);
      cur = null;
      i++;
    } else if (l.op === "-") {
      cur ??= { start: i, end: i, lines: [] };
      cur.end = ++i;
    } else {
      cur ??= { start: i, end: i, lines: [] };
      cur.lines.push(l.text);
    }
  }
  if (cur) out.push(cur);
  return out;
}

const KEY_LINE = /^([A-Za-z][A-Za-z0-9_]*):\s?(.*)$/;

/** 両側が変えた行範囲が `updatedAt:` の 1 行だけなら、新しい方を採る */
function resolveUpdatedAt(a: Hunk, b: Hunk, base: string[]): string[] | null {
  if (a.start !== b.start || a.end !== b.end || a.end - a.start !== 1 || a.lines.length !== 1 || b.lines.length !== 1)
    return null;
  const k0 = KEY_LINE.exec(base[a.start] ?? "");
  const ka = KEY_LINE.exec(a.lines[0] ?? "");
  const kb = KEY_LINE.exec(b.lines[0] ?? "");
  if (!k0 || !ka || !kb || k0[1] !== "updatedAt" || ka[1] !== "updatedAt" || kb[1] !== "updatedAt") return null;
  const ta = Date.parse((ka[2] ?? "").replace(/^["']|["']$/g, ""));
  const tb = Date.parse((kb[2] ?? "").replace(/^["']|["']$/g, ""));
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return [(ta >= tb ? a.lines[0] : b.lines[0]) as string];
}

/** 行単位の三方向マージ。重なる変更があれば null */
export function mergeText(base: string, local: string, remote: string): string | null {
  if (local === remote) return local;
  if (base === local) return remote;
  if (base === remote) return local;
  const b = base.split("\n");
  const hl = hunks(b, local);
  const hr = hunks(b, remote);
  if (!hl || !hr) return null;
  const out: string[] = [];
  let pos = 0;
  let i = 0;
  let j = 0;
  // 接する変更も重なりとみなす（ネイティブ Git と同じく保守的に）
  const overlaps = (x: Hunk, y: Hunk) => x.start <= y.end && y.start <= x.end;
  while (i < hl.length || j < hr.length) {
    const x = hl[i];
    const y = hr[j];
    let h: Hunk;
    if (x && y && overlaps(x, y)) {
      const same = x.start === y.start && x.end === y.end && x.lines.join("\n") === y.lines.join("\n");
      const lines = same ? x.lines : resolveUpdatedAt(x, y, b);
      if (!lines) return null;
      h = { start: x.start, end: x.end, lines };
      i++;
      j++;
    } else if (x && (!y || x.start < y.start)) {
      h = x;
      i++;
    } else if (y) {
      h = y;
      j++;
    } else break;
    if (h.start < pos) return null;
    out.push(...b.slice(pos, h.start), ...h.lines);
    pos = h.end;
  }
  out.push(...b.slice(pos));
  const merged = out.join("\n");
  // id・createdAt は食い違えば競合（自動では選ばない）
  for (const key of ["id", "createdAt"]) {
    const vals = new Set([fm(local, key), fm(remote, key)]);
    if (vals.size > 1) return null;
    if (fm(merged, key) !== fm(local, key)) return null;
  }
  return merged;
}

function fm(text: string, key: string): string | null {
  const m = /^---\n([\s\S]*?)\n---/.exec(text.replace(/^\uFEFF/, ""));
  if (!m) return null;
  for (const line of (m[1] as string).split("\n")) {
    const k = KEY_LINE.exec(line);
    if (k && k[1] === key) return (k[2] ?? "").trim();
  }
  return null;
}
