/** 当天编辑抽屉：记工时（可多条）+ 餐补（1~100，手动开关） */

import { useEffect, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../store';
import { formatCN } from '../lib/date';
import { clampMeal, hoursOfDay, incomeOfDay, mealOfDay, money, recordsOfDay, wageOfDay } from '../lib/calc';
import { MEAL_MAX, MEAL_MIN } from '../types';
import { NumberField, Switch } from './ui';
import { useReveal } from '../hooks/useScrollFx';

const MEAL_PRESETS = [10, 15, 20, 25, 30];

export function DayDrawer({ iso, onClose }: { iso: string; onClose: () => void }) {
  const { data, addRecord, updateRecord, removeRecord, clearDay, setMeal, toast } = useStore();
  const { settings } = data;
  const rows = recordsOfDay(data, iso);
  const meal = mealOfDay(data, iso);
  const hours = hoursOfDay(data, iso);
  const income = incomeOfDay(data, iso);

  // 抽屉是后挂载的，这里重新扫一遍滚动淡入，否则里面的卡片会一直透明
  useReveal([iso]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="记工时">
        <div className="drawer__head">
          <div>
            <div className="h2">{formatCN(iso)}</div>
            <div className="tiny muted" style={{ marginTop: 4 }}>
              合计 {hours} h · {settings.currency}
              {money(income)}
            </div>
          </div>
          <button type="button" className="btn btn--glass btn--sm" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="stack" style={{ '--stack-gap': '18px' } as CSSProperties}>
          <section className="glass card card--tight" data-reveal>
            <div className="section-title">
              <span className="h3">工时</span>
              <span className="tiny dim">一天可以记多条</span>
            </div>

            {rows.length === 0 ? (
              <div className="empty" style={{ padding: '22px 8px' }}>
                <span className="empty__art">🗓</span>
                <span className="tiny">这天还没有记录</span>
              </div>
            ) : null}

            <div className="stack" style={{ '--stack-gap': '12px' } as CSSProperties}>
              {rows.map((r) => {
                const rate = r.rate === null ? settings.hourlyRate : r.rate;
                return (
                  <div key={r.id} className="glass card card--tight" data-reveal style={{ borderRadius: 'var(--radius-md)' }}>
                    <div className="rec__top">
                      <NumberField
                        value={r.hours}
                        onChange={(v) => updateRecord(r.id, { hours: v })}
                        min={0}
                        max={24}
                        step={0.5}
                        suffix="小时"
                        ariaLabel="工时"
                        width={148}
                      />
                      <span className="rec__money num">
                        {settings.currency}
                        {money(r.hours * rate)}
                      </span>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm btn--danger"
                        onClick={() => removeRecord(r.id)}
                        aria-label="删除这条记录"
                      >
                        删除
                      </button>
                    </div>
                    <div className="rec__bottom">
                      <NumberField
                        value={r.rate === null ? 0 : r.rate}
                        onChange={(v) => updateRecord(r.id, { rate: v > 0 ? v : null })}
                        min={0}
                        max={100000}
                        step={1}
                        suffix="元/小时"
                        placeholder={String(settings.hourlyRate)}
                        ariaLabel="单独时薪"
                        width={172}
                      />
                      <input
                        className="input"
                        type="text"
                        value={r.note}
                        placeholder="备注（可选）"
                        aria-label="备注"
                        onChange={(e) => updateRecord(r.id, { note: e.target.value })}
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            <div style={{ marginTop: 14 }}>
              <button type="button" className="btn btn--clay btn--sm" onClick={() => addRecord(iso, { hours: 8 })}>
                ＋ 再加一条
              </button>
            </div>
          </section>

          <section className="glass card card--tight" data-reveal>
            <div className="section-title">
              <span className="h3">餐补</span>
              <span className="tiny dim">1 ~ {MEAL_MAX} 元，按天记</span>
            </div>

            <div className="row" style={{ padding: '4px 0 10px' }}>
              <div className="row__label">
                <strong>{meal > 0 ? '这天有餐补' : '这天没有餐补'}</strong>
                <div className="tiny muted">手动选择哪天有、哪天没有</div>
              </div>
              <Switch
                checked={meal > 0}
                label="餐补开关"
                onChange={(on) => setMeal(iso, on ? settings.defaultMeal || 15 : null)}
              />
            </div>

            {meal > 0 ? (
              <>
                <div className="input-row" style={{ gap: 12 }}>
                  <input
                    className="slider"
                    type="range"
                    min={MEAL_MIN}
                    max={MEAL_MAX}
                    value={meal}
                    aria-label="餐补金额"
                    onChange={(e) => setMeal(iso, clampMeal(Number(e.target.value)))}
                  />
                  <NumberField
                    value={meal}
                    onChange={(v) => setMeal(iso, v > 0 ? clampMeal(v) : null)}
                    min={MEAL_MIN}
                    max={MEAL_MAX}
                    suffix="元"
                    ariaLabel="餐补金额"
                    width={130}
                  />
                </div>
                <div className="h-scroller" style={{ marginTop: 10, paddingBottom: 6 }}>
                  {MEAL_PRESETS.map((v) => (
                    <button
                      key={v}
                      type="button"
                      className={'chip h-item' + (meal === v ? ' is-active' : '')}
                      onClick={() => setMeal(iso, v)}
                    >
                      {v} 元
                    </button>
                  ))}
                </div>
              </>
            ) : null}
          </section>

          <section className="glass card card--tight" data-reveal>
            <div className="row" style={{ padding: '2px 0' }}>
              <div className="row__label">
                <strong>当天收入</strong>
                <div className="tiny muted">
                  工时收入 {settings.currency}
                  {money(wageOfDay(data, iso))} ＋ 餐补 {settings.currency}
                  {money(meal)}
                </div>
              </div>
              <div className="row__value num" style={{ fontSize: 20, fontWeight: 750, color: 'var(--ink-1)' }}>
                {settings.currency}
                {money(income)}
              </div>
            </div>
            <div style={{ marginTop: 12 }}>
              <button
                type="button"
                className="btn btn--ghost btn--sm btn--danger"
                onClick={() => {
                  clearDay(iso);
                  toast('已清空 ' + iso.slice(5) + ' 的记录');
                }}
              >
                清空这一天的记录与餐补
              </button>
            </div>
          </section>
        </div>
      </aside>
    </>,
    document.body
  );
}
