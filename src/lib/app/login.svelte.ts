/**
 * 起動時のログイン（ADR-0011）。
 *
 * 最初にパスキーを登録し、以後の起動ではパスキーで認証してから使い始める。サーバーへのログインではなく、
 * 端末内の「ログイン鍵」をパスキーの PRF で開く操作で、ログイン鍵は復旧ドラフトの暗号化と、
 * ブラウザ内の暗号化した作業場所の鍵を包むのに使う。
 *
 * - パスキーを使えない環境（file:// で開いたとき・PRF に対応しないとき）は、パスフレーズで同じことをする。
 * - 回復コードの枠は必ず作る（パスキー・パスフレーズを失ったときの道）。回復コードは登録時に一度だけ表示する。
 * - ログイン鍵はログイン中だけメモリに置く。ロックで捨てる。
 */
import { accountName } from "../crypto/passkey";
import type { UnlockMethod, Vault } from "../crypto/vault";
import type { SealedDraftStore } from "../drafts/sealed";
import type { LoginRecord, LoginStore } from "../login/store";
import type { KeyringRecord } from "../workspaces/store";

/** Vault の中でログイン鍵を置く ID（作業場所 ID と重ならない） */
export const LOGIN_ID = "login";
/** パスキー・回復コードのユーザー名（パスワード管理での表示） */
export const LOGIN_ACCOUNT = "kotono-login";

export type LoginPhase =
  /** 記録を読んでいる */
  | "loading"
  /** この環境ではログインできない（IndexedDB がない）。ログインなしで使う */
  | "unavailable"
  /** 初回：パスキー（またはパスフレーズ）を登録する */
  | "register"
  /** 登録直後：回復コードの保存を確かめる */
  | "recovery"
  /** 2 回目以降：パスキー（またはパスフレーズ・回復コード）で認証する */
  | "login"
  /** ログイン済み */
  | "ready";

export type RegisterMethod =
  { readonly kind: "passkey" } | { readonly kind: "passphrase"; readonly passphrase: string };

export class LoginController {
  /** 記録は IndexedDB へそのまま書くので、深い反応（Proxy）にしない（構造化複製できない） */
  record = $state.raw<LoginRecord | null>(null);
  loaded = $state(false);
  unlocked = $state(false);
  busy = $state(false);
  error = $state<string | null>(null);
  info = $state<string | null>(null);
  /** 登録直後に一度だけ表示する回復コード */
  recoveryCode = $state<string | null>(null);
  /** 直前のパスキーでの認証が失敗した（回復コードを先に勧める） */
  failed = $state(false);

  constructor(
    readonly vault: Vault,
    private readonly store: LoginStore | null,
    private readonly sealed: SealedDraftStore | null,
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- 時刻を得るだけで、状態として持たない
    private readonly now: () => Date = () => new Date(),
  ) {}

  get phase(): LoginPhase {
    if (!this.store) return "unavailable";
    if (!this.loaded) return "loading";
    if (this.recoveryCode !== null) return "recovery";
    if (this.unlocked) return "ready";
    return this.record ? "login" : "register";
  }

  /** この環境でパスキーを使えるか（file:// では使えない） */
  get passkeySupported(): boolean {
    return this.vault.passkey !== null;
  }

  /** 登録済みで、この配信元で使えるパスキーがあるか */
  get hasPasskey(): boolean {
    return this.record?.keyring.slots.some((s) => this.vault.usablePasskey(s)) ?? false;
  }

  /** 登録したパスキーが、別の配信元のものだけか（ここでは使えない） */
  get passkeyElsewhere(): boolean {
    const slots = this.record?.keyring.slots ?? [];
    return slots.some((s) => s.kind === "passkey") && !this.hasPasskey;
  }

  get hasPassphrase(): boolean {
    return this.record?.keyring.slots.some((s) => s.kind === "passphrase") ?? false;
  }

  readonly account = LOGIN_ACCOUNT;

  async init(): Promise<void> {
    if (!this.store) return;
    try {
      this.record = await this.store.load();
    } catch (e) {
      this.error = `ログインの記録を読めません：${(e as Error).message}`;
    } finally {
      this.loaded = true;
    }
  }

  /** 初回の登録：ログイン鍵と回復コードの枠を作り、パスキー（またはパスフレーズ）の枠を加えて保存する */
  async register(method: RegisterMethod): Promise<boolean> {
    if (!this.store || this.busy || this.record) return false;
    this.busy = true;
    this.error = null;
    try {
      const fresh = await this.vault.prepareNew();
      this.vault.adopt(LOGIN_ID, fresh.key);
      let keyring: KeyringRecord;
      try {
        keyring =
          method.kind === "passkey"
            ? await this.vault.withPasskey(LOGIN_ID, fresh.record, accountName(LOGIN_ID))
            : await this.vault.withPassphrase(LOGIN_ID, fresh.record, method.passphrase);
      } catch (e) {
        this.vault.lock(LOGIN_ID);
        throw e;
      }
      const rec: LoginRecord = { v: 1, keyring, places: {}, createdAt: this.now().toISOString() };
      await this.store.save(rec);
      this.record = rec;
      this.recoveryCode = fresh.recoveryCode;
      await this.afterUnlock();
      return true;
    } catch (e) {
      this.error = `登録できませんでした：${(e as Error).message}`;
      return false;
    } finally {
      this.busy = false;
    }
  }

