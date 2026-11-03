/** 日期工具 —— 只处理本地时区的 YYYY-MM-DD 字符串，不引入任何依赖 */

export const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];

export function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

export function toISO(d: Date): string {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

export function parseISO(iso: string): Date {
  const parts = iso.split('-');
  return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
}

export function todayISO(): string {
  return toISO(new Date());
}

export function isoOf(y: number, m: number, d: number): string {
  return y + '-' + pad2(m + 1) + '-' + pad2(d);
}

export function daysInMonth(y: number, m: number): number {
  return new Date(y, m + 1, 0).getDate();
}

export function monthLabel(y: number, m: number): string {
  return y + '年' + (m + 1) + '月';
}

export function monthRangeText(y: number, m: number): string {
  const last = daysInMonth(y, m);
  return (m + 1) + '.1-' + (m + 1) + '.' + last;
}

export function addMonths(y: number, m: number, delta: number): { y: number; m: number } {
  const total = y * 12 + m + delta;
  return { y: Math.floor(total / 12), m: ((total % 12) + 12) % 12 };
}

export function weekdayOf(iso: string): number {
  return parseISO(iso).getDay();
}

export function isWeekendISO(iso: string): boolean {
  const w = weekdayOf(iso);
  return w === 0 || w === 6;
}

export function shiftDate(iso: string, days: number): string {
  const d = parseISO(iso);
  d.setDate(d.getDate() + days);
  return toISO(d);
}

export function isoMonth(iso: string): string {
  return iso.slice(0, 7);
}

export function formatCN(iso: string): string {
  const d = parseISO(iso);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 周' + WEEK_CN[d.getDay()];
}

export function formatShortCN(iso: string): string {
  const d = parseISO(iso);
  return (d.getMonth() + 1) + '/' + d.getDate();
}

export interface Cell {
  iso: string;
  day: number;
  inMonth: boolean;
  weekday: number;
}

/** 生成月视图网格：前面补上上月末尾，后面补下月开头，凑满整周 */
export function monthMatrix(y: number, m: number, weekStart: 0 | 1): Cell[] {
  const first = new Date(y, m, 1);
  const lead = (first.getDay() - weekStart + 7) % 7;
  const cells: Cell[] = [];
  const start = new Date(y, m, 1 - lead);
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    cells.push({
      iso: toISO(d),
      day: d.getDate(),
      inMonth: d.getMonth() === m && d.getFullYear() === y,
      weekday: d.getDay(),
    });
  }
  // 最后一行整行都在下个月就去掉，避免日历下面挂一行空的
  const lastRow = cells.slice(35);
  if (lastRow.every((c) => !c.inMonth)) cells.length = 35;
  return cells;
}

export function weekdayHeaders(weekStart: 0 | 1): string[] {
  const out: string[] = [];
  for (let i = 0; i < 7; i++) out.push(WEEK_CN[(i + weekStart) % 7]);
  return out;
}

/** 该月的所有日期（ISO 数组） */
export function monthDates(y: number, m: number): string[] {
  const out: string[] = [];
  const n = daysInMonth(y, m);
  for (let d = 1; d <= n; d++) out.push(isoOf(y, m, d));
  return out;
}
