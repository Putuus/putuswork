/** 顶部汇总：Hermes 风格双联人物画卡片 + 本月饭补可直接填总数 */

import { useEffect, useState } from 'react';
import { money } from '../lib/calc';
import type { MonthStats } from '../lib/calc';
import { monthLabel } from '../lib/date';
import { useStore } from '../store';
import { EyeIcon } from './ui';

const ART_HOURS = import.meta.env.BASE_URL + 'print-putus-wide-dark.webp';
const ART_INCOME = import.meta.env.BASE_URL + 'print-blue-wide-dark.webp';

export function SummaryHero({ stats }: { stats: MonthStats }) {
  const { data, setSettings, setMonthMeal } = useStore();
  const { settings } = data;
  const shown = settings.showIncome;
  const monthKey = stats.y + '-' + String(stats.m + 1).padStart(2, '0');
  const [mealText, setMealText] = useState(stats.meal > 0 ? String(stats.meal) : '');

  useEffect(() => {
    setMealText(stats.meal > 0 ? String(stats.meal) : '');
  }, [stats.meal, monthKey]);

  const commitMeal = () => {
    const n = Number(mealText.replace(/[^\d.]/g, ''));
    const value = Number.isFinite(n) && n > 0 ? Math.min(100000, Math.round(n * 100) / 100) : 0;
    setMonthMeal(monthKey, value || null);
    setMealText(value > 0 ? String(value) : '');
  };

  return (
    <section className="hero" data-reveal aria-label="本月汇总">
      <div className="hero__panels">
        <article className="hero__panel">
          <img className="hero__panel-art" src={ART_HOURS} alt="" />
          <div className="hero__panel-shade" />
          <div className="hero__panel-body">
            <div className="hero__k">本月工时</div>
            <div className="hero__v">
              {stats.hours}
              <small>h</small>
            </div>
          </div>
        </article>

        <article className="hero__panel">
          <img className="hero__panel-art" src={ART_INCOME} alt="" />
          <div className="hero__panel-shade" />
          <div className="hero__panel-body">
            <div className="hero__k">
              <span>本月收入</span>
              <button
                type="button"
                className="hero__eye"
                title={shown ? '隐藏收入' : '显示收入'}
                aria-label={shown ? '隐藏收入' : '显示收入'}
                onClick={() => setSettings({ showIncome: !shown })}
              >
                <EyeIcon off={!shown} />
              </button>
            </div>
            <div className="hero__v">
              {shown ? (
                <>
                  <small className="hero__cur">{settings.currency}</small>
                  {money(stats.income)}
                </>
              ) : (
                '••••'
              )}
            </div>
          </div>
        </article>
      </div>

      <div className="hero__foot">
        <span>{monthLabel(stats.y, stats.m)}</span>
        <span>出勤 {stats.workDays} 天</span>
        <label className="hero__meal">
          <span>本月饭补</span>
          <span className="hero__meal-cur">{settings.currency}</span>
          <input
            className="hero__meal-input"
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={mealText}
            placeholder="0"
            aria-label="本月饭补"
            onChange={(e) => setMealText(e.target.value)}
            onBlur={commitMeal}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
        </label>
        <span>日均 {stats.avgHours} h</span>
        {stats.bestDay ? (
          <span>
            最多的一天 {stats.bestDay.hours}h（{stats.bestDay.iso.slice(5).replace('-', '/')}）
          </span>
        ) : null}
      </div>
    </section>
  );
}
