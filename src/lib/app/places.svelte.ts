/**
 * ブラウザ内の作業場所の画面の状態と操作（仕様 3.2 第38章、ADR-0006・ADR-0012）。
 *
 * 作業場所を開いたあとの記事の操作は Workspace（実フォルダと同じ処理）に任せる。
 * ここで扱うのは、作業場所の一覧・作成・取り込み・書き出し・削除と、保存領域の永続化の状態。
 * 作業場所はすべて暗号化し、起動時のロック解除で開く鍵（ロック解除の鍵）で開く（ADR-0012）。
 */
import type { DirHandleLike } from "../fs/types";
import type { Workspace } from "./workspace.svelte";
import {
  BACKUP_REMIND_DAYS,
  WorkspaceStore,
  unsyncedSince,
  type KeySlot,
  type OpfsResult,
  type WorkspaceEntry,
  type WorkspaceMeta,
} from "../workspaces/store";
import { exportZip, extractZip, planZip, type ZipPlan } from "../workspaces/zip";
import { Vault, type Unlocked, type UnlockMethod } from "../crypto/vault";
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
}

export interface PlaceView {
  readonly id: string;
  readonly entry: WorkspaceEntry;
  /** 表示名（平文） */
  readonly label: string;
  /** いまのロック解除の鍵では開けていない（別の鍵で作った作業場所など。削除はできる） */
  readonly locked: boolean;
}

/**
 * 起動時のロック解除（ADR-0011・ADR-0012）とのつなぎ。作業場所の鍵はロック解除の鍵で包んで meta に置くので、
 * ロックを解除しただけで開ける。自動ロックではアプリ全体をロックする。
 */
export interface PlaceHooks {
  /**
   * ロック解除中なら、Vault の中のロック解除の鍵の ID と、書き出しに入れる枠（回復コード・パスキー）。ロック中は null
   * （作業場所を作る・取り込む・開くにはロック解除が要る）
   */
  readonly login?: () => { readonly id: string; readonly slots: readonly KeySlot[] } | null;
  /** 無操作で自動ロックした */
  readonly autoLocked?: () => void;
  /** 作業場所のほかに、自動ロックの対象（ロック解除の鍵）が開いているか */
  readonly active?: () => boolean;
}

/** 書き出したファイルを端末の外へ渡す（共有シート、なければダウンロード：38.3） */
export type Deliver = (bytes: Uint8Array, fileName: string) => Promise<"shared" | "downloaded" | "cancelled">;

