/** 全局状态：数据 + 持久化 + 本地文件关联 + 轻提示 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { emptyData, type AppData, type Settings, type WorkRecord } from './types';
import {
  loadData,
  saveData,
  uid,
  writeToHandle,
  loadHandle,
  saveHandle,
  ensurePermission,
  pickSaveFile,
  pickOpenFile,
  pushBackup,
  latestBackup,
  mergeInto,
  type FSFileHandle,
} from './lib/storage';
import { clampMeal } from './lib/calc';

export interface Toast {
  id: string;
  text: string;
  kind: 'ok' | 'warn';
}

export interface BatchPatch {
  hours?: number;
  meal?: number | null;
  note?: string;
}

interface StoreValue {
  data: AppData;
  setSettings: (patch: Partial<Settings>) => void;
  setDayHours: (iso: string, hours: number) => void;
  addRecord: (iso: string, patch?: Partial<WorkRecord>) => void;
  updateRecord: (id: string, patch: Partial<WorkRecord>) => void;
  removeRecord: (id: string) => void;
  clearDay: (iso: string) => void;
  setMeal: (iso: string, value: number | null) => void;
  batchApply: (dates: string[], patch: BatchPatch) => void;
  replaceAll: (next: AppData) => void;
  mergeAll: (next: AppData) => { added: number; skipped: number };
  resetAll: () => void;
  restoreLastBackup: () => boolean;
  toasts: Toast[];
  toast: (text: string, kind?: 'ok' | 'warn') => void;
  dismissToast: (id: string) => void;
  fileHandle: FSFileHandle | null;
  fileName: string | null;
  fileLinked: boolean;
  linkFile: () => Promise<void>;
  unlinkFile: () => Promise<void>;
}

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<AppData>(() => loadData());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [fileHandle, setFileHandle] = useState<FSFileHandle | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileLinked, setFileLinked] = useState(false);
  const timers = useRef<number[]>([]);

  const toast = useCallback((text: string, kind: 'ok' | 'warn' = 'ok') => {
    const id = uid();
    setToasts((prev) => prev.concat([{ id, text, kind }]));
    const t = window.setTimeout(() => {
      setToasts((prev) => prev.filter((x) => x.id !== id));
    }, 2600);
    timers.current.push(t);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }, []);

  // 主存储：localStorage（防抖写入）+ 每次改动前把上一版留进轮转备份
  const prevJsonRef = useRef<string>('');
  useEffect(() => {
    const json = JSON.stringify(data);
    if (prevJsonRef.current && prevJsonRef.current !== json) pushBackup(prevJsonRef.current);
    prevJsonRef.current = json;
    const t = window.setTimeout(() => {
      if (!saveData(data)) toast('保存失败：浏览器存储写不进去了（可能满了或处于隐私模式）', 'warn');
    }, 180);
    return () => window.clearTimeout(t);
  }, [data, toast]);

  // 用非 localhost 地址打开时会看到另一套（空的）数据，先提醒一句
  useEffect(() => {
    const h = window.location.hostname;
    if (h !== 'localhost' && h !== '127.0.0.1') {
      toast('提示：你现在是用 ' + h + ' 打开的，数据和 localhost 不互通', 'warn');
    }
  }, [toast]);

  // 一次性预置历史数据：seed.json 的版本号比本地新才导入，导过的不会重复
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(import.meta.env.BASE_URL + 'seed.json', { cache: 'no-store' });
        if (!res.ok) return;
        const seed = (await res.json()) as { seedVersion?: number; data?: AppData };
        if (!alive || !seed || !seed.data) return;
        const version = Number(seed.seedVersion || 1);
        let applied = 0;
        try {
          applied = Number(localStorage.getItem('worklog:seed') || '0');
        } catch {
          applied = 0;
        }
        if (applied >= version) return;
        const incoming = seed.data;
        setData((prev) => {
          const merged = mergeInto(prev, incoming);
          return Object.assign({}, merged.data, {
            settings: Object.assign({}, merged.data.settings, {
              hourlyRate:
                incoming.settings && incoming.settings.hourlyRate
                  ? incoming.settings.hourlyRate
                  : merged.data.settings.hourlyRate,
            }),
          });
        });
        try {
          localStorage.setItem('worklog:seed', String(version));
        } catch {
          /* 忽略 */
        }
        toast('已自动导入历史工时 ' + ((incoming.records && incoming.records.length) || 0) + ' 条');
      } catch {
        /* 没有 seed.json 就静默跳过 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [toast]);

  // 本地文件：改动后自动落盘
  useEffect(() => {
    if (!fileHandle || !fileLinked) return;
    const t = window.setTimeout(() => {
      void writeToHandle(fileHandle, data);
    }, 500);
    return () => window.clearTimeout(t);
  }, [data, fileHandle, fileLinked]);

  // 恢复上次关联的文件句柄（权限需要用户点一下才给）
  useEffect(() => {
    let alive = true;
    void loadHandle().then((h) => {
      if (!alive || !h) return;
      setFileHandle(h);
      setFileName(h.name);
    });
    return () => {
      alive = false;
      timers.current.forEach((t) => window.clearTimeout(t));
    };
  }, []);

  const setSettings = useCallback((patch: Partial<Settings>) => {
    setData((prev) => Object.assign({}, prev, { settings: Object.assign({}, prev.settings, patch) }));
  }, []);

  const setDayHours = useCallback((iso: string, hours: number) => {
    const value = Math.max(0, Math.min(24, Math.round(hours * 100) / 100));
    setData((prev) => {
      const mine = prev.records.filter((r) => r.date === iso);
      if (value <= 0) {
        return Object.assign({}, prev, { records: prev.records.filter((r) => r.date !== iso) });
      }
      if (mine.length === 0) {
        const rec: WorkRecord = { id: uid(), date: iso, hours: value, rate: null, note: '' };
        return Object.assign({}, prev, { records: prev.records.concat([rec]) });
      }
      const keepId = mine[0].id;
      const records: WorkRecord[] = [];
      for (const r of prev.records) {
        if (r.date !== iso) {
          records.push(r);
          continue;
        }
        if (r.id === keepId) records.push(Object.assign({}, r, { hours: value }));
      }
      return Object.assign({}, prev, { records });
    });
  }, []);

  const addRecord = useCallback((iso: string, patch?: Partial<WorkRecord>) => {
    setData((prev) => {
      const rec: WorkRecord = Object.assign(
        { id: uid(), date: iso, hours: 8, rate: null, note: '' },
        patch || {}
      );
      return Object.assign({}, prev, { records: prev.records.concat([rec]) });
    });
  }, []);

  const updateRecord = useCallback((id: string, patch: Partial<WorkRecord>) => {
    setData((prev) =>
      Object.assign({}, prev, {
        records: prev.records.map((r) => (r.id === id ? Object.assign({}, r, patch) : r)),
      })
    );
  }, []);

  const removeRecord = useCallback((id: string) => {
    setData((prev) => Object.assign({}, prev, { records: prev.records.filter((r) => r.id !== id) }));
  }, []);

  const clearDay = useCallback((iso: string) => {
    setData((prev) => {
      const meals = Object.assign({}, prev.meals);
      delete meals[iso];
      return Object.assign({}, prev, { records: prev.records.filter((r) => r.date !== iso), meals });
    });
  }, []);

  const setMeal = useCallback((iso: string, value: number | null) => {
    setData((prev) => {
      const meals = Object.assign({}, prev.meals);
      if (value === null || !Number.isFinite(value) || value <= 0) delete meals[iso];
      else meals[iso] = clampMeal(value);
      return Object.assign({}, prev, { meals });
    });
  }, []);

  /** 批量：把工时/餐补/备注一次性套用到选中的每一天 */
  const batchApply = useCallback((dates: string[], patch: BatchPatch) => {
    if (dates.length === 0) return;
    setData((prev) => {
      let records = prev.records.slice();
      const meals = Object.assign({}, prev.meals);

      if (typeof patch.hours === 'number' && Number.isFinite(patch.hours)) {
        const hours = Math.max(0, Math.min(24, Math.round(patch.hours * 100) / 100));
        for (const iso of dates) {
          const mine = records.filter((r) => r.date === iso);
          if (hours <= 0) {
            records = records.filter((r) => r.date !== iso);
            continue;
          }
          if (mine.length === 0) {
            records.push({ id: uid(), date: iso, hours, rate: null, note: patch.note || '' });
          } else {
            const keepId = mine[0].id;
            records = records
              .filter((r) => r.date !== iso || r.id === keepId)
              .map((r) => (r.id === keepId ? Object.assign({}, r, { hours, note: patch.note !== undefined ? patch.note : r.note }) : r));
          }
        }
      } else if (patch.note !== undefined) {
        for (const iso of dates) {
          const mine = records.filter((r) => r.date === iso);
          if (mine.length === 0) continue;
          const keepId = mine[0].id;
          records = records.map((r) => (r.id === keepId ? Object.assign({}, r, { note: patch.note as string }) : r));
        }
      }

      if (patch.meal !== undefined) {
        for (const iso of dates) {
          if (patch.meal === null || patch.meal <= 0) delete meals[iso];
          else meals[iso] = clampMeal(patch.meal);
        }
      }

      return Object.assign({}, prev, { records, meals });
    });
  }, []);

  const replaceAll = useCallback((next: AppData) => setData(next), []);

  /** 合并导入：保留现有数据，只把新的补进来 */
  const mergeAll = useCallback(
    (next: AppData) => {
      const result = mergeInto(data, next);
      setData(result.data);
      return { added: result.added, skipped: result.skipped };
    },
    [data]
  );
  const resetAll = useCallback(() => setData(emptyData()), []);

  /** 恢复到上一份自动备份（恢复前先把当前数据也存一份，防止后悔） */
  const restoreLastBackup = useCallback(() => {
    const bk = latestBackup();
    if (!bk) return false;
    pushBackup(JSON.stringify(data));
    setData(bk.data);
    return true;
  }, [data]);

  const linkFile = useCallback(async () => {
    // 已有句柄就直接续期权限
    if (fileHandle) {
      const ok = await ensurePermission(fileHandle);
      if (ok) {
        setFileLinked(true);
        const written = await writeToHandle(fileHandle, data);
        toast(written ? '已重新连接：' + fileHandle.name : '授权失败，请重试', written ? 'ok' : 'warn');
        return;
      }
    }
    const handle = (await pickSaveFile()) || (await pickOpenFile());
    if (!handle) {
      toast('没有选择文件', 'warn');
      return;
    }
    const ok = await ensurePermission(handle);
    if (!ok) {
      toast('未获得文件写入权限', 'warn');
      return;
    }
    setFileHandle(handle);
    setFileName(handle.name);
    setFileLinked(true);
    await saveHandle(handle);
    const written = await writeToHandle(handle, data);
    toast(written ? '数据已关联到 ' + handle.name : '写入失败', written ? 'ok' : 'warn');
  }, [data, fileHandle, toast]);

  const unlinkFile = useCallback(async () => {
    setFileHandle(null);
    setFileName(null);
    setFileLinked(false);
    await saveHandle(null);
    toast('已取消文件关联');
  }, [toast]);

  const value = useMemo<StoreValue>(
    () => ({
      data,
      setSettings,
      setDayHours,
      addRecord,
      updateRecord,
      removeRecord,
      clearDay,
      setMeal,
      batchApply,
      replaceAll,
      mergeAll,
      resetAll,
      restoreLastBackup,
      toasts,
      toast,
      dismissToast,
      fileHandle,
      fileName,
      fileLinked,
      linkFile,
      unlinkFile,
    }),
    [
      data,
      setSettings,
      setDayHours,
      addRecord,
      updateRecord,
      removeRecord,
      clearDay,
      setMeal,
      batchApply,
      replaceAll,
      mergeAll,
      resetAll,
      restoreLastBackup,
      toasts,
      toast,
      dismissToast,
      fileHandle,
      fileName,
      fileLinked,
      linkFile,
      unlinkFile,
    ]
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore 必须在 StoreProvider 内部使用');
  return ctx;
}
