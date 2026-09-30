# 消息网关模拟器容器
#
# 为什么需要构建阶段：模拟器依赖一些开发/测试期工具（如 SSE 客户端用于自测脚本），
# 生产依赖用 `npm install --omit=dev` 安装，保证镜像只带运行所需内容。
# 说明：模拟器是无构建步骤的纯 ESM 项目，dist 阶段即直接拷贝源码。

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# 先装依赖，利用 Docker 层缓存（package.json 不变则跳过重装）
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src

# 以非 root 用户运行
USER node

EXPOSE 3100
CMD ["node", "src/index.js"]
