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
    if (await handleGateway(req, res, url)) return;

    sendError(res, 404, 'NOT_FOUND', { message: `未知路径：${req.method} ${url.pathname}` });
  } catch (err) {
    console.error('[gateway] 请求处理失败:', err);
    if (!res.headersSent) {
      sendError(res, 500, 'INTERNAL_ERROR');
    }
  }
});

server.listen(config.port, '0.0.0.0', () => {
  console.log(
    `[gateway-mock] 监听 ${config.port}，时序档案=${config.timingProfile}，` +
      `预置账号=[${config.seedAccounts.join(', ')}]`,
  );
});
