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
import { runStartup } from './lib/startup';
import {
  createSyncController,
  defaultSyncConfig,
  isSyncConfigured,
  loadSyncConfig,
  saveSyncConfig,
  type SyncConfig,
  type SyncController,
  type SyncStatus,
} from './lib/sync';

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
  /** 云同步：配置、状态与手动操作（未配置时 syncNow / syncTest 不发任何请求） */
  syncConfig: SyncConfig;
  syncStatus: SyncStatus;
  updateSyncConfig: (patch: Partial<Pick<SyncConfig, 'token' | 'owner' | 'repo' | 'path'>>) => void;
  resetSyncConfig: () => void;
  syncNow: () => Promise<void>;
  syncTest: () => Promise<{ ok: boolean; message: string }>;
  /** 有覆盖风险时用户拍板：'remote' 用云端覆盖本地，'local' 用本地覆盖云端 */
  resolveSyncConflict: (choice: 'remote' | 'local') => Promise<void>;
}

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<AppData>(() => loadData());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [fileHandle, setFileHandle] = useState<FSFileHandle | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileLinked, setFileLinked] = useState(false);
  const [syncConfig, setSyncConfig] = useState<SyncConfig>(() => loadSyncConfig());
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(() =>
    isSyncConfigured(loadSyncConfig())
      ? { state: 'idle', at: null, message: '等待同步' }
      : { state: 'off', at: null, message: '未开启云同步' }
  );
  /** 同步层始终读最新的数据（不能拿渲染那一刻的闭包快照） */
  const dataRef = useRef<AppData>(data);
  const syncRef = useRef<SyncController | null>(null);
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

  /* --------------------------------- 云同步 --------------------------------- */

  // 配置了才启动；未配置时这里一个网络请求都不会发（A002 第 1 条）
  useEffect(() => {
    const ctrl = createSyncController({
      getData: () => dataRef.current,
      // 立刻同步 dataRef：React 提交前 getData() 还得拿到刚合并的结果
      applyRemote: (next) => {
        dataRef.current = next;
        setData(next);
      },
      onStatus: (s) => setSyncStatus(s),
      onNotice: (text, kind) => toast(text, kind),
    });
    syncRef.current = ctrl;
    // 整页启动：seed 预置（仅 DEV）+ 云同步。抽到 runStartup 里是为了能在装配层测
    // 「未配置 PAT 时零网络请求」（项目没有 jsdom，跑不了真实挂载）
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
      startSync: () => ctrl.start(),
    });

    // 关页面 / 切后台 / 锁屏：立刻推，别等那 8 秒防抖。
    // keepalive 让请求在页面销毁后仍能发完（否则手机上一关页就白推）
    const flushNow = () => {
      void ctrl.flush({ keepalive: true });
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flushNow();
    };
    // 断网时打开页面：拉取失败、pending 为空，只 flush 等于什么都不做 → 用 syncNow 重拉
    const retrySync = () => {
      void ctrl.syncNow();
    };
    window.addEventListener('pagehide', flushNow);
    window.addEventListener('online', retrySync);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flushNow);
      window.removeEventListener('online', retrySync);
      document.removeEventListener('visibilitychange', onVisibility);
      ctrl.stop();
      syncRef.current = null;
    };
  }, [toast]);

  // 数据一变就交给同步层：有没有实质变化由它判断（刚被远端覆盖的不会回推）
  useEffect(() => {
    dataRef.current = data;
    if (syncRef.current) syncRef.current.schedule(data);
  }, [data]);

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

  /** 改同步配置：owner/repo/path 换地方后，旧 sha 与基线就作废了 */
  const updateSyncConfig = useCallback(
    (patch: Partial<Pick<SyncConfig, 'token' | 'owner' | 'repo' | 'path'>>) => {
      const prev = loadSyncConfig();
      const next: SyncConfig = Object.assign({}, prev, patch);
      const moved =
        (patch.owner !== undefined && patch.owner !== prev.owner) ||
        (patch.repo !== undefined && patch.repo !== prev.repo) ||
        (patch.path !== undefined && patch.path !== prev.path);
      if (moved) {
        next.lastSha = null;
        next.baseUpdatedAt = null;
        // 旧仓库的冲突快照不能拿来合新仓库
        syncRef.current?.dropConflict();
      }
      saveSyncConfig(next);
      setSyncConfig(next);
      // 这里不自动发起同步：配置是逐字输入的，token 还没输完就请求只会换来一个 401。
      // 首次上传靠设置页的「立即同步」，或者下一次改动（8 秒防抖那趟会带上全量数据）。
    },
    []
  );

  const resetSyncConfig = useCallback(() => {
    syncRef.current?.dropConflict();
    const next = defaultSyncConfig();
    saveSyncConfig(next);
    setSyncConfig(next);
    setSyncStatus({ state: 'off', at: null, message: '未开启云同步' });
  }, []);

  const syncNow = useCallback(async () => {
    await syncRef.current?.syncNow();
  }, []);

  const resolveSyncConflict = useCallback(async (choice: 'remote' | 'local') => {
    await syncRef.current?.resolveConflict(choice);
  }, []);

  const syncTest = useCallback(async (): Promise<{ ok: boolean; message: string }> => {
    if (!syncRef.current) return { ok: false, message: '同步层还没准备好' };
    return syncRef.current.testConnection();
  }, []);

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
      syncConfig,
      syncStatus,
      updateSyncConfig,
      resetSyncConfig,
      syncNow,
      syncTest,
      resolveSyncConflict,
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
      syncConfig,
      syncStatus,
      updateSyncConfig,
      resetSyncConfig,
      syncNow,
      syncTest,
      resolveSyncConflict,
    ]
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore 必须在 StoreProvider 内部使用');
  return ctx;
}
