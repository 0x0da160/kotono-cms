/**
 * ブラウザ内の作業場所（仕様 3.2 第38.1節、ADR-0006）。
 *
 * OPFS（navigator.storage.getDirectory()）の下に次の構成を置く。
 *
 * ```text
 * <OPFS のルート>/kotono/
 * ├── workspaces/<ID>/   ← 第3章のリポジトリと同じ構成（記事・画像・.git）
 * ├── meta/<ID>.json     ← 作業場所の情報。最後に書く（完成マーカー：38.2）
 * └── backups/<ID>/      ← 削除前退避（19.1）の退避先。作業場所の走査に混入しない
 * ```
 *
 * - 作業場所のフォルダ名は乱数の ID。表示名は meta に置く（暗号化時は暗号文：第39章）。
 * - meta がない・壊れている作業場所は「不完全」として表示し、自動削除しない（38.2）。
 * - 削除は明示操作で、エントリーを深い順に 1 件ずつ消す（再帰一括削除に依存しない：19）。
 */
import { ID_ALPHABET } from "../core/article-id";
import { decodeUtf8Strict, encodeUtf8 } from "../core/bytes";
import { classifyFsError, fsErrorMessage, type DirHandleLike, type FileHandleLike } from "../fs/types";

export const STORE_DIR = "kotono";
const WORKSPACES = "workspaces";
const META = "meta";
const BACKUPS = "backups";
export const WORKSPACE_ID_LENGTH = 16;
/** meta の読み込み上限（34.5：未信頼入力の入口別予算。PROVISIONAL） */
export const META_MAX_BYTES = 64 * 1024;
export const NAME_MAX_LENGTH = 100;

/** 鍵の情報（第39章）。暗号化しない作業場所では null */
export interface KeyringRecord {
  readonly v: 1;
  /** 包んだデータ鍵（解錠方法ごと） */
  readonly slots: readonly KeySlot[];
  /** 表示名の暗号文（base64url） */
  readonly name: string;
}

export type KeySlot =
  | { readonly kind: "recovery"; readonly salt: string; readonly iterations: number; readonly wrapped: string }
  | { readonly kind: "passphrase"; readonly salt: string; readonly iterations: number; readonly wrapped: string }
  | { readonly kind: "passkey"; readonly credentialId: string; readonly prfSalt: string; readonly wrapped: string };

export interface WorkspaceMeta {
  readonly v: 1;
  readonly id: string;
  /** 平文の表示名。暗号化する作業場所では空文字で、keyring.name に暗号文を置く */
  readonly name: string;
  readonly createdAt: string;
  /** 最後に書き出しを開始した日時（38.3：検証済みバックアップとは称さない） */
  readonly lastExportAt: string | null;
  /** 最後に GitHub と同期した日時（第40章） */
  readonly lastSyncAt: string | null;
  /** 最後に保存・コミットした日時。書き出し・同期より新しければ「端末の外にない変更あり」（38.4） */
  readonly lastChangeAt: string | null;
  readonly keyring: KeyringRecord | null;
  /** 同期の設定（第40章）。トークンは含めない */
  readonly remote: RemoteRecord | null;
}

export interface RemoteRecord {
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
  /** トークンの暗号文（暗号化する作業場所のみ。base64url）。暗号化しない作業場所には保存しない */
  readonly token: string | null;
}

export type WorkspaceEntry =
  | { readonly state: "ok"; readonly meta: WorkspaceMeta }
  | { readonly state: "incomplete"; readonly id: string; readonly reason: string };

export class WorkspaceStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceStoreError";
  }
}

