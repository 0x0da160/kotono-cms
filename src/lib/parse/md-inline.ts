/** 単体試験用：同じ解析関数を同期で呼ぶ（ブラウザの配布物では使わない） */
import { attachHighlights } from "../core/highlight";
import { extractMediaRefs, parseMarkdown } from "../core/markdown-parse";
import type { MdService } from "./md-service";

export const inlineMdService: MdService = {
  tree: async (body) => {
    const r = parseMarkdown(body);
    if (r.ok) attachHighlights(r.tree);
    return r;
  },
  refs: async (body, cover) => extractMediaRefs(body, cover),
};
