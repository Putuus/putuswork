/** 顶部汇总卡：本月工时 / 本月收入（可隐藏），背景山峦带视差 */

import { money } from '../lib/calc';
import type { MonthStats } from '../lib/calc';
import { monthLabel } from '../lib/date';
import { useStore } from '../store';
import { EyeIcon } from './ui';

export function SummaryHero({ stats }: { stats: MonthStats }) {
  const { data, setSettings } = useStore();
  const { settings } = data;
  const shown = settings.showIncome;

  return (
    <section className="hero" data-reveal aria-label="本月汇总">
      <div
        className="hero__photo"
        style={{ backgroundImage: 'url(' + import.meta.env.BASE_URL + 'hero.jpg)' }}
      />

      <div className="hero__grid">
        <div>
          <div className="hero__k">本月工时</div>
          <div className="hero__v">
            {stats.hours}
            <small>h</small>
          </div>
        </div>

        <div>
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
      </div>

      <div className="hero__foot">
        <span>{monthLabel(stats.y, stats.m)}</span>
        <span>出勤 {stats.workDays} 天</span>
        <span>
          餐补 {settings.currency}
          {money(stats.meal)}（{stats.mealDays} 天）
        </span>
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
