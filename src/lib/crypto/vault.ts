/**
 * 鍵の管理とロック解除（仕様 3.2 第39章、ADR-0012）。
 *
 * - ロック解除の鍵は、起動時のロック解除（パスキーか回復コード）で開く鍵。ロック解除中だけメモリに置き、ロックで捨てる。
 *   ロック解除の鍵は回復コードの枠（必須）とパスキーの PRF の枠（任意）で包み、ロック解除の記録（IndexedDB）に置く。
 *   コード上の名前は login のまま（loginId・NewLogin・枠の種類 `login`。画面の表現は ADR-0014）。
 * - 作業場所のデータ鍵（DK）は、ロック解除の鍵で包んで作業場所の meta に置く（枠の種類 `login`）。
 *   作業場所ごとの回復コード・パスキー・パスフレーズはない。
 * - 暗号化した書き出し（`.kotono`）は、ロック解除の鍵を包んだ枠（回復コード・パスキー）と、ロック解除の鍵で包んだ DK と、
 *   DK から作った書き出し用の鍵で暗号化した zip からなる。別の端末では、回復コード（または同期したパスキー）で開ける。
 */
import {
  PBKDF2_ITERATIONS,
  aesDecrypt,
  aesEncrypt,
  b64u,
  deriveDataKeys,
  fromB64u,
  hmac,
  keyFromPrf,
  keyFromSecret,
  newRecoveryCode,
  normalizeRecoveryCode,
  randomBytes,
  unwrapDk,
  wrapDk,
  type DataKeys,
} from "./keys";
import type { DirHandleLike } from "../fs/types";
import { validKeyring, type KeyringRecord, type KeySlot } from "../workspaces/store";
import type { Sealer } from "../drafts/sealed";
import { encryptedRoot, type EncContext } from "./encfs";
import type { PasskeyApi } from "./passkey";

const te = new TextEncoder();
const td = new TextDecoder("utf-8", { fatal: true });
const TOKEN_AAD = te.encode("kotono-cms/meta/token");
const DRAFT_AAD = te.encode("kotono-cms/draft");
/** ロック解除の鍵で作業場所のデータ鍵を包むときの追加認証データ（作業場所 ID を足す） */
const PLACE_AAD = te.encode("kotono-cms/login/place");
/** 書き出しで、書き出した端末のロック解除の鍵で DK を包むときの追加認証データ */
const EXPORT_DK_AAD = te.encode("kotono-cms/export/dk");
const EXPORT_MAGIC = te.encode("KOTONO-EXPORT/1\n");

function placeAad(id: string): Uint8Array {
  return new Uint8Array([...PLACE_AAD, 0, ...te.encode(id)]);
}

export interface Unlocked {
  readonly dk: Uint8Array;
  readonly keys: DataKeys;
}

/** ロック解除の方法（ADR-0012：パスキーと回復コードだけ。パスフレーズはない） */
export type UnlockMethod = { readonly kind: "recovery"; readonly code: string } | { readonly kind: "passkey" };

type PasskeySlot = Extract<KeySlot, { kind: "passkey" }>;

export interface NewLogin {
  /** ロック解除の記録の枠（回復コードの枠だけ。パスキーは登録のあとに足す） */
  readonly keyring: KeyringRecord;
  readonly key: Unlocked;
  /** 作成時に一度だけ表示する（保存しない：39.2） */
  readonly recoveryCode: string;
}

/** 暗号化した書き出し（版 1）のヘッダー。ロック解除の鍵を包んだ枠（回復コード・パスキー）と、ロック解除の鍵で包んだ DK */
export interface SealedExportHeader {
  readonly v: 1;
  readonly login: { readonly slots: readonly KeySlot[]; readonly wrapped: string };
}

export class Vault {
  private readonly open = new Map<string, Unlocked>();

  constructor(
    readonly passkey: PasskeyApi | null = null,
    private readonly iterations: number = PBKDF2_ITERATIONS,
  ) {}

  isUnlocked(id: string): boolean {
    return this.open.has(id);
  }

  adopt(id: string, key: Unlocked): void {
    this.open.set(id, key);
  }

  lock(id: string): void {
    this.open.delete(id);
  }

  lockAll(): void {
    this.open.clear();
  }

  private need(id: string): Unlocked {
    const k = this.open.get(id);
    if (!k) throw new Error("ロックされています。");
    return k;
  }

  /** 新しいデータ鍵（乱数）。ロック解除の鍵にも作業場所のデータ鍵にも使う */
  async newKey(): Promise<Unlocked> {
    const dk = randomBytes(32);
    return { dk, keys: await deriveDataKeys(dk) };
  }

