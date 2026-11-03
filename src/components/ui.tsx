/** 通用小控件：数字输入（可拖动调节 + 卡榫手感）/ 开关 / 分段控件 / 字段 / 图标 */

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

const KEY_STEP_DELAY = 360; // 按住多久开始连发
const KEY_STEP_REPEAT = 70; // 连发间隔
const DRAG_PIXELS_PER_STEP = 13; // 拖动多少像素走一格 —— 手感就靠这个

export function NumberField({
  value,
  onChange,
  min = 0,
  max = 100000,
  step = 1,
  suffix,
  placeholder,
  autoFocus,
  ariaLabel,
  width,
}: {
  value: number | null;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  placeholder?: string;
  autoFocus?: boolean;
  ariaLabel?: string;
  width?: number;
}) {
  const [text, setText] = useState(value === null || value === 0 ? '' : String(value));
  const [editing, setEditing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dragRef = useRef<{ x: number; v: number; last: number } | null>(null);
  const draggingRef = useRef(false);
  const holdRef = useRef<number | null>(null);
  /** 最新的值，长按连发时不能依赖闭包里的 value（那是渲染那一刻的快照） */
  const latestRef = useRef<number>(value ?? 0);

  useEffect(() => {
    latestRef.current = value ?? 0;
  }, [value]);

  useEffect(() => {
    if (!editing) setText(value === null || value === 0 ? '' : String(value));
  }, [value, editing]);

  useEffect(() => {
    return () => {
      if (holdRef.current !== null) window.clearTimeout(holdRef.current);
    };
  }, []);

  const round = (n: number) => Math.round(n / step) * step;
  const clamp = (n: number) => Math.min(max, Math.max(min, round(n)));

  /** 每走一格：数字轻轻弹一下，做出“卡榫”顿挫感 */
  const bump = () => {
    const el = wrapRef.current;
    if (!el) return;
    el.classList.remove('is-tick');
    void el.offsetWidth;
    el.classList.add('is-tick');
  };

  const apply = (next: number) => {
    const v = clamp(next);
    latestRef.current = v;
    onChange(v);
    setText(String(v));
    bump();
  };

  const commit = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === '') {
      onChange(min > 0 ? min : 0);
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return;
    onChange(clamp(n));
  };

  /* ---------------- 拖动调数值（左右拖，一格一格“卡”过去） ---------------- */
  const onPointerDown = (e: ReactPointerEvent<HTMLInputElement>) => {
    if (e.button !== 0 || editing) return;
    dragRef.current = { x: e.clientX, v: value ?? 0, last: 0 };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLInputElement>) => {
    const st = dragRef.current;
    if (!st) return;
    const dx = e.clientX - st.x;
    if (!draggingRef.current) {
      if (Math.abs(dx) < 5) return;
      draggingRef.current = true;
      setDragging(true);
      inputRef.current && inputRef.current.blur();
      e.currentTarget.setPointerCapture && e.currentTarget.setPointerCapture(e.pointerId);
    }
    const steps = Math.trunc(dx / DRAG_PIXELS_PER_STEP);
    if (steps !== st.last) {
      st.last = steps;
      apply(st.v + steps * step);
    }
  };

  const endDrag = () => {
    dragRef.current = null;
    draggingRef.current = false;
    setDragging(false);
  };

  /* ---------------- 加减按钮：点一下走一格，按住连续走 ---------------- */
  const stopHold = () => {
    if (holdRef.current !== null) {
      window.clearTimeout(holdRef.current);
      holdRef.current = null;
    }
  };

  const startHold = (dir: number) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    apply(latestRef.current + dir * step);
    stopHold();
    const tick = () => {
      apply(latestRef.current + dir * step);
      holdRef.current = window.setTimeout(tick, KEY_STEP_REPEAT);
    };
    holdRef.current = window.setTimeout(tick, KEY_STEP_DELAY);
  };

  return (
    <span className="input-row" style={width ? { width } : undefined}>
      <span className="numfield" ref={wrapRef} data-dragging={dragging ? 'true' : 'false'}>
        <input
          ref={inputRef}
          className="input input--num numfield__input"
          type="number"
          inputMode="decimal"
          value={text}
          step={step}
          min={min}
          max={max}
          placeholder={placeholder}
          aria-label={ariaLabel}
          autoFocus={autoFocus}
          title="左右拖动可以调数值，也可以直接输入"
          onFocus={() => setEditing(true)}
          onBlur={(e) => {
            setEditing(false);
            commit(e.target.value);
          }}
          onChange={(e) => {
            setText(e.target.value);
            const n = Number(e.target.value);
            if (e.target.value.trim() !== '' && Number.isFinite(n) && n >= min && n <= max) onChange(n);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commit((e.target as HTMLInputElement).value);
              (e.target as HTMLInputElement).blur();
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              apply(latestRef.current + step);
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              apply(latestRef.current - step);
            }
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />
        <span className="numfield__steps" aria-hidden="true">
          <button
            type="button"
            className="numfield__step"
            tabIndex={-1}
            onPointerDown={startHold(1)}
            onPointerUp={stopHold}
            onPointerLeave={stopHold}
            onPointerCancel={stopHold}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 15l7-7 7 7" />
            </svg>
          </button>
          <button
            type="button"
            className="numfield__step"
            tabIndex={-1}
            onPointerDown={startHold(-1)}
            onPointerUp={stopHold}
            onPointerLeave={stopHold}
            onPointerCancel={stopHold}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 9l7 7 7-7" />
            </svg>
          </button>
        </span>
      </span>
      {suffix ? <span className="suffix">{suffix}</span> : null}
    </span>
  );
}

/** 眼睛图标（显示/隐藏收入），不用 emoji，跨平台一致 */
export function EyeIcon({ off }: { off?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {off ? (
        <>
          <path d="M3 3l18 18" />
          <path d="M10.6 5.2A9.9 9.9 0 0 1 12 5c5 0 9 4.5 9 7 0 .8-.5 1.9-1.4 3" />
          <path d="M6.2 6.4C3.9 8 3 10.4 3 12c0 2.5 4 7 9 7 1.4 0 2.7-.35 3.8-.9" />
        </>
      ) : (
        <>
          <path d="M3 12c0-2.5 4-7 9-7s9 4.5 9 7-4 7-9 7-9-4.5-9-7Z" />
          <circle cx="12" cy="12" r="3" />
        </>
      )}
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12.5l5.5 5.5L20 7" />
    </svg>
  );
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={'switch' + (checked ? ' is-on' : '')}
      onClick={() => onChange(!checked)}
    >
      <span className="switch__knob" />
    </button>
  );
}

export function Seg<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg" role="group">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          className={'seg__item' + (o.value === value ? ' is-active' : '')}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
      {hint ? <span className="tiny dim">{hint}</span> : null}
    </label>
  );
}

export function Collapse({ title, children, defaultOpen = false }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen(!open)}>
        {open ? '▾ ' : '▸ '}
        {title}
      </button>
      {open ? <div style={{ marginTop: 10 }}>{children}</div> : null}
    </div>
  );
}
