/**
 * 起動時のログインの記録（ADR-0011・ADR-0012）。
 *
 * ログイン鍵を、回復コードの枠（必須）とパスキーの PRF の枠（任意）で包んだもの（KeyringRecord と同じ形）を、
 * ブラウザ内（IndexedDB）に 1 件だけ置く。ログイン鍵そのものは保存しない（ログイン中だけメモリに置く）。
 */
import { validKeyring, type KeyringRecord } from "../workspaces/store";

export interface LoginRecord {
  readonly v: 1;
  readonly keyring: KeyringRecord;
  readonly createdAt: string;
}

export interface LoginStore {
  load(): Promise<LoginRecord | null>;
  save(rec: LoginRecord): Promise<void>;
  clear(): Promise<void>;
}

/** 読み戻した記録を未信頼入力として検査する */
export function validLogin(v: unknown): v is LoginRecord {
  if (v === null || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return r["v"] === 1 && validKeyring(r["keyring"]) && typeof r["createdAt"] === "string";
}

const DB_NAME = "kotono-cms-settings";
const DB_VERSION = 1;
const STORE = "kv";
const KEY = "login";

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

/** 前回のフォルダの記憶（recent-folder.ts）と同じデータベースの別のキーに置く */
export class IdbLoginStore implements LoginStore {
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

  async load(): Promise<LoginRecord | null> {
    const db = await this.db();
    const v = (await req(db.transaction(STORE).objectStore(STORE).get(KEY))) as unknown;
    return validLogin(v) ? v : null;
  }

  async save(rec: LoginRecord): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(rec, KEY);
    await done(tx);
  }

  async clear(): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(KEY);
    await done(tx);
  }
}

export class MemoryLoginStore implements LoginStore {
  rec: LoginRecord | null = null;
  async load() {
    return this.rec && validLogin(JSON.parse(JSON.stringify(this.rec))) ? this.rec : null;
  }
  async save(rec: LoginRecord) {
    this.rec = rec;
  }
  async clear() {
    this.rec = null;
  }
}