export function newWorkspaceId(random: (n: number) => Uint8Array = randomBytes): string {
  const bytes = random(WORKSPACE_ID_LENGTH);
  let s = "";
  for (const b of bytes) s += ID_ALPHABET[b % ID_ALPHABET.length];
  return s;
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function isWorkspaceId(id: string): boolean {
  if (id.length !== WORKSPACE_ID_LENGTH) return false;
  for (const c of id) if (!ID_ALPHABET.includes(c)) return false;
  return true;
}

export function checkWorkspaceName(name: string): string | null {
  const n = name.trim();
  if (n.length === 0) return "名前を入力してください。";
  if (n.length > NAME_MAX_LENGTH) return `名前は ${NAME_MAX_LENGTH} 文字以内にしてください。`;
  // eslint-disable-next-line no-control-regex -- 制御文字を含む名前を拒否する
  if (/[\u0000-\u001f\u007f]/.test(n)) return "制御文字を含む名前は使えません。";
  return null;
}

/** 読み戻した meta を未信頼入力として検査する */
export function parseMeta(bytes: Uint8Array, expectedId: string): WorkspaceMeta | string {
  if (bytes.length > META_MAX_BYTES) return "作業場所の情報が大きすぎます。";
  const d = decodeUtf8Strict(bytes);
  if (!d.ok) return "作業場所の情報が UTF-8 として読めません。";
  let v: unknown;
  try {
    v = JSON.parse(d.text);
  } catch {
    return "作業場所の情報が JSON として読めません。";
  }
  if (typeof v !== "object" || v === null) return "作業場所の情報の形式が違います。";
  const r = v as Record<string, unknown>;
  if (r["v"] !== 1) return "未知の版の作業場所です。";
  if (r["id"] !== expectedId) return "作業場所の ID が一致しません。";
  if (typeof r["name"] !== "string" || r["name"].length > NAME_MAX_LENGTH) return "作業場所の名前が不正です。";
  if (typeof r["createdAt"] !== "string") return "作業場所の作成日時が不正です。";
  for (const k of ["lastExportAt", "lastSyncAt", "lastChangeAt"]) {
    if (r[k] !== null && typeof r[k] !== "string") return `作業場所の ${k} が不正です。`;
  }
  const keyring = r["keyring"] ?? null;
  if (keyring !== null && !validKeyring(keyring)) return "作業場所の鍵の情報が不正です。";
  const remote = r["remote"] ?? null;
  if (remote !== null && !validRemote(remote)) return "作業場所の同期の設定が不正です。";
  return {
    v: 1,
    id: expectedId,
    name: r["name"],
    createdAt: r["createdAt"],
    lastExportAt: (r["lastExportAt"] as string | null) ?? null,
    lastSyncAt: (r["lastSyncAt"] as string | null) ?? null,
    lastChangeAt: (r["lastChangeAt"] as string | null) ?? null,
    keyring: keyring as KeyringRecord | null,
    remote: remote as RemoteRecord | null,
  };
}

const B64URL = /^[A-Za-z0-9_-]{0,8192}$/;

export function validKeyring(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const k = v as Record<string, unknown>;
  if (k["v"] !== 1 || typeof k["name"] !== "string" || !B64URL.test(k["name"])) return false;
  const slots = k["slots"];
  if (!Array.isArray(slots) || slots.length === 0 || slots.length > 16) return false;
  return slots.every((s: unknown) => {
    if (typeof s !== "object" || s === null) return false;
    const o = s as Record<string, unknown>;
    if (typeof o["wrapped"] !== "string" || !B64URL.test(o["wrapped"])) return false;
    if (o["kind"] === "recovery" || o["kind"] === "passphrase")
      return (
        typeof o["salt"] === "string" &&
        B64URL.test(o["salt"]) &&
        typeof o["iterations"] === "number" &&
        Number.isInteger(o["iterations"]) &&
        o["iterations"] >= 100_000 &&
        o["iterations"] <= 10_000_000
      );
    if (o["kind"] === "passkey")
      return (
        typeof o["credentialId"] === "string" &&
        B64URL.test(o["credentialId"]) &&
        typeof o["prfSalt"] === "string" &&
        B64URL.test(o["prfSalt"])
      );
    return false;
  });
}

const GH_NAME = /^[A-Za-z0-9_.-]{1,100}$/;

function validRemote(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r["owner"] === "string" &&
    GH_NAME.test(r["owner"]) &&
    typeof r["repo"] === "string" &&
    GH_NAME.test(r["repo"]) &&
    typeof r["branch"] === "string" &&
    r["branch"].length > 0 &&
    r["branch"].length <= 255 &&
    (r["token"] === null || (typeof r["token"] === "string" && B64URL.test(r["token"])))
  );
}

async function readBytes(h: FileHandleLike, max: number): Promise<Uint8Array | null> {
  const f = await h.getFile();
  if (f.size > max) return null;
  return new Uint8Array(await f.arrayBuffer());
}

async function writeWhole(dir: DirHandleLike, name: string, bytes: Uint8Array): Promise<void> {
  const h = await dir.getFileHandle(name, { create: true });
  const w = await h.createWritable({ keepExistingData: false });
  try {
    await w.write(bytes);
  } catch (e) {
    await w.abort().catch(() => undefined);
    throw e;
  }
  await w.close();
  // close 後に読み直して確かめる（13.2）
  const back = await readBytes(h, bytes.length);
  if (!back || back.length !== bytes.length || back.some((b, i) => b !== bytes[i]))
    throw new WorkspaceStoreError(`${name} を書いた後の読み直しが一致しません。`);
}

async function isEmptyDir(d: DirHandleLike): Promise<boolean> {
  for await (const c of d.values()) {
    void c;
    return false;
  }
  return true;
}

