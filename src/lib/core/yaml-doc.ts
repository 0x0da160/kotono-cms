/**
 * YAML frontmatter の解析・意味的同値・ノード単位の書き換え（仕様 8.3・9.2〜9.4）。
 *
 * 採用パーサー：`yaml`（eemeli/yaml）2.9.1 の Document API。文書ノード・コメント・
 * 範囲情報を保持できる。全体を JSON 互換オブジェクトへ変換して再生成しない。
 *
 * フォームからの変更は、対象ノードの原文範囲だけを置き換え、置換後に再解析して
 * 「対象の値が意図どおり」「他のトップレベル項目が意味的に同値」「コメントが欠落・
 * 増加していない」ことを検証する。満たせない場合は変更を拒否する（9.3・9.4）。
 */
import {
  isAlias,
  isCollection,
  isMap,
  isPair,
  isScalar,
  isSeq,
  parseDocument,
  visit,
  type Document,
  type Node as YamlNode,
  type Scalar,
  type YAMLMap,
} from "yaml";
import {
  FRONTMATTER_MAX_DEPTH,
  FRONTMATTER_MAX_KEYS,
  FRONTMATTER_MAX_NODES,
  FRONTMATTER_MAX_SCALAR_BYTES,
} from "./budgets";
import { utf8ByteLength } from "./bytes";

export type YamlProblemKind = "syntax" | "duplicate-key" | "root" | "unsupported" | "budget";

export interface YamlProblem {
  readonly kind: YamlProblemKind;
  readonly message: string;
  /** frontmatter 内の 1 始まりの行・列（分かる場合） */
  readonly line?: number;
  readonly col?: number;
}

export interface ParsedFrontmatter {
  readonly ok: true;
  readonly doc: Document.Parsed;
  readonly root: YAMLMap<Scalar<string>, YamlNode | null>;
  readonly source: string;
}

export type FrontmatterParse = ParsedFrontmatter | { readonly ok: false; readonly problems: YamlProblem[] };

/** YAML core schema のタグだけを許可する。独自タグは対象外（9.2）。 */
const CORE_TAGS = new Set([
  "tag:yaml.org,2002:str",
  "tag:yaml.org,2002:int",
  "tag:yaml.org,2002:float",
  "tag:yaml.org,2002:bool",
  "tag:yaml.org,2002:null",
  "tag:yaml.org,2002:map",
  "tag:yaml.org,2002:seq",
]);

export const PARSE_OPTIONS = {
  version: "1.2",
  schema: "core",
  // ライブラリのキー重複検査は件数の2乗の時間がかかるため、重複は visit で O(n) に検査する
  uniqueKeys: false,
  intAsBigInt: true,
  keepSourceTokens: false,
  prettyErrors: false,
  strict: true,
  // エイリアスは非対応（拒否）。展開処理も行わせない（9.2）。
  maxAliasCount: 0,
} as const;

function position(source: string, offset: number | undefined): { line?: number; col?: number } {
  if (offset === undefined) return {};
  let line = 1;
  let last = -1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      last = i;
    }
  }
  return { line, col: offset - last };
}

