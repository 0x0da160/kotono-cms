import { describe, expect, it } from "vitest";
import { KEYBOARD_MIN_INSET, keyboardInset, watchKeyboard, type ViewportLike } from "../../src/lib/ui/viewport";

describe("画面キーボードの高さ（ADR-0015）", () => {
  it("レイアウトの高さから、見えている範囲の下端を引く", () => {
    // iPhone 17（874px）でキーボードが 336px 覆っている
    expect(keyboardInset(874, { height: 538, offsetTop: 0 })).toBe(336);
    // 見えている範囲が下へずれている（ページの下端でキーボードが出た）ときは、その分だけ覆う高さが減る
    expect(keyboardInset(874, { height: 538, offsetTop: 100 })).toBe(236);
  });

  it("アドレスバーの伸び縮み程度の差は、キーボードとみなさない", () => {
    expect(keyboardInset(874, { height: 874, offsetTop: 0 })).toBe(0);
    expect(keyboardInset(874, { height: 874 - (KEYBOARD_MIN_INSET - 1), offsetTop: 0 })).toBe(0);
    expect(keyboardInset(874, { height: 900, offsetTop: 0 })).toBe(0);
  });

  it("拡大している間は 0（見えている範囲が縮むのは拡大のため）", () => {
    expect(keyboardInset(874, { height: 437, offsetTop: 0, scale: 2 })).toBe(0);
  });
});

describe("watchKeyboard", () => {
  function fake() {
    const listeners = new Map<string, Set<() => void>>();
    const vv = {
      height: 874,
      offsetTop: 0,
      addEventListener: (t: string, f: () => void) => {
        if (!listeners.has(t)) listeners.set(t, new Set());
        listeners.get(t)?.add(f);
      },
      removeEventListener: (t: string, f: () => void) => void listeners.get(t)?.delete(f),
    };
    const props = new Map<string, string>();
    const attrs = new Map<string, string>();
    const root = {
      style: { setProperty: (n: string, v: string) => void props.set(n, v) },
      setAttribute: (n: string, v: string) => void attrs.set(n, v),
      removeAttribute: (n: string) => void attrs.delete(n),
    };
    const fire = (t: string) => listeners.get(t)?.forEach((f) => f());
    const count = () => [...listeners.values()].reduce((n, s) => n + s.size, 0);
    return { vv, props, attrs, root, fire, count };
  }

  it("キーボードが出たら --keyboard-inset と data-keyboard を書き、閉じたら戻す", () => {
    const f = fake();
    const stop = watchKeyboard({ innerHeight: 874, visualViewport: f.vv as ViewportLike }, f.root);
    expect(f.props.get("--keyboard-inset")).toBe("0px");
    expect(f.attrs.has("data-keyboard")).toBe(false);

    f.vv.height = 538;
    f.fire("resize");
    expect(f.props.get("--keyboard-inset")).toBe("336px");
    expect(f.attrs.get("data-keyboard")).toBe("open");

    f.vv.offsetTop = 60;
    f.fire("scroll");
    expect(f.props.get("--keyboard-inset")).toBe("276px");

    f.vv.height = 874;
    f.vv.offsetTop = 0;
    f.fire("resize");
    expect(f.props.get("--keyboard-inset")).toBe("0px");
    expect(f.attrs.has("data-keyboard")).toBe(false);

    stop();
    expect(f.count()).toBe(0);
  });

  it("visualViewport がない環境では何もしない", () => {
    const f = fake();
    const stop = watchKeyboard({ innerHeight: 874, visualViewport: null }, f.root);
    expect(f.props.size).toBe(0);
    stop();
  });
});
