/**
 * ダイアログを閉じた後、開いた操作へフォーカスを戻す。
 *
 * 確認やコミットの間だけ無効になる操作（「削除…」「コミット…」は処理中に無効になる）は、
 * 閉じた時点ではフォーカスできない。その場合は有効に戻るのを待ち、そのときフォーカスが
 * どこにも無ければ（BODY）戻す。ほかの場所へ移っていれば奪わない。
 */
export class FocusReturn {
  private pending: { target: HTMLElement; observer: MutationObserver } | null = null;

  /** 開く時点の戻り先。続けて開くダイアログでは、待っている戻り先を引き継ぐ */
  capture(): Element | null {
    const active = document.activeElement;
    const target = this.pending && (active === null || active === document.body) ? this.pending.target : active;
    this.cancel();
    return target;
  }

  restore(target: Element | null): void {
    this.cancel();
    if (!(target instanceof HTMLElement) || !target.isConnected) return;
    if (!target.matches(":disabled")) {
      target.focus();
      return;
    }
    const observer = new MutationObserver(() => {
      if (!target.isConnected) return this.cancel();
      if (target.matches(":disabled")) return;
      this.cancel();
      const active = document.activeElement;
      if (active === null || active === document.body) target.focus();
    });
    observer.observe(target, { attributes: true, attributeFilter: ["disabled"] });
    this.pending = { target, observer };
  }

  cancel(): void {
    this.pending?.observer.disconnect();
    this.pending = null;
  }
}

/** ダイアログをまたいで戻り先を引き継げるよう、アプリで1つを共有する */
export const focusReturn = new FocusReturn();
