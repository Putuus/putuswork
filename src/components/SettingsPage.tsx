/** 设置页：只保留计价、外观、同步和一次导出 */

import { useRef, type CSSProperties } from 'react';
import { useStore } from '../store';
import { NumberField, Seg, Switch, Field } from './ui';
import { downloadJSON, parseImport, readFileAsText } from '../lib/storage';

export function SettingsPage() {
  const { data, setSettings, replaceAll, toast, cloudLink, cloudStatus, cloudConflict, resolveCloudConflict, inspectCloud } = useStore();
  const { settings } = data;
  const fileRef = useRef<HTMLInputElement | null>(null);

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

          {!cloudConflict ? (
            <div className="sync-actions">
              <button type="button" className="btn btn--glass btn--sm" onClick={() => void inspectCloud()}>
                对照云端版本
              </button>
            </div>
          ) : null}

          <div className="sync-status-line">
            {cloudStatus.state === 'synced' && cloudStatus.at
              ? '上次同步 ' + new Date(cloudStatus.at).toLocaleTimeString('zh-CN', { hour12: false })
              : cloudStatus.state === 'syncing'
                ? '同步中…'
                : cloudStatus.state === 'error'
                  ? '同步失败，稍后自动重试'
                  : cloudStatus.state === 'conflict'
                    ? '云端数据和本地不一致'
                    : '等待同步'}
          </div>

          {cloudConflict ? (
            <div className="row sync-conflict">
              <div className="row__label">
                <strong>云端已有数据，和本地不一致</strong>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="btn btn--glass btn--sm" onClick={() => void resolveCloudConflict('remote')}>
                  使用云端
                </button>
                <button type="button" className="btn btn--clay btn--sm" onClick={() => void resolveCloudConflict('local')}>
                  保留本地
                </button>
              </div>
            </div>
          ) : null}
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

          <div className="row">
            <div className="row__label">
              <strong>从 JSON 恢复</strong>
            </div>
            <div>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                className="sr"
                onChange={(e) => {
                  const file = e.target.files ? e.target.files[0] : undefined;
                  e.target.value = '';
                  if (!file) return;
                  void (async () => {
                    const next = parseImport(await readFileAsText(file));
                    if (!next) {
                      toast('这个文件读不出来，确认是导出的 JSON 吗', 'warn');
                      return;
                    }
                    if (!window.confirm('恢复会覆盖当前本地数据，继续？')) return;
                    const before = data;
                    replaceAll(next);
                    toast('已从 JSON 恢复 ' + next.records.length + ' 条记录', 'ok', {
                      label: '撤销',
                      run: () => replaceAll(before),
                    });
                  })();
                }}
              />
              <button type="button" className="btn btn--glass btn--sm" onClick={() => fileRef.current?.click()}>
                选择文件
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
