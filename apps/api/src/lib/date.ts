const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const DAY_MS = 86_400_000;

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function parseDateString(value: string): { year: number; month: number; day: number } | null {
  const match = DATE_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return null;
  const maxDay = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (day > maxDay) return null;
  return { year, month, day };
}

export function isValidDateString(value: string): boolean {
  return parseDateString(value) !== null;
}

export function isLeapDay(value: string): boolean {
  const parsed = parseDateString(value);
  return parsed !== null && parsed.month === 2 && parsed.day === 29;
}

/** 物候比较使用的公共参照年（平年），保证跨年比较不受闰年影响。 */
const COMMON_YEAR = 2001;

/**
 * 序日：1 月 1 日为 1。
 * 所有年份都映射到同一个平年参照系，因此 2 月 29 日与 2 月 28 日同值，
 * 且 3 月及以后的日期不会因为闰年多出一天而产生非自然的 1 天跳变。
 */
export function dayOfYear(value: string): number {
  const parsed = parseDateString(value);
  if (!parsed) throw new Error(`非法日期字符串：${value}`);
  const { month } = parsed;
  const day = month === 2 && parsed.day === 29 ? 28 : parsed.day;
  const current = Date.UTC(COMMON_YEAR, month - 1, day);
  const start = Date.UTC(COMMON_YEAR, 0, 1);
  return Math.round((current - start) / DAY_MS) + 1;
}

export function addDays(value: string, days: number): string {
  const parsed = parseDateString(value);
  if (!parsed) throw new Error(`非法日期字符串：${value}`);
  const base = Date.UTC(parsed.year, parsed.month - 1, parsed.day) + days * DAY_MS;
  const next = new Date(base);
  const year = next.getUTCFullYear();
  const month = String(next.getUTCMonth() + 1).padStart(2, "0");
  const day = String(next.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** 某个时刻在某个时区的日历日（YYYY-MM-DD）。 */
export function dateInTimezone(date: Date, timezone = "Asia/Shanghai"): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(date);
}

/** 某个时区的"今天"（YYYY-MM-DD）。 */
export function todayInTimezone(timezone = "Asia/Shanghai", now = new Date()): string {
  return dateInTimezone(now, timezone);
}

/** 当前时区年份。 */
export function currentYearInTimezone(timezone = "Asia/Shanghai", now = new Date()): number {
  return Number(todayInTimezone(timezone, now).slice(0, 4));
}

export function formatChineseDate(value: string): string {
  const parsed = parseDateString(value);
  if (!parsed) return value;
  return `${parsed.year}年${parsed.month}月${parsed.day}日`;
}

/** 把当地日期字符串转成 UTC 零点 Date，仅用于写入 observedAt 兜底值。 */
export function dateStringToUtc(value: string): Date {
  const parsed = parseDateString(value);
  if (!parsed) throw new Error(`非法日期字符串：${value}`);
  return new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
}

export function daysBetween(start: string, end: string): number {
  const a = parseDateString(start);
  const b = parseDateString(end);
  if (!a || !b) throw new Error("非法日期字符串");
  const startMs = Date.UTC(a.year, a.month - 1, a.day);
  const endMs = Date.UTC(b.year, b.month - 1, b.day);
  return Math.round((endMs - startMs) / DAY_MS);
}
