// 控制台前端 —— 占位实现。
//
// 切片 5 会替换为 React 18 + TypeScript + Vite 的真实前端（5 个页面）。
// 现在只提供一个静态页面，让 docker-compose 能整体起来、端口能通。
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

const port = Number(process.env['PORT'] ?? 5173);

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>多账号群组消息平台</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; line-height: 1.6">
  <h1>多账号群组消息平台</h1>
  <p>前端控制台尚未实现（切片 5）。当前可用的是后端 API：</p>
  <ul>
    <li><code>GET  http://localhost:3000/api/health</code></li>
    <li><code>POST http://localhost:3000/api/auth/login</code> —— <code>admin/admin</code> 或 <code>viewer/viewer</code></li>
  </ul>
</body>
</html>`;

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'frontend', placeholder: true }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`[frontend] 占位页面已启动，监听 ${port}`);
});
