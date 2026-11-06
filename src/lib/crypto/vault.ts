/**
 * 作業場所の鍵の管理と解錠（仕様 3.2 第39章、ADR-0006 第7章）。
 *
 * - データ鍵（DK）は解錠中だけメモリに置く。ロックで捨てる。
 * - DK は回復コード（必須）・パスフレーズ（任意）・パスキーの PRF（任意）でそれぞれ包んで meta に置く。
 * - 暗号化した書き出し（`.kotono`）は、包んだ DK（回復コード・パスフレーズ・パスキーの枠）と、
 *   DK から作った書き出し用の鍵で暗号化した zip からなる。別の端末では回復コード等で開ける。
 */
import type { DirHandleLike } from "../fs/types";
import { validKeyring, type KeyringRecord, type KeySlot } from "../workspaces/store";
import type { Sealer } from "../drafts/sealed";
import { encryptedRoot, type EncContext } from "./encfs";
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
import type { PasskeyApi } from "./passkey";

const te = new TextEncoder();
const td = new TextDecoder("utf-8", { fatal: true });
const NAME_AAD = te.encode("kotono-cms/meta/name");
const TOKEN_AAD = te.encode("kotono-cms/meta/token");
const DRAFT_AAD = te.encode("kotono-cms/draft");
const EXPORT_MAGIC = te.encode("KOTONO-EXPORT/1\n");
export const PASSPHRASE_MIN = 10;

export interface Unlocked {
  readonly dk: Uint8Array;
  readonly keys: DataKeys;
}

export type UnlockMethod =
  | { readonly kind: "recovery"; readonly code: string }
  | { readonly kind: "passphrase"; readonly passphrase: string }
  | { readonly kind: "passkey" };

export interface NewKeyring {
  readonly record: KeyringRecord;
  readonly key: Unlocked;
  /** 作成時に一度だけ表示する（保存しない：39.2） */
  readonly recoveryCode: string;
}

export interface SealedExportHeader {
  readonly v: 1;
  readonly slots: readonly KeySlot[];
}

export class Vault {
  private readonly open = new Map<string, Unlocked>();
  /** 作成直後に表示する回復コード（ID → コード） */
  lastRecovery: { id: string | null; code: string } | null = null;

  constructor(
    readonly passkey: PasskeyApi | null = null,
    private readonly iterations: number = PBKDF2_ITERATIONS,
  ) {}

  isUnlocked(id: string): boolean {
    return this.open.has(id);
  }

  adopt(id: string, key: Unlocked): void {
    this.open.set(id, key);
    if (this.lastRecovery && this.lastRecovery.id === null) this.lastRecovery = { ...this.lastRecovery, id };
  }

  lock(id: string): void {
    this.open.delete(id);
  }

  lockAll(): void {
    this.open.clear();
  }

  forget(id: string): void {
    this.open.delete(id);
  }

  private ctx(id: string, scope: string, k: Unlocked, onUnreadable?: (w: string) => void): EncContext {
    return { keys: k.keys, scope, workspaceId: id, ...(onUnreadable ? { onUnreadable } : {}) };
  }

  private need(id: string): Unlocked {
    const k = this.open.get(id);
    if (!k) throw new Error("この作業場所はロックされています。");
    return k;
  }

  /** 新しい DK と回復コードの枠を作る */
  async prepareNew(name: string): Promise<NewKeyring> {
    const dk = randomBytes(32);
    const keys = await deriveDataKeys(dk);
    const code = newRecoveryCode();
    const slot = await this.secretSlot("recovery", normalizeRecoveryCode(code) ?? "", dk);
    const encName = await aesEncrypt(keys.meta, te.encode(name.trim()), NAME_AAD);
    this.lastRecovery = { id: null, code };
    return { record: { v: 1, slots: [slot], name: b64u(encName) }, key: { dk, keys }, recoveryCode: code };
  }

  /** 取り込んだ暗号化書き出しの DK と枠をそのまま使う（名前だけ付け直す） */
  async keyringFor(name: string, key: Unlocked, slots: readonly KeySlot[]): Promise<KeyringRecord> {
    const encName = await aesEncrypt(key.keys.meta, te.encode(name.trim()), NAME_AAD);
    return { v: 1, slots: [...slots], name: b64u(encName) };
  }

  private async secretSlot(kind: "recovery" | "passphrase", secret: string, dk: Uint8Array): Promise<KeySlot> {
    const salt = randomBytes(16);
    const w = await keyFromSecret(secret, salt, this.iterations);
    return { kind, salt: b64u(salt), iterations: this.iterations, wrapped: b64u(await wrapDk(w, dk)) };
  }

