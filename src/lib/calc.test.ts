/**
 * 回归测试：手输数值不能被「步长吸附」吃掉小数
 * 背景：rot 报 2026-11-03 —— 时薪填 32.5 自动变 33，导致整月工资算错。
 * 根因：NumberField 的 commit() 走 clamp()，里面做了 Math.round(n / step) * step，
 * 时薪字段 step=1，于是 32.5 → 33。已改为 commit 只夹范围不吸附步长。
 *
 * 这里锁住的是纯函数 clampNumber 的行为；组件层（ui.tsx commit 分支）用同一函数，
 * 不要改回 clamp()。
 */
import { describe, expect, it } from 'vitest';
import { clampNumber, clampMeal, round2 } from './calc';

describe('clampNumber —— 手输保留小数', () => {
  it('32.5 的时薪原样保留（step=1 也不能吸附成 33）', () => {
    expect(clampNumber(32.5, 0, 100000)).toBe(32.5);
  });

  it('工时 6.25 原样保留（step=0.5 也不能吸附成 6.5）', () => {
    expect(clampNumber(6.25, 0, 24)).toBe(6.25);
  });

  it('三位小数压到两位，不乱跳档（取整规则与 round2 一致）', () => {
    expect(clampNumber(7.126, 0, 24)).toBe(7.13);
    expect(clampNumber(7.124, 0, 24)).toBe(7.12);
    expect(clampNumber(32.499, 0, 100000)).toBe(32.5);
  });

  it('越界夹回范围边界', () => {
    expect(clampNumber(-5, 0, 100)).toBe(0);
    expect(clampNumber(999, 0, 100)).toBe(100);
    expect(clampNumber(0, 0, 100)).toBe(0);
  });

  it('浮点噪声压掉：0.1 + 0.2 得 0.3 而不是 0.30000000000000004', () => {
    expect(clampNumber(0.1 + 0.2, 0, 10)).toBe(0.3);
  });

  it('NaN / Infinity 这类坏输入回落到下界，不写进数据', () => {
    expect(clampNumber(Number.NaN, 0, 100)).toBe(0);
    expect(clampNumber(Number.NaN, 1, 100)).toBe(1);
    expect(clampNumber(Number.POSITIVE_INFINITY, 0, 100)).toBe(100);
  });
});

describe('既有行为不被这次改动带偏', () => {
  it('餐补仍然只收整数（1~100）', () => {
    expect(clampMeal(15.4)).toBe(15);
    expect(clampMeal(15.6)).toBe(16);
    expect(clampMeal(0)).toBe(1);
    expect(clampMeal(999)).toBe(100);
  });

  it('金额仍按两位小数四舍五入', () => {
    expect(round2(123.456)).toBe(123.46);
    expect(round2(32.5 * 1.5)).toBe(48.75);
  });
});
