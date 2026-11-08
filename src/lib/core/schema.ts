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

/**
 * 任意の標準項目（docs/knowledge/research/cms-comparison.md の P1）。
 * ない記事は今までどおりに扱い、ある場合だけ型と形式を検証する。足りなくても補わない。
 */
export const OPTIONAL_KEYS = ["description", "aliases", "revisedAt", "corrections", "authors"] as const;
export type OptionalKey = (typeof OPTIONAL_KEYS)[number];
/** フォームと検証で扱う項目（必須の標準項目と任意の標準項目） */
export type FieldKey = StandardKey | OptionalKey;

export function isOptionalKey(k: string): k is OptionalKey {
  return (OPTIONAL_KEYS as readonly string[]).includes(k);
}

/** 著者 ID の形式。人が読める ID にするため slug と同じ形式とする */
export const AUTHOR_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const AUTHOR_ID_MAX_LENGTH = 64;
export function isValidAuthorId(id: string): boolean {
  return id.length <= AUTHOR_ID_MAX_LENGTH && AUTHOR_ID_RE.test(id);
}

export const FIELD_LABELS: Record<FieldKey, string> = {
  id: "記事ID（id）",
  title: "タイトル（title）",
  slug: "slug",
  status: "原稿状態（status）",
  createdAt: "作成日時（createdAt）",
  updatedAt: "更新日時（updatedAt）",
  publishedAt: "公開日時（publishedAt）",
  tags: "タグ（tags）",
  cover: "カバー画像（cover）",
  description: "説明文（description）",
  aliases: "旧 slug（aliases）",
  revisedAt: "読者向けの更新日時（revisedAt）",
  corrections: "訂正・追記（corrections）",
  authors: "著者（authors）",
};

export type Status = "draft" | "published";

export interface Cover {
  readonly src: string;
  readonly alt: string;
  /** 任意。写真の説明 */
  readonly caption?: string;
  /** 任意。撮影者・提供元などのクレジット */
  readonly credit?: string;
}

/** 訂正・追記の 1 件 */
export interface Correction {
  readonly at: string;
  readonly note: string;
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
  description?: string;
  aliases?: string[];
  revisedAt?: string | null;
  corrections?: Correction[];
  authors?: string[];
}

export interface FieldError {
  readonly field: FieldKey;
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
    | "cover-src"
    | "alias"
    | "correction"
    | "author";
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
  const err = (field: FieldKey, code: FieldError["code"], message: string) => errors.push({ field, code, message });
  const get = (k: FieldKey) => getValueNode(root, k);

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
        const extra: { caption?: string; credit?: string } = {};
        for (const sub of ["caption", "credit"] as const) {
          const sn = getValueNode(n, sub);
          if (sn === undefined) continue;
          const sv = str(sn);
          if (sv === undefined) err("cover", "type", `cover.${sub} は文字列にしてください。`);
          else extra[sub] = sv;
        }
        values.cover = { src, alt, ...extra };
        if (!isSafeMediaRef(src))
          err("cover", "cover-src", "cover.src は当該記事の media/ 内の画像（./media/ファイル名）を指定してください。");
      }
    }
  }
  validateOptional(get, values, err);
  return { values, errors };
}

function stringList(n: YamlNode | null | undefined): { ok: true; items: string[] } | { ok: false } {
  if (!isSeq(n)) return { ok: false };
  const items: string[] = [];
  for (const it of n.items) {
    const v = str(it as YamlNode);
    if (v === undefined) return { ok: false };
    items.push(v);
  }
  return { ok: true, items };
}

function duplicates(items: readonly string[]): string[] {
  const seen = new Set<string>();
  return [...new Set(items.filter((t) => (seen.has(t) ? true : (seen.add(t), false))))];
}

function validateOptional(
  get: (k: FieldKey) => YamlNode | null | undefined,
  values: StandardValues,
  err: (field: FieldKey, code: FieldError["code"], message: string) => void,
): void {
  // description
  {
    const n = get("description");
    if (n !== undefined) {
      const v = str(n);
      if (v === undefined) err("description", "type", "description は文字列にしてください。");
      else values.description = v;
    }
  }
  // aliases：公開後に変えた旧 slug（フロントがリダイレクトを作る）
  {
    const n = get("aliases");
    if (n !== undefined) {
      const r = stringList(n);
      if (!r.ok) err("aliases", "type", "aliases は文字列の配列にしてください。");
      else {
        values.aliases = r.items;
        const bad = r.items.filter((a) => a === "" || checkSlugFormat(a, "published") !== null);
        if (bad.length > 0)
          err("aliases", "alias", `旧 slug の形式が不正です：${bad.map((b) => `「${b}」`).join("、")}`);
        const dup = duplicates(r.items);
        if (dup.length > 0) err("aliases", "alias", `重複した旧 slug があります：${dup.join("、")}`);
        if (values.slug !== undefined && values.slug !== "" && r.items.includes(values.slug))
          err(
            "aliases",
            "alias",
            `旧 slug に現在の slug（${values.slug}）が入っています。CMS で保存すると aliases から外します。`,
          );
      }
    }
  }
  // revisedAt
  {
    const n = get("revisedAt");
    if (n !== undefined) {
      if (isNull(n)) values.revisedAt = null;
      else {
        const v = str(n);
        if (v === undefined) err("revisedAt", "type", "revisedAt は日時の文字列または null にしてください。");
        else {
          values.revisedAt = v;
          if (!isValidDateTime(v))
            err("revisedAt", "datetime", "revisedAt の日時形式が不正です（例：2026-11-03T22:08:00+09:00）。");
        }
      }
    }
  }
  // corrections
  {
    const n = get("corrections");
    if (n !== undefined) {
      if (!isSeq(n)) err("corrections", "type", "corrections は at・note を持つマッピングの配列にしてください。");
      else {
        const list: Correction[] = [];
        let typeOk = true;
        for (const it of n.items) {
          if (!isMap(it)) {
            typeOk = false;
            break;
          }
          const at = str(getValueNode(it, "at"));
          const note = str(getValueNode(it, "note"));
          if (at === undefined || note === undefined) {
            typeOk = false;
            break;
          }
          list.push({ at, note });
        }
        if (!typeOk)
          err("corrections", "type", "corrections の各要素は、文字列の at・note を持つマッピングにしてください。");
        else {
          values.corrections = list;
          list.forEach((c, i) => {
            if (!isValidDateTime(c.at))
              err(
                "corrections",
                "datetime",
                `訂正・追記 ${i + 1} 件目の日時形式が不正です（例：2026-11-03T22:08:00+09:00）。`,
              );
            if (c.note.trim() === "") err("corrections", "correction", `訂正・追記 ${i + 1} 件目の内容が空です。`);
          });
        }
      }
    }
  }
  // authors：著者 ID の配列。先頭を主著者とする
  {
    const n = get("authors");
    if (n !== undefined) {
      const r = stringList(n);
      if (!r.ok) err("authors", "type", "authors は文字列の配列にしてください。");
      else {
        values.authors = r.items;
        const bad = r.items.filter((a) => !isValidAuthorId(a));
        if (bad.length > 0)
          err(
            "authors",
            "author",
            `著者 ID の形式が不正です（半角英小文字・数字とハイフン、${AUTHOR_ID_MAX_LENGTH}文字以内）：${bad.map((b) => `「${b}」`).join("、")}`,
          );
        const dup = duplicates(r.items);
        if (dup.length > 0) err("authors", "author", `重複した著者があります：${dup.join("、")}`);
      }
    }
  }
}
