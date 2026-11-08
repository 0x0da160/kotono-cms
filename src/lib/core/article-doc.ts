/**
 * 記事文書（index.md）の解析・変更判定・フォーム編集・保存候補（仕様 8・9・13・14・24）。
 *
 * 編集中の正本文書は「LF に統一し BOM を除いた全文の文字列」1つだけとし、
 * フォーム・原文・本文はすべてこの文字列を編集する（14：単一の正本文書）。
 */
import { ARTICLE_MAX_BYTES } from "./budgets";
import { decodeUtf8Strict, toLf, utf8ByteLength } from "./bytes";
import { isValidArticleId } from "./article-id";
import { sameInstant } from "./datetime";
import { STANDARD_KEYS, validateStandard, type FieldError, type SchemaResult, type StandardKey } from "./schema";
import { splitDocument, splitErrorMessage, type SplitResult } from "./split";
import {
  getValueNode,
  nodesEqual,
  parseFrontmatter,
  setTopLevelValue,
  topLevelKeys,
  UnsupportedComparison,
  type FieldValue,
  type FrontmatterParse,
  type ParsedFrontmatter,
} from "./yaml-doc";
import { isScalar } from "yaml";

export interface Problem {
  readonly message: string;
  readonly field?: StandardKey;
  /** 文書全体での 1 始まりの行・列 */
  readonly line?: number;
  readonly col?: number;
  readonly code?: FieldError["code"] | "split" | "yaml" | "unsupported" | "budget" | "size";
}

export interface Analysis {
  readonly text: string;
  readonly split: SplitResult;
  readonly parse: FrontmatterParse | null;
  readonly schema: SchemaResult | null;
  /** 保存を止める問題（空なら記事として正常） */
  readonly problems: Problem[];
  /** 開いた時点で読み取り専用とすべき理由（非対応YAML・上限超過・ID不正等） */
  readonly readOnlyReason: string | null;
}

/** 閉じた frontmatter の解析結果をキャッシュする（本文だけの入力で再解析しない） */
let cacheKey: string | null = null;
let cacheValue: FrontmatterParse | null = null;
function parseCached(fm: string): FrontmatterParse {
  if (cacheKey !== fm || cacheValue === null) {
    cacheValue = parseFrontmatter(fm);
    cacheKey = fm;
  }
  return cacheValue;
}

export function analyzeText(text: string, folderId: string | null): Analysis {
  const problems: Problem[] = [];
  let readOnlyReason: string | null = null;
  const split = splitDocument(text);
  if (!split.ok) {
    problems.push({ message: splitErrorMessage(split.code), code: "split", line: 1 });
    if (split.code === "frontmatter-too-large") readOnlyReason = splitErrorMessage(split.code);
    return { text, split, parse: null, schema: null, problems, readOnlyReason };
  }
  const parse = parseCached(split.frontmatter);
  if (!parse.ok) {
    for (const p of parse.problems) {
      problems.push({
        message: p.message,
        code: p.kind === "unsupported" ? "unsupported" : p.kind === "budget" ? "budget" : "yaml",
        ...(p.line !== undefined ? { line: p.line + 1 } : {}),
        ...(p.col !== undefined ? { col: p.col } : {}),
      });
      if (p.kind === "unsupported" || p.kind === "budget") {
        readOnlyReason ??= `YAML の構文が非対応か上限を超えているため、編集・保存できません：${p.message}`;
      }
    }
    return { text, split, parse, schema: null, problems, readOnlyReason };
  }
  const schema = validateStandard(parse.root, folderId);
  for (const e of schema.errors) {
    const node = getValueNode(parse.root, e.field);
    const line = node?.range ? lineOf(split.frontmatter, node.range[0]) + 1 : undefined;
    problems.push({ message: e.message, field: e.field, code: e.code, ...(line !== undefined ? { line } : {}) });
    if (e.code === "id-format")
      readOnlyReason ??= "id の文字種・長さが不正なため、閲覧・コピーのみ可能です。外部ツールで修正してください。";
  }
  return { text, split, parse, schema, problems, readOnlyReason };
}

