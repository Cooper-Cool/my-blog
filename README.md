# 个人静态博客系统

**GitHub**：[Cooper-Cool/my-blog](https://github.com/Cooper-Cool/my-blog)

**使用教程**：[点击查看](src/content/echoes博客使用说明.md)

**在线演示**：[blog.Cooper.com](https://blog.Cooper.com/)


# docker compose down -v 清理说明和常用命令速查。
# 首次/更新镜像后启动
docker compose up --build

# 后台启动
docker compose up -d --build

# 看日志
docker compose logs -f

# 停止并删除容器（保留卷）
docker compose down

# 停止并删除容器 + 卷（会清掉容器里的 node_modules）
docker compose down -v

# 进入容器
docker compose exec blog-dev sh

# 仅重启服务（不重建镜像）
docker compose restart blog-dev