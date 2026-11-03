/**
 * 云同步 —— 用 GitHub 私有仓库当存储（Contents API）
 *
 * 设计要点（对应 PROJECT_RULES §3.1 与 §4 A002）：
 * - **本地优先**：AppData 仍以 localStorage(`worklog:v1`) 为主，这里只管「副本」的拉 / 推 / 合并；
 *   所有失败都只反映在状态上，绝不阻塞记账
 * - **纯函数**：mergeWorklog、base64 UTF-8 编解码、parseRemoteDoc 不碰 DOM、不碰 storage，可直接断言输入输出
 * - **可测**：fetch / localStorage / 定时器 / 时钟全部可注入；未配置 PAT 时任何方法都不发请求（A002-1）
 * - **安全**：PAT 只从 localStorage(`worklog:sync`) 读，不进 URL、不进日志、不进远端文件
 */

import { DATA_VERSION, type AppData, type Settings, type WorkRecord } from '../types';
import { normalize } from './storage';

export const SYNC_KEY = 'worklog:sync';
/** 变更后防抖多久再推送（§3.1 定稿：8 秒） */
export const SYNC_DEBOUNCE_MS = 8000;
/** 远端文件结构版本，目前只认 1 */
export const SYNC_SCHEMA = 1;
/** 单次请求超时：弱网下别把队列吊死（R3） */
export const SYNC_TIMEOUT_MS = 15000;
/** 失败后指数退避重试：30s 起，封顶 5 分钟（R4） */
export const RETRY_BASE_MS = 30000;
export const RETRY_MAX_MS = 300000;
const API_BASE = 'https://api.github.com';

/* ---------------------------------- 类型 ---------------------------------- */

export interface SyncKV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 上次同步成功时的数据快照指纹（只存指纹，不存整份数据） */
export interface SyncBase {
  /** 记录 id → `date|hours|rate|note`，用来判断「本地这条自上次同步后有没有被改过」 */
  records: Record<string, string>;
  /** 日期 → 金额 */
  meals: Record<string, number>;
  /** JSON(settings) */
  settings: string;
}

export interface SyncConfig {
  /** fine-grained PAT，只存在浏览器 localStorage，绝不外泄 */
  token: string;
  owner: string;
  repo: string;
  /** 仓库内路径，默认 worklog.json（可放子目录） */
  path: string;
  /** 上次读/写拿到的 blob sha，做乐观锁 */
  lastSha: string | null;
  /** 上次同步时远端文档的 updatedAt，用作合并基线 */
  baseUpdatedAt: string | null;
  /**
   * 上次同步成功后的本地数据快照。拉取时拿它和当前 data 比：
   * 本地没动过 → 远端版本直接采用，不该弹「用云端/用本地」；
   * 本地真改过 → 才进冲突确认。null = 老版本升级上来或快照坏了，按「有风险」保守处理。
   */
  base: SyncBase | null;
}

/** 远端文件：{ schema: 1, updatedAt: ISO, data: AppData } */
export interface RemoteDoc {
  schema: number;
  updatedAt: string;
  data: AppData;
}

export type SyncState = 'off' | 'idle' | 'syncing' | 'synced' | 'unsynced' | 'conflict';

/** 合并会抹掉哪些本地改动（有值时不算「同步成功」，要用户拍板） */
export interface OverwriteRisk {
  /** 同 id 但内容不同、本地版本会被远端覆盖的条数 */
  records: number;
  /** 同一天餐补不同、本地会被远端覆盖的天数 */
  meals: number;
  /** settings 整份会被远端覆盖 */
  settings: boolean;
}

export interface SyncStatus {
  state: SyncState;
  /** 最近一次成功/失败的时间戳（ms） */
  at: number | null;
  message: string;
  /** state === 'conflict' 时带上风险摘要 */
  risk?: OverwriteRisk | null;
}

export type SyncErrorCode = 'disabled' | 'auth' | 'notfound' | 'conflict' | 'http' | 'bad-data' | 'network';

export class SyncError extends Error {
  readonly code: SyncErrorCode;
  readonly status: number | undefined;

  constructor(code: SyncErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'SyncError';
    this.code = code;
    this.status = status;
  }
}

/* -------------------------------- 配置读写 -------------------------------- */

export function defaultSyncConfig(): SyncConfig {
  return { token: '', owner: '', repo: '', path: 'worklog.json', lastSha: null, baseUpdatedAt: null, base: null };
}

function normalizeBase(raw: unknown): SyncBase | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const records: Record<string, string> = {};
  if (r.records && typeof r.records === 'object') {
    for (const [id, v] of Object.entries(r.records as Record<string, unknown>)) {
      if (typeof v === 'string') records[id] = v;
    }
  }
  const meals: Record<string, number> = {};
  if (r.meals && typeof r.meals === 'object') {
    for (const [day, v] of Object.entries(r.meals as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) meals[day] = v;
    }
  }
  return { records, meals, settings: typeof r.settings === 'string' ? r.settings : '' };
}