  /** パスフレーズの枠を作る（既存のパスフレーズの枠は置き換える） */
  async withPassphrase(id: string, record: KeyringRecord, passphrase: string): Promise<KeyringRecord> {
    if (passphrase.normalize("NFKC").length < PASSPHRASE_MIN)
      throw new Error(`パスフレーズは ${PASSPHRASE_MIN} 文字以上にしてください。`);
    const k = this.need(id);
    const slot = await this.secretSlot("passphrase", passphrase, k.dk);
    return { ...record, slots: [...record.slots.filter((s) => s.kind !== "passphrase"), slot] };
  }

  /** パスキーを登録し、PRF の出力で DK を包んだ枠を加える */
  async withPasskey(id: string, record: KeyringRecord, label: string): Promise<KeyringRecord> {
    if (!this.passkey) throw new Error("この環境ではパスキーを使えません。");
    const k = this.need(id);
    const prfSalt = randomBytes(32);
    const cred = await this.passkey.register(label, prfSalt);
    const w = await keyFromPrf(cred.prf);
    const slot: KeySlot = {
      kind: "passkey",
      credentialId: b64u(cred.credentialId),
      prfSalt: b64u(prfSalt),
      wrapped: b64u(await wrapDk(w, k.dk)),
    };
    return { ...record, slots: [...record.slots, slot] };
  }

  /** 枠のいずれかで DK を開く。開けなければ null */
  async unlockSlots(slots: readonly KeySlot[], method: UnlockMethod): Promise<Unlocked | null> {
    let dk: Uint8Array | null = null;
    if (method.kind === "passkey") {
      if (!this.passkey) throw new Error("この環境ではパスキーを使えません。");
      const pk = slots.filter((s): s is Extract<KeySlot, { kind: "passkey" }> => s.kind === "passkey");
      if (pk.length === 0) throw new Error("この作業場所にはパスキーが登録されていません。");
      const got = await this.passkey.authenticate(
        pk.map((s) => ({
          credentialId: fromB64u(s.credentialId) ?? new Uint8Array(),
          prfSalt: fromB64u(s.prfSalt) ?? new Uint8Array(),
        })),
      );
      const slot = pk.find((s) => s.credentialId === b64u(got.credentialId));
      const wrapped = slot ? fromB64u(slot.wrapped) : null;
      if (wrapped) dk = await unwrapDk(await keyFromPrf(got.prf), wrapped);
    } else {
      const secret = method.kind === "recovery" ? normalizeRecoveryCode(method.code) : method.passphrase;
      if (secret === null || secret === "") return null;
      for (const s of slots) {
        if (s.kind !== method.kind) continue;
        const salt = fromB64u(s.salt);
        const wrapped = fromB64u(s.wrapped);
        if (!salt || !wrapped) continue;
        dk = await unwrapDk(await keyFromSecret(secret, salt, s.iterations), wrapped);
        if (dk) break;
      }
    }
    return dk ? { dk, keys: await deriveDataKeys(dk) } : null;
  }

  /** 解錠する。表示名を返す。開けなければ null */
  async unlock(id: string, record: KeyringRecord, method: UnlockMethod): Promise<string | null> {
    const k = await this.unlockSlots(record.slots, method);
    if (!k) return null;
    const name = await this.decryptName(k, record);
    if (name === null) return null;
    this.open.set(id, k);
    return name;
  }

  private async decryptName(k: Unlocked, record: KeyringRecord): Promise<string | null> {
    const sealed = fromB64u(record.name);
    if (!sealed) return null;
    const p = await aesDecrypt(k.keys.meta, sealed, NAME_AAD);
    if (!p) return null;
    try {
      return td.decode(p);
    } catch {
      return null;
    }
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

  async sealExport(id: string, zip: Uint8Array, slots: readonly KeySlot[]): Promise<Uint8Array> {
    const k = this.need(id);
    const header: SealedExportHeader = { v: 1, slots };
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
    const r = v as { v?: unknown; slots?: unknown };
    // 枠の形式は meta と同じ規則で検査する（未信頼入力：38.2）
    if (r.v !== 1 || !validKeyring({ v: 1, name: "", slots: r.slots })) return null;
    return { header: { v: 1, slots: r.slots as KeySlot[] }, raw, body: bytes.slice(EXPORT_MAGIC.length + 4 + len) };
  }

  /** 暗号化した書き出しを開く。開けなければ null */
  async openSealedExport(
    bytes: Uint8Array,
    method: UnlockMethod,
  ): Promise<{ zip: Uint8Array; key: Unlocked; slots: readonly KeySlot[] } | null> {
    const r = Vault.readExportHeader(bytes);
    if (!r) return null;
    const key = await this.unlockSlots(r.header.slots, method);
    if (!key) return null;
    const zip = await aesDecrypt(key.keys.exportKey, r.body, r.raw);
    return zip ? { zip, key, slots: r.header.slots } : null;
  }
}
