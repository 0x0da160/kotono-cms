/**
 * ブラウザ内復旧ドラフトの保存領域（仕様 33・34.5・ADR-0003）。IndexedDB を使う。
 *
 * 順序の保証（33.3.1）は、要求ごとの世代番号（seq）と記事ごとの制御記録を、
 * 同じトランザクションの中で照合して実現する。
 * - 有効設定・破棄済み世代（floorSeq）・保存済みリビジョン（savedRevision）を put と同じ
 *   トランザクションで読むため、無効化・破棄・保存成功の後に完了した古い要求は永続化されない。
 * - 既に新しい世代が保存されていれば、古い要求の遅延完了で巻き戻さない。
 * 原子性の範囲は IndexedDB の 1 トランザクション。耐電断性・暗号化は保証しない。
 */
import {
  DRAFT_GENERATIONS,
  DRAFT_MAX_ARTICLES_PER_WORKSPACE,
  DRAFT_MAX_TOTAL_BYTES,
  DRAFT_RETENTION_MS,
  PROVISIONAL_DRAFT_META_MAX_CHARS,
  ARTICLE_MAX_BYTES,
} from "../core/budgets";

export const DRAFT_FORMAT_VERSION = 1;
const DB_NAME = "kotono-cms-drafts";
const DB_VERSION = 1;

export interface DraftRecord {
  readonly ws: string;
  /** `a:<記事ID>`（保存済み記事）または `n:<一時ID>`（未保存の新規記事） */
  readonly key: string;
  readonly seq: number;
  readonly articleId: string;
  readonly isNew: boolean;
  readonly revision: number;
  readonly sessionNonce: string;
  /** 元ファイルの内容ハッシュ。新規記事は null */
  readonly baseHash: string | null;
  readonly savedAt: number;
  readonly appVersion: string;
  readonly formatVersion: number;
  readonly size: number;
  /** 本文（text）の SHA-256 */
  readonly checksum: string;
  readonly text: string;
}

interface Control {
  ws: string;
  key: string;
  floorSeq: number;
  sessionNonce: string;
  savedRevision: number;
  bytes: number;
}

export type PutOutcome =
  | { kind: "stored" }
  | { kind: "skipped"; reason: "disabled" | "stale" | "saved" | "older" }
  | { kind: "quota"; message: string };

export interface WorkspaceIdentity {
  readonly id: string;
  /** 以前のワークスペースとハンドルの同一性で一致した */
  readonly matched: boolean;
  /** 次回の照合のためにハンドルを保存できた */
  readonly persisted: boolean;
}

export interface DraftStore {
  getEnabled(): Promise<boolean | null>;
  setEnabled(enabled: boolean): Promise<void>;
  put(rec: DraftRecord): Promise<PutOutcome>;
  /** 保存した世代を読み直し、チェックサムが一致するか */
  verify(ws: string, key: string, seq: number, checksum: string): Promise<boolean>;
  /** 明示破棄：upToSeq 以下の世代を消し、以後その世代以下の要求を受け付けない */
  discard(ws: string, key: string, upToSeq: number): Promise<void>;
  /** リポジトリ保存成功：そのセッションの revision 以下の世代を消す（後続編集の世代は保持） */
  markSaved(ws: string, key: string, sessionNonce: string, revision: number): Promise<void>;
  remove(ws: string, key: string, seq: number): Promise<void>;
  removeAll(): Promise<void>;
  list(): Promise<DraftRecord[]>;
  expire(now: number): Promise<number>;
  identify(root: unknown, isSame: (a: unknown, b: unknown) => Promise<boolean>): Promise<WorkspaceIdentity>;
}

// ---------------------------------------------------------------------------

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

const range = (ws: string, key: string, hi = Infinity) => IDBKeyRange.bound([ws, key, -Infinity], [ws, key, hi]);

/** 付随メタデータの形式・長さの検証（34.5：ドラフトも未信頼入力として再読込時に検証） */
export function validRecord(r: unknown): r is DraftRecord {
  if (r === null || typeof r !== "object") return false;
  const d = r as Record<string, unknown>;
  const str = (v: unknown) => typeof v === "string" && v.length <= PROVISIONAL_DRAFT_META_MAX_CHARS;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  return (
    str(d["ws"]) &&
    str(d["key"]) &&
    num(d["seq"]) &&
    str(d["articleId"]) &&
    typeof d["isNew"] === "boolean" &&
    num(d["revision"]) &&
    str(d["sessionNonce"]) &&
    (d["baseHash"] === null || str(d["baseHash"])) &&
    num(d["savedAt"]) &&
    str(d["appVersion"]) &&
    d["formatVersion"] === DRAFT_FORMAT_VERSION &&
    num(d["size"]) &&
    str(d["checksum"]) &&
    typeof d["text"] === "string" &&
    (d["text"] as string).length <= ARTICLE_MAX_BYTES
  );
}

