/**
 * 資源予算（仕様 第34章）。
 *
 * 第34.2節の値は仕様で固定された初期値。第34.5節で「TG09で確定・承認必須」とされた
 * 値は、ここでは暫定値（PROVISIONAL）として置いている。暫定値は未承認であり、
 * 技術ゲートで測定・承認するまでリリース条件を満たさない。
 */

export const MiB = 1_048_576;
export const KiB = 1024;

/** 第34.2節・第25.1節：記事ファイルは 5 MiB まで対話編集 */
export const ARTICLE_MAX_BYTES = 5 * MiB;

/** 第9.2節・第34.2節：frontmatter の上限 */
export const FRONTMATTER_MAX_BYTES = 1 * MiB;
export const FRONTMATTER_MAX_DEPTH = 50;
export const FRONTMATTER_MAX_NODES = 50_000;
export const FRONTMATTER_MAX_KEYS = 20_000;
export const FRONTMATTER_MAX_SCALAR_BYTES = 256 * KiB;

/** 第34.2節：原文差分 */
export const DIFF_MAX_INPUT_BYTES = 1 * MiB;
export const DIFF_MAX_LINES = 20_000;
export const DIFF_MAX_RENDER_LINES = 2_000;
export const DIFF_MAX_MS = 2_000;

/** 第34.2節：Undo/Redo は履歴差分 20 MiB または 1,000 操作の先到達 */
export const HISTORY_MAX_BYTES = 20 * MiB;
export const HISTORY_MAX_ENTRIES = 1_000;

/** 第25.2節：メタデータ I/O の並列度の初期値 */
export const METADATA_IO_CONCURRENCY = 8;

/** 第5.2節・第17章：ID 候補は初回を含め最大 11 */
export const ID_MAX_CANDIDATES = 11;

/**
 * 第34.5節：cms.config.json の読込前バイト上限。
 * PROVISIONAL：TG09 で確定・承認が必要な暫定値。
 */
export const PROVISIONAL_CONFIG_MAX_BYTES = 64 * KiB;
/** PROVISIONAL：設定 JSON の深度上限（第34.5節） */
export const PROVISIONAL_CONFIG_MAX_DEPTH = 16;

/**
 * 第34.5節：記事領域の列挙 1 要求の調査件数・時間。
 * PROVISIONAL：TG09 で確定・承認が必要な暫定値。
 */
export const PROVISIONAL_SCAN_MAX_ENTRIES = 20_000;
export const PROVISIONAL_SCAN_MAX_MS = 10_000;

/** 記事一覧の 1 ページの行数（第23.1節：全件 DOM 化を避ける） */
export const LIST_PAGE_SIZE = 100;
