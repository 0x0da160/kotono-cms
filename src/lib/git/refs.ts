/** HEAD・ref・packed-refs・reflog（仕様 20.2・20.2.1・21.4・34.5）。 */
import {
  PROVISIONAL_GIT_MAX_REFS,
  PROVISIONAL_GIT_PACKED_REFS_MAX_BYTES,
  PROVISIONAL_GIT_REF_MAX_BYTES,
} from "../core/budgets";
import { GitFs } from "./gitfs";
import { GitError, OID_RE } from "./objects";
import { formatSig, type Signature } from "./model";

const dec = new TextDecoder();
const enc = new TextEncoder();

/** ref 名の検証（git check-ref-format の主要規則。20.2.1：不正 ref 名を拒否） */
export function validRefName(name: string): boolean {
  if (name.length === 0 || name.length > 1024) return false;
  if (name === "@" || name.endsWith("/") || name.endsWith(".") || name.includes("..") || name.includes("@{"))
    return false;
  // eslint-disable-next-line no-control-regex -- 制御文字を拒否する
  if (/[\u0000- \u007f~^:?*[\\]/.test(name)) return false;
  for (const c of name.split("/")) if (c === "" || c.startsWith(".") || c.endsWith(".lock")) return false;
  return true;
}

export type Head =
  | { kind: "branch"; ref: string; branch: string; oid: string | null }
  | { kind: "detached"; oid: string }
  | { kind: "invalid"; message: string };

export class Refs {
  #packed: Map<string, string> | null = null;
  constructor(readonly fs: GitFs) {}

  reset() {
    this.#packed = null;
  }

  async #packedRefs(): Promise<Map<string, string>> {
    if (this.#packed) return this.#packed;
    const bytes = await this.fs.readOrNull(".git/packed-refs", PROVISIONAL_GIT_PACKED_REFS_MAX_BYTES, "packed-refs");
    const m = new Map<string, string>();
    if (bytes) {
      for (const line of dec.decode(bytes).split("\n")) {
        if (line === "" || line.startsWith("#") || line.startsWith("^")) continue;
        const [oid, name] = line.split(" ");
        if (!oid || !name || !OID_RE.test(oid) || !validRefName(name))
          throw new GitError("packed-refs に不正な行があります。");
        m.set(name, oid);
        if (m.size > PROVISIONAL_GIT_MAX_REFS) throw new GitError("ref の数が上限を超えています。", "budget");
      }
    }
    this.#packed = m;
    return m;
  }

  async #readLoose(ref: string): Promise<string | null> {
    const bytes = await this.fs.readOrNull(`.git/${ref}`, PROVISIONAL_GIT_REF_MAX_BYTES, "ref");
    return bytes ? dec.decode(bytes).trim() : null;
  }

  /** ref を object ID へ解決する。存在しなければ null（初回コミット前のブランチ） */
  async resolve(ref: string, depth = 0): Promise<string | null> {
    if (depth > 5) throw new GitError("シンボリック ref の連鎖が深すぎます。");
    if (!validRefName(ref)) throw new GitError(`不正な ref 名です（${ref}）。`);
    const loose = await this.#readLoose(ref);
    if (loose !== null) {
      if (OID_RE.test(loose)) return loose;
      if (loose.startsWith("ref: ")) return this.resolve(loose.slice(5), depth + 1);
      throw new GitError(`ref ${ref} の内容が不正です。`);
    }
    return (await this.#packedRefs()).get(ref) ?? null;
  }

  async head(): Promise<Head> {
    const bytes = await this.fs.readOrNull(".git/HEAD", PROVISIONAL_GIT_REF_MAX_BYTES, "HEAD");
    if (!bytes) return { kind: "invalid", message: ".git/HEAD がありません。" };
    const s = dec.decode(bytes).trim();
    if (OID_RE.test(s)) return { kind: "detached", oid: s };
    if (!s.startsWith("ref: ")) return { kind: "invalid", message: ".git/HEAD の内容が不正です。" };
    const ref = s.slice(5);
    if (!validRefName(ref) || !ref.startsWith("refs/heads/"))
      return { kind: "invalid", message: `HEAD が通常のブランチを指していません（${ref}）。` };
    return { kind: "branch", ref, branch: ref.slice("refs/heads/".length), oid: await this.resolve(ref) };
  }

  /** ブランチ・タグ名の一覧（表示用） */
  async branches(): Promise<string[]> {
    const names = new Set<string>();
    const walk = async (dir: string, prefix: string) => {
      const list = (await this.fs.list(dir, PROVISIONAL_GIT_MAX_REFS)) ?? [];
      for (const e of list) {
        if (e.kind === "dir") await walk(`${dir}/${e.name}`, `${prefix}${e.name}/`);
        else if (!e.name.endsWith(".lock")) names.add(`${prefix}${e.name}`);
        if (names.size > PROVISIONAL_GIT_MAX_REFS) throw new GitError("ref の数が上限を超えています。", "budget");
      }
    };
    await walk(".git/refs/heads", "");
    for (const k of (await this.#packedRefs()).keys()) if (k.startsWith("refs/heads/")) names.add(k.slice(11));
    return [...names].sort();
  }

  /**
   * ブランチ ref を更新する。現在値が期待値と違えば止める。
   * 非保証：比較と書き込みの間の外部 Git とは排他できない（21.3：外部 Git の同時実行は禁止運用）。
   */
  async update(ref: string, next: string, expected: string | null): Promise<void> {
    if (!validRefName(ref) || !ref.startsWith("refs/heads/")) throw new GitError("ブランチ以外の ref は更新しません。");
    if ((await this.fs.kind(`.git/${ref}.lock`)) !== "missing")
      throw new GitError(`${ref}.lock があります。外部の Git が処理中の可能性があるため止めました。`, "io");
    this.#packed = null;
    const cur = await this.resolve(ref);
    if (cur !== expected) throw new GitError("ブランチの位置が確認時から変わっています。", "io");
    await this.fs.replace(`.git/${ref}`, enc.encode(`${next}\n`), { create: true });
  }

  /** reflog が既にあれば追記する（なければ作らない）。大きすぎる場合は追記しない */
  async appendReflog(
    ref: string,
    oldOid: string | null,
    newOid: string,
    who: Signature,
    msg: string,
  ): Promise<boolean> {
    const line = `${oldOid ?? "0".repeat(40)} ${newOid} ${formatSig(who)}\t${msg.split("\n")[0]}\n`;
    let all = true;
    for (const path of [`.git/logs/${ref}`, ".git/logs/HEAD"]) {
      const cur = await this.fs.read(path, 4 * 1048576);
      if (cur.kind !== "bytes") {
        if (cur.kind !== "missing") all = false;
        continue;
      }
      const add = enc.encode(line);
      const out = new Uint8Array(cur.bytes.length + add.length);
      out.set(cur.bytes, 0);
      out.set(add, cur.bytes.length);
      try {
        await this.fs.replace(path, out);
      } catch {
        all = false;
      }
    }
    return all;
  }
}
