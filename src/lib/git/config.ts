/**
 * リポジトリローカルの Git 設定（.git/config）の読み取りと、作者設定の明示保存（仕様 20.2.1・21.2）。
 *
 * - OS グローバル設定・親設定は参照しない。
 * - include／includeIf は追跡せず、存在を検出して Git 書き込みを止める。
 * - 書き込みは user.name・user.email の2キーだけ。他の行は原文のまま残す。
 */
import { GitError } from "./objects";

export interface ConfigEntry {
  /** 小文字の section（subsection は大文字小文字を保持して `section.sub` で表す） */
  readonly section: string;
  readonly subsection: string | null;
  readonly key: string;
  readonly value: string | null;
  readonly line: number;
}

export interface GitConfig {
  readonly entries: ConfigEntry[];
  readonly text: string;
}

function unquote(raw: string, line: number): string {
  let out = "";
  let inQ = false;
  let i = 0;
  // 先頭・末尾の空白は値に含めない（引用内は保持）
  let pendingSpace = "";
  for (; i < raw.length; i++) {
    const c = raw[i] as string;
    if (!inQ && (c === "#" || c === ";")) break;
    if (c === '"') {
      out += pendingSpace;
      pendingSpace = "";
      inQ = !inQ;
      continue;
    }
    if (c === "\\") {
      const n = raw[++i];
      out += pendingSpace;
      pendingSpace = "";
      if (n === "n") out += "\n";
      else if (n === "t") out += "\t";
      else if (n === "b") out = out.slice(0, -1);
      else if (n === '"' || n === "\\") out += n;
      else throw new GitError(`.git/config の ${line} 行目に不正なエスケープがあります。`);
      continue;
    }
    if (!inQ && (c === " " || c === "\t")) {
      if (out !== "") pendingSpace += c;
      continue;
    }
    out += pendingSpace + c;
    pendingSpace = "";
  }
  if (inQ) throw new GitError(`.git/config の ${line} 行目の引用符が閉じていません。`);
  return out;
}

export function parseConfig(text: string, maxEntries = 10_000): GitConfig {
  const entries: ConfigEntry[] = [];
  let section: string | null = null;
  let sub: string | null = null;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i] as string;
    const no = i + 1;
    // 行末のバックスラッシュによる継続
    while (/\\$/.test(line) && !/\\\\$/.test(line) && i + 1 < lines.length) line = line.slice(0, -1) + lines[++i];
    const t = line.trim();
    if (t === "" || t.startsWith("#") || t.startsWith(";")) continue;
    if (t.startsWith("[")) {
      const m = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\](.*)$/.exec(t);
      if (!m) throw new GitError(`.git/config の ${no} 行目の見出しが不正です。`);
      const name = (m[1] as string).toLowerCase();
      if (m[2] !== undefined) {
        section = name;
        sub = (m[2] as string).replace(/\\(.)/g, "$1");
      } else {
        const dot = name.indexOf(".");
        section = dot < 0 ? name : name.slice(0, dot);
        sub = dot < 0 ? null : (m[1] as string).slice(dot + 1);
      }
      const rest = (m[3] as string).trim();
      if (rest === "" || rest.startsWith("#") || rest.startsWith(";")) continue;
      line = rest;
    }
    if (section === null) throw new GitError(`.git/config の ${no} 行目が見出しの前にあります。`);
    const km = /^\s*([A-Za-z][A-Za-z0-9-]*)\s*(?:=(.*))?$/.exec(line);
    if (!km) throw new GitError(`.git/config の ${no} 行目を解釈できません。`);
    entries.push({
      section,
      subsection: sub,
      key: (km[1] as string).toLowerCase(),
      value: km[2] === undefined ? null : unquote(km[2], no),
      line: no,
    });
    if (entries.length > maxEntries) throw new GitError(".git/config の項目数が上限を超えています。", "budget");
  }
  return { entries, text };
}

/** `section.key` または `section.sub.key` の最後の値 */
export function getConfig(c: GitConfig, name: string): string | null | undefined {
  const parts = name.split(".");
  const section = (parts[0] as string).toLowerCase();
  const key = (parts.at(-1) as string).toLowerCase();
  const sub = parts.length > 2 ? parts.slice(1, -1).join(".") : null;
  let v: string | null | undefined;
  for (const e of c.entries) if (e.section === section && e.key === key && e.subsection === sub) v = e.value;
  return v;
}

export function configBool(v: string | null | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  if (v === null) return true;
  const s = v.toLowerCase();
  if (["true", "yes", "on", "1"].includes(s)) return true;
  if (["false", "no", "off", "0", ""].includes(s)) return false;
  return undefined;
}

function quote(v: string): string {
  const esc = v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return /^\s|\s$|[#;]/.test(v) || esc !== v ? `"${esc}"` : v;
}

/**
 * user.name・user.email を設定した新しい本文。既存の [user] の該当行を置き換え、
 * なければ最後の [user] に追記、[user] がなければ末尾に追加する。他の行は変えない。
 */
export function withUser(c: GitConfig, name: string, email: string): string {
  const lines = c.text.split("\n");
  const set = new Map<string, string>([
    ["name", name],
    ["email", email],
  ]);
  const userLines = c.entries.filter((e) => e.section === "user" && e.subsection === null);
  const done = new Set<string>();
  // 後ろの値が有効なので、各キーの最後の行を置き換える
  for (const key of ["name", "email"]) {
    const last = userLines.filter((e) => e.key === key).at(-1);
    if (last) {
      const orig = lines[last.line - 1] ?? "";
      if (orig.trim().startsWith("[") || /\\$/.test(orig))
        throw new GitError(".git/config の user 設定の書き方が複雑なため、自動では書き換えません。", "unsupported");
      lines[last.line - 1] = `\t${key} = ${quote(set.get(key) as string)}`;
      done.add(key);
    }
  }
  const missing = ["name", "email"].filter((k) => !done.has(k));
  if (missing.length > 0) {
    const add = missing.map((k) => `\t${k} = ${quote(set.get(k) as string)}`);
    let headerLine = -1;
    lines.forEach((l, i) => {
      if (/^\s*\[\s*user\s*\]\s*$/i.test(l)) headerLine = i;
    });
    if (headerLine >= 0) lines.splice(headerLine + 1, 0, ...add);
    else {
      if (lines.length > 0 && lines.at(-1) === "") lines.pop();
      lines.push("[user]", ...add, "");
    }
  }
  return lines.join("\n");
}
