/**
 * Git 用の実フォルダアダプター（仕様 31・32.1）。
 *
 * - 選択ルートから相対パスのセグメントだけを辿る。`..`・空・区切り文字・制御文字を含むパスは拒否する。
 * - 書き込みは `.git/` の内側だけに閉じる（31.1：`.git` へのアクセスは Git 専用の許可範囲）。
 *   作業ツリー（記事・画像）へは書き込まない。CMS の Git 機能は checkout・復元をしない。
 * - 読み込みは常にバイト上限付き。上限を超えるファイルは読まない（34.5）。
 * - rename・ロック取得・mode の読み書きは File System Access API で実現できない（31.1 の「実現不能」）。
 *   ref・index の置換は `createWritable()` のクローズ時反映に依存し、原子性は保証しない。
 */
import { PROVISIONAL_GIT_PATH_MAX } from "../core/budgets";
import { bytesEqual } from "../core/bytes";
import {
  classifyFsError,
  fsErrorMessage,
  type DirHandleLike,
  type FileHandleLike,
  type FsErrorKind,
} from "../fs/types";

export const GIT_DIR = ".git";

export type ReadState =
  | { kind: "bytes"; bytes: Uint8Array }
  | { kind: "missing" }
  | { kind: "wrong-kind" }
  | { kind: "too-large"; size: number }
  | { kind: "error"; errorKind: FsErrorKind; message: string };

export class GitFsError extends Error {
  constructor(
    message: string,
    readonly code: "path" | "scope" | "missing" | "exists" | "io" | "verify" | "too-large" | "blocked",
  ) {
    super(message);
    this.name = "GitFsError";
  }
}

/**
 * Chromium 系ブラウザ（Chrome・Edge など）は、File System Access API による次の場所への書き込みを
 * 常に禁止する（chrome_file_system_access_permission_context.cc の kBlockWrite：
 * `.git/config`・`.git/hooks`・`.git/modules`）。禁止は SecurityError として現れる。
 */
export const BROWSER_BLOCKED_MESSAGE =
  "ブラウザ（Chrome・Edge など）が安全のため .git/config・.git/hooks・.git/modules への書き込みを禁止しています。";

/** 書き込み系の失敗を GitFsError にする。SecurityError はブラウザの禁止として区別する */
function writeError(e: unknown, what: string, otherCode: "io" | "missing-or-io"): GitFsError {
  const k = classifyFsError(e);
  if (k === "security") return new GitFsError(`${what}：${BROWSER_BLOCKED_MESSAGE}`, "blocked");
  const code = otherCode === "missing-or-io" && k === "not-found" ? "missing" : "io";
  return new GitFsError(`${what}：${fsErrorMessage(k)}`, code);
}

/** Git 用パスの検証（20.2.1：逸脱・絶対パス・OS 固有表現を拒否） */
export function checkGitPath(path: string): string | null {
  if (path.length === 0) return "パスが空です。";
  if (path.length > PROVISIONAL_GIT_PATH_MAX) return "パスが長すぎます。";
  if (path.startsWith("/")) return "絶対パスは扱いません。";
  for (const seg of path.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return `不正なパス区間があります（${path}）。`;
    // eslint-disable-next-line no-control-regex -- 制御文字を含むパスを拒否する
    if (/[\\\u0000-\u001f\u007f]/.test(seg)) return `区切り文字・制御文字を含むパスです（${JSON.stringify(path)}）。`;
    // Windows の代替データストリーム・ドライブ表記、末尾のドット・空白（OS 依存の別名）
    if (seg.includes(":") || /[. ]$/.test(seg)) return `OS 依存の表現を含むパスです（${JSON.stringify(path)}）。`;
  }
  return null;
}

export interface FileStat {
  readonly size: number;
  readonly mtimeMs: number;
}

export class GitFs {
  constructor(readonly root: DirHandleLike) {}

