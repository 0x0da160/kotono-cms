/**
 * frontmatter の標準スキーマ（仕様 第6章・7章・24章）。
 * 下書きでも標準項目の存在と型は必須。未知フィールドだけを理由に保存を止めない。
 * 足りない値を勝手に補わない。
 */
import { isMap, isScalar, isSeq, type Node as YamlNode, type YAMLMap } from "yaml";
import { isValidArticleId } from "./article-id";
import { isValidDateTime } from "./datetime";
import { checkSlugFormat, slugProblemMessage } from "./slug";
import { getValueNode } from "./yaml-doc";

export const STANDARD_KEYS = [
  "id",
  "title",
  "slug",
  "status",
  "createdAt",
  "updatedAt",
  "publishedAt",
  "tags",
  "cover",
] as const;
export type StandardKey = (typeof STANDARD_KEYS)[number];

export const FIELD_LABELS: Record<StandardKey, string> = {
  id: "記事ID（id）",
  title: "タイトル（title）",
  slug: "slug",
  status: "原稿状態（status）",
  createdAt: "作成日時（createdAt）",
  updatedAt: "更新日時（updatedAt）",
  publishedAt: "公開日時（publishedAt）",
  tags: "タグ（tags）",
  cover: "カバー画像（cover）",
};

export type Status = "draft" | "published";

export interface Cover {
  readonly src: string;
  readonly alt: string;
}

/** 型として読み取れた標準値。読み取れない項目は undefined。 */
export interface StandardValues {
  id?: string;
  title?: string;
  slug?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  publishedAt?: string | null;
  tags?: string[];
  cover?: Cover | null;
}

export interface FieldError {
  readonly field: StandardKey;
  readonly code:
    | "missing"
    | "type"
    | "id-format"
    | "id-mismatch"
    | "title-required"
    | "slug"
    | "status"
    | "datetime"
    | "published-at-required"
    | "tag-empty"
    | "tag-duplicate"
    | "cover-src";
  readonly message: string;
}

export interface SchemaResult {
  readonly values: StandardValues;
  readonly errors: FieldError[];
}

function str(node: YamlNode | null | undefined): string | undefined {
  return isScalar(node) && typeof node.value === "string" ? node.value : undefined;
}

function isNull(node: YamlNode | null | undefined): boolean {
  return node === null || (isScalar(node) && node.value === null);
}

/**
 * coverが当該記事の media/ 内のローカル画像を指すか（仕様 6・16.2）。
 * 文字列パスとして `./media/<ファイル名>` だけを許可する。区切り文字、ドット区間、
 * URL エンコード（%）、スキーム・クエリ・フラグメント、制御文字は拒否する。
 */
