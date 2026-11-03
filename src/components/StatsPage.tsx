/** 统计页：概览 + 整屏吸附的图表区（Scroll Snap）+ 横向 TOP 卡片 + 粘性月份标题的明细 */

import { useMemo, type CSSProperties } from 'react';
import { useStore } from '../store';
import { activeDays, groupByMonth, money, monthStats, recentMonths, yearStats } from '../lib/calc';
import { formatShortCN, monthLabel, todayISO } from '../lib/date';
import { useReveal, useSnapIndex } from '../hooks/useScrollFx';

export function StatsPage() {
  const { data } = useStore();
  const { settings } = data;
  const today = todayISO();
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7)) - 1;

  const month = useMemo(() => monthStats(data, y, m), [data, y, m]);
  const year = useMemo(() => yearStats(data, y), [data, y]);
  const series = useMemo(() => recentMonths(data, y, m, 12), [data, y, m]);
  const rows = useMemo(() => activeDays(data), [data]);
  const groups = useMemo(() => groupByMonth(rows), [rows]);
  const top = useMemo(() => rows.slice().sort((a, b) => b.hours - a.hours).slice(0, 6), [rows]);
  const snap = useSnapIndex(3);

  const maxHours = Math.max(1, ...series.map((p) => p.hours));
  const maxIncome = Math.max(1, ...series.map((p) => p.income));
  const maxTop = Math.max(1, ...top.map((t) => t.hours));

  useReveal([series.length, rows.length]);

  return (
    <div className="page view-fade">
      <div className="wrap stack" style={{ '--stack-gap': '22px' } as CSSProperties}>
        <div className="stat-grid" data-reveal>
          <Stat k="本月工时" v={String(month.hours)} unit="h" />
          <Stat k="本月收入" v={money(month.income)} unit={settings.currency} />
          <Stat k="本月餐补" v={money(month.meal)} unit={settings.currency} sub={month.mealDays + ' 天'} />
          <Stat k="本年累计" v={money(year.income)} unit={settings.currency} sub={year.hours + ' h'} />
        </div>

        {/* Scroll Snap：一次停一屏 */}
        <section className="snap-shell glass card--liquid" data-reveal aria-label="图表区，滚动切换">
          <div className="snap-dots">
            {[0, 1, 2].map((i) => (
              <button
                key={i}
                type="button"
                className={snap.index === i ? 'is-active' : ''}
                aria-label={'第 ' + (i + 1) + ' 屏'}
                onClick={() => snap.go(i)}
              />
            ))}
          </div>

          <div className="snap-scroller" ref={snap.ref}>
            <div className="snap-panel">
              <div className="section-title">
                <span className="h2">近 12 个月工时</span>
                <span className="tiny dim">单位：小时</span>
              </div>
              <div className="bars">
                {series.map((p) => (
                  <div className="bars__col" key={p.y + '-' + p.m} title={p.hours + ' 小时'}>
                    <span className="tiny num muted">{p.hours > 0 ? p.hours : ''}</span>
                    {p.hours > 0 ? (
                      <div className="bars__fill" style={{ height: Math.round((p.hours / maxHours) * 100) + '%' }} />
                    ) : (
                      <div className="bars__zero" />
                    )}
                    <span className="bars__label">{p.label}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="snap-panel">
              <div className="section-title">
                <span className="h2">近 12 个月收入</span>
                <span className="legend">
                  <span>
                    <i style={{ background: 'var(--accent-2)' }} />
                    工时收入
                  </span>
                  <span>
                    <i style={{ background: 'var(--meal)' }} />
                    餐补
                  </span>
                </span>
              </div>
              <div className="bars">
                {series.map((p) => (
                  <div className="bars__col" key={p.y + '-' + p.m} title={money(p.income) + ' 元'}>
                    <span className="tiny num muted">{p.income > 0 ? money(p.income) : ''}</span>
                    <div
                      className="bars__fill"
                      style={{ height: Math.round((p.income / maxIncome) * 100) + '%', position: 'relative' }}
                    >
                      {p.meal > 0 ? (
                        <span
                          className="bars__fill bars__fill--meal"
                          style={{
                            position: 'absolute',
                            left: 0,
                            right: 0,
                            bottom: 0,
                            height: Math.round((p.meal / p.income) * 100) + '%',
                          }}
                        />
                      ) : null}
                    </div>
                    <span className="bars__label">{p.label}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="snap-panel">
              <div className="section-title">
                <span className="h2">最忙的几天</span>
                <span className="tiny dim">横向滑动</span>
              </div>
              <div className="h-scroller">
                {top.length === 0 ? (
                  <div className="empty">
                    <span className="empty__art">📊</span>
                    <span>还没有数据</span>
                  </div>
                ) : (
                  top.map((t) => (
                    <div key={t.iso} className="glass card card--tight h-item" style={{ width: 220 }}>
                      <div className="tiny muted left">{formatShortCN(t.iso)}</div>
                      <div className="num" style={{ fontSize: 30, fontWeight: 750, margin: '4px 0 8px' }}>
                        {t.hours}
                        <span className="tiny muted"> h</span>
                      </div>
                      <div className="bars__fill" style={{ height: 6, width: Math.round((t.hours / maxTop) * 100) + '%' }} />
                      <div className="tiny muted left" style={{ marginTop: 8 }}>
                        {settings.currency}
                        {money(t.income)}
                        {t.meal > 0 ? ' · 餐补 ' + t.meal : ''}
                      </div>
                    </div>
                  ))
                )}
              </div>
              <div className="tiny dim center" style={{ marginTop: 8 }}>
                继续往下滚，明细在下面
              </div>
            </div>
          </div>
        </section>

        {/* Sticky 月份标题：像通讯录的字母标题一样钉在顶部 */}
        <section className="glass card" data-reveal>
          <div className="section-title">
            <span className="h2">每日明细</span>
            <span className="tiny dim">共 {rows.length} 天有记录</span>
          </div>
          <div className="detail">
            {groups.length === 0 ? (
              <div className="empty">
                <span className="empty__art">🗂</span>
                <span>还没有记录</span>
              </div>
            ) : (
              groups.map((g) => (
                <div key={g.key}>
                  <div className="group-title">
                    <span>{g.label}</span>
                    <span className="num muted">
                      {g.hours} h · {settings.currency}
                      {money(g.income)}
                    </span>
                  </div>
                  {g.rows.map((row) => (
                    <div className="day-row" key={row.iso}>
                      <span className="day-row__date">{row.iso.slice(5)}</span>
                      <span className="day-row__note">{row.note || '—'}</span>
                      <span className="day-row__h">
                        {row.hours} h
                        {row.meal > 0 ? <span className="badge badge--meal" style={{ marginLeft: 8 }}>餐 {row.meal}</span> : null}
                      </span>
                      <span className="day-row__money">
                        {settings.currency}
                        {money(row.income)}
                      </span>
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>
        </section>

        <section className="glass card" data-reveal>
          <div className="row">
            <div className="row__label">
              <strong>{monthLabel(y, m)}小结</strong>
              <div className="tiny muted">
                出勤 {month.workDays} 天 · 平均每天 {month.avgHours} h · 餐补 {month.mealDays} 天
              </div>
            </div>
            <div className="row__value num" style={{ color: 'var(--ink-1)', fontWeight: 700 }}>
              {month.hours} h / {settings.currency}
              {money(month.income)}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function Stat({ k, v, unit, sub }: { k: string; v: string; unit?: string; sub?: string }) {
  return (
    <div className="stat glass card--liquid">
      <span className="stat__k">{k}</span>
      <span className="stat__v">
        {v}
        {unit ? <small>{unit}</small> : null}
      </span>
      {sub ? <span className="tiny dim left">{sub}</span> : null}
    </div>
  );
}
