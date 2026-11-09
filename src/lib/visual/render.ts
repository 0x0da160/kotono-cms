/**
 * 見たまま編集（WYSIWYG）用に、Markdown の構文木を編集可能な DOM にする（ADR-0005）。
 *
 * - 要素は createElement と文字ノードだけで作る（innerHTML を使わない）。記事由来の HTML は描画・実行しない。
 * - リンクは href を持たせず data-href に置く（編集領域から遷移・通信しない：16.3）。
 * - 画像は img を置き、表示用の資源（検証済みの派生画像の blob: URL）は呼び出し側が後から設定する。
 * - 対応しない記法は編集不可の塊にし、元の記述を data-md に持たせる（serialize.ts がそのまま出す）。
 */
import type { Nodes, Root, RootContent, PhrasingContent, List, ListItem } from "mdast";
import type { PristineBlock } from "./serialize";

export interface RenderedBlock {
  readonly el: HTMLElement;
  readonly info: PristineBlock;
}

export interface RenderOutput {
  readonly blocks: RenderedBlock[];
  readonly images: HTMLElement[];
}

const start = (n: Nodes) => n.position?.start.offset ?? 0;
const end = (n: Nodes) => n.position?.end.offset ?? 0;

export function renderTree(doc: Document, tree: Root, src: string): RenderOutput {
  const images: HTMLElement[] = [];
  const raw = (n: Nodes, block: boolean): HTMLElement => {
    const s = src.slice(start(n), end(n));
    const el = doc.createElement(block ? "div" : "span");
    el.className = block ? "v-raw" : "v-raw-inline";
    el.contentEditable = "false";
    el.setAttribute("data-md", s);
    if (block) {
      el.setAttribute("data-md-block", n.type);
      el.title = "この部分は「原文」タブで編集できます";
    }
    el.textContent = s;
    return el;
  };

  const inlineInto = (parent: HTMLElement, nodes: readonly PhrasingContent[]) => {
    for (const n of nodes) parent.append(inlineNode(n));
  };

  const inlineNode = (n: PhrasingContent): Node => {
    switch (n.type) {
      case "text":
        return doc.createTextNode(n.value);
      case "emphasis": {
        const el = doc.createElement("em");
        inlineInto(el, n.children);
        return el;
      }
      case "strong": {
        const el = doc.createElement("strong");
        inlineInto(el, n.children);
        return el;
      }
      case "delete": {
        const el = doc.createElement("del");
        inlineInto(el, n.children);
        return el;
      }
      case "inlineCode": {
        const el = doc.createElement("code");
        el.textContent = n.value;
        return el;
      }
      case "break":
        return doc.createElement("br");
      case "link": {
        const el = doc.createElement("a");
        el.setAttribute("data-href", n.url);
        if (n.title) el.title = n.title;
        inlineInto(el, n.children);
        return el;
      }
      case "image": {
        // 画像は編集不可の1文字として扱う。表示用の資源は呼び出し側が検証してから入れる
        const el = doc.createElement("span");
        el.contentEditable = "false";
        el.className = "v-img";
        el.setAttribute("data-img", "");
        el.setAttribute("data-src", n.url);
        el.setAttribute("data-alt", n.alt ?? "");
        if (n.title) el.setAttribute("data-title", n.title);
        el.setAttribute("role", "img");
        el.setAttribute("aria-label", n.alt ?? "");
        const ph = doc.createElement("span");
        ph.className = "v-img-ph";
        ph.textContent = `画像：${n.alt || "alt なし"}`;
        el.append(ph);
        images.push(el);
        return el;
      }
      default:
        return raw(n, false);
    }
  };

  /** リストを描けるか：各項目が「段落（任意）＋入れ子のリスト」だけで、段落は1つまで */
  const simpleList = (l: List): boolean =>
    l.children.every((li: ListItem) => {
      const [first, ...rest] = li.children;
      if (first && first.type !== "paragraph" && first.type !== "list") return false;
      return rest.every((c) => c.type === "list" && simpleList(c));
    });

  const listMarker = (l: List): string => {
    const s = src.slice(start(l), end(l)).replace(/^[ \t]+/, "");
    if (l.ordered) return /^\d+\)/.test(s) ? ")" : ".";
    const c = s[0];
    return c === "*" || c === "+" ? c : "-";
  };

  const listEl = (l: List): HTMLElement => {
    const el = doc.createElement(l.ordered ? "ol" : "ul");
    if (l.ordered && typeof l.start === "number" && l.start !== 1) el.setAttribute("start", String(l.start));
    el.setAttribute("data-marker", listMarker(l));
    if (l.spread) el.setAttribute("data-spread", "true");
    for (const li of l.children) {
      const item = doc.createElement("li");
      if (typeof li.checked === "boolean") {
        item.setAttribute("data-checked", String(li.checked));
        const box = doc.createElement("span");
        box.className = "v-check";
        box.contentEditable = "false";
        box.setAttribute("data-ui", "check");
        box.setAttribute("role", "checkbox");
        box.setAttribute("aria-checked", String(li.checked));
        box.setAttribute("aria-label", "完了");
        box.textContent = li.checked ? "☑" : "☐";
        item.append(box);
      }
      for (const c of li.children) {
        if (c.type === "paragraph") inlineInto(item, c.children);
        else if (c.type === "list") item.append(listEl(c));
      }
      el.append(item);
    }
    return el;
  };

  /** ブロックを描く。描けない記法は null（呼び出し側で編集不可の塊にする） */
  const blockEl = (n: RootContent): HTMLElement | null => {
    switch (n.type) {
      case "paragraph": {
        const el = doc.createElement("p");
        inlineInto(el, n.children);
        return el;
      }
      case "heading": {
        const el = doc.createElement(`h${n.depth}`);
        inlineInto(el, n.children);
        return el;
      }
      case "thematicBreak": {
        const el = doc.createElement("hr");
        el.contentEditable = "false";
        return el;
      }
      case "code": {
        if (n.meta) break; // 情報文字列の言語以外の部分は原文で扱う
        const el = doc.createElement("pre");
        if (n.lang) el.setAttribute("data-lang", n.lang);
        el.textContent = n.value;
        return el;
      }
      case "list":
        if (!simpleList(n)) break;
        return listEl(n);
      case "blockquote": {
        const el = doc.createElement("blockquote");
        for (const c of n.children) {
          if (c.type === "blockquote") return null;
          const b = blockEl(c);
          if (!b) return null;
          el.append(b);
        }
        return el;
      }
      default:
        break;
    }
    return null;
  };

  /**
   * 表（GFM）：編集はできない塊のまま、罫線つきの表として見せる（ADR-0011）。元の記述は data-md に持つ。
   * セルの中身は文字・強調などの行内の記法だけで描く（innerHTML は使わない）。
   */
  const tableEl = (n: Extract<RootContent, { type: "table" }>): HTMLElement => {
    const box = raw(n, true);
    box.classList.add("v-table");
    box.textContent = "";
    const table = doc.createElement("table");
    const align = n.align ?? [];
    n.children.forEach((row, ri) => {
      const tr = doc.createElement("tr");
      row.children.forEach((cell, ci) => {
        const c = doc.createElement(ri === 0 ? "th" : "td");
        const a = align[ci];
        if (a) c.style.textAlign = a;
        inlineInto(c, cell.children);
        tr.append(c);
      });
      if (ri === 0) {
        const thead = doc.createElement("thead");
        thead.append(tr);
        table.append(thead);
      } else {
        let tbody = table.tBodies[0];
        if (!tbody) {
          tbody = doc.createElement("tbody");
          table.append(tbody);
        }
        tbody.append(tr);
      }
    });
    box.append(table);
    return box;
  };

  const blocks: RenderedBlock[] = [];
  let prev: HTMLElement | null = null;
  let prevEnd = 0;
  tree.children.forEach((n, i) => {
    const el = blockEl(n) ?? (n.type === "table" ? tableEl(n) : raw(n, true));
    const isLast = i === tree.children.length - 1;
    blocks.push({
      el,
      info: {
        src: src.slice(start(n), end(n)),
        prev,
        gap: src.slice(prevEnd, start(n)),
        tail: isLast ? src.slice(end(n)) : null,
      },
    });
    prev = el;
    prevEnd = end(n);
  });
  return { blocks, images };
}