export function parseFrontmatter(source: string): FrontmatterParse {
  const doc = parseDocument(source, PARSE_OPTIONS);
  const problems: YamlProblem[] = [];
  for (const e of doc.errors) {
    const kind: YamlProblemKind =
      e.code === "DUPLICATE_KEY" ? "duplicate-key" : e.code === "MULTIPLE_DOCS" ? "unsupported" : "syntax";
    const pos = position(source, e.pos[0]);
    problems.push({ kind, message: firstLine(e.message), ...pos });
  }
  for (const w of doc.warnings) {
    // 未解決タグ等の警告は、保持できない構文として扱う
    problems.push({ kind: "unsupported", message: firstLine(w.message), ...position(source, w.pos[0]) });
  }
  if (problems.length > 0) return { ok: false, problems };

  const root = doc.contents;
  if (!isMap(root)) {
    return { ok: false, problems: [{ kind: "root", message: "frontmatter のルートはマッピングにしてください。" }] };
  }

  let nodes = 0;
  let keys = 0;
  const visitNode = (node: unknown, depth: number): void => {
    if (problems.length > 0) return;
    if (depth > FRONTMATTER_MAX_DEPTH) {
      problems.push({ kind: "budget", message: `入れ子が上限（${FRONTMATTER_MAX_DEPTH}段）を超えています。` });
      return;
    }
    if (node === null || node === undefined) return;
    if (++nodes > FRONTMATTER_MAX_NODES) {
      problems.push({ kind: "budget", message: `ノード数が上限（${FRONTMATTER_MAX_NODES}）を超えています。` });
      return;
    }
    if (isAlias(node)) {
      problems.push({
        kind: "unsupported",
        message: "エイリアス（*）は初期版では非対応です。",
        ...rangePos(source, node),
      });
      return;
    }
    const n = node as YamlNode;
    if (n.anchor) {
      problems.push({ kind: "unsupported", message: "アンカー（&）は初期版では非対応です。", ...rangePos(source, n) });
      return;
    }
    if (n.tag !== undefined && !CORE_TAGS.has(n.tag)) {
      problems.push({
        kind: "unsupported",
        message: `独自タグ（${n.tag}）は初期版では非対応です。`,
        ...rangePos(source, n),
      });
      return;
    }
    if (isScalar(n)) {
      const [start, end] = n.range ?? [0, 0];
      if (utf8ByteLength(source.slice(start, end)) > FRONTMATTER_MAX_SCALAR_BYTES) {
        problems.push({ kind: "budget", message: "単一の値が上限（256 KiB）を超えています。", ...rangePos(source, n) });
      }
      return;
    }
    if (isMap(n)) {
      const seen = new Set<string>();
      for (const pair of n.items) {
        if (++keys > FRONTMATTER_MAX_KEYS) {
          problems.push({ kind: "budget", message: `キー数が上限（${FRONTMATTER_MAX_KEYS}）を超えています。` });
          return;
        }
        const key = pair.key;
        if (!isScalar(key) || typeof key.value !== "string") {
          problems.push({
            kind: "unsupported",
            message: "文字列以外のキーは初期版では非対応です。",
            ...(isScalar(key) || isCollection(key) ? rangePos(source, key as YamlNode) : {}),
          });
          return;
        }
        if (key.value === "<<" && key.type === "PLAIN") {
          problems.push({
            kind: "unsupported",
            message: "マージキー（<<）は初期版では非対応です。",
            ...rangePos(source, key),
          });
          return;
        }
        if (key.anchor || (key.tag !== undefined && !CORE_TAGS.has(key.tag))) {
          problems.push({
            kind: "unsupported",
            message: "キーへのアンカー・独自タグは非対応です。",
            ...rangePos(source, key),
          });
          return;
        }
        if (seen.has(key.value)) {
          problems.push({
            kind: "duplicate-key",
            message: `キー「${key.value}」が重複しています。`,
            ...rangePos(source, key),
          });
          return;
        }
        seen.add(key.value);
        nodes++;
        visitNode(pair.value, depth + 1);
      }
      return;
    }
    if (isSeq(n)) {
      for (const item of n.items) visitNode(item, depth + 1);
    }
  };
  visitNode(root, 1);
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, doc, root: root as YAMLMap<Scalar<string>, YamlNode | null>, source };
}

function firstLine(s: string): string {
  return s.split("\n")[0] ?? s;
}

function rangePos(source: string, n: YamlNode): { line?: number; col?: number } {
  return position(source, n.range?.[0]);
}

// ---------------------------------------------------------------------------
// トップレベル項目の参照

export function getPair(root: YAMLMap, key: string) {
  return root.items.find((p) => isScalar(p.key) && p.key.value === key);
}

export function getValueNode(root: YAMLMap, key: string): YamlNode | null | undefined {
  const pair = getPair(root, key);
  if (!pair) return undefined;
  return (pair.value as YamlNode | null) ?? null;
}

export function topLevelKeys(root: YAMLMap): string[] {
  return root.items.map((p) => String((p.key as Scalar).value));
}

// ---------------------------------------------------------------------------
// 意味的同値（8.3）

type Canon =
  | { t: "null" }
  | { t: "bool"; v: boolean }
  | { t: "int"; v: bigint }
  | { t: "float"; v: string }
  | { t: "str"; v: string }
  | { t: "unsupported" };

