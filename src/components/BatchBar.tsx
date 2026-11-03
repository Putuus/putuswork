/** 批量记工时：选中多天，一次性写入工时 / 餐补 / 备注 */

import { useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { BatchPatch } from '../store';
import { NumberField, Seg } from './ui';
import { MEAL_MAX, MEAL_MIN } from '../types';
import { money } from '../lib/calc';

type MealMode = 'keep' | 'set' | 'clear';

export function BatchBar({
  picked,
  onApply,
  onClear,
  onQuick,
}: {
  picked: string[];
  onApply: (patch: BatchPatch) => void;
  onClear: () => void;
  onQuick: (kind: 'week' | 'weekdays' | 'monthWeekdays' | 'monthAll' | 'none') => void;
}) {
  const [hoursText, setHoursText] = useState('');
  const [note, setNote] = useState('');
  const [mealMode, setMealMode] = useState<MealMode>('keep');
  const [mealValue, setMealValue] = useState(15);

  const count = picked.length;

  const apply = () => {
    const patch: BatchPatch = {};
    if (hoursText.trim() !== '') patch.hours = Number(hoursText);
    if (note.trim() !== '') patch.note = note.trim();
    if (mealMode === 'set') patch.meal = Math.min(MEAL_MAX, Math.max(MEAL_MIN, mealValue));
    if (mealMode === 'clear') patch.meal = null;
    onApply(patch);
    setHoursText('');
    setNote('');
    setMealMode('keep');
  };

  return createPortal(
    <div className="batchbar glass card card--liquid" role="region" aria-label="批量记工时">
      <div className="h-scroller" style={{ paddingBottom: 4 }}>
        <button type="button" className="chip h-item" onClick={() => onQuick('week')}>
          本周
        </button>
        <button type="button" className="chip h-item" onClick={() => onQuick('weekdays')}>
          本周工作日
        </button>
        <button type="button" className="chip h-item" onClick={() => onQuick('monthWeekdays')}>
          本月工作日
        </button>
        <button type="button" className="chip h-item" onClick={() => onQuick('monthAll')}>
          本月全部
        </button>
        <button type="button" className="chip h-item" onClick={() => onQuick('none')}>
          清空选择
        </button>
      </div>

      <div className="batchbar__grid">
        <label className="field">
          <span className="field__label">工时（留空则不改）</span>
          <input
            className="input input--num"
            type="number"
            min={0}
            max={24}
            step={0.5}
            value={hoursText}
            placeholder="8"
            onChange={(e) => setHoursText(e.target.value)}
          />
        </label>

        <div className="field">
          <span className="field__label">餐补</span>
          <div className="input-row" style={{ gap: 8 }}>
            <Seg<MealMode>
              value={mealMode}
              onChange={setMealMode}
              options={[
                { value: 'keep', label: '不改' },
                { value: 'set', label: '设置' },
                { value: 'clear', label: '清除' },
              ]}
            />
            {mealMode === 'set' ? (
              <NumberField
                value={mealValue}
                onChange={setMealValue}
                min={MEAL_MIN}
                max={MEAL_MAX}
                suffix="元"
                ariaLabel="批量餐补金额"
                width={110}
              />
            ) : null}
          </div>
        </div>

        <label className="field">
          <span className="field__label">备注（留空则不改）</span>
          <input
            className="input"
            type="text"
            value={note}
            placeholder="比如：A 工地"
            onChange={(e) => setNote(e.target.value)}
          />
        </label>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center' } as CSSProperties}>
          <button type="button" className="btn btn--glass" onClick={onClear}>
            退出批量
          </button>
          <button type="button" className="btn btn--clay btn--clay-accent" onClick={apply} disabled={count === 0}>
            应用到 {count} 天
          </button>
        </div>
      </div>

      <div className="tiny muted" style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
        <span>已选 {count} 天</span>
        <span>餐补范围 {MEAL_MIN}~{MEAL_MAX} 元</span>
        <span>提示：在日历上点格子可多选，按住拖动可以连续刷选</span>
        {mealMode === 'set' ? <span>将写入餐补 {money(mealValue)} 元/天</span> : null}
      </div>
    </div>,
    document.body
  );
}
