/**
 * 記事フォルダ単位の操作：複製（10.2・13.4）と削除（19・11.3）。
 */
import { verifyCandidateBytes, type Problem } from "../core/article-doc";
import { INDEX_FILE } from "./repo";
import { writeAndVerify } from "./save";
import { enumerateTree, fingerprint, readAllBytes, sameFingerprints, type Fingerprint, type TreeEntry } from "./tree";
import { classifyFsError, fsErrorMessage, type DirHandleLike, type FileHandleLike } from "./types";

// ---------------------------------------------------------------------------
// 複製

export interface DuplicateParams {
  readonly articles: DirHandleLike;
  readonly sourceId: string;
  readonly newId: string;
  /** 計画時に列挙・ハッシュした元の状態 */
  readonly planned: readonly Fingerprint[];
  readonly sourceEntries: readonly TreeEntry[];
  /** 元の再照合の後に、最後の index.md 候補を作る（日時はこの工程で取得する：36） */
  readonly buildIndex: () => { ok: true; bytes: Uint8Array } | { ok: false; problems: Problem[] };
  readonly ownedDirs: Set<string>;
}

export type DuplicateResult =
  | { kind: "done"; bytes: Uint8Array; files: number }
  | { kind: "exists" }
  | { kind: "source-changed"; message: string }
  | { kind: "candidate-invalid"; problems: Problem[] }
  /** 作成先が残っている。完成記事ではない（13.4） */
  | { kind: "incomplete"; path: string; message: string };

export async function duplicateArticle(p: DuplicateParams): Promise<DuplicateResult> {
  const path = `content/articles/${p.newId}/`;
  try {
    await p.articles.getDirectoryHandle(p.newId);
    return { kind: "exists" };
  } catch (e) {
    const k = classifyFsError(e);
    if (k === "type-mismatch") return { kind: "exists" };
    if (k !== "not-found")
      return { kind: "incomplete", path: "", message: `作成先を確認できません：${fsErrorMessage(k)}` };
  }
  let dest: DirHandleLike;
  try {
    dest = await p.articles.getDirectoryHandle(p.newId, { create: true });
    for await (const c of dest.values())
      return { kind: "incomplete", path, message: `作成直後のフォルダに想定外のエントリー（${c.name}）があります。` };
    p.ownedDirs.add(p.newId);
  } catch (e) {
    return {
      kind: "incomplete",
      path: "",
      message: `記事フォルダを作成できません：${fsErrorMessage(classifyFsError(e))}`,
    };
  }

  // index.md 以外を先にコピー・検証する
  let files = 0;
  for (const e of p.sourceEntries) {
    if (e.path === INDEX_FILE) continue;
    const parts = e.path.split("/");
    try {
      let d = dest;
      for (const seg of e.kind === "dir" ? parts : parts.slice(0, -1))
        d = await d.getDirectoryHandle(seg, { create: true });
      if (e.kind === "dir") continue;
      const src = await readAllBytes(e.handle as FileHandleLike, Number.MAX_SAFE_INTEGER);
      if (!src.ok) return { kind: "incomplete", path, message: `${e.path} を読み取れません：${src.message}` };
      const name = parts.at(-1) ?? "";
      const h = await d.getFileHandle(name, { create: true });
      if ((await h.getFile()).size !== 0)
        return { kind: "incomplete", path, message: `${e.path} の作成先が空ではありません。` };
      const w = await writeAndVerify(h, src.bytes, null, Number.MAX_SAFE_INTEGER);
      if (w.kind !== "saved")
        return { kind: "incomplete", path, message: `${e.path} のコピーを確認できません：${w.message}` };
      files++;
    } catch (err) {
      return {
        kind: "incomplete",
        path,
        message: `${e.path} をコピーできません：${fsErrorMessage(classifyFsError(err))}`,
      };
    }
  }

  // 元の最後の再照合（集合・内容）。同時点スナップショットは保証しない（10.2）
  let source: DirHandleLike;
  try {
    source = await p.articles.getDirectoryHandle(p.sourceId);
  } catch (e) {
    return { kind: "incomplete", path, message: `複製元を開けません：${fsErrorMessage(classifyFsError(e))}` };
  }
  const again = await enumerateTree(source);
  if (!again.ok) return { kind: "incomplete", path, message: again.message };
  const fp = await fingerprint(again.entries);
  if (!fp.ok) return { kind: "incomplete", path, message: fp.message };
  const diff = sameFingerprints(p.planned, fp.items);
  if (diff) return { kind: "source-changed", message: `${diff}（作成途中の ${path} は完成記事ではありません）` };

  // 最後に正常な index.md を確定する
  const c = p.buildIndex();
  if (!c.ok) return { kind: "candidate-invalid", problems: c.problems };
  const check = verifyCandidateBytes(c.bytes, p.newId);
  if (!check.ok) return { kind: "candidate-invalid", problems: check.problems };
  try {
    const h = await dest.getFileHandle(INDEX_FILE, { create: true });
    if ((await h.getFile()).size !== 0)
      return { kind: "incomplete", path, message: "index.md の作成先が空ではありません。" };
    const w = await writeAndVerify(h, c.bytes, null);
    if (w.kind !== "saved") return { kind: "incomplete", path, message: `index.md を確認できません：${w.message}` };
  } catch (e) {
    return { kind: "incomplete", path, message: `index.md を作成できません：${fsErrorMessage(classifyFsError(e))}` };
  }
  return { kind: "done", bytes: c.bytes, files };
}

