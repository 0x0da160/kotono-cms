/**
 * Markdown の構文解析（仕様 15・29.1・34.2）。micromark / mdast 系を使う（ADR-0001）。
 *
 * GFM のうち表・取り消し線・チェックリストを有効にする。脚注・数式・ディレクティブ・MDX・
 * URL の自動リンクは有効にしない（15：初期版プレビュー対象外、原文は保持）。
 *
 * ブラウザでは終了可能な Worker の中だけで呼ぶ（md.worker.ts）。採用パーサーは入力によって
 * 処理時間が大きく伸びる（強調記号の多い 80 KB の本文で 2 秒超を実測）ため、主スレッドでは解析しない。
 * 非保証：ノード数・入れ子・リンク数の上限は構文木を構築した後に検査している。
 */
import type { Nodes, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmStrikethroughFromMarkdown } from "mdast-util-gfm-strikethrough";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTaskListItemFromMarkdown } from "mdast-util-gfm-task-list-item";
import { gfmStrikethrough } from "micromark-extension-gfm-strikethrough";
import { gfmTable } from "micromark-extension-gfm-table";
import { gfmTaskListItem } from "micromark-extension-gfm-task-list-item";
import { MD_MAX_DEPTH, MD_MAX_LINKS_IMAGES, MD_MAX_MS, MD_MAX_NODES } from "./budgets";
import { refsFromTree, type MdParse, type MediaRefs } from "./markdown";

export interface MdLimits {
  readonly nodes: number;
  readonly depth: number;
  readonly linksImages: number;
}

const LIMITS: MdLimits = { nodes: MD_MAX_NODES, depth: MD_MAX_DEPTH, linksImages: MD_MAX_LINKS_IMAGES };

export function parseMarkdown(
  body: string,
  now: () => number = () => performance.now(),
  limits: MdLimits = LIMITS,
): MdParse {
  const t0 = now();
  let tree: Root;
  try {
    tree = fromMarkdown(body, {
      extensions: [gfmTable(), gfmStrikethrough(), gfmTaskListItem()],
      mdastExtensions: [gfmTableFromMarkdown(), gfmStrikethroughFromMarkdown(), gfmTaskListItemFromMarkdown()],
    });
  } catch (e) {
    return { ok: false, reason: "error", message: `Markdown を解析できません：${e instanceof Error ? e.message : ""}` };
  }
  // 構築後の検査（再帰しない走査で、深い入れ子でもスタックを使い切らない）
  let nodes = 0;
  let depth = 0;
  let linksImages = 0;
  const stack: [Nodes, number][] = [[tree, 0]];
  while (stack.length > 0) {
    const [n, d] = stack.pop() as [Nodes, number];
    nodes++;
    if (d > depth) depth = d;
    if (n.type === "link" || n.type === "image" || n.type === "linkReference" || n.type === "imageReference")
      linksImages++;
    if (nodes > limits.nodes)
      return {
        ok: false,
        reason: "budget",
        message: `構文木のノード数が上限（${limits.nodes.toLocaleString()}）を超えました。`,
      };
    if (d > limits.depth)
      return { ok: false, reason: "budget", message: `入れ子が上限（${limits.depth}段）を超えました。` };
    if (linksImages > limits.linksImages)
      return {
        ok: false,
        reason: "budget",
        message: `リンクと画像の合計が上限（${limits.linksImages.toLocaleString()}）を超えました。`,
      };
    if ("children" in n) for (const c of n.children) stack.push([c, d + 1]);
  }
  const ms = now() - t0;
  // 同じイベントループ内の事後判定であり、処理の中断ではない（34.2 の緊張点）
  if (ms > MD_MAX_MS)
    return { ok: false, reason: "timeout", message: "Markdown の解析が時間上限（2秒）を超えました。" };
  return { ok: true, tree, nodes, depth, linksImages, ms };
}

/** 本文と cover からメディア参照を集める（18.1）。解析できなければ参照状況不明。 */
export function extractMediaRefs(body: string, coverSrc: string | null): MediaRefs {
  const p = parseMarkdown(body);
  return p.ok ? refsFromTree(p.tree, coverSrc) : refsFromTree(null, coverSrc, p.message);
}
