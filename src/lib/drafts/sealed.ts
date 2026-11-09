/**
 * 暗号化した作業場所の復旧ドラフト（仕様 3.2 第39.1節）。
 *
 * 下の保存領域（IndexedDB）には、記事ID・キー・本文・ハッシュを暗号化して置く。
 * - 作業場所のドラフトの ws は `e:<作業場所ID>`。解錠中だけ暗号化の道具（Sealer）を登録する。
 * - キーとチェックサムは HMAC で置き換え（照合に使えるが元に戻せない）、本体は AES-GCM で包む。
 * - ロック中の作業場所のドラフトは一覧に出さない（消さない）。
 * 世代・破棄・保存成功の順序の保証は下の保存領域のものをそのまま使う。
 *
 * それ以外（実フォルダ・暗号化しない作業場所）のドラフトは、ログイン鍵の道具（既定の Sealer）で同じように包む（ADR-0011）。
 * ログインしていない間は書かず、一覧にも出さない。以前の版の平文のドラフトは、ログインしたときに包み直す。
 */
import type { DraftRecord, DraftStore, PutOutcome, WorkspaceIdentity } from "./store";

export interface Sealer {
  /** 決定的な置き換え（照合用） */
  tag(s: string): Promise<string>;
  seal(plain: string): Promise<string>;
  open(sealed: string): Promise<string | null>;
}

export const SEALED_WS_PREFIX = "e:";
/** 包んだドラフトのキーの接頭辞（以前の版の平文のキーは `a:`・`n:`） */
const SEALED_KEY_PREFIX = "s:";

interface Inner {
  key: string;
  articleId: string;
  checksum: string;
  baseHash: string | null;
  text: string;
}

export class SealedDraftStore implements DraftStore {
  private readonly sealers = new Map<string, Sealer>();
  /** ログイン鍵の道具。ログインしていなければ null */
  private fallback: Sealer | null = null;

  constructor(private readonly base: DraftStore) {}

  register(ws: string, s: Sealer): void {
    this.sealers.set(ws, s);
  }

  unregister(ws: string): void {
    this.sealers.delete(ws);
  }

  /**
   * ログイン鍵の道具を置く（null で外す）。置いたときは、以前の版の平文のドラフトを包み直す。
   * 包み直した件数を返す。
   */
  async setDefault(s: Sealer | null): Promise<number> {
    this.fallback = s;
    if (!s) return 0;
    let n = 0;
    for (const r of await this.base.list()) {
      if (r.ws.startsWith(SEALED_WS_PREFIX) || r.key.startsWith(SEALED_KEY_PREFIX)) continue;
      const out = await this.put(r);
      if (out.kind === "stored") {
        await this.base.remove(r.ws, r.key, r.seq);
        n++;
      }
    }
    return n;
  }

  get unlocked(): boolean {
    return this.fallback !== null;
  }

  private sealerOf(ws: string): Sealer {
    if (!ws.startsWith(SEALED_WS_PREFIX)) {
      if (!this.fallback) throw new Error("ログインしていないため、復旧ドラフトを扱えません。");
      return this.fallback;
    }
    const s = this.sealers.get(ws);
    if (!s) throw new Error("この作業場所はロックされています。");
    return s;
  }

  private async mapKey(ws: string, key: string): Promise<string> {
    const s = this.sealerOf(ws);
    return `${SEALED_KEY_PREFIX}${await s.tag(`key\0${key}`)}`;
  }

  getEnabled(): Promise<boolean | null> {
    return this.base.getEnabled();
  }

  setEnabled(enabled: boolean): Promise<void> {
    return this.base.setEnabled(enabled);
  }

  async put(rec: DraftRecord): Promise<PutOutcome> {
    const s = this.sealerOf(rec.ws);
    const inner: Inner = {
      key: rec.key,
      articleId: rec.articleId,
      checksum: rec.checksum,
      baseHash: rec.baseHash,
      text: rec.text,
    };
    return this.base.put({
      ...rec,
      key: await this.mapKey(rec.ws, rec.key),
      articleId: "",
      baseHash: null,
      checksum: await s.tag(`sum\0${rec.checksum}`),
      text: await s.seal(JSON.stringify(inner)),
    });
  }

  async verify(ws: string, key: string, seq: number, checksum: string): Promise<boolean> {
    const s = this.sealerOf(ws);
    return this.base.verify(ws, await this.mapKey(ws, key), seq, await s.tag(`sum\0${checksum}`));
  }

  async discard(ws: string, key: string, upToSeq: number): Promise<void> {
    return this.base.discard(ws, await this.mapKey(ws, key), upToSeq);
  }

  async markSaved(ws: string, key: string, sessionNonce: string, revision: number): Promise<void> {
    return this.base.markSaved(ws, await this.mapKey(ws, key), sessionNonce, revision);
  }

  async remove(ws: string, key: string, seq: number): Promise<void> {
    return this.base.remove(ws, await this.mapKey(ws, key), seq);
  }

  removeAll(): Promise<void> {
    return this.base.removeAll();
  }

  async list(): Promise<DraftRecord[]> {
    const out: DraftRecord[] = [];
    for (const r of await this.base.list()) {
      // ログイン前に残っていた平文の記録（以前の版）は、包み直すまで出さない
      if (!r.key.startsWith(SEALED_KEY_PREFIX)) continue;
      const s = r.ws.startsWith(SEALED_WS_PREFIX) ? this.sealers.get(r.ws) : this.fallback;
      if (!s) continue;
      const inner = parseInner(await s.open(r.text));
      // 復号できない・形式の違う記録は一覧へ出さない（改ざん・別の鍵：39.3）
      if (!inner || (await s.tag(`key\0${inner.key}`)) !== r.key.slice(2)) continue;
      out.push({ ...r, ...inner });
    }
    return out;
  }

  expire(now: number): Promise<number> {
    return this.base.expire(now);
  }

  identify(root: unknown, isSame: (a: unknown, b: unknown) => Promise<boolean>): Promise<WorkspaceIdentity> {
    return this.base.identify(root, isSame);
  }
}

function parseInner(s: string | null): Inner | null {
  if (s === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(s);
  } catch {
    return null;
  }
  const o = v as Partial<Inner>;
  if (
    typeof o?.key !== "string" ||
    typeof o.articleId !== "string" ||
    typeof o.checksum !== "string" ||
    typeof o.text !== "string" ||
    !(o.baseHash === null || typeof o.baseHash === "string")
  )
    return null;
  return { key: o.key, articleId: o.articleId, checksum: o.checksum, baseHash: o.baseHash, text: o.text };
}
