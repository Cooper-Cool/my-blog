# 构建阶段
FROM node:20-alpine AS builder

# 安装 pnpm
RUN npm install -g pnpm

WORKDIR /app

# 复制依赖文件
COPY package.json pnpm-lock.yaml ./

# 安装依赖
RUN pnpm install --frozen-lockfile

# 复制源代码
COPY . .

# 构建项目
RUN pnpm run build

# 生产阶段
FROM node:20-alpine

# 安装轻量级静态服务器
RUN npm install -g serve

WORKDIR /app

# 从构建阶段复制构建产物
COPY --from=builder /app/dist ./dist

# 暴露端口
EXPOSE 4321

# 启动服务
CMD ["serve", "-s", "dist", "-l", "4321"]