/** Supabase 同步：随机 space_id 当钥匙，不登录、不导入；本地优先，后台合并。 */

import type { AppData } from '../types';
import { normalize } from './storage';
import { mergeWorklog } from './sync';

const SUPABASE_URL = 'https://zpqpkqisdzhsnmoyuztd.supabase.co';
const SUPABASE_KEY = 'sb_publishable_hjgOgXzKeZx_AHobhTzPAw_lOtOEoDA';
const CONFIG_KEY = 'worklog:cloud';
const SYNC_PROTOCOL = 2;
const SPACE_RE = /^[a-f0-9]{32}$/i;

export interface CloudConfig {
  space: string;
  lastJson: string;
  lastAt: string;
}

export interface CloudRemote {
  payload: unknown;
  updated_at: string;
}

function randomSpace(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 隐私模式等：忽略，仍可本地使用 */
  }
}

export function readCloudConfig(): CloudConfig | null {
  const raw = safeGet(CONFIG_KEY);
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Partial<CloudConfig>;
    if (!obj.space || !SPACE_RE.test(obj.space)) return null;
    return {
      space: obj.space,
      lastJson: typeof obj.lastJson === 'string' ? obj.lastJson : '',
      lastAt: typeof obj.lastAt === 'string' ? obj.lastAt : '',
    };
  } catch {
    return null;
  }
}

export function writeCloudConfig(cfg: CloudConfig): void {
  safeSet(CONFIG_KEY, JSON.stringify(cfg));
}

function spaceFromHash(): string | null {
  const m = location.hash.match(/space=([a-f0-9]{32})/i);
  if (!m) return null;
  const space = m[1].toLowerCase();
  // 链接里的 space 是钥匙，读完就从地址栏去掉，避免被截图/转发时一直带着
  try {
    history.replaceState(null, '', location.pathname + location.search);
  } catch {
    /* ignore */
  }
  return space;
}

/** 优先用链接里的 space；其次用本机已存的；都没有就生成一个新的。 */
export function ensureCloudSpace(): string {
  const fromHash = spaceFromHash();
  if (fromHash) {
    const existing = readCloudConfig();
    writeCloudConfig({ space: fromHash, lastJson: existing?.space === fromHash ? existing.lastJson : '', lastAt: '' });
    return fromHash;
  }
  const existing = readCloudConfig();
  if (existing) return existing.space;
  const space = randomSpace();
  writeCloudConfig({ space, lastJson: '', lastAt: '' });
  return space;
}

export function cloudLink(space: string): string {
  const path = location.pathname.replace(/index\.html$/i, '') || '/';
  return location.origin + path + '#space=' + space;
}

async function rpc<T>(name: 'worklog_get' | 'worklog_put' | 'worklog_head', body: Record<string, unknown>): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) throw new Error('cloud ' + name + ' ' + res.status);
    return (await res.json()) as T;
  } finally {
    window.clearTimeout(timer);
  }
}

export async function cloudGet(space: string): Promise<CloudRemote | null> {
  const data = await rpc<CloudRemote | null>('worklog_get', { p_space: space });
  if (!data || typeof data !== 'object') return null;
  if (typeof data.updated_at !== 'string') return null;
  return data;
}

export async function cloudPut(space: string, data: AppData): Promise<{ ok: boolean; updated_at: string }> {
  // 旧客户端没有 syncProtocol；新客户端整份快照带上它，服务端/其他新客户端可识别旧格式
  return rpc<{ ok: boolean; updated_at: string }>('worklog_put', {
    p_space: space,
    p_payload: Object.assign({}, data, { syncProtocol: SYNC_PROTOCOL }),
  });
}

/** 只取 updated_at 的轻量探针；正文只在真的有变化时才拉。 */
export async function cloudHead(space: string): Promise<{ updated_at: string } | null> {
  const data = await rpc<{ updated_at: string } | null>('worklog_head', { p_space: space });
  if (!data || typeof data !== 'object' || typeof data.updated_at !== 'string') return null;
  return data;
}

export function normalizeRemote(remote: CloudRemote): AppData {
  return normalize(remote.payload as Partial<AppData> | null);
}

export function mergeCloud(local: AppData, remote: CloudRemote, localUpdatedAt: string): AppData {
  return mergeWorklog(
    local,
    { schema: 1, updatedAt: remote.updated_at, data: normalizeRemote(remote) },
    localUpdatedAt
  );
}
