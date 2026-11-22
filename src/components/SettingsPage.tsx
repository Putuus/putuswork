/** 设置页：只保留计价、外观、同步和一次导出 */

import type { CSSProperties } from 'react';
import { useStore } from '../store';
import { NumberField, Seg, Switch, Field } from './ui';
import { downloadJSON } from '../lib/storage';

export function SettingsPage() {
  const { data, setSettings, toast, cloudLink } = useStore();
  const { settings } = data;

  const copyCloudLink = async () => {
    try {
      await navigator.clipboard.writeText(cloudLink);
      toast('同步链接已复制');
    } catch {
      toast('复制失败，手动选中链接', 'warn');
    }
  };

  return (
    <div className="page view-fade settings">
      <div className="wrap stack" style={{ '--stack-gap': '22px' } as CSSProperties}>
        <section className="glass card" data-reveal>
          <div className="section-title">
            <span className="h2">计价</span>
          </div>
          <div className="settings-grid">
            <Field label="默认时薪">
              <NumberField
                value={settings.hourlyRate}
                onChange={(v) => setSettings({ hourlyRate: v })}
                min={0}
                max={100000}
                suffix="元 / 小时"
                ariaLabel="默认时薪"
              />
            </Field>
          </div>
        </section>

        <section className="glass card" data-reveal>
          <div className="section-title">
            <span className="h2">外观与习惯</span>
          </div>
          <div className="row">
            <div className="row__label">
              <strong>显示收入数字</strong>
            </div>
            <Switch checked={settings.showIncome} label="显示收入" onChange={(v) => setSettings({ showIncome: v })} />
          </div>
          <div className="row">
            <div className="row__label">
              <strong>一周从哪天开始</strong>
            </div>
            <Seg<0 | 1>
              value={settings.weekStart}
              onChange={(v) => setSettings({ weekStart: v })}
              options={[
                { value: 0, label: '周日' },
                { value: 1, label: '周一' },
              ]}
            />
          </div>
          <div className="row">
            <div className="row__label">
              <strong>主题</strong>
            </div>
            <Seg<'light' | 'dark' | 'auto'>
              value={settings.theme}
              onChange={(v) => setSettings({ theme: v })}
              options={[
                { value: 'light', label: '浅色' },
                { value: 'dark', label: '深色' },
                { value: 'auto', label: '跟随系统' },
              ]}
            />
          </div>
        </section>

        <section className="glass card" data-reveal>
          <div className="section-title">
            <span className="h2">同步</span>
          </div>
          <div className="row sync-row">
            <div className="row__label">
              <strong>同步链接</strong>
            </div>
            <div className="sync-link-row">
              <input
                className="input"
                readOnly
                value={cloudLink}
                aria-label="同步链接"
                onFocus={(e) => e.currentTarget.select()}
              />
              <button type="button" className="btn btn--clay btn--sm" onClick={() => void copyCloudLink()}>
                复制
              </button>
            </div>
          </div>
        </section>

        <section className="glass card" data-reveal>
          <div className="section-title">
            <span className="h2">数据</span>
          </div>
          <div className="row">
            <div className="row__label">
              <strong>导出 JSON</strong>
            </div>
            <button
              type="button"
              className="btn btn--clay btn--sm"
              onClick={() => {
                downloadJSON(data);
                toast('已导出 JSON');
              }}
            >
              导出
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
