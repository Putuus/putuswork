/** 顶部汇总：Hermes 风格双联人物画卡片 + 按月饭补 */

import { useEffect, useRef, useState } from 'react';
import { money } from '../lib/calc';
import type { MonthStats } from '../lib/calc';
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
  const [editingMeal, setEditingMeal] = useState(false);
  const panelsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setMealText(stats.meal > 0 ? String(stats.meal) : '');
  }, [stats.meal, monthKey]);

  // 鼠标在页面里移动时，两张人物画在各自卡片内部轻微反向位移
  useEffect(() => {
    const root = panelsRef.current;
    if (!root) return;
    const imgs = Array.from(root.querySelectorAll<HTMLImageElement>('.hero__panel-art'));
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;

    const reset = () => {
      imgs.forEach((img) => {
        img.style.transform = 'translate3d(0, 0, 0) scale(1.04)';
      });
    };
    const onMove = (e: PointerEvent) => {
      const x = e.clientX / window.innerWidth - 0.5;
      const y = e.clientY / window.innerHeight - 0.5;
      imgs.forEach((img, i) => {
        const depth = i === 0 ? 1 : 1.35;
        const tx = (x * -16 * depth).toFixed(1);
        const ty = (y * -12 * depth).toFixed(1);
        img.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(1.04)`;
      });
    };

    reset();
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerleave', reset);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerleave', reset);
    };
  }, []);

  const commitMeal = () => {
    const n = Number(mealText.replace(/[^\d.]/g, ''));
    const value = Number.isFinite(n) && n > 0 ? Math.min(100000, Math.round(n * 100) / 100) : 0;
    setMonthMeal(monthKey, value || null);
    setMealText(value > 0 ? String(value) : '');
    setEditingMeal(false);
  };

  const best = stats.bestDay;

  return (
    <section className="hero" data-reveal aria-label="本月汇总">
      <div className="hero__panels" ref={panelsRef}>
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

      <div className="hero__stats">
        <div className="hero__stat">
          <span className="hero__stat-k">出勤</span>
          <span className="hero__stat-v">
            {stats.workDays}
            <small>天</small>
          </span>
        </div>

        <div className="hero__stat">
          <span className="hero__stat-k">日均</span>
          <span className="hero__stat-v">
            {stats.avgHours}
            <small>h</small>
          </span>
        </div>

        <div className="hero__stat">
          <span className="hero__stat-k">最多一天</span>
          <span className="hero__stat-v">
            {best ? (
              <>
                {best.hours}
                <small>h</small>
                <em>· {best.iso.slice(5).replace('-', '/')}</em>
              </>
            ) : (
              <span className="hero__stat-empty">—</span>
            )}
          </span>
        </div>

        <div className="hero__stat hero__stat--meal">
          <span className="hero__stat-k">本月饭补</span>
          {editingMeal ? (
            <span className="hero__stat-v hero__stat-v--meal">
              <span className="hero__meal-cur">{settings.currency}</span>
              <input
                className="hero__meal-input"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                autoFocus
                value={mealText}
                placeholder="0"
                aria-label="本月饭补"
                onChange={(e) => setMealText(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
                onBlur={commitMeal}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
              />
            </span>
          ) : (
            <button
              type="button"
              className="hero__stat-v hero__meal-display"
              onClick={() => {
                setMealText(stats.meal > 0 ? String(stats.meal) : '');
                setEditingMeal(true);
              }}
              aria-label="填写本月饭补"
            >
              {settings.currency}
              {stats.meal > 0 ? money(stats.meal) : '0'}
            </button>
          )}
        </div>
      </div>

    </section>
  );
}
