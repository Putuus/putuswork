/**
 * 整页启动：seed 历史数据预置 + 云同步启动。
 *
 * 为什么单独抽出来：A002-1 要求「未配置 PAT 时不得发起任何网络请求」，这条只能在整个启动
 * 装配上验证；而项目只允许 vitest 一个 devDependency（没有 jsdom），跑不了真实 React 挂载，
 * 所以 store 里那个 effect 的全部内容就是这个函数，测试直接打这里。
 *
 * seed.json 只存在于开发环境（.gitignore 排除了 public/seed.json，生产是 404），
 * 所以只有 `dev === true` 时才去拉，生产构建一次请求都不发。
 */

import type { AppData } from '../types';

export interface SeedFile {
  seedVersion?: number;
  data?: AppData;
}

export interface SeedResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export interface StartupDeps {
  /** 生产构建里没有 seed.json，只有开发环境才预置历史数据 */
  dev: boolean;
  seedUrl: string;
  fetchSeed: (url: string) => Promise<SeedResponseLike>;
  /** 本地已经导入过的 seed 版本号 */
  readSeedVersion: () => number;
  writeSeedVersion: (version: number) => void;
  /** 把 seed 数据并进本地（保持原有「按 date|hours|note 去重」的语义） */
  importSeed: (data: AppData) => void;
  notify: (text: string) => void;
  /** 启动云同步（未配置时控制器内部直接返回，不发请求） */
  startSync: () => Promise<void>;
}

export async function runStartup(deps: StartupDeps): Promise<void> {
  if (deps.dev) await preloadSeed(deps);
  await deps.startSync();
}

async function preloadSeed(deps: StartupDeps): Promise<void> {
  try {
    const res = await deps.fetchSeed(deps.seedUrl);
    if (!res.ok) return;
    const raw = (await res.json()) as SeedFile | null;
    const data = raw && raw.data;
    if (!data) return;
    const version = Number(raw.seedVersion || 1);
    // 导过的版本不重复导
    if (deps.readSeedVersion() >= version) return;
    deps.importSeed(data);
    deps.writeSeedVersion(version);
    const count = (data.records && data.records.length) || 0;
    deps.notify('已自动导入历史工时 ' + count + ' 条');
  } catch {
    /* 没有 seed.json 或格式不对：静默跳过，不影响启动 */
  }
}
