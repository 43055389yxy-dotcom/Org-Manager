#!/bin/bash
set -Eeuo pipefail

: "${BUILD_NUMBER:?缺少 Jenkins BUILD_NUMBER}"
cd "$WORKSPACE"

test -f Dockerfile
test -f deploy/docker-compose.yml
grep -q 'image: org-manager:latest' deploy/docker-compose.yml

CONTAINER_NAME="org-manager"
ENV_FILE="$WORKSPACE/deploy/.env.production"
PUBLIC_URL="${ORG_MANAGER_PUBLIC_URL:-https://org.tontiancloud.com/}"

EXISTING_ENV=""
if docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  EXISTING_ENV="$(docker inspect "$CONTAINER_NAME" --format '{{range .Config.Env}}{{println .}}{{end}}')"
fi

AWS_ACCESS_KEY_ID="${ORG_MANAGER_AWS_ACCESS_KEY_ID:-${AWS_ACCESS_KEY_ID:-$(printf '%s\n' "$EXISTING_ENV" | sed -n 's/^AWS_ACCESS_KEY_ID=//p' | head -1)}}"
AWS_SECRET_ACCESS_KEY="${ORG_MANAGER_AWS_SECRET_ACCESS_KEY:-${AWS_SECRET_ACCESS_KEY:-$(printf '%s\n' "$EXISTING_ENV" | sed -n 's/^AWS_SECRET_ACCESS_KEY=//p' | head -1)}}"
AWS_SESSION_TOKEN="${ORG_MANAGER_AWS_SESSION_TOKEN:-${AWS_SESSION_TOKEN:-$(printf '%s\n' "$EXISTING_ENV" | sed -n 's/^AWS_SESSION_TOKEN=//p' | head -1)}}"
APP_DATA_REGION="${APP_DATA_REGION:-us-east-1}"
ORG_ACCOUNTS_TABLE="${ORG_ACCOUNTS_TABLE:-OrgOuAccounts}"

: "${AWS_ACCESS_KEY_ID:?没有找到 AWS Access Key，请在 Jenkins 中添加 Secret Text：ORG_MANAGER_AWS_ACCESS_KEY_ID}"
: "${AWS_SECRET_ACCESS_KEY:?没有找到 AWS Secret Key，请在 Jenkins 中添加 Secret Text：ORG_MANAGER_AWS_SECRET_ACCESS_KEY}"

umask 077
{
  printf 'AWS_ACCESS_KEY_ID=%s\n' "$AWS_ACCESS_KEY_ID"
  printf 'AWS_SECRET_ACCESS_KEY=%s\n' "$AWS_SECRET_ACCESS_KEY"
  [ -z "$AWS_SESSION_TOKEN" ] || printf 'AWS_SESSION_TOKEN=%s\n' "$AWS_SESSION_TOKEN"
  printf 'APP_DATA_REGION=%s\n' "$APP_DATA_REGION"
  printf 'ORG_ACCOUNTS_TABLE=%s\n' "$ORG_ACCOUNTS_TABLE"
} > "$ENV_FILE"

trap 'rm -f "$ENV_FILE"' EXIT
export ORG_MANAGER_ENV_FILE="$ENV_FILE"

PREVIOUS_IMAGE=""
if docker inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  PREVIOUS_IMAGE="$(docker inspect "$CONTAINER_NAME" --format '{{.Image}}')"
  docker image tag "$PREVIOUS_IMAGE" "org-manager:rollback-${BUILD_NUMBER}"
fi

docker build -t "org-manager:${BUILD_NUMBER}" -t org-manager:latest .

docker compose -p org-manager -f deploy/docker-compose.yml up -d --no-deps --pull never --no-build --force-recreate org-manager

for i in $(seq 1 30); do
  INTERNAL_READY=false
  if docker exec "$CONTAINER_NAME" wget -qO- http://127.0.0.1:3101/health >/dev/null 2>&1; then INTERNAL_READY=true; fi
  PUBLIC_CODE="$(curl -sS --max-time 8 -o /dev/null -w '%{http_code}' "$PUBLIC_URL" || true)"
  if [ "$INTERNAL_READY" = true ] && { [ "$PUBLIC_CODE" = "200" ] || [ "$PUBLIC_CODE" = "301" ] || [ "$PUBLIC_CODE" = "302" ]; }; then
    echo "容器健康检查：成功"
    echo "公网检查：${PUBLIC_CODE}"
    echo "部署成功：${PUBLIC_URL}"
    docker image prune -f --filter 'until=168h' >/dev/null 2>&1 || true
    exit 0
  fi
  echo "等待服务启动：${i}/30（公网状态：${PUBLIC_CODE}）"
  sleep 2
done

echo "部署健康检查失败"
docker ps -a --filter "name=${CONTAINER_NAME}"
docker logs --tail 200 "$CONTAINER_NAME" || true

if [ -n "$PREVIOUS_IMAGE" ]; then
  echo "开始回滚旧镜像"
  docker image tag "$PREVIOUS_IMAGE" org-manager:latest
  docker compose -p org-manager -f deploy/docker-compose.yml up -d --no-deps --pull never --no-build --force-recreate org-manager
fi

exit 1
