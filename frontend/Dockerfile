# 控制台前端容器（占位）
# 切片 5 会替换为 Vite 构建的 React 应用。
# 占位服务为纯 ESM TypeScript，运行时通过 tsx 直接加载 src/*.ts。
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src

USER node
EXPOSE 5173
CMD ["node", "--import=tsx", "src/server.ts"]
