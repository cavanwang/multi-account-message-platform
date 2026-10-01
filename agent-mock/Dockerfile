# Agent 服务模拟器容器（占位）
# 切片 5 会替换为完整实现。
# 占位服务为纯 ESM TypeScript，运行时通过 tsx 直接加载 src/*.ts。
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src

USER node
EXPOSE 3200
CMD ["node", "--import=tsx", "src/server.ts"]
