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
  defaultSyncConfig,
  isSyncConfigured,
  loadSyncConfig,
  saveSyncConfig,
  type SyncConfig,
  type SyncController,
  type SyncStatus,
} from './lib/sync';
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
  /** 第一台设备生成的同步链接；新设备打开一次就绑定 */
  cloudLink: string;
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
  const [cloudSpace] = useState<string>(() => ensureCloudSpace());
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
  // 不做按 id 的并集合并：并集会把刚删掉的记录从云端捞回来，也会让编辑看起来“自己弹回去”。
  useEffect(() => {
    let alive = true;
    let timer = 0;
    let inFlight = false;

    const run = async () => {
      if (!alive || inFlight) return;
      inFlight = true;
      try {
        const cfg = readCloudConfig() || { space: cloudSpace, lastJson: '', lastAt: '' };
        const local = dataRef.current;
        const localJson = JSON.stringify(local);
        const localEmpty = local.records.length === 0 && Object.keys(local.meals).length === 0;
        const dirty = localJson !== cfg.lastJson;
        const brandNew = !cfg.lastJson && localEmpty;

        // 这台设备有未同步的改动（新增 / 编辑 / 删除都算）：整份推本地
        if (!brandNew && dirty) {
          const res = await cloudPut(cloudSpace, local);
          if (alive) {
            writeCloudConfig({ space: cloudSpace, lastJson: localJson, lastAt: res.updated_at });
          }
          return;
        }

        const remote = await cloudGet(cloudSpace);
        if (!remote) {
          const res = await cloudPut(cloudSpace, local);
          if (alive) {
            writeCloudConfig({ space: cloudSpace, lastJson: localJson, lastAt: res.updated_at });
          }
          return;
        }

        const remoteData = normalizeRemote(remote);
        const remoteJson = JSON.stringify(remoteData);

        // 本地已经清空过（cfg 里有上次快照），云端还是旧记录：
        // 只要云端没有比本地更新时间更新，就以本地的「空」为准，别把删掉的记录再拉回来。
        if (localEmpty && cfg.lastJson && remoteJson !== localJson) {
          const remoteNewer = Date.parse(remote.updated_at) > Date.parse(cfg.lastAt || '');
          if (!remoteNewer) {
            const res = await cloudPut(cloudSpace, local);
            if (alive) writeCloudConfig({ space: cloudSpace, lastJson: localJson, lastAt: res.updated_at });
            return;
          }
        }

        // 拉取期间用户又改了：丢掉这次结果，交给下一轮推本地
        if (JSON.stringify(dataRef.current) !== localJson) return;

        if (remoteJson !== localJson) {
          writeCloudConfig({ space: cloudSpace, lastJson: remoteJson, lastAt: remote.updated_at });
          if (alive) {
            dataRef.current = remoteData;
            setData(remoteData);
          }
        } else {
          writeCloudConfig({ space: cloudSpace, lastJson: localJson, lastAt: remote.updated_at });
        }
      } catch {
        /* 断网/代理失败：保持本地，下次改动或重开再试 */
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
    // 另一台设备改动后，最多 8 秒在这里出现；只拉 updated_at，变了才拉正文
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
        // 还没跑最新的 schema.sql（缺 worklog_head）时退回整份拉取
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
  }, [cloudSpace]);

  // 数据一变就交给同步层：有没有实质变化由它判断（刚被远端覆盖的不会回推）
  useEffect(() => {
    dataRef.current = data;
    if (syncRef.current) syncRef.current.schedule(data);
    cloudScheduler.current?.();
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
        next.base = null; // 换了仓库，旧仓库的快照没意义
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
      cloudLink: link,
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
      link,
    ]
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore 必须在 StoreProvider 内部使用');
  return ctx;
}