  #split(path: string): string[] {
    const bad = checkGitPath(path);
    if (bad) throw new GitFsError(bad, "path");
    return path.split("/");
  }

  #assertWritable(parts: string[]) {
    if (parts[0] !== GIT_DIR || parts.length < 2)
      throw new GitFsError("Git 機能は .git の外へ書き込みません。", "scope");
  }

  async dir(path: string, create = false): Promise<DirHandleLike> {
    if (path === "") return this.root;
    const parts = this.#split(path);
    if (create) this.#assertWritable([...parts, "x"]);
    let d = this.root;
    for (const p of parts) d = await d.getDirectoryHandle(p, create ? { create: true } : {});
    return d;
  }

  async file(path: string): Promise<FileHandleLike> {
    const parts = this.#split(path);
    const name = parts.pop() as string;
    let d = this.root;
    for (const p of parts) d = await d.getDirectoryHandle(p);
    return d.getFileHandle(name);
  }

  /** 種類の確認（存在しない・ファイル・フォルダ）。権限等の失敗は例外のまま返す */
  async kind(path: string): Promise<"missing" | "file" | "dir"> {
    const parts = this.#split(path);
    const name = parts.pop() as string;
    let d = this.root;
    try {
      for (const p of parts) d = await d.getDirectoryHandle(p);
    } catch (e) {
      const k = classifyFsError(e);
      if (k === "not-found" || k === "type-mismatch") return "missing";
      throw e;
    }
    for (const via of ["file", "dir"] as const) {
      try {
        if (via === "file") await d.getFileHandle(name);
        else await d.getDirectoryHandle(name);
        return via;
      } catch (e) {
        const k = classifyFsError(e);
        if (k === "not-found") return "missing";
        if (k !== "type-mismatch") throw e;
      }
    }
    return "missing";
  }

  async read(path: string, maxBytes: number): Promise<ReadState> {
    let h: FileHandleLike;
    try {
      h = await this.file(path);
    } catch (e) {
      if (e instanceof GitFsError) return { kind: "error", errorKind: "unknown", message: e.message };
      const k = classifyFsError(e);
      if (k === "not-found") return { kind: "missing" };
      if (k === "type-mismatch") return { kind: "wrong-kind" };
      return { kind: "error", errorKind: k, message: fsErrorMessage(k) };
    }
    try {
      const f = await h.getFile();
      if (f.size > maxBytes) return { kind: "too-large", size: f.size };
      const bytes = new Uint8Array(await f.arrayBuffer());
      // サイズ確認後に伸びた場合も上限を守る
      if (bytes.length > maxBytes) return { kind: "too-large", size: bytes.length };
      return { kind: "bytes", bytes };
    } catch (e) {
      const k = classifyFsError(e);
      if (k === "not-found") return { kind: "missing" };
      return { kind: "error", errorKind: k, message: fsErrorMessage(k) };
    }
  }

  /** 読めなければ例外。存在しなければ null */
  async readOrNull(path: string, maxBytes: number, what: string): Promise<Uint8Array | null> {
    const r = await this.read(path, maxBytes);
    if (r.kind === "bytes") return r.bytes;
    if (r.kind === "missing") return null;
    if (r.kind === "too-large")
      throw new GitFsError(
        `${what}（${path}）が上限を超えています（${r.size.toLocaleString()} バイト）。`,
        "too-large",
      );
    if (r.kind === "wrong-kind") throw new GitFsError(`${what}（${path}）の位置にフォルダがあります。`, "io");
    throw new GitFsError(`${what}（${path}）を読めません：${r.message}`, "io");
  }

  async stat(path: string): Promise<FileStat | null> {
    try {
      const f = await (await this.file(path)).getFile();
      return { size: f.size, mtimeMs: f.lastModified };
    } catch (e) {
      if (e instanceof GitFsError) throw e;
      const k = classifyFsError(e);
      if (k === "not-found" || k === "type-mismatch") return null;
      throw e;
    }
  }

  /** ファイルの一部を読む（pack 全量をメモリに持たない：34.4） */
  async slice(path: string, start: number, end: number): Promise<Uint8Array> {
    const f = await (await this.file(path)).getFile();
    return new Uint8Array(await f.slice(start, end).arrayBuffer());
  }

  async size(path: string): Promise<number> {
    return (await (await this.file(path)).getFile()).size;
  }

  /** 直下の名前と種類 */
  async list(path: string, max: number): Promise<{ name: string; kind: "file" | "dir" }[] | null> {
    let d: DirHandleLike;
    try {
      d = await this.dir(path);
    } catch (e) {
      const k = classifyFsError(e);
      if (k === "not-found" || k === "type-mismatch") return null;
      throw e;
    }
    const out: { name: string; kind: "file" | "dir" }[] = [];
    for await (const c of d.values()) {
      out.push({ name: c.name, kind: c.kind === "directory" ? "dir" : "file" });
      if (out.length > max) throw new GitFsError(`${path || "./"} のエントリー数が上限を超えています。`, "too-large");
    }
    return out;
  }

  /**
   * 既存ファイルを置き換える（index・ref・config）。書き込み後に読み直して一致を確認する。
   * 非保証：rename がないため、クローズ時の反映が原子的かはブラウザ実装に依存する（31.1）。
   */
  async replace(path: string, bytes: Uint8Array, opts: { create?: boolean } = {}): Promise<void> {
    const parts = this.#split(path);
    this.#assertWritable(parts);
    const name = parts.pop() as string;
    let h: FileHandleLike;
    try {
      let d = this.root;
      for (const p of parts) d = await d.getDirectoryHandle(p, opts.create ? { create: true } : {});
      h = await d.getFileHandle(name, opts.create ? { create: true } : {});
    } catch (e) {
      throw writeError(e, `${path} を開けません`, "missing-or-io");
    }
    await this.#write(h, path, bytes);
  }

  /** 新しいファイルとして作る。既に存在すれば exists を投げる（上書きしない） */
  async createNew(path: string, bytes: Uint8Array): Promise<void> {
    const parts = this.#split(path);
    this.#assertWritable(parts);
    const name = parts.pop() as string;
    let d: DirHandleLike;
    try {
      d = this.root;
      for (const p of parts) d = await d.getDirectoryHandle(p, { create: true });
    } catch (e) {
      throw writeError(e, `${parts.join("/")} を作れません`, "io");
    }
    try {
      await d.getFileHandle(name);
      throw new GitFsError(`${path} は既に存在します。`, "exists");
    } catch (e) {
      if (e instanceof GitFsError) throw e;
      const k = classifyFsError(e);
      if (k === "type-mismatch") throw new GitFsError(`${path} の位置にフォルダがあります。`, "exists");
      if (k !== "not-found") throw new GitFsError(`${path} を確認できません：${fsErrorMessage(k)}`, "io");
    }
    let h: FileHandleLike;
    try {
      h = await d.getFileHandle(name, { create: true });
      if ((await h.getFile()).size !== 0) throw new GitFsError(`${path} が作成直後に空ではありません。`, "exists");
    } catch (e) {
      if (e instanceof GitFsError) throw e;
      throw writeError(e, `${path} を作れません`, "io");
    }
    await this.#write(h, path, bytes);
  }

  async mkdirs(path: string): Promise<void> {
    try {
      await this.dir(path, true);
    } catch (e) {
      if (e instanceof GitFsError) throw e;
      throw writeError(e, `${path} を作れません`, "io");
    }
  }

  /** 空のファイル・フォルダを1件ずつ削除する（再帰一括削除をしない） */
  async remove(path: string): Promise<void> {
    const parts = this.#split(path);
    this.#assertWritable(parts);
    const name = parts.pop() as string;
    const d = await this.dir(parts.join("/"));
    if (!d.removeEntry) throw new GitFsError("この環境では削除できません。", "io");
    await d.removeEntry(name);
  }

  /** 空の .git フォルダを消す（init の後始末専用）。中身があれば失敗する（再帰削除をしない） */
  async removeEmptyGitDir(): Promise<void> {
    if (!this.root.removeEntry) throw new GitFsError("この環境では削除できません。", "io");
    await this.root.removeEntry(GIT_DIR);
  }

  async #write(h: FileHandleLike, path: string, bytes: Uint8Array): Promise<void> {
    try {
      const w = await h.createWritable({ keepExistingData: false });
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
      throw writeError(e, `${path} の書き込みに失敗しました`, "io");
    }
    let back: Uint8Array;
    try {
      const f = await h.getFile();
      back = new Uint8Array(await f.arrayBuffer());
    } catch (e) {
      throw new GitFsError(`${path} を読み直せません：${fsErrorMessage(classifyFsError(e))}`, "verify");
    }
    if (!bytesEqual(back, bytes)) throw new GitFsError(`${path} を読み直した内容が一致しません。`, "verify");
  }
}
