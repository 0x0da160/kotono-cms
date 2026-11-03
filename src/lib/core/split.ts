/**
 * 文書形式（仕様 9.1）：frontmatter の区切り探索。YAML 解析より先に行う。
 *
 * - 先頭の独立行 `---` で開始し、その後最初の独立行 `---` で終了する。
 * - 独立行は内容がちょうど `---` の行。行終端は LF または CRLF。前後空白は不可。
 * - インデントされた `  ---` は区切りではない。非インデントの `---` は常に終端。
 * - `...` は閉じ区切りとして採用しない。閉じ区切りより後はすべて本文。
 * - 上限内に閉じ区切りがない場合、全文を探索せずエラーとする。
 *
 * 入力は BOM を取り除いた文字列。
 */
import { FRONTMATTER_MAX_BYTES } from "./budgets";
import { utf8ByteLength } from "./bytes";

export interface SplitOk {
  readonly ok: true;
  /** 開始区切り行の直後から閉じ区切り行の直前まで（YAML 本体） */
  readonly frontmatter: string;
  /** frontmatter の開始オフセット（文字） */
  readonly fmStart: number;
  /** 本文の開始オフセット（閉じ区切り行の行終端の直後） */
  readonly bodyStart: number;
  readonly body: string;
  /** frontmatter の UTF-8 バイト数 */
  readonly frontmatterBytes: number;
}

export type SplitErrorCode = "no-frontmatter" | "unclosed" | "frontmatter-too-large";

export interface SplitError {
  readonly ok: false;
  readonly code: SplitErrorCode;
}

export type SplitResult = SplitOk | SplitError;

export function splitDocument(text: string, maxBytes = FRONTMATTER_MAX_BYTES): SplitResult {
  let fmStart: number;
  if (text.startsWith("---\n")) fmStart = 4;
  else if (text.startsWith("---\r\n")) fmStart = 5;
  else return { ok: false, code: "no-frontmatter" };

  let pos = fmStart;
  for (;;) {
    // 文字数はバイト数以下なので、文字位置が上限を超えたら閉じ区切りは上限外にある
    if (pos - fmStart > maxBytes) return { ok: false, code: "frontmatter-too-large" };
    const nl = text.indexOf("\n", pos);
    const lineEnd = nl === -1 ? text.length : nl;
    let content = text.slice(pos, lineEnd);
    if (nl !== -1 && content.endsWith("\r")) content = content.slice(0, -1);
    if (content === "---") {
      const frontmatter = text.slice(fmStart, pos);
      const frontmatterBytes = utf8ByteLength(frontmatter);
      if (frontmatterBytes > maxBytes) return { ok: false, code: "frontmatter-too-large" };
      const bodyStart = nl === -1 ? text.length : nl + 1;
      return { ok: true, frontmatter, fmStart, bodyStart, body: text.slice(bodyStart), frontmatterBytes };
    }
    if (nl === -1) return { ok: false, code: "unclosed" };
    pos = nl + 1;
  }
}

export function splitErrorMessage(code: SplitErrorCode): string {
  switch (code) {
    case "no-frontmatter":
      return "frontmatter がありません。1行目を `---` だけの行にしてください。";
    case "unclosed":
      return "frontmatter の閉じ区切り `---` が見つかりません。";
    case "frontmatter-too-large":
      return "frontmatter が上限（1 MiB）を超えているか、上限内に閉じ区切りがありません。";
  }
}
