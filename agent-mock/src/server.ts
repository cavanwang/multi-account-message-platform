/**
 * Agent 模拟器 HTTP 入口。
 *
 * 端点：
 *   POST /agent/turn    — Agent 推理
 *   POST /agent/audit   — 内容审计
 *   POST /_mock/behavior — 切换坏行为模式
 *   POST /_mock/audit    — 切换 audit 模式
 *   POST /_mock/reset    — 重置状态
 *   GET  /health         — 健康检查
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { loadConfig } from './config.js';
import { handleTurn, handleAudit } from './routes.js';
import { handleMockBehavior, handleMockAudit, handleMockReset } from './mock-routes.js';
import { sendError, sendJson } from './lib/http.js';

const config = loadConfig();

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  try {
    if (method === 'POST' && url === '/agent/turn') {
      await handleTurn(req, res);
      return;
    }
    if (method === 'POST' && url === '/agent/audit') {
      await handleAudit(req, res);
      return;
    }
    if (method === 'POST' && url === '/_mock/behavior') {
      await handleMockBehavior(req, res);
      return;
    }
    if (method === 'POST' && url === '/_mock/audit') {
      await handleMockAudit(req, res);
      return;
    }
    if (method === 'POST' && url === '/_mock/reset') {
      handleMockReset(req, res);
      return;
    }
    if (method === 'GET' && url === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }
    sendError(res, 404, 'NOT_FOUND', `未找到路由: ${method} ${url}`);
  } catch (err) {
    console.error('[agent-mock] 未捕获异常:', err);
    sendError(res, 500, 'INTERNAL_ERROR', '服务器内部错误');
  }
});

server.listen(config.port, () => {
  console.log(`agent-mock listening on :${config.port}`);
});