export class PlacesController {
  store = $state<WorkspaceStore | null>(null);
  entries = $state<WorkspaceEntry[]>([]);
  /** 開いている（鍵を持っている）作業場所（ID → 表示名） */
  unlocked = $state<Record<string, string>>({});
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
    /** 暗号化した書き出しから取り込むときの DK（同じ鍵のまま作業場所にする）。平文の zip なら null（新しい鍵） */
    key: Unlocked | null;
  } | null>(null);
  /** 回復コード・パスキーを待っている、暗号化した書き出し（38.2・39.4）。passkey は書き出しのヘッダーにパスキーの枠があるか */
  pendingSealed = $state<{ name: string; bytes: Uint8Array; passkey: boolean } | null>(null);
  /** 作業場所の一覧を読み終えたか */
  ready = $state(false);

  readonly vault: Vault;
  private readonly sealed: SealedDraftStore | null;
  private readonly now: () => Date;
  private readonly hooks: PlaceHooks;

  constructor(
    private readonly ws: Workspace,
    private readonly host: StorageHost,
    private readonly deliver: Deliver,
    opts: { vault: Vault; sealed?: SealedDraftStore | null; now?: () => Date; hooks?: PlaceHooks },
  ) {
    this.vault = opts.vault;
    this.sealed = opts.sealed ?? null;
    this.hooks = opts.hooks ?? {};
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- 時刻を得るだけで、状態として持たない
    this.now = opts.now ?? (() => new Date());
  }

  /** 自動ロックまでの無操作時間（分、0 は自動ロックしない：39.3） */
  lockMinutes = $state(DEFAULT_LOCK_MINUTES);
  private lastActive = 0;
  private hiddenAt: number | null = null;

  /** ホーム画面から開いているか（38.4：ブラウザでの利用時は推奨を表示する） */
  get standalone(): boolean {
    return (
      this.host.navigator?.standalone === true || this.host.matchMedia?.("(display-mode: standalone)").matches === true
    );
  }

  /** ブラウザ内の保存領域（OPFS）を開けなかった理由。開けていれば null（作成・取り込みの欄を出さない） */
  storageError = $state<string | null>(null);
  private opener: (() => Promise<OpfsResult>) | null = null;

  /** 保存領域を開いてから一覧を読む。開けなければ理由を storageError に置く（retry でやり直せる） */
  async start(open: () => Promise<OpfsResult>): Promise<void> {
    this.opener = open;
    this.storageError = null;
    const r = await open();
    if (!r.ok) {
      this.storageError = r.reason;
      this.ready = true;
      return;
    }
    await this.init(r.root);
  }

  /** 保存領域をもう一度開く */
  async retry(): Promise<void> {
    if (!this.opener || this.store || this.busy) return;
    this.busy = true;
    try {
      await this.start(this.opener);
    } finally {
      this.busy = false;
    }
  }

  async init(root: DirHandleLike): Promise<void> {
    try {
      this.store = await WorkspaceStore.open(root);
      this.storageError = null;
    } catch (e) {
      this.storageError = (e as Error).message;
      this.ready = true;
      return;
    }
    await this.refresh();
    this.ready = true;
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
      return { id: entry.meta.id, entry, label: entry.meta.name, locked: !(entry.meta.id in this.unlocked) };
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

  /** ロック解除中なら Vault の中のロック解除の鍵の ID */
  private get loginId(): string | null {
    return this.hooks.login?.()?.id ?? null;
  }

  /** ロックを解除していない（作業場所を作る・取り込む・開くには、ロック解除が要る） */
  get needsLogin(): boolean {
    return this.loginId === null;
  }

  /** 作業場所を作る。常に暗号化し、データ鍵はロック解除の鍵で包む（ADR-0012：作業場所ごとの回復コードはない） */
  async create(name: string): Promise<WorkspaceMeta | null> {
    if (this.busy) return null;
    if (!this.store) {
      // 黙って何もしないと、押しても反応しないように見える
      this.error = "ブラウザ内の保存領域を開けていないため、作業場所を作れません。";
      return null;
    }
    const lid = this.loginId;
    if (!lid) {
      this.error = "ロックを解除していないため、作業場所を作れません。";
      return null;
    }
    this.busy = true;
    this.error = null;
    try {
      const vault = this.vault;
      const key = await vault.newKey();
      const meta = await this.store.create({
        name,
        keyring: (id) => vault.placeKeyring(lid, id, key),
        // 記事の置き場所を用意しておく（初回フォルダ準備を省く：3.1）
        fill: async (dir, id) => {
          const t = await vault.wrapDir(dir, id, key);
          const c = await t.getDirectoryHandle("content", { create: true });
          await c.getDirectoryHandle("articles", { create: true });
        },
      });
      vault.adopt(meta.id, key);
      this.unlocked = { ...this.unlocked, [meta.id]: name.trim() };
      await this.refresh();
      return meta;
    } catch (e) {
      this.error = `作業場所を作れません：${(e as Error).message}`;
      return null;
    } finally {
      this.busy = false;
    }
  }

  /** zip（または暗号化した書き出し）を検査して確認待ちにする（38.2：未信頼入力） */
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
      const h = Vault.readExportHeader(bytes);
      if (!h) {
        this.error = "暗号化した書き出しの形式が違います（壊れている可能性があります）。";
        return;
      }
      // いまのロック解除の鍵で書き出したもの（この端末で書き出した）なら、そのまま開ける
      const lid = this.loginId;
      if (lid) {
        const r = await this.vault.openSealedExport(bytes, { kind: "login", loginId: lid }).catch(() => null);
        if (r) {
          this.planImport(base, r.zip, r.key);
          return;
        }
      }
      this.pendingSealed = {
        name: base,
        bytes,
        passkey: h.header.login.slots.some((s) => s.kind === "passkey"),
      };
      return;
    }
    this.planImport(base, bytes, null);
  }

  private planImport(name: string, bytes: Uint8Array, key: Unlocked | null): void {
    const plan = planZip(bytes);
    if (!plan.ok) {
      this.error = `取り込めません：${plan.message}`;
      return;
    }
    this.pendingImport = { name, bytes, plan, key };
  }

  /** 暗号化した書き出しを、書き出した端末の回復コード・パスキーで開く（別の端末） */
  async unsealImport(method: UnlockMethod): Promise<boolean> {
    const p = this.pendingSealed;
    if (!p || this.busy) return false;
    this.busy = true;
    this.error = null;
    try {
      const r = await this.vault.openSealedExport(p.bytes, method);
      if (!r) {
        this.error = "開けませんでした。書き出した端末の回復コードを確かめてください。";
        return false;
      }
      this.pendingSealed = null;
      this.planImport(p.name, r.zip, r.key);
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

  /** 新しい作業場所へ展開する。完成するまで meta を書かない（38.2）。ロック解除の鍵で包んで暗号化する */
  async confirmImport(name: string): Promise<WorkspaceMeta | null> {
    const p = this.pendingImport;
    if (!this.store || !p || this.busy) return null;
    const lid = this.loginId;
    if (!lid) {
      this.error = "ロックを解除していないため、取り込めません。";
      return null;
    }
    this.busy = true;
    this.error = null;
    try {
      const vault = this.vault;
      // 暗号化した書き出しは同じ鍵のまま。平文の zip は新しい鍵で暗号化する
      const key = p.key ?? (await vault.newKey());
      const meta = await this.store.create({
        name,
        keyring: (id) => vault.placeKeyring(lid, id, key),
        fill: async (dir, id) => {
          const target = await vault.wrapDir(dir, id, key);
          const r = await extractZip(p.bytes, target, p.plan);
          if (!r.ok) throw new Error(`${r.message}（${r.written} 件を書いたところで止めました）`);
        },
      });
      vault.adopt(meta.id, key);
      this.unlocked = { ...this.unlocked, [meta.id]: name.trim() };
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

  // -------------------------------------------------------------------------
  // ロック解除（ADR-0012）：ロックを解除したら、ロック解除の鍵で開ける作業場所をすべて開く

  /**
   * ロックを解除したら、ロック解除の鍵で開ける作業場所を開く。開けた作業場所の ID を返す。
   * 開けない作業場所（別の鍵で作ったもの）は一覧に残す（削除はできる）。
   */
  async unlockAll(): Promise<string[]> {
    const lid = this.loginId;
    if (!lid) return [];
    const unlocked = { ...this.unlocked };
    const out: string[] = [];
    for (const e of this.entries) {
      if (e.state !== "ok") continue;
      const m = e.meta;
      const ok =
        this.vault.isUnlocked(m.id) || (await this.vault.unlockWithLogin(lid, m.id, m.keyring).catch(() => false));
      if (!ok) continue;
      unlocked[m.id] = m.name;
      out.push(m.id);
    }
    this.unlocked = unlocked;
    return out;
  }

  /**
   * 作業場所の鍵を捨てる（開いていれば閉じる）。未保存の編集は、閉じる前に暗号化した復旧ドラフトへ退避する（39.3）。
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
    this.forget(id);
    if (!kept) this.info = "ロックしました。未保存の編集は退避できませんでした（復旧ドラフトが無効です）。";
    return kept;
  }

  /** 鍵と、暗号化したドラフトの道具を捨てる（開いている作業場所は閉じてから呼ぶ） */
  private forget(id: string): void {
    this.sealed?.unregister(SEALED_WS_PREFIX + id);
    this.vault.lock(id);
    const { [id]: _drop, ...rest } = this.unlocked;
    void _drop;
    this.unlocked = rest;
  }

  async lockAll(): Promise<void> {
    for (const id of Object.keys(this.unlocked)) await this.lock(id);
  }

  /** 作業場所を開く。ロック解除の鍵で開いていること */
  async open(meta: WorkspaceMeta): Promise<void> {
    if (!this.store) return;
    if (!(await this.ws.confirmLeave("別の作業場所を開く前に、未保存の編集をどうしますか。"))) return;
    this.error = null;
    const vault = this.vault;
    const store = this.store;
    let root: DirHandleLike;
    try {
      if (!vault.isUnlocked(meta.id)) {
        this.error = "いまのロック解除の鍵では開けません。削除することはできます。";
        return;
      }
      root = await vault.wrapOpened(await store.root(meta.id), meta.id);
    } catch (e) {
      this.error = `作業場所を開けません：${(e as Error).message}`;
      return;
    }
    this.current = meta;
    this.sealed?.register(SEALED_WS_PREFIX + meta.id, vault.draftSealer(meta.id));
    await this.ws.openRoot(root, {
      displayName: meta.name || "作業場所",
      draftsId: SEALED_WS_PREFIX + meta.id,
      backupRoot: async () => vault.wrapBackup(await store.backupRoot(meta.id), meta.id),
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

  /**
   * `.git` を含めて zip にして渡す（38.3）。既定は暗号化して書き出す（ロック解除の鍵で包んだ DK を入れる）。
   * plain なら暗号化しない zip（中身は平文）。
   */
  async export(meta: WorkspaceMeta, plain: boolean): Promise<void> {
    if (!this.store || this.busy) return;
    this.busy = true;
    this.error = null;
    this.info = null;
    try {
      const vault = this.vault;
      if (!vault.isUnlocked(meta.id)) throw new Error("先にロックを解除してください。");
      const root = await vault.wrapOpened(await this.store.root(meta.id), meta.id);
      const r = await exportZip(root);
      if (!r.ok) throw new Error(r.message);
      let bytes = r.bytes;
      let ext = "zip";
      if (!plain) {
        const login = this.hooks.login?.() ?? null;
        if (!login) throw new Error("ロックを解除していないため、暗号化して書き出せません。");
        bytes = await vault.sealExport(meta.id, bytes, login.id, login.slots);
        ext = "kotono";
      }
      const label = meta.name || "workspace";
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
    return Object.keys(this.unlocked).length > 0;
  }

  private get lockable(): boolean {
    return this.anyUnlocked || (this.hooks.active?.() ?? false);
  }

  activity(): void {
    this.lastActive = this.now().getTime();
  }

  /** 定期的に呼ぶ。無操作が続いたらロックする */
  async tick(): Promise<void> {
    if (this.lockMinutes <= 0 || !this.lockable || this.busy) return;
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
    if (at === null || this.lockMinutes <= 0 || !this.lockable) return;
    const grace = Math.min(this.lockMinutes, HIDDEN_GRACE_MINUTES) * 60_000;
    if (t - at >= grace) await this.autoLock();
    else this.activity();
  }

  private async autoLock(): Promise<void> {
    await this.lockAll();
    this.info ??= "しばらく操作がなかったのでロックしました。";
    this.hooks.autoLocked?.();
  }

  /** 作業場所を削除する。開いていれば閉じてから消す（退避は消さない：19.1） */
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
      else this.forget(id);
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
