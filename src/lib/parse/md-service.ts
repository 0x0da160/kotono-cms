/**
 * Markdown 解析の窓口（仕様 16.1.1・32.1.1・34.2）。
 *
 * ブラウザでは終了可能な Worker（md-worker-service.ts）を使う。Worker を起動できない環境では
 * 主スレッドで代わりに解析せず、プレビュー停止・参照状況不明として扱う。
 */
import type { MdParse, MediaRefs } from "../core/markdown";
import { refsFromTree } from "../core/markdown";

export interface MdService {
  tree(body: string): Promise<MdParse>;
  refs(body: string, coverSrc: string | null): Promise<MediaRefs>;
}

const UNAVAILABLE = "Markdown の解析処理（Worker）を起動できません。";

export const unavailableMdService: MdService = {
  tree: async () => ({ ok: false, reason: "unavailable", message: UNAVAILABLE }),
  refs: async (_b, cover) => refsFromTree(null, cover, UNAVAILABLE),
};
