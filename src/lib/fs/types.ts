/**
 * File System Access API のうち CMS が使う最小の形（仕様 29.1・31）。
 * 実ブラウザのハンドルはこの形を構造的に満たす。単体試験では失敗注入できる
 * メモリ上の実装を使う。
 */

export interface BlobLike {
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface FileLike extends BlobLike {
  readonly lastModified: number;
  slice(start?: number, end?: number): BlobLike;
}

export interface WritableLike {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

export type PermissionMode = { mode: "read" | "readwrite" };
export type PermissionStateLike = "granted" | "denied" | "prompt";

export interface FileHandleLike {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<FileLike>;
  createWritable(options?: { keepExistingData?: boolean; mode?: "exclusive" | "siloed" }): Promise<WritableLike>;
}

export interface DirHandleLike {
  readonly kind: "directory";
  readonly name: string;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirHandleLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
  values(): AsyncIterable<FileHandleLike | DirHandleLike>;
  queryPermission?(descriptor: PermissionMode): Promise<PermissionStateLike>;
  requestPermission?(descriptor: PermissionMode): Promise<PermissionStateLike>;
}

/** DOMException 等の名前から、表示に使う失敗の種類を区別する（13.3） */
export type FsErrorKind =
  | "not-found"
  | "type-mismatch"
  | "permission"
  | "locked"
  | "quota"
  | "invalid-state"
  | "not-readable"
  | "security"
  | "aborted"
  | "unknown";

export function classifyFsError(e: unknown): FsErrorKind {
  const name = typeof e === "object" && e !== null && "name" in e ? String((e as { name: unknown }).name) : "";
  switch (name) {
    case "NotFoundError":
      return "not-found";
    case "TypeMismatchError":
      return "type-mismatch";
    case "NotAllowedError":
      return "permission";
    case "NoModificationAllowedError":
      return "locked";
    case "QuotaExceededError":
      return "quota";
    case "InvalidStateError":
      return "invalid-state";
    case "NotReadableError":
      return "not-readable";
    case "SecurityError":
      return "security";
    case "AbortError":
      return "aborted";
    default:
      return "unknown";
  }
}

export function fsErrorMessage(kind: FsErrorKind): string {
  switch (kind) {
    case "not-found":
      return "ファイルまたはフォルダが見つかりません。";
    case "type-mismatch":
      return "期待した種類と違うエントリー（ファイルとフォルダの取り違え）があります。";
    case "permission":
      return "権限がありません。フォルダへのアクセスを許可し直してください。";
    case "locked":
      return "別の処理がファイルを使用中のため書き込めません。";
    case "quota":
      return "空き容量が不足しています。";
    case "invalid-state":
      return "ファイルの状態が変わったため操作できません。再読み込みしてください。";
    case "not-readable":
      return "ファイルを読み取れません。";
    case "security":
      return "ブラウザのセキュリティ制限によりアクセスできません。";
    case "aborted":
      return "操作が中断されました。";
    case "unknown":
      return "不明なエラーが発生しました。";
  }
}
