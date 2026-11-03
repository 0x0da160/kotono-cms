/**
 * 文書レベルの共通 Undo/Redo 履歴（仕様 14・34.2）。
 *
 * フォーム変更と原文変更を同じ履歴に記録する。連続入力は同じグループキーで
 * 一定時間内ならまとめる。IME 変換中は呼び出し側が記録を遅らせる。
 * 予算（20 MiB または 1,000 操作の先到達）を超えたら古い履歴を切り捨てて通知する。
 * 現在文書は切り捨てない。
 */
import { HISTORY_MAX_BYTES, HISTORY_MAX_ENTRIES } from "./budgets";

interface Entry {
  text: string;
  group: string | null;
  at: number;
}

export class DocHistory {
  private entries: Entry[];
  private index = 0;
  private bytes: number;
  /** 予算超過で古い履歴を切り捨てたか */
  truncated = false;

  constructor(
    initial: string,
    private readonly coalesceMs = 1000,
    private readonly maxEntries = HISTORY_MAX_ENTRIES,
    private readonly maxBytes = HISTORY_MAX_BYTES,
  ) {
    this.entries = [{ text: initial, group: null, at: 0 }];
    this.bytes = initial.length * 2;
  }

  get current(): string {
    return (this.entries[this.index] as Entry).text;
  }

  get canUndo(): boolean {
    return this.index > 0;
  }

  get canRedo(): boolean {
    return this.index < this.entries.length - 1;
  }

  /** 新しい内容を記録する。同じグループの連続入力はまとめる。 */
  push(text: string, group: string | null, now = Date.now()): void {
    if (text === this.current) return;
    // Redo 分岐を捨てる
    for (const e of this.entries.splice(this.index + 1)) this.bytes -= e.text.length * 2;
    const top = this.entries[this.index] as Entry;
    if (group !== null && top.group === group && this.index > 0 && now - top.at <= this.coalesceMs) {
      this.bytes += (text.length - top.text.length) * 2;
      top.text = text;
      top.at = now;
    } else {
      this.entries.push({ text, group, at: now });
      this.index++;
      this.bytes += text.length * 2;
    }
    this.trim();
  }

  undo(): string | null {
    if (!this.canUndo) return null;
    this.index--;
    this.seal();
    return this.current;
  }

  redo(): string | null {
    if (!this.canRedo) return null;
    this.index++;
    this.seal();
    return this.current;
  }

  /** 次の入力を新しい操作として始める（モード切替・フォーカス移動など） */
  seal(): void {
    const top = this.entries[this.index] as Entry;
    top.group = null;
  }

  /**
   * CMS の管理値（updatedAt 等）を履歴全体へ反映する。Undo の対象にはしない（13.2.1）。
   * 反映できない版はそのまま残す。
   */
  mapAll(fn: (text: string) => string): void {
    this.bytes = 0;
    for (const e of this.entries) {
      e.text = fn(e.text);
      this.bytes += e.text.length * 2;
    }
  }

  private trim(): void {
    while ((this.entries.length > this.maxEntries || this.bytes > this.maxBytes) && this.index > 0) {
      const [old] = this.entries.splice(0, 1);
      if (old) this.bytes -= old.text.length * 2;
      this.index--;
      this.truncated = true;
    }
  }
}