/** 十進数・指数表記を精度を保ったまま正規化する。NaN 同士は同値、±0 は同値、±∞ は区別。 */
export function canonicalFloat(src: string): string | null {
  const s = src.trim();
  if (/^[-+]?\.(inf|Inf|INF)$/.test(s)) return s.startsWith("-") ? "-inf" : "+inf";
  if (/^\.(nan|NaN|NAN)$/.test(s)) return "nan";
  const m = /^([-+])?(\d*)(?:\.(\d*))?(?:[eE]([-+]?\d+))?$/.exec(s);
  if (!m) return null;
  const [, sign, intPart = "", fracPart = "", expPart] = m;
  if (intPart === "" && fracPart === "") return null;
  let digits = (intPart + fracPart).replace(/^0+/, "");
  let exp = BigInt(expPart ?? "0") - BigInt(fracPart.length);
  if (digits === "") return "0";
  const trailing = /0*$/.exec(digits)?.[0].length ?? 0;
  if (trailing > 0) {
    digits = digits.slice(0, digits.length - trailing);
    exp += BigInt(trailing);
  }
  return `${sign === "-" ? "-" : ""}${digits}e${exp}`;
}

function canon(n: Scalar): Canon {
  const v = n.value;
  if (v === null) return { t: "null" };
  if (typeof v === "boolean") return { t: "bool", v };
  if (typeof v === "bigint") return { t: "int", v };
  if (typeof v === "string") return { t: "str", v };
  if (typeof v === "number") {
    // 整数でも Number になる場合（例：明示タグ）や浮動小数は、元の表現から精度を保って比較する
    const src = typeof n.source === "string" ? n.source : undefined;
    if (src === undefined) return { t: "unsupported" };
    if (Number.isInteger(v) && /^[-+]?\d+$/.test(src.trim())) return { t: "int", v: BigInt(src.trim()) };
    const c = canonicalFloat(src);
    return c === null ? { t: "unsupported" } : { t: "float", v: c };
  }
  return { t: "unsupported" };
}

export class UnsupportedComparison extends Error {}

