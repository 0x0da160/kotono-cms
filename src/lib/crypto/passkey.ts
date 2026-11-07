/**
 * パスキー（WebAuthn）の PRF 拡張で、端末内の鍵を開くための 32 バイトを得る（仕様 3.2 第39.2節）。
 *
 * - サーバーへのログインではない。チャレンジは端末内で作り、署名は検証しない（使うのは PRF の出力だけ）。
 * - RP ID は配信元のホスト名。配信元を移すと使えなくなるので、登録し直す（39.2）。
 * - PRF の対応は iOS 18.4 以降で安定とされる。端末間で同じ出力になるかは TG14 で確かめる。
 */
import { randomBytes } from "./keys";

export interface PasskeyApi {
  /** 配信元のホスト名（RP ID）。分からなければ undefined */
  readonly rpId?: string;
  /** 登録し、PRF の出力を得る（登録時に出力が返らなければ、続けて認証して得る） */
  register(label: string, prfSalt: Uint8Array): Promise<{ credentialId: Uint8Array; prf: Uint8Array }>;
  /** 登録済みのいずれかで認証し、そのパスキーの PRF の出力を得る */
  authenticate(
    allowed: readonly { credentialId: Uint8Array; prfSalt: Uint8Array }[],
  ): Promise<{ credentialId: Uint8Array; prf: Uint8Array }>;
}

interface PrfResults {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
}

type CredentialsHost = {
  navigator?: { credentials?: CredentialsContainer };
  location?: { hostname?: string };
  PublicKeyCredential?: unknown;
};

export function browserPasskey(host: CredentialsHost): PasskeyApi | null {
  const creds = host.navigator?.credentials;
  const rpId = host.location?.hostname;
  if (!creds || typeof host.PublicKeyCredential !== "function" || !rpId) return null;
  // file:// ではホスト名がなく、パスキーを使えない
  if (rpId === "") return null;

  const authenticate: PasskeyApi["authenticate"] = async (allowed) => {
    if (allowed.length === 0) throw new Error("登録済みのパスキーがありません。");
    const prfIn = prfInputs(allowed);
    const cred = (await call(
      () =>
        creds.get({
          publicKey: {
            challenge: randomBytes(32),
            rpId,
            userVerification: "required",
            allowCredentials: allowed.map((a) => ({
              type: "public-key",
              id: a.credentialId as Uint8Array<ArrayBuffer>,
            })),
            extensions: { prf: prfIn } as AuthenticationExtensionsClientInputs,
          },
        }),
      NOT_ALLOWED_GET,
    )) as PublicKeyCredential | null;
    if (!cred) throw new Error("パスキーでの認証が取り消されました。");
    const prf = (cred.getClientExtensionResults() as PrfResults).prf?.results?.first;
    if (!prf)
      throw new Error("このパスキーは鍵の導出（PRF）に対応していません。回復コードかパスフレーズで開いてください。");
    return { credentialId: new Uint8Array(cred.rawId), prf: new Uint8Array(prf) };
  };

  return {
    rpId,
    async register(rawLabel, prfSalt) {
      const label = asciiLabel(rawLabel);
      const cred = (await call(
        () =>
          creds.create({
            publicKey: {
              challenge: randomBytes(32),
              rp: { id: rpId, name: "Kotono CMS" },
              user: { id: randomBytes(16), name: label, displayName: label },
              pubKeyCredParams: [
                { type: "public-key", alg: -7 },
                { type: "public-key", alg: -257 },
              ],
              authenticatorSelection: { residentKey: "required", userVerification: "required" },
              extensions: {
                prf: { eval: { first: prfSalt as Uint8Array<ArrayBuffer> } },
              } as AuthenticationExtensionsClientInputs,
            },
          }),
        NOT_ALLOWED_CREATE,
      )) as PublicKeyCredential | null;
      if (!cred) throw new Error("パスキーの登録が取り消されました。");
      const id = new Uint8Array(cred.rawId);
      const ext = cred.getClientExtensionResults() as PrfResults;
      const first = ext.prf?.results?.first;
      if (first) return { credentialId: id, prf: new Uint8Array(first) };
      if (ext.prf?.enabled === false) throw new Error("このパスキーは鍵の導出（PRF）に対応していません。");
      // 登録時に出力を返さない実装（Safari など）では、続けて認証して得る
      return authenticate([{ credentialId: id, prfSalt }]);
    },
    authenticate,
  };
}

const NOT_ALLOWED_GET =
  "取り消されたか、この端末・ブラウザで使えるパスキーが見つかりませんでした（別の端末・ブラウザ・配信元で登録した場合など）。回復コードで開けます（パスワードとして保存していれば自動入力できます）。";
const NOT_ALLOWED_CREATE =
  "パスキーを登録できませんでした。取り消したか、ブラウザが許可しませんでした。もう一度「パスキーを登録」を押してください。";

/**
 * WebAuthn の NotAllowedError（取り消し・該当なし・許可なし。ブラウザは理由を区別して返さない）を、
 * 次にできることが分かる日本語に置き換える。
 */
async function call<T>(f: () => Promise<T>, notAllowed: string): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof Error && e.name === "NotAllowedError") throw new Error(notAllowed, { cause: e });
    throw e;
  }
}

/**
 * PRF の入力。塩がすべて同じなら `eval` だけで渡す（`evalByCredential` に対応しないパスキー管理アプリがあるため。
 * iOS の 1Password で失敗した件）。塩が違う枠が混ざるときは、どれが選ばれても正しい塩になるよう `evalByCredential` で渡す。
 */
export function prfInputs(
  allowed: readonly { credentialId: Uint8Array; prfSalt: Uint8Array }[],
):
  | { eval: { first: Uint8Array<ArrayBuffer> } }
  | { evalByCredential: Record<string, { first: Uint8Array<ArrayBuffer> }> } {
  const [head] = allowed;
  if (head && allowed.every((a) => sameBytes(a.prfSalt, head.prfSalt)))
    return { eval: { first: head.prfSalt as Uint8Array<ArrayBuffer> } };
  const evalByCredential: Record<string, { first: Uint8Array<ArrayBuffer> }> = {};
  for (const a of allowed) evalByCredential[b64(a.credentialId)] = { first: a.prfSalt as Uint8Array<ArrayBuffer> };
  return { evalByCredential };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * パスキーと回復コードの保存名（ユーザー名）。ロック中でも分かる作業場所 ID から作る英字の名前。
 * 日本語の名前で登録したパスキーは、iOS の 1Password が認証を拒否する（確認ページで確かめた）。
 */
export function accountName(workspaceId: string): string {
  return `kotono-${workspaceId.slice(0, 8)}`;
}

/** パスキーに渡す名前を、印字できる ASCII だけにする（それ以外は除く。空なら "kotono"） */
export function asciiLabel(label: string): string {
  const s = label
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);
  return s === "" ? "kotono" : s;
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
