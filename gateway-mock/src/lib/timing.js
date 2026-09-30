/**
 * 时序档案（timing profile）。
 *
 * 题面里的所有时序数字（202 延迟、message_sent 延迟、join 延迟、kick 耗时等）
 * 都集中在这里定义，是"时序"的唯一来源。
 *
 * 为什么要可切换：
 *  - real：忠实复现题面给出的时序，用于人工演示与验收。
 *  - fast：把延迟按比例压缩到毫秒级，让 e2e 测试能在几秒内跑完一个完整场景；
 *          如果固定成题面的 1-5 秒，一个 S6 场景就要等半分钟。
 *
 * 注意：压缩只影响"等待时长"，不影响任何业务语义（谁先谁后、谁成功谁失败）。
 */
import { config } from '../config.js';

/** 实时档案：完全按题面给出的数字。 */
const REAL = {
  /** POST /groups/:id/send 返回 202 之前的延迟 */
  sendAcceptedDelayMin: 0,
  sendAcceptedDelayMax: 2000,
  /** 从受理到推 message_sent / message_failed 的延迟 */
  messageSentDelayMin: 50,
  messageSentDelayMax: 2000,
  /** join 被受理到推 member_joined 的延迟 */
  joinDelayMin: 100,
  joinDelayMax: 1500,
  /** kick 返回前的处理耗时 */
  kickDelayMin: 1000,
  kickDelayMax: 5000,
  /** 504 之后消息"收敛"（落地或确认没落地）的时间 */
  networkTimeoutConvergence: 2000,
  /** 事件乱序窗口上限（题面：≤ 1 秒） */
  shuffleWindowMax: 1000,
};

/** fast 档案：把最坏情况也压到 30ms 以内，同时保留"最短 < 最长"的量级关系。 */
const FAST = {
  sendAcceptedDelayMin: 0,
  sendAcceptedDelayMax: 10,
  messageSentDelayMin: 1,
  messageSentDelayMax: 25,
  joinDelayMin: 1,
  joinDelayMax: 20,
  kickDelayMin: 5,
  kickDelayMax: 30,
  networkTimeoutConvergence: 120,
  shuffleWindowMax: 10,
};

export const TIMING_PROFILES = { real: REAL, fast: FAST };

/** 当前生效的时序档案；可通过 POST /_mock/timing 切换。 */
let currentName = TIMING_PROFILES[config.timingProfile] !== undefined ? config.timingProfile : 'real';
let current = TIMING_PROFILES[currentName];

export function timing() {
  return current;
}

/** 当前档案名，供 /_mock/state 展示。 */
export function currentTimingProfile() {
  return currentName;
}

/** 切换时序档案，返回是否成功（未知档案名返回 false）。 */
export function setTimingProfile(name) {
  const profile = TIMING_PROFILES[name];
  if (profile === undefined) return false;
  current = profile;
  currentName = name;
  return true;
}

/**
 * 把题面给定的固定毫秒数按当前档案比例缩放。
 * 用于那些不在区间里、但需要整体压缩的等待（例如 10 秒静默窗口）。
 */
export function scaled(realMs) {
  return Math.round((realMs * current.networkTimeoutConvergence) / REAL.networkTimeoutConvergence);
}

/** 在 [min, max] 内取随机整数（含端点）。 */
export function randBetween(min, max) {
  if (max <= min) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}
