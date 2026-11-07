/**
 * ブラウザ内の作業場所の画面の状態と操作（仕様 3.2 第38章、ADR-0006）。
 *
 * 作業場所を開いたあとの記事の操作は Workspace（実フォルダと同じ処理）に任せる。
 * ここで扱うのは、作業場所の一覧・作成・取り込み・書き出し・削除と、保存領域の永続化の状態。
 */
import type { DirHandleLike } from "../fs/types";
import type { Workspace } from "./workspace.svelte";
import {
  BACKUP_REMIND_DAYS,
  WorkspaceStore,
  unsyncedSince,
  type WorkspaceEntry,
  type WorkspaceMeta,
} from "../workspaces/store";
import { exportZip, extractZip, planZip, type ZipPlan } from "../workspaces/zip";
import { Vault, type Unlocked, type UnlockMethod } from "../crypto/vault";
import type { KeySlot } from "../workspaces/store";
import { SEALED_WS_PREFIX, type SealedDraftStore } from "../drafts/sealed";

export const DEFAULT_LOCK_MINUTES = 15;
export const HIDDEN_GRACE_MINUTES = 5;
export const LOCK_MINUTE_CHOICES = [5, 15, 30, 60, 0] as const;

export type PersistState = "unknown" | "persisted" | "not-persisted" | "unsupported";

export interface StorageHost {
  navigator?: {
    storage?: {
      persist?: () => Promise<boolean>;
      persisted?: () => Promise<boolean>;
      estimate?: () => Promise<{ usage?: number; quota?: number }>;
    };
    share?: (data: { files: File[]; title?: string }) => Promise<void>;
    canShare?: (data: { files: File[] }) => boolean;
    standalone?: boolean;
  };
  matchMedia?: (q: string) => { matches: boolean };
  location?: { hostname?: string };
}

export interface PlaceView {
  readonly id: string;
  readonly entry: WorkspaceEntry;
  /** 表示名（暗号化した作業場所はロック中「ロック中の作業場所」） */
  readonly label: string;
  readonly locked: boolean;
}

/** 書き出したファイルを端末の外へ渡す（共有シート、なければダウンロード：38.3） */
export type Deliver = (bytes: Uint8Array, fileName: string) => Promise<"shared" | "downloaded" | "cancelled">;

export class PlacesController {
  store = $state<WorkspaceStore | null>(null);
  entries = $state<WorkspaceEntry[]>([]);
  /** 解錠済みの作業場所の表示名（ID → 名前） */
  names = $state<Record<string, string>>({});
  current = $state<WorkspaceMeta | null>(null);
  error = $state<string | null>(null);
  info = $state<string | null>(null);
  busy = $state(false);
  persist = $state<PersistState>("unknown");
  usage = $state<{ usage: number; quota: number } | null>(null);
  /** 取り込みの確認待ち */
  pendingImport = $state<{
    name: string;
    bytes: Uint8Array;
    plan: Extract<ZipPlan, { ok: true }>;
    /** 暗号化した書き出しから取り込むときの DK と枠（同じ鍵のまま作業場所にする） */
    sealed: { key: Unlocked; slots: readonly KeySlot[] } | null;
  } | null>(null);
  /** 暗号化した書き出しの解錠待ち（38.2・39.4） */
  pendingSealed = $state<{ name: string; bytes: Uint8Array; passphrase: boolean; passkey: boolean } | null>(null);
  /** 作成直後に一度だけ表示する回復コード（39.2） */
  recoveryToShow = $state<{ id: string; code: string } | null>(null);

  readonly vault: Vault | null;
  private readonly sealed: SealedDraftStore | null;
  private readonly now: () => Date;

  constructor(
    private readonly ws: Workspace,
    private readonly host: StorageHost,
    private readonly deliver: Deliver,
    opts: { vault?: Vault | null; sealed?: SealedDraftStore | null; now?: () => Date } = {},
  ) {
    this.vault = opts.vault ?? null;
    this.sealed = opts.sealed ?? null;
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- 時刻を得るだけで、状態として持たない
    this.now = opts.now ?? (() => new Date());
  }

  /** 自動ロックまでの無操作時間（分、0 は自動ロックしない：39.3） */
  lockMinutes = $state(DEFAULT_LOCK_MINUTES);
  private lastActive = 0;
  private hiddenAt: number | null = null;

  /** 開発版の配信元（他のページと保存領域を共有する：38.5）なら true */
  get sharedOrigin(): boolean {
    return /\.github\.io$/i.test(this.host.location?.hostname ?? "");
  }

