/** 计算层 —— 工时、工资、餐补、月度/年度统计，纯函数，方便以后写测试 */

import type { AppData, Settings, WorkRecord } from '../types';
import { daysInMonth, isoOf, monthDates } from './date';

export function recordsOfDay(data: AppData, iso: string): WorkRecord[] {
  return data.records.filter((r) => r.date === iso);
}

export function hoursOfDay(data: AppData, iso: string): number {
  let sum = 0;
  for (const r of data.records) if (r.date === iso) sum += r.hours;
  return round2(sum);
}

export function wageOfDay(data: AppData, iso: string): number {
  const rate = data.settings.hourlyRate;
  let sum = 0;
  for (const r of data.records) {
    if (r.date !== iso) continue;
    sum += r.hours * (r.rate === null || r.rate === undefined ? rate : r.rate);
  }
  return round2(sum);
}

export function mealOfDay(data: AppData, iso: string): number {
  const v = data.meals[iso];
  return typeof v === 'number' ? v : 0;
}

/** 当天总计：工时收入 + 餐补 */
export function incomeOfDay(data: AppData, iso: string): number {
  return round2(wageOfDay(data, iso) + mealOfDay(data, iso));
}

export interface MonthStats {
  y: number;
  m: number;
  hours: number;
  wage: number;
  meal: number;
  income: number;
  /** 出勤天数（有工时的天数） */
  workDays: number;
  /** 有餐补的天数 */
  mealDays: number;
  /** 平均每天工时（按出勤天算） */
  avgHours: number;
  /** 工时最高的一天 */
  bestDay: { iso: string; hours: number } | null;
}

export function monthStats(data: AppData, y: number, m: number): MonthStats {
  let hours = 0;
  let wage = 0;
  let meal = 0;
  let workDays = 0;
  let mealDays = 0;
  let best: { iso: string; hours: number } | null = null;

  for (const iso of monthDates(y, m)) {
    const h = hoursOfDay(data, iso);
    if (h > 0) {
      workDays++;
      hours += h;
      if (!best || h > best.hours) best = { iso, hours: h };
    }
    wage += wageOfDay(data, iso);
    const mealV = mealOfDay(data, iso);
    if (mealV > 0) {
      mealDays++;
      meal += mealV;
    }
  }

  hours = round2(hours);
  wage = round2(wage);
  meal = round2(meal);
  return {
    y,
    m,
    hours,
    wage,
    meal,
    income: round2(wage + meal),
    workDays,
    mealDays,
    avgHours: workDays > 0 ? round2(hours / workDays) : 0,
    bestDay: best,
  };
}

export interface MonthPoint {
  y: number;
  m: number;
  label: string;
  hours: number;
  income: number;
  meal: number;
}

/** 最近 n 个月的序列（含当月），给柱状图用 */
export function recentMonths(data: AppData, y: number, m: number, n: number): MonthPoint[] {
  const out: MonthPoint[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const total = y * 12 + m - i;
    const yy = Math.floor(total / 12);
    const mm = ((total % 12) + 12) % 12;
    const s = monthStats(data, yy, mm);
    out.push({ y: yy, m: mm, label: mm + 1 + '月', hours: s.hours, income: s.income, meal: s.meal });
  }
  return out;
}

export interface YearStats {
  y: number;
  hours: number;
  income: number;
  meal: number;
  workDays: number;
}

export function yearStats(data: AppData, y: number): YearStats {
  let hours = 0;
  let income = 0;
  let meal = 0;
  let workDays = 0;
  for (let m = 0; m < 12; m++) {
    const s = monthStats(data, y, m);
    hours += s.hours;
    income += s.income;
    meal += s.meal;
    workDays += s.workDays;
  }
  return { y, hours: round2(hours), income: round2(income), meal: round2(meal), workDays };
}

export interface DayRow {
  iso: string;
  hours: number;
  wage: number;
  meal: number;
  income: number;
  note: string;
  count: number;
}

