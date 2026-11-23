import { describe, expect, it } from 'vitest';
import { staticYearMarks } from './holidays';

describe('staticYearMarks · 内置节假日兜底', () => {
  it('2026 春节与调休', () => {
    const marks = staticYearMarks(2026);
    expect(marks['2026-02-15']?.kind).toBe('holiday');
    expect(marks['2026-02-14']?.kind).toBe('workday');
    expect(marks['2026-02-28']?.kind).toBe('workday');
  });

  it('2025 国庆中秋连休', () => {
    const marks = staticYearMarks(2025);
    expect(marks['2025-10-01']?.kind).toBe('holiday');
    expect(marks['2025-10-08']?.kind).toBe('holiday');
    expect(marks['2025-09-28']?.kind).toBe('workday');
  });

  it('2027 春节与国庆', () => {
    const marks = staticYearMarks(2027);
    expect(marks['2027-02-06']?.kind).toBe('holiday');
    expect(marks['2027-02-14']?.kind).toBe('workday');
    expect(marks['2027-10-01']?.kind).toBe('holiday');
    expect(marks['2027-09-26']?.kind).toBe('workday');
  });

  it('没有内置数据的年份返回空表，而不是瞎猜', () => {
    expect(staticYearMarks(2031)).toEqual({});
  });
});