  /** ホーム画面から開いているか（38.4：ブラウザでの利用時は推奨を表示する） */
  get standalone(): boolean {
    return (
      this.host.navigator?.standalone === true || this.host.matchMedia?.("(display-mode: standalone)").matches === true
    );
  }

  async init(root: DirHandleLike): Promise<void> {
    try {
      this.store = await WorkspaceStore.open(root);
    } catch (e) {
      this.error = `ブラウザ内の保存領域を開けません：${(e as Error).message}`;
      return;
    }
    await this.refresh();
    await this.checkPersist(false);
  }

  async refresh(): Promise<void> {
    if (!this.store) return;
    try {
      this.entries = await this.store.list();
    } catch (e) {
      this.error = `作業場所の一覧を読めません：${(e as Error).message}`;
    }
  }

  views(): PlaceView[] {
    return this.entries.map((entry) => {
      if (entry.state !== "ok") return { id: entry.id, entry, label: `不完全な作業場所（${entry.id}）`, locked: false };
      const m = entry.meta;
      if (!m.keyring) return { id: m.id, entry, label: m.name, locked: false };
      const n = this.names[m.id];
      return { id: m.id, entry, label: n ?? "ロック中の作業場所", locked: n === undefined };
    });
  }

  /** 永続化を求める（38.4）。ask=false なら現状だけ調べる */
  async checkPersist(ask: boolean): Promise<void> {
    const st = this.host.navigator?.storage;
    if (!st?.persisted) {
      this.persist = "unsupported";
    } else {
      try {
        let p = await st.persisted();
        if (!p && ask && st.persist) p = await st.persist();
        this.persist = p ? "persisted" : "not-persisted";
      } catch {
        this.persist = "unsupported";
      }
    }
    try {
      const e = await st?.estimate?.();
      if (e && typeof e.usage === "number" && typeof e.quota === "number")
        this.usage = { usage: e.usage, quota: e.quota };
    } catch {
      this.usage = null;
    }
  }

  /** 書き出し・同期を促すか（38.4）。最後の安全な時点から BACKUP_REMIND_DAYS 日を超えたら true */
  remindDays(meta: WorkspaceMeta): number | null {
    const since = unsyncedSince(meta);
    if (!since) return null;
    const days = Math.floor((this.now().getTime() - Date.parse(since)) / 86_400_000);
    return days;
  }

  shouldRemind(meta: WorkspaceMeta): boolean {
    const d = this.remindDays(meta);
    return d !== null && d >= BACKUP_REMIND_DAYS;
  }

  async create(name: string, encrypted: boolean): Promise<WorkspaceMeta | null> {
    if (!this.store || this.busy) return null;
    this.busy = true;
    this.error = null;
    try {
      const vault = this.vault;
      const keyring = encrypted && vault ? await vault.prepareNew(name) : null;
      const meta = await this.store.create({
        name,
        keyring: keyring?.record ?? null,
        // 記事の置き場所を用意しておく（初回フォルダ準備を省く：3.1）
        fill: async (dir, id) => {
          const t = keyring && vault ? await vault.wrapDir(dir, id, keyring.key) : dir;
          const c = await t.getDirectoryHandle("content", { create: true });
          await c.getDirectoryHandle("articles", { create: true });
        },
      });
      if (keyring) {
        this.vault?.adopt(meta.id, keyring.key);
        this.names = { ...this.names, [meta.id]: name.trim() };
        this.recoveryToShow = { id: meta.id, code: keyring.recoveryCode };
      }
      await this.refresh();
      return meta;
    } catch (e) {
      this.error = `作業場所を作れません：${(e as Error).message}`;
      return null;
    } finally {
      this.busy = false;
    }
  }

