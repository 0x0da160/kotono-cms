/**
 * 見たまま編集（WYSIWYG）の DOM から Markdown を作る（ADR-0005）。
 *
 * - 正本は従来どおり Markdown の本文。見たまま編集は、本文を DOM に描いた「見え方」を編集し、
 *   入力のたびに Markdown へ戻して session.setBody に渡す。
 * - 変更していないブロックは、元の Markdown の記述をそのまま使う（記号・改行・空行の書き方を変えない）。
 *   変更したブロックだけを、この関数の規則で書き直す。
 * - 対応しない記法（表・生 HTML・参照定義・脚注など）は編集不可の塊として描き、元の記述（data-md）をそのまま出す。
 *
 * 実 DOM と単体試験用の簡易ノードの両方で動くよう、使う DOM の機能を最小限にしている。
 */

export interface VNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly nodeValue: string | null;
  readonly childNodes: ArrayLike<VNode>;
  getAttribute?(name: string): string | null;
}

const TEXT = 3;
const ELEMENT = 1;

const attr = (n: VNode, name: string): string | null => (n.getAttribute ? n.getAttribute(name) : null);
const tag = (n: VNode) => n.nodeName.toLowerCase();
const kids = (n: VNode): VNode[] => Array.from(n.childNodes);
const isRaw = (n: VNode) => n.nodeType === ELEMENT && attr(n, "data-md") !== null;

const BLOCK_TAGS = new Set([
  "p",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "blockquote",
  "pre",
  "hr",
  "li",
]);
const isBlock = (n: VNode) =>
  n.nodeType === ELEMENT && (BLOCK_TAGS.has(tag(n)) || (isRaw(n) && attr(n, "data-md-block") !== null));

// ---------------------------------------------------------------------------
// 文字のエスケープ

const PUNCT_OR_SPACE = /[\s\p{P}\p{S}]/u;

/** 本文の文字を、Markdown の記号として解釈されないようにする（行頭の判定は escapeLineStart） */
export function escapeText(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (c === "\\" || c === "`" || c === "*" || c === "[" || c === "]" || c === "<" || c === "~") out += `\\${c}`;
    else if (c === "_") {
      // 語中の _ は強調にならない（日本語・英数字の間）。語の境目だけをエスケープする
      const prev = i === 0 ? " " : (text[i - 1] as string);
      const next = i + 1 >= text.length ? " " : (text[i + 1] as string);
      out += PUNCT_OR_SPACE.test(prev) || PUNCT_OR_SPACE.test(next) ? "\\_" : "_";
    } else if (c === "&" && /^&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{0,31});/.test(text.slice(i)))
      out += "\\&";
    else out += c;
  }
  return out;
}

/** 行頭にあると見出し・引用・リスト・区切り線などになる記述をエスケープする（エスケープ済みの行に使う） */
export function escapeLineStart(line: string): string {
  const s = line.replace(/^[ \t]+/, "");
  if (/^#{1,6}(\s|$)/.test(s)) return `\\${s}`;
  if (/^>/.test(s)) return `\\${s}`;
  if (/^[-+](\s|$)/.test(s)) return `\\${s}`;
  if (/^(=+|-+)\s*$/.test(s)) return `\\${s}`;
  const m = /^(\d{1,9})([.)])(\s|$)/.exec(s);
  if (m) return `${m[1]}\\${s.slice((m[1] ?? "").length)}`;
  return s;
}

function codeSpan(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  const n = runs.reduce((m, r) => Math.max(m, r.length), 0) + 1;
  const fence = "`".repeat(n);
  const pad =
    text.startsWith("`") || text.endsWith("`") || (text.startsWith(" ") && text.endsWith(" ") && text.trim() !== "")
      ? " "
      : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

function linkDestination(url: string): string {
  if (url === "") return "<>";
  if (/[\s()<>]/.test(url)) return `<${url.replace(/[<>]/g, (c) => encodeURIComponent(c))}>`;
  return url.replace(/\\/g, "\\\\");
}

function linkTitle(title: string | null): string {
  if (!title) return "";
  return ` "${title.replace(/["\\]/g, (c) => `\\${c}`)}"`;
}

export function escapeAltText(alt: string): string {
  return alt.replace(/[\r\n]+/g, " ").replace(/([\\[\]])/g, "\\$1");
}

// ---------------------------------------------------------------------------
// インライン

interface InlineCtx {
  out: string;
}

/** 強調などの前後の空白は記号の外に出す（「** 太字**」は強調にならない） */
function wrap(ctx: InlineCtx, inner: string, open: string, close = open): void {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
  const lead = m?.[1] ?? "";
  const core = m?.[2] ?? "";
  const trail = m?.[3] ?? "";
  if (core === "") {
    ctx.out += inner;
    return;
  }
  ctx.out += `${lead}${open}${core}${close}${trail}`;
}

function inlineChildren(nodes: readonly VNode[]): string {
  const ctx: InlineCtx = { out: "" };
  // 末尾の <br>（空の段落を保つためにブラウザが置くもの）は出さない
  let end = nodes.length;
  while (end > 0) {
    const last = nodes[end - 1] as VNode;
    if (last.nodeType === ELEMENT && tag(last) === "br") end--;
    else if (last.nodeType === TEXT && (last.nodeValue ?? "") === "") end--;
    else break;
  }
  for (let i = 0; i < end; i++) inline(ctx, nodes[i] as VNode);
  return ctx.out;
}

function inline(ctx: InlineCtx, n: VNode): void {
  if (n.nodeType === TEXT) {
    ctx.out += escapeText(n.nodeValue ?? "");
    return;
  }
  if (n.nodeType !== ELEMENT) return;
  const md = attr(n, "data-md");
  if (md !== null) {
    ctx.out += md;
    return;
  }
  if (attr(n, "data-ui") !== null) return; // チェック欄などの編集用の飾り
  switch (tag(n)) {
    case "strong":
    case "b":
      return wrap(ctx, inlineChildren(kids(n)), "**");
    case "em":
    case "i":
      return wrap(ctx, inlineChildren(kids(n)), "*");
    case "del":
    case "s":
    case "strike":
      return wrap(ctx, inlineChildren(kids(n)), "~~");
    case "code":
      ctx.out += codeSpan(textOf(n));
      return;
    case "br":
      ctx.out += "\\\n";
      return;
    case "a": {
      const url = attr(n, "data-href") ?? attr(n, "href") ?? "";
      const text = inlineChildren(kids(n));
      ctx.out += `[${text}](${linkDestination(url)}${linkTitle(attr(n, "title"))})`;
      return;
    }
    case "span":
    case "img": {
      if (attr(n, "data-img") === null) {
        for (const c of kids(n)) inline(ctx, c);
        return;
      }
      const src = attr(n, "data-src") ?? "";
      if (src === "") return;
      ctx.out += `![${escapeAltText(attr(n, "data-alt") ?? "")}](${linkDestination(src)}${linkTitle(attr(n, "data-title"))})`;
      return;
    }
    default:
      for (const c of kids(n)) inline(ctx, c);
  }
}

function textOf(n: VNode): string {
  if (n.nodeType === TEXT) return n.nodeValue ?? "";
  if (n.nodeType === ELEMENT && tag(n) === "br") return "\n";
  return kids(n).map(textOf).join("");
}

/** 段落の本文：行ごとに行頭をエスケープする */
function paragraph(nodes: readonly VNode[]): string {
  const raw = inlineChildren(nodes);
  return raw
    .split("\n")
    .map((l) => escapeLineStart(l))
    .join("\n")
    .replace(/\s+$/, "");
}

// ---------------------------------------------------------------------------
// ブロック

function indent(text: string, pad: string): string {
  return text
    .split("\n")
    .map((l, i) => (i === 0 || l === "" ? l : pad + l))
    .join("\n");
}

function heading(n: VNode, level: number): string {
  const t = inlineChildren(kids(n))
    .replace(/\\\n|\n/g, " ")
    .trim();
  if (t === "") return "";
  return `${"#".repeat(level)} ${escapeLineStart(t).replace(/(#+)$/, "\\$1")}`;
}

function fence(n: VNode): string {
  const text = textOf(n).replace(/\n$/, "");
  const runs = text.match(/^`{3,}/gm) ?? [];
  const len = runs.reduce((m, r) => Math.max(m, r.length + 1), 3);
  const f = "`".repeat(len);
  const lang = (attr(n, "data-lang") ?? "").replace(/[`\s]/g, "");
  return `${f}${lang}\n${text}\n${f}`;
}

function listBlock(n: VNode): string {
  const ordered = tag(n) === "ol";
  const marker = attr(n, "data-marker") ?? (ordered ? "." : "-");
  let num = Number(attr(n, "start") ?? "1");
  if (!Number.isFinite(num) || num < 0) num = 1;
  const items: string[] = [];
  let loose = attr(n, "data-spread") === "true";
  for (const li of kids(n)) {
    if (li.nodeType !== ELEMENT || tag(li) !== "li") {
      // リスト直下の文字（編集中に生じる）は項目として扱う
      if (li.nodeType === TEXT && (li.nodeValue ?? "").trim() === "") continue;
    }
    const prefix = ordered ? `${num++}${marker} ` : `${marker} `;
    const checked = li.nodeType === ELEMENT ? attr(li, "data-checked") : null;
    const task = checked === "true" ? "[x] " : checked === "false" ? "[ ] " : "";
    const blocks =
      li.nodeType === ELEMENT && tag(li) === "li"
        ? blocksOf(kids(li))
        : [{ text: paragraph([li]), kind: "other" as const }];
    const onlyListsAfterFirst = blocks.slice(1).every((b) => b.kind === "list");
    if (!onlyListsAfterFirst) loose = true;
    const body = blocks.map((b) => b.text).join(onlyListsAfterFirst ? "\n" : "\n\n");
    items.push(indent(`${prefix}${task}${body}`, " ".repeat(prefix.length)));
  }
  return items.join(loose ? "\n\n" : "\n");
}

function quote(n: VNode): string {
  const inner = blocksOf(kids(n))
    .map((b) => b.text)
    .join("\n\n");
  return inner
    .split("\n")
    .map((l) => (l === "" ? ">" : `> ${l}`))
    .join("\n");
}

interface Block {
  readonly text: string;
  readonly kind: "list" | "other";
}

function block(n: VNode): Block | null {
  const md = attr(n, "data-md");
  if (md !== null) return { text: md, kind: "other" };
  const t = tag(n);
  switch (t) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const s = heading(n, Number(t.slice(1)));
      return s === "" ? null : { text: s, kind: "other" };
    }
    case "ul":
    case "ol": {
      const s = listBlock(n);
      return s === "" ? null : { text: s, kind: "list" };
    }
    case "blockquote": {
      const s = quote(n);
      return s === "" ? null : { text: s, kind: "other" };
    }
    case "pre":
      return { text: fence(n), kind: "other" };
    case "hr":
      return { text: "---", kind: "other" };
    case "li":
      return { text: listBlock({ nodeType: ELEMENT, nodeName: "UL", nodeValue: null, childNodes: [n] }), kind: "list" };
    default: {
      // p・div：中にブロックがあれば（ブラウザの編集で生じる）それぞれをブロックとして扱う
      const c = kids(n);
      if (c.some(isBlock)) {
        const bs = blocksOf(c);
        return bs.length === 0 ? null : { text: bs.map((b) => b.text).join("\n\n"), kind: "other" };
      }
      const s = paragraph(c);
      return s.trim() === "" ? null : { text: s, kind: "other" };
    }
  }
}

/** 子ノードの並びを、ブロックの並びにする（連続したインラインは1つの段落にまとめる） */
function blocksOf(nodes: readonly VNode[]): Block[] {
  const out: Block[] = [];
  let run: VNode[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const s = paragraph(run);
    if (s.trim() !== "") out.push({ text: s, kind: "other" });
    run = [];
  };
  for (const n of nodes) {
    if (isBlock(n)) {
      flush();
      const b = block(n);
      if (b) out.push(b);
    } else run.push(n);
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// 全体

export interface PristineBlock {
  /** 元の Markdown の記述 */
  readonly src: string;
  /** 元の並びで直前にあったブロック（先頭なら null） */
  readonly prev: VNode | null;
  /** 直前のブロックとの間の元の記述（空行など）。先頭なら本文の先頭からの記述 */
  readonly gap: string;
  /** 元の並びで最後のブロックなら、その後ろの記述 */
  readonly tail: string | null;
}

export interface SerializeOptions {
  /** 変更していないブロックなら元の記述を返す */
  pristine(el: VNode): PristineBlock | null;
}

export interface SerializeResult {
  readonly markdown: string;
  /** 最上位の各ブロックの、出力での終わりの位置（画像の挿入位置に使う） */
  readonly ends: Map<VNode, number>;
}

export function serializeRoot(root: VNode, opts: SerializeOptions): SerializeResult {
  let out = "";
  const ends = new Map<VNode, number>();
  let prevEl: VNode | null = null;
  let prevPristine: PristineBlock | null = null;
  let run: VNode[] = [];
  const emit = (text: string, el: VNode | null, p: PristineBlock | null) => {
    if (out === "") out = p && p.prev === null ? p.gap : "";
    else out += p && prevPristine && p.prev === prevEl ? p.gap : "\n\n";
    out += text;
    if (el) ends.set(el, out.length);
    prevEl = el;
    prevPristine = p;
  };
  const flush = () => {
    if (run.length === 0) return;
    const s = paragraph(run);
    const last = run[run.length - 1] as VNode;
    run = [];
    if (s.trim() !== "") emit(s, last, null);
  };
  for (const n of kids(root)) {
    if (!isBlock(n) && !(n.nodeType === ELEMENT && attr(n, "data-md-block") !== null)) {
      run.push(n);
      continue;
    }
    flush();
    const p = opts.pristine(n);
    if (p) {
      emit(p.src, n, p);
      continue;
    }
    const b = block(n);
    if (b) emit(b.text, n, null);
  }
  flush();
  if (out === "") return { markdown: "", ends };
  const lastP = prevPristine as PristineBlock | null;
  out += lastP && lastP.tail !== null ? lastP.tail : "\n";
  return { markdown: out, ends };
}
