/**
 * LOCKED — 调整需经 rot 批准
 *
 * 云同步的判定基线（PROJECT_RULES §4 A002）：
 *   1. 未配置 PAT 时：不发起任何网络请求
 *   2. 远端被外部改过 / sha 冲突：重新拉 → 合并 → 只重试一次，不丢数据
 *   3. mergeWorklog 为纯函数，固定输入输出（含中文 UTF-8 base64 往返）
 *
 * 改这里的断言 = 改验收标准，必须先经 rot 批准（见 PROJECT_RULES「测试锁定规则」）。
 */

import { describe, expect, it } from 'vitest';
import { defaultSettings, type AppData, type Settings, type WorkRecord } from '../types';
import {
  SYNC_DEBOUNCE_MS,
  buildRemoteDoc,
  createGitHubTransport,
  createSyncController,
  decodeBase64Utf8,
  defaultSyncConfig,
  encodeBase64Utf8,
  isSyncConfigured,
  loadSyncConfig,
  mergeWorklog,
  type FetchLike,
  type RemoteDoc,
  type SyncConfig,
  type SyncKV,
} from './sync';

/* --------------------------------- 测试工具 -------------------------------- */

const TOKEN = 'github_pat_UNIT_TEST_ONLY';
const T0 = '2026-11-03T08:00:00.000Z';
const T1 = '2026-11-03T09:00:00.000Z';
const T2 = '2026-11-03T10:00:00.000Z';

function rec(id: string, date: string, hours: number, note = ''): WorkRecord {
  return { id, date, hours, rate: null, note };
}

function makeData(
  patch: { settings?: Partial<Settings>; records?: WorkRecord[]; meals?: Record<string, number> } = {}
): AppData {
  return {
    version: 1,
    settings: Object.assign({}, defaultSettings(), patch.settings || {}),
    records: patch.records || [],
    meals: patch.meals || {},
  };
}

function configured(over: Partial<SyncConfig> = {}): SyncConfig {
  return Object.assign({}, defaultSyncConfig(), {
    token: TOKEN,
    owner: 'Putuus',
    repo: 'putuswork-data',
    path: 'worklog.json',
    ...over,
  });
}

/** 假 localStorage：只认 worklog:sync 一个键，够用 */
function makeKV(initial: Partial<SyncConfig> | null): SyncKV & { read(): SyncConfig } {
  const map = new Map<string, string>();
  if (initial) map.set('worklog:sync', JSON.stringify(Object.assign({}, defaultSyncConfig(), initial)));
  return {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => {
      map.set(k, v);
    },
    read: () => loadSyncConfig({
      getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
      setItem: (k, v) => {
        map.set(k, v);
      },
    }),
  };
}

type Reply = { status: number; body?: unknown } | { throws: true };

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** 按脚本顺序回复的假 fetch；脚本用光后再被调用就抛错（顺便证明没有多余请求） */
function scriptedFetch(replies: Reply[]): { impl: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const queue = replies.slice();
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const reply = queue.shift();
    if (!reply) throw new Error('意外的请求：' + init.method + ' ' + url);
    if ('throws' in reply) throw new TypeError('fetch failed');
    const status = reply.status;
    const body = reply.body === undefined ? {} : reply.body;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
      json: async () => body,
    };
  };
  return { impl, calls };
}

/** GitHub 返回的 base64 每 76 字符换行；照抄这个细节，才能测到解码前的去空白 */
function wrap76(b64: string): string {
  return b64.replace(/(.{76})/g, '$1\n') + '\n';
}

function contentsReply(doc: RemoteDoc, sha: string, status = 200): Reply {
  return {
    status,
    body: { sha, encoding: 'base64', content: wrap76(encodeBase64Utf8(JSON.stringify(doc))) },
  };
}

function putReply(sha: string): Reply {
  return { status: 200, body: { content: { sha }, commit: { sha: 'commit_' + sha } } };
}

/** 解出 PUT 请求体里的远端文档，用来断言「推上去的到底是什么」 */
function pushedDoc(call: RecordedCall): RemoteDoc {
  const payload = JSON.parse(String(call.body)) as { content: string; sha?: string };
  return JSON.parse(decodeBase64Utf8(payload.content)) as RemoteDoc;
}

