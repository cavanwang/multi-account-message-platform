# 消息网关模拟器容器
#
# 模拟器是无独立编译步骤的纯 ESM TypeScript 项目：运行时通过 tsx 直接加载 src/*.ts
# （tsx 已声明在 dependencies 中，--omit=dev 安装后依然可用），因此镜像只拷贝源码。

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# 先装依赖，利用 Docker 层缓存（package.json 不变则跳过重装）
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src

# 以非 root 用户运行
USER node

EXPOSE 3100
CMD ["node", "--import=tsx", "src/index.ts"]
