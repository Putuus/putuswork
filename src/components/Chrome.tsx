/** 页面外壳：背景光斑(视差) / 顶部进度条(Scroll-linked) / 顶栏(Sticky) / 轻提示 */

import { useState, type ReactNode, type RefObject } from 'react';
import type { Toast } from '../store';
import { useStore } from '../store';

export function Background() {
  return (
    <div className="bg" aria-hidden="true">
      <div
        className="bg__photo"
        data-parallax="0.02"
        style={{ backgroundImage: 'url(' + import.meta.env.BASE_URL + 'background.jpg)' }}
      />
      <div className="bg__veil" />
      <div className="blob blob--1" data-parallax="0.08" />
      <div className="blob blob--2" data-parallax="0.14" />
      <div className="bg__sheen" />
      <div className="bg__grain" />
    </div>
  );
}

/** Scroll-linked：顶部阅读进度条，滚动多少走多少 */
export function ProgressRail() {
  return (
    <div className="progress" aria-hidden="true">
      <div className="progress__bar" />
    </div>
  );
}

export type TabKey = 'log' | 'stats' | 'settings';

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'log', label: '记工时' },
  { key: 'stats', label: '统计' },
  { key: 'settings', label: '设置' },
];

/** 左上角图标：默认用 public/logo.png，也可以退回文字「时」 */
export function BrandMark({ logo }: { logo: string }) {
  const [failed, setFailed] = useState(false);
  if (!logo || logo === 'letter' || failed) {
    return <span className="brand__mark">时</span>;
  }
  return (
    <img
      className="brand__img"
      src={import.meta.env.BASE_URL + logo}
      alt=""
      width={30}
      height={30}
      onError={() => setFailed(true)}
    />
  );
}

export function TopBar({
  innerRef,
  tab,
  onTab,
  right,
}: {
  innerRef: RefObject<HTMLDivElement | null>;
  tab: TabKey;
  onTab: (t: TabKey) => void;
  right?: ReactNode;
}) {
  const { data } = useStore();
  return (
    <header className="topbar" ref={innerRef}>
      <div className="wrap">
        <div className="topbar__inner">
          <div className="brand">
            <BrandMark logo={data.settings.logo} />
            <span>工时记录</span>
          </div>
          <nav className="tabs" aria-label="主导航">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                className={'tab' + (tab === t.key ? ' is-active' : '')}
                aria-current={tab === t.key ? 'page' : undefined}
                onClick={() => onTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </nav>
          {right}
        </div>
      </div>
    </header>
  );
}

export function Toasts({ items, onDismiss }: { items: Toast[]; onDismiss: (id: string) => void }) {
  if (items.length === 0) return null;
  const last = items[items.length - 1];
  return (
    <div className={'toast' + (last.kind === 'warn' ? ' toast--warn' : ' toast--ok')} role="status" onClick={() => onDismiss(last.id)}>
      <span aria-hidden="true">{last.kind === 'warn' ? '⚠️' : '✅'}</span>
      <span>{last.text}</span>
    </div>
  );
}