function pushedSha(call: RecordedCall): string | undefined {
  return (JSON.parse(String(call.body)) as { sha?: string }).sha;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/* ------------------------- A002-1：未配置不发任何请求 ------------------------- */

describe('A002-1 未配置 PAT 时零网络请求', () => {
  it('控制器在空配置下 start / schedule / flush / syncNow / 测试连接 都不发请求', async () => {
    const kv = makeKV(null);
    const net = scriptedFetch([]);
    let applied = 0;
    const ctrl = createSyncController({
      kv,
      fetchImpl: net.impl,
      getData: () => makeData({ records: [rec('a', '2026-11-01', 8)] }),
      applyRemote: () => {
        applied++;
      },
    });

    await ctrl.start();
    ctrl.schedule(makeData({ records: [rec('b', '2026-11-02', 4)] }));
    await ctrl.flush();
    await ctrl.syncNow();
    const probe = await ctrl.testConnection();

    expect(net.calls).toHaveLength(0);
    expect(applied).toBe(0);
    expect(ctrl.status().state).toBe('off');
    expect(probe.ok).toBe(false);
  });

  it('只填 owner/repo 但没 token 也算未配置', async () => {
    const kv = makeKV({ token: '', owner: 'Putuus', repo: 'putuswork-data', path: 'worklog.json' });
    const net = scriptedFetch([]);
    const ctrl = createSyncController({
      kv,
      fetchImpl: net.impl,
      getData: () => makeData(),
      applyRemote: () => undefined,
    });
    await ctrl.start();
    await ctrl.syncNow();
    expect(isSyncConfigured(loadSyncConfig(kv))).toBe(false);
    expect(net.calls).toHaveLength(0);
  });

  it('传输层自己也拦一道：未配置时 pull/push 直接抛 disabled，不碰 fetch', async () => {
    const net = scriptedFetch([]);
    const transport = createGitHubTransport(defaultSyncConfig(), { fetchImpl: net.impl });
    await expect(transport.pull()).rejects.toMatchObject({ code: 'disabled' });
    await expect(transport.push(buildRemoteDoc(makeData(), T1), null)).rejects.toMatchObject({ code: 'disabled' });
    expect(net.calls).toHaveLength(0);
  });
});

/* -------------------- A002-5：mergeWorklog 纯函数固定输入输出 -------------------- */

describe('A002-5 mergeWorklog 纯函数', () => {
  const local = makeData({
    settings: { hourlyRate: 33.5 },
    records: [rec('a', '2026-11-01', 8, '上午'), rec('b', '2026-11-02', 4)],
    meals: { '2026-11-01': 15, '2026-11-02': 20 },
  });
  const remote: RemoteDoc = {
    schema: 1,
    updatedAt: T2,
    data: makeData({
      settings: { hourlyRate: 40 },
      records: [rec('a', '2026-11-01', 9, '改过'), rec('c', '2026-11-03', 6)],
      meals: { '2026-11-01': 25, '2026-11-03': 15 },
    }),
  };

  it('远端更新：同 id 取远端版本，只在一侧的记录都保留，meals 取较新，settings 整份取较新', () => {
    const before = JSON.stringify({ local, remote });
    const merged = mergeWorklog(local, remote, T1);

    expect(merged.records).toEqual([
      rec('a', '2026-11-01', 9, '改过'), // 同 id，远端文档更新 → 远端赢
      rec('b', '2026-11-02', 4), // 本地独有 → 保留
      rec('c', '2026-11-03', 6), // 远端独有 → 保留
    ]);
    expect(merged.meals).toEqual({ '2026-11-01': 25, '2026-11-02': 20, '2026-11-03': 15 });
    expect(merged.settings.hourlyRate).toBe(40);
    expect(merged.version).toBe(1);

    // 纯函数：不许改输入
    expect(JSON.stringify({ local, remote })).toBe(before);
  });

  it('本地更新：同 id 取本地版本，但远端独有的记录仍然保留（不静默丢数据）', () => {
    const merged = mergeWorklog(local, remote, T2);
    expect(merged.records).toEqual([
      rec('a', '2026-11-01', 8, '上午'),
      rec('b', '2026-11-02', 4),
      rec('c', '2026-11-03', 6),
    ]);
    expect(merged.meals).toEqual({ '2026-11-01': 15, '2026-11-02': 20, '2026-11-03': 15 });
    expect(merged.settings.hourlyRate).toBe(33.5);
  });

  it('不传本地基线时按「远端较新」处理（两参调用也能用）', () => {
    const merged = mergeWorklog(local, remote);
    expect(merged.records[0]).toEqual(rec('a', '2026-11-01', 9, '改过'));
  });

  it('同一份数据反复合并结果稳定（幂等）', () => {
    const once = mergeWorklog(local, remote, T1);
    // 拿同一份远端再合一次，结果必须还是它（键序 / 排序都不能抖）
    expect(mergeWorklog(once, remote, T1)).toEqual(once);
    expect(JSON.stringify(mergeWorklog(once, remote, T1))).toBe(JSON.stringify(once));
  });

  it('远端 updatedAt 读不懂时不认它更新：本地设置不被坏文件冲掉，但远端记录照样并进来', () => {
    const odd = { ...remote, updatedAt: 'not-a-timestamp' };
    const merged = mergeWorklog(local, odd, T1);
    expect(merged.settings.hourlyRate).toBe(33.5); // 本地赢
    expect(merged.records.map((r) => r.id)).toEqual(['a', 'b', 'c']); // 记录仍是并集，不丢
  });

  it('中文 UTF-8 base64 往返一致，76 字符换行不影响解码', () => {
    const text = '工时记录 · 餐补 ¥15\n第二行 ☕ emoji 😀';
    expect(decodeBase64Utf8(encodeBase64Utf8(text))).toBe(text);

    const long = '工时-中文-'.repeat(5000); // 超过单次 fromCharCode 的舒适区，验证分段拼接
    const encoded = encodeBase64Utf8(long);
    expect(decodeBase64Utf8(wrap76(encoded))).toBe(long);
  });
});

/* ------------------- A002-4：远端被外部改过 / sha 冲突处理 ------------------- */

describe('A002-4 远端更新与 sha 冲突', () => {
  it('打开页面先拉远端：外部新增的记录合并进本地，不被本地覆盖', async () => {
    let local = makeData({ records: [rec('a', '2026-11-01', 8)] });
    const applied: AppData[] = [];
    const kv = makeKV(configured({ lastSha: 'sha0', baseUpdatedAt: T0 }));
    const remoteDoc: RemoteDoc = {
      schema: 1,
      updatedAt: T2,
      data: makeData({ records: [rec('a', '2026-11-01', 8), rec('b', '2026-11-02', 6)] }),
    };
    const net = scriptedFetch([contentsReply(remoteDoc, 'sha_remote')]);
    const notices: Array<{ text: string; kind: string }> = [];

    const ctrl = createSyncController({
      kv,
      fetchImpl: net.impl,
      now: () => T2,
      getData: () => local,
      applyRemote: (d) => {
        applied.push(d);
        local = d;
      },
      onNotice: (text, kind) => {
        notices.push({ text, kind });
      },
    });

    await ctrl.start();

    expect(applied).toHaveLength(1);
    expect(applied[0].records.map((r) => r.id)).toEqual(['a', 'b']);
    expect(local.records.map((r) => r.id)).toEqual(['a', 'b']);
    expect(net.calls).toHaveLength(1); // 合并结果与远端一致 → 不必回写
    expect(ctrl.status().state).toBe('synced');
    expect(kv.read().lastSha).toBe('sha_remote');
    // §3.1：合并要提示，不能静默覆盖
    expect(notices.some((n) => n.kind === 'ok' && n.text.indexOf('合并') >= 0)).toBe(true);
  });

  it('PUT 撞 sha（409）：重新拉 → 合并 → 只重试一次，最终两边数据都在', async () => {
    let local = makeData({ records: [rec('a', '2026-11-01', 8)] });
    const applied: AppData[] = [];
    const kv = makeKV(configured({ lastSha: 'sha0', baseUpdatedAt: T0 }));

    const remoteV1: RemoteDoc = {
      schema: 1,
      updatedAt: T1,
      data: makeData({ records: [rec('a', '2026-11-01', 8), rec('b', '2026-11-02', 6)] }),
    };
    const remoteV2: RemoteDoc = {
      schema: 1,
      updatedAt: T2,
      data: makeData({ records: [rec('a', '2026-11-01', 8), rec('b', '2026-11-02', 6), rec('c', '2026-11-03', 5)] }),
    };

    const net = scriptedFetch([
      contentsReply(remoteV1, 'sha1'), // 1. 打开时拉
      { status: 409, body: { message: 'sha mismatch' } }, // 2. 推的时候撞车
      contentsReply(remoteV2, 'sha2'), // 3. 重新拉
      putReply('sha3'), // 4. 重试
    ]);

    const ctrl = createSyncController({
      kv,
      fetchImpl: net.impl,
      now: () => T2,
      getData: () => local,
      applyRemote: (d) => {
        applied.push(d);
        local = d;
      },
    });

    await ctrl.start();
    // 另一台设备又改了一次：本地也新增了 d
    local = makeData({ records: [rec('a', '2026-11-01', 8), rec('b', '2026-11-02', 6), rec('d', '2026-11-04', 3)] });
    ctrl.schedule(local);
    await ctrl.flush();

    expect(net.calls.map((c) => c.method)).toEqual(['GET', 'PUT', 'GET', 'PUT']);
    expect(pushedSha(net.calls[1])).toBe('sha1');
    expect(pushedSha(net.calls[3])).toBe('sha2');

    const finalDoc = pushedDoc(net.calls[3]);
    expect(finalDoc.schema).toBe(1);
    expect(finalDoc.data.records.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);

    expect(ctrl.status().state).toBe('synced');
    expect(kv.read().lastSha).toBe('sha3');
    // 冲突期间合并出来的 c 也要落到本地
    expect(applied.some((d) => d.records.some((r) => r.id === 'c'))).toBe(true);
  });

  it('冲突重试也只重试一次：第二次 PUT 还失败就转为「未同步」，本地数据不动', async () => {
    let local = makeData({ records: [rec('a', '2026-11-01', 8)] });
    const before = JSON.stringify(local);
    const kv = makeKV(configured({ lastSha: 'sha0', baseUpdatedAt: T0 }));
    // 远端与本地内容一致 → 打开时只拉不推；冲突留到本地改动后的那次推送
    const remoteDoc: RemoteDoc = { schema: 1, updatedAt: T1, data: makeData({ records: [rec('a', '2026-11-01', 8)] }) };
    const net = scriptedFetch([
      contentsReply(remoteDoc, 'sha1'),
      { status: 409, body: {} },
      contentsReply(remoteDoc, 'sha2'),
      { status: 409, body: {} },
    ]);

    const ctrl = createSyncController({
      kv,
      fetchImpl: net.impl,
      now: () => T2,
      getData: () => local,
      applyRemote: (d) => {
        local = d;
      },
    });

    await ctrl.start();
    expect(net.calls).toHaveLength(1); // 内容一致，不回写

    local = makeData({ records: [rec('a', '2026-11-01', 8), rec('c', '2026-11-03', 6)] });
    ctrl.schedule(local);
    await ctrl.flush();

    expect(net.calls.filter((c) => c.method === 'PUT')).toHaveLength(2); // 首发 + 一次重试
    expect(ctrl.status().state).toBe('unsynced');
    expect(before).toContain('"a"');
    // 本地记录一条没少（c 是本地新加的，也还在）
    expect(local.records.map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('云端文件结构不对（坏文件）时保留本地，只报未同步', async () => {
    const local = makeData({ records: [rec('a', '2026-11-01', 8)] });
    let applied = 0;
    const kv = makeKV(configured({ lastSha: 'sha0', baseUpdatedAt: T0 }));
    const broken = { status: 200, body: { sha: 'shaX', encoding: 'base64', content: encodeBase64Utf8('{"schema":1,"updatedAt":"' + T2 + '","data":{"settings":{}}}') } };
    const net = scriptedFetch([broken]);

    const ctrl = createSyncController({
      kv,
      fetchImpl: net.impl,
      getData: () => local,
      applyRemote: () => {
        applied++;
      },
    });

    await ctrl.start();

    expect(applied).toBe(0);
    expect(ctrl.status().state).toBe('unsynced');
    expect(ctrl.status().message).toContain('云端文件');
  });
});

/* --------------------------- 防抖 / 失败重试（第 3、4 条） --------------------------- */

describe('推送时机与失败处理', () => {
  it('变更后防抖 8 秒再推；没有实质变化不推', async () => {
    let local = makeData();
    const kv = makeKV(configured());
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const net = scriptedFetch([{ status: 404, body: { message: 'Not Found' } }, putReply('shaA')]);

    const ctrl = createSyncController({
      kv,
      fetchImpl: net.impl,
      now: () => T1,
      getData: () => local,
      applyRemote: (d) => {
        local = d;
      },
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length - 1;
      },
      clearTimer: () => undefined,
    });

    await ctrl.start(); // 远端还没文件 → 把本地推上去（建文件）
    expect(net.calls.map((c) => c.method)).toEqual(['GET', 'PUT']);
    const putCountAfterStart = net.calls.length;

    expect(SYNC_DEBOUNCE_MS).toBe(8000);
    ctrl.schedule(local); // 数据没变：不排期
    expect(timers).toHaveLength(0);

    local = makeData({ records: [rec('a', '2026-11-01', 8)] });
    ctrl.schedule(local);
    expect(timers.at(-1)?.ms).toBe(8000);

    // 还没到点：不该有新请求
    expect(net.calls.length).toBe(putCountAfterStart);

    // 触发定时器 = 到点 flush
    timers.at(-1)?.fn();
    await tick();
    await tick();
    expect(net.calls.length).toBe(putCountAfterStart + 1);
    expect(pushedDoc(net.calls.at(-1) as RecordedCall).data.records).toEqual([rec('a', '2026-11-01', 8)]);
  });

  it('推送失败只提示不阻塞：本地不动、状态变未同步，下次 flush 继续补推（同一种失败只弹一次）', async () => {
    let local = makeData({ records: [rec('a', '2026-11-01', 8)] });
    const before = JSON.stringify(local);
    const kv = makeKV(configured());
    const notices: Array<{ text: string; kind: string }> = [];
    const net = scriptedFetch([
      { status: 404, body: {} }, // 拉：还没有文件
      { throws: true }, // 推：断网
      { throws: true }, // 再推：还是断
      putReply('shaOK'), // 第三次：通了
    ]);

    const ctrl = createSyncController({
      kv,
      fetchImpl: net.impl,
      now: () => T1,
      getData: () => local,
      applyRemote: (d) => {
        local = d;
      },
      onNotice: (text, kind) => {
        notices.push({ text, kind });
      },
    });

    await ctrl.start();
    expect(ctrl.status().state).toBe('unsynced');
    expect(JSON.stringify(local)).toBe(before); // 记账本身不受影响

    await ctrl.flush();
    expect(ctrl.status().state).toBe('unsynced');
    expect(notices.filter((n) => n.kind === 'warn')).toHaveLength(1);

    await ctrl.flush();
    expect(ctrl.status().state).toBe('synced');
    expect(kv.read().lastSha).toBe('shaOK');
    expect(JSON.parse(String(net.calls.at(-1)?.body)).content).toBeTruthy();
  });

  it('请求头与请求体符合 GitHub Contents API 约定，且 token 不出现在 URL / 文件内容里', async () => {
    const local = makeData({ records: [rec('a', '2026-11-01', 8)] });
    const kv = makeKV(configured());
    const net = scriptedFetch([{ status: 404, body: {} }, putReply('shaA')]);
    const ctrl = createSyncController({
      kv,
      fetchImpl: net.impl,
      now: () => T1,
      getData: () => local,
      applyRemote: () => undefined,
    });

    await ctrl.start();

    const put = net.calls.find((c) => c.method === 'PUT') as RecordedCall;
    expect(put.url).toBe('https://api.github.com/repos/Putuus/putuswork-data/contents/worklog.json');
    expect(put.url).not.toContain(TOKEN);
    expect(put.headers.Authorization).toBe('Bearer ' + TOKEN);
    expect(put.headers.Accept).toBe('application/vnd.github+json');
    expect(put.headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    expect(put.headers['Content-Type']).toBe('application/json');

    const payload = JSON.parse(String(put.body)) as { message: string; content: string; sha?: string };
    expect(payload.message).toContain('worklog');
    expect(payload.sha).toBeUndefined(); // 首个版本不带 sha
    expect(payload.content).not.toContain(TOKEN);
    expect(pushedDoc(put).data.records).toEqual([rec('a', '2026-11-01', 8)]);
  });
});

/* --------------------------- 拉取与本地改动交错 --------------------------- */

describe('拉取还没回来时本地又记了一条', () => {
  it('只推合并结果，不会用旧快照把远端独有的记录覆盖掉', async () => {
    let local = makeData({ records: [rec('a', '2026-11-01', 8)] });
    const applied: AppData[] = [];
    const kv = makeKV(configured({ lastSha: 'sha0', baseUpdatedAt: T0 }));
    const remoteDoc: RemoteDoc = {
      schema: 1,
      updatedAt: T1,
      data: makeData({ records: [rec('a', '2026-11-01', 8), rec('b', '2026-11-02', 6)] }),
    };

    const calls: RecordedCall[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const impl: FetchLike = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body });
      if (init.method === 'GET') {
        await gate; // 卡住「拉取」，模拟手机上网络慢
        return {
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => ({
            sha: 'sha1',
            encoding: 'base64',
            content: encodeBase64Utf8(JSON.stringify(remoteDoc)),
          }),
        };
      }
      return { ok: true, status: 200, text: async () => '', json: async () => ({ content: { sha: 'sha2' } }) };
    };

    const timers: Array<{ fn: () => void; ms: number }> = [];
    const ctrl = createSyncController({
      kv,
      fetchImpl: impl,
      now: () => T2,
      getData: () => local,
      applyRemote: (d) => {
        applied.push(d);
        local = d;
      },
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length - 1;
      },
      clearTimer: () => undefined,
    });

    const started = ctrl.start();
    await tick(); // 让它停在 GET 的 await 上

    // 拉取途中又记了一条（手机上很常见：打开就在记）
    local = makeData({
      records: [rec('a', '2026-11-01', 8), rec('c', '2026-11-03', 5)],
    });
    ctrl.schedule(local);
    expect(timers.at(-1)?.ms).toBe(8000);

    release();
    await started;

    expect(applied).toHaveLength(1);
    expect(local.records.map((r) => r.id)).toEqual(['a', 'b', 'c']);

    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(pushedDoc(puts[0]).data.records.map((r) => r.id)).toEqual(['a', 'b', 'c']);

    // 旧快照已经作废：8 秒到点也不该再推一次（否则会用 {a,c} 覆盖掉 b）
    const before = calls.length;
    timers.at(-1)?.fn();
    await tick();
    expect(calls.length).toBe(before);
  });
});

describe('冲突重试请求往返期间本地又记了一条', () => {
  it('不覆盖新记录：先并回本地，下一趟再把这个记录补推到远端', async () => {
    let local = makeData({ records: [rec('a', '2026-11-01', 8)] });
    const applied: AppData[] = [];
    const kv = makeKV(configured({ lastSha: 'stale', baseUpdatedAt: T0 }));

    const remoteV1: RemoteDoc = {
      schema: 1,
      updatedAt: T1,
      data: makeData({ records: [rec('a', '2026-11-01', 8)] }),
    };
    const remoteV2: RemoteDoc = {
      schema: 1,
      updatedAt: T2,
      data: makeData({ records: [rec('a', '2026-11-01', 8), rec('b', '2026-11-02', 6)] }),
    };

    const calls: RecordedCall[] = [];
    const timers: Array<{ fn: () => void; ms: number }> = [];
    let releaseRetry: () => void = () => undefined;
    const retryGate = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    let gets = 0;
    let puts = 0;

    const impl: FetchLike = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body });
      if (init.method === 'GET') {
        const doc = gets++ === 0 ? remoteV1 : remoteV2;
        return {
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => ({
            sha: 'sha' + gets,
            encoding: 'base64',
            content: encodeBase64Utf8(JSON.stringify(doc)),
          }),
        };
      }
      puts++;
      if (puts === 1) return { ok: false, status: 409, text: async () => '', json: async () => ({}) };
      if (puts === 2) await retryGate; // 卡住「重试那一次 PUT」
      return { ok: true, status: 200, text: async () => '', json: async () => ({ content: { sha: 'sha-put' + puts } }) };
    };

    const ctrl = createSyncController({
      kv,
      fetchImpl: impl,
      now: () => T2,
      getData: () => local,
      applyRemote: (d) => {
        applied.push(d);
        local = d;
      },
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length - 1;
      },
      clearTimer: () => undefined,
    });

    await ctrl.start(); // 远端与本地一致，不推

    local = makeData({ records: [rec('a', '2026-11-01', 8), rec('c', '2026-11-03', 5)] });
    ctrl.schedule(local);
    const flushing = ctrl.flush(); // 撞 409 → 重新拉 → 重试 PUT（被卡住）

    await tick();
    await tick();
    await tick();

    // 用户在「正在同步」的时候又记了一条
    local = makeData({
      records: [rec('a', '2026-11-01', 8), rec('c', '2026-11-03', 5), rec('e', '2026-11-05', 2)],
    });
    ctrl.schedule(local);
    expect(timers.length).toBeGreaterThan(0);

    releaseRetry();
    await flushing;

    // 关键：e 没被 applyRemote(merged) 盖掉
    expect(local.records.map((r) => r.id)).toEqual(['a', 'b', 'c', 'e']);
    expect(applied.at(-1)?.records.map((r) => r.id)).toEqual(['a', 'b', 'c', 'e']);

    // 下一趟把它补推上去
    await ctrl.flush();
    const putsDone = calls.filter((c) => c.method === 'PUT');
    expect(putsDone).toHaveLength(3); // 撞车那次 + 冲突重试 + 这条补推
    expect(pushedDoc(putsDone.at(-1) as RecordedCall).data.records.map((r) => r.id)).toEqual([
      'a',
      'b',
      'c',
      'e',
    ]);
  });
});

