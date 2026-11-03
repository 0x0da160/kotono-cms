/**
 * 1記事の編集セッション（仕様 11・13・14）。
 *
 * - 正本文書（LF・BOMなしの全文文字列）とリビジョン番号を1つだけ持つ。
 * - 保存はスナップショットを固定して行い、保存中の後続編集は保持する（13.2.1）。
 * - 保存成功時は保存したリビジョンまでを基準化し、管理値（updatedAt）だけを
 *   現在文書と履歴へ反映する。Undo の対象にはしない。
 */
import {
  analyzeText,
  classifyChange,
  editField,
  replaceBody,
  replaceId,
  textFromBytes,
  verifyCandidateBytes,
  type Analysis,
  type Problem,
  type TextEdit,
} from "../core/article-doc";
import { bytesEqual, encodeUtf8, sha256Hex } from "../core/bytes";
import { nowDateTime } from "../core/datetime";
import { DocHistory } from "../core/history";
import type { StandardKey } from "../core/schema";
import type { FieldValue } from "../core/yaml-doc";
import type { DiskState } from "../fs/save";

export type SaveStatus = "unsaved" | "saving" | "saved" | "unknown";

export interface Notice {
  readonly kind: "ok" | "error" | "warn" | "info";
  readonly text: string;
  readonly details?: readonly string[];
}

export interface Conflict {
  readonly baseText: string;
  readonly baseHash: string;
  readonly baseReadAt: number;
  readonly disk: DiskState;
  readonly diskText: string | null;
  readonly diskHash: string | null;
  readonly diskReadAt: number;
  readonly editingText: string;
  readonly editingHash: string;
  readonly editingAt: number;
}

export interface Base {
  readonly bytes: Uint8Array;
  readonly text: string;
  readonly readAt: number;
  readonly hash: string;
}

export class EditorSession {
  /** 記事ID（記事フォルダ名）。新規記事では初回保存前に変わることがある。 */
  id = $state("");
  isNew = $state(false);
  text = $state("");
  revision = $state(0);
  base = $state<Base | null>(null);
  /** 開いた時点の読み取り専用理由 */
  readOnlyReason = $state<string | null>(null);
  saving = $state(false);
  /** 直近の保存試行の結果が不明・失敗で、候補が残っている */
  pendingCandidate = $state<Uint8Array | null>(null);
  resultUnknown = $state(false);
  lastSavedAt = $state<number | null>(null);
  conflict = $state<Conflict | null>(null);
  notice = $state<Notice | null>(null);
  /** 新規記事の作成開始時刻（再試行・復旧でも取り直さない：8.2・36） */
  readonly newCreatedAt: string | null;
  historyTruncated = $state(false);

  private history: DocHistory;

  readonly analysis: Analysis = $derived(analyzeText(this.text, this.id));
  readonly dirty: boolean = $derived(this.base === null || this.text !== this.base.text);
  readonly status: SaveStatus = $derived(
    this.saving ? "saving" : this.resultUnknown ? "unknown" : this.dirty ? "unsaved" : "saved",
  );

  constructor(init: {
    id: string;
    text: string;
    base: Base | null;
    isNew: boolean;
    newCreatedAt?: string;
    readOnlyReason?: string | null;
  }) {
    this.id = init.id;
    this.text = init.text;
    this.base = init.base;
    this.isNew = init.isNew;
    this.newCreatedAt = init.newCreatedAt ?? null;
    this.readOnlyReason = init.readOnlyReason ?? null;
    this.history = new DocHistory(init.text);
  }

  get canUndo(): boolean {
    void this.revision;
    return this.history.canUndo;
  }

  get canRedo(): boolean {
    void this.revision;
    return this.history.canRedo;
  }

  // -------------------------------------------------------------------------
  // 編集（フォーム・原文・本文は同じ正本文書を変える）

  setText(text: string, group: string | null): void {
    if (this.readOnlyReason !== null || text === this.text) return;
    this.history.push(text, group);
    this.historyTruncated = this.history.truncated;
    this.text = text;
    this.revision++;
  }

  setBody(body: string): void {
    const r = replaceBody(this.text, body);
    if (r.ok) this.setText(r.text, "body");
  }

  setField(key: StandardKey, value: FieldValue): TextEdit {
    const r = editField(this.text, key, value);
    if (r.ok) this.setText(r.text, `field:${key}`);
    return r;
  }

  /** 原稿状態の変更（7.2）：初めて published にするとき publishedAt が null なら現在時刻を入れる */
  setStatus(status: "draft" | "published", publishedAt: string | null): TextEdit {
    let r = editField(this.text, "status", status);
    if (!r.ok) return r;
    if (status === "published" && publishedAt === null) {
      r = editField(r.text, "publishedAt", nowDateTime());
      if (!r.ok) return r;
    }
    this.setText(r.text, null);
    return r;
  }

  sealHistory(): void {
    this.history.seal();
  }

  undo(): void {
    const t = this.history.undo();
    if (t !== null) {
      this.text = t;
      this.revision++;
    }
  }

  redo(): void {
    const t = this.history.redo();
    if (t !== null) {
      this.text = t;
      this.revision++;
    }
  }

  // -------------------------------------------------------------------------
  // 保存の準備（13.2 手順1・2）