function lineOf(s: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < s.length; i++) if (s.charCodeAt(i) === 10) line++;
  return line;
}

// ---------------------------------------------------------------------------
// ディスク上のバイト列から編集用の正本文書へ

export type LoadedText = { ok: true; text: string; bom: boolean; crlf: boolean } | { ok: false; reason: string };

export function textFromBytes(bytes: Uint8Array): LoadedText {
  if (bytes.length > ARTICLE_MAX_BYTES) {
    return {
      ok: false,
      reason: "記事ファイルが 5 MiB を超えているため、CMS では編集できません。外部エディタで編集してください。",
    };
  }
  const d = decodeUtf8Strict(bytes);
  if (!d.ok) {
    return {
      ok: false,
      reason: "不正な UTF-8 を含むため読み取り専用です。元ファイルを退避し、外部エディタで修正してください。",
    };
  }
  const lf = toLf(d.text);
  if (lf.includes("\r")) {
    // 単独の CR は行終端ではないが、テキスト入力欄では保持できず黙って変換されるため編集しない
    return {
      ok: false,
      reason: "単独の CR（\\r）を含むため、CMS の編集欄では内容を保持できません。外部エディタで修正してください。",
    };
  }
  return { ok: true, text: lf, bom: d.bom, crlf: lf !== d.text };
}

// ---------------------------------------------------------------------------
// 変更判定（8.2・8.3）

export interface ChangeInfo {
  /** 正本文書が基準と異なる（未保存判定） */
  readonly textChanged: boolean;
  /** 本文・id 以外の標準値・未知フィールドの値や構造が変わった（updatedAt 更新判定） */
  readonly contentChanged: boolean;
  /** ユーザーが updatedAt の時刻を変えた */
  readonly updatedAtEdited: boolean;
  /** ユーザーが createdAt の時刻を変えた */
  readonly createdAtEdited: boolean;
  /** 意味的比較ができない表現がある */
  readonly incomparable: boolean;
}

function scalarString(p: ParsedFrontmatter, key: string): string | undefined {
  const n = getValueNode(p.root, key);
  return isScalar(n) && typeof n.value === "string" ? n.value : undefined;
}

function sameDateField(a: ParsedFrontmatter, b: ParsedFrontmatter, key: string): boolean {
  const va = scalarString(a, key);
  const vb = scalarString(b, key);
  if (va !== undefined && vb !== undefined && sameInstant(va, vb)) return true;
  return nodesEqual(getValueNode(a.root, key), getValueNode(b.root, key));
}

export function classifyChange(base: Analysis, cur: Analysis): ChangeInfo {
  const textChanged = base.text !== cur.text;
  const none = {
    textChanged,
    contentChanged: textChanged,
    updatedAtEdited: false,
    createdAtEdited: false,
    incomparable: false,
  };
  if (!textChanged) return { ...none, contentChanged: false };
  if (!base.split.ok || !cur.split.ok || !base.parse?.ok || !cur.parse?.ok) return none;
  const bp = base.parse;
  const cp = cur.parse;
  try {
    const bodyChanged = base.split.body !== cur.split.body;
    const keys = new Set([...topLevelKeys(bp.root), ...topLevelKeys(cp.root)]);
    let fieldsChanged = false;
    for (const k of keys) {
      if (k === "id" || k === "updatedAt") continue;
      const same =
        k === "createdAt" || k === "publishedAt"
          ? sameDateField(bp, cp, k)
          : nodesEqual(getValueNode(bp.root, k), getValueNode(cp.root, k));
      if (!same) fieldsChanged = true;
    }
    return {
      textChanged,
      contentChanged: bodyChanged || fieldsChanged,
      updatedAtEdited: !sameDateField(bp, cp, "updatedAt"),
      createdAtEdited: !sameDateField(bp, cp, "createdAt"),
      incomparable: false,
    };
  } catch (e) {
    if (e instanceof UnsupportedComparison) return { ...none, incomparable: true };
    throw e;
  }
}

