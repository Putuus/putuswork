import { useEffect, useState } from 'react';
import { StoreProvider, useStore } from './store';
import { Background, ProgressRail, TopBar, Toasts, type TabKey } from './components/Chrome';
import { CalendarPage } from './components/CalendarPage';
import { StatsPage } from './components/StatsPage';
import { SettingsPage } from './components/SettingsPage';
import { useReveal, useScrollFx } from './hooks/useScrollFx';

function Shell() {
  const { data, toasts, dismissToast } = useStore();
  const [tab, setTab] = useState<TabKey>('log');

  // 滚动动效引擎：进度条 + 视差 + 顶栏吸附
  const topbarRef = useScrollFx([tab, data.records.length, Object.keys(data.meals).length]);
  // 滚动动效：卡片滚进屏幕就淡入
  useReveal([tab, data.records.length, Object.keys(data.meals).length, data.settings.weekStart]);

  // 主题：auto 时跟随系统，系统切换也能实时响应
  const [systemDark, setSystemDark] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const resolvedTheme =
    data.settings.theme === 'auto' ? (systemDark ? 'dark' : 'light') : data.settings.theme;
  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);

  // 只有真正按下按键（在输入框里打字）才临时把光标显示出来
  useEffect(() => {
    const timers = new WeakMap<HTMLElement, number>();
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')) return;
      el.classList.add('is-typing');
      const prev = timers.get(el);
      if (prev) window.clearTimeout(prev);
      timers.set(
        el,
        window.setTimeout(() => el.classList.remove('is-typing'), 1600)
      );
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' });
  }, [tab]);

  return (
    <>
      <Background />
      <ProgressRail />
      <TopBar innerRef={topbarRef} tab={tab} onTab={setTab} />
      <main>
        {tab === 'log' ? <CalendarPage /> : null}
        {tab === 'stats' ? <StatsPage /> : null}
        {tab === 'settings' ? <SettingsPage /> : null}
      </main>
      <Toasts items={toasts} onDismiss={dismissToast} />
    </>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
