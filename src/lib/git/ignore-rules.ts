/**
 * .gitignore・.git/info/exclude の判定（仕様 21.1：無視対象を自動で強制追加しない）。
 * OS グローバルの除外設定（core.excludesFile）は参照しない（20.2.1）。
 */
import ignore, { type Ignore } from "ignore";
import { PROVISIONAL_GIT_RULES_MAX_BYTES } from "../core/budgets";
import { GitFs } from "./gitfs";

const dec = new TextDecoder();

export class IgnoreRules {
  #levels = new Map<string, Ignore | null>();
  constructor(readonly fs: GitFs) {}

  async #level(base: string): Promise<Ignore | null> {
    if (this.#levels.has(base)) return this.#levels.get(base) ?? null;
    const texts: string[] = [];
    const add = async (p: string) => {
      const b = await this.fs.readOrNull(p, PROVISIONAL_GIT_RULES_MAX_BYTES, "無視規則");
      if (b) texts.push(dec.decode(b));
    };
    if (base === "") await add(".git/info/exclude");
    await add(base === "" ? ".gitignore" : `${base}/.gitignore`);
    const ig = texts.length > 0 ? ignore().add(texts.join("\n")) : null;
    this.#levels.set(base, ig);
    return ig;
  }

  async #match(path: string, isDir: boolean): Promise<boolean> {
    const parts = path.split("/");
    let res = false;
    for (let i = 0; i < parts.length; i++) {
      const ig = await this.#level(parts.slice(0, i).join("/"));
      if (!ig) continue;
      const rel = parts.slice(i).join("/") + (isDir ? "/" : "");
      const t = ig.test(rel);
      if (t.ignored) res = true;
      else if (t.unignored) res = false;
    }
    return res;
  }

  /** 祖先フォルダが無視されていれば、その中も無視（Git は無視フォルダの中を見ない） */
  async ignored(path: string, isDir = false): Promise<boolean> {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) if (await this.#match(parts.slice(0, i).join("/"), true)) return true;
    return this.#match(path, isDir);
  }
}