/** 一条记录的内容指纹：只用来判断「有没有改过」 */
function recordFingerprint(r: WorkRecord): string {
  return r.date + '|' + r.hours + '|' + (r.rate === null ? '' : r.rate) + '|' + r.note;
}

/** 给当前数据拍一份指纹快照，同步成功后存进配置 */
export function buildBase(data: AppData): SyncBase {
  const records: Record<string, string> = {};
  for (const r of data.records) records[r.id] = recordFingerprint(r);
  const meals: Record<string, number> = {};
  for (const day of Object.keys(data.meals)) meals[day] = data.meals[day];
  return { records, meals, settings: JSON.stringify(data.settings) };
}

export function defaultKV(): SyncKV | null {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

export function normalizeSyncConfig(raw: unknown): SyncConfig {
  const base = defaultSyncConfig();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  return {
    token: str(r.token),
    owner: str(r.owner),
    repo: str(r.repo),
    path: str(r.path) || base.path,
    lastSha: str(r.lastSha) || null,
    baseUpdatedAt: str(r.baseUpdatedAt) || null,
    base: normalizeBase(r.base),
  };
}

export function loadSyncConfig(kv: SyncKV | null = defaultKV()): SyncConfig {
  if (!kv) return defaultSyncConfig();
  try {
    const raw = kv.getItem(SYNC_KEY);
    if (!raw) return defaultSyncConfig();
    return normalizeSyncConfig(JSON.parse(raw));
  } catch {
    return defaultSyncConfig();
  }
}

/** 只写配置、不回显 token；写失败也不抛（隐私模式下会写不进去） */
export function saveSyncConfig(cfg: SyncConfig, kv: SyncKV | null = defaultKV()): void {
  if (!kv) return;
  try {
    kv.setItem(SYNC_KEY, JSON.stringify(normalizeSyncConfig(cfg)));
  } catch (err) {
    // 注意：不要把 cfg 打出来，里面有 token
    console.warn('[worklog] 云同步配置保存失败（可能是隐私模式或配额满）', err instanceof Error ? err.name : '');
  }
}

/** 四个字段齐了才算「已配置」；少一个就当没开同步，一个请求都不发 */
export function isSyncConfigured(cfg: SyncConfig): boolean {
  return Boolean(cfg.token && cfg.owner && cfg.repo && cfg.path);
}

/* ------------------------------ base64 / UTF-8 ----------------------------- */

/** UTF-8 → base64（btoa 只吃 Latin-1，中文必须先过 TextEncoder；A002-5 的往返断言靠它） */
export function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** base64 → UTF-8；GitHub 返回的内容每 76 字符带换行，先去掉 */
export function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/* -------------------------------- 远端文档 -------------------------------- */

export function buildRemoteDoc(data: AppData, updatedAt: string): RemoteDoc {
  return { schema: SYNC_SCHEMA, updatedAt, data };
}

/**
 * 解析远端文件。宁可判「读不懂」也不要把半截数据当成真的：
 * 结构不对就返回 null，调用方按 bad-data 处理，本地数据原样保留（数据安全红线）。
 */
export function parseRemoteDoc(text: string): RemoteDoc | null {
  try {
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const schema = r.schema === undefined ? SYNC_SCHEMA : Number(r.schema);
    if (schema !== SYNC_SCHEMA) return null;
    const d = r.data;
    if (!d || typeof d !== 'object') return null;
    const dr = d as Record<string, unknown>;
    // records / meals 至少要 recognizable，否则视为坏文件（避免把空数据合并进本地）
    if (!Array.isArray(dr.records) || !dr.meals || typeof dr.meals !== 'object') return null;
    const updatedAt = typeof r.updatedAt === 'string' && r.updatedAt ? r.updatedAt : '';
    return { schema: SYNC_SCHEMA, updatedAt, data: normalize(dr as Partial<AppData>) };
  } catch {
    return null;
  }
}

/* --------------------------------- 合并 ---------------------------------- */

function byDateThenId(a: WorkRecord, b: WorkRecord): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * 合并本地与远端（纯函数，A002-5 锁定）。
 *
 * - 文档级 last-write-wins：`remote.updatedAt > localUpdatedAt` 时远端算「较新文档」，反之本地算
 * - records：按 id 合并；同一个 id 只取「较新文档」那份（记录本身没有时间戳，只能按文档判）
 * - meals：按日期合并；同一天冲突时取较新文档的
 * - settings：整份取较新文档的
 * - 只在一侧存在的记录一律保留 —— 宁可多一条，不静默丢数据
 *
 * @param localUpdatedAt 本地这份数据对应的远端基线（SyncConfig.baseUpdatedAt）；不传则视为「最旧」
 */
/**
 * 谁能当「较新文档」。
 * 远端时间戳读不懂时**不认它更新**（本地赢），避免一个手改坏的文件把本地设置冲掉；
 * 本地没有基线（首次同步 / 换仓库）时远端算更新。
 */
function isNewer(remoteIso: string, localIso: string | null): boolean {
  const r = Date.parse(remoteIso || '');
  if (Number.isNaN(r)) return false;
  const l = Date.parse(localIso || '');
  if (Number.isNaN(l)) return true;
  return r > l;
}

export function mergeWorklog(local: AppData, remote: RemoteDoc, localUpdatedAt: string | null = ''): AppData {
  const remoteNewer = isNewer(remote.updatedAt, localUpdatedAt);
  const winner: AppData = remoteNewer ? remote.data : local;
  const loser: AppData = remoteNewer ? local : remote.data;

  const records = new Map<string, WorkRecord>();
  for (const r of loser.records) records.set(r.id, r);
  for (const r of winner.records) records.set(r.id, r);

  const settings: Settings = Object.assign({}, winner.settings);
  const mealMap: Record<string, number> = Object.assign({}, loser.meals, winner.meals);
  const meals: Record<string, number> = {};
  for (const day of Object.keys(mealMap).sort()) meals[day] = mealMap[day];

  return {
    version: DATA_VERSION,
    settings,
    records: Array.from(records.values()).sort(byDateThenId),
    meals,
  };
}

function sameRecord(a: WorkRecord, b: WorkRecord): boolean {
  return a.date === b.date && a.hours === b.hours && a.rate === b.rate && a.note === b.note;
}

/**
 * 合并 + 风险摘要（纯函数）。
 * risk 只统计「本地版本会被远端覆盖」的部分 —— 那才是用户会感知到的丢数据。
 * 首次同步（localUpdatedAt 为空）时远端整份赢 settings 是既定行为，不算覆盖用户改动。
 */
export function planMerge(
  local: AppData,
  remote: RemoteDoc,
  localUpdatedAt: string | null = '',
  base: SyncBase | null = null
): { merged: AppData; risk: OverwriteRisk } {
  const merged = mergeWorklog(local, remote, localUpdatedAt);
  const risk: OverwriteRisk = { records: 0, meals: 0, settings: false };
  if (isNewer(remote.updatedAt, localUpdatedAt)) {
    const theirs = new Map(remote.data.records.map((r) => [r.id, r]));
    for (const mine of local.records) {
      const other = theirs.get(mine.id);
      if (!other || sameRecord(mine, other)) continue;
      // 有快照时，本地这条没被改过就不算「覆盖了用户的改动」，静默采用远端即可
      if (!base || base.records[mine.id] !== recordFingerprint(mine)) risk.records++;
    }
    for (const day of Object.keys(local.meals)) {
      const other = remote.data.meals[day];
      if (other === undefined || other === local.meals[day]) continue;
      if (!base || base.meals[day] !== local.meals[day]) risk.meals++;
    }
    if (localUpdatedAt) {
      const changed = JSON.stringify(remote.data.settings) !== JSON.stringify(local.settings);
      if (changed && (!base || base.settings !== JSON.stringify(local.settings))) risk.settings = true;
    }
  }
  return { merged, risk };
}

export function hasRisk(risk: OverwriteRisk): boolean {
  return risk.records > 0 || risk.meals > 0 || risk.settings;
}

function conflictMessage(risk: OverwriteRisk): string {
  const parts: string[] = [];
  if (risk.records > 0) parts.push(risk.records + ' 条工时');
  if (risk.meals > 0) parts.push(risk.meals + ' 天餐补');
  if (risk.settings) parts.push('计价设置');
  return '云端有新版本，合并会覆盖本地 ' + parts.join('、') + '，等你选保留哪边';
}

/* --------------------------------- 传输层 -------------------------------- */

export interface HttpResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    keepalive?: boolean;
    signal?: AbortSignal;
  }
) => Promise<HttpResponseLike>;

