/**
 * Markdown の解析・プレビュー用 HTML の生成・メディア参照の抽出（仕様 15・16・18.1・34.2）。
 *
 * - 解析は micromark / mdast 系（ADR-0001）。描画と参照抽出で同じ構文木を使う（18.1・29.1）。
 * - GFM のうち表・取り消し線・チェックリストを有効にする。脚注・数式・ディレクティブ・MDX・
 *   URL の自動リンクは有効にしない（15：初期版プレビュー対象外、原文は保持）。
 * - 生成する HTML は許可した要素・属性だけを、すべての文字列をエスケープして組み立てる。
 *   生 HTML は文字として表示する。リンクは遷移しない表示にし、行先は親側で一覧する（16.1.1）。
 *
 * 非保証：資源上限（ノード数・入れ子・リンク数）は構文木を構築した後に検査している。
 * 採用パーサーは構築中の打切りフックを持たない（ADR-0003 の緊張点）。
 */
import type { Nodes, Parents, Root, RootContent } from "mdast";
import { PREVIEW_MAX_ELEMENTS } from "./budgets";
import { isSafeMediaRef } from "./schema";

/** 構文木の解析結果。解析は終了可能な Worker で行う（markdown-parse.ts・md-service.ts） */
export type MdParse =
  | { ok: true; tree: Root; nodes: number; depth: number; linksImages: number; ms: number }
  | { ok: false; reason: "budget" | "error" | "timeout" | "unavailable"; message: string };

// ---------------------------------------------------------------------------
// URL の分類（16.2・16.3）。参照抽出と描画で同じ規則を使う。

export type UrlKind =
  | { kind: "media"; name: string }
  | { kind: "external"; url: string; scheme: "http" | "https" | "mailto" }
  | { kind: "fragment" }
  | { kind: "relative" }
  | { kind: "rejected"; reason: string };

/** スキームを持つ URL の判定。制御文字・空白を除いた先頭で判断する。 */
export function classifyUrl(raw: string): UrlKind {
  const url = raw.trim();
  if (isSafeMediaRef(url)) return { kind: "media", name: url.slice("./media/".length) };
  // eslint-disable-next-line no-control-regex -- 制御文字を含むスキームの偽装を拒否する
  const compact = url.replace(/[\u0000- \u007f]/g, "");
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(compact);
  if (m) {
    const scheme = (m[1] ?? "").toLowerCase();
    if (scheme === "http" || scheme === "https" || scheme === "mailto") {
      if (compact !== url) return { kind: "rejected", reason: "URL に空白・制御文字が含まれています。" };
      return { kind: "external", url, scheme };
    }
    return { kind: "rejected", reason: `スキーム「${scheme}:」は開けません。` };
  }
  if (url.startsWith("//")) return { kind: "rejected", reason: "スキーム相対 URL は開けません。" };
  if (url.startsWith("#")) return { kind: "fragment" };
  if (/media/i.test(url))
    return { kind: "rejected", reason: "media の参照は ./media/<ファイル名> の形だけを扱います。" };
  return { kind: "relative" };
}

// ---------------------------------------------------------------------------
// メディア参照の抽出（18.1）

export type MediaRefs =
  { status: "ok"; names: Set<string> } | { status: "unknown"; reasons: string[]; names: Set<string> };

/**
 * 当該記事の本文と cover から、media/ のファイル参照を集める。
 * 安全に判定できない記述（生 HTML・未対応構文・曖昧なパス）に media の文字列があれば
 * 記事全体を「参照状況不明」とする（18.1）。コードブロック・インラインコードは対象外。
 */
