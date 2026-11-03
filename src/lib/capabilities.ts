/**
 * 起動時の能力検査（仕様 2.1・2.2）。
 *
 * ここでの判定は「APIが存在するか」の確認だけであり、実機試験（技術成立性ゲート
 * TG01〜TG12）の代替ではない。非対応環境では理由を表示して編集を開始しない。
 */

export type CapabilityId =
  "secure-context" | "directory-picker" | "writable-stream" | "worker" | "web-crypto" | "indexed-db" | "strict-utf8";

export interface CapabilityResult {
  readonly id: CapabilityId;
  readonly label: string;
  readonly ok: boolean;
  /** 対応しない場合に何ができなくなるか */
  readonly impact: string;
}

/** 検査に使うグローバルの最小形。テストでは任意のオブジェクトを渡せる。 */
export type CapabilityHost = Record<string, unknown>;

function has(host: CapabilityHost, key: string): boolean {
  return typeof host[key] === "function";
}

function hasProtoMethod(host: CapabilityHost, ctor: string, method: string): boolean {
  const c = host[ctor];
  if (typeof c !== "function") return false;
  const proto = (c as { prototype?: Record<string, unknown> }).prototype;
  return typeof proto?.[method] === "function";
}

function hasStrictTextDecoder(host: CapabilityHost): boolean {
  const Ctor = host["TextDecoder"];
  if (typeof Ctor !== "function") return false;
  try {
    const decoder = new (Ctor as typeof TextDecoder)("utf-8", { fatal: true });
    // 不正な UTF-8 を黙って置換しないこと（仕様 9.1）
    decoder.decode(new Uint8Array([0xff]));
    return false;
  } catch {
    return true;
  }
}

function hasSubtleCrypto(host: CapabilityHost): boolean {
  const c = host["crypto"] as { getRandomValues?: unknown; subtle?: { digest?: unknown } } | undefined;
  return typeof c?.getRandomValues === "function" && typeof c.subtle?.digest === "function";
}

export function detectCapabilities(host: CapabilityHost): CapabilityResult[] {
  return [
    {
      id: "secure-context",
      label: "安全なコンテキスト（file:// 起動を含む）",
      ok: host["isSecureContext"] === true,
      impact: "フォルダアクセス等の権限APIを利用できません。",
    },
    {
      id: "directory-picker",
      label: "フォルダ選択（showDirectoryPicker）",
      ok: has(host, "showDirectoryPicker"),
      impact: "作業フォルダを選択できないため、編集を開始できません。",
    },
    {
      id: "writable-stream",
      label: "ファイル書き込み（createWritable）",
      ok: hasProtoMethod(host, "FileSystemFileHandle", "createWritable"),
      impact: "記事を保存できません。",
    },
    {
      id: "worker",
      label: "隔離処理（Web Worker）",
      ok: has(host, "Worker") && has(host, "Blob") && hasProtoMethod(host, "URL", "toString"),
      impact: "解析を終了可能な隔離処理で実行できません。",
    },
    {
      id: "web-crypto",
      label: "安全な乱数と暗号学的ハッシュ（Web Crypto）",
      ok: hasSubtleCrypto(host),
      impact: "記事IDの生成と内容の照合ができません。",
    },
    {
      id: "indexed-db",
      label: "ブラウザ内ストレージ（IndexedDB）",
      ok: typeof host["indexedDB"] === "object" && host["indexedDB"] !== null,
      impact: "ブラウザ内復旧ドラフトを利用できません。",
    },
    {
      id: "strict-utf8",
      label: "厳密な UTF-8 デコード",
      ok: hasStrictTextDecoder(host),
      impact: "不正な UTF-8 を検出できません。",
    },
  ];
}

export function isSupported(results: readonly CapabilityResult[]): boolean {
  return results.every((r) => r.ok);
}
