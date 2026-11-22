/**
 * 中国法定节假日 / 调休。
 *
 * 主数据源：holiday-cn（NateScarlet/holiday-cn），每年从国务院公告生成，仓库每天更新。
 * 运行时按年拉取并缓存 6 小时；网络不可用时回退到内置的 2026 年数据。
 */

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

/** 2026 年放假安排（内置兜底，来自国务院办公厅通知） */
const HOLIDAYS_2026: HolidayRange[] = [
  { from: '2026-01-01', to: '2026-01-03', short: '元旦', name: '元旦（放假 3 天，1 月 4 日周日上班）' },
  { from: '2026-02-15', to: '2026-02-23', short: '春节', name: '春节（放假 9 天，2 月 14 日、2 月 28 日周六上班）' },
  { from: '2026-04-04', to: '2026-04-06', short: '清明', name: '清明节（放假 3 天）' },
  { from: '2026-05-01', to: '2026-05-05', short: '劳动', name: '劳动节（放假 5 天，5 月 9 日周六上班）' },
  { from: '2026-06-19', to: '2026-06-21', short: '端午', name: '端午节（放假 3 天）' },
  { from: '2026-09-25', to: '2026-09-27', short: '中秋', name: '中秋节（放假 3 天）' },
  { from: '2026-10-01', to: '2026-10-07', short: '国庆', name: '国庆节（放假 7 天，9 月 20 日周日、10 月 10 日周六上班）' },
];

const MAKEUP_2026: Array<{ date: string; short: string; name: string }> = [
  { date: '2026-01-04', short: '班', name: '元旦调休上班（周日）' },
  { date: '2026-02-14', short: '班', name: '春节调休上班（周六）' },
  { date: '2026-02-28', short: '班', name: '春节调休上班（周六）' },
  { date: '2026-05-09', short: '班', name: '劳动节调休上班（周六）' },
  { date: '2026-09-20', short: '班', name: '国庆调休上班（周日）' },
  { date: '2026-10-10', short: '班', name: '国庆调休上班（周六）' },
];

const SHORT: Record<string, string> = {
  元旦: '元旦',
  春节: '春节',
  清明节: '清明',
  劳动节: '劳动',
  端午节: '端午',
  中秋节: '中秋',
  国庆节: '国庆',
};

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

function shift(iso: string, days: number): string {
  const d = new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)) + days);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function shortName(name: string): string {
  return SHORT[name] || name.slice(0, 2);
}

const STATIC_2026: Record<string, DayMark> = (() => {
  const map: Record<string, DayMark> = {};
  for (const r of HOLIDAYS_2026) {
    let cur = r.from;
    while (cur <= r.to) {
      map[cur] = { kind: 'holiday', short: r.short, name: r.name };
      cur = shift(cur, 1);
    }
  }
  for (const d of MAKEUP_2026) {
    map[d.date] = { kind: 'workday', short: d.short, name: d.name };
  }
  return map;
})();

const CACHE_PREFIX = 'worklog:holidays:v2:';
const CACHE_TTL = 6 * 60 * 60 * 1000;

interface HolidayFile {
  days?: Array<{ date?: unknown; name?: unknown; isOffDay?: unknown }>;
}

function readCache(year: number): Record<string, DayMark> | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + year);
    if (!raw) return null;
    const obj = JSON.parse(raw) as { at?: number; days?: Record<string, DayMark> };
    if (!obj.at || Date.now() - obj.at > CACHE_TTL || !obj.days) return null;
    return obj.days;
  } catch {
    return null;
  }
}

function writeCache(year: number, days: Record<string, DayMark>): void {
  try {
    localStorage.setItem(CACHE_PREFIX + year, JSON.stringify({ at: Date.now(), days }));
  } catch {
    /* 忽略缓存失败 */
  }
}

/** 同步兜底：只内置了 2026，其他年份由 loadHolidayYear 拉取 */
export function staticYearMarks(year: number): Record<string, DayMark> {
  return year === 2026 ? STATIC_2026 : {};
}

/** 拉取某一年的完整节假日；有缓存先用缓存，网络失败回退内置数据 */
export async function loadHolidayYear(year: number): Promise<Record<string, DayMark>> {
  const cached = readCache(year);
  if (cached) return cached;
  const fallback = staticYearMarks(year);
  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    window.clearTimeout(timer);
    if (!res.ok) return fallback;
    const raw = (await res.json()) as HolidayFile;
    if (!Array.isArray(raw.days)) return fallback;

    const map: Record<string, DayMark> = {};
    for (const d of raw.days) {
      const date = typeof d.date === 'string' ? d.date : '';
      const name = typeof d.name === 'string' ? d.name : '';
      if (!date || !name) continue;
      if (d.isOffDay === true) {
        map[date] = { kind: 'holiday', short: shortName(name), name: name + '（放假）' };
      } else if (d.isOffDay === false) {
        map[date] = { kind: 'workday', short: '班', name: name + ' 调休上班' };
      }
    }
    if (Object.keys(map).length === 0) return fallback;
    writeCache(year, map);
    return map;
  } catch {
    return fallback;
  }
}

/** 同步查询兜底（内置的 2026） */
export function dayMark(iso: string): DayMark | null {
  return STATIC_2026[iso] || null;
}