  /** 新しいロック解除の鍵と回復コードの枠を作る。パスキーは登録のあとに withPasskey で足す */
  async newLogin(): Promise<NewLogin> {
    const key = await this.newKey();
    const code = newRecoveryCode();
    const slot = await this.recoverySlot(code, key.dk);
    return { keyring: { v: 1, slots: [slot] }, key, recoveryCode: code };
  }

  /** 作業場所の枠（ロック解除の鍵で包んだ枠だけ）を作る。ロック解除の鍵（loginId で開いている）で DK を包む */
  async placeKeyring(loginId: string, placeId: string, key: Unlocked): Promise<KeyringRecord> {
    const login = this.need(loginId);
    const wrapped = b64u(await aesEncrypt(login.keys.meta, key.dk, placeAad(placeId)));
    return { v: 1, slots: [{ kind: "login", wrapped }] };
  }

  /**
   * ロック解除の鍵（loginId で開いている）で、作業場所の枠を開き、作業場所の鍵を置く。
   * 開けなければ false（ロック解除の鍵がない・別の作業場所の枠・枠が壊れている）
   */
  async unlockWithLogin(loginId: string, placeId: string, keyring: KeyringRecord): Promise<boolean> {
    const login = this.open.get(loginId);
    if (!login) return false;
    for (const s of keyring.slots) {
      if (s.kind !== "login") continue;
      const b = fromB64u(s.wrapped);
      const dk = b ? await aesDecrypt(login.keys.meta, b, placeAad(placeId)) : null;
      if (dk && dk.length === 32) {
        this.open.set(placeId, { dk, keys: await deriveDataKeys(dk) });
        return true;
      }
    }
    return false;
  }

  /** 回復コードで鍵を包んだ枠を作る（塩はこの枠ごとに乱数） */
  private async recoverySlot(code: string, dk: Uint8Array): Promise<KeySlot> {
    const salt = randomBytes(16);
    const w = await keyFromSecret(normalizeRecoveryCode(code) ?? "", salt, this.iterations);
    return { kind: "recovery", salt: b64u(salt), iterations: this.iterations, wrapped: b64u(await wrapDk(w, dk)) };
  }

  /** パスキーを登録し、PRF の出力でロック解除の鍵を包んだ枠を加える（ロック解除中であること） */
  async withPasskey(loginId: string, record: KeyringRecord, label: string): Promise<KeyringRecord> {
    if (!this.passkey) throw new Error("この環境ではパスキーを使えません。");
    const k = this.need(loginId);
    // 塩はパスキーどうしで共通にする。共通なら認証時に PRF の入力を eval だけで渡せる
    // （evalByCredential に対応しないパスキー管理アプリがある：iOS の 1Password）。
    // PRF の出力はパスキーごとの秘密で決まるので、塩が共通でも包む鍵はパスキーごとに違う。
    const shared = record.slots.find((s) => s.kind === "passkey");
    const prfSalt = (shared?.kind === "passkey" ? fromB64u(shared.prfSalt) : null) ?? randomBytes(32);
    const cred = await this.passkey.register(label, prfSalt);
    const w = await keyFromPrf(cred.prf);
    const slot: KeySlot = {
      kind: "passkey",
      credentialId: b64u(cred.credentialId),
      prfSalt: b64u(prfSalt),
      wrapped: b64u(await wrapDk(w, k.dk)),
      ...(this.passkey.rpId ? { rpId: this.passkey.rpId } : {}),
    };
    return { ...record, slots: [...record.slots, slot] };
  }

  /** 枠で鍵を開く。開けたら id の鍵として置き、true を返す。開けなければ false */
  async unlock(id: string, keyring: KeyringRecord, method: UnlockMethod): Promise<boolean> {
    const k = await this.unlockSlots(keyring.slots, method);
    if (!k) return false;
    this.open.set(id, k);
    return true;
  }

  /**
   * 枠のいずれかで鍵を開く。開けなければ null。
   * パスキーの枠がなければ例外（呼び出し側は画面に出す）。パスキーの認証を取り消したときも例外になる。
   */
  async unlockSlots(slots: readonly KeySlot[], method: UnlockMethod): Promise<Unlocked | null> {
    let dk: Uint8Array | null = null;
    if (method.kind === "passkey") {
      const pk = slots.filter((s): s is PasskeySlot => s.kind === "passkey");
      if (pk.length === 0) throw new Error("パスキーが登録されていません。");
      dk = await this.authenticatePasskey(pk);
    } else {
      const secret = normalizeRecoveryCode(method.code);
      if (!secret) return null;
      for (const s of slots) {
        if (s.kind !== "recovery") continue;
        const salt = fromB64u(s.salt);
        const wrapped = fromB64u(s.wrapped);
        if (!salt || !wrapped) continue;
        dk = await unwrapDk(await keyFromSecret(secret, salt, s.iterations), wrapped);
        if (dk) break;
      }
    }
    return dk ? { dk, keys: await deriveDataKeys(dk) } : null;
  }