/** フォルダの中身を深い順に 1 件ずつ消す。結果として消せなかったパスを返す（19：部分失敗を区別） */
export async function removeTreeContents(dir: DirHandleLike, prefix = ""): Promise<string[]> {
  const failed: string[] = [];
  const children: (FileHandleLike | DirHandleLike)[] = [];
  for await (const c of dir.values()) children.push(c);
  for (const c of children) {
    const path = `${prefix}${c.name}`;
    if (c.kind === "directory") {
      const sub = await removeTreeContents(c, `${path}/`);
      failed.push(...sub);
      if (sub.length > 0) continue;
    }
    try {
      if (!dir.removeEntry) throw new WorkspaceStoreError("この環境では削除できません。");
      await dir.removeEntry(c.name);
    } catch {
      failed.push(c.kind === "directory" ? `${path}/` : path);
    }
  }
  return failed;
}

export interface CreateOptions {
  readonly name: string;
  readonly keyring?: KeyringRecord | null;
  /** 中身を用意してから meta を書く（取り込み：38.2）。失敗すれば meta を書かない */
  readonly fill?: (dir: DirHandleLike, id: string) => Promise<void>;
}

export class WorkspaceStore {
  private constructor(
    private readonly base: DirHandleLike,
    private readonly now: () => string,
    private readonly random: (n: number) => Uint8Array,
  ) {}

  /** OPFS のルート（またはその代わりのハンドル）から開く */
  static async open(
    opfsRoot: DirHandleLike,
    opts: { now?: () => string; random?: (n: number) => Uint8Array } = {},
  ): Promise<WorkspaceStore> {
    const base = await opfsRoot.getDirectoryHandle(STORE_DIR, { create: true });
    for (const d of [WORKSPACES, META, BACKUPS]) await base.getDirectoryHandle(d, { create: true });
    return new WorkspaceStore(base, opts.now ?? (() => new Date().toISOString()), opts.random ?? randomBytes);
  }

  private async dir(name: string): Promise<DirHandleLike> {
    return this.base.getDirectoryHandle(name, { create: false });
  }

  async list(): Promise<WorkspaceEntry[]> {
    const ws = await this.dir(WORKSPACES);
    const metaDir = await this.dir(META);
    const out: WorkspaceEntry[] = [];
    for await (const c of ws.values()) {
      if (c.kind !== "directory") continue;
      if (!isWorkspaceId(c.name)) {
        out.push({ state: "incomplete", id: c.name, reason: "CMS が作っていないフォルダです。" });
        continue;
      }
      out.push(await this.readEntry(metaDir, c.name));
    }
    out.sort((a, b) => {
      const ka = a.state === "ok" ? a.meta.createdAt : "";
      const kb = b.state === "ok" ? b.meta.createdAt : "";
      return ka < kb ? 1 : ka > kb ? -1 : 0;
    });
    return out;
  }

  private async readEntry(metaDir: DirHandleLike, id: string): Promise<WorkspaceEntry> {
    let h: FileHandleLike;
    try {
      h = await metaDir.getFileHandle(`${id}.json`);
    } catch (e) {
      const k = classifyFsError(e);
      return {
        state: "incomplete",
        id,
        reason: k === "not-found" ? "作成または取り込みが完了していません。" : fsErrorMessage(k),
      };
    }
    try {
      const bytes = await readBytes(h, META_MAX_BYTES);
      if (!bytes) return { state: "incomplete", id, reason: "作業場所の情報が大きすぎます。" };
      const m = parseMeta(bytes, id);
      return typeof m === "string" ? { state: "incomplete", id, reason: m } : { state: "ok", meta: m };
    } catch (e) {
      return { state: "incomplete", id, reason: fsErrorMessage(classifyFsError(e)) };
    }
  }

  async get(id: string): Promise<WorkspaceEntry> {
    if (!isWorkspaceId(id)) return { state: "incomplete", id, reason: "作業場所の ID が不正です。" };
    return this.readEntry(await this.dir(META), id);
  }

  /** 新しい作業場所を作る。fill が成功してから meta を書く（完成マーカー：38.2） */
  async create(opts: CreateOptions): Promise<WorkspaceMeta> {
    const bad = checkWorkspaceName(opts.name);
    if (bad) throw new WorkspaceStoreError(bad);
    const ws = await this.dir(WORKSPACES);
    let id = "";
    for (let i = 0; i < 8; i++) {
      const c = newWorkspaceId(this.random);
      let exists = true;
      try {
        await ws.getDirectoryHandle(c);
      } catch (e) {
        if (classifyFsError(e) !== "not-found") throw e;
        exists = false;
      }
      if (!exists) {
        id = c;
        break;
      }
    }
    if (!id) throw new WorkspaceStoreError("作業場所の ID を割り当てられません。");
    const dir = await ws.getDirectoryHandle(id, { create: true });
    // 作ったばかりのフォルダが空であることを確かめる（既存の再利用をしない：5.3）
    if (!(await isEmptyDir(dir))) throw new WorkspaceStoreError("作業場所のフォルダが空ではありません。");
    await opts.fill?.(dir, id);
    const keyring = opts.keyring ?? null;
    const meta: WorkspaceMeta = {
      v: 1,
      id,
      name: keyring ? "" : opts.name.trim(),
      createdAt: this.now(),
      lastExportAt: null,
      lastSyncAt: null,
      lastChangeAt: null,
      keyring,
      remote: null,
    };
    await this.writeMeta(meta);
    return meta;
  }

