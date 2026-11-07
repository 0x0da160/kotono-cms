/**
 * Oklab（Björn Ottosson, 2020）と sRGB の相互変換、sRGB の色域への収め方、WCAG 2.x のコントラスト比。
 * パレットの生成（palette.ts）と、その検証（tests/unit/design-tokens.test.ts）だけが使う。実行時には読み込まない。
 *
 * 変換行列は https://bottosson.github.io/posts/oklab/ の値をそのまま使う。
 */

/** Oklab の座標。L は 0〜1（明度）、a・b は色み。 */
export interface Oklab {
  L: number;
  a: number;
  b: number;
}

/** 線形化した sRGB（0〜1。色域の外では範囲を超える）。 */
export type LinearRgb = readonly [number, number, number];

export function oklabToLinearSrgb({ L, a, b }: Oklab): LinearRgb {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

export function linearSrgbToOklab([r, g, b]: LinearRgb): Oklab {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/** 明度 L、彩度 C、色相 h（度）の極座標（いわゆる OKLCH）から Oklab へ。 */
export function fromLch(L: number, C: number, hDeg: number): Oklab {
  const h = (hDeg * Math.PI) / 180;
  return { L, a: C * Math.cos(h), b: C * Math.sin(h) };
}

const EPS = 1e-6;

export function inSrgbGamut(rgb: LinearRgb): boolean {
  return rgb.every((v) => v >= -EPS && v <= 1 + EPS);
}

/**
 * 明度と色相を保ったまま彩度だけを下げて、sRGB の色域に収める（二分探索）。
 * 明度を動かさないので、パレットの「明度の段が等間隔」という性質が色域の端でも崩れない。
 */
export function gamutMapChroma(L: number, C: number, hDeg: number): Oklab {
  if (inSrgbGamut(oklabToLinearSrgb(fromLch(L, C, hDeg)))) return fromLch(L, C, hDeg);
  let lo = 0;
  let hi = C;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (inSrgbGamut(oklabToLinearSrgb(fromLch(L, mid, hDeg)))) lo = mid;
    else hi = mid;
  }
  return fromLch(L, lo, hDeg);
}

function encode(v: number): number {
  const c = Math.min(1, Math.max(0, v));
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

function decode(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** Oklab を #rrggbb に。8 ビットへの丸めを含む。 */
export function oklabToHex(c: Oklab): string {
  return (
    "#" +
    oklabToLinearSrgb(c)
      .map((v) =>
        Math.round(encode(v) * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}

export function hexToLinearSrgb(hex: string): LinearRgb {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`not a #rrggbb color: ${hex}`);
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => decode(parseInt(x ?? "0", 16) / 255));
  return [r ?? 0, g ?? 0, b ?? 0];
}

export function hexToOklab(hex: string): Oklab {
  return linearSrgbToOklab(hexToLinearSrgb(hex));
}

/** WCAG 2.x の相対輝度。丸めた後の 16 進の値から計算する（画面に出る色で判定するため）。 */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToLinearSrgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x のコントラスト比（1〜21）。 */
export function contrastRatio(fg: string, bg: string): number {
  const a = relativeLuminance(fg);
  const b = relativeLuminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