  /** この配信元で使えるパスキーの枠か（配信元を記録していない枠は、ここでも試す） */
  usablePasskey(slot: KeySlot): slot is PasskeySlot {
    const here = this.passkey?.rpId;
    return slot.kind === "passkey" && (slot.rpId === undefined || here === undefined || slot.rpId === here);
  }

  /**
   * 候補のパスキーの枠をまとめて 1 回のパスキー認証にかけ、選ばれたパスキーの枠で鍵を開く。
   * 選ばれたパスキーがどの候補にもない・鍵を開けないときは null。
   */
  private async authenticatePasskey(candidates: readonly PasskeySlot[]): Promise<Uint8Array | null> {
    if (!this.passkey) throw new Error("この環境ではパスキーを使えません。");
    const usable = candidates.filter((s) => this.usablePasskey(s));
    if (usable.length === 0) {
      const rp = candidates[0]?.rpId ?? "";
      throw new Error(
        `このパスキーは「${rp}」で登録したもので、ここ（${this.passkey.rpId ?? ""}）では使えません。回復コードを使ってください。`,
      );
    }
    const got = await this.passkey.authenticate(
      usable.map((s) => ({
        credentialId: fromB64u(s.credentialId) ?? new Uint8Array(),
        prfSalt: fromB64u(s.prfSalt) ?? new Uint8Array(),
      })),
    );
    const cid = b64u(got.credentialId);
    const w = await keyFromPrf(got.prf);
    for (const s of usable) {
      if (s.credentialId !== cid) continue;
      const wrapped = fromB64u(s.wrapped);
      const dk = wrapped ? await unwrapDk(w, wrapped) : null;
      if (dk) return dk;
    }
    return null;
  }

  private ctx(id: string, scope: string, k: Unlocked, onUnreadable?: (w: string) => void): EncContext {
    return { keys: k.keys, scope, workspaceId: id, ...(onUnreadable ? { onUnreadable } : {}) };
  }

  async wrapDir(
    dir: DirHandleLike,
    id: string,
    key: Unlocked,
    onUnreadable?: (w: string) => void,
  ): Promise<DirHandleLike> {
    return encryptedRoot(dir, this.ctx(id, "w", key, onUnreadable));
  }

  async wrapOpened(dir: DirHandleLike, id: string, onUnreadable?: (w: string) => void): Promise<DirHandleLike> {
    return encryptedRoot(dir, this.ctx(id, "w", this.need(id), onUnreadable));
  }

  async wrapBackup(dir: DirHandleLike, id: string): Promise<DirHandleLike> {
    return encryptedRoot(dir, this.ctx(id, "b", this.need(id)));
  }

  // -------------------------------------------------------------------------
  // 復旧ドラフト（39.1）

  /** ドラフトを暗号化する道具。鍵はロックまで保持する（ロック後は使えない） */
  draftSealer(id: string): Sealer {
    const k = this.need(id);
    const aad = new Uint8Array([...DRAFT_AAD, 0, ...te.encode(id)]);
    return {
      tag: async (v) => b64u((await hmac(k.keys.nameLong, te.encode(`draft\0${id}\0${v}`))).slice(0, 24)),
      seal: async (plain) => b64u(await aesEncrypt(k.keys.meta, te.encode(plain), aad)),
      open: async (sealed) => {
        const b = fromB64u(sealed);
        const p = b ? await aesDecrypt(k.keys.meta, b, aad) : null;
        if (!p) return null;
        try {
          return td.decode(p);
        } catch {
          return null;
        }
      },
    };
  }

  // -------------------------------------------------------------------------
  // GitHub のトークン（40.2）

  async sealToken(id: string, token: string): Promise<string> {
    return b64u(await aesEncrypt(this.need(id).keys.meta, te.encode(token), TOKEN_AAD));
  }

  async openToken(id: string, sealed: string): Promise<string | null> {
    const b = fromB64u(sealed);
    if (!b) return null;
    const p = await aesDecrypt(this.need(id).keys.meta, b, TOKEN_AAD);
    return p ? td.decode(p) : null;
  }

