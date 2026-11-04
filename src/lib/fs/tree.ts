/**
 * 記事フォルダの有界な再帰列挙と、ファイル内容の照合（仕様 10.2・19・19.1・34.4）。
 *
 * 非保証：File System Access API はシンボリックリンク・ジャンクション等を区別して返さない
 * （TG05 未着手）。列挙で見えたエントリーは通常ファイル・フォルダとして扱っている。
 */
import { TREE_MAX_DEPTH, TREE_MAX_ENTRIES, TREE_MAX_MS, TREE_MAX_TOTAL_BYTES } from "../core/budgets";
import { bytesEqual, sha256Hex } from "../core/bytes";
import { classifyFsError, fsErrorMessage, type DirHandleLike, type FileHandleLike } from "./types";

export interface TreeEntry {
  /** フォルダ内の相対パス（`/` 区切り、末尾 `/` なし） */
  readonly path: string;
  readonly kind: "file" | "dir";
  readonly size: number;
  readonly handle: FileHandleLike | DirHandleLike;
}

export type TreeResult =
  { ok: true; entries: TreeEntry[]; files: number; dirs: number; totalBytes: number } | { ok: false; message: string };

export interface TreeLimits {
  readonly maxEntries: number;
  readonly maxDepth: number;
  readonly maxBytes: number;
  readonly maxMs: number;
}

export const DEFAULT_TREE_LIMITS: TreeLimits = {
  maxEntries: TREE_MAX_ENTRIES,
  maxDepth: TREE_MAX_DEPTH,
  maxBytes: TREE_MAX_TOTAL_BYTES,
  maxMs: TREE_MAX_MS,
};

/** 名前に区切り文字・制御文字・ドット区間があるエントリーはコピー・退避できない */
function unsafeName(name: string): boolean {
  // eslint-disable-next-line no-control-regex -- 制御文字を含む名前を拒否する
  return name === "" || name === "." || name === ".." || /[/\\\u0000-\u001f]/.test(name);
}

/** 深さ優先で全エントリーを列挙する。上限を超えたら途中で止め、部分結果を返さない（34.4） */
export async function enumerateTree(
  dir: DirHandleLike,
  limits: TreeLimits = DEFAULT_TREE_LIMITS,
  now: () => number = () => Date.now(),
): Promise<TreeResult> {
  const t0 = now();
  const entries: TreeEntry[] = [];
  let totalBytes = 0;
  let files = 0;
  let dirs = 0;
  const visit = async (d: DirHandleLike, prefix: string, depth: number): Promise<string | null> => {
    if (depth > limits.maxDepth) return `フォルダの深さが上限（${limits.maxDepth}）を超えています。`;
    const children: (FileHandleLike | DirHandleLike)[] = [];
    try {
      for await (const c of d.values()) {
        children.push(c);
        if (entries.length + children.length > limits.maxEntries)
          return `エントリー数が上限（${limits.maxEntries.toLocaleString()}）を超えています。`;
      }
    } catch (e) {
      return `${prefix || "./"} を列挙できません：${fsErrorMessage(classifyFsError(e))}`;
    }
    children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const c of children) {
      if (now() - t0 > limits.maxMs) return "列挙が時間上限（10秒）を超えました。完了していないため操作できません。";
      if (unsafeName(c.name)) return `安全に扱えない名前のエントリーがあります（${JSON.stringify(c.name)}）。`;
      const path = prefix === "" ? c.name : `${prefix}/${c.name}`;
      if (c.kind === "directory") {
        dirs++;
        entries.push({ path, kind: "dir", size: 0, handle: c });
        const err = await visit(c, path, depth + 1);
        if (err) return err;
      } else if (c.kind === "file") {
        let size: number;
        try {
          size = (await c.getFile()).size;
        } catch (e) {
          return `${path} を読み取れません：${fsErrorMessage(classifyFsError(e))}`;
        }
        files++;
        totalBytes += size;
        if (totalBytes > limits.maxBytes) return "ファイルの合計容量が上限（2 GiB）を超えています。";
        entries.push({ path, kind: "file", size, handle: c });
      } else {
        return `種類を判定できないエントリーがあります（${path}）。`;
      }
    }
    return null;
  };
  const err = await visit(dir, "", 1);
  if (err) return { ok: false, message: err };
  return { ok: true, entries, files, dirs, totalBytes };
}

