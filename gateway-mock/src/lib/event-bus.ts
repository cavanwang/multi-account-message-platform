/**
 * 事件流（SSE）的事件总线。
 *
 * 职责：
 *  1. 为每个事件分配**全局单调递增**的 eventId；
 *  2. 保留**全部历史事件**（题面明确要求，用于 since 补拉）；
 *  3. 把事件分发给所有已连接的 SSE 客户端，并按需制造
 *     "重复推送"与"≤1s 乱序"两种投递语义。
 *
 * 关键设计：eventId 在**入队时**就确定，乱序只改变**发送时刻**，绝不修改 eventId。
 * 因此消费者看到的 eventId 始终单调，只是到达顺序可能颠倒——这正是后端需要容忍的。
 */
import { EventEmitter } from 'node:events';
import { timing, randBetween } from './timing.js';
import type { GatewayEvent, GatewayEventType, EventBody } from '../types.js';

/** 已产生的事件，按 eventId 升序排列（索引即 eventId - 1 的近似，但不依赖这一点）。 */
const history: GatewayEvent[] = [];
let nextEventId = 1;

/** 投递行为开关。 */
const delivery = {
  /** true 时每个事件推送两次（对应验收场景 S2） */
  duplicateMode: false,
  /** true 时按 ≤1s 窗口打乱相邻事件的发送时刻 */
  shuffleMode: false,
};

/** SSE 客户端注册表。 */
const emitter = new EventEmitter();
emitter.setMaxListeners(0); // 客户端数量不设上限

/**
 * 追加一个事件。
 * @param type 事件类型
 * @param data 事件负载（会补上 eventId 与 type 两个字段）
 * @returns 完整事件对象
 */
export function publish<K extends GatewayEventType>(type: K, data: EventBody<K>): GatewayEvent {
  // 注意展开顺序：eventId 与 type 放最后，保证调用方传入的同名键无法覆盖权威值
  const event = {
    ...data,
    eventId: nextEventId++,
    type,
  } as GatewayEvent;
  history.push(event);

  scheduleDelivery(event);
  return event;
}

/**
 * 把事件投递给订阅者。
 *
 * duplicateMode：先立即推一次，再延迟 1ms 推第二次（用同一 eventId）。
 * shuffleMode：把事件塞进一个"稍后发送"的队列，发送时刻在窗口内随机，
 *              从而让相邻事件的到达顺序可能颠倒。
 *
 * 两种模式可以叠加。关闭时走直通路径，零延迟。
 */
function scheduleDelivery(event: GatewayEvent): void {
  const push = (): void => emitter.emit('event', event);

  if (delivery.shuffleMode) {
    const window = Math.min(timing().shuffleWindowMax, 50);
    const delay = randBetween(0, window);
    setTimeout(() => {
      push();
      if (delivery.duplicateMode) setTimeout(push, 1);
    }, delay);
    return;
  }

  push();
  if (delivery.duplicateMode) setTimeout(push, 1);
}

/** 订阅事件流；返回取消订阅函数。 */
export function subscribe(listener: (event: GatewayEvent) => void): () => void {
  emitter.on('event', listener);
  return () => emitter.off('event', listener);
}

/** 读取 eventId > since 的全部历史事件（since 为独占语义）。 */
export function replaySince(since: number): GatewayEvent[] {
  return history.filter((e) => e.eventId > since);
}

/** 当前最大 eventId（用于 /_mock/state 与测试断言）。 */
export function lastEventId(): number {
  return nextEventId - 1;
}

/** 按 eventId 区间取事件，供 /_mock/events/replay 使用。 */
export function eventsInRange(fromEventId: number, count: number): GatewayEvent[] {
  return history.filter((e) => e.eventId >= fromEventId).slice(0, count);
}

/**
 * 把一个**已存在**的事件重新推送一次。
 *
 * 与 publish 的区别：不分配新 eventId、不追加历史——这正是 at-least-once
 * 语义下"同一事件被推两次"的表现，用于验证后端的去重能力（验收场景 S2）。
 */
export function rePublish(event: GatewayEvent): void {
  scheduleDelivery(event);
}

/** 读取/修改投递开关。 */
export function setDuplicateMode(on: boolean): boolean {
  delivery.duplicateMode = on === true;
  return delivery.duplicateMode;
}

export function setShuffleMode(on: boolean): boolean {
  delivery.shuffleMode = on === true;
  return delivery.shuffleMode;
}

export function deliveryFlags(): { duplicateMode: boolean; shuffleMode: boolean } {
  return { duplicateMode: delivery.duplicateMode, shuffleMode: delivery.shuffleMode };
}

/**
 * 请求断开所有 SSE 连接，用于验证后端带 since 重连续传（INV-4）。
 * 本函数只负责广播；实际断开由 server 层在收到广播后关闭各连接。
 */
export function breakAllConnections(): void {
  emitter.emit('disconnect-requests');
}

/** 供 server 层监听"要求断开"的通道。 */
export function onDisconnectRequest(listener: () => void): () => void {
  emitter.on('disconnect-requests', listener);
  return () => emitter.off('disconnect-requests', listener);
}

/** 清空历史事件与计数器——供 /_mock/reset 使用（注意：默认不清零 eventId 计数）。 */
export function resetEventBus({ resetCounter = false }: { resetCounter?: boolean } = {}): void {
  history.length = 0;
  delivery.duplicateMode = false;
  delivery.shuffleMode = false;
  if (resetCounter) nextEventId = 1;
}
