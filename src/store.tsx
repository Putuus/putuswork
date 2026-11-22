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
import type { AppData, Settings, WorkRecord } from './types';
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
  mergeInto,
  type FSFileHandle,
} from './lib/storage';
import { runStartup } from './lib/startup';
import {
  cloudGet,
  cloudHead,
  cloudLink,
  cloudPut,
  ensureCloudSpace,
  normalizeRemote,
  readCloudConfig,
  writeCloudConfig,
} from './lib/cloud';

export interface Toast {
  id: string;
  text: string;
  kind: 'ok' | 'warn';
}

export interface BatchPatch {
  hours?: number;
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
  /** 按月填饭补：month = 'YYYY-MM' */
  setMonthMeal: (month: string, value: number | null) => void;
  batchApply: (dates: string[], patch: BatchPatch) => void;
  replaceAll: (next: AppData) => void;
  mergeAll: (next: AppData) => { added: number; skipped: number };
  toasts: Toast[];
  toast: (text: string, kind?: 'ok' | 'warn') => void;
  dismissToast: (id: string) => void;
  fileHandle: FSFileHandle | null;
  fileName: string | null;
  fileLinked: boolean;
  linkFile: () => Promise<void>;
  unlinkFile: () => Promise<void>;
  /** 第一台设备生成的同步链接；新设备打开一次就绑定 */
  cloudLink: string;
  cloudStatus: { state: 'idle' | 'syncing' | 'synced' | 'error' | 'conflict'; at: string | null };
  cloudConflict: boolean;
  resolveCloudConflict: (choice: 'local' | 'remote') => Promise<void>;
}

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<AppData>(() => loadData());
  /**
   * 所有“用户改数据”的入口都走这里，给内容盖上本机修改时间。
   * 远端拉回来的数据用 setData 原样放回，不盖时间，否则会被误判成本地新改动。
   */
  const commit = useCallback((next: AppData | ((prev: AppData) => AppData)) => {
    setData((prev) => {
      const value = typeof next === 'function' ? next(prev) : next;
      return Object.assign({}, value, { updatedAt: new Date().toISOString() });
    });
  }, []);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [fileHandle, setFileHandle] = useState<FSFileHandle | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileLinked, setFileLinked] = useState(false);
  /** 同步层始终读最新的数据（不能拿渲染那一刻的闭包快照） */
  const dataRef = useRef<AppData>(data);
  const timers = useRef<number[]>([]);
  const [cloudSpace] = useState<string>(() => ensureCloudSpace());
  const [cloudStatus, setCloudStatus] = useState<{
    state: 'idle' | 'syncing' | 'synced' | 'error' | 'conflict';
    at: string | null;
  }>({ state: 'idle', at: null });
  const [cloudConflict, setCloudConflict] = useState(false);
  const cloudConflictRef = useRef<{ remoteData: AppData; remoteAt: string } | null>(null);
  const cloudScheduler = useRef<(() => void) | null>(null);
  const link = useMemo(() => cloudLink(cloudSpace), [cloudSpace]);

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
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (!saveData(data)) toast('保存失败：浏览器存储写不进去了（可能满了或处于隐私模式）', 'warn');
    }, 180);
    return () => window.clearTimeout(t);
  }, [data, toast]);


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

  /* ------------------------- 启动 seed（云同步已改用 Supabase） ------------------------- */
  useEffect(() => {
    void runStartup({
      dev: import.meta.env.DEV,
      seedUrl: import.meta.env.BASE_URL + 'seed.json',
      fetchSeed: (url) => fetch(url, { cache: 'no-store' }),
      readSeedVersion: () => {
        try {
          return Number(localStorage.getItem('worklog:seed') || '0');
        } catch {
          return 0;
        }
      },
      writeSeedVersion: (version) => {
        try {
          localStorage.setItem('worklog:seed', String(version));
        } catch {
          /* 忽略 */
        }
      },
      importSeed: (incoming) => {
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
      },
      notify: (text) => toast(text),
      startSync: async () => {
        /* 旧的 GitHub 同步已停用；自动同步统一走下面的 Supabase */
      },
    });
  }, [toast]);

  // Supabase 自动同步：本地有改动就整份快照推上去，干净时才拉云端。
  // 不做按 id 的并集合并；云端和本地同时有改动时停下来，让用户选一边。
  useEffect(() => {
    let alive = true;
    let timer = 0;
    let inFlight = false;

    const markSynced = () => {
      if (alive) setCloudStatus({ state: 'synced', at: new Date().toISOString() });
    };
    const pushLocal = async (local: AppData, localJson: string) => {
      const res = await cloudPut(cloudSpace, local);
      if (alive) {
        writeCloudConfig({ space: cloudSpace, lastJson: localJson, lastAt: res.updated_at });
        markSynced();
      }
    };

    const run = async () => {
      if (!alive || inFlight || cloudConflictRef.current) return;
      inFlight = true;
      if (alive) setCloudStatus({ state: 'syncing', at: null });
      try {
        const cfg = readCloudConfig() || { space: cloudSpace, lastJson: '', lastAt: '' };
        const local = dataRef.current;
        const localJson = JSON.stringify(local);
        const localEmpty = local.records.length === 0 && Object.keys(local.meals).length === 0;
        const dirty = localJson !== cfg.lastJson;
        const brandNew = !cfg.lastJson && localEmpty;

        const remote = await cloudGet(cloudSpace);
        if (!remote) {
          await pushLocal(local, localJson);
          return;
        }

        const rawProtocol = (remote.payload as { syncProtocol?: number } | null)?.syncProtocol;
        if (rawProtocol !== 2) {
          // 旧版客户端没有 syncProtocol，新客户端不把它的数据当权威
          if (brandNew) {
            const legacyData = normalizeRemote(remote);
            const legacyJson = JSON.stringify(legacyData);
            if (JSON.stringify(dataRef.current) !== localJson) return;
            writeCloudConfig({ space: cloudSpace, lastJson: legacyJson, lastAt: remote.updated_at });
            if (alive) {
              dataRef.current = legacyData;
              setData(legacyData);
            }
            const res = await cloudPut(cloudSpace, legacyData);
            if (alive) {
              writeCloudConfig({ space: cloudSpace, lastJson: legacyJson, lastAt: res.updated_at });
              markSynced();
            }
            return;
          }
          await pushLocal(local, localJson);
          return;
        }

        const remoteData = normalizeRemote(remote);
        const remoteJson = JSON.stringify(remoteData);
        const localUpdatedAt = Date.parse(local.updatedAt || '') || 0;
        const remoteUpdatedAt = Date.parse(remoteData.updatedAt || '') || 0;

        // 新设备 + 空本地：直接采用云端
        if (brandNew) {
          if (JSON.stringify(dataRef.current) !== localJson) return;
          writeCloudConfig({ space: cloudSpace, lastJson: remoteJson, lastAt: remote.updated_at });
          if (alive) {
            dataRef.current = remoteData;
            setData(remoteData);
            markSynced();
          }
          return;
        }

        // 本地有改动，且云端在“上次同步之后”也变了；或这台设备还没同步过但云端已有数据：
        // 都不自动覆盖，停下来让用户选。手机第一次打开旧的本地数据不会再静默盖掉电脑的新数据。
        const neverSynced = !cfg.lastJson;
        const remoteChanged = !cfg.lastAt || remote.updated_at !== cfg.lastAt;
        if ((neverSynced || remoteChanged) && dirty && remoteJson !== localJson) {
          cloudConflictRef.current = { remoteData, remoteAt: remote.updated_at };
          if (alive) {
            setCloudConflict(true);
            setCloudStatus({ state: 'conflict', at: remote.updated_at });
            toast('云端已有数据，去设置里选择保留哪边', 'warn');
          }
          return;
        }

        // 本地有未同步改动：整份推本地
        if (dirty) {
          await pushLocal(local, localJson);
          return;
        }

        // 本地干净但内容不同：用内容修改时间判断谁更新
        if (remoteJson !== localJson) {
          if (remoteUpdatedAt > localUpdatedAt) {
            if (JSON.stringify(dataRef.current) !== localJson) return;
            writeCloudConfig({ space: cloudSpace, lastJson: remoteJson, lastAt: remote.updated_at });
            if (alive) {
              dataRef.current = remoteData;
              setData(remoteData);
              markSynced();
            }
          } else if (localUpdatedAt > remoteUpdatedAt) {
            // 本机内容比云端新（例如云端被旧设备写成旧快照）：把本机推回去
            await pushLocal(local, localJson);
          } else {
            // 两边都没有可靠的内容时间：不猜，交给用户选
            cloudConflictRef.current = { remoteData, remoteAt: remote.updated_at };
            if (alive) {
              setCloudConflict(true);
              setCloudStatus({ state: 'conflict', at: remote.updated_at });
              toast('云端和本地都有自己的数据，去设置里选择保留哪边', 'warn');
            }
          }
        } else {
          writeCloudConfig({ space: cloudSpace, lastJson: localJson, lastAt: remote.updated_at });
          markSynced();
        }
      } catch {
        if (alive) setCloudStatus({ state: 'error', at: null });
      } finally {
        inFlight = false;
      }
    };

    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void run(), 1400);
    };
    cloudScheduler.current = schedule;
    timer = window.setTimeout(() => void run(), 900);

    let headOk = true;
    const check = async () => {
      if (inFlight) return;
      if (!headOk) {
        void run();
        return;
      }
      try {
        const head = await cloudHead(cloudSpace);
        const cfg = readCloudConfig();
        if (head && head.updated_at !== (cfg?.lastAt || '')) {
          void run();
        } else if (!head && cfg?.lastAt) {
          void run();
        }
      } catch {
        // 还没跑最新 schema.sql 时退回整份拉取
        headOk = false;
        void run();
      }
    };
    const interval = window.setInterval(() => void check(), 8000);
    const wake = () => {
      if (document.visibilityState !== 'hidden') void run();
    };
    window.addEventListener('focus', wake);
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', wake);

    return () => {
      alive = false;
      window.clearTimeout(timer);
      window.clearInterval(interval);
      window.removeEventListener('focus', wake);
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', wake);
      cloudScheduler.current = null;
    };
  }, [cloudSpace, toast]);

  const resolveCloudConflict = useCallback(
    async (choice: 'local' | 'remote') => {
      const conflict = cloudConflictRef.current;
      if (!conflict) return;
      try {
        if (choice === 'local') {
          // 用户明确选本地时，给内容盖一个当前时间再推，确保其他设备知道这是更新的版本
          const local = Object.assign({}, dataRef.current, { updatedAt: new Date().toISOString() });
          const res = await cloudPut(cloudSpace, local);
          dataRef.current = local;
          setData(local);
          writeCloudConfig({ space: cloudSpace, lastJson: JSON.stringify(local), lastAt: res.updated_at });
          setCloudStatus({ state: 'synced', at: res.updated_at });
          toast('已保留本地版本');
        } else {
          writeCloudConfig({
            space: cloudSpace,
            lastJson: JSON.stringify(conflict.remoteData),
            lastAt: conflict.remoteAt,
          });
          dataRef.current = conflict.remoteData;
          setData(conflict.remoteData);
          setCloudStatus({ state: 'synced', at: conflict.remoteAt });
          toast('已使用云端版本');
        }
      } catch {
        toast('处理冲突失败，稍后再试', 'warn');
        return;
      }
      cloudConflictRef.current = null;
      setCloudConflict(false);
    },
    [cloudSpace, toast]
  );

  // 数据一变就交给同步层：有没有实质变化由它判断（刚被远端覆盖的不会回推）
  useEffect(() => {
    dataRef.current = data;
    cloudScheduler.current?.();
  }, [data]);

  const setSettings = useCallback((patch: Partial<Settings>) => {
    commit((prev) => Object.assign({}, prev, { settings: Object.assign({}, prev.settings, patch) }));
  }, [commit]);

  const setDayHours = useCallback((iso: string, hours: number) => {
    const value = Math.max(0, Math.min(24, Math.round(hours * 100) / 100));
    commit((prev) => {
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
  }, [commit]);

  const addRecord = useCallback((iso: string, patch?: Partial<WorkRecord>) => {
    commit((prev) => {
      const rec: WorkRecord = Object.assign(
        { id: uid(), date: iso, hours: 8, rate: null, note: '' },
        patch || {}
      );
      return Object.assign({}, prev, { records: prev.records.concat([rec]) });
    });
  }, [commit]);

  const updateRecord = useCallback((id: string, patch: Partial<WorkRecord>) => {
    commit((prev) =>
      Object.assign({}, prev, {
        records: prev.records.map((r) => (r.id === id ? Object.assign({}, r, patch) : r)),
      })
    );
  }, [commit]);

  const removeRecord = useCallback((id: string) => {
    commit((prev) => Object.assign({}, prev, { records: prev.records.filter((r) => r.id !== id) }));
  }, [commit]);

  const clearDay = useCallback((iso: string) => {
    commit((prev) => Object.assign({}, prev, { records: prev.records.filter((r) => r.date !== iso) }));
  }, [commit]);

  const setMonthMeal = useCallback((month: string, value: number | null) => {
    commit((prev) => {
      const monthMeals = Object.assign({}, prev.monthMeals);
      if (value === null || !Number.isFinite(value) || value <= 0) delete monthMeals[month];
      else monthMeals[month] = Math.min(100000, Math.round(value * 100) / 100);
      return Object.assign({}, prev, { monthMeals });
    });
  }, [commit]);

  /** 批量：把工时/备注一次性套用到选中的每一天 */
  const batchApply = useCallback((dates: string[], patch: BatchPatch) => {
    if (dates.length === 0) return;
    commit((prev) => {
      let records = prev.records.slice();

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

      return Object.assign({}, prev, { records });
    });
  }, [commit]);

  const replaceAll = useCallback((next: AppData) => commit(next), [commit]);

  /** 合并导入：保留现有数据，只把新的补进来 */
  const mergeAll = useCallback(
    (next: AppData) => {
      const result = mergeInto(data, next);
      commit(result.data);
      return { added: result.added, skipped: result.skipped };
    },
    [data, commit]
  );
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
      setMonthMeal,
      batchApply,
      replaceAll,
      mergeAll,
      toasts,
      toast,
      dismissToast,
      fileHandle,
      fileName,
      fileLinked,
      linkFile,
      unlinkFile,
      cloudLink: link,
      cloudStatus,
      cloudConflict,
      resolveCloudConflict,
    }),
    [
      data,
      setSettings,
      setDayHours,
      addRecord,
      updateRecord,
      removeRecord,
      clearDay,
      setMonthMeal,
      batchApply,
      replaceAll,
      mergeAll,
      toasts,
      toast,
      dismissToast,
      fileHandle,
      fileName,
      fileLinked,
      linkFile,
      unlinkFile,
      link,
      cloudStatus,
      cloudConflict,
      resolveCloudConflict,
    ]
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore 必须在 StoreProvider 内部使用');
  return ctx;
}