  private async writeMeta(meta: WorkspaceMeta): Promise<void> {
    await writeWhole(await this.dir(META), `${meta.id}.json`, encodeUtf8(`${JSON.stringify(meta, null, 2)}\n`));
  }

  async update(id: string, patch: Partial<Omit<WorkspaceMeta, "v" | "id" | "createdAt">>): Promise<WorkspaceMeta> {
    const e = await this.get(id);
    if (e.state !== "ok") throw new WorkspaceStoreError(e.reason);
    const meta: WorkspaceMeta = { ...e.meta, ...patch, v: 1, id, createdAt: e.meta.createdAt };
    await this.writeMeta(meta);
    return meta;
  }

  /** 作業場所のフォルダ（第3章のリポジトリ） */
  async root(id: string): Promise<DirHandleLike> {
    if (!isWorkspaceId(id)) throw new WorkspaceStoreError("作業場所の ID が不正です。");
    return (await this.dir(WORKSPACES)).getDirectoryHandle(id);
  }

  /** 削除前退避の退避先（19.1）。作業場所ごとに分け、作業場所の外に置く */
  async backupRoot(id: string): Promise<DirHandleLike> {
    if (!isWorkspaceId(id)) throw new WorkspaceStoreError("作業場所の ID が不正です。");
    return (await this.dir(BACKUPS)).getDirectoryHandle(id, { create: true });
  }

  /**
   * 作業場所を削除する。meta を先に消して「不完全」にし、中身を 1 件ずつ消す。
   * 退避（backups/<ID>）は消さない（19.1 手順8：自動削除しない）。
   */
  async remove(id: string): Promise<{ ok: true } | { ok: false; remaining: string[]; message: string }> {
    if (!isWorkspaceId(id) && !(await this.hasDir(id)))
      return { ok: false, remaining: [], message: "作業場所が見つかりません。" };
    const metaDir = await this.dir(META);
    try {
      await metaDir.removeEntry?.(`${id}.json`);
    } catch (e) {
      if (classifyFsError(e) !== "not-found")
        return {
          ok: false,
          remaining: [],
          message: `作業場所の情報を消せません：${fsErrorMessage(classifyFsError(e))}`,
        };
    }
    const ws = await this.dir(WORKSPACES);
    let dir: DirHandleLike;
    try {
      dir = await ws.getDirectoryHandle(id);
    } catch (e) {
      if (classifyFsError(e) === "not-found") return { ok: true };
      throw e;
    }
    const remaining = await removeTreeContents(dir);
    if (remaining.length > 0)
      return { ok: false, remaining, message: `${remaining.length} 件を消せませんでした。もう一度削除してください。` };
    try {
      await ws.removeEntry?.(id);
    } catch (e) {
      return { ok: false, remaining: [`${id}/`], message: fsErrorMessage(classifyFsError(e)) };
    }
    return { ok: true };
  }

  private async hasDir(id: string): Promise<boolean> {
    try {
      await (await this.dir(WORKSPACES)).getDirectoryHandle(id);
      return true;
    } catch {
      return false;
    }
  }
}

/** OPFS のルートを得る。使えなければ null */
export async function opfsRoot(host: { navigator?: { storage?: { getDirectory?: () => Promise<unknown> } } }) {
  const get = host.navigator?.storage?.getDirectory;
  if (typeof get !== "function") return null;
  try {
    return (await get.call(host.navigator?.storage)) as DirHandleLike;
  } catch {
    return null;
  }
}

/** 「端末の外にない変更あり」の判定（38.4） */
export function unsyncedSince(meta: WorkspaceMeta): string | null {
  const change = meta.lastChangeAt;
  if (!change) return null;
  const safe = [meta.lastExportAt, meta.lastSyncAt]
    .filter((x): x is string => x !== null)
    .sort()
    .at(-1);
  if (safe && safe >= change) return null;
  return safe ?? meta.createdAt;
}

export const BACKUP_REMIND_DAYS = 3;