export type PullResult = { missing: true } | { missing: false; sha: string; doc: RemoteDoc; text: string };

export interface GitHubTransport {
  pull(): Promise<PullResult>;
  push(doc: RemoteDoc, sha: string | null, keepalive?: boolean): Promise<{ sha: string }>;
  probe(): Promise<{ fileExists: boolean; sha: string | null; updatedAt: string | null }>;
}

/** AbortSignal.timeout 在旧内核里可能没有，拿不到就退化成「不带超时」 */
function makeTimeoutSignal(ms: number): AbortSignal | undefined {
  try {
    return AbortSignal.timeout(ms);
  } catch {
    return undefined;
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function requireConfigured(cfg: SyncConfig): void {
  if (!isSyncConfigured(cfg)) throw new SyncError('disabled', '未配置云同步');
}

function encodePath(path: string): string {
  return path
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => encodeURIComponent(s))
    .join('/');
}

function statusError(status: number, op: 'read' | 'write'): SyncError {
  if (status === 401) return new SyncError('auth', 'PAT 无效或已过期', status);
  if (status === 403) return new SyncError('auth', 'PAT 权限不够，或被 GitHub 限流', status);
  if (status === 404) return new SyncError('notfound', '仓库或路径不存在，检查 owner / repo', status);
  if (status === 409 || status === 422) return new SyncError('conflict', '云端文件已被其他设备改过', status);
  return new SyncError('http', (op === 'read' ? '读取' : '写入') + '云端失败（HTTP ' + status + '）', status);
}

/**
 * GitHub Contents API 的最小封装。
 * 注意：`assert` 在方法第一行做配置校验 —— 没有 token 时连 fetch 都不会被调用。
 */
export function createGitHubTransport(
  cfg: SyncConfig,
  opts: { fetchImpl?: FetchLike; baseUrl?: string; timeoutMs?: number } = {}
): GitHubTransport {
  const baseUrl = opts.baseUrl || API_BASE;
  const timeoutMs = opts.timeoutMs ?? SYNC_TIMEOUT_MS;
  const doFetch: FetchLike = opts.fetchImpl || ((url, init) => fetch(url, init));
  const contentsUrl = baseUrl + '/repos/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo) + '/contents/' + encodePath(cfg.path);

  const headers = (withBody: boolean): Record<string, string> => {
    const h: Record<string, string> = {
      Authorization: 'Bearer ' + cfg.token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (withBody) h['Content-Type'] = 'application/json';
    return h;
  };

  const call = async (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string; keepalive?: boolean }
  ): Promise<HttpResponseLike> => {
    try {
      // 每次请求都挂超时：弱网下不能让请求永久悬挂把串行队列吊死（R3）
      return await doFetch(url, { ...init, signal: makeTimeoutSignal(timeoutMs) });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new SyncError('network', '请求超时（' + Math.round(timeoutMs / 1000) + ' 秒没响应），稍后会自动重试');
      }
      // 断网 / DNS 失败 / CORS：统一当「网络不通」，稍后自动重试
      throw new SyncError('network', '网络不通，稍后会自动重试');
    }
  };

  return {
    async pull(): Promise<PullResult> {
      requireConfigured(cfg);
      const res = await call(contentsUrl, { method: 'GET', headers: headers(false) });
      if (res.status === 404) {
        // 远端还没有这个文件：不是错误，下次推上去就是新建
        return { missing: true };
      }
      if (!res.ok) throw statusError(res.status, 'read');
      const body = asRecord(await res.json());
      const encoding = typeof body.encoding === 'string' ? body.encoding : 'base64';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (encoding !== 'base64' || typeof body.content !== 'string') {
        throw new SyncError('bad-data', '云端文件太大或格式不对，读不出来');
      }
      const text = decodeBase64Utf8(body.content);
      const doc = parseRemoteDoc(text);
      if (!doc) throw new SyncError('bad-data', '云端文件不是合法的工时数据，已保留本地数据');
      return { missing: false, sha, doc, text };
    },

    async push(doc: RemoteDoc, sha: string | null, keepalive = false): Promise<{ sha: string }> {
      requireConfigured(cfg);
      const payload: Record<string, string> = {
        message: 'worklog: 同步 ' + doc.updatedAt,
        content: encodeBase64Utf8(JSON.stringify(doc)),
      };
      if (sha) payload.sha = sha;
      const payloadJson = JSON.stringify(payload);
      // keepalive 的请求体有 64KB 上限，超了浏览器直接抛 TypeError；大文件就退回普通请求
      const useKeepalive = keepalive && payloadJson.length < 60000;
      const res = await call(contentsUrl, {
        method: 'PUT',
        headers: headers(true),
        body: payloadJson,
        keepalive: useKeepalive,
      });
      if (!res.ok) throw statusError(res.status, 'write');
      const body = asRecord(await res.json());
      const newSha = asRecord(body.content).sha;
      if (typeof newSha !== 'string' || !newSha) {
        throw new SyncError('bad-data', '云端没有返回文件版本号，稍后重试');
      }
      return { sha: newSha };
    },

    /** 「测试连接」专用：先确认仓库可访问，再看文件在不在。只在用户点按钮时调用 */
    async probe(): Promise<{ fileExists: boolean; sha: string | null; updatedAt: string | null }> {
      requireConfigured(cfg);
      const repoUrl = baseUrl + '/repos/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo);
      const repoRes = await call(repoUrl, { method: 'GET', headers: headers(false) });
      if (!repoRes.ok) {
        if (repoRes.status === 404) throw new SyncError('notfound', '找不到这个仓库（名字不对，或 PAT 没给它权限）', 404);
        throw statusError(repoRes.status, 'read');
      }
      const res = await call(contentsUrl, { method: 'GET', headers: headers(false) });
      if (res.status === 404) return { fileExists: false, sha: null, updatedAt: null };
      if (!res.ok) throw statusError(res.status, 'read');
      const body = asRecord(await res.json());
      const sha = typeof body.sha === 'string' ? body.sha : null;
      let updatedAt: string | null = null;
      if (typeof body.content === 'string') {
        const doc = parseRemoteDoc(decodeBase64Utf8(body.content));
        updatedAt = doc ? doc.updatedAt : null;
      }
      return { fileExists: true, sha, updatedAt };
    },
  };
}

