# backend 容器镜像
# 两阶段构建：先编译 TypeScript，再只把产物与生产依赖装进运行镜像。

FROM node:22-slim AS build
WORKDIR /app

# 先只拷贝依赖清单，利用 Docker 层缓存
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# 只装生产依赖
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# 编译产物 + 迁移 SQL（迁移文件在运行时读取，必须拷贝）
COPY --from=build /app/dist ./dist
COPY migrations ./migrations

# 以非 root 用户运行
USER node

EXPOSE 3000
CMD ["node", "dist/index.js"]
