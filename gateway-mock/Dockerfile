# 消息网关模拟器容器（占位）
# 切片 1 会替换为完整实现，届时可能需要补依赖与构建步骤。
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY src ./src

USER node
EXPOSE 3100
CMD ["node", "src/server.js"]
