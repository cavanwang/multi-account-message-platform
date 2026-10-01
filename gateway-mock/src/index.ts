/**
 * 消息网关模拟器 —— HTTP 入口。
 *
 * 路由分两段：
 *   - `/_mock/*` 控制端点（模拟器私有，仅供测试驱动故障）
 *   - 其余为题面 §2.1 定义的网关契约
 *
 * 状态保存在内存中，进程重启即清空（README 已声明）。
 */
import { createServer } from 'node:http';
import { config } from './config.js';
import { installDisconnectHandler, sendError, activeConnectionCount } from './lib/http.js';
import { classifyEndpoint, consumeFault, peekFault } from './lib/faults.js';
import { seedAccounts } from './store.js';
import { handle as handleMock } from './mock-routes.js';
import { handle as handleGateway } from './routes.js';

// 预置账号（默认 acct-1..acct-4，与后端 migration 里的账号一一对应）
seedAccounts(config.seedAccounts);
installDisconnectHandler();

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  try {
    // 存活探针：容器编排与 README 的冒烟检查都用它
    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          service: 'gateway-mock',
          accounts: config.seedAccounts.length,
          sseConnections: activeConnectionCount(),
        }),
      );
      return;
    }

    if (await handleMock(req, res, url)) return;

    // 通用故障守卫（仅作用于题面 REST 契约端点；SSE /events 与 /_mock/* 不受影响）
    if (await applyFault(req.method ?? 'GET', url.pathname, res)) return;

    if (await handleGateway(req, res, url)) return;

    sendError(res, 404, 'NOT_FOUND', { message: `未知路径：${req.method} ${url.pathname}` });
  } catch (err) {
    console.error('[gateway] 请求处理失败:', err);
    if (!res.headersSent) {
      sendError(res, 500, 'INTERNAL_ERROR');
    }
  }
});

/**
 * 通用故障注入守卫。
 * @returns true 表示请求已被故障短路（已写响应）；false 表示继续正常路由
 *
 * send 的 504 是特例：它可能"其实被接收、稍后落地"，需要请求体里的
 * clientMsgId/text 来调度补落地，因此此处只放行、由 routes.ts 消耗并处理。
 */
async function applyFault(method: string, path: string, res: Parameters<typeof sendError>[0]): Promise<boolean> {
  const endpoint = classifyEndpoint(method, path);
  if (endpoint === null) return false;

  const rule = peekFault(endpoint);
  if (rule === null) return false;

  // send + 504：交由路由层在读体后消耗（peek 不消耗次数）
  if (endpoint === 'send' && rule.mode === '504') return false;

  const fault = consumeFault(endpoint);
  if (fault === null) return false; // 概率未命中

  if (fault.mode === 'delay') {
    if (fault.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, fault.delayMs));
    }
    return false; // 延迟后继续正常处理
  }
  if (fault.mode === '503') {
    sendError(res, 503, 'SERVICE_UNAVAILABLE');
    return true;
  }
  // 非 send 端点的 504
  sendError(res, 504, 'NETWORK_TIMEOUT');
  return true;
}

server.listen(config.port, '0.0.0.0', () => {
  console.log(
    `[gateway-mock] 监听 ${config.port}，时序档案=${config.timingProfile}，` +
      `预置账号=[${config.seedAccounts.join(', ')}]`,
  );
});
