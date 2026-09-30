// 消息网关模拟器 —— 占位实现。
//
// 切片 1 会用完整实现替换本文件（账号/群/成员/发消息/SSE 事件流 + 故障注入）。
// 现在只提供一个存活探针，让 docker-compose 能整体起来、端口能通。
import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 3100);

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'gateway-mock', placeholder: true }));
    return;
  }
  res.writeHead(501, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    error: {
      code: 'NOT_IMPLEMENTED',
      message: '网关模拟器尚未实现，将在切片 1 补齐',
    },
  }));
});

server.listen(port, '0.0.0.0', () => {
  console.log(`[gateway-mock] 占位服务已启动，监听 ${port}`);
});