export class IdbDraftStore implements DraftStore {
  private dbp: Promise<IDBDatabase> | null = null;

  constructor(private readonly idb: IDBFactory = indexedDB) {}

  private db(): Promise<IDBDatabase> {
    this.dbp ??= new Promise((resolve, reject) => {
      const r = this.idb.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore("settings");
        db.createObjectStore("workspaces", { keyPath: "id" });
        db.createObjectStore("drafts", { keyPath: ["ws", "key", "seq"] });
        db.createObjectStore("control", { keyPath: ["ws", "key"] });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error ?? new Error("IndexedDB を開けません"));
      r.onblocked = () => reject(new Error("IndexedDB が他のタブで使用中です"));
    });
    return this.dbp;
  }

  async getEnabled(): Promise<boolean | null> {
    const db = await this.db();
    const v = (await req(db.transaction("settings").objectStore("settings").get("enabled"))) as unknown;
    return typeof v === "boolean" ? v : null;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    const db = await this.db();
    const tx = db.transaction("settings", "readwrite");
    tx.objectStore("settings").put(enabled, "enabled");
    await done(tx);
  }

  async put(rec: DraftRecord): Promise<PutOutcome> {
    const db = await this.db();
    const tx = db.transaction(["settings", "drafts", "control"], "readwrite");
    const fin = done(tx);
    const settings = tx.objectStore("settings");
    const drafts = tx.objectStore("drafts");
    const control = tx.objectStore("control");
    let outcome: PutOutcome = { kind: "stored" };
    try {
      const enabled = (await req(settings.get("enabled"))) as unknown;
      if (enabled !== true) outcome = { kind: "skipped", reason: "disabled" };
      else {
        const ctrl = ((await req(control.get([rec.ws, rec.key]))) as Control | undefined) ?? {
          ws: rec.ws,
          key: rec.key,
          floorSeq: -Infinity,
          sessionNonce: "",
          savedRevision: -1,
          bytes: 0,
        };
        const existing = (await req(drafts.getAll(range(rec.ws, rec.key)))) as DraftRecord[];
        if (rec.seq <= ctrl.floorSeq) outcome = { kind: "skipped", reason: "stale" };
        else if (ctrl.sessionNonce === rec.sessionNonce && rec.revision <= ctrl.savedRevision)
          outcome = { kind: "skipped", reason: "saved" };
        else if (existing.some((d) => d.seq >= rec.seq)) outcome = { kind: "skipped", reason: "older" };
        else {
          const all = (await req(control.getAll())) as Control[];
          const others = all.filter((c) => !(c.ws === rec.ws && c.key === rec.key));
          const wsArticles = others.filter((c) => c.ws === rec.ws && c.bytes > 0).length;
          // 最新とその1つ前だけを残す（最大2世代）
          const keep = existing.sort((a, b) => b.seq - a.seq).slice(0, DRAFT_GENERATIONS - 1);
          const drop = existing.filter((d) => !keep.includes(d));
          const newBytes = keep.reduce((n, d) => n + d.size, 0) + rec.size;
          const total = others.reduce((n, c) => n + c.bytes, 0) + newBytes;
          if (ctrl.bytes === 0 && wsArticles >= DRAFT_MAX_ARTICLES_PER_WORKSPACE)
            outcome = {
              kind: "quota",
              message: `このフォルダの復旧ドラフトが上限（${DRAFT_MAX_ARTICLES_PER_WORKSPACE}記事）に達しています。不要なドラフトを削除してください。`,
            };
          else if (total > DRAFT_MAX_TOTAL_BYTES)
            outcome = {
              kind: "quota",
              message: "復旧ドラフトの合計容量が上限（50 MiB）に達しています。不要なドラフトを削除してください。",
            };
          else {
            for (const d of drop) drafts.delete([d.ws, d.key, d.seq]);
            drafts.put(rec);
            control.put({ ...ctrl, bytes: newBytes } satisfies Control);
          }
        }
      }
    } catch (e) {
      try {
        tx.abort();
      } catch {
        // 既に終了している
      }
      await fin.catch(() => undefined);
      throw e;
    }
    await fin;
    return outcome;
  }

  async verify(ws: string, key: string, seq: number, checksum: string): Promise<boolean> {
    const db = await this.db();
    const r = (await req(db.transaction("drafts").objectStore("drafts").get([ws, key, seq]))) as unknown;
    return validRecord(r) && r.checksum === checksum;
  }

  private async rewrite(
    ws: string,
    key: string,
    pick: (d: DraftRecord) => boolean,
    update: (c: Control) => Control,
  ): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(["drafts", "control"], "readwrite");
    const fin = done(tx);
    const drafts = tx.objectStore("drafts");
    const control = tx.objectStore("control");
    const ctrl = ((await req(control.get([ws, key]))) as Control | undefined) ?? {
      ws,
      key,
      floorSeq: -Infinity,
      sessionNonce: "",
      savedRevision: -1,
      bytes: 0,
    };
    const existing = (await req(drafts.getAll(range(ws, key)))) as DraftRecord[];
    let bytes = 0;
    for (const d of existing) {
      if (pick(d)) drafts.delete([d.ws, d.key, d.seq]);
      else bytes += d.size;
    }
    control.put({ ...update(ctrl), bytes });
    await fin;
  }

  discard(ws: string, key: string, upToSeq: number): Promise<void> {
    return this.rewrite(
      ws,
      key,
      (d) => d.seq <= upToSeq,
      (c) => ({ ...c, floorSeq: Math.max(c.floorSeq, upToSeq) }),
    );
  }

  markSaved(ws: string, key: string, sessionNonce: string, revision: number): Promise<void> {
    return this.rewrite(
      ws,
      key,
      (d) => d.sessionNonce === sessionNonce && d.revision <= revision,
      (c) =>
        c.sessionNonce === sessionNonce
          ? { ...c, savedRevision: Math.max(c.savedRevision, revision) }
          : { ...c, sessionNonce, savedRevision: revision },
    );
  }

  remove(ws: string, key: string, seq: number): Promise<void> {
    return this.rewrite(
      ws,
      key,
      (d) => d.seq === seq,
      (c) => ({ ...c, floorSeq: Math.max(c.floorSeq, seq) }),
    );
  }

  async removeAll(): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(["drafts", "control"], "readwrite");
    const fin = done(tx);
    const drafts = tx.objectStore("drafts");
    const control = tx.objectStore("control");
    const all = (await req(control.getAll())) as Control[];
    const maxSeq = (await req(drafts.getAll())) as DraftRecord[];
    for (const c of all) {
      const top = maxSeq
        .filter((d) => d.ws === c.ws && d.key === c.key)
        .reduce((m, d) => Math.max(m, d.seq), c.floorSeq);
      control.put({ ...c, floorSeq: top, bytes: 0 });
    }
    drafts.clear();
    await fin;
  }

  async list(): Promise<DraftRecord[]> {
    const db = await this.db();
    const all = (await req(db.transaction("drafts").objectStore("drafts").getAll())) as unknown[];
    // 形式の不正な記録は一覧へ出さない（破損として呼び出し側で数える）
    return all.filter(validRecord);
  }

  /** 最終退避から保持期間を過ぎた世代を整理する（33.3：期限後の次回起動時） */
  async expire(now: number): Promise<number> {
    const db = await this.db();
    const all = (await req(db.transaction("drafts").objectStore("drafts").getAll())) as DraftRecord[];
    const byKey = new Map<string, DraftRecord[]>();
    for (const d of all) {
      const k = JSON.stringify([d.ws, d.key]);
      byKey.set(k, [...(byKey.get(k) ?? []), d]);
    }
    let n = 0;
    for (const list of byKey.values()) {
      const last = Math.max(...list.map((d) => d.savedAt));
      if (now - last <= DRAFT_RETENTION_MS) continue;
      const first = list[0] as DraftRecord;
      const top = Math.max(...list.map((d) => d.seq));
      await this.discard(first.ws, first.key, top);
      n += list.length;
    }
    return n;
  }

  async identify(root: unknown, isSame: (a: unknown, b: unknown) => Promise<boolean>): Promise<WorkspaceIdentity> {
    const db = await this.db();
    const list = (await req(db.transaction("workspaces").objectStore("workspaces").getAll())) as {
      id: string;
      handle: unknown;
    }[];
    for (const w of list) {
      try {
        if (w.handle && (await isSame(w.handle, root))) return { id: w.id, matched: true, persisted: true };
      } catch {
        // 判定できないものは一致とみなさない
      }
    }
    const id = randomId();
    let persisted = true;
    try {
      const tx = db.transaction("workspaces", "readwrite");
      tx.objectStore("workspaces").put({ id, handle: root, createdAt: Date.now() });
      await done(tx);
    } catch {
      // ハンドルを保存できない環境では、次回は「関連先未確認」になる
      persisted = false;
      const tx = db.transaction("workspaces", "readwrite");
      tx.objectStore("workspaces").put({ id, handle: null, createdAt: Date.now() });
      await done(tx).catch(() => undefined);
    }
    return { id, matched: false, persisted };
  }
}

export function randomId(): string {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