export function isSafeMediaRef(src: string): boolean {
  const prefix = "./media/";
  if (!src.startsWith(prefix)) return false;
  const name = src.slice(prefix.length);
  if (name === "" || name === "." || name === "..") return false;
  return !/[/\\%:?#\p{Cc}]/u.test(name) && name.trim() === name;
}

export function validateStandard(root: YAMLMap, folderId: string | null): SchemaResult {
  const values: StandardValues = {};
  const errors: FieldError[] = [];
  const err = (field: StandardKey, code: FieldError["code"], message: string) => errors.push({ field, code, message });
  const get = (k: StandardKey) => getValueNode(root, k);

  // id
  {
    const n = get("id");
    const v = str(n);
    if (n === undefined) err("id", "missing", "id がありません。");
    else if (v === undefined) err("id", "type", "id は文字列にしてください。");
    else {
      values.id = v;
      if (!isValidArticleId(v)) err("id", "id-format", "id の文字種・長さが不正です（7〜32文字の小文字Base32）。");
      else if (folderId !== null && v !== folderId)
        err("id", "id-mismatch", `id（${v}）が記事フォルダ名（${folderId}）と一致しません。`);
    }
  }
  // status（title・slug・publishedAt の条件に使うので先に読む）
  {
    const n = get("status");
    const v = str(n);
    if (n === undefined) err("status", "missing", "status がありません。");
    else if (v === undefined) err("status", "type", "status は文字列にしてください。");
    else {
      values.status = v;
      if (v !== "draft" && v !== "published")
        err("status", "status", "status は draft または published にしてください。");
    }
  }
  const published = values.status === "published";
  // title
  {
    const n = get("title");
    const v = str(n);
    if (n === undefined) err("title", "missing", "title がありません。");
    else if (v === undefined) err("title", "type", "title は文字列にしてください。");
    else {
      values.title = v;
      if (published && v.trim() === "") err("title", "title-required", "公開対象の記事にはタイトルが必要です。");
    }
  }
  // slug
  {
    const n = get("slug");
    const v = str(n);
    if (n === undefined) err("slug", "missing", "slug がありません。");
    else if (v === undefined) err("slug", "type", "slug は文字列にしてください。");
    else {
      values.slug = v;
      const p = checkSlugFormat(v, values.status ?? "draft");
      if (p) err("slug", "slug", slugProblemMessage(p));
    }
  }
  // createdAt・updatedAt
  for (const k of ["createdAt", "updatedAt"] as const) {
    const n = get(k);
    const v = str(n);
    if (n === undefined) err(k, "missing", `${k} がありません。`);
    else if (v === undefined) err(k, "type", `${k} は日時の文字列にしてください。`);
    else {
      values[k] = v;
      if (!isValidDateTime(v)) err(k, "datetime", `${k} の日時形式が不正です（例：2026-11-03T22:08:00+09:00）。`);
    }
  }
  // publishedAt
  {
    const n = get("publishedAt");
    if (n === undefined) err("publishedAt", "missing", "publishedAt がありません。");
    else if (isNull(n)) {
      values.publishedAt = null;
      if (published) err("publishedAt", "published-at-required", "公開対象の記事には公開日時が必要です。");
    } else {
      const v = str(n);
      if (v === undefined) err("publishedAt", "type", "publishedAt は日時の文字列または null にしてください。");
      else {
        values.publishedAt = v;
        if (!isValidDateTime(v))
          err("publishedAt", "datetime", "publishedAt の日時形式が不正です（例：2026-11-03T22:08:00+09:00）。");
      }
    }
  }
  // tags
  {
    const n = get("tags");
    if (n === undefined) err("tags", "missing", "tags がありません。");
    else if (!isSeq(n)) err("tags", "type", "tags は文字列の配列にしてください。");
    else {
      const tags: string[] = [];
      let typeOk = true;
      for (const it of n.items) {
        const v = str(it as YamlNode);
        if (v === undefined) typeOk = false;
        else tags.push(v);
      }
      if (!typeOk) err("tags", "type", "tags の要素はすべて文字列にしてください。");
      else {
        values.tags = tags;
        if (tags.some((t) => t.trim() === "")) err("tags", "tag-empty", "空、または空白だけのタグがあります。");
        const seen = new Set<string>();
        const dup = tags.filter((t) => (seen.has(t) ? true : (seen.add(t), false)));
        if (dup.length > 0) err("tags", "tag-duplicate", `重複したタグがあります：${[...new Set(dup)].join("、")}`);
      }
    }
  }
  // cover
  {
    const n = get("cover");
    if (n === undefined) err("cover", "missing", "cover がありません。");
    else if (isNull(n)) values.cover = null;
    else if (!isMap(n)) err("cover", "type", "cover は null または src・alt を持つマッピングにしてください。");
    else {
      const src = str(getValueNode(n, "src"));
      const alt = str(getValueNode(n, "alt"));
      if (src === undefined || alt === undefined) err("cover", "type", "cover.src・cover.alt は文字列にしてください。");
      else {
        values.cover = { src, alt };
        if (!isSafeMediaRef(src))
          err("cover", "cover-src", "cover.src は当該記事の media/ 内の画像（./media/ファイル名）を指定してください。");
      }
    }
  }
  return { values, errors };
}
