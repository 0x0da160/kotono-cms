/** tree・commit の解析と生成（仕様 21）。 */
import { GitError, hex, OID_RE, unhex } from "./objects";

const enc = new TextEncoder();
const strict = new TextDecoder("utf-8", { fatal: true });

export interface TreeItem {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export const MODE_FILE = "100644";
export const MODE_EXEC = "100755";
export const MODE_LINK = "120000";
export const MODE_TREE = "40000";
export const MODE_GITLINK = "160000";

export function parseTree(data: Uint8Array): TreeItem[] {
  const out: TreeItem[] = [];
  let p = 0;
  while (p < data.length) {
    const sp = data.indexOf(0x20, p);
    const nul = data.indexOf(0, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) throw new GitError("tree object が不正です。");
    const mode = String.fromCharCode(...data.subarray(p, sp));
    let name: string;
    try {
      name = strict.decode(data.subarray(sp + 1, nul));
    } catch {
      throw new GitError("tree に UTF-8 でない名前があります。", "unsupported");
    }
    if (!/^[0-7]{5,6}$/.test(mode)) throw new GitError("tree の mode が不正です。");
    out.push({ mode, name, oid: hex(data.subarray(nul + 1, nul + 21)) });
    p = nul + 21;
  }
  return out;
}

/** Git の tree 内の並び順（フォルダは名前の後ろに `/` を付けて比べる） */
export function treeSortKey(name: string, isTree: boolean): Uint8Array {
  return enc.encode(isTree ? `${name}/` : name);
}

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  return a.length - b.length;
}

export function serializeTree(items: readonly TreeItem[]): Uint8Array {
  const sorted = [...items].sort((x, y) =>
    compareBytes(treeSortKey(x.name, x.mode === MODE_TREE), treeSortKey(y.name, y.mode === MODE_TREE)),
  );
  const parts: Uint8Array[] = [];
  let n = 0;
  for (const it of sorted) {
    const head = enc.encode(`${it.mode} ${it.name}\0`);
    parts.push(head, unhex(it.oid));
    n += head.length + 20;
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export interface Signature {
  readonly name: string;
  readonly email: string;
  /** UNIX 秒 */
  readonly time: number;
  /** UTC からの分（+09:00 なら 540） */
  readonly tzMinutes: number;
}

export interface Commit {
  readonly tree: string;
  readonly parents: string[];
  readonly author: Signature | null;
  readonly committer: Signature | null;
  readonly message: string;
  readonly signed: boolean;
  /** 未対応の encoding 指定など */
  readonly encoding: string | null;
}

function parseSig(s: string): Signature | null {
  const m = /^(.*) <([^<>]*)> (\d+) ([+-])(\d{2})(\d{2})$/.exec(s);
  if (!m) return null;
  const tz = (Number(m[5]) * 60 + Number(m[6])) * (m[4] === "-" ? -1 : 1);
  return { name: m[1] as string, email: m[2] as string, time: Number(m[3]), tzMinutes: tz };
}

export function parseCommit(data: Uint8Array): Commit {
  let s: string;
  try {
    s = strict.decode(data);
  } catch {
    s = new TextDecoder().decode(data);
  }
  const blank = s.indexOf("\n\n");
  const head = blank < 0 ? s : s.slice(0, blank);
  const message = blank < 0 ? "" : s.slice(blank + 2);
  let tree = "";
  const parents: string[] = [];
  let author: Signature | null = null;
  let committer: Signature | null = null;
  let signed = false;
  let encoding: string | null = null;
  for (const line of head.split("\n")) {
    if (line.startsWith(" ")) continue; // 複数行ヘッダーの継続（gpgsig・mergetag）
    const sp = line.indexOf(" ");
    const k = sp < 0 ? line : line.slice(0, sp);
    const v = sp < 0 ? "" : line.slice(sp + 1);
    if (k === "tree") tree = v;
    else if (k === "parent") parents.push(v);
    else if (k === "author") author = parseSig(v);
    else if (k === "committer") committer = parseSig(v);
    else if (k === "gpgsig" || k === "gpgsig-sha256") signed = true;
    else if (k === "encoding") encoding = v;
  }
  if (!OID_RE.test(tree) || !parents.every((p) => OID_RE.test(p))) throw new GitError("commit object が不正です。");
  return { tree, parents, author, committer, message, signed, encoding };
}

function tz(min: number): string {
  const sign = min < 0 ? "-" : "+";
  const a = Math.abs(min);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, "0")}${String(a % 60).padStart(2, "0")}`;
}

export function formatSig(s: Signature): string {
  return `${s.name} <${s.email}> ${s.time} ${tz(s.tzMinutes)}`;
}

/** 作者名・メールの検証（21.2）。Git のヘッダーを壊す文字を拒否する */
export function checkIdentity(name: string, email: string): string | null {
  const n = name.trim();
  const e = email.trim();
  if (n === "") return "作者名を入力してください。";
  if (e === "") return "メールアドレスを入力してください。";
  // eslint-disable-next-line no-control-regex -- 制御文字を拒否する
  if (/[<>\u0000-\u001f\u007f]/.test(n) || /[<>\s\u0000-\u001f\u007f]/.test(e))
    return "作者名・メールに使えない文字（< > 改行・制御文字）が含まれています。";
  if (n.length > 256 || e.length > 256) return "作者名・メールが長すぎます。";
  return null;
}

export function serializeCommit(c: {
  tree: string;
  parents: readonly string[];
  author: Signature;
  committer: Signature;
  message: string;
}): Uint8Array {
  let s = `tree ${c.tree}\n`;
  for (const p of c.parents) s += `parent ${p}\n`;
  s += `author ${formatSig(c.author)}\ncommitter ${formatSig(c.committer)}\n\n`;
  s += c.message.endsWith("\n") ? c.message : `${c.message}\n`;
  return enc.encode(s);
}

/** コミットメッセージの検証（21.1：必須・空白だけは禁止） */
export function checkMessage(m: string): string | null {
  if (m.trim() === "") return "コミットメッセージを入力してください（空白だけは使えません）。";
  // eslint-disable-next-line no-control-regex -- NUL は Git object を壊す
  if (/\u0000/.test(m)) return "コミットメッセージに使えない文字があります。";
  if (m.length > 64 * 1024) return "コミットメッセージが長すぎます。";
  return null;
}

/** 末尾空白・連続空行を Git の既定（cleanup=strip に近い形）で整える */
export function cleanMessage(m: string): string {
  const lines = m
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""));
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  const out: string[] = [];
  for (const l of lines) if (!(l === "" && out.at(-1) === "")) out.push(l);
  return `${out.join("\n")}\n`;
}