/** ノードの型を保持して比較する。キー順だけの違いは同値。比較不能な表現は例外。 */
export function nodesEqual(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || b === null || b === undefined) {
    const an = a === null || a === undefined || (isScalar(a) && a.value === null);
    const bn = b === null || b === undefined || (isScalar(b) && b.value === null);
    if (an || bn) return an && bn;
  }
  if (isScalar(a) && isScalar(b)) {
    const ca = canon(a);
    const cb = canon(b);
    if (ca.t === "unsupported" || cb.t === "unsupported") throw new UnsupportedComparison("比較できない数値表現です。");
    if (ca.t !== cb.t) return false;
    if (ca.t === "null") return true;
    return (ca as { v: unknown }).v === (cb as { v: unknown }).v;
  }
  if (isSeq(a) && isSeq(b)) {
    if (a.items.length !== b.items.length) return false;
    return a.items.every((x, i) => nodesEqual(x, b.items[i]));
  }
  if (isMap(a) && isMap(b)) {
    if (a.items.length !== b.items.length) return false;
    const bm = new Map<string, unknown>();
    for (const p of b.items) bm.set(String((p.key as Scalar).value), p.value);
    for (const p of a.items) {
      const k = String((p.key as Scalar).value);
      if (!bm.has(k)) return false;
      if (!nodesEqual(p.value, bm.get(k))) return false;
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// コメントの収集（9.4 の検証用）

export function collectComments(doc: Document): string[] {
  const out: string[] = [];
  if (doc.commentBefore) out.push(doc.commentBefore);
  if (doc.comment) out.push(doc.comment);
  visit(doc, (_key, node) => {
    if (isPair(node)) return;
    const n = node as { commentBefore?: string | null; comment?: string | null };
    if (n.commentBefore) out.push(n.commentBefore);
    if (n.comment) out.push(n.comment);
  });
  return out.sort();
}

// ---------------------------------------------------------------------------
// 値の直列化（変更したノードだけ）

export interface CoverValue {
  readonly src: string;
  readonly alt: string;
  /** 省略時は既存の値を変えない。空文字で、項目がなければ追加しない */
  readonly caption?: string;
  readonly credit?: string;
}
export interface CorrectionValue {
  readonly at: string;
  readonly note: string;
}
export type FieldValue = string | null | readonly string[] | readonly CorrectionValue[] | CoverValue;

function isCorrectionList(v: readonly unknown[]): v is readonly CorrectionValue[] {
  return v.length > 0 && typeof v[0] === "object" && v[0] !== null;
}

function doubleQuoted(s: string): string {
  // JSON の文字列エスケープは YAML の二重引用符スカラーで有効
  return JSON.stringify(s);
}

function isSafePlain(s: string): boolean {
  if (s === "" || s.trim() !== s || /[\n\r\t]/.test(s)) return false;
  const probe = parseDocument(`k: ${s}\n`, PARSE_OPTIONS);
  if (probe.errors.length > 0 || probe.warnings.length > 0) return false;
  const v = getValueNode(probe.contents as YAMLMap, "k");
  return isScalar(v) && v.value === s && v.type === "PLAIN";
}

/** 元のスカラー表現の種類をできるだけ保ちつつ、文字列・null を直列化する */
export function serializeScalar(value: string | null, previous: YamlNode | null | undefined): string {
  if (value === null) return "null";
  const type = isScalar(previous) ? previous.type : undefined;
  if (type === "QUOTE_SINGLE" && !/[\n\r\t\p{Cc}]/u.test(value)) return `'${value.replace(/'/g, "''")}'`;
  // plain は元の値が文字列だった場合だけ保つ（null 等からの変更で日時等が別の型に読まれるのを避ける）
  if (type === "PLAIN" && isScalar(previous) && typeof previous.value === "string" && isSafePlain(value)) return value;
  return doubleQuoted(value);
}

function flowSeq(items: readonly string[]): string {
  return `[${items.map(doubleQuoted).join(", ")}]`;
}

// ---------------------------------------------------------------------------
// 原文範囲の置換と検証

export interface EditOk {
  readonly ok: true;
  readonly source: string;
}
export interface EditRejected {
  readonly ok: false;
  readonly message: string;
}
export type EditResult = EditOk | EditRejected;

function replaceRange(source: string, start: number, end: number, replacement: string): string {
  const original = source.slice(start, end);
  let rep = replacement;
  // 置換範囲が行終端を含んでいた場合（ブロックスカラー等）は行終端を残す
  if (original.endsWith("\n") && !rep.endsWith("\n")) rep += "\n";
  // `key:` の直後（空値）に挿入する場合は区切りの空白を補う
  if (start === end && source[start - 1] === ":") rep = ` ${rep}`;
  return source.slice(0, start) + rep + source.slice(end);
}

const REJECT_STRUCTURE = "この項目は書式を保ったまま変更できません。原文モードで編集してください。";
const REJECT_COMMENT =
  "この項目にはコメントがあり、フォームで変更するとコメントを保持できません。原文モードで編集してください。";

/**
 * トップレベル項目の値を置き換える。項目が存在しない場合は変更しない（勝手に補わない）。
 * 置換後に再解析し、意図した値・他項目の同値・コメントの保持を検証する。
 */
export function setTopLevelValue(parsed: ParsedFrontmatter, key: string, value: FieldValue): EditResult {
  const { root, source, doc } = parsed;
  const pair = getPair(root, key);
  if (!pair) return { ok: false, message: `${key} がありません。原文モードで追加してください。` };
  const node = (pair.value as YamlNode | null) ?? null;
  let next: string;

  if (value === null || typeof value === "string") {
    if (node === null) return { ok: false, message: REJECT_STRUCTURE };
    const [start, end] = node.range ?? [0, 0];
    next = replaceRange(source, start, end, serializeScalar(value, node));
  } else if (Array.isArray(value)) {
    const items = value as readonly unknown[];
    if (isCorrectionList(items)) {
      const r = replaceMapSeq(source, node, items);
      if (r === null) return { ok: false, message: REJECT_STRUCTURE };
      next = r;
    } else next = replaceSeq(source, node, items as readonly string[]);
  } else {
    const cover = value as CoverValue;
    if (isMap(node)) {
      // 既存のマッピングでは src・alt 等のスカラーだけを置き換え、未知の子項目を保持する
      let cur: ParsedFrontmatter = parsed;
      for (const sub of ["src", "alt", "caption", "credit"] as const) {
        const want = cover[sub];
        if (want === undefined) continue;
        const map = getValueNode(cur.root, key);
        if (!isMap(map)) return { ok: false, message: REJECT_STRUCTURE };
        const subNode = getValueNode(map, sub);
        if (subNode === undefined) {
          if (sub === "src" || sub === "alt")
            return { ok: false, message: `${key}.${sub} がありません。原文モードで追加してください。` };
          if (want === "") continue;
          const added = addMapChild(cur.source, map, sub, want);
          if (added === null) return { ok: false, message: `${key}.${sub} は原文モードで追加してください。` };
          const reparsed = parseFrontmatter(added);
          if (!reparsed.ok) return { ok: false, message: REJECT_STRUCTURE };
          cur = reparsed;
          continue;
        }
        if (subNode === null) return { ok: false, message: REJECT_STRUCTURE };
        if (isScalar(subNode) && subNode.value === want) continue;
        const [s, e] = subNode.range ?? [0, 0];
        const reparsed = parseFrontmatter(replaceRange(cur.source, s, e, serializeScalar(want, subNode)));
        if (!reparsed.ok) return { ok: false, message: REJECT_STRUCTURE };
        cur = reparsed;
      }
      // 書き換えなかった子項目（未知の項目を含む）が変わっていないこと
      const before = getValueNode(root, key);
      const after = getValueNode(cur.root, key);
      if (!isMap(before) || !isMap(after)) return { ok: false, message: REJECT_STRUCTURE };
      try {
        for (const k of topLevelKeys(before)) {
          if (cover[k as keyof CoverValue] !== undefined) continue;
          if (!nodesEqual(getValueNode(before, k), getValueNode(after, k)))
            return { ok: false, message: REJECT_STRUCTURE };
        }
      } catch {
        return { ok: false, message: REJECT_STRUCTURE };
      }
      next = cur.source;
    } else {
      if (node === null) return { ok: false, message: REJECT_STRUCTURE };
      const [start, end] = node.range ?? [0, 0];
      const extra = (["caption", "credit"] as const)
        .filter((k) => (cover[k] ?? "") !== "")
        .map((k) => `, ${k}: ${doubleQuoted(cover[k] ?? "")}`)
        .join("");
      next = replaceRange(
        source,
        start,
        end,
        `{ src: ${doubleQuoted(cover.src)}, alt: ${doubleQuoted(cover.alt)}${extra} }`,
      );
    }
  }

  const reparsed = parseFrontmatter(next);
  if (!reparsed.ok) return { ok: false, message: REJECT_STRUCTURE };
  // 他のトップレベル項目が変わっていないこと
  const beforeKeys = topLevelKeys(root);
  const afterKeys = topLevelKeys(reparsed.root);
  if (beforeKeys.join("\u0000") !== afterKeys.join("\u0000")) return { ok: false, message: REJECT_STRUCTURE };
  try {
    for (const k of beforeKeys) {
      if (k === key) continue;
      if (!nodesEqual(getValueNode(root, k), getValueNode(reparsed.root, k)))
        return { ok: false, message: REJECT_STRUCTURE };
    }
  } catch {
    return { ok: false, message: REJECT_STRUCTURE };
  }
  // 対象の値が意図どおりであること
  if (!valueMatches(getValueNode(reparsed.root, key), value)) return { ok: false, message: REJECT_STRUCTURE };
  // コメントが欠落・増加していないこと
  if (collectComments(doc).join("\u0000") !== collectComments(reparsed.doc).join("\u0000")) {
    return { ok: false, message: REJECT_COMMENT };
  }
  return { ok: true, source: next };
}

function replaceSeq(source: string, node: YamlNode | null, items: readonly string[]): string {
  if (node === null) return source;
  const [start, end] = node.range ?? [0, 0];
  if (isSeq(node) && !node.flow && items.length > 0) {
    // ブロック形式は元のインデントを保って書き直す
    const lineStart = source.lastIndexOf("\n", start - 1) + 1;
    const indent = source.slice(lineStart, start);
    if (/^[ ]*$/.test(indent)) {
      const prev = node.items[0];
      const text = items
        .map((it, i) =>
          `- ${serializeScalar(it, isScalar(prev) ? prev : undefined)}`.replace(/^/, i === 0 ? "" : indent),
        )
        .join("\n");
      return replaceRange(source, start, end, text);
    }
  }
  return replaceRange(source, start, end, flowSeq(items));
}

/**
 * 訂正・追記のようなマッピングの配列を書き直す。ブロック形式は元のインデントを保つ。
 * 空のフロー形式（`[]`）からは、キーの次の行にブロック形式で書く。
 */
function replaceMapSeq(source: string, node: YamlNode | null, items: readonly CorrectionValue[]): string | null {
  if (node === null) return null;
  const [start, end] = node.range ?? [0, 0];
  const colon = source.lastIndexOf(":", start - 1);
  const afterKey = colon >= 0 && /^\s*$/.test(source.slice(colon + 1, start));
  if (items.length === 0) {
    // ブロック形式から空にするときは `key: []` に戻す
    if (afterKey && isSeq(node) && !node.flow) return replaceRange(source, colon + 1, end, " []");
    return replaceRange(source, start, end, "[]");
  }
  if (isSeq(node) && !node.flow) {
    const lineStart = source.lastIndexOf("\n", start - 1) + 1;
    const indent = source.slice(lineStart, start);
    if (!/^[ ]*$/.test(indent)) return null;
    return replaceRange(source, start, end, blockMapSeq(items, indent).slice(indent.length));
  }
  // フロー形式・スカラーからは、キーの直後をブロック形式に置き換える
  if (!afterKey) return null;
  const lineStart = source.lastIndexOf("\n", colon - 1) + 1;
  const keyIndent = source.slice(lineStart, colon).match(/^[ ]*/)?.[0] ?? "";
  const rep = `\n${blockMapSeq(items, `${keyIndent}  `)}`;
  return replaceRange(source, colon + 1, end, rep);
}

/** `- at: …` の形のブロック配列。各行の先頭に indent を付け、末尾に改行を付けない */
export function blockMapSeq(items: readonly CorrectionValue[], indent: string): string {
  return items.map((c) => `${indent}- at: ${doubleQuoted(c.at)}\n${indent}  note: ${doubleQuoted(c.note)}`).join("\n");
}

/** マッピングの末尾に子項目を 1 つ足す。足せない形のときは null */
function addMapChild(source: string, map: YAMLMap, key: string, value: string): string | null {
  const [start, end] = map.range ?? [0, 0];
  const line = `${key}: ${doubleQuoted(value)}`;
  if (map.flow) {
    const close = source.lastIndexOf("}", end);
    if (close < start) return null;
    const sep = map.items.length > 0 ? ", " : "";
    // 閉じ括弧の前の空白は残す
    let p = close;
    while (p > start && source[p - 1] === " ") p--;
    return `${source.slice(0, p)}${sep}${line}${source.slice(p)}`;
  }
  const first = map.items[0]?.key as YamlNode | undefined;
  const firstStart = first?.range?.[0];
  if (firstStart === undefined) return null;
  const lineStart = source.lastIndexOf("\n", firstStart - 1) + 1;
  const indent = source.slice(lineStart, firstStart);
  if (!/^[ ]+$/.test(indent)) return null;
  let p = end;
  while (p > start && source[p - 1] === "\n") p--;
  return `${source.slice(0, p)}\n${indent}${line}${source.slice(p)}`;
}

function valueMatches(node: YamlNode | null | undefined, value: FieldValue): boolean {
  if (value === null) return node === null || (isScalar(node) && node.value === null);
  if (typeof value === "string") return isScalar(node) && node.value === value;
  if (Array.isArray(value)) {
    const items = value as readonly unknown[];
    if (!isSeq(node) || node.items.length !== items.length) return false;
    if (isCorrectionList(items)) {
      return node.items.every((it, i) => {
        if (!isMap(it)) return false;
        const at = getValueNode(it, "at");
        const note = getValueNode(it, "note");
        const want = items[i] as CorrectionValue;
        return isScalar(at) && at.value === want.at && isScalar(note) && note.value === want.note;
      });
    }
    return node.items.every((it, i) => isScalar(it) && it.value === items[i]);
  }
  const cover = value as CoverValue;
  if (!isMap(node)) return false;
  for (const sub of ["src", "alt", "caption", "credit"] as const) {
    const want = cover[sub];
    if (want === undefined) continue;
    const n = getValueNode(node, sub);
    if (n === undefined && want === "" && (sub === "caption" || sub === "credit")) continue;
    if (!isScalar(n) || n.value !== want) return false;
  }
  return true;
}