/** 有记录或餐补的日期，倒序 */
export function activeDays(data: AppData): DayRow[] {
  const map = new Map<string, DayRow>();
  const ensure = (iso: string): DayRow => {
    let row = map.get(iso);
    if (!row) {
      row = { iso, hours: 0, wage: 0, meal: mealOfDay(data, iso), income: 0, note: '', count: 0 };
      map.set(iso, row);
    }
    return row;
  };
  for (const r of data.records) {
    const row = ensure(r.date);
    const rate = r.rate === null || r.rate === undefined ? data.settings.hourlyRate : r.rate;
    row.hours = round2(row.hours + r.hours);
    row.wage = round2(row.wage + r.hours * rate);
    row.count += 1;
    if (r.note) row.note = row.note ? row.note + ' / ' + r.note : r.note;
  }
  for (const iso of Object.keys(data.meals)) ensure(iso);
  const rows = Array.from(map.values());
  for (const row of rows) row.income = round2(row.wage + row.meal);
  rows.sort((a, b) => (a.iso < b.iso ? 1 : -1));
  return rows;
}

/** 按月分组，给统计页的“通讯录式”明细列表用 */
export function groupByMonth(rows: DayRow[]): Array<{ key: string; label: string; rows: DayRow[]; hours: number; income: number }> {
  const map = new Map<string, { key: string; label: string; rows: DayRow[]; hours: number; income: number }>();
  for (const row of rows) {
    const key = row.iso.slice(0, 7);
    let g = map.get(key);
    if (!g) {
      const y = Number(key.slice(0, 4));
      const m = Number(key.slice(5, 7));
      g = { key, label: y + '年' + m + '月', rows: [], hours: 0, income: 0 };
      map.set(key, g);
    }
    g.rows.push(row);
    g.hours = round2(g.hours + row.hours);
    g.income = round2(g.income + row.income);
  }
  return Array.from(map.values()).sort((a, b) => (a.key < b.key ? 1 : -1));
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 输入框提交用：只夹到 [min, max]，**不吸附到 step**，并压到两位小数。
 * step 只服务于加减按钮 / 拖动 / 方向键（那些地方"卡榫"是对的）；
 * 手输必须原样收下，否则 32.5 的时薪会被四舍五入成 33。
 */
export function clampNumber(v: number, min: number, max: number): number {
  if (Number.isNaN(v)) return min;
  return round2(Math.min(max, Math.max(min, v)));
}

/** 金额显示：整数不带小数点，小数最多两位 */
export function money(n: number): string {
  const v = round2(n);
  const s = Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

export function hoursText(n: number): string {
  const v = round2(n);
  return Number.isInteger(v) ? String(v) : String(v);
}

export function withCurrency(n: number, currency: string): string {
  return currency + money(n);
}

/** 校验并夹取餐补数值到 1~100 */
export function clampMeal(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(100, Math.max(1, Math.round(v)));
}

/** 本月某个区间（用来做“本周/本月工作日”这类批量选择） */
export function weekdaysOfMonth(y: number, m: number): string[] {
  return monthDates(y, m).filter((iso) => {
    const d = new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
    const w = d.getDay();
    return w !== 0 && w !== 6;
  });
}

export function weekOf(anchorISO: string, weekStart: 0 | 1): string[] {
  const d = new Date(Number(anchorISO.slice(0, 4)), Number(anchorISO.slice(5, 7)) - 1, Number(anchorISO.slice(8, 10)));
  const lead = (d.getDay() - weekStart + 7) % 7;
  const out: string[] = [];
  for (let i = 0; i < 7; i++) {
    const c = new Date(d.getFullYear(), d.getMonth(), d.getDate() - lead + i);
    out.push(isoOf(c.getFullYear(), c.getMonth(), c.getDate()));
  }
  return out;
}

/** 当月天数（供日历以外的统计使用） */
export function daysCount(y: number, m: number): number {
  return daysInMonth(y, m);
}

export function rateOf(r: WorkRecord, settings: Settings): number {
  return r.rate === null || r.rate === undefined ? settings.hourlyRate : r.rate;
}
