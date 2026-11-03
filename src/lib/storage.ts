/** 存储层 —— 主存储在 localStorage，可选关联本地 JSON 文件（Chrome/Edge 的 File System Access） */

import { DATA_VERSION, defaultSettings, emptyData, type AppData } from '../types';

const KEY = 'worklog:v1';
const HANDLE_DB = 'worklog-fs';
const HANDLE_STORE = 'handles';

/* ---------------------------------- 主存储 --------------------------------- */

export function loadData(): AppData {
  const raw = localStorage.getItem(KEY);
  if (!raw) return emptyData();
  try {
    const parsed = JSON.parse(raw) as Partial<AppData>;
    return normalize(parsed);
  } catch (err) {
    // 数据解析不了：先把原始字符串另存一份，再回退。
    // 绝不能让「空数据」把原来那份直接覆盖掉。
    try {
      localStorage.setItem('worklog:corrupt:' + Date.now(), raw);
    } catch {
      /* 存不下也没办法 */
    }
    console.warn('[worklog] 数据解析失败，原始内容已另存为 worklog:corrupt:*', err);
    return emptyData();
  }
}

export function saveData(data: AppData): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
    return true;
  } catch (err) {
    console.warn('[worklog] 保存失败（可能超出 localStorage 配额）', err);
    return false;
  }
}

/** 兼容旧数据 / 脏数据 */
export function normalize(input: Partial<AppData> | null | undefined): AppData {
  const base = emptyData();
  if (!input || typeof input !== 'object') return base;
  const settings = Object.assign({}, defaultSettings(), input.settings || {});
  // 图标只允许这两个值：默认图 or 文字「时」。旧版本存过的其它图标名会让图片 404
  if (settings.logo !== 'logo.png' && settings.logo !== 'letter') settings.logo = 'logo.png';
  settings.hourlyRate = Number(settings.hourlyRate) || 0;
  settings.defaultMeal = Number(settings.defaultMeal) || 0;
  const records = Array.isArray(input.records)
    ? input.records
        .filter((r) => r && typeof r.date === 'string')
        .map((r) => ({
          id: String(r.id || uid()),
          date: r.date,
          hours: Number(r.hours) || 0,
          rate: r.rate === null || r.rate === undefined || r.rate === ('' as unknown) ? null : Number(r.rate),
          note: typeof r.note === 'string' ? r.note : '',
        }))
    : [];
  const meals: Record<string, number> = {};
  if (input.meals && typeof input.meals === 'object') {
    for (const [k, v] of Object.entries(input.meals)) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) meals[k] = Math.min(100, Math.max(1, Math.round(n)));
    }
  }
  return { version: DATA_VERSION, settings, records, meals };
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/* ---------------------------------- 导入导出 -------------------------------- */

export function downloadJSON(data: AppData, filename?: string): void {
  const name = filename || 'worklog-' + new Date().toISOString().slice(0, 10) + '.json';
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/* ---------------------------------- 轮转备份 --------------------------------- */

const BACKUP_PREFIX = 'worklog:bk:';
const BACKUP_KEEP = 5;

/** 把上一版数据存进轮转备份，最多保留 5 份 */
export function pushBackup(prevJson: string): void {
  try {
    localStorage.setItem(BACKUP_PREFIX + Date.now(), prevJson);
    const keys = backupKeys();
    for (let i = 0; i < keys.length - BACKUP_KEEP; i++) localStorage.removeItem(keys[i]);
  } catch (err) {
    console.warn('[worklog] 备份失败', err);
  }
}

export function backupKeys(): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf(BACKUP_PREFIX) === 0) keys.push(k);
    }
  } catch {
    /* 忽略 */
  }
  return keys.sort();
}

export function latestBackup(): { at: number; data: AppData } | null {
  const keys = backupKeys();
  const k = keys[keys.length - 1];
  if (!k) return null;
  try {
    const raw = localStorage.getItem(k);
    if (!raw) return null;
    return { at: Number(k.slice(BACKUP_PREFIX.length)) || 0, data: normalize(JSON.parse(raw)) };
  } catch {
    return null;
  }
}