export function refsFromTree(tree: Root | null, coverSrc: string | null, parseFailure?: string): MediaRefs {
  const names = new Set<string>();
  const reasons: string[] = [];
  if (coverSrc !== null) {
    const c = classifyUrl(coverSrc);
    if (c.kind === "media") names.add(c.name);
    else if (/media/i.test(coverSrc)) reasons.push("cover.src の形式を判定できません。");
  }
  if (tree === null)
    return { status: "unknown", reasons: [...reasons, parseFailure ?? "本文を解析できません。"], names };
  const defs = definitionsOf(tree);
  const visitUrl = (url: string, where: string) => {
    const c = classifyUrl(url);
    if (c.kind === "media") names.add(c.name);
    else if (/media/i.test(url)) reasons.push(`${where}の参照先「${truncate(url)}」を判定できません。`);
  };
  const stack: Nodes[] = [tree];
  while (stack.length > 0) {
    const n = stack.pop() as Nodes;
    switch (n.type) {
      case "code":
      case "inlineCode":
        continue;
      case "image":
        visitUrl(n.url, "画像");
        break;
      case "link":
        visitUrl(n.url, "リンク");
        break;
      case "definition":
        visitUrl(n.url, "参照定義");
        break;
      case "imageReference":
      case "linkReference":
        if (!defs.has(n.identifier)) reasons.push("定義のない参照形式の記述があります。");
        break;
      case "html":
        if (/media/i.test(n.value)) reasons.push("生 HTML の中に media の記述があります。");
        break;
      case "text":
        // 脚注・独自構文など、解析しない記法の中の参照を見落とさない
        if (/media\//i.test(n.value)) reasons.push("本文の未対応の記述に media/ の文字列があります。");
        break;
      default:
        break;
    }
    if ("children" in n) for (const c of n.children) stack.push(c);
  }
  return reasons.length > 0 ? { status: "unknown", reasons: [...new Set(reasons)], names } : { status: "ok", names };
}

/** 判定できなかったことを表す結果 */
export function unknownRefs(reason: string): MediaRefs {
  return { status: "unknown", reasons: [reason], names: new Set() };
}

function truncate(s: string, n = 60): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function definitionsOf(tree: Root): Map<string, { url: string; title: string | null }> {
  const defs = new Map<string, { url: string; title: string | null }>();
  const stack: Nodes[] = [tree];
  while (stack.length > 0) {
    const n = stack.pop() as Nodes;
    if (n.type === "definition" && !defs.has(n.identifier))
      defs.set(n.identifier, { url: n.url, title: n.title ?? null });
    if ("children" in n) for (const c of n.children) stack.push(c);
  }
  return defs;
}

// ---------------------------------------------------------------------------
// プレビュー HTML（16.1・16.1.1）

export interface PreviewLink {
  readonly n: number;
  readonly url: string;
  readonly text: string;
  readonly target: UrlKind;
}

export interface PreviewImage {
  readonly n: number;
  readonly src: string;
  readonly alt: string;
  readonly target: UrlKind;
}

export type ImageSource =
  { kind: "data"; url: string; width: number; height: number } | { kind: "placeholder"; reason: string };

export interface RenderResult {
  readonly html: string;
  readonly links: PreviewLink[];
  readonly images: PreviewImage[];
  readonly elements: number;
  readonly overBudget: boolean;
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

/** 画像参照を列挙する（描画前に、表示用資源を親側で用意するため） */
export function collectImages(tree: Root): PreviewImage[] {
  const defs = definitionsOf(tree);
  const out: PreviewImage[] = [];
  walkInOrder(tree, (n) => {
    if (n.type === "image") out.push({ n: out.length + 1, src: n.url, alt: n.alt ?? "", target: classifyUrl(n.url) });
    else if (n.type === "imageReference") {
      const d = defs.get(n.identifier);
      if (d) out.push({ n: out.length + 1, src: d.url, alt: n.alt ?? "", target: classifyUrl(d.url) });
    }
  });
  return out;
}

function walkInOrder(tree: Root, fn: (n: Nodes) => void): void {
  const stack: Nodes[] = [tree];
  while (stack.length > 0) {
    const n = stack.pop() as Nodes;
    fn(n);
    if ("children" in n) for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i] as Nodes);
  }
}

/**
 * 構文木から、許可要素だけで構成した HTML 文字列を作る。
 * `images` は collectImages と同じ順の表示用資源。null は未読込としてプレースホルダーにする。
 */
