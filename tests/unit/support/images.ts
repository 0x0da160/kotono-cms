/** 試験用の画像（ヘッダー部分だけを組み立てたもの。デコード可能な完全な画像ではない） */
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >>> 8) & 255];
const le24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
const le32 = (n: number) => [...le24(n), (n >>> 24) & 255];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const chunk = (type: string, data: number[]) => [...be32(data.length), ...ascii(type), ...data, 0, 0, 0, 0];

export function png(w: number, h: number, frames?: number): Uint8Array {
  const ihdr = chunk("IHDR", [...be32(w), ...be32(h), 8, 6, 0, 0, 0]);
  const actl = frames ? chunk("acTL", [...be32(frames), ...be32(0)]) : [];
  return new Uint8Array([
    0x89,
    ...ascii("PNG\r\n\x1a\n"),
    ...ihdr,
    ...actl,
    ...chunk("IDAT", [0]),
    ...chunk("IEND", []),
  ]);
}

export function gif(w: number, h: number, frames: number, fw = w, fh = h): Uint8Array {
  const out = [...ascii("GIF89a"), ...le16(w), ...le16(h), 0, 0, 0];
  for (let i = 0; i < frames; i++) {
    out.push(0x21, 0xf9, 4, 0, 0, 0, 0, 0); // 画像制御拡張
    out.push(0x2c, 0, 0, 0, 0, ...le16(fw), ...le16(fh), 0, 2, 1, 0, 0);
  }
  out.push(0x3b);
  return new Uint8Array(out);
}

export function jpeg(w: number, h: number): Uint8Array {
  const sof = [0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0];
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, ...sof, 0xff, 0xd9]);
}

export function webpLossless(w: number, h: number): Uint8Array {
  const bits = (w - 1) | ((h - 1) << 14);
  const data = [0x2f, ...le32(bits), 0, 0, 0];
  const body = [...ascii("WEBP"), ...ascii("VP8L"), ...le32(data.length), ...data];
  return new Uint8Array([...ascii("RIFF"), ...le32(body.length), ...body]);
}

export function webpAnimated(w: number, h: number, frames: number): Uint8Array {
  const vp8x = [...ascii("VP8X"), ...le32(10), 0x02, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)];
  const anmf: number[] = [];
  for (let i = 0; i < frames; i++)
    anmf.push(...ascii("ANMF"), ...le32(16), ...le24(0), ...le24(0), ...le24(w - 1), ...le24(h - 1), 0, 0, 0, 0);
  const body = [...ascii("WEBP"), ...vp8x, ...anmf];
  return new Uint8Array([...ascii("RIFF"), ...le32(body.length), ...body]);
}

function box(type: string, payload: number[]): number[] {
  return [...be32(payload.length + 8), ...ascii(type), ...payload];
}

export function avif(w: number, h: number, brand = "avif"): Uint8Array {
  const ftyp = box("ftyp", [...ascii(brand), 0, 0, 0, 0, ...ascii("mif1")]);
  const ispe = box("ispe", [0, 0, 0, 0, ...be32(w), ...be32(h)]);
  const meta = box("meta", [0, 0, 0, 0, ...box("iprp", box("ipco", ispe))]);
  return new Uint8Array([...ftyp, ...meta]);
}
