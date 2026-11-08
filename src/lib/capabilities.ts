/**
 * 起動時の能力検査（仕様 2.1・2.2）。
 *
 * ここでの判定は「APIが存在するか」の確認だけであり、実機試験（技術成立性ゲート
 * TG01〜TG12）の代替ではない。非対応環境では理由を表示して編集を開始しない。
 */

export type CapabilityId =
  | "secure-context"
  | "directory-picker"
  | "opfs"
  | "writable-stream"
  | "worker"
  | "web-crypto"
  | "indexed-db"
  | "strict-utf8";

/**
 * 保存先の系統（仕様 3.2 第2.1節）。folder：実フォルダ（デスクトップの Chrome・Edge）。
 * workspace：ブラウザ内の作業場所（iOS・iPadOS の Safari、第38章）。
 */
export type StorageMode = "folder" | "workspace";

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

function hasOpfs(host: CapabilityHost): boolean {
  const nav = host["navigator"] as { storage?: { getDirectory?: unknown } } | undefined;
  return typeof nav?.storage?.getDirectory === "function";
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
      id: "opfs",
      label: "ブラウザ内の作業場所（Origin Private File System）",
      ok: hasOpfs(host),
      impact: "フォルダ選択が使えない環境（iPhone・iPad）で、ブラウザ内に作業場所を作れません。",
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
      impact: "解析を、途中で止められる隔離処理で実行できません。",
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

/** 保存先の系統ごとに必要な能力。共通の能力はどちらにも要る */
const MODE_ONLY: Record<StorageMode, CapabilityId> = { folder: "directory-picker", workspace: "opfs" };

/** 使える保存先の系統。実フォルダを優先する。どちらも使えなければ null */
export function supportedMode(
  results: readonly CapabilityResult[],
  prefer: StorageMode | null = null,
): StorageMode | null {
  const ok = (id: CapabilityId) => results.find((r) => r.id === id)?.ok === true;
  const common = results.every((r) => r.id === "directory-picker" || r.id === "opfs" || r.ok);
  if (!common) return null;
  const modes = (["folder", "workspace"] as const).filter((m) => ok(MODE_ONLY[m]));
  if (prefer && modes.includes(prefer)) return prefer;
  return modes[0] ?? null;
}

/** その系統で使わない能力（表示で「この環境では不要」とする） */
export function unusedIn(mode: StorageMode | null, id: CapabilityId): boolean {
  if (mode === "folder") return id === "opfs";
  if (mode === "workspace") return id === "directory-picker";
  return false;
}

export function isSupported(results: readonly CapabilityResult[]): boolean {
  return supportedMode(results) !== null;
}