// ---------------------------------------------------------------------------
// フォーム編集（単一正本文書を、変更したノードだけ書き換える）

export type TextEdit = { ok: true; text: string } | { ok: false; message: string };

export function editField(text: string, key: StandardKey, value: FieldValue): TextEdit {
  const split = splitDocument(text);
  if (!split.ok) return { ok: false, message: splitErrorMessage(split.code) };
  const parse = parseCached(split.frontmatter);
  if (!parse.ok) return { ok: false, message: "frontmatter に構文エラーがあるため、フォームでは編集できません。" };
  const r = setTopLevelValue(parse, key, value);
  if (!r.ok) return r;
  return {
    ok: true,
    text: text.slice(0, split.fmStart) + r.source + text.slice(split.fmStart + split.frontmatter.length),
  };
}

export function replaceBody(text: string, body: string): TextEdit {
  const split = splitDocument(text);
  if (!split.ok) return { ok: false, message: splitErrorMessage(split.code) };
  return { ok: true, text: text.slice(0, split.bodyStart) + body };
}

// ---------------------------------------------------------------------------
// 新規作成テンプレート（9.3：標準項目の掲載順で生成）

export function newArticleText(id: string, createdAt: string): string {
  return [
    "---",
    `id: ${JSON.stringify(id)}`,
    `title: ""`,
    `slug: ""`,
    `status: "draft"`,
    `createdAt: ${JSON.stringify(createdAt)}`,
    `updatedAt: ${JSON.stringify(createdAt)}`,
    "publishedAt: null",
    "tags: []",
    "cover: null",
    "---",
    "",
    "",
  ].join("\n");
}

/** 新規記事の初回保存直前に ID を差し替える（10.1：候補が既に存在する場合の再生成） */
export function replaceId(text: string, id: string): TextEdit {
  return editField(text, "id", id);
}

// ---------------------------------------------------------------------------
// 最終保存候補の検証（13.2.2）

export interface CandidateCheck {
  readonly ok: boolean;
  readonly problems: Problem[];
}

/**
 * 管理値反映・LF 統一・BOM 除去後の最終 UTF-8 バイト列を、同じ検証規則で再読込できるか確かめる。
 */
export function verifyCandidateBytes(bytes: Uint8Array, folderId: string): CandidateCheck {
  if (bytes.length > ARTICLE_MAX_BYTES) {
    return {
      ok: false,
      problems: [
        {
          code: "size",
          message: `保存後の記事ファイルが上限を超えます（${bytes.length.toLocaleString()} / ${ARTICLE_MAX_BYTES.toLocaleString()} バイト）。本文を短くするか、原文を退避してください。`,
        },
      ],
    };
  }
  const loaded = textFromBytes(bytes);
  if (!loaded.ok) return { ok: false, problems: [{ code: "size", message: loaded.reason }] };
  if (loaded.bom || loaded.crlf)
    return { ok: false, problems: [{ message: "保存候補に BOM または CRLF が残っています。" }] };
  const a = analyzeText(loaded.text, folderId);
  return { ok: a.problems.length === 0, problems: a.problems };
}

export function textByteLength(text: string): number {
  return utf8ByteLength(text);
}

export { isValidArticleId };

// ---------------------------------------------------------------------------
// 複製の index.md（10.2）

/**
 * 複製元の文書から、新しい記事の index.md を作る。title・本文・タグ・cover・未知フィールドは保持し、
 * id を新しい値、status を draft、slug を空文字、publishedAt を null、createdAt・updatedAt を同じ時刻にする。
 * 未知フィールド内の ID・外部参照は変換しない。
 */
export function duplicateText(source: string, newId: string, at: string): TextEdit {
  let text = source;
  const steps: [StandardKey, FieldValue][] = [
    ["id", newId],
    ["status", "draft"],
    ["slug", ""],
    ["publishedAt", null],
    ["createdAt", at],
    ["updatedAt", at],
  ];
  for (const [k, v] of steps) {
    const r = editField(text, k, v);
    if (!r.ok) return r;
    text = r.text;
  }
  return { ok: true, text };
}

