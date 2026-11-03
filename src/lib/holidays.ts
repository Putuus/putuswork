/** 中国法定节假日与调休（数据来源：国务院办公厅关于 2026 年部分节假日安排的通知） */

export interface DayMark {
  /** holiday = 放假，workday = 周末调休上班 */
  kind: 'holiday' | 'workday';
  /** 2 个字，直接画在日历格子里 */
  short: string;
  /** 完整名字，放 title 提示 */
  name: string;
}

interface HolidayRange {
  from: string;
  to: string;
  short: string;
  name: string;
}

/** 2026 年放假安排（含调休） */
const HOLIDAYS_2026: HolidayRange[] = [
  { from: '2026-01-01', to: '2026-01-03', short: '元旦', name: '元旦（放假 3 天，1 月 4 日周日上班）' },
  { from: '2026-02-15', to: '2026-02-23', short: '春节', name: '春节（放假 9 天，2 月 14 日、2 月 28 日周六上班）' },
  { from: '2026-04-04', to: '2026-04-06', short: '清明', name: '清明节（放假 3 天）' },
  { from: '2026-05-01', to: '2026-05-05', short: '劳动', name: '劳动节（放假 5 天，5 月 9 日周六上班）' },
  { from: '2026-06-19', to: '2026-06-21', short: '端午', name: '端午节（放假 3 天）' },
  { from: '2026-09-25', to: '2026-09-27', short: '中秋', name: '中秋节（放假 3 天）' },
  { from: '2026-10-01', to: '2026-10-07', short: '国庆', name: '国庆节（放假 7 天，9 月 20 日周日、10 月 10 日周六上班）' },
];

/** 周末调休上班的日子 */
const MAKEUP_DAYS: Array<{ date: string; short: string; name: string }> = [
  { date: '2026-01-04', short: '班', name: '元旦调休上班（周日）' },
  { date: '2026-02-14', short: '班', name: '春节调休上班（周六）' },
  { date: '2026-02-28', short: '班', name: '春节调休上班（周六）' },
  { date: '2026-05-09', short: '班', name: '劳动节调休上班（周六）' },
  { date: '2026-09-20', short: '班', name: '国庆调休上班（周日）' },
  { date: '2026-10-10', short: '班', name: '国庆调休上班（周六）' },
];

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

function shift(iso: string, days: number): string {
  const d = new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) + days);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

const TABLE: Record<string, DayMark> = (() => {
  const map: Record<string, DayMark> = {};
  for (const r of HOLIDAYS_2026) {
    let cur = r.from;
    while (cur <= r.to) {
      map[cur] = { kind: 'holiday', short: r.short, name: r.name };
      cur = shift(cur, 1);
    }
  }
  for (const d of MAKEUP_DAYS) {
    map[d.date] = { kind: 'workday', short: d.short, name: d.name };
  }
  return map;
})();

/** 查这天的节假日标记；不是节假日/调休日返回 null */
export function dayMark(iso: string): DayMark | null {
  return TABLE[iso] || null;
}

/** 需要忽略周末的日期集合（调休上班日按工作日算） */
export function isMakeupWorkday(iso: string): boolean {
  const m = TABLE[iso];
  return !!m && m.kind === 'workday';
}

export function isHoliday(iso: string): boolean {
  const m = TABLE[iso];
  return !!m && m.kind === 'holiday';
}

export const HOLIDAY_YEARS = [2026];