  /** 回復コードを保存したことを確かめた */
  confirmRecovery(): void {
    this.recoveryCode = null;
  }

  /** ログインする。失敗しても自動では繰り返さない */
  async login(method: UnlockMethod): Promise<boolean> {
    const rec = this.record;
    if (!rec || this.busy) return false;
    this.busy = true;
    this.error = null;
    this.info = null;
    try {
      const r = await this.vault.unlock(LOGIN_ID, rec.keyring, method);
      if (!r) {
        this.failed = method.kind === "passkey";
        this.error =
          method.kind === "passkey"
            ? "このパスキーではログインできませんでした。回復コードでログインできます。"
            : method.kind === "passphrase"
              ? "パスフレーズが違います。"
              : "回復コードが違います。";
        return false;
      }
      this.failed = false;
      await this.afterUnlock();
      return true;
    } catch (e) {
      this.failed = method.kind === "passkey";
      this.error = `ログインできませんでした：${(e as Error).message}`;
      return false;
    } finally {
      this.busy = false;
    }
  }

  private async afterUnlock(): Promise<void> {
    this.unlocked = true;
    try {
      const n = (await this.sealed?.setDefault(this.vault.draftSealer(LOGIN_ID))) ?? 0;
      if (n > 0) this.info = `以前の版で暗号化せずに置いていた復旧ドラフト ${n} 件を暗号化しました。`;
    } catch (e) {
      this.info = `以前の復旧ドラフトを暗号化し直せませんでした：${(e as Error).message}`;
    }
  }

  /** ロックする（ログイン鍵を捨てる）。作業場所のロック・閉じる処理は呼び出し側で先に行う */
  lock(): void {
    this.vault.lock(LOGIN_ID);
    void this.sealed?.setDefault(null);
    this.unlocked = false;
    this.failed = false;
  }

  /**
   * ログインの記録を消して、登録からやり直す。パスキー・パスフレーズ・回復コードのどれも使えないときの道。
   * ログイン鍵で暗号化した復旧ドラフトは読めなくなる（呼び出し側で削除する）。
   */
  async reset(): Promise<void> {
    if (!this.store) return;
    this.lock();
    await this.store.clear();
    this.record = null;
    this.error = null;
    this.info = null;
  }

  // -------------------------------------------------------------------------
  // ログインの方法を足す（「設定」の画面）

  async addMethod(add: RegisterMethod): Promise<boolean> {
    const rec = this.record;
    if (!this.store || !rec || !this.unlocked || this.busy) return false;
    this.busy = true;
    this.error = null;
    this.info = null;
    try {
      const keyring =
        add.kind === "passkey"
          ? await this.vault.withPasskey(LOGIN_ID, rec.keyring, accountName(LOGIN_ID))
          : await this.vault.withPassphrase(LOGIN_ID, rec.keyring, add.passphrase);
      await this.save({ ...rec, keyring });
      this.info = add.kind === "passkey" ? "パスキーを登録しました。" : "パスフレーズを設定しました。";
      return true;
    } catch (e) {
      this.error = `設定できませんでした：${(e as Error).message}`;
      return false;
    } finally {
      this.busy = false;
    }
  }

  private async save(rec: LoginRecord): Promise<void> {
    await this.store?.save(rec);
    this.record = rec;
  }

  // -------------------------------------------------------------------------
  // 暗号化した作業場所の鍵（ログインだけで開けるようにする）

  /** 解錠中の作業場所の鍵を、ログイン鍵で包んで覚える */
  async rememberPlace(placeId: string): Promise<void> {
    const rec = this.record;
    if (!rec || !this.unlocked || !this.vault.isUnlocked(placeId)) return;
    const wrapped = await this.vault.wrapPlace(LOGIN_ID, placeId);
    await this.save({ ...rec, places: { ...rec.places, [placeId]: wrapped } });
  }

  async forgetPlace(placeId: string): Promise<void> {
    const rec = this.record;
    if (!rec || !(placeId in rec.places)) return;
    const { [placeId]: _drop, ...rest } = rec.places;
    void _drop;
    await this.save({ ...rec, places: rest });
  }

  /** 覚えている作業場所の鍵を開く。開けた作業場所の ID を返す */
  async unlockPlaces(): Promise<string[]> {
    const rec = this.record;
    if (!rec || !this.unlocked) return [];
    const out: string[] = [];
    for (const [id, wrapped] of Object.entries(rec.places)) {
      if (await this.vault.unwrapPlace(LOGIN_ID, id, wrapped)) out.push(id);
    }
    return out;
  }
}
