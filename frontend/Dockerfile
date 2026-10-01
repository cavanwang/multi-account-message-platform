# 控制台前端（A6）：React 18 + TypeScript + Vite
# 多阶段构建：
#   1) node 阶段安装依赖并 vite build 出静态产物
#   2) nginx 阶段伺服产物，并反代 /api、/ws 到 backend 容器（见 nginx.conf）

FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund && npm cache clean --force

COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 5173
CMD ["nginx", "-g", "daemon off;"]
