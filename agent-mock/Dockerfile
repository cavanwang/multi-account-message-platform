# Agent 服务模拟器容器（占位）
# 切片 5 会替换为完整实现。
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY src ./src

USER node
EXPOSE 3200
CMD ["node", "src/server.js"]