  // -------------------------------------------------------------------------
  // 暗号化した書き出し（38.3・39.4）

  /**
   * 暗号化して書き出す。DK はロック解除の鍵（loginId で開いている）で包み、その鍵を包んだ枠（回復コード・パスキー）と一緒にヘッダーに入れる。
   * 別の端末では、書き出した端末の回復コード（または同期したパスキー）で開ける。
   */
  async sealExport(id: string, zip: Uint8Array, loginId: string, loginSlots: readonly KeySlot[]): Promise<Uint8Array> {
    const k = this.need(id);
    const lk = this.need(loginId);
    const wrapped = b64u(await aesEncrypt(lk.keys.meta, k.dk, EXPORT_DK_AAD));
    const slots = loginSlots.filter((s) => s.kind !== "login");
    const header: SealedExportHeader = { v: 1, login: { slots, wrapped } };
    const h = te.encode(JSON.stringify(header));
    const body = await aesEncrypt(k.keys.exportKey, zip, h);
    const out = new Uint8Array(EXPORT_MAGIC.length + 4 + h.length + body.length);
    out.set(EXPORT_MAGIC, 0);
    new DataView(out.buffer).setUint32(EXPORT_MAGIC.length, h.length);
    out.set(h, EXPORT_MAGIC.length + 4);
    out.set(body, EXPORT_MAGIC.length + 4 + h.length);
    return out;
  }

  static isSealedExport(bytes: Uint8Array): boolean {
    if (bytes.length < EXPORT_MAGIC.length + 4) return false;
    for (let i = 0; i < EXPORT_MAGIC.length; i++) if (bytes[i] !== EXPORT_MAGIC[i]) return false;
    return true;
  }

  static readExportHeader(bytes: Uint8Array): { header: SealedExportHeader; raw: Uint8Array; body: Uint8Array } | null {
    if (!Vault.isSealedExport(bytes)) return null;
    const len = new DataView(bytes.buffer, bytes.byteOffset).getUint32(EXPORT_MAGIC.length);
    if (len > 64 * 1024 || EXPORT_MAGIC.length + 4 + len > bytes.length) return null;
    const raw = bytes.slice(EXPORT_MAGIC.length + 4, EXPORT_MAGIC.length + 4 + len);
    let v: unknown;
    try {
      v = JSON.parse(td.decode(raw));
    } catch {
      return null;
    }
    const r = v as { v?: unknown; login?: unknown };
    const l = r.login as { slots?: unknown; wrapped?: unknown } | null | undefined;
    // 枠の形式は meta と同じ規則で検査する（未信頼入力：38.2）
    if (r.v !== 1 || typeof l !== "object" || l === null) return null;
    if (!validKeyring({ v: 1, slots: l.slots })) return null;
    if (typeof l.wrapped !== "string" || !/^[A-Za-z0-9_-]{1,512}$/.test(l.wrapped)) return null;
    const body = bytes.slice(EXPORT_MAGIC.length + 4 + len);
    const header: SealedExportHeader = { v: 1, login: { slots: l.slots as KeySlot[], wrapped: l.wrapped } };
    return { header, raw, body };
  }

  /**
   * 暗号化した書き出しを開く。開けなければ null。
   * method が "login" なら、いまのロック解除の鍵（loginId で開いている）で開く（同じ鍵で書き出したもの）。
   * そうでなければ、ヘッダーの枠を回復コードかパスキーで開く（別の端末）。
   */
  async openSealedExport(
    bytes: Uint8Array,
    method: UnlockMethod | { readonly kind: "login"; readonly loginId: string },
  ): Promise<{ zip: Uint8Array; key: Unlocked } | null> {
    const r = Vault.readExportHeader(bytes);
    if (!r) return null;
    const { slots, wrapped } = r.header.login;
    const lk =
      method.kind === "login" ? (this.open.get(method.loginId) ?? null) : await this.unlockSlots(slots, method);
    const key = lk ? await this.unwrapExportDk(lk, wrapped) : null;
    if (!key) return null;
    const zip = await aesDecrypt(key.keys.exportKey, r.body, r.raw);
    return zip ? { zip, key } : null;
  }

  private async unwrapExportDk(login: Unlocked, wrapped: string): Promise<Unlocked | null> {
    const b = fromB64u(wrapped);
    const dk = b ? await aesDecrypt(login.keys.meta, b, EXPORT_DK_AAD) : null;
    return dk && dk.length === 32 ? { dk, keys: await deriveDataKeys(dk) } : null;
  }
}