/** 標準項目以外のトップレベルキー（複製前の注意表示に使う） */
export function unknownKeys(a: Analysis): string[] {
  if (!a.parse?.ok) return [];
  const std = new Set<string>(STANDARD_KEYS);
  return topLevelKeys(a.parse.root).filter((k) => !std.has(k));
}

// ---------------------------------------------------------------------------
// 専用の修復操作（10.3・24.1）：勝手に補わず、差分を示して確認後に適用する

export interface RepairProposal {
  readonly text: string;
  /** 差分（変更前・変更後の行） */
  readonly before: string | null;
  readonly after: string;
}

/** トップレベルに欠けている文字列項目を frontmatter の末尾へ追加する。他の項目は変えない */
export function addTopLevelString(text: string, key: string, value: string): TextEdit {
  const split = splitDocument(text);
  if (!split.ok) return { ok: false, message: splitErrorMessage(split.code) };
  const parse = parseCached(split.frontmatter);
  if (!parse.ok) return { ok: false, message: "frontmatter に構文エラーがあるため追加できません。" };
  if (topLevelKeys(parse.root).includes(key)) return { ok: false, message: `${key} は既にあります。` };
  const fm = split.frontmatter;
  const line = `${key}: ${JSON.stringify(value)}`;
  const nextFm = fm === "" ? `${line}\n` : fm.endsWith("\n") ? `${fm}${line}\n` : `${fm}\n${line}`;
  const re = parseFrontmatter(nextFm);
  if (!re.ok) return { ok: false, message: "追加後の frontmatter を解釈できません。" };
  const before = topLevelKeys(parse.root);
  const after = topLevelKeys(re.root);
  if (after.join("\u0000") !== [...before, key].join("\u0000"))
    return { ok: false, message: "追加すると他の項目も変わるため、原文モードで追加してください。" };
  for (const k of before)
    if (!nodesEqual(getValueNode(parse.root, k), getValueNode(re.root, k)))
      return { ok: false, message: "追加すると他の項目も変わるため、原文モードで追加してください。" };
  return { ok: true, text: text.slice(0, split.fmStart) + nextFm + text.slice(split.fmStart + fm.length) };
}

/** id をフォルダ名に合わせる提案（10.3：フォルダ名が有効な場合だけ） */
export function proposeIdFix(text: string, folderId: string): RepairProposal | { error: string } {
  const a = analyzeText(text, folderId);
  if (!a.problems.some((p) => p.code === "id-mismatch")) return { error: "id はフォルダ名と一致しています。" };
  const cur = a.schema?.values.id;
  const r = editField(text, "id", folderId);
  if (!r.ok) return { error: r.message };
  return { text: r.text, before: `id: ${JSON.stringify(cur ?? "")}`, after: `id: ${JSON.stringify(folderId)}` };
}

/** createdAt の不足・不正を指定値で直す提案（24.1） */
export function proposeCreatedAtFix(text: string, folderId: string, value: string): RepairProposal | { error: string } {
  const a = analyzeText(text, folderId);
  const p = a.problems.find((x) => x.field === "createdAt");
  if (!p) return { error: "createdAt に問題はありません。" };
  if (p.code === "missing") {
    const r = addTopLevelString(text, "createdAt", value);
    if (!r.ok) return { error: r.message };
    return { text: r.text, before: null, after: `createdAt: ${JSON.stringify(value)}` };
  }
  const r = editField(text, "createdAt", value);
  if (!r.ok) return { error: r.message };
  const split = splitDocument(text);
  const old = split.ok
    ? (split.frontmatter.split("\n").find((l) => l.startsWith("createdAt:")) ?? "createdAt: （不正な値）")
    : "createdAt: （不正な値）";
  return { text: r.text, before: old, after: `createdAt: ${JSON.stringify(value)}` };
}