/* -------------------------------- 同步控制器 ------------------------------- */

export type TimerHandle = unknown;

export interface SyncControllerDeps {
  /** 不传则用浏览器 localStorage；测试可传假实现 */
  kv?: SyncKV | null;
  fetchImpl?: FetchLike;
  baseUrl?: string;
  /** 返回 ISO 时间串，测试可固定 */
  now?: () => string;
  debounceMs?: number;
  /** 单次请求超时（毫秒），默认 15 秒；测试可调小 */
  timeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  /** 读当前本地数据（始终读最新，不要闭包快照） */
  getData: () => AppData;
  /** 拉取后把合并结果写回本地 */
  applyRemote: (data: AppData) => void;
  onStatus?: (status: SyncStatus) => void;
  onNotice?: (text: string, kind: 'ok' | 'warn') => void;
}

export interface SyncController {
  /** 打开页面时调用：拉远端、合并、必要时补推 */
  start(): Promise<void>;
  /** 数据变了：防抖后推送；没有实质变化（含刚被远端合并覆盖）则什么都不做 */
  schedule(data: AppData): void;
  /** 立刻推（pagehide / 隐藏 / 手动同步）；失败会把这次变更留在待推里。
   *  keepalive: true 用于 pagehide —— 页面销毁后请求仍能发完（普通 fetch 会被掐断） */
  flush(opts?: { keepalive?: boolean }): Promise<void>;
  /** 「立即同步」：拉一次 + 把当前数据推上去 */
  syncNow(): Promise<void>;
  /** 有覆盖风险、等用户选边时返回风险摘要，否则 null */
  conflict(): OverwriteRisk | null;
  /** 用户拍板：'remote' 用云端覆盖本地；'local' 用本地覆盖云端（都只影响冲突的那部分） */
  resolveConflict(choice: 'remote' | 'local'): Promise<void>;
  /** 换仓库 / 断开同步时丢掉内存里的冲突快照，避免拿旧仓库的数据去合新仓库 */
  dropConflict(): void;
  testConnection(): Promise<{ ok: boolean; message: string }>;
  status(): SyncStatus;
  stop(): void;
}

