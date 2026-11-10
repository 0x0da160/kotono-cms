/**
 * 復旧ドラフトの予約・退避・破棄・復旧候補（仕様 33）。
 *
 * - 既定で有効（ADR-0011：33.1 の事前の同意を、起動時のロック解除と暗号化に置き換えた）。「設定」で無効にできる。
 * - 本文は SealedDraftStore がロック解除の鍵（または作業場所の鍵）で暗号化して置く。
 * - 入力が 2 秒止まった時点、連続入力中でも最大 10 秒ごとに退避を試みる。IME 変換中は待つ（33.3）。
 * - 保存領域へ書き、読み直してチェックサムが一致したリビジョンだけを「退避済み」と表示する（33.3）。
 * - 破棄・保存成功・無効化との順序は保存領域のトランザクションで守る（store.ts・33.3.1）。
 */
import { DRAFT_IDLE_MS, DRAFT_MAX_INTERVAL_MS } from "../core/budgets";
import { encodeUtf8, sha256Hex } from "../core/bytes";
import { DRAFT_FORMAT_VERSION, type DraftRecord, type DraftStore } from "../drafts/store";
import type { EditorSession } from "./session.svelte";

export type DraftMode = "unavailable" | "enabled" | "disabled";

interface Timers {
  idle: ReturnType<typeof setTimeout> | null;
  max: ReturnType<typeof setTimeout> | null;
}

export class DraftController {
  mode = $state<DraftMode>("unavailable");
  /** 利用不可・失敗の理由（技術的に成立しない状態とユーザーの無効化を区別する：33.1） */
  reason = $state<string | null>(null);
  wsId = $state<string | null>(null);
  wsMatched = $state(false);
  wsPersisted = $state(false);
  records = $state<DraftRecord[]>([]);
  busy = $state(false);

  private lastSeq = 0;
  /** 発行済みの最大世代（破棄時に、それ以下の未完了要求を無効にする） */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- 画面に表示しない内部状態
  private issued = new Map<string, number>();
  private timers = new WeakMap<EditorSession, Timers>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- 画面に表示しない内部状態
  private inflight = new Set<Promise<unknown>>();