// ---------------------------------------------------------------------------
// 削除（確認済みの対象を個別に削除する。再帰一括削除に依存しない：19）

export interface DeleteReport {
  readonly deleted: string[];
  readonly remaining: string[];
  readonly unknown: string[];
  readonly error: string | null;
}

/**
 * `targets` は記事フォルダ内の相対パス。ファイル → 深いフォルダ → 浅いフォルダの順に削除する。
 * `removeSelf` が真なら最後に記事フォルダ自体を `parent` から削除する。
 */
export async function deleteEntries(
  dir: DirHandleLike,
  targets: readonly Fingerprint[],
  remove: { parent: DirHandleLike; name: string } | null,
  beforeEach: () => string | null = () => null,
): Promise<DeleteReport> {
  const deleted: string[] = [];
  const order = [
    ...targets.filter((t) => t.kind === "file"),
    ...targets.filter((t) => t.kind === "dir").sort((a, b) => b.path.split("/").length - a.path.split("/").length),
  ];
  const all = order.map((t) => t.path);
  const fail = (i: number, error: string, unsure: boolean): DeleteReport => ({
    deleted,
    unknown: unsure ? [all[i] ?? ""] : [],
    remaining: all.slice(unsure ? i + 1 : i).concat(remove ? ["（記事フォルダ）"] : []),
    error,
  });
  for (let i = 0; i < order.length; i++) {
    const t = order[i] as Fingerprint;
    const stop = beforeEach();
    if (stop) return fail(i, stop, false);
    const parts = t.path.split("/");
    let parent = dir;
    try {
      for (const seg of parts.slice(0, -1)) parent = await parent.getDirectoryHandle(seg);
      if (!parent.removeEntry) return fail(i, "このブラウザではファイルを削除できません。", false);
      await parent.removeEntry(parts.at(-1) ?? "");
    } catch (e) {
      return fail(i, `${t.path} を削除できません：${fsErrorMessage(classifyFsError(e))}`, true);
    }
    // 結果照合：消えたことを確認する
    try {
      if (t.kind === "dir") await parent.getDirectoryHandle(parts.at(-1) ?? "");
      else await parent.getFileHandle(parts.at(-1) ?? "");
      return fail(i, `${t.path} が削除後も残っています。`, false);
    } catch (e) {
      if (classifyFsError(e) !== "not-found") return fail(i, `${t.path} の削除結果を確認できません。`, true);
    }
    deleted.push(t.path);
  }
  if (remove) {
    try {
      if (!remove.parent.removeEntry) throw new Error("removeEntry");
      await remove.parent.removeEntry(remove.name);
      await remove.parent.getDirectoryHandle(remove.name).then(
        () => {
          throw Object.assign(new Error("still"), { name: "Still" });
        },
        (e: unknown) => {
          if (classifyFsError(e) !== "not-found") throw e;
        },
      );
    } catch (e) {
      const still = (e as { name?: string }).name === "Still";
      return {
        deleted,
        remaining: still ? ["（記事フォルダ）"] : [],
        unknown: still ? [] : ["（記事フォルダ）"],
        error: still
          ? "記事フォルダが削除後も残っています（想定外のエントリーの可能性）。"
          : "記事フォルダの削除を確認できません。",
      };
    }
  }
  return { deleted, remaining: [], unknown: [], error: null };
}
