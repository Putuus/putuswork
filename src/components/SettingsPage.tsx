/** 设置页：计价规则 + 外观 + 数据（导出/导入/关联本地文件）+ 关于 */

import { useRef, useState, type CSSProperties } from 'react';
import { useStore } from '../store';
import { NumberField, Seg, Switch, Field } from './ui';
import { backupKeys, downloadJSON, parseImport, readFileAsText, fsSupported } from '../lib/storage';
import { isSyncConfigured } from '../lib/sync';
import { MEAL_MAX } from '../types';

export function SettingsPage() {
  const {
    data,
    setSettings,
    replaceAll,
    mergeAll,
    resetAll,
    restoreLastBackup,
    toast,
    fileHandle,
    fileName,
    fileLinked,
    linkFile,
    unlinkFile,
    syncConfig,
    syncStatus,
    updateSyncConfig,
    resetSyncConfig,
    syncNow,
    syncTest,
  } = useStore();
  const { settings } = data;
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge');
  const [syncBusy, setSyncBusy] = useState(false);

  const syncReady = isSyncConfigured(syncConfig);
  const syncLabel =
    syncStatus.state === 'off'
      ? '未开启，数据只在本机'
      : syncStatus.state === 'syncing'
        ? '同步中…'
        : syncStatus.state === 'synced'
          ? '已同步' +
            (syncStatus.at ? ' · ' + new Date(syncStatus.at).toLocaleTimeString('zh-CN', { hour12: false }) : '')
          : syncStatus.state === 'unsynced'
            ? '未同步：' + syncStatus.message
            : '等待同步';

  const onSyncTest = async () => {
    setSyncBusy(true);
    const res = await syncTest();
    setSyncBusy(false);
    toast(res.message, res.ok ? 'ok' : 'warn');
  };

  const onSyncNow = async () => {
    setSyncBusy(true);
    await syncNow();
    setSyncBusy(false);
  };

  const onImport = async (file: File | undefined, mode: 'merge' | 'replace') => {
    if (!file) return;
    const text = await readFileAsText(file);
    const next = parseImport(text);
    if (!next) {
      toast('这个文件读不出来，确认是导出的 JSON 吗', 'warn');
      return;
    }
    if (mode === 'merge') {
      const res = mergeAll(next);
      toast(
        res.added > 0
          ? '合并完成：新增 ' + res.added + ' 条' + (res.skipped > 0 ? '，跳过重复 ' + res.skipped + ' 条' : '')
          : '没有新记录，' + res.skipped + ' 条都是已有的',
        res.added > 0 ? 'ok' : 'warn'
      );
      return;
    }
    replaceAll(next);
    toast('已覆盖导入 ' + next.records.length + ' 条记录');
  };

  return (
    <div className="page view-fade">
      <div className="wrap stack" style={{ '--stack-gap': '22px' } as CSSProperties}>
        <section className="glass card" data-reveal>
          <div className="section-title">
            <span className="h2">计价</span>
            <span className="tiny dim">固定时薪 × 小时数，加班倍率以后再加</span>
          </div>
          <div className="settings-grid">
            <Field label="默认时薪" hint="每天记工时的时候可以单独覆盖">
              <NumberField
                value={settings.hourlyRate}
                onChange={(v) => setSettings({ hourlyRate: v })}
                min={0}
                max={100000}
                suffix="元 / 小时"
                ariaLabel="默认时薪"
              />
            </Field>
            <Field label="默认餐补" hint={'点开某天的餐补开关时用这个数，范围 1~' + MEAL_MAX}>
              <NumberField
                value={settings.defaultMeal}
                onChange={(v) => setSettings({ defaultMeal: v })}
                min={0}
                max={MEAL_MAX}
                suffix="元 / 天"
                ariaLabel="默认餐补"
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
              <div className="tiny muted">关掉之后日历页的收入显示成圆点</div>
            </div>
            <Switch checked={settings.showIncome} label="显示收入" onChange={(v) => setSettings({ showIncome: v })} />
          </div>
          <div className="row">
            <div className="row__label">
              <strong>一周从哪天开始</strong>
              <div className="tiny muted">影响日历的表头顺序</div>
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
              <div className="tiny muted">选「跟随系统」就会跟着 Windows 的深色模式自动切</div>
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
            <span className="h2">数据</span>
            <span className="tiny dim">本地优先：默认存在浏览器里，也可以落到一个真实文件上</span>
          </div>

          <div className="row">
            <div className="row__label">
              <strong>导出备份</strong>
              <div className="tiny muted">下载一个 JSON，换电脑直接导入</div>
            </div>
            <button
              type="button"
              className="btn btn--clay btn--sm"
              onClick={() => {
                downloadJSON(data);
                toast('已导出备份文件');
              }}
            >
              导出 JSON
            </button>
          </div>

          <div className="row">
            <div className="row__label">
              <strong>导入数据</strong>
              <div className="tiny muted">
                「合并」只补新记录、不动现有数据（按日期+工时去重）；「覆盖」会清掉现有数据，导入前先导出一份
              </div>
            </div>
            <div>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                className="sr"
                onChange={(e) => {
                  void onImport(e.target.files ? e.target.files[0] : undefined, importMode);
                  e.target.value = '';
                }}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="btn btn--clay btn--sm"
                  onClick={() => {
                    setImportMode('merge');
                    if (fileRef.current) fileRef.current.click();
                  }}
                >
                  合并导入
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => {
                    setImportMode('replace');
                    if (fileRef.current) fileRef.current.click();
                  }}
                >
                  覆盖导入
                </button>
              </div>
            </div>
          </div>

          <div className="row">
            <div className="row__label">
              <strong>关联本地文件（自动保存）</strong>
              <div className="tiny muted">
                {fileLinked
                  ? '正在自动保存到 ' + fileName
                  : fileHandle
                    ? '上次关联了 ' + fileName + '，点一下重新授权'
                    : fsSupported()
                      ? '选一个 JSON 文件，之后每次改动自动写进去'
                      : '当前浏览器不支持，用导出/导入即可（Chrome / Edge 支持）'}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="btn btn--glass btn--sm" onClick={() => void linkFile()} disabled={!fsSupported()}>
                {fileHandle ? '重新连接' : '选择文件'}
              </button>
              {fileHandle ? (
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => void unlinkFile()}>
                  解除
                </button>
              ) : null}
            </div>
          </div>

          <div className="row">
            <div className="row__label">
              <strong>自动备份</strong>
              <div className="tiny muted">
                每次改动前自动留一份快照，保留最近 5 份；当前已存 {backupKeys().length} 份
              </div>
            </div>
            <button
              type="button"
              className="btn btn--glass btn--sm"
              disabled={backupKeys().length === 0}
              onClick={() => {
                const ok = restoreLastBackup();
                toast(ok ? '已恢复到上一份备份' : '还没有可用的备份', ok ? 'ok' : 'warn');
              }}
            >
              恢复上一版
            </button>
          </div>

          <div className="row">
            <div className="row__label">
              <strong>清空所有数据</strong>
              <div className="tiny muted">记录 {data.records.length} 条 · 餐补 {Object.keys(data.meals).length} 天</div>
            </div>
            <button
              type="button"
              className="btn btn--ghost btn--sm btn--danger"
              onClick={() => {
                if (!confirmReset) {
                  setConfirmReset(true);
                  toast('再点一次就会清空', 'warn');
                  return;
                }
                resetAll();
                setConfirmReset(false);
                toast('已清空');
              }}
            >
              {confirmReset ? '真的要清空？' : '清空数据'}
            </button>
          </div>
        </section>

        <section className="glass card" data-reveal>
          <div className="section-title">
            <span className="h2">云同步</span>
            <span className="tiny dim">副本存进你自己的 GitHub 私有仓库；不填令牌就完全是本地应用</span>
          </div>

          <div className="row">
            <div className="row__label">
              <strong>当前状态</strong>
              <div className="tiny muted">{syncLabel}</div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="btn btn--glass btn--sm"
                disabled={!syncReady || syncBusy}
                onClick={() => void onSyncTest()}
              >
                测试连接
              </button>
              <button
                type="button"
                className="btn btn--clay btn--sm"
                disabled={!syncReady || syncBusy}
                onClick={() => void onSyncNow()}
              >
                立即同步
              </button>
            </div>
          </div>

          <div className="settings-grid">
            <Field label="访问令牌（PAT）" hint="只存在这台设备的浏览器里；fine-grained token 只需给它 Contents 读写">
              <input
                className="input"
                type="password"
                value={syncConfig.token}
                placeholder="github_pat_..."
                autoComplete="off"
                spellCheck={false}
                aria-label="GitHub 访问令牌"
                onChange={(e) => updateSyncConfig({ token: e.target.value })}
              />
            </Field>
            <div className="field">
              <span className="field__label">仓库 owner / repo</span>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  className="input"
                  value={syncConfig.owner}
                  placeholder="owner"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="仓库 owner"
                  onChange={(e) => updateSyncConfig({ owner: e.target.value })}
                />
                <input
                  className="input"
                  value={syncConfig.repo}
                  placeholder="repo"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="仓库名"
                  onChange={(e) => updateSyncConfig({ repo: e.target.value })}
                />
              </div>
              <span className="tiny dim">建议用私有仓库，例如 Putuus / putuswork-data</span>
            </div>
          </div>

          <div className="row">
            <div className="row__label">
              <strong>仓库内文件路径</strong>
              <div className="tiny muted">默认 worklog.json；云端还没有这个文件时，第一次同步会自动创建</div>
            </div>
            <input
              className="input"
              style={{ maxWidth: 260 }}
              value={syncConfig.path}
              placeholder="worklog.json"
              autoComplete="off"
              spellCheck={false}
              aria-label="仓库内文件路径"
              onChange={(e) => updateSyncConfig({ path: e.target.value })}
            />
          </div>

          <div className="row">
            <div className="row__label">
              <strong>断开云同步</strong>
              <div className="tiny muted">只清掉本机的令牌和仓库配置，云端文件与本地记录都不动</div>
            </div>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                resetSyncConfig();
                toast('已清除云同步配置，本地数据不变');
              }}
            >
              清除配置
            </button>
          </div>
        </section>

        <section className="glass card" data-reveal>
          <div className="section-title">
            <span className="h2">关于</span>
            <span className="tiny dim">v0.1.0 · MIT</span>
          </div>
          <div className="about-list">
            <div className="row">
              <div className="row__label">
                <strong>键盘快捷键</strong>
                <div className="tiny muted">在日历页生效，输入框里不打扰你</div>
              </div>
              <div className="row__value nowrap">
                <span className="kbd">←</span> <span className="kbd">→</span> 切月 · <span className="kbd">T</span> 回今天 ·{' '}
                <span className="kbd">Esc</span> 关闭
              </div>
            </div>
            <div className="row">
              <div className="row__label">
                <strong>技术栈</strong>
                <div className="tiny muted">React + TypeScript + Vite，零运行时依赖，构建产物是纯静态文件</div>
              </div>
              <div className="row__value">静态站点，可直接部署到 GitHub Pages</div>
            </div>
            <div className="row">
              <div className="row__label">
                <strong>数据在哪</strong>
                <div className="tiny muted">
                  浏览器 localStorage 里的 worklog:v1；关联文件后会同步写到你自己选的 JSON 文件
                </div>
              </div>
              <div className="row__value">不会上传到任何服务器</div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
