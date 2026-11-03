/** 六种滚动视觉动效的引擎部分：Scroll-linked / Scroll-triggered / Parallax / Sticky / Snap / Horizontal
 *  说明：动画本体全部写在 CSS 里，JS 只负责算数值、加 class，避免每帧操作样式引起卡顿。
 */

import { useEffect, useRef, useState, type DependencyList, type RefObject } from 'react';

/** Scroll-linked + Parallax + Sticky(顶栏吸附)：一次 scroll 监听搞定全局滚动效果 */
export function useScrollFx(deps: DependencyList): RefObject<HTMLDivElement | null> {
  const topbarRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let raf = 0;

    const update = () => {
      raf = 0;
      const doc = document.documentElement;
      const scrollY = window.scrollY;
      const vh = window.innerHeight;
      const max = doc.scrollHeight - vh;

      // 1) Scroll-linked：顶部进度条，滚动多少走多少
      const ratio = max > 0 ? Math.min(1, Math.max(0, scrollY / max)) : 0;
      doc.style.setProperty('--progress', ratio.toFixed(4));

      // 4) Sticky：顶栏滚过一点就吸附并加毛玻璃
      if (topbarRef.current) topbarRef.current.classList.toggle('is-pinned', scrollY > 8);

      // 3) Parallax：背景光斑比前景滚得慢
      const fixed = document.querySelectorAll<HTMLElement>('[data-parallax]');
      fixed.forEach((el) => {
        const speed = Number(el.dataset.parallax || '0.2');
        el.style.setProperty('--py', (scrollY * speed).toFixed(1) + 'px');
      });

      // 3b) Parallax（相对层）：卡片里的装饰随视口中心偏移
      const relative = document.querySelectorAll<HTMLElement>('[data-parallax-rel]');
      relative.forEach((el) => {
        const speed = Number(el.dataset.parallaxRel || '0.06');
        const rect = el.getBoundingClientRect();
        if (rect.bottom < -200 || rect.top > vh + 200) return;
        const center = rect.top + rect.height / 2 - vh / 2;
        el.style.setProperty('--py', (-center * speed).toFixed(1) + 'px');
      });
    };

    const onScroll = () => {
      if (!raf) raf = window.requestAnimationFrame(update);
    };

    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, deps);

  return topbarRef;
}

/** Scroll-triggered：滚进屏幕就自己播完（卡片淡入上浮），同一个元素只播一次 */
export function useReveal(deps: DependencyList): void {
  useEffect(() => {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>('[data-reveal]:not(.is-in)'));
    if (nodes.length === 0) return;

    if (typeof IntersectionObserver === 'undefined') {
      nodes.forEach((n) => n.classList.add('is-in'));
      return;
    }

    nodes.forEach((n) => {
      if (!n.style.getPropertyValue('--reveal-delay')) {
        const siblings = n.parentElement
          ? Array.from(n.parentElement.children).filter((c) => (c as HTMLElement).hasAttribute('data-reveal'))
          : [n];
        const idx = Math.max(0, siblings.indexOf(n));
        n.style.setProperty('--reveal-delay', String(Math.min(idx, 7) * 55) + 'ms');
      }
    });

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-in');
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.06, rootMargin: '0px 0px -6% 0px' }
    );

    nodes.forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, deps);
}

/** Scroll Snap：整屏吸附 + 右侧圆点指示器 */
export function useSnapIndex(count: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        const i = Math.round(el.scrollTop / Math.max(1, el.clientHeight));
        setIndex(Math.min(count - 1, Math.max(0, i)));
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [count]);

  const go = (i: number) => {
    const el = ref.current;
    if (!el) return;
    el.scrollTo({ top: i * el.clientHeight, behavior: 'smooth' });
  };

  return { ref, index, go };
}

/** 键盘快捷键：左右切月、T 回今天、Esc 关抽屉 */
export function useKeys(handlers: { onPrev?: () => void; onNext?: () => void; onToday?: () => void; onEscape?: () => void }): void {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (typing) {
        if (e.key === 'Escape' && ref.current.onEscape) ref.current.onEscape();
        return;
      }
      if (e.key === 'ArrowLeft' && ref.current.onPrev) ref.current.onPrev();
      else if (e.key === 'ArrowRight' && ref.current.onNext) ref.current.onNext();
      else if (e.key === 't' || e.key === 'T' || e.key === '今天') ref.current.onToday && ref.current.onToday();
      else if (e.key === 'Escape' && ref.current.onEscape) ref.current.onEscape();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
