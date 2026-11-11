/**
 * 画面キーボードの高さを CSS へ渡す（ADR-0015）。
 *
 * iOS の Safari は、画面キーボードが出てもレイアウトの高さ（`100dvh`・`position: fixed` の基準）を変えず、
 * 見えている範囲（visualViewport）だけを縮める。そのままでは、画面の下に固定した部品がキーボードの下に隠れる。
 * ここで「キーボードが下から覆っている高さ」を求め、`<html>` に次を書く。
 *
 * - `--keyboard-inset`：覆っている高さ（px）。出ていないときは `0px`。
 * - `data-keyboard="open"`：キーボードが出ている間だけ付ける。
 *
 * CSS は `bottom: var(--keyboard-inset)` のように使う（書式の帯・下から出すダイアログ）。
 * visualViewport がない環境では何もしない（`--keyboard-inset` は tokens.css の既定の 0px のまま）。
 */

/** キーボードとみなす高さの下限（px）。アドレスバーの伸び縮み・拡大での小さな差をキーボードと取り違えない */
export const KEYBOARD_MIN_INSET = 120;

export type ViewportLike = {
  readonly height: number;
  readonly offsetTop: number;
  readonly scale?: number;
  addEventListener(type: "resize" | "scroll", listener: () => void): void;
  removeEventListener(type: "resize" | "scroll", listener: () => void): void;
};

export type ViewportHost = {
  readonly innerHeight: number;
  readonly visualViewport?: ViewportLike | null;
  requestAnimationFrame?: (cb: () => void) => number;
  cancelAnimationFrame?: (id: number) => void;
};

export type ViewportRoot = {
  style: { setProperty(name: string, value: string): void };
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
};

/**
 * 画面キーボードが下から覆っている高さ（px）。
 * レイアウトの高さから、見えている範囲の下端（offsetTop ＋ height）を引く。
 * ピンチで拡大している間（scale > 1）は、見えている範囲が縮むのは拡大のためなので 0 とする。
 */
export function keyboardInset(layoutHeight: number, vv: Pick<ViewportLike, "height" | "offsetTop" | "scale">): number {
  if ((vv.scale ?? 1) > 1.01) return 0;
  const inset = Math.round(layoutHeight - (vv.offsetTop + vv.height));
  return inset >= KEYBOARD_MIN_INSET ? inset : 0;
}

/** キーボードの高さを見張り、`root`（<html>）へ書く。戻り値を呼ぶと見張りをやめる */
export function watchKeyboard(host: ViewportHost, root: ViewportRoot): () => void {
  const vv = host.visualViewport;
  if (!vv) return () => undefined;
  let last = -1;
  let raf = 0;
  const apply = () => {
    raf = 0;
    const inset = keyboardInset(host.innerHeight, vv);
    if (inset === last) return;
    last = inset;
    root.style.setProperty("--keyboard-inset", `${inset}px`);
    if (inset > 0) root.setAttribute("data-keyboard", "open");
    else root.removeAttribute("data-keyboard");
  };
  // スクロールのたびに何度も来るので、描画の前に 1 回だけ書く
  const schedule = () => {
    if (!host.requestAnimationFrame) return apply();
    if (raf === 0) raf = host.requestAnimationFrame(apply);
  };
  vv.addEventListener("resize", schedule);
  vv.addEventListener("scroll", schedule);
  apply();
  return () => {
    vv.removeEventListener("resize", schedule);
    vv.removeEventListener("scroll", schedule);
    if (raf !== 0) host.cancelAnimationFrame?.(raf);
  };
}
