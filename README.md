# Org Manager

AWS Organizations 成员账号自动分组管理平台。

## 功能

- 连接多个 AWS Organizations 管理账号
- 新增、编辑或删除已连接的管理账号
- 切换账号时使用 5 分钟服务器缓存，手动刷新可强制获取最新数据
- 自动识别“临时”和“禁止 SP/RI”OU
- 扫描发现缺少“禁止 SP/RI”OU 时自动在 Organization Root 下创建
- OU 名称不一致时列出全部 OU，由用户确认并保存映射
- 北京时间每天 24:00 自动扫描
- 将“临时”和 Root 未分组成员账号移动到“禁止 SP/RI”
- 管理员可在网页中搜索、查看和手动调整分组
- 账号元数据保存到 DynamoDB，AK/SK 加密保存到 Secrets Manager

## Docker 部署

生产服务器通过 EC2 IAM Role 获取 AWS 权限，不需要在容器或 Jenkins 中保存 AK/SK：

```bash
docker build -t org-manager:latest .
docker compose -p org-manager -f deploy/docker-compose.yml up -d --no-build
```

健康检查：`http://127.0.0.1:3101/health`

Caddy 配置示例位于 `deploy/org-manager.caddy`，容器会加入外部网络 `caddy-net`。

## Jenkins

Jenkins 使用 Git SCM 检出 `main` 分支后，在“执行 shell”中直接运行 `docker build` 和 `docker compose up`。无需配置 AWS Secret Text。
