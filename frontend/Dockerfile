# 控制台前端容器（占位）
# 切片 5 会替换为 Vite 构建的 React 应用。
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
COPY src ./src

USER node
EXPOSE 5173
CMD ["node", "src/server.js"]
