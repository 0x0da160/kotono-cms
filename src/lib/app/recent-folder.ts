/**
 * 前回開いたリポジトリのフォルダを記憶する（ADR-0005：仕様 2 の「次回起動での永続化を必須としない」を超える追加機能）。
 *
 * - File System Access API のディレクトリハンドルを IndexedDB に1件だけ保存する。ファイルの中身は保存しない。
 * - 保存したハンドルは次回の書き込み認可を意味しない。開くときに権限を確認し、必要ならユーザー操作で求める。
 * - file:// のブラウザ内ストレージは同じプロファイルの他のローカル HTML と共有されうる（ADR-0001）。
 *   保存するのはフォルダ名とハンドルだけで、記事の内容は含まない。
 */

export interface RecentFolder {
  /** ディレクトリハンドル（構造化複製したもの。メソッドを失っている可能性があるため、使う前に検査する） */
  readonly handle: unknown;
  readonly name: string;
  readonly at: number;
}

export interface RecentFolderStore {
  load(): Promise<RecentFolder | null>;
  save(handle: unknown, name: string): Promise<void>;
  clear(): Promise<void>;
}

const DB_NAME = "kotono-cms-settings";
const DB_VERSION = 1;
const STORE = "kv";
const KEY = "recent-folder";

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB request failed"));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
  });
}

/** 読み戻した記録を未信頼入力として検査する */
export function validRecent(v: unknown): v is RecentFolder {
  if (v === null || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r["name"] === "string" &&
    r["name"].length > 0 &&
    r["name"].length <= 255 &&
    typeof r["at"] === "number" &&
    Number.isFinite(r["at"]) &&
    typeof r["handle"] === "object" &&
    r["handle"] !== null
  );
}

export class IdbRecentFolderStore implements RecentFolderStore {
  private dbp: Promise<IDBDatabase> | null = null;

  constructor(private readonly idb: IDBFactory = indexedDB) {}

  private db(): Promise<IDBDatabase> {
    this.dbp ??= new Promise((resolve, reject) => {
      const r = this.idb.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error ?? new Error("IndexedDB を開けません"));
      r.onblocked = () => reject(new Error("IndexedDB が他のタブで使用中です"));
    });
    return this.dbp;
  }

  async load(): Promise<RecentFolder | null> {
    const db = await this.db();
    const v = (await req(db.transaction(STORE).objectStore(STORE).get(KEY))) as unknown;
    return validRecent(v) ? v : null;
  }

  async save(handle: unknown, name: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ handle, name, at: Date.now() } satisfies RecentFolder, KEY);
    await done(tx);
  }

  async clear(): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(KEY);
    await done(tx);
  }
}

/** 構造化複製で復元したハンドルが、CMS が使うディレクトリハンドルの形を保っているか */
export function looksLikeDirHandle(h: unknown): boolean {
  if (h === null || typeof h !== "object") return false;
  const d = h as Record<string, unknown>;
  return (
    d["kind"] === "directory" &&
    typeof d["name"] === "string" &&
    typeof d["getDirectoryHandle"] === "function" &&
    typeof d["getFileHandle"] === "function" &&
    typeof d["values"] === "function"
  );
}