  constructor(
    private readonly store: DraftStore | null,
    private readonly appVersion: string,
    private readonly opts: { idleMs?: number; maxMs?: number; now?: () => number } = {},
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  nextSeq(): number {
    this.lastSeq = Math.max(this.now() * 1000, this.lastSeq + 1);
    return this.lastSeq;
  }

  async init(): Promise<void> {
    if (!this.store) {
      this.mode = "unavailable";
      this.reason = "このブラウザでは IndexedDB を利用できません。";
      return;
    }
    try {
      const e = await this.store.getEnabled();
      // 未設定（null）は有効にする（既定で有効：ADR-0011）。保存領域は有効の設定を見て書くので、設定も書いておく
      if (e === null) await this.store.setEnabled(true);
      this.mode = e === false ? "disabled" : "enabled";
      await this.store.expire(this.now());
      this.reason = null;
    } catch (e) {
      this.mode = "unavailable";
      this.reason = `ブラウザ内の保存領域を開けません（プライベートモード・保存の禁止等）：${e instanceof Error ? e.message : ""}`;
    }
  }

  /** 作業フォルダの識別（33.2：ランダム識別子、ハンドルの同一性で照合。フォルダ名では認定しない） */
  async attach(root: unknown, fixedId: string | null = null): Promise<void> {
    this.wsId = null;
    this.wsMatched = false;
    if (!this.store || this.mode !== "enabled") return;
    // ブラウザ内の作業場所は ID が決まっているので、ハンドルで照合しない（38.1）
    if (fixedId !== null) {
      this.wsId = fixedId;
      this.wsMatched = true;
      this.wsPersisted = true;
      await this.reload();
      return;
    }
    try {
      const id = await this.store.identify(root, sameEntry);
      this.wsId = id.id;
      this.wsMatched = id.matched;
      this.wsPersisted = id.persisted;
      await this.reload();
    } catch (e) {
      this.reason = `作業フォルダを識別できません：${e instanceof Error ? e.message : ""}`;
    }
  }

  async reload(): Promise<void> {
    if (!this.store || this.mode === "unavailable") return;
    try {
      this.records = await this.store.list();
    } catch (e) {
      this.reason = `復旧ドラフトの一覧を読めません：${e instanceof Error ? e.message : ""}`;
    }
  }

  async enable(): Promise<void> {
    if (!this.store) return;
    await this.store.setEnabled(true);
    this.mode = "enabled";
  }

  /** 無効化（33.3.1）：以後の予約を止め、未完了の退避を待ってから無効を確定する */
  async disable(removeExisting: boolean): Promise<void> {
    if (!this.store) return;
    this.busy = true;
    try {
      this.mode = "disabled";
      await Promise.allSettled([...this.inflight]);
      // put と同じトランザクションで有効設定を読むため、この後に完了する古い要求は保存されない
      await this.store.setEnabled(false);
      if (removeExisting) await this.store.removeAll();
      await this.reload();
    } finally {
      this.busy = false;
    }
  }

  static keyOf(s: EditorSession): string {
    return s.isNew ? `n:${s.draftTempKey}` : `a:${s.id}`;
  }

  // -------------------------------------------------------------------------
  // 予約

  onEdit(s: EditorSession): void {
    if (this.mode !== "enabled" || this.wsId === null) return;
    if (s.readOnlyReason !== null || !s.dirty) {
      this.cancel(s);
      return;
    }
    const t = this.timers.get(s) ?? { idle: null, max: null };
    if (t.idle) clearTimeout(t.idle);
    t.idle = setTimeout(() => void this.fire(s), this.opts.idleMs ?? DRAFT_IDLE_MS);
    t.max ??= setTimeout(() => void this.fire(s), this.opts.maxMs ?? DRAFT_MAX_INTERVAL_MS);
    this.timers.set(s, t);
    if (s.draft.kind !== "failed") s.draft = { kind: "pending" };
  }

  cancel(s: EditorSession): void {
    const t = this.timers.get(s);
    if (t?.idle) clearTimeout(t.idle);
    if (t?.max) clearTimeout(t.max);
    this.timers.delete(s);
  }

  private fire(s: EditorSession): Promise<void> {
    this.cancel(s);
    if (s.composing) {
      // 確定済みのスナップショットまでを扱う
      const t: Timers = { idle: setTimeout(() => void this.fire(s), 500), max: null };
      this.timers.set(s, t);
      return Promise.resolve();
    }
    return this.flush(s);
  }

  /** いまの内容を退避する（試験・離脱前にも使う） */
  async flush(s: EditorSession): Promise<void> {
    const store = this.store;
    const ws = this.wsId;
    if (!store || ws === null || this.mode !== "enabled" || !s.dirty || s.readOnlyReason !== null) return;
    const text = s.text;
    const revision = s.revision;
    const key = DraftController.keyOf(s);
    const seq = this.nextSeq();
    this.issued.set(`${ws}\u0000${key}`, seq);
    const p = (async () => {
      const bytes = encodeUtf8(text);
      const rec: DraftRecord = {
        ws,
        key,
        seq,
        articleId: s.id,
        isNew: s.isNew,
        revision,
        sessionNonce: s.draftNonce,
        baseHash: s.base?.hash ?? null,
        savedAt: this.now(),
        appVersion: this.appVersion,
        formatVersion: DRAFT_FORMAT_VERSION,
        size: bytes.length,
        checksum: await sha256Hex(bytes),
        text,
      };
      try {
        const out = await store.put(rec);
        if (out.kind === "stored") {
          if (await store.verify(ws, key, seq, rec.checksum)) {
            if (s.draft.kind !== "saved" || s.draft.revision <= revision)
              s.draft = { kind: "saved", revision, at: rec.savedAt };
          } else s.draft = this.failed(s, "退避した内容を読み直せませんでした。");
        } else if (out.kind === "quota") s.draft = this.failed(s, out.message);
        await this.reload();
      } catch (e) {
        s.draft = this.failed(s, `ブラウザ内へ退避できませんでした：${e instanceof Error ? e.message : ""}`);
      }
    })();
    this.inflight.add(p);
    try {
      await p;
    } finally {
      this.inflight.delete(p);
    }
  }

  private failed(s: EditorSession, message: string): EditorSession["draft"] {
    const prev = s.draft.kind === "saved" ? s.draft : null;
    return { kind: "failed", message, lastRevision: prev?.revision ?? null, lastAt: prev?.at ?? null };
  }

  // -------------------------------------------------------------------------
  // 破棄・保存成功（33.3.1）

  /** 明示破棄：発行済みのすべての世代を無効にして消す */
  async discard(s: EditorSession): Promise<void> {
    this.cancel(s);
    s.draft = { kind: "none" };
    const store = this.store;
    const ws = this.wsId;
    if (!store || ws === null || this.mode === "unavailable") return;
    const key = DraftController.keyOf(s);
    const upTo = Math.max(this.issued.get(`${ws}\u0000${key}`) ?? 0, this.nextSeq());
    await store.discard(ws, key, upTo);
    await this.reload();
  }

  /** リポジトリ保存成功：保存したリビジョン以下だけを消す（後続編集の世代は保持） */
  async saved(s: EditorSession, revision: number, keyBeforeSave: string): Promise<void> {
    const store = this.store;
    const ws = this.wsId;
    if (!store || ws === null || this.mode === "unavailable") return;
    await store.markSaved(ws, keyBeforeSave, s.draftNonce, revision);
    if (!s.dirty) {
      this.cancel(s);
      s.draft = { kind: "none" };
    }
    await this.reload();
  }

  async remove(rec: DraftRecord): Promise<void> {
    if (!this.store) return;
    await this.store.remove(rec.ws, rec.key, rec.seq);
    await this.reload();
  }
}

async function sameEntry(a: unknown, b: unknown): Promise<boolean> {
  const x = a as { isSameEntry?: (o: unknown) => Promise<boolean> };
  if (typeof x?.isSameEntry !== "function") return false;
  return x.isSameEntry(b);
}
