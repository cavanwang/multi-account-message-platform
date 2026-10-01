/**
 * 账号状态机纯函数测试（规划 02 §7 验收）。
 *
 * 注意：这里的期望矩阵是**对照规划 §2 权威转移表手工枚举**的，
 * 不是从被测代码反推，因此代码与表一旦漂移测试就能抓到。
 *
 * 规划文档中的数字勘误：§7 写"13 合法 / 23 非法"，但 §2 权威表实际是
 * 16 条合法边（3+5+4+4）、20 个非法组合（含 6 个自环）。代码与权威表一致。
 */
import { describe, expect, it } from 'vitest';
import {
  ALL_STATUSES,
  assertCanTransition,
  canTransition,
  isTerminal,
  isValidStatus,
  type AccountStatus,
} from '../../src/domain/account-fsm.js';

/** 规划 §2 权威转移表：from -> 允许的 to 集合（手工枚举，唯一事实来源是规划文档）。 */
const EXPECTED: Record<AccountStatus, readonly AccountStatus[]> = {
  idle: ['online', 'suspended', 'session_expired'],
  online: ['idle', 'disconnected', 'rate_limited', 'suspended', 'session_expired'],
  rate_limited: ['online', 'disconnected', 'suspended', 'session_expired'],
  disconnected: ['idle', 'online', 'suspended', 'session_expired'],
  suspended: [],
  session_expired: [],
};

describe('账号状态机：6×6 全 36 格枚举', () => {
  it('合法边恰好 16 条、非法组合恰好 20 个（含 6 个自环）', () => {
    let legal = 0;
    for (const from of ALL_STATUSES) legal += EXPECTED[from].length;
    expect(legal).toBe(16);
    expect(ALL_STATUSES.length * ALL_STATUSES.length - legal).toBe(20);
  });

  // 逐格断言：36 个 (from, to) 组合与权威表完全一致
  for (const from of ALL_STATUSES) {
    for (const to of ALL_STATUSES) {
      const expected = EXPECTED[from].includes(to);
      it(`${from} -> ${to} ${expected ? '合法' : '非法'}`, () => {
        expect(canTransition(from, to)).toBe(expected);
      });
    }
  }

  it('6 个自环（to === from）全部非法', () => {
    for (const s of ALL_STATUSES) {
      expect(canTransition(s, s)).toBe(false);
    }
  });

  it('终态没有任何出边（12 个组合全封死）', () => {
    for (const terminal of ['suspended', 'session_expired'] as const) {
      expect(isTerminal(terminal)).toBe(true);
      for (const to of ALL_STATUSES) {
        expect(canTransition(terminal, to)).toBe(false);
      }
    }
  });

  it('任意非终态都能进入两个终态（4×2 = 8 条边）', () => {
    const nonTerminal = ALL_STATUSES.filter((s) => !isTerminal(s));
    expect(nonTerminal).toHaveLength(4);
    for (const from of nonTerminal) {
      expect(canTransition(from, 'suspended')).toBe(true);
      expect(canTransition(from, 'session_expired')).toBe(true);
    }
  });
});

describe('assertCanTransition', () => {
  it('合法转移不抛错', () => {
    expect(() => assertCanTransition('idle', 'online')).not.toThrow();
    expect(() => assertCanTransition('rate_limited', 'disconnected')).not.toThrow();
  });

  it('非法转移抛出含 from/to 的错误', () => {
    expect(() => assertCanTransition('idle', 'disconnected')).toThrow(/idle.*disconnected/);
    expect(() => assertCanTransition('suspended', 'online')).toThrow(/suspended.*online/);
  });
});

describe('状态集合工具函数', () => {
  it('isValidStatus 收窄合法字符串、拒绝未知值', () => {
    for (const s of ALL_STATUSES) expect(isValidStatus(s)).toBe(true);
    expect(isValidStatus('banned')).toBe(false);
    expect(isValidStatus('')).toBe(false);
    expect(isValidStatus('ONLINE')).toBe(false);
  });

  it('isTerminal 只认两个终态', () => {
    expect(isTerminal('suspended')).toBe(true);
    expect(isTerminal('session_expired')).toBe(true);
    for (const s of ['idle', 'online', 'disconnected', 'rate_limited'] as const) {
      expect(isTerminal(s)).toBe(false);
    }
  });
});
