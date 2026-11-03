/**
 * 整页启动装配层（不是控制器层）：
 * A002-1 的字面要求是「未配置 PAT 时不得发起任何网络请求」，所以这里把 store 启动时
 * 真正会跑的两件事（seed 预置 + 云同步启动）放在一起断言 fetch 次数。
 *
 * 说明：项目没装 jsdom/@testing-library（PROJECT_RULES 只允许 vitest 一个 devDependency），
 * 跑不了真实 React 挂载；runStartup 就是 store 里那个 effect 的全部内容，改它等于改装配。
 */

import { describe, expect, it } from 'vitest';
import { defaultSettings, type AppData } from '../types';
import { createSyncController, type FetchLike, type SyncKV } from './sync';
import { runStartup } from './startup';

function makeData(): AppData {
  return { version: 1, settings: defaultSettings(), records: [], meals: {} };
}

const emptyKV: SyncKV = {
  getItem: () => null,
  setItem: () => undefined,
};

describe('整页启动装配', () => {
  it('未配置 PAT、非 DEV：seed 与云同步都不发请求（A002-1 字面口径）', async () => {
    const netCalls: string[] = [];
    const net: FetchLike = async (url) => {
      netCalls.push(url);
      throw new Error('未配置云同步时不该发请求');
    };
    const ctrl = createSyncController({
      kv: emptyKV,
      fetchImpl: net,
      getData: () => makeData(),
      applyRemote: () => undefined,
    });

    let seedRequests = 0;
    await runStartup({
      dev: false,
      seedUrl: '/seed.json',
      fetchSeed: async () => {
        seedRequests++;
        return { ok: false, status: 404, json: async () => null };
      },
      readSeedVersion: () => 0,
      writeSeedVersion: () => undefined,
      importSeed: () => undefined,
      notify: () => undefined,
      startSync: () => ctrl.start(),
    });

    expect(seedRequests).toBe(0);
    expect(netCalls).toHaveLength(0);
  });

  it('DEV 下才拉 seed.json：拉到就导入、记版本、提示条数', async () => {
    const seedData = makeData();
    seedData.records = [{ id: 'seed-1', date: '2026-01-02', hours: 8, rate: null, note: '' }];

    const imported: AppData[] = [];
    const versions: number[] = [];
    const notices: string[] = [];
    let started = 0;

    await runStartup({
      dev: true,
      seedUrl: '/seed.json',
      fetchSeed: async () => ({ ok: true, status: 200, json: async () => ({ seedVersion: 3, data: seedData }) }),
      readSeedVersion: () => 0,
      writeSeedVersion: (v) => versions.push(v),
      importSeed: (d) => imported.push(d),
      notify: (t) => notices.push(t),
      startSync: async () => {
        started++;
      },
    });

    expect(imported).toHaveLength(1);
    expect(imported[0].records[0].id).toBe('seed-1');
    expect(versions).toEqual([3]);
    expect(notices[0]).toContain('1 条');
    expect(started).toBe(1);
  });

  it('已经导过同一版本的 seed 不再重复导入', async () => {
    const imported: AppData[] = [];
    await runStartup({
      dev: true,
      seedUrl: '/seed.json',
      fetchSeed: async () => ({ ok: true, status: 200, json: async () => ({ seedVersion: 2, data: makeData() }) }),
      readSeedVersion: () => 2,
      writeSeedVersion: () => undefined,
      importSeed: (d) => imported.push(d),
      notify: () => undefined,
      startSync: async () => undefined,
    });
    expect(imported).toHaveLength(0);
  });

  it('seed.json 不存在（生产 404）时静默跳过，不影响云同步启动', async () => {
    let started = 0;
    await runStartup({
      dev: true,
      seedUrl: '/seed.json',
      fetchSeed: async () => ({ ok: false, status: 404, json: async () => null }),
      readSeedVersion: () => 0,
      writeSeedVersion: () => undefined,
      importSeed: () => undefined,
      notify: () => undefined,
      startSync: async () => {
        started++;
      },
    });
    expect(started).toBe(1);
  });
});
