/** 记工时（首页）：月份切换 + 横向月份条 + 汇总卡 + 日历 + 最近记录 */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import { useStore, type BatchPatch } from '../store';
import { monthStats, activeDays, money, weekdaysOfMonth, weekOf } from '../lib/calc';
import {
  addMonths,
  formatShortCN,
  monthDates,
  monthLabel,
  monthMatrix,
  monthRangeText,
  pad2,
  todayISO,
  weekdayHeaders,
} from '../lib/date';
import { downloadJSON } from '../lib/storage';
import { SummaryHero } from './SummaryHero';
import { DayDrawer } from './DayDrawer';
import { BatchBar } from './BatchBar';
import { useKeys } from '../hooks/useScrollFx';
import { CheckIcon } from './ui';
import { dayMark } from '../lib/holidays';
import { buildCSV, downloadCanvasPNG, downloadTextFile, renderMonthReport } from '../lib/exporters';

export function CalendarPage() {
  const { data, setDayHours, batchApply, toast } = useStore();
  const { settings } = data;

  const today = todayISO();
  const [cursor, setCursor] = useState(() => ({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) - 1 }));
  const [openISO, setOpenISO] = useState<string | null>(null);
  const [batch, setBatch] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  /** 就地输入：正在编辑哪一天、输入框里的文本 */
  const [editingISO, setEditingISO] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const painting = useRef<boolean | null>(null);
  const lastPicked = useRef<string | null>(null);

  const stats = useMemo(() => monthStats(data, cursor.y, cursor.m), [data, cursor.y, cursor.m]);
  const cells = useMemo(() => monthMatrix(cursor.y, cursor.m, settings.weekStart), [cursor.y, cursor.m, settings.weekStart]);
  const heads = useMemo(() => weekdayHeaders(settings.weekStart), [settings.weekStart]);
  const recent = useMemo(() => activeDays(data).slice(0, 12), [data]);

  const hoursByDate = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of data.records) map.set(r.date, (map.get(r.date) || 0) + r.hours);
    return map;
  }, [data.records]);

  useEffect(() => {
    const up = () => {
      painting.current = null;
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  const togglePick = (iso: string, add: boolean) => {
    setPicked((prev) => {
      if (add) return prev.includes(iso) ? prev : prev.concat([iso]);
      return prev.filter((x) => x !== iso);
    });
  };

  /* ---------------- 就地输入工时（单击格子直接打字） ---------------- */
  const startEditing = (iso: string) => {
    const h = hoursByDate.get(iso) || 0;
    setEditingText(h > 0 ? String(h) : '');
    setEditingISO(iso);
  };

  const commitEditing = () => {
    if (!editingISO) return;
    const raw = editingText.trim();
    if (raw === '') {
      setDayHours(editingISO, 0);
    } else {
      const n = Number(raw);
      if (Number.isFinite(n)) setDayHours(editingISO, n);
    }
    setEditingISO(null);
  };

  /** Shift 区间选择：从上一次点的那天一路选到这天 */
  const pickRange = (from: string, to: string) => {
    const list = cells.filter((c) => c.inMonth).map((c) => c.iso);
    const a = list.indexOf(from);
    const b = list.indexOf(to);
    if (a < 0 || b < 0) return;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    setPicked((prev) => {
      const set = new Set(prev);
      for (const d of list.slice(lo, hi + 1)) set.add(d);
      return Array.from(set);
    });
  };

  const cellActivate = (iso: string) => {
    if (batch) {
      togglePick(iso, !picked.includes(iso));
      lastPicked.current = iso;
      return;
    }
    startEditing(iso);
  };

  /** mousedown 只在批量模式下干活：拖动刷选必须靠它。
   *  非批量走 click —— 用 mousedown 会在同一帧里先聚焦 button、再把刚挂载的输入框顶掉。 */
  const cellDown = (e: ReactMouseEvent, iso: string) => {
    if (!batch) return;
    if (e.shiftKey && lastPicked.current) {
      pickRange(lastPicked.current, iso);
      painting.current = null;
      return;
    }
    const has = picked.includes(iso);
    painting.current = !has;
    togglePick(iso, !has);
    lastPicked.current = iso;
  };

  const cellEnter = (iso: string) => {
    if (!batch || painting.current === null) return;
    togglePick(iso, painting.current);
  };

  // 批量模式下 Ctrl/Cmd + A 全选当月
  useEffect(() => {
    if (!batch) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        setPicked(monthDates(cursor.y, cursor.m));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [batch, cursor.y, cursor.m]);

  const go = (delta: number) => {
    setCursor((c) => addMonths(c.y, c.m, delta));
  };

  useKeys({
    onPrev: () => go(-1),
    onNext: () => go(1),
    onToday: () => {
      setCursor({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) - 1 });
    },
    onEscape: () => {
      if (openISO) setOpenISO(null);
      else if (editingISO) setEditingISO(null);
      else if (batch) setBatch(false);
    },
  });

  const quickPick = (kind: 'week' | 'weekdays' | 'monthWeekdays' | 'monthAll' | 'none') => {
    if (kind === 'none') return setPicked([]);
    if (kind === 'week') return setPicked(weekOf(today, settings.weekStart));
    if (kind === 'weekdays') return setPicked(weekOf(today, settings.weekStart).filter((iso) => !weekdayIsWeekend(iso)));
    if (kind === 'monthWeekdays') return setPicked(weekdaysOfMonth(cursor.y, cursor.m));
    return setPicked(monthDates(cursor.y, cursor.m));
  };

  const exportReportImage = async () => {
    const canvas = await renderMonthReport(data, cursor.y, cursor.m);
    downloadCanvasPNG(canvas, '工时报表-' + cursor.y + '-' + pad2(cursor.m + 1) + '.png');
    toast('报表图片已导出（' + monthLabel(cursor.y, cursor.m) + '）');
  };

  const exportCSV = () => {
    downloadTextFile(buildCSV(data), '工时明细-' + today + '.csv');
    toast('CSV 已导出，Excel 可直接打开');
  };

  const applyBatch = (patch: BatchPatch) => {
    if (picked.length === 0) return;
    batchApply(picked, patch);
    toast('已写入 ' + picked.length + ' 天');
    setPicked([]);
  };

  const yearMonths = Array.from({ length: 12 }, (_, i) => i);

  return (
    <div className="page view-fade">
      <div className="wrap stack" style={{ '--stack-gap': '18px' } as CSSProperties}>
        <div className="monthbar" data-reveal>
          <button type="button" className="btn btn--glass btn--icon" onClick={() => go(-1)} aria-label="上个月">
            ‹
          </button>
          <div>
            <div className="monthbar__label">{monthLabel(cursor.y, cursor.m)}</div>
            <div className="monthbar__range">{monthRangeText(cursor.y, cursor.m)}</div>
          </div>
          <button type="button" className="btn btn--glass btn--icon" onClick={() => go(1)} aria-label="下个月">
            ›
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setCursor({ y: Number(today.slice(0, 4)), m: Number(today.slice(5, 7)) - 1 })}
          >
            今天
          </button>

          <div className="monthbar__spacer">
            <button
              type="button"
              className={'chip' + (batch ? ' is-active' : '')}
              onClick={() => {
                setBatch(!batch);
                if (batch) setPicked([]);
              }}
            >
              {batch ? '退出批量' : '批量'}
            </button>
            <button
              type="button"
              className="chip"
              onClick={() => {
                downloadJSON(data);
                toast('已导出备份文件');
              }}
            >
              备份
            </button>
          </div>
        </div>

        {/* Horizontal Scroll + Snap：一整年的月份横着滑 */}
        <div className="monthstrip" data-reveal>
          <div className="h-scroller">
            {yearMonths.map((m) => (
              <button
                key={m}
                type="button"
                className={'chip h-item' + (m === cursor.m ? ' is-active' : '')}
                onClick={() => setCursor((c) => ({ y: c.y, m }))}
              >
                {m + 1}月
              </button>
            ))}
          </div>
        </div>

        <SummaryHero stats={stats} />

        <section className="glass card card--liquid calendar" data-reveal aria-label="日历">
          <div className="cal__head">
            {heads.map((h) => (
              <span key={h}>{h}</span>
            ))}
          </div>
          <div className="cal__grid">
            {cells.map((c) => {
              const h = hoursByDate.get(c.iso) || 0;
              const meal = data.meals[c.iso];
              const mark = dayMark(c.iso);
              const cls = ['cell', 'h-item'];
              if (!c.inMonth) cls.push('is-out');
              if (mark && mark.kind === 'holiday') cls.push('is-holiday');
              else if (mark && mark.kind === 'workday') cls.push('is-makeup');
              else if (c.weekday === 0 || c.weekday === 6) cls.push('is-weekend');
              if (h > 0) cls.push('is-work');
              if (c.iso === today) cls.push('is-today');
              if (batch && picked.includes(c.iso)) cls.push('is-selected');
              const title =
                c.iso +
                (mark ? ' · ' + mark.name : '') +
                (h > 0 ? ' · 工时 ' + h + ' 小时' : '') +
                (meal ? ' · 餐补 ' + meal + ' 元' : '');
              const level = h >= 11 ? 3 : h >= 9 ? 2 : 1;

              // 就地输入时不能把 input 放进 button：button 里嵌交互元素是非法结构，而且点完焦点会被 button 抢走
              if (editingISO === c.iso) {
                return (
                  <div key={c.iso} className={cls.join(' ') + ' is-editing'} data-level={level} title={title}>
                    <span className="cell__d">{c.day}</span>
                    <input
                      className="cell__input"
                      type="number"
                      inputMode="decimal"
                      step={0.5}
                      min={0}
                      max={24}
                      value={editingText}
                      autoFocus
                      aria-label="输入当天工时"
                      placeholder="0"
                      onChange={(ev) => setEditingText(ev.target.value)}
                      onBlur={commitEditing}
                      onKeyDown={(ev) => {
                        if (ev.key === 'Enter') {
                          ev.preventDefault();
                          commitEditing();
                        } else if (ev.key === 'Escape') {
                          ev.preventDefault();
                          setEditingISO(null);
                        }
                      }}
                    />
                    {meal ? <span className="cell__meal">餐 {meal}</span> : null}
                    {mark ? (
                      <span
                        className={
                          'mark-chip cell__mark ' +
                          (mark.kind === 'holiday' ? 'mark-chip--holiday' : 'mark-chip--workday')
                        }
                      >
                        {mark.short}
                      </span>
                    ) : null}
                    <button
                      type="button"
                      className="cell__more"
                      title="打开详情（餐补 / 记多条 / 备注）"
                      aria-label="打开详情"
                      onMouseDown={(ev) => ev.preventDefault()}
                      onClick={() => {
                        setEditingISO(null);
                        setOpenISO(c.iso);
                      }}
                    >
                      ⋯
                    </button>
                  </div>
                );
              }

              return (
                <button
                  key={c.iso}
                  type="button"
                  className={cls.join(' ')}
                  data-level={level}
                  title={title}
                  onMouseDown={(e) => cellDown(e, c.iso)}
                  onMouseEnter={() => cellEnter(c.iso)}
                  onClick={(e) => {
                    if (e.detail === 0) {
                      cellActivate(c.iso); // 键盘（回车/空格）
                      return;
                    }
                    if (!batch && editingISO !== c.iso) startEditing(c.iso);
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setEditingISO(null);
                    setOpenISO(c.iso);
                  }}
                  aria-label={title}
                >
                  <span className="cell__d">{c.day}</span>
                  {h > 0 ? <span className="cell__h">{h}h</span> : null}
                  {meal ? <span className="cell__meal">餐 {meal}</span> : null}
                  {mark ? (
                    <span
                      className={
                        'mark-chip cell__mark ' +
                        (mark.kind === 'holiday' ? 'mark-chip--holiday' : 'mark-chip--workday')
                      }
                    >
                      {mark.short}
                    </span>
                  ) : null}
                  {batch && picked.includes(c.iso) ? (
                    <span className="cell__tick">
                      <CheckIcon />
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </section>

        <section data-reveal>
          <div className="section-title">
            <span className="h2">最近记录</span>
            <span className="tiny dim">横向滑动查看</span>
          </div>
          {recent.length === 0 ? (
            <div className="glass card empty">
              <span className="empty__art">📝</span>
              <span>还没有记录，点日历上任意一天就能开始记</span>
            </div>
          ) : (
            <div className="h-scroller">
              {recent.map((row) => (
                <button
                  key={row.iso}
                  type="button"
                  className="glass card card--tight recent__card h-item"
                  onClick={() => setOpenISO(row.iso)}
                >
                  <span className="recent__date">{formatShortCN(row.iso)}</span>
                  <span className="recent__hours num">
                    {row.hours}
                    <span className="tiny muted"> h</span>
                  </span>
                  <span className="recent__meta">
                    <span className="num">
                      {settings.currency}
                      {money(row.income)}
                    </span>
                    {row.meal > 0 ? <span className="badge badge--meal">餐补 {row.meal}</span> : null}
                  </span>
                  {row.note ? <span className="tiny muted left">{row.note}</span> : null}
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="glass card" data-reveal>
          <div className="row">
            <div className="row__label">
              <strong>本月小结</strong>
              <div className="tiny muted">
                {monthLabel(cursor.y, cursor.m)} · 出勤 {stats.workDays} 天 · 日均 {stats.avgHours} h
              </div>
            </div>
            <div className="row__value num" style={{ color: 'var(--ink-1)', fontWeight: 700 }}>
              {settings.currency}
              {money(stats.income)}
            </div>
          </div>
          <div className="row">
            <div className="row__label">
              <strong>日历标记</strong>
              <div className="tiny muted">
                法定节假日与调休按国务院办公厅 2026 年安排标注；周末单独着色
              </div>
            </div>
            <div className="row__value nowrap">
              <span className="mark-chip mark-chip--holiday">国庆</span> 放假 ·{' '}
              <span className="mark-chip mark-chip--workday">班</span> 调休上班
            </div>
          </div>
          <div className="row">
            <div className="row__label">
              <strong>导出</strong>
              <div className="tiny muted">
                图片是这个月的报表（直接发微信就行）；CSV 是全部月份的每日明细，末尾附按月汇总
              </div>
            </div>
            <div className="row__value nowrap" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn--clay btn--sm" onClick={() => void exportReportImage()}>
                导出报表图片
              </button>
              <button type="button" className="btn btn--glass btn--sm" onClick={exportCSV}>
                导出 CSV 明细
              </button>
            </div>
          </div>
          <div className="row">
            <div className="row__label">
              <strong>怎么记更快</strong>
              <div className="tiny muted">
                单击格子直接填工时（回车确认，Esc 取消）；点右下角「⋯」或双击格子打开详情，记餐补 / 多条 / 备注
              </div>
            </div>
            <div className="row__value nowrap">批量模式：Shift 点选区间 · Ctrl+A 全选当月</div>
          </div>
          <div className="row">
            <div className="row__label">
              <strong>键盘快捷键</strong>
              <div className="tiny muted">上手之后基本不用点鼠标</div>
            </div>
            <div className="row__value nowrap">
              <span className="kbd">←</span> <span className="kbd">→</span> 切月 · <span className="kbd">T</span> 今天
            </div>
          </div>
        </section>
      </div>

      {openISO ? <DayDrawer iso={openISO} onClose={() => setOpenISO(null)} /> : null}

      {batch ? (
        <BatchBar picked={picked} onApply={applyBatch} onClear={() => setBatch(false)} onQuick={quickPick} />
      ) : null}
    </div>
  );
}

function weekdayIsWeekend(iso: string): boolean {
  const w = new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))).getDay();
  return w === 0 || w === 6;
}