  /** 保存前の検証。問題があれば理由を返す。 */
  precheck(
    snapshot: string,
  ):
    | { ok: true; bump: boolean; slugChanged: boolean; becamePublished: boolean; slugChangedAfterPublish: boolean }
    | { ok: false; notice: Notice } {
    const a = analyzeText(snapshot, this.id);
    if (a.problems.length > 0) {
      return { ok: false, notice: problemsNotice("検証エラーがあるため保存できません。", a.problems) };
    }
    const cur = a.schema?.values ?? {};
    if (this.base === null) {
      if (this.newCreatedAt !== null && cur.createdAt !== this.newCreatedAt) {
        return {
          ok: false,
          notice: { kind: "error", text: "createdAt は通常変更できません。元の値に戻してください。" },
        };
      }
      return {
        ok: true,
        bump: true,
        slugChanged: true,
        becamePublished: cur.status === "published",
        slugChangedAfterPublish: false,
      };
    }
    const baseA = analyzeText(this.base.text, this.id);
    const ch = classifyChange(baseA, a);
    if (!ch.textChanged) return { ok: false, notice: { kind: "info", text: "変更がないため、書き込みませんでした。" } };
    if (ch.incomparable) {
      return {
        ok: false,
        notice: { kind: "error", text: "比較できない数値表現があるため保存を止めました。原文を確認してください。" },
      };
    }
    if (ch.updatedAtEdited) {
      return {
        ok: false,
        notice: { kind: "error", text: "updatedAt は保存時に CMS が管理する項目です。元の値に戻してください。" },
      };
    }
    if (ch.createdAtEdited) {
      return { ok: false, notice: { kind: "error", text: "createdAt は通常変更できません。元の値に戻してください。" } };
    }
    const prev = baseA.schema?.values ?? {};
    return {
      ok: true,
      bump: ch.contentChanged,
      slugChanged: prev.slug !== cur.slug,
      becamePublished: cur.status === "published" && prev.status !== "published",
      slugChangedAfterPublish: prev.status === "published" && prev.slug !== cur.slug,
    };
  }

  /** 最終候補を確定し、再読込可能性を検証する（13.2 手順4・5、13.2.2） */
  buildCandidate(
    snapshot: string,
    bump: boolean,
  ): { ok: true; bytes: Uint8Array } | { ok: false; problems: Problem[] } {
    let text = snapshot;
    if (bump) {
      // updatedAt は各保存試行の候補生成時に一度だけ取得する（8.2）
      const r = editField(text, "updatedAt", nowDateTime());
      if (!r.ok) return { ok: false, problems: [{ message: r.message, field: "updatedAt" }] };
      text = r.text;
    }
    const bytes = encodeUtf8(text);
    const check = verifyCandidateBytes(bytes, this.id);
    if (!check.ok) return { ok: false, problems: check.problems };
    return { ok: true, bytes };
  }

  /** 新規記事の ID を差し替える（初回保存直前の重複再確認で再生成した場合） */
  changeNewId(id: string): void {
    this.history.mapAll((t) => {
      const r = replaceId(t, id);
      return r.ok ? r.text : t;
    });
    this.id = id;
    this.text = this.history.current;
    this.revision++;
  }

  // -------------------------------------------------------------------------
  // 保存結果の反映（13.2 手順8、13.2.1）

  async adoptSaved(bytes: Uint8Array): Promise<void> {
    const loaded = textFromBytes(bytes);
    if (!loaded.ok) throw new Error(loaded.reason);
    const savedText = loaded.text;
    const savedValues = analyzeText(savedText, this.id).schema?.values ?? {};
    const managed = savedValues.updatedAt;
    // 管理値だけを現在文書と履歴へ反映する。後続編集は保持する。
    if (managed !== undefined) {
      this.history.mapAll((t) => {
        const r = editField(t, "updatedAt", managed);
        return r.ok ? r.text : t;
      });
    }
    this.text = this.history.current;
    this.base = { bytes, text: savedText, readAt: Date.now(), hash: await sha256Hex(bytes) };
    this.isNew = false;
    this.pendingCandidate = null;
    this.resultUnknown = false;
    this.conflict = null;
    this.lastSavedAt = Date.now();
    this.revision++;
  }

  async setConflict(disk: DiskState, readAt: number): Promise<void> {
    if (this.base === null) return;
    const diskBytes = disk.kind === "bytes" ? disk.bytes : null;
    const diskLoaded = diskBytes ? textFromBytes(diskBytes) : null;
    const editingBytes = encodeUtf8(this.text);
    this.conflict = {
      baseText: this.base.text,
      baseHash: this.base.hash,
      baseReadAt: this.base.readAt,
      disk,
      diskText: diskLoaded?.ok ? diskLoaded.text : null,
      diskHash: diskBytes ? await sha256Hex(diskBytes) : null,
      diskReadAt: readAt,
      editingText: this.text,
      editingHash: await sha256Hex(editingBytes),
      editingAt: Date.now(),
    };
  }

  /** 保存候補がディスクの内容と一致しているか（UI表示用） */
  candidateMatches(bytes: Uint8Array): boolean {
    return this.pendingCandidate !== null && bytesEqual(this.pendingCandidate, bytes);
  }
}

export function problemsNotice(text: string, problems: readonly Problem[]): Notice {
  return {
    kind: "error",
    text,
    details: problems.map((p) => (p.line !== undefined ? `${p.line}行目：${p.message}` : p.message)),
  };
}