describe('立即同步不拿旧快照覆盖云端', () => {
  it('applyRemote 异步生效时（React 还没来得及重渲染），只推合并结果，不补推旧的本地数据', async () => {
    // 本地多一条 c、远端多一条 b：合并结果 {a,b,c} 必须整体推上去
    let local = makeData({ records: [rec('a', '2026-11-01', 8), rec('c', '2026-11-03', 5)] });
    const remoteDoc: RemoteDoc = {
      schema: 1,
      updatedAt: T2,
      data: makeData({ records: [rec('a', '2026-11-01', 8), rec('b', '2026-11-02', 6)] }),
    };
    const kv = makeKV(configured({ lastSha: 'sha1', baseUpdatedAt: T0 }));
    const net = scriptedFetch([contentsReply(remoteDoc, 'sha1'), putReply('sha2')]);

    const ctrl = createSyncController({
      kv,
      fetchImpl: net.impl,
      now: () => T2,
      getData: () => local,
      // 模拟 React：合并结果先排队，本次同步里 getData 仍返回旧数据
      applyRemote: () => undefined,
      setTimer: () => 0,
      clearTimer: () => undefined,
    });

    await ctrl.syncNow();

    // 只有「合并结果」这一次写入；没有再拿 {a} 去把远端 b 覆盖掉
    expect(net.calls.map((c) => c.method)).toEqual(['GET', 'PUT']);
    expect(pushedDoc(net.calls[1]).data.records.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('pagehide 用的 flush 带 keepalive', () => {
  it('flush({keepalive:true}) 时 PUT 请求带 keepalive，普通推送不带', async () => {
    let local = makeData({ records: [rec('a', '2026-11-01', 8)] });
    const kv = makeKV(configured());
    const seen: Array<{ method: string; keepalive?: boolean }> = [];
    const impl: FetchLike = async (_url, init) => {
      seen.push({ method: init.method, keepalive: init.keepalive });
      if (init.method === 'GET') {
        return {
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => ({ sha: 'sha0', encoding: 'base64', content: encodeBase64Utf8(JSON.stringify(buildRemoteDoc(makeData(), T0))) }),
        };
      }
      return { ok: true, status: 200, text: async () => '', json: async () => ({ content: { sha: 'sha1' } }) };
    };

    const ctrl = createSyncController({
      kv,
      fetchImpl: impl,
      now: () => T1,
      getData: () => local,
      applyRemote: (d) => {
        local = d;
      },
      setTimer: () => 0,
      clearTimer: () => undefined,
    });

    await ctrl.start(); // 拉取：本地有 a，远端空 → 合并后补推（不带 keepalive）
    const firstPut = seen.find((x) => x.method === 'PUT');
    expect(firstPut?.keepalive).toBeFalsy();

    local = makeData({ records: [rec('a', '2026-11-01', 8), rec('b', '2026-11-02', 6)] });
    ctrl.schedule(local);
    await ctrl.flush({ keepalive: true });
    const lastPut = seen.filter((x) => x.method === 'PUT').at(-1);
    expect(lastPut?.keepalive).toBe(true);
  });
});

describe('在途请求不覆盖用户当场改的配置', () => {
  it('推送途中用户点「清除配置」：旧 token / lastSha 不会被写回去', async () => {
    let local = makeData({ records: [rec('a', '2026-11-01', 8)] });
    const kv = makeKV(configured({ lastSha: null, baseUpdatedAt: null }));
    let releasePut: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    let puts = 0;
    const impl: FetchLike = async (_url, init) => {
      if (init.method === 'GET') {
        // 远端还没有文件 → 走「首次推送」这条路径
        return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
      }
      puts++;
      await gate;
      return {
        ok: true,
        status: 200,
        text: async () => '',
        json: async () => ({ content: { sha: 'sha1' } }),
      };
    };

    const ctrl = createSyncController({
      kv,
      fetchImpl: impl,
      now: () => T1,
      getData: () => local,
      applyRemote: (d) => {
        local = d;
      },
      setTimer: () => 0,
      clearTimer: () => undefined,
    });

    const started = ctrl.syncNow();
    await tick();

    // 用户在这期间点了「清除配置」
    kv.setItem('worklog:sync', JSON.stringify(defaultSyncConfig()));
    releasePut();
    await started;

    expect(puts).toBe(1);
    const saved = kv.read();
    expect(saved.token).toBe('');
    expect(saved.owner).toBe('');
    expect(saved.lastSha).toBeNull();
  });
});

/* ------------------ F2：远端会抹掉本地改动时，先让用户确认（§3.1） ------------------ */

describe('F2 覆盖前必须确认，不静默丢弃', () => {
  function setup() {
    let local = makeData({ records: [rec('a', '2026-11-01', 8)] });
    const applied: AppData[] = [];
    const kv = makeKV(configured({ lastSha: 'sha0', baseUpdatedAt: T0 }));
    const remoteDoc: RemoteDoc = {
      schema: 1,
      updatedAt: T2,
      data: makeData({ records: [rec('a', '2026-11-01', 3)] }),
    };
    return {
      kv,
      remoteDoc,
      applied,
      getLocal: () => local,
      setLocal: (d: AppData) => {
        local = d;
      },
    };
  }

  it('远端更新会抹掉本地未推送的 8h：不覆盖、不推送，状态变成等确认', async () => {
    const s = setup();
    const net = scriptedFetch([contentsReply(s.remoteDoc, 'sha_remote')]);
    const ctrl = createSyncController({
      kv: s.kv,
      fetchImpl: net.impl,
      now: () => T2,
      getData: s.getLocal,
      applyRemote: (d) => {
        s.applied.push(d);
        s.setLocal(d);
      },
    });

    await ctrl.start();

    expect(s.applied).toHaveLength(0);
    expect(s.getLocal().records[0].hours).toBe(8); // 本地那条还在
    expect(ctrl.status().state).toBe('conflict');
    expect(ctrl.status().risk?.records).toBe(1);
    expect(net.calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  });

  it('选「用云端版本」才覆盖本地，并把基线推到远端那版', async () => {
    const s = setup();
    const net = scriptedFetch([contentsReply(s.remoteDoc, 'sha_remote')]);
    const ctrl = createSyncController({
      kv: s.kv,
      fetchImpl: net.impl,
      now: () => T2,
      getData: s.getLocal,
      applyRemote: (d) => {
        s.applied.push(d);
        s.setLocal(d);
      },
    });

    await ctrl.start();
    await ctrl.resolveConflict('remote');

    expect(s.getLocal().records[0].hours).toBe(3);
    expect(s.kv.read().baseUpdatedAt).toBe(T2);
    expect(ctrl.status().state).toBe('synced');
    expect(net.calls.filter((c) => c.method === 'PUT')).toHaveLength(0); // 与远端一致，不用回写
  });

  it('选「用本地版本」：带远端 sha 把本地 8h 推上去', async () => {
    const s = setup();
    const net = scriptedFetch([contentsReply(s.remoteDoc, 'sha_remote'), putReply('sha_new')]);
    const ctrl = createSyncController({
      kv: s.kv,
      fetchImpl: net.impl,
      now: () => T2,
      getData: s.getLocal,
      applyRemote: (d) => {
        s.applied.push(d);
        s.setLocal(d);
      },
    });

    await ctrl.start();
    await ctrl.resolveConflict('local');

    const puts = net.calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(pushedSha(puts[0])).toBe('sha_remote');
    expect(pushedDoc(puts[0]).data.records[0].hours).toBe(8);
    expect(s.getLocal().records[0].hours).toBe(8);
    expect(ctrl.status().state).toBe('synced');
  });
});

/* ------------------------------ R3：请求超时 ------------------------------ */

describe('R3 请求带超时，弱网不会把同步卡死', () => {
  it('每个 fetch 都拿到 AbortSignal', async () => {
    const signals: Array<AbortSignal | undefined> = [];
    const impl: FetchLike = async (_url, init) => {
      signals.push(init.signal);
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
    };
    const ctrl = createSyncController({
      kv: makeKV(configured()),
      fetchImpl: impl,
      now: () => T1,
      getData: () => makeData(),
      applyRemote: () => undefined,
      setTimer: () => 0,
      clearTimer: () => undefined,
    });

    await ctrl.start();
    expect(signals.length).toBeGreaterThan(0);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it('请求悬挂时按「超时」失败，syncNow 仍会返回', async () => {
    const impl: FetchLike = async (_url, init) =>
      await new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const ctrl = createSyncController({
      kv: makeKV(configured()),
      fetchImpl: impl,
      timeoutMs: 20,
      now: () => T1,
      getData: () => makeData(),
      applyRemote: () => undefined,
      setTimer: () => 0,
      clearTimer: () => undefined,
    });

    await ctrl.syncNow();

    expect(ctrl.status().state).toBe('unsynced');
    expect(ctrl.status().message).toContain('超时');
  });
});

/* --------------------------- R4：失败后指数退避重试 --------------------------- */

describe('R4 失败后按 30s 起退避重试', () => {
  it('连续失败 30s → 60s，成功后不再排期', async () => {
    let local = makeData({ records: [rec('a', '2026-11-01', 8)] });
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const net = scriptedFetch([
      { status: 404, body: {} },
      { throws: true },
      { status: 404, body: {} },
      { throws: true },
      { status: 404, body: {} },
      putReply('shaOK'),
    ]);
    const ctrl = createSyncController({
      kv: makeKV(configured()),
      fetchImpl: net.impl,
      now: () => T1,
      getData: () => local,
      applyRemote: (d) => {
        local = d;
      },
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length - 1;
      },
      clearTimer: () => undefined,
    });

    await ctrl.start();
    expect(timers.at(-1)?.ms).toBe(30000);

    timers.at(-1)?.fn();
    await tick();
    await tick();
    await tick();
    await tick();
    expect(timers.at(-1)?.ms).toBe(60000);

    timers.at(-1)?.fn();
    await tick();
    await tick();
    await tick();
    await tick();
    expect(ctrl.status().state).toBe('synced');
    expect(timers.filter((t) => t.ms >= 30000)).toHaveLength(2);
  });
});

/* ------------- 409 撞车路径同样不能静默覆盖（复核缺陷 1 的回归） ------------- */

describe('F2 的 409 路径', () => {
  it('撞 sha 后重新拉到的远端会抹掉本地 9h：停下来等确认，不推也不覆盖', async () => {
    let local = makeData({ records: [rec('a', '2026-11-01', 8)] });
    const kv = makeKV(configured({ lastSha: 'sha1', baseUpdatedAt: T1 }));
    const remoteV1: RemoteDoc = { schema: 1, updatedAt: T1, data: makeData({ records: [rec('a', '2026-11-01', 8)] }) };
    const remoteV2: RemoteDoc = { schema: 1, updatedAt: T2, data: makeData({ records: [rec('a', '2026-11-01', 3)] }) };
    const net = scriptedFetch([
      contentsReply(remoteV1, 'sha1'),
      { status: 409, body: {} },
      contentsReply(remoteV2, 'sha2'),
    ]);

    const ctrl = createSyncController({
      kv,
      fetchImpl: net.impl,
      now: () => T2,
      getData: () => local,
      applyRemote: (d) => {
        local = d;
      },
    });

    await ctrl.start(); // 与远端一致，不动

    local = makeData({ records: [rec('a', '2026-11-01', 9)] });
    ctrl.schedule(local);
    await ctrl.flush(); // PUT 撞 409 → 重新拉到 v2（3h）

    expect(ctrl.status().state).toBe('conflict');
    expect(local.records[0].hours).toBe(9); // 本地那次改动没被抹掉
    expect(net.calls.filter((c) => c.method === 'PUT')).toHaveLength(1); // 只有撞车那一次
  });

  it('选云端时另一侧独有的记录保留（a 冲突取云端，b 新增，c 只在本机）', async () => {
    let local = makeData({
      records: [rec('a', '2026-11-01', 8), rec('c', '2026-11-03', 5)],
    });
    const kv = makeKV(configured({ lastSha: 'sha0', baseUpdatedAt: T0 }));
    const remoteDoc: RemoteDoc = {
      schema: 1,
      updatedAt: T2,
      data: makeData({ records: [rec('a', '2026-11-01', 3), rec('b', '2026-11-02', 6)] }),
    };
    const net = scriptedFetch([contentsReply(remoteDoc, 'sha_remote'), putReply('sha_new')]);

    const ctrl = createSyncController({
      kv,
      fetchImpl: net.impl,
      now: () => T2,
      getData: () => local,
      applyRemote: (d) => {
        local = d;
      },
    });

    await ctrl.start();
    expect(ctrl.status().state).toBe('conflict');

    await ctrl.resolveConflict('remote');

    expect(local.records.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(local.records.find((r) => r.id === 'a')?.hours).toBe(3);
    expect(local.records.find((r) => r.id === 'c')?.hours).toBe(5);
    expect(ctrl.status().state).toBe('synced');
  });
});