export function renderHtml(tree: Root, images: readonly (ImageSource | null)[] = []): RenderResult {
  const defs = definitionsOf(tree);
  const links: PreviewLink[] = [];
  const imgs: PreviewImage[] = [];
  let elements = 0;
  let over = false;
  const parts: string[] = [];
  const open = (tag: string, attrs = "") => {
    elements++;
    if (elements > PREVIEW_MAX_ELEMENTS) over = true;
    parts.push(`<${tag}${attrs}>`);
  };
  const close = (tag: string) => parts.push(`</${tag}>`);
  const text = (s: string) => parts.push(esc(s));

  const inlineText = (n: Nodes): string => {
    if (n.type === "text" || n.type === "inlineCode") return n.value;
    if (n.type === "image" || n.type === "imageReference") return n.alt ?? "";
    if ("children" in n) return n.children.map(inlineText).join("");
    return "";
  };

  const link = (n: Parents, url: string) => {
    const target = classifyUrl(url);
    const num = links.length + 1;
    links.push({ n: num, url, text: inlineText(n), target });
    open("span", ` class="link" data-link="${num}"`);
    kids(n);
    open("sup", ` class="ref"`);
    text(`[${num}]`);
    close("sup");
    close("span");
  };

  const image = (alt: string, src: string) => {
    const idx = imgs.length;
    imgs.push({ n: idx + 1, src, alt, target: classifyUrl(src) });
    const res = images[idx] ?? null;
    if (res?.kind === "data") {
      // data: は親が検証済みのローカル画像から生成した値のみ（16.2）
      open("img", ` src="${esc(res.url)}" alt="${esc(alt)}" width="${res.width}" height="${res.height}"`);
    } else {
      open("span", ` class="img-ph" role="img" aria-label="${esc(alt)}"`);
      text(
        `画像${idx + 1}：${res?.kind === "placeholder" ? res.reason : "未読込"}（${alt === "" ? "alt なし" : alt}）`,
      );
      close("span");
    }
  };

  const kids = (n: Parents) => {
    for (const c of n.children) node(c);
  };

  const node = (n: RootContent | Root) => {
    if (over) return;
    switch (n.type) {
      case "root":
        kids(n);
        return;
      case "paragraph":
        open("p");
        kids(n);
        close("p");
        return;
      case "heading":
        open(`h${n.depth}`);
        kids(n);
        close(`h${n.depth}`);
        return;
      case "thematicBreak":
        open("hr");
        return;
      case "blockquote":
        open("blockquote");
        kids(n);
        close("blockquote");
        return;
      case "list": {
        const tag = n.ordered ? "ol" : "ul";
        open(tag, n.ordered && n.start !== null && n.start !== undefined && n.start !== 1 ? ` start="${n.start}"` : "");
        kids(n);
        close(tag);
        return;
      }
      case "listItem":
        open("li", typeof n.checked === "boolean" ? ` class="task"` : "");
        if (typeof n.checked === "boolean") {
          // チェック操作は本文エディタで行う（15）。入力要素は置かない。
          open("span", ` class="check" aria-label="${n.checked ? "完了" : "未完了"}"`);
          text(n.checked ? "☑ " : "☐ ");
          close("span");
        }
        // 詰めたリストの段落は p にしない
        for (const c of n.children) {
          if (n.spread === false && c.type === "paragraph") kids(c);
          else node(c);
        }
        close("li");
        return;
      case "table": {
        open("table");
        n.children.forEach((row, i) => {
          if (i === 0) open("thead");
          if (i === 1) open("tbody");
          open("tr");
          row.children.forEach((cell, j) => {
            const tag = i === 0 ? "th" : "td";
            const align = n.align?.[j];
            open(tag, align ? ` class="a-${align}"` : "");
            kids(cell);
            close(tag);
          });
          close("tr");
          if (i === 0) close("thead");
        });
        if (n.children.length > 1) close("tbody");
        close("table");
        return;
      }
      case "code":
        // 実行しない。言語指定は表示のみ（ハイライトは未実装）
        open("pre", n.lang ? ` data-lang="${esc(n.lang)}"` : "");
        open("code");
        text(n.value);
        close("code");
        close("pre");
        return;
      case "html":
        // 生 HTML は描画・実行せず、文字として表示する（15）
        open("code", ` class="raw-html"`);
        text(n.value);
        close("code");
        return;
      case "text":
        text(n.value);
        return;
      case "emphasis":
        open("em");
        kids(n);
        close("em");
        return;
      case "strong":
        open("strong");
        kids(n);
        close("strong");
        return;
      case "delete":
        open("del");
        kids(n);
        close("del");
        return;
      case "inlineCode":
        open("code");
        text(n.value);
        close("code");
        return;
      case "break":
        open("br");
        return;
      case "link":
        link(n, n.url);
        return;
      case "linkReference": {
        const d = defs.get(n.identifier);
        // 脚注（[^1]）はプレビュー対象外。記法のまま文字として出す（15）
        if (d && !n.identifier.startsWith("^")) link(n, d.url);
        else {
          text("[");
          kids(n);
          text("]");
        }
        return;
      }
      case "image":
        image(n.alt ?? "", n.url);
        return;
      case "imageReference": {
        const d = defs.get(n.identifier);
        if (d) image(n.alt ?? "", d.url);
        else text(n.alt ?? "");
        return;
      }
      case "definition":
        if (n.identifier.startsWith("^")) {
          open("p");
          text(`[${n.label ?? n.identifier}]: ${n.url}`);
          close("p");
        }
        return;
      default:
        // 想定外のノードは内容を文字として出す
        if ("value" in n && typeof n.value === "string") text(n.value);
        else if ("children" in n) kids(n as Parents);
        return;
    }
  };

  node(tree);
  return { html: over ? "" : parts.join(""), links, images: imgs, elements, overBudget: over };
}