  /** zip を検査して確認待ちにする（38.2：未信頼入力） */
  async prepareImport(file: { name: string; arrayBuffer(): Promise<ArrayBuffer> }): Promise<void> {
    this.error = null;
    this.info = null;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      this.error = "ファイルを読めません。";
      return;
    }
    const base = file.name.replace(/\.(zip|kotono)$/i, "").slice(0, 80) || "取り込んだ作業場所";
    if (Vault.isSealedExport(bytes)) {
      if (!this.vault) {
        this.error = "この環境では暗号化した書き出しを開けません。";
        return;
      }
      const h = Vault.readExportHeader(bytes);
      if (!h) {
        this.error = "暗号化した書き出しの形式が違います（壊れている可能性があります）。";
        return;
      }
      const has = (k: string) => h.header.slots.some((x) => x.kind === k);
      this.pendingSealed = { name: base, bytes, passphrase: has("passphrase"), passkey: has("passkey") };
      return;
    }
    this.planImport(base, bytes, null);
  }

  private planImport(
    name: string,
    bytes: Uint8Array,
    sealed: { key: Unlocked; slots: readonly KeySlot[] } | null,
  ): void {
    const plan = planZip(bytes);
    if (!plan.ok) {
      this.error = `取り込めません：${plan.message}`;
      return;
    }
    this.pendingImport = { name, bytes, plan, sealed };
  }

  /** 暗号化した書き出しを、回復コード・パスフレーズ・パスキーで開く */
  async unsealImport(method: UnlockMethod): Promise<boolean> {
    const p = this.pendingSealed;
    if (!p || !this.vault || this.busy) return false;
    this.busy = true;
    this.error = null;
    try {
      const r = await this.vault.openSealedExport(p.bytes, method);
      if (!r) {
        this.error = "開けませんでした。回復コード・パスフレーズを確かめてください。";
        return false;
      }
      this.pendingSealed = null;
      this.planImport(p.name, r.zip, { key: r.key, slots: r.slots });
      return true;
    } catch (e) {
      this.error = (e as Error).message;
      return false;
    } finally {
      this.busy = false;
    }
  }

  cancelImport(): void {
    this.pendingImport = null;
    this.pendingSealed = null;
  }

  /** 新しい作業場所へ展開する。完成するまで meta を書かない（38.2） */
  async confirmImport(name: string, encrypted: boolean): Promise<WorkspaceMeta | null> {
    const p = this.pendingImport;
    if (!this.store || !p || this.busy) return null;
    this.busy = true;
    this.error = null;
    try {
      const vault = this.vault;
      let key: Unlocked | null = null;
      let record = null;
      let recoveryCode: string | null = null;
      if (vault && p.sealed) {
        key = p.sealed.key;
        record = await vault.keyringFor(name, key, p.sealed.slots);
      } else if (vault && encrypted) {
        const k = await vault.prepareNew(name);
        key = k.key;
        record = k.record;
        recoveryCode = k.recoveryCode;
      }
      const meta = await this.store.create({
        name,
        keyring: record,
        fill: async (dir, id) => {
          const target = key && vault ? await vault.wrapDir(dir, id, key) : dir;
          const r = await extractZip(p.bytes, target, p.plan);
          if (!r.ok) throw new Error(`${r.message}（${r.written} 件を書いたところで止めました）`);
        },
      });
      if (key && vault) {
        vault.adopt(meta.id, key);
        this.names = { ...this.names, [meta.id]: name.trim() };
        if (recoveryCode) this.recoveryToShow = { id: meta.id, code: recoveryCode };
      }
      this.pendingImport = null;
      this.info = `取り込みました（${p.plan.files.length} 件${p.plan.skipped.length > 0 ? `、付属物 ${p.plan.skipped.length} 件を除外` : ""}）。`;
      await this.refresh();
      return meta;
    } catch (e) {
      this.error = `取り込みに失敗しました：${(e as Error).message}。不完全な作業場所として残しています。`;
      await this.refresh();
      return null;
    } finally {
      this.busy = false;
    }
  }

  /** 暗号化した作業場所を解錠する（39.3） */
  async unlock(meta: WorkspaceMeta, method: UnlockMethod): Promise<boolean> {
    if (!this.vault || !meta.keyring || this.busy) return false;
    this.busy = true;
    this.error = null;
    try {
      const name = await this.vault.unlock(meta.id, meta.keyring, method);
      if (name === null) {
        this.error = "解錠できませんでした。回復コード・パスフレーズを確かめてください。";
        return false;
      }
      this.names = { ...this.names, [meta.id]: name };
      return true;
    } catch (e) {
      this.error = `解錠できませんでした：${(e as Error).message}`;
      return false;
    } finally {
      this.busy = false;
    }
  }

  /**
   * ロックする（鍵を捨てる）。開いていれば閉じる（39.3）。
   * 未保存の編集は、ロックの前に暗号化した復旧ドラフトとして退避する（ドラフトが有効な場合）。
   * 戻り値は、未保存の編集を退避できなかった（ドラフトが無効・失敗）なら false。
   */
  async lock(id: string): Promise<boolean> {
    let kept = true;
    if (this.current?.id === id) {
      const s = this.ws.session;
      if (s?.dirty && s.readOnlyReason === null) {
        await this.ws.drafts?.flush(s).catch(() => undefined);
        kept = s.draft.kind === "saved" && s.draft.revision === s.revision;
      }
      this.ws.close();
      this.current = null;
    }
    this.sealed?.unregister(SEALED_WS_PREFIX + id);
    this.vault?.lock(id);
    const { [id]: _drop, ...rest } = this.names;
    void _drop;
    this.names = rest;
    if (!kept) this.info = "ロックしました。未保存の編集は退避できませんでした（復旧ドラフトが無効です）。";
    return kept;
  }

  async lockAll(): Promise<void> {
    for (const id of Object.keys(this.names)) await this.lock(id);
  }

  /** 登録済みのパスキーをすべて外す（登録し直す前に使う。回復コードの枠は残る） */
  async removePasskeys(meta: WorkspaceMeta): Promise<boolean> {
    if (!this.store || !this.vault || !meta.keyring || this.busy) return false;
    this.busy = true;
    this.error = null;
    try {
      const m = await this.store.update(meta.id, { keyring: this.vault.withoutPasskeys(meta.keyring) });
      if (this.current?.id === meta.id) this.current = m;
      await this.refresh();
      this.info = "パスキーの登録を外しました。使うパスキーを登録し直してください。";
      return true;
    } catch (e) {
      this.error = `外せませんでした：${(e as Error).message}`;
      return false;
    } finally {
      this.busy = false;
    }
  }

  /** パスフレーズ・パスキーを加える（39.2） */
  async addUnlock(
    meta: WorkspaceMeta,
    add: { kind: "passphrase"; passphrase: string } | { kind: "passkey" },
  ): Promise<boolean> {
    if (!this.store || !this.vault || !meta.keyring || this.busy) return false;
    this.busy = true;
    this.error = null;
    try {
      const rec =
        add.kind === "passphrase"
          ? await this.vault.withPassphrase(meta.id, meta.keyring, add.passphrase)
          : await this.vault.withPasskey(meta.id, meta.keyring, this.names[meta.id] ?? "Kotono CMS");
      const m = await this.store.update(meta.id, { keyring: rec });
      if (this.current?.id === meta.id) this.current = m;
      await this.refresh();
      this.info = add.kind === "passphrase" ? "パスフレーズを設定しました。" : "パスキーを登録しました。";
      return true;
    } catch (e) {
      this.error = `設定できませんでした：${(e as Error).message}`;
      return false;
    } finally {
      this.busy = false;
    }
  }

  /** 作業場所を開く。暗号化した作業場所は解錠済みであること */
  async open(meta: WorkspaceMeta): Promise<void> {
    if (!this.store) return;
    if (!(await this.ws.confirmLeave("別の作業場所を開く前に、未保存の編集をどうしますか。"))) return;
    this.error = null;
    let root: DirHandleLike;
    try {
      root = await this.store.root(meta.id);
      if (meta.keyring) {
        if (!this.vault?.isUnlocked(meta.id)) {
          this.error = "先に解錠してください。";
          return;
        }
        root = await this.vault.wrapOpened(root, meta.id);
      }
    } catch (e) {
      this.error = `作業場所を開けません：${(e as Error).message}`;
      return;
    }
    const store = this.store;
    this.current = meta;
    if (meta.keyring && this.vault) this.sealed?.register(SEALED_WS_PREFIX + meta.id, this.vault.draftSealer(meta.id));
    await this.ws.openRoot(root, {
      displayName: meta.keyring ? (this.names[meta.id] ?? "作業場所") : meta.name,
      draftsId: meta.keyring ? SEALED_WS_PREFIX + meta.id : `p:${meta.id}`,
      backupRoot: async () => {
        const b = await store.backupRoot(meta.id);
        return meta.keyring && this.vault ? this.vault.wrapBackup(b, meta.id) : b;
      },
      onDiskChange: () => void this.touch(meta.id),
    });
  }

  private async touch(id: string): Promise<void> {
    if (!this.store) return;
    try {
      const m = await this.store.update(id, { lastChangeAt: this.now().toISOString() });
      if (this.current?.id === id) this.current = m;
    } catch {
      // 記録に失敗しても編集は続けられる（表示は次回の更新で直る）
    }
  }

  async markSynced(id: string): Promise<void> {
    if (!this.store) return;
    const m = await this.store.update(id, { lastSyncAt: this.now().toISOString() });
    if (this.current?.id === id) this.current = m;
    await this.refresh();
  }

  /** 作業場所の一覧へ戻る */
  async leave(): Promise<boolean> {
    if (!(await this.ws.confirmLeave("作業場所の一覧へ戻る前に、未保存の編集をどうしますか。"))) return false;
    this.ws.close();
    this.current = null;
    await this.refresh();
    return true;
  }

  /** `.git` を含めて zip にして渡す（38.3）。暗号化した作業場所は既定で暗号化して書き出す */
  async export(meta: WorkspaceMeta, plain: boolean): Promise<void> {
    if (!this.store || this.busy) return;
    this.busy = true;
    this.error = null;
    this.info = null;
    try {
      let root = await this.store.root(meta.id);
      if (meta.keyring) {
        if (!this.vault?.isUnlocked(meta.id)) throw new Error("先に解錠してください。");
        root = await this.vault.wrapOpened(root, meta.id);
      }
      const r = await exportZip(root);
      if (!r.ok) throw new Error(r.message);
      let bytes = r.bytes;
      let ext = "zip";
      if (meta.keyring && !plain && this.vault) {
        bytes = await this.vault.sealExport(meta.id, bytes, meta.keyring.slots);
        ext = "kotono";
      }
      const label = (meta.keyring ? this.names[meta.id] : meta.name) ?? "workspace";
      const stamp = this.now().toISOString().slice(0, 10).replaceAll("-", "");
      const res = await this.deliver(bytes, `${label.replace(/[\\/:*?"<>|\s]+/g, "_")}-${stamp}.${ext}`);
      if (res === "cancelled") {
        this.info = "書き出しを取り消しました。";
        return;
      }
      const m = await this.store.update(meta.id, { lastExportAt: this.now().toISOString() });
      if (this.current?.id === meta.id) this.current = m;
      // ダウンロード・共有の開始だけでは保存成功を確かめられない（38.3）
      this.info = `書き出しを開始しました（${r.files} ファイル）。保存先に届いたかは、ファイル App 等で確かめてください。`;
      await this.refresh();
    } catch (e) {
      this.error = `書き出せません：${(e as Error).message}`;
    } finally {
      this.busy = false;
    }
  }

  // -------------------------------------------------------------------------
  // 自動ロック（39.3）

  get anyUnlocked(): boolean {
    return Object.keys(this.names).length > 0;
  }

  activity(): void {
    this.lastActive = this.now().getTime();
  }

  /** 定期的に呼ぶ。無操作が続いたらロックする */
  async tick(): Promise<void> {
    if (this.lockMinutes <= 0 || !this.anyUnlocked || this.busy) return;
    if (this.lastActive === 0) this.activity();
    if (this.now().getTime() - this.lastActive >= this.lockMinutes * 60_000) await this.autoLock();
  }

  /**
   * ページの表示・非表示。非表示の間はタイマーが止まることがある（iOS）ので、戻ったときに経過時間で判断する。
   * 共有シート・ファイル選択で一時的に隠れることがあるため、非表示の猶予は無操作時間と HIDDEN_GRACE_MINUTES の短い方。
   */
  async visibility(hidden: boolean): Promise<void> {
    const t = this.now().getTime();
    if (hidden) {
      this.hiddenAt = t;
      return;
    }
    const at = this.hiddenAt;
    this.hiddenAt = null;
    if (at === null || this.lockMinutes <= 0 || !this.anyUnlocked) return;
    const grace = Math.min(this.lockMinutes, HIDDEN_GRACE_MINUTES) * 60_000;
    if (t - at >= grace) await this.autoLock();
    else this.activity();
  }

  private async autoLock(): Promise<void> {
    await this.lockAll();
    this.info ??= "しばらく操作がなかったのでロックしました。";
  }

  async remove(id: string): Promise<void> {
    if (!this.store || this.busy) return;
    if (this.current?.id === id) {
      this.ws.close();
      this.current = null;
    }
    this.busy = true;
    this.error = null;
    try {
      const r = await this.store.remove(id);
      if (!r.ok) this.error = `削除できませんでした：${r.message}`;
      else this.vault?.forget(id);
      await this.refresh();
    } finally {
      this.busy = false;
    }
  }
}

/** ブラウザでの受け渡し：共有シート（iOS）を優先し、なければダウンロード */
export function browserDeliver(host: StorageHost & { document?: Document; URL?: typeof URL }): Deliver {
  return async (bytes, fileName) => {
    const type = fileName.endsWith(".zip") ? "application/zip" : "application/octet-stream";
    const file = new File([bytes as Uint8Array<ArrayBuffer>], fileName, { type });
    const nav = host.navigator;
    if (nav?.share && nav.canShare?.({ files: [file] })) {
      try {
        await nav.share({ files: [file], title: fileName });
        return "shared";
      } catch (e) {
        if ((e as Error).name === "AbortError") return "cancelled";
        // 共有できなければダウンロードへ
      }
    }
    const doc = host.document;
    if (!doc) return "cancelled";
    const url = URL.createObjectURL(file);
    try {
      const a = doc.createElement("a");
      a.href = url;
      a.download = fileName;
      a.rel = "noopener";
      doc.body.append(a);
      a.click();
      a.remove();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
    return "downloaded";
  };
}
