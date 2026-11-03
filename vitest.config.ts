import { defineConfig } from 'vitest/config';

// 只跑纯逻辑单测（合并 / 同步 / 计算层）：node 环境足够，不需要 jsdom。
// 新增测试文件一律 src/**/*.test.ts，DEV 依赖只允许 vitest（PROJECT_RULES §4 测试锁定规则）。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
