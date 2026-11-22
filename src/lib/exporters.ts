/** 导出：月度报表图片（canvas 手绘，零依赖）与明细 CSV */

import type { AppData } from '../types';
import { activeDays, monthStats, round2 } from './calc';
import { daysInMonth, monthLabel } from './date';

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
const FONT_BODY =
  '"Inter Variable", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
const FONT_DISPLAY = '"Oswald", "Inter Variable", "PingFang SC", "Microsoft YaHei", sans-serif';
const FONT_MONO = '"IBM Plex Mono", "SFMono-Regular", Consolas, monospace';

const REP_BG = '#e9e4d6';
const REP_CARD = '#f7f3e8';
const REP_SURFACE = '#efeadd';
const REP_INK = '#15130e';
const REP_MUTED = '#6b6555';
const REP_LINE = '#d8d1bf';
const REP_BLUE = '#0000f2';
const REP_DARK = '#0d0d24';

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, w: number, h: number) {
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
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

  const [artHours, artIncome] = await Promise.all([
    loadImage(import.meta.env.BASE_URL + 'print-putus-wide-dark.webp').catch(() => null),
    loadImage(import.meta.env.BASE_URL + 'print-blue-wide-dark.webp').catch(() => null),
  ]).then((r) => r as Array<HTMLImageElement | null>);

  const canvas = document.createElement('canvas');
  canvas.width = W * S;
  canvas.height = H * S;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.scale(S, S);

  ctx.fillStyle = REP_BG;
  ctx.fillRect(0, 0, W, H);

  // 外框
  ctx.fillStyle = REP_CARD;
  ctx.fillRect(40, 40, W - 80, H - 80);
  ctx.strokeStyle = REP_LINE;
  ctx.lineWidth = 1;
  ctx.strokeRect(40.5, 40.5, W - 81, H - 81);

  // 标题
  text(ctx, monthLabel(y, m) + ' 工时报表', 80, 118, '500 38px ' + FONT_DISPLAY, REP_INK);
  const now = new Date();
  const pad = (n: number) => (n < 10 ? '0' + n : String(n));
  const stamp =
    now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes());
  text(ctx, '生成于 ' + stamp, W - 80, 114, '400 14px ' + FONT_MONO, REP_MUTED, 'right');
  ctx.strokeStyle = REP_LINE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(80, 148);
  ctx.lineTo(W - 80, 148);
  ctx.stroke();

  // 两张深色汇总卡
  const px = 80;
  const py = 180;
  const gap = 16;
  const pw = (W - 160 - gap) / 2;
  const ph = 210;
  const panels: Array<[HTMLImageElement | null, string, string]> = [
    [artHours, '本月工时', String(stats.hours) + ' h'],
    [artIncome, '本月收入', data.settings.currency + stats.income],
  ];
  panels.forEach(([img, label, value], i) => {
    const x = px + i * (pw + gap);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, py, pw, ph);
    ctx.clip();
    ctx.fillStyle = REP_DARK;
    ctx.fillRect(x, py, pw, ph);
    if (img) {
      ctx.globalAlpha = 0.62;
      ctx.filter = 'grayscale(1) contrast(1.08)';
      drawCover(ctx, img, x, py, pw, ph);
      ctx.filter = 'none';
      ctx.globalAlpha = 1;
    }
    const grad = ctx.createLinearGradient(0, py, 0, py + ph);
    grad.addColorStop(0, 'rgba(5,5,22,0.12)');
    grad.addColorStop(0.5, 'rgba(5,5,22,0.35)');
    grad.addColorStop(1, 'rgba(5,5,22,0.96)');
    ctx.fillStyle = grad;
    ctx.fillRect(x, py, pw, ph);
    text(ctx, label, x + 24, py + 34, '500 12px ' + FONT_MONO, 'rgba(255,255,255,0.78)');
    text(ctx, value, x + 24, py + ph - 26, '300 66px ' + FONT_DISPLAY, '#ffffff');
    ctx.restore();
  });

  // 四列统计条
  const sy = py + ph + 14;
  const sh = 78;
  const sw = (W - 160) / 4;
  const cellTexts: Array<[string, string]> = [
    ['出勤', stats.workDays + ' 天'],
    ['日均', stats.avgHours + ' h'],
    ['最多一天', stats.bestDay ? stats.bestDay.hours + 'h · ' + stats.bestDay.iso.slice(5).replace('-', '/') : '—'],
    ['本月饭补', data.settings.currency + stats.meal],
  ];
  ctx.fillStyle = REP_SURFACE;
  ctx.fillRect(px, sy, W - 160, sh);
  ctx.strokeStyle = REP_LINE;
  ctx.strokeRect(px + 0.5, sy + 0.5, W - 161, sh - 1);
  cellTexts.forEach(([label, value], i) => {
    const x = px + i * sw;
    if (i > 0) {
      ctx.beginPath();
      ctx.moveTo(x + 0.5, sy + 1);
      ctx.lineTo(x + 0.5, sy + sh - 1);
      ctx.stroke();
    }
    text(ctx, label, x + sw / 2, sy + 27, '500 11px ' + FONT_MONO, REP_MUTED, 'center');
    text(ctx, value, x + sw / 2, sy + 58, '400 24px ' + FONT_DISPLAY, REP_INK, 'center');
  });

  // 每日工时柱状图
  text(ctx, '每日工时', px, 550, '500 22px ' + FONT_BODY, REP_INK);
  const chartX = px;
  const chartW = W - 160;
  const chartTop = 590;
  const chartBottom = 1010;
  const chartH = chartBottom - chartTop;

  let maxHours = 0;
  for (let d = 1; d <= days; d++) maxHours = Math.max(maxHours, hoursOfDaySafe(data, y, m, d));
  const axisMax = Math.max(8, Math.ceil(maxHours / 2) * 2);

  ctx.setLineDash([4, 8]);
  ctx.strokeStyle = REP_LINE;
  ctx.lineWidth = 1;
  for (let v = 0; v <= axisMax; v += axisMax / 4) {
    const gy = chartBottom - (v / axisMax) * chartH;
    ctx.beginPath();
    ctx.moveTo(chartX, gy);
    ctx.lineTo(chartX + chartW, gy);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  const slot = chartW / days;
  const barW = Math.min(22, slot - 10);
  for (let d = 1; d <= days; d++) {
    const h = hoursOfDaySafe(data, y, m, d);
    const cx = chartX + (d - 0.5) * slot;
    if (h > 0) {
      const bh = Math.max(5, (h / axisMax) * chartH);
      ctx.fillStyle = REP_BLUE;
      ctx.fillRect(cx - barW / 2, chartBottom - bh, barW, bh);
      text(ctx, String(h), cx, chartBottom - bh - 8, '500 13px ' + FONT_MONO, REP_BLUE, 'center');
    } else {
      ctx.fillStyle = REP_LINE;
      ctx.fillRect(cx - barW / 2, chartBottom - 2, barW, 2);
    }
    text(ctx, String(d), cx, chartBottom + 24, '400 11px ' + FONT_MONO, REP_MUTED, 'center');
  }
  ctx.strokeStyle = REP_LINE;
  ctx.beginPath();
  ctx.moveTo(chartX, chartBottom + 4);
  ctx.lineTo(chartX + chartW, chartBottom + 4);
  ctx.stroke();

  // 小结
  const best = stats.bestDay;
  const summary =
    '出勤 ' + stats.workDays + ' 天 · 日均 ' + stats.avgHours + ' h' +
    (best ? ' · 最多的一天 ' + best.hours + 'h（' + best.iso.slice(5).replace('-', '/') + '）' : '');
  text(ctx, summary, px, 1084, '500 18px ' + FONT_BODY, REP_MUTED);

  const wage = round2(stats.wage);
  text(ctx, '工时收入 ' + data.settings.currency + wage, px, 1130, '400 22px ' + FONT_DISPLAY, REP_INK);
  text(ctx, '＋ 饭补 ' + data.settings.currency + stats.meal, px, 1162, '400 22px ' + FONT_DISPLAY, REP_INK);
  text(ctx, '＝ ' + data.settings.currency + stats.income, W - 80, 1162, '400 34px ' + FONT_DISPLAY, REP_BLUE, 'right');

  // 页脚
  ctx.strokeStyle = REP_LINE;
  ctx.beginPath();
  ctx.moveTo(px, 1240);
  ctx.lineTo(W - 80, 1240);
  ctx.stroke();
  text(ctx, '工时记录 Worklog · 本地优先 · 云端同步', px, 1288, '400 14px ' + FONT_MONO, REP_MUTED);
  text(ctx, '按 ' + data.settings.hourlyRate + ' 元/小时 计价', W - 80, 1288, '400 14px ' + FONT_MONO, REP_MUTED, 'right');

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
  lines.push(['日期', '星期', '工时', '时薪(元/小时)', '工时收入(元)', '饭补(元)', '当天合计(元)', '备注'].join(','));

  const monthKeys = new Set<string>();
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
    monthKeys.add(r.iso.slice(0, 7));
  }
  for (const key of Object.keys(data.monthMeals || {})) monthKeys.add(key);

  lines.push('');
  lines.push(['月份', '出勤天数', '工时', '工时收入(元)', '饭补(元)', '合计(元)'].join(','));
  for (const key of Array.from(monthKeys).sort()) {
    const y = Number(key.slice(0, 4));
    const m = Number(key.slice(5, 7)) - 1;
    const a = monthStats(data, y, m);
    lines.push([key, String(a.workDays), String(a.hours), String(a.wage), String(a.meal), String(a.income)].join(','));
  }

  return '\ufeff' + lines.join('\r\n');
}
