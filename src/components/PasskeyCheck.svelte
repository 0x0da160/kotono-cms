<script lang="ts">
  /**
   * パスキー（WebAuthn の PRF）の確認ページ。`?passkey-check` で開く。
   * パスキー管理アプリごとに、どの要求の形なら通るかを実機で確かめるためのもの。作業場所には触れない。
   */
  const host = location.hostname;
  const salt = crypto.getRandomValues(new Uint8Array(32));
  let credId = $state<Uint8Array<ArrayBuffer> | null>(null);
  let regPrf = $state<string | null>(null);
  let busy = $state(false);
  let lines = $state<string[]>([]);
  let copied = $state(false);

  function log(s: string) {
    lines = [...lines, `${new Date().toLocaleTimeString("ja-JP")} ${s}`];
  }

  function hex(b: ArrayBuffer | undefined): string | null {
    if (!b) return null;
    return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
  }

  function b64u(b: Uint8Array): string {
    let s = "";
    for (const x of b) s += String.fromCharCode(x);
    return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  }

  function err(e: unknown): string {
    return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }

  type PrfOut = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };

  async function env() {
    log(`配信元：${host}`);
    log(`ブラウザ：${navigator.userAgent}`);
    try {
      const pkc = PublicKeyCredential as unknown as {
        isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
        getClientCapabilities?: () => Promise<Record<string, boolean>>;
      };
      log(`端末の認証器：${String(await pkc.isUserVerifyingPlatformAuthenticatorAvailable?.())}`);
      const caps = await pkc.getClientCapabilities?.();
      log(`対応機能：${caps ? JSON.stringify(caps) : "（取得できない）"}`);
    } catch (e) {
      log(`対応機能を取得できません：${err(e)}`);
    }
  }
  void env();

  async function register() {
    busy = true;
    try {
      const cred = (await navigator.credentials.create({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rp: { id: host, name: "Kotono CMS" },
          user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "Kotono 確認用", displayName: "Kotono 確認用" },
          pubKeyCredParams: [
            { type: "public-key", alg: -7 },
            { type: "public-key", alg: -257 },
          ],
          authenticatorSelection: { residentKey: "required", userVerification: "required" },
          extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
        },
      })) as PublicKeyCredential | null;
      if (!cred) return log("登録：取り消し");
      credId = new Uint8Array(cred.rawId);
      const ext = cred.getClientExtensionResults() as PrfOut;
      regPrf = hex(ext.prf?.results?.first);
      const att = (cred as unknown as { authenticatorAttachment?: string }).authenticatorAttachment;
      log(
        `登録：成功 id=${b64u(credId).slice(0, 12)}… 接続=${att ?? "?"} prf.enabled=${String(ext.prf?.enabled)} 登録時のPRF=${regPrf ? "あり" : "なし"}`,
      );
    } catch (e) {
      log(`登録：失敗 ${err(e)}`);
    } finally {
      busy = false;
    }
  }

  type Variant = "none" | "eval" | "byCred" | "discover" | "preferred";
  const variants: { v: Variant; label: string }[] = [
    { v: "none", label: "A. 拡張なし" },
    { v: "eval", label: "B. PRF（eval）" },
    { v: "byCred", label: "C. PRF（evalByCredential）" },
    { v: "discover", label: "D. PRF（eval）・パスキーを指定しない" },
    { v: "preferred", label: "E. PRF（eval）・本人確認は可能なら" },
  ];

  async function get(v: Variant, label: string) {
    if (!credId && v !== "discover") return log(`${label}：先にテスト用パスキーを登録してください`);
    busy = true;
    try {
      let extensions: Record<string, unknown> | undefined;
      if (v === "eval" || v === "discover" || v === "preferred") extensions = { prf: { eval: { first: salt } } };
      if (v === "byCred" && credId) extensions = { prf: { evalByCredential: { [b64u(credId)]: { first: salt } } } };
      const cred = (await navigator.credentials.get({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rpId: host,
          userVerification: v === "preferred" ? "preferred" : "required",
          allowCredentials: v === "discover" || !credId ? [] : [{ type: "public-key", id: credId }],
          ...(extensions ? { extensions: extensions as AuthenticationExtensionsClientInputs } : {}),
        },
      })) as PublicKeyCredential | null;
      if (!cred) return log(`${label}：取り消し`);
      const out = hex((cred.getClientExtensionResults() as PrfOut).prf?.results?.first);
      const same = regPrf && out ? (regPrf === out ? "登録時と一致" : "登録時と不一致") : "";
      log(`${label}：成功 PRF=${out ? `あり ${same}` : "なし"} id=${b64u(new Uint8Array(cred.rawId)).slice(0, 12)}…`);
    } catch (e) {
      log(`${label}：失敗 ${err(e)}`);
    } finally {
      busy = false;
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      copied = true;
    } catch {
      copied = false;
    }
  }
</script>

<main class="check" data-testid="passkey-check">
  <h1>パスキーの確認</h1>
  <p class="small">
    パスキー管理アプリ（パスワードアプリ・1Password
    など）で、どの要求の形なら通るかを確かめます。作業場所には触れません。
  </p>
  <ol class="small">
    <li>「テスト用パスキーを登録」を押し、確かめたいアプリ（例：1Password）に保存します。</li>
    <li>A〜E を順に押し、同じアプリのパスキーで認証します。</li>
    <li>「結果をコピー」を押して、結果を送ってください。</li>
  </ol>
  <p class="small muted">
    テスト用パスキーは「Kotono 確認用」という名前で保存されます。確認が済んだら、アプリから削除してください。
  </p>
  <div class="buttons">
    <button type="button" class="primary" disabled={busy} onclick={register} data-testid="pkc-register"
      >テスト用パスキーを登録</button
    >
    {#each variants as x (x.v)}
      <button type="button" disabled={busy} onclick={() => get(x.v, x.label)}>{x.label}</button>
    {/each}
    <button type="button" disabled={lines.length === 0} onclick={copy}
      >{copied ? "コピーしました" : "結果をコピー"}</button
    >
  </div>
  <pre class="log" data-testid="pkc-log">{lines.join("\n")}</pre>
  <p class="small"><a href="./">CMS に戻る</a></p>
</main>

<style>
  .check {
    max-width: 40rem;
    margin: 0 auto;
    padding: 1rem;
  }
  h1 {
    font-size: 1.25rem;
  }
  .buttons {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.5rem;
    margin-block: 1rem;
  }
  .log {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 0.8125rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.5rem;
    min-height: 6rem;
  }
  .small {
    font-size: 0.875rem;
  }
  .muted {
    color: var(--muted);
  }
</style>