/** ファイル全体を読む。上限を超える場合は読まない。 */
export async function readAllBytes(
  handle: FileHandleLike,
  maxBytes: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; message: string; missing?: boolean }> {
  try {
    const f = await handle.getFile();
    if (f.size > maxBytes)
      return { ok: false, message: `ファイルが大きすぎます（${f.size.toLocaleString()} バイト）。` };
    return { ok: true, bytes: new Uint8Array(await f.arrayBuffer()) };
  } catch (e) {
    const k = classifyFsError(e);
    return { ok: false, message: fsErrorMessage(k), missing: k === "not-found" };
  }
}

export interface Fingerprint {
  readonly path: string;
  readonly kind: "file" | "dir";
  readonly size: number;
  readonly sha256: string | null;
}

/**
 * 列挙結果の各ファイルを読み、ハッシュを付ける。
 * 非保証：SubtleCrypto に逐次ハッシュがないため、1ファイルずつ全体を読む（34.4 の緊張点）。
 */
export async function fingerprint(
  entries: readonly TreeEntry[],
): Promise<{ ok: true; items: Fingerprint[] } | { ok: false; message: string }> {
  const items: Fingerprint[] = [];
  for (const e of entries) {
    if (e.kind === "dir") {
      items.push({ path: e.path, kind: "dir", size: 0, sha256: null });
      continue;
    }
    const r = await readAllBytes(e.handle as FileHandleLike, TREE_MAX_TOTAL_BYTES);
    if (!r.ok) return { ok: false, message: `${e.path}：${r.message}` };
    items.push({ path: e.path, kind: "file", size: r.bytes.length, sha256: await sha256Hex(r.bytes) });
  }
  return { ok: true, items };
}

/** 集合・種類・サイズ・内容ハッシュが同じか（追加・変更・種類変更を検出する：19） */
export function sameFingerprints(a: readonly Fingerprint[], b: readonly Fingerprint[]): string | null {
  const key = (f: Fingerprint) => f.path;
  const am = new Map(a.map((f) => [key(f), f]));
  const bm = new Map(b.map((f) => [key(f), f]));
  for (const [p, f] of bm) {
    const o = am.get(p);
    if (!o) return `確認後に追加されたエントリーがあります：${p}`;
    if (o.kind !== f.kind) return `確認後に種類が変わったエントリーがあります：${p}`;
    if (o.size !== f.size || o.sha256 !== f.sha256) return `確認後に内容が変わったファイルがあります：${p}`;
  }
  for (const p of am.keys()) if (!bm.has(p)) return `確認後に見つからなくなったエントリーがあります：${p}`;
  return null;
}

/** 相対パスでハンドルを解決する（親から許可された相対セグメントだけを辿る：32.1） */
export async function resolvePath(
  root: DirHandleLike,
  path: string,
  kind: "file" | "dir",
): Promise<FileHandleLike | DirHandleLike> {
  const parts = path.split("/");
  let d = root;
  for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
  const last = parts.at(-1) ?? "";
  return kind === "dir" ? d.getDirectoryHandle(last) : d.getFileHandle(last);
}

/** 新しいファイルを作り、空であることを確かめてから書き、再読込で一致を確認する */
export async function writeNewFile(
  dir: DirHandleLike,
  name: string,
  bytes: Uint8Array,
): Promise<{ ok: true; handle: FileHandleLike } | { ok: false; message: string; created: boolean }> {
  try {
    await dir.getFileHandle(name);
    return { ok: false, message: `${name} は既に存在します。上書きしません。`, created: false };
  } catch (e) {
    const k = classifyFsError(e);
    if (k !== "not-found")
      return {
        ok: false,
        message: k === "type-mismatch" ? `${name} の位置に同名のフォルダがあります。` : fsErrorMessage(k),
        created: false,
      };
  }
  let handle: FileHandleLike;
  try {
    handle = await dir.getFileHandle(name, { create: true });
  } catch (e) {
    return { ok: false, message: `${name} を作成できません：${fsErrorMessage(classifyFsError(e))}`, created: false };
  }
  try {
    if ((await handle.getFile()).size !== 0)
      return { ok: false, message: `${name} が作成直後に空ではありません。書き込みを止めました。`, created: true };
    const w = await handle.createWritable({ keepExistingData: false });
    try {
      await w.write(bytes);
      await w.close();
    } catch (e) {
      try {
        await w.abort();
      } catch {
        // 実状態の再読込で判定する
      }
      throw e;
    }
  } catch (e) {
    return {
      ok: false,
      message: `${name} の書き込みに失敗しました：${fsErrorMessage(classifyFsError(e))}`,
      created: true,
    };
  }
  const back = await readAllBytes(handle, bytes.length);
  if (!back.ok || !bytesEqual(back.bytes, bytes))
    return { ok: false, message: `${name} を読み直した内容が一致しません。`, created: true };
  return { ok: true, handle };
}
