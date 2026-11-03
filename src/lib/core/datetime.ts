/**
 * 日時の形式（仕様 8.1）。オフセット必須の RFC 3339 サブセット。
 *
 * - 年4桁（0001〜9999）、秒必須、小数秒は省略または1〜3桁。
 * - `T`・`Z` は大文字のみ。オフセットは `Z` または `±HH:MM`（絶対値 00:00〜14:00）。
 * - `-00:00`、24時、うるう秒、存在しない日付、前後空白は拒否する。
 * - 曖昧な Date パースは使わない。
 */

const RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

export interface ParsedDateTime {
  /** UTC のエポックミリ秒（小数秒は3桁までなのでミリ秒で正確に表せる） */
  readonly epochMs: number;
  /** UTC からのオフセット（分） */
  readonly offsetMinutes: number;
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y: number, m: number): number {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] ?? 0;
}

export function parseDateTime(s: string): ParsedDateTime | null {
  const m = RE.exec(s);
  if (!m) return null;
  const [, ys, mos, ds, hs, mis, ss, frac, tz] = m;
  const y = Number(ys);
  const mo = Number(mos);
  const d = Number(ds);
  const h = Number(hs);
  const mi = Number(mis);
  const sec = Number(ss);
  if (y < 1 || y > 9999) return null;
  if (mo < 1 || mo > 12) return null;
  if (d < 1 || d > daysInMonth(y, mo)) return null;
  if (h > 23 || mi > 59 || sec > 59) return null;
  let offsetMinutes = 0;
  if (tz !== "Z" && tz !== undefined) {
    const sign = tz[0] === "-" ? -1 : 1;
    const oh = Number(tz.slice(1, 3));
    const om = Number(tz.slice(4, 6));
    if (om > 59) return null;
    if (oh > 14 || (oh === 14 && om !== 0)) return null;
    if (sign === -1 && oh === 0 && om === 0) return null; // 未知オフセットを意味する -00:00
    offsetMinutes = sign * (oh * 60 + om);
  }
  const ms = frac === undefined ? 0 : Number(frac.padEnd(3, "0"));
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  date.setUTCHours(h, mi, sec, ms);
  return { epochMs: date.getTime() - offsetMinutes * 60_000, offsetMinutes };
}

export function isValidDateTime(s: string): boolean {
  return parseDateTime(s) !== null;
}

/** 同じ時間軸上で同一時刻か（オフセット表記の違いは同値） */
export function sameInstant(a: string, b: string): boolean {
  const pa = parseDateTime(a);
  const pb = parseDateTime(b);
  return pa !== null && pb !== null && pa.epochMs === pb.epochMs;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** CMS 生成値：秒精度で端末のローカルオフセットを付ける（仕様 8.1） */
export function formatLocalDateTime(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  const tz = offset === 0 ? "+00:00" : `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return (
    `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${tz}`
  );
}

/** 現在時刻の CMS 生成値 */
export function nowDateTime(): string {
  return formatLocalDateTime(new Date());
}

/** 表示用：端末のローカル時刻（仕様 8.1） */
export function formatForDisplay(s: string): string {
  const p = parseDateTime(s);
  if (!p) return s;
  const d = new Date(p.epochMs);
  return (
    `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

export type PublishTiming = "unset" | "past" | "future" | "invalid";

/** 公開日時の状態軸（仕様 7.3）。比較は文字列順ではなく時間軸で行う。 */
export function publishTiming(publishedAt: string | null, now: number): PublishTiming {
  if (publishedAt === null) return "unset";
  const p = parseDateTime(publishedAt);
  if (!p) return "invalid";
  return p.epochMs <= now ? "past" : "future";
}
