# Org Manager

AWS Organizations 成员账号自动分组管理平台。

## 功能

- 连接多个 AWS Organizations 管理账号
- 自动识别“临时”和“禁止 SP/RI”OU
- 北京时间每天 24:00 自动扫描
- 将“临时”和 Root 未分组成员账号移动到“禁止 SP/RI”
- 管理员可在网页中搜索、查看和手动调整分组
- 账号元数据保存到 DynamoDB，AK/SK 加密保存到 Secrets Manager

## Docker 部署

复制 `.env.example` 为 `deploy/.env.production` 并填入部署账号凭证，然后执行：

```bash
docker build -t org-manager:latest .
ORG_MANAGER_ENV_FILE="$PWD/deploy/.env.production" docker compose -p org-manager -f deploy/docker-compose.yml up -d
```

健康检查：`http://127.0.0.1:3101/health`

Caddy 配置示例位于 `deploy/org-manager.caddy`，容器会加入外部网络 `caddy-net`。

## Jenkins

Jenkins 使用 Git SCM 检出 `main` 分支后，在“执行 shell”中粘贴 `deploy/jenkins-deploy.sh` 的完整内容。

在 Jenkins 中配置 Secret Text：

- `ORG_MANAGER_AWS_ACCESS_KEY_ID`
- `ORG_MANAGER_AWS_SECRET_ACCESS_KEY`

可选环境变量：

- `ORG_MANAGER_PUBLIC_URL`，默认 `https://org.tontiancloud.com/`
- `APP_DATA_REGION`，默认 `us-east-1`
- `ORG_ACCOUNTS_TABLE`，默认 `OrgOuAccounts`
