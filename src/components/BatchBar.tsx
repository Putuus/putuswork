/** 批量记工时：选中多天，一次性写入工时 / 备注 */

import { useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { BatchPatch } from '../store';

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

  const count = picked.length;

  const apply = () => {
    const patch: BatchPatch = {};
    if (hoursText.trim() !== '') patch.hours = Number(hoursText);
    if (note.trim() !== '') patch.note = note.trim();
    onApply(patch);
    setHoursText('');
    setNote('');
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
        <span>提示：在日历上点格子可多选，按住拖动可以连续刷选</span>
      </div>
    </div>,
    document.body
  );
}