/** 值不值得自动重试：网络抖动 / 服务端 5xx 值得，鉴权、路径、坏文件不值得 */
function isRetryable(err: SyncError): boolean {
  return err.code === 'network' || err.code === 'http';
}

function toSyncError(err: unknown): SyncError {
  if (err instanceof SyncError) return err;
  return new SyncError('network', '网络不通，稍后会自动重试');
}

export function createSyncController(deps: SyncControllerDeps): SyncController {
  const kv = deps.kv === undefined ? defaultKV() : deps.kv;
  const now = deps.now || (() => new Date().toISOString());
  const debounceMs = deps.debounceMs ?? SYNC_DEBOUNCE_MS;
  const setTimer =
    deps.setTimer ||
    ((fn, ms) => {
      const t = setTimeout(fn, ms);
      // Node（vitest）里别让退避定时器拖住进程退出；浏览器里 setTimeout 返回数字，这里会跳过
      const maybe = t as unknown as { unref?: () => void };
      if (typeof maybe.unref === 'function') maybe.unref();
      return t;
    });
  const clearTimer = deps.clearTimer || ((h) => clearTimeout(h as Parameters<typeof clearTimeout>[0]));

  let active = true;
  let timer: TimerHandle | null = null;
  /**
   * 最近一次「已与云端一致」的数据 JSON，用来判断有没有实质变化。
   * 创建时就定基线（而不是等 start 回来），否则首次拉取途中记的那条会被当成基线吞掉。
   */
  let knownJson: string = JSON.stringify(deps.getData());
  let pending: { json: string; data: AppData } | null = null;
  /** 云端此刻的内容（最后一次成功拉/推的 JSON），用来挡掉「内容没变还推」的重复 commit */
  let syncedJson: string | null = null;
  let lastFailKey = '';
  let status: SyncStatus = { state: 'off', at: null, message: '未开启云同步' };
  let chain: Promise<unknown> = Promise.resolve();
  /** 有覆盖风险时挂在这里，等用户选完再动数据 */
  let conflict: { local: AppData; remote: RemoteDoc; merged: AppData; risk: OverwriteRisk; sha: string } | null = null;
  let retryTimer: TimerHandle | null = null;
  let failCount = 0;

  const emit = (state: SyncState, message: string, risk: OverwriteRisk | null = null): void => {
    if (!active) return;
    // off / syncing 这类「过程态」重复广播没意义（关着同步时每次按键都会走到这里）
    if ((state === 'off' || state === 'syncing') && status.state === state && status.message === message) return;
    const at = state === 'synced' || state === 'unsynced' ? Date.now() : status.at;
    status = { state, at, message, risk };
    deps.onStatus && deps.onStatus(status);
  };

  /** 成功：清失败计数与退避定时器 */
  const succeed = (message: string): void => {
    failCount = 0;
    clearRetry();
    lastFailKey = '';
    emit('synced', message);
  };

  const notice = (text: string, kind: 'ok' | 'warn', key: string): void => {
    if (!active) return;
    if (kind === 'warn' && key === lastFailKey) return;
    lastFailKey = key;
    deps.onNotice && deps.onNotice(text, kind);
  };

  const readCfg = (): SyncConfig => loadSyncConfig(kv);
  const writeCfg = (cfg: SyncConfig): void => saveSyncConfig(cfg, kv);
  /**
   * 只写回元数据（sha / 基线），不碰 token、owner、repo、path。
   * 请求在路上时用户可能刚清掉配置或换了仓库，整份回写会把旧 token 复活。
   */
  const patchMeta = (patch: Partial<Pick<SyncConfig, 'lastSha' | 'baseUpdatedAt'>>): void => {
    const cur = readCfg();
    if (!isSyncConfigured(cur)) return; // 已经断开：不再往 localStorage 里写任何元数据
    writeCfg({ ...cur, ...patch });
  };

  /** 同步成功（拉或推）：记下 sha / 基线，顺手更新「上次同步快照」，供下次判假阳性冲突 */
  const markSynced = (data: AppData, sha: string | null, baseUpdatedAt: string | null): void => {
    const cur = readCfg();
    if (!isSyncConfigured(cur)) return;
    writeCfg({ ...cur, lastSha: sha, baseUpdatedAt, base: buildBase(data) });
  };

  /** 串行执行：避免两次推送拿着同一个 sha 撞车。错误照常抛给调用方，队列本身不卡住 */
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  const clear = (): void => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  const armTimer = (): void => {
    clear();
    timer = setTimer(() => {
      timer = null;
      void flushNow();
    }, debounceMs);
  };

  function clearRetry(): void {
    if (retryTimer !== null) {
      clearTimer(retryTimer);
      retryTimer = null;
    }
  }

  /** 失败后指数退避：30s → 60s → 120s … 封顶 5 分钟（R4，网络自己恢复也能补上） */
  function armRetry(): void {
    clearRetry();
    if (!active) return;
    const delay = Math.min(RETRY_BASE_MS * Math.pow(2, Math.max(0, failCount - 1)), RETRY_MAX_MS);
    retryTimer = setTimer(() => {
      retryTimer = null;
      void retryNow();
    }, delay);
  }

  async function retryNow(): Promise<void> {
    if (!active || conflict) return;
    try {
      // pullOnce 里已经包含「本地有远端没有 → 补推」，不用再 flush（否则一次重试算两次失败）
      await enqueue(pullOnce);
    } catch (err) {
      fail(toSyncError(err), null);
    }
  }

  const fail = (err: SyncError, job: { json: string; data: AppData } | null): void => {
    // 失败：这次变更留在待推里，下次 flush / 打开页面继续补推
    if (job && !pending) pending = job;
    // R-D：只有「可能一会儿就好」的错误才做指数退避。401/403/404/坏文件重试也没用，
    // 反复撞 API 反而吃限流；这类错误只提示，等下次编辑 / 手动同步 / 重开页面再试。
    if (isRetryable(err)) {
      failCount++;
      armRetry();
    } else {
      failCount = 0;
      clearRetry();
    }
    emit('unsynced', err.message);
    notice('云同步失败：' + err.message, 'warn', err.code + ':' + String(err.status || ''));
  };

  /**
   * 推送一次；409/422 冲突时重新拉 → 合并 → 只重试一次。
   * 不传 data 就推「当前本地」：防抖排期到真正发出之间用户可能又记了东西。
   */
  async function push(override?: AppData, keepalive = false, preferLocal = false): Promise<void> {
    if (!active) return;
    if (conflict) return; // 等用户选边，谁也别抢跑
    const data = override || deps.getData();
    const cfg = readCfg();
    if (!isSyncConfigured(cfg)) {
      emit('off', '未开启云同步');
      return;
    }
    const baseUpdatedAt = cfg.baseUpdatedAt;
    const transport = createGitHubTransport(cfg, {
      fetchImpl: deps.fetchImpl,
      baseUrl: deps.baseUrl,
      timeoutMs: deps.timeoutMs,
    });
    const doc = buildRemoteDoc(data, now());

    try {
      const res = await transport.push(doc, cfg.lastSha, keepalive);
      markSynced(data, res.sha, doc.updatedAt);
      knownJson = JSON.stringify(data);
      syncedJson = knownJson;
      succeed('已同步');
      return;
    } catch (err) {
      const e = toSyncError(err);
      if (e.code !== 'conflict') {
        fail(e, { json: JSON.stringify(data), data });
        return;
      }
    }

    // 冲突：跑在这里说明云端比我们手里的 sha 新
    emit('syncing', '云端有新版本，正在合并…');
    try {
      const fresh = await transport.pull();
      const current = deps.getData();
      if (fresh.missing) {
        // 文件被删了：当成新建，不要带 sha
        const retryDoc = buildRemoteDoc(current, now());
        const res = await transport.push(retryDoc, null, keepalive);
        markSynced(current, res.sha, retryDoc.updatedAt);
        knownJson = JSON.stringify(current);
        syncedJson = knownJson;
        succeed('已同步');
        return;
      }
      if (!preferLocal) {
        // 409 这条路也能静默覆盖本地（跨设备时比启动拉取更常见）：
        // 重新拉到的远端如果会抹掉本地改动，同样停下来等用户选
        const retryPlan = planMerge(current, fresh.doc, baseUpdatedAt, readCfg().base);
        const retryMergedJson = JSON.stringify(retryPlan.merged);
        if (hasRisk(retryPlan.risk) && retryMergedJson !== JSON.stringify(current)) {
          conflict = { local: current, remote: fresh.doc, merged: retryPlan.merged, risk: retryPlan.risk, sha: fresh.sha };
          emit('conflict', conflictMessage(retryPlan.risk), retryPlan.risk);
          notice('云端有更新版本，已暂停同步等你确认', 'warn', 'conflict:' + fresh.sha);
          return;
        }
      }
      // preferLocal：用户在「用本地版本」拍过板，冲突重试时也别让远端再赢一次
      const merged = mergeWorklog(current, fresh.doc, preferLocal ? fresh.doc.updatedAt : baseUpdatedAt);
      const retryDoc = buildRemoteDoc(merged, now());
      const res = await transport.push(retryDoc, fresh.sha, keepalive);
      patchMeta({ lastSha: res.sha, baseUpdatedAt: retryDoc.updatedAt });
      knownJson = JSON.stringify(merged);
      const latest = deps.getData();
      if (JSON.stringify(latest) !== knownJson) {
        // 重试请求在路上时用户可能又记了一条：回写前再并一次最新本地，
        // 否则 applyRemote(merged) 会把这条新记录从界面上抹掉（远端也还没收到）
        const after = mergeWorklog(
          latest,
          { schema: SYNC_SCHEMA, updatedAt: retryDoc.updatedAt, data: merged },
          retryDoc.updatedAt
        );
        deps.applyRemote(after);
      }
      succeed('已与云端合并后同步');
      notice('云端数据更新过，已合并两边记录', 'ok', '');
    } catch (err) {
      const latest = deps.getData();
      fail(toSyncError(err), { json: JSON.stringify(latest), data: latest });
    }
  }

  async function flushNow(keepalive = false): Promise<void> {
    if (!active) return;
    if (conflict) return; // 等用户选边，别拿本地覆盖云端
    clear();
    const job = pending;
    pending = null;
    if (!job) return;
    const cfg = readCfg();
    if (!isSyncConfigured(cfg)) {
      emit('off', '未开启云同步');
      return;
    }
    if (syncedJson !== null && JSON.stringify(deps.getData()) === syncedJson) {
      // 云端已经是这份内容（比如刚在冲突裁决里推过），别再产生一个空 commit
      succeed('已同步');
      return;
    }
    await enqueue(() => push(undefined, keepalive));
  }

  async function pullOnce(): Promise<void> {
    if (!active) return;
    const cfg = readCfg();
    if (!isSyncConfigured(cfg)) {
      emit('off', '未开启云同步');
      return;
    }
    const transport = createGitHubTransport(cfg, {
      fetchImpl: deps.fetchImpl,
      baseUrl: deps.baseUrl,
      timeoutMs: deps.timeoutMs,
    });
    emit('syncing', '正在读取云端…');
    const res = await transport.pull();

    if (res.missing) {
      // 第一次用：远端还没有文件，把本地推上去（含历史数据）
      patchMeta({ lastSha: null, baseUpdatedAt: null });
      knownJson = JSON.stringify(deps.getData());
      pending = null; // 待推快照已经在这份数据里了
      // 这里已经在队列里了，直接调；再 enqueue 会自己等自己
      await push();
      return;
    }

    const local = deps.getData();
    const plan = planMerge(local, res.doc, cfg.baseUpdatedAt, cfg.base);
    const merged = plan.merged;
    const mergedJson = JSON.stringify(merged);
    const remoteJson = JSON.stringify(res.doc.data);
    const localJson = JSON.stringify(local);

    if (hasRisk(plan.risk) && mergedJson !== localJson) {
      // §3.1「若远端版本比本地基线新，先提示再覆盖，不静默丢弃」：
      // 这里既不写回也不推送，lastSha 也不动 —— 下次打开会重新识别同一个冲突
      conflict = { local, remote: res.doc, merged, risk: plan.risk, sha: res.sha };
      emit('conflict', conflictMessage(plan.risk), plan.risk);
      // toast 只是提示一眼，真正拦住覆盖的是上面这个常驻状态（toast 2.6 秒就没了）
      notice('云端有更新版本，已暂停同步等你确认', 'warn', 'conflict:' + res.sha);
      return;
    }

    markSynced(merged, res.sha, res.doc.updatedAt || cfg.baseUpdatedAt);
    knownJson = mergedJson;
    // 拉取期间用户可能又记了一条：merged 是刚读的快照，已经包含它，
    // 旧的待推快照留着会在 8 秒后把远端覆盖掉（远端独有的记录就没了）
    pending = null;

    if (mergedJson !== localJson) {
      // 这次合并带来了本地没有的东西（远端更新或被外部改过）→ 先落本地，丢掉就等于丢数据
      deps.applyRemote(merged);
      notice('已从云端合并 ' + (merged.records.length - local.records.length > 0 ? '并新增记录' : '数据'), 'ok', '');
    }
    if (mergedJson !== remoteJson) {
      // 本地有远端没有的记录 → 补推一次，别让另一台设备看不到
      const job = { json: mergedJson, data: merged };
      pending = job;
      await push(merged);
      // 推成功就清掉；万一期间又来了新改动（pending 已被替换），保留新的
      if (pending === job) pending = null;
    } else {
      syncedJson = remoteJson; // 云端就是最新，本地也一致，没有可推的
      succeed('已同步');
    }
  }

  return {
    status: () => status,

    async start(): Promise<void> {
      const cfg = readCfg();
      if (!isSyncConfigured(cfg)) {
        knownJson = JSON.stringify(deps.getData());
        emit('off', '未开启云同步');
        return;
      }
      try {
        await enqueue(pullOnce);
      } catch (err) {
        fail(toSyncError(err), null);
      }
    },

    schedule(data: AppData): void {
      const json = JSON.stringify(data);
      if (!isSyncConfigured(readCfg())) {
        knownJson = json;
        emit('off', '未开启云同步');
        return;
      }
      if (conflict) return; // 冲突未决期间只记本地，不推
      if (json === knownJson) return;
      pending = { json, data };
      armTimer();
    },

    async flush(opts?: { keepalive?: boolean }): Promise<void> {
      try {
        await flushNow(Boolean(opts && opts.keepalive));
      } catch (err) {
        // pagehide 里是 fire-and-forget，这里兜住，别让异常漏到控制台
        fail(toSyncError(err), null);
      }
    },

    async syncNow(): Promise<void> {
      if (conflict) {
        emit('conflict', conflictMessage(conflict.risk), conflict.risk);
        return;
      }
      const cfg = readCfg();
      if (!isSyncConfigured(cfg)) {
        emit('off', '未开启云同步');
        return;
      }
      try {
        await enqueue(pullOnce);
        // 注意：applyRemote 走到 React 里是异步的，这里 deps.getData() 可能还是合并前的旧快照。
        // 拿它强推会覆盖掉刚合并进来的远端记录 —— 所以只补 pending（pullOnce 自己已经推过合并结果）。
        await flushNow();
      } catch (err) {
        fail(toSyncError(err), null);
      }
    },

    conflict(): OverwriteRisk | null {
      return conflict ? conflict.risk : null;
    },

    dropConflict(): void {
      if (!conflict) return;
      conflict = null;
      if (status.state === 'conflict') emit('idle', '等待同步');
    },

    async resolveConflict(choice: 'remote' | 'local'): Promise<void> {
      const c = conflict;
      if (!c) return;
      conflict = null;
      const cfg = readCfg();
      if (!isSyncConfigured(cfg)) {
        emit('off', '未开启云同步');
        return;
      }
      try {
        const current = deps.getData();
        // remote：基线给空 → 远端赢；local：基线给远端那版 → 本地赢。
        // 两边都只影响「同一条记录/同一天」的冲突，只在一侧存在的记录一律保留。
        const target = mergeWorklog(current, c.remote, choice === 'remote' ? '' : c.remote.updatedAt);
        const targetJson = JSON.stringify(target);
        const remoteJson = JSON.stringify(c.remote.data);
        pending = null;
        if (JSON.stringify(current) !== targetJson) deps.applyRemote(target);
        if (targetJson === remoteJson) {
          // 选云端且合并结果就等于远端：不用回写
          knownJson = remoteJson;
          syncedJson = remoteJson;
          markSynced(target, c.sha, c.remote.updatedAt);
          succeed('已采用云端版本');
          return;
        }
        knownJson = remoteJson; // 云端还是旧内容，推成功后 push 会更新
        // 先认下刚看到的远端版本，推的时候带上它的 sha，避免拿过期 sha 白撞一次 409
        patchMeta({ lastSha: c.sha, baseUpdatedAt: c.remote.updatedAt });
        await enqueue(() => push(target, false, choice === 'local'));
      } catch (err) {
        fail(toSyncError(err), null);
      }
    },

    async testConnection(): Promise<{ ok: boolean; message: string }> {
      const cfg = readCfg();
      if (!isSyncConfigured(cfg)) return { ok: false, message: '先填 PAT、owner 和 repo' };
      const transport = createGitHubTransport(cfg, {
        fetchImpl: deps.fetchImpl,
        baseUrl: deps.baseUrl,
        timeoutMs: deps.timeoutMs,
      });
      try {
        const probe = await transport.probe();
        if (!probe.fileExists) {
          return { ok: true, message: '连接成功：仓库能访问，' + cfg.path + ' 还不存在，首次同步会创建' };
        }
        return {
          ok: true,
          message: '连接成功：云端已有 ' + cfg.path + (probe.updatedAt ? '（更新于 ' + probe.updatedAt + '）' : ''),
        };
      } catch (err) {
        return { ok: false, message: toSyncError(err).message };
      }
    },

    stop(): void {
      active = false;
      clear();
      clearRetry();
      conflict = null;
    },
  };
}
