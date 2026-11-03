/** 导出：月度报表图片（canvas 手绘，零依赖）与明细 CSV */

import type { AppData } from '../types';
import { activeDays, monthStats, round2 } from './calc';
import { daysInMonth, monthLabel } from './date';

const FONT =
  '"Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

const INK = '#1c1633';
const INK_SOFT = '#6f678c';
const PURPLE = '#7c3aed';
const PURPLE_LIGHT = '#a78bfa';

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function text(
  ctx: CanvasRenderingContext2D,
  str: string,
  x: number,
  y: number,
  font: string,
  color: string,
  align: CanvasTextAlign = 'left'
) {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(str, x, y);
}

/** 画一张当月工时报表，返回 canvas（2 倍分辨率，直接导出 PNG 就很清楚） */
export async function renderMonthReport(data: AppData, y: number, m: number): Promise<HTMLCanvasElement> {
  const stats = monthStats(data, y, m);
  const days = daysInMonth(y, m);
  const W = 1080;
  const H = 1440;
  const S = 2;

  if (document.fonts && document.fonts.ready) {
    try {
      await document.fonts.ready;
    } catch {
      /* 字体没加载好也不影响出图 */
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = W * S;
  canvas.height = H * S;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.scale(S, S);

  // 底
  ctx.fillStyle = '#f4f1fb';
  ctx.fillRect(0, 0, W, H);

  // 白卡片
  ctx.save();
  ctx.shadowColor = 'rgba(58, 38, 110, 0.18)';
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 14;
  roundRect(ctx, 48, 48, W - 96, H - 96, 42);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.restore();

  // 标题
  text(ctx, monthLabel(y, m) + ' 工时报表', 100, 158, '700 44px ' + FONT, INK);
  const now = new Date();
  const pad = (n: number) => (n < 10 ? '0' + n : String(n));
  const stamp =
    now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes());
  text(ctx, '生成于 ' + stamp, W - 100, 158, '400 20px ' + FONT, INK_SOFT, 'right');
  ctx.strokeStyle = '#eee9f9';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(100, 200);
  ctx.lineTo(W - 100, 200);
  ctx.stroke();

  // 四个概览
  const cards: Array<[string, string]> = [
    ['本月工时', String(stats.hours) + ' h'],
    ['本月收入', '¥' + stats.income],
    ['出勤天数', String(stats.workDays) + ' 天'],
    ['餐补', '¥' + stats.meal + '（' + stats.mealDays + ' 天）'],
  ];
  const gap = 20;
  const cw = (W - 200 - gap * 3) / 4;
  cards.forEach((c, i) => {
    const x = 100 + i * (cw + gap);
    roundRect(ctx, x, 244, cw, 140, 24);
    ctx.fillStyle = '#f7f4ff';
    ctx.fill();
    text(ctx, c[0], x + 24, 292, '500 22px ' + FONT, INK_SOFT);
    text(ctx, c[1], x + 24, 348, '700 40px ' + FONT, PURPLE);
  });

  // 每日工时柱状图
  text(ctx, '每日工时', 100, 462, '600 28px ' + FONT, INK);
  const chartX = 100;
  const chartW = W - 200;
  const chartTop = 520;
  const chartBottom = 1000;
  const chartH = chartBottom - chartTop;

  let maxHours = 0;
  for (let d = 1; d <= days; d++) {
    maxHours = Math.max(maxHours, hoursOfDaySafe(data, y, m, d));
  }
  const axisMax = Math.max(8, Math.ceil(maxHours / 2) * 2);

  // 参考线
  ctx.setLineDash([6, 8]);
  ctx.strokeStyle = '#e9e4f8';
  ctx.lineWidth = 1.5;
  for (let v = 0; v <= axisMax; v += axisMax / 4) {
    const gy = chartBottom - (v / axisMax) * chartH;
    ctx.beginPath();
    ctx.moveTo(chartX, gy);
    ctx.lineTo(chartX + chartW, gy);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  const slot = chartW / days;
  const barW = Math.min(26, slot - 8);
  for (let d = 1; d <= days; d++) {
    const h = hoursOfDaySafe(data, y, m, d);
    const cx = chartX + (d - 0.5) * slot;
    if (h > 0) {
      const bh = Math.max(6, (h / axisMax) * chartH);
      const grad = ctx.createLinearGradient(0, chartBottom - bh, 0, chartBottom);
      grad.addColorStop(0, PURPLE_LIGHT);
      grad.addColorStop(1, PURPLE);
      roundRect(ctx, cx - barW / 2, chartBottom - bh, barW, bh, Math.min(9, barW / 2));
      ctx.fillStyle = grad;
      ctx.fill();
      text(ctx, String(h), cx, chartBottom - bh - 12, '700 19px ' + FONT, PURPLE, 'center');
    } else {
      roundRect(ctx, cx - barW / 2, chartBottom - 4, barW, 4, 2);
      ctx.fillStyle = '#e9e4f8';
      ctx.fill();
    }
    text(ctx, String(d), cx, chartBottom + 34, '500 18px ' + FONT, INK_SOFT, 'center');
  }
  ctx.strokeStyle = '#ded7f2';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(chartX, chartBottom + 12);
  ctx.lineTo(chartX + chartW, chartBottom + 12);
  ctx.stroke();

  // 小结
  const best = stats.bestDay;
  const summary =
    '出勤 ' + stats.workDays + ' 天 · 日均 ' + stats.avgHours + ' h' +
    (best ? ' · 最多的一天 ' + best.hours + 'h（' + best.iso.slice(5).replace('-', '/') + '）' : '');
  text(ctx, summary, 100, 1112, '600 26px ' + FONT, '#4b4368');

  const wage = round2(stats.wage);
  text(
    ctx,
    '工时收入 ¥' + wage + ' ＋ 餐补 ¥' + stats.meal + ' ＝ ¥' + stats.income,
    100,
    1160,
    '600 26px ' + FONT,
    PURPLE
  );

  // 页脚
  ctx.strokeStyle = '#eee9f9';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(100, 1240);
  ctx.lineTo(W - 100, 1240);
  ctx.stroke();
  text(ctx, '工时记录 Worklog · 数据保存在本机，未上传任何服务器', 100, 1288, '400 20px ' + FONT, INK_SOFT);
  text(ctx, '按 ' + data.settings.hourlyRate + ' 元/小时 计价', W - 100, 1288, '400 20px ' + FONT, INK_SOFT, 'right');

  return canvas;
}

function hoursOfDaySafe(data: AppData, y: number, m: number, d: number): number {
  const iso = y + '-' + (m + 1 < 10 ? '0' + (m + 1) : String(m + 1)) + '-' + (d < 10 ? '0' + d : String(d));
  let sum = 0;
  for (const r of data.records) if (r.date === iso) sum += r.hours;
  return round2(sum);
}

export function downloadCanvasPNG(canvas: HTMLCanvasElement, filename: string): void {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, 'image/png');
}

export function downloadTextFile(text: string, filename: string, mime = 'text/csv;charset=utf-8'): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(v: string): string {
  if (v === '') return '';
  if (v.indexOf(',') >= 0 || v.indexOf('"') >= 0 || v.indexOf('\n') >= 0 || v.indexOf('\r') >= 0) {
    return '"' + v.split('"').join('""') + '"';
  }
  return v;
}

/** 明细 CSV：每天一行 + 末尾按月汇总；带 BOM，Excel 直接双击不乱码 */
export function buildCSV(data: AppData): string {
  const rows = activeDays(data).slice().reverse();
  const week = ['日', '一', '二', '三', '四', '五', '六'];
  const lines: string[] = [];
  lines.push(['日期', '星期', '工时', '时薪(元/小时)', '工时收入(元)', '餐补(元)', '当天合计(元)', '备注'].join(','));

  const months = new Map<string, { hours: number; wage: number; meal: number; days: number }>();
  for (const r of rows) {
    const d = new Date(Number(r.iso.slice(0, 4)), Number(r.iso.slice(5, 7)) - 1, Number(r.iso.slice(8, 10)));
    lines.push(
      [
        r.iso,
        '周' + week[d.getDay()],
        String(r.hours),
        r.hours > 0 ? String(round2(r.wage / r.hours)) : '',
        String(r.wage),
        String(r.meal),
        String(r.income),
        csvCell(r.note),
      ].join(',')
    );
    const key = r.iso.slice(0, 7);
    const agg = months.get(key) || { hours: 0, wage: 0, meal: 0, days: 0 };
    agg.hours = round2(agg.hours + r.hours);
    agg.wage = round2(agg.wage + r.wage);
    agg.meal = round2(agg.meal + r.meal);
    if (r.hours > 0) agg.days += 1;
    months.set(key, agg);
  }

  lines.push('');
  lines.push(['月份', '出勤天数', '工时', '工时收入(元)', '餐补(元)', '合计(元)'].join(','));
  for (const key of Array.from(months.keys()).sort()) {
    const a = months.get(key);
    if (!a) continue;
    lines.push([key, String(a.days), String(a.hours), String(a.wage), String(a.meal), String(round2(a.wage + a.meal))].join(','));
  }

  return '\ufeff' + lines.join('\r\n');
}