/** 合并导入：只补新记录，不动已有数据（按 日期+工时+备注 去重） */
export function mergeInto(
  current: AppData,
  incoming: AppData
): { data: AppData; added: number; skipped: number } {
  const keys = new Set(current.records.map((r) => r.date + '|' + r.hours + '|' + r.note));
  const records = current.records.slice();
  let added = 0;
  let skipped = 0;
  for (const r of incoming.records) {
    const key = r.date + '|' + r.hours + '|' + r.note;
    if (keys.has(key)) {
      skipped++;
      continue;
    }
    keys.add(key);
    records.push(r);
    added++;
  }
  const meals: Record<string, number> = Object.assign({}, current.meals);
  for (const [k, v] of Object.entries(incoming.meals)) {
    if (meals[k] === undefined) meals[k] = v;
  }
  records.sort((a, b) => (a.date < b.date ? -1 : 1));
  return { data: Object.assign({}, current, { records, meals }), added, skipped };
}

export function parseImport(text: string): AppData | null {
  try {
    return normalize(JSON.parse(text) as Partial<AppData>);
  } catch {
    return null;
  }
}

/* ------------------------------ 本地文件关联（可选） ------------------------------ */

interface FSWritable {
  write(data: string): Promise<void>;
  close(): Promise<void>;
}

export interface FSFileHandle {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<FSWritable>;
  queryPermission?(desc: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(desc: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

interface PickerWindow {
  showSaveFilePicker?: (opts?: unknown) => Promise<FSFileHandle>;
  showOpenFilePicker?: (opts?: unknown) => Promise<FSFileHandle[]>;
}

export function fsSupported(): boolean {
  const w = window as unknown as PickerWindow;
  return typeof w.showSaveFilePicker === 'function' && typeof indexedDB !== 'undefined';
}

export async function pickSaveFile(): Promise<FSFileHandle | null> {
  const w = window as unknown as PickerWindow;
  if (!w.showSaveFilePicker) return null;
  try {
    return await w.showSaveFilePicker({
      suggestedName: 'worklog-data.json',
      types: [{ description: '工时数据', accept: { 'application/json': ['.json'] } }],
    });
  } catch {
    return null;
  }
}

export async function pickOpenFile(): Promise<FSFileHandle | null> {
  const w = window as unknown as PickerWindow;
  if (!w.showOpenFilePicker) return null;
  try {
    const arr = await w.showOpenFilePicker({
      multiple: false,
      types: [{ description: '工时数据', accept: { 'application/json': ['.json'] } }],
    });
    return arr && arr[0] ? arr[0] : null;
  } catch {
    return null;
  }
}

export async function ensurePermission(handle: FSFileHandle): Promise<boolean> {
  if (!handle.queryPermission || !handle.requestPermission) return true;
  const opts = { mode: 'readwrite' as const };
  try {
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    return (await handle.requestPermission(opts)) === 'granted';
  } catch {
    return false;
  }
}

export async function writeToHandle(handle: FSFileHandle, data: AppData): Promise<boolean> {
  try {
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(data, null, 2));
    await writable.close();
    return true;
  } catch (err) {
    console.warn('[worklog] 写入本地文件失败', err);
    return false;
  }
}

export async function readHandle(handle: FSFileHandle): Promise<AppData | null> {
  try {
    const file = await handle.getFile();
    return parseImport(await file.text());
  } catch {
    return null;
  }
}

/* --------------------- 文件句柄持久化（IndexedDB，localStorage 存不下） --------------------- */

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HANDLE_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE)) db.createObjectStore(HANDLE_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveHandle(handle: FSFileHandle | null): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readwrite');
      const store = tx.objectStore(HANDLE_STORE);
      if (handle) store.put(handle, 'linked');
      else store.delete('linked');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    console.warn('[worklog] 句柄保存失败', err);
  }
}

export async function loadHandle(): Promise<FSFileHandle | null> {
  if (typeof indexedDB === 'undefined') return null;
  try {
    const db = await openDB();
    const handle = await new Promise<FSFileHandle | null>((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readonly');
      const req = tx.objectStore(HANDLE_STORE).get('linked');
      req.onsuccess = () => resolve((req.result as FSFileHandle) || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return handle;
  } catch {
    return null;
  }
}
