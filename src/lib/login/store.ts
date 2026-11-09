/**
 * 起動時のログインの記録（ADR-0011）。
 *
 * アプリの鍵（ログイン鍵）を、パスキーの PRF・パスフレーズ・回復コードで包んだ枠（KeyringRecord と同じ形）と、
 * ログイン鍵で包んだ作業場所の鍵（ログインだけで作業場所を開くため）を、ブラウザ内（IndexedDB）に 1 件だけ置く。
 * ログイン鍵そのものは保存しない（ログイン中だけメモリに置く）。
 */
import { isWorkspaceId, validKeyring, type KeyringRecord } from "../workspaces/store";

export interface LoginRecord {
  readonly v: 1;
  readonly keyring: KeyringRecord;
  /** 作業場所 ID → ログイン鍵で包んだ作業場所のデータ鍵（base64url） */
  readonly places: Readonly<Record<string, string>>;
  readonly createdAt: string;
}

export interface LoginStore {
  load(): Promise<LoginRecord | null>;
  save(rec: LoginRecord): Promise<void>;
  clear(): Promise<void>;
}

const B64URL = /^[A-Za-z0-9_-]{1,8192}$/;

/** 読み戻した記録を未信頼入力として検査する */
export function validLogin(v: unknown): v is LoginRecord {
  if (v === null || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  if (r["v"] !== 1 || !validKeyring(r["keyring"]) || typeof r["createdAt"] !== "string") return false;
  const p = r["places"];
  if (p === null || typeof p !== "object" || Array.isArray(p)) return false;
  const entries = Object.entries(p as Record<string, unknown>);
  return (
    entries.length <= 256 && entries.every(([k, w]) => isWorkspaceId(k) && typeof w === "string" && B64URL.test(w))
  );
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
