import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OrganizationsClient, DescribeOrganizationCommand, DescribeOrganizationalUnitCommand, ListAccountsCommand, ListAccountsForParentCommand, ListChildrenCommand, ListParentsCommand, ListRootsCommand, MoveAccountCommand } from '@aws-sdk/client-organizations';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand, GetCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, CreateSecretCommand, DeleteSecretCommand, GetSecretValueCommand, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const app = express();
app.use(express.json());
app.get('/health', (_, res) => res.json({ ok: true, service: 'org-manager', time: new Date().toISOString() }));
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
app.use(express.static(publicDir));
const connections = new Map();
const organizationCache = new Map();
const organizationLoads = new Map();
const dataRegion = process.env.APP_DATA_REGION || 'us-east-1';
const tableName = process.env.ORG_ACCOUNTS_TABLE || 'OrgOuAccounts';
const organizationCacheTtlMs = Math.max(30_000, Number(process.env.ORG_CACHE_TTL_MS || 5 * 60 * 1000));
const retryConfig = { maxAttempts: 10, retryMode: 'adaptive' };
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: dataRegion, ...retryConfig }));
const secrets = new SecretsManagerClient({ region: dataRegion, ...retryConfig });
const policy = `USER_NAME="org-ou-web-manager"
POLICY_NAME="OrgOUWebManagerPolicy"
if aws iam get-user --user-name "$USER_NAME" >/dev/null 2>&1; then
  for KEY_ID in $(aws iam list-access-keys --user-name "$USER_NAME" --query 'AccessKeyMetadata[].AccessKeyId' --output text); do
    [ "$KEY_ID" = "None" ] || aws iam delete-access-key --user-name "$USER_NAME" --access-key-id "$KEY_ID"
  done
  for ARN in $(aws iam list-attached-user-policies --user-name "$USER_NAME" --query 'AttachedPolicies[].PolicyArn' --output text); do
    [ "$ARN" = "None" ] || aws iam detach-user-policy --user-name "$USER_NAME" --policy-arn "$ARN"
  done
  for GROUP in $(aws iam list-groups-for-user --user-name "$USER_NAME" --query 'Groups[].GroupName' --output text); do
    [ "$GROUP" = "None" ] || aws iam remove-user-from-group --user-name "$USER_NAME" --group-name "$GROUP"
  done
  aws iam delete-user-policy --user-name "$USER_NAME" --policy-name "$POLICY_NAME" 2>/dev/null || true
  aws iam delete-login-profile --user-name "$USER_NAME" 2>/dev/null || true
  aws iam delete-user --user-name "$USER_NAME"
fi
cat > /tmp/org-ou-policy.json <<'JSON'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["organizations:DescribeOrganization","organizations:DescribeAccount","organizations:DescribeOrganizationalUnit","organizations:ListAccounts","organizations:ListAccountsForParent","organizations:ListChildren","organizations:ListParents","organizations:ListRoots","organizations:MoveAccount"],"Resource":"*"}]}
JSON
aws iam create-user --user-name "$USER_NAME"
aws iam put-user-policy --user-name "$USER_NAME" --policy-name "$POLICY_NAME" --policy-document file:///tmp/org-ou-policy.json
aws iam create-access-key --user-name "$USER_NAME"`;

function client(c) { return new OrganizationsClient({ region: c.region || 'us-east-1', credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey }, ...retryConfig }); }
function stsClient(c) { return new STSClient({ region: c.region || 'us-east-1', credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey }, ...retryConfig }); }
function errorMessage(error) {
  if (['TooManyRequestsException', 'ThrottlingException', 'Throttling'].includes(error?.name) || /too many requests|rate exceeded|throttl/i.test(error?.message || '')) {
    return 'AWS 接口暂时限流，系统已自动重试。请稍后再刷新组织数据；已经保存成功的连接不会丢失。';
  }
  return error?.message || '请求失败';
}
async function saveConnection(accountId, c) {
  const secretName = `org-ou-manager/${accountId}`;
  const secretValue = JSON.stringify({ accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, region: c.region });
  let secretArn;
  try {
    const result = await secrets.send(new PutSecretValueCommand({ SecretId: secretName, SecretString: secretValue }));
    secretArn = result.ARN;
  } catch (error) {
    if (error.name !== 'ResourceNotFoundException') throw error;
    const result = await secrets.send(new CreateSecretCommand({ Name: secretName, Description: 'Org OU Manager target account credentials', SecretString: secretValue, Tags: [{ Key: 'Application', Value: 'OrgOuManager' }] }));
    secretArn = result.ARN;
  }
  await db.send(new UpdateCommand({
    TableName: tableName,
    Key: { accountId },
    UpdateExpression: 'SET #n = :name, #r = :region, secretArn = :secretArn, #s = :status, updatedAt = :updatedAt',
    ExpressionAttributeNames: { '#n': 'name', '#r': 'region', '#s': 'status' },
    ExpressionAttributeValues: { ':name': c.name, ':region': c.region, ':secretArn': secretArn, ':status': 'CONNECTED', ':updatedAt': new Date().toISOString() }
  }));
}
async function loadConnection(accountId) {
  if (connections.has(accountId)) return connections.get(accountId);
  const result = await db.send(new GetCommand({ TableName: tableName, Key: { accountId } }));
  if (!result.Item) return null;
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId: result.Item.secretArn }));
  const credentials = JSON.parse(secret.SecretString);
  const c = {
    name: result.Item.name,
    region: result.Item.region || credentials.region || 'us-east-1',
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    temporaryOuId: result.Item.temporaryOuId || null,
    blockedOuId: result.Item.blockedOuId || null,
    ouConfigured: result.Item.ouConfigured === true
  };
  connections.set(accountId, c);
  return c;
}
async function accounts(c) {
  const orgClient = client(c);
  const org = await orgClient.send(new DescribeOrganizationCommand({}));
  const roots = await orgClient.send(new ListRootsCommand({}));
  const allOus = [];
  async function readOus(parentId) {
    let nextToken;
    do {
      const page = await orgClient.send(new ListChildrenCommand({ ParentId: parentId, ChildType: 'ORGANIZATIONAL_UNIT', NextToken: nextToken }));
      for (const child of page.Children || []) {
        const detail = await orgClient.send(new DescribeOrganizationalUnitCommand({ OrganizationalUnitId: child.Id }));
        const ou = detail.OrganizationalUnit; if (!ou) continue;
        allOus.push(ou); await readOus(ou.Id);
      }
      nextToken = page.NextToken;
    } while (nextToken);
  }
  for (const root of roots.Roots || []) await readOus(root.Id);
  const temporaryOu = c.ouConfigured
    ? allOus.find(ou => ou.Id === c.temporaryOuId)
    : allOus.find(ou => ou.Name?.trim() === '临时');
  const blockedOu = c.ouConfigured
    ? allOus.find(ou => ou.Id === c.blockedOuId)
    : allOus.find(ou => ['禁止SP/RI', '禁止 SP/RI'].includes(ou.Name?.replace(/\s+/g, ' ').trim()));
  const managementId = org.Organization?.ManagementAccountId || org.Organization?.MasterAccountId;
  const out = []; let token;
  do { const r = await orgClient.send(new ListAccountsCommand({ NextToken: token })); out.push(...(r.Accounts || [])); token = r.NextToken; } while (token);
  async function accountIdsForParent(parentId) {
    const ids = new Set(); if (!parentId) return ids;
    let nextToken;
    do {
      const page = await orgClient.send(new ListAccountsForParentCommand({ ParentId: parentId, NextToken: nextToken }));
      for (const account of page.Accounts || []) ids.add(account.Id);
      nextToken = page.NextToken;
    } while (nextToken);
    return ids;
  }
  const rootAccountSets = await Promise.all((roots.Roots || []).map(root => accountIdsForParent(root.Id)));
  const rootAccounts = new Set(rootAccountSets.flatMap(set => [...set]));
  const [temporaryAccounts, blockedAccounts] = await Promise.all([accountIdsForParent(temporaryOu?.Id), accountIdsForParent(blockedOu?.Id)]);
  const rootByAccount = new Map();
  (roots.Roots || []).forEach((root, index) => { for (const id of rootAccountSets[index]) rootByAccount.set(id, root.Id); });
  const enriched = out.map(account => {
    if (rootAccounts.has(account.Id)) return { ...account, ParentId: rootByAccount.get(account.Id), ParentType: 'ROOT', Group: '未分组', IsManagement: account.Id === managementId };
    if (temporaryAccounts.has(account.Id)) return { ...account, ParentId: temporaryOu.Id, ParentType: 'ORGANIZATIONAL_UNIT', Group: '临时', IsManagement: account.Id === managementId };
    if (blockedAccounts.has(account.Id)) return { ...account, ParentId: blockedOu.Id, ParentType: 'ORGANIZATIONAL_UNIT', Group: '禁止 SP/RI', IsManagement: account.Id === managementId };
    return { ...account, ParentId: null, ParentType: 'ORGANIZATIONAL_UNIT', Group: '其他 OU', IsManagement: account.Id === managementId };
  });
  const availableOus = allOus
    .map(ou => ({ Id: ou.Id, Name: ou.Name, Path: ou.Path || '' }))
    .sort((a, b) => String(a.Name).localeCompare(String(b.Name), 'zh-CN'));
  return {
    organization: org.Organization,
    accounts: enriched,
    availableOus,
    ouConfigured: c.ouConfigured,
    ouSelectionRequired: !blockedOu || (!temporaryOu && !c.ouConfigured),
    targetOus: { temporary: temporaryOu || null, blocked: blockedOu || null },
    stats: {
    total: enriched.length,
    temporary: enriched.filter(a => a.Group === '临时').length,
    blocked: enriched.filter(a => a.Group === '禁止 SP/RI').length,
    ungrouped: enriched.filter(a => a.Group === '未分组' && !a.IsManagement).length,
    actionable: enriched.filter(a => ['未分组', '临时'].includes(a.Group) && !a.IsManagement).length
    }
  };
}
function cachedResponse(entry, hit, stale = false) {
  return { ...entry.data, cache: { hit, stale, cachedAt: new Date(entry.cachedAt).toISOString(), expiresAt: new Date(entry.expiresAt).toISOString() } };
}
async function organizationData(accountId, c, forceRefresh = false) {
  const cached = organizationCache.get(accountId);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cachedResponse(cached, true);
  if (organizationLoads.has(accountId)) return organizationLoads.get(accountId);
  const loading = accounts(c).then(data => {
    const cachedAt = Date.now();
    const entry = { data, cachedAt, expiresAt: cachedAt + organizationCacheTtlMs };
    organizationCache.set(accountId, entry);
    return cachedResponse(entry, false);
  }).catch(error => {
    if (cached) return { ...cachedResponse(cached, true, true), cacheWarning: errorMessage(error) };
    throw error;
  }).finally(() => organizationLoads.delete(accountId));
  organizationLoads.set(accountId, loading);
  return loading;
}
function invalidateOrganizationCache(accountId) { organizationCache.delete(accountId); }
app.post('/api/connect', async (req, res) => {
  try {
    const { name, region, accessKeyId, secretAccessKey } = req.body;
    if (!name || !accessKeyId || !secretAccessKey) return res.status(400).json({ error: '请填写账号名称、Access Key 和 Secret Key' });
    const c = { name, region: region || 'us-east-1', accessKeyId, secretAccessKey };
    const identity = await stsClient(c).send(new GetCallerIdentityCommand({}));
    await client(c).send(new DescribeOrganizationCommand({}));
    const id = identity.Account;
    await saveConnection(id, c);
    const saved = await db.send(new GetCommand({ TableName: tableName, Key: { accountId: id } }));
    c.temporaryOuId = saved.Item?.temporaryOuId || null;
    c.blockedOuId = saved.Item?.blockedOuId || null;
    c.ouConfigured = saved.Item?.ouConfigured === true;
    connections.set(id, c);
    invalidateOrganizationCache(id);
    res.json({ id, accountId: identity.Account, accountName: name });
  } catch (e) { res.status(400).json({ error: errorMessage(e) }); }
});
app.get('/api/connections', async (_, res) => { try { const result = await db.send(new ScanCommand({ TableName: tableName, ProjectionExpression: 'accountId, #n, #r, #s, updatedAt, lastScanAt, lastScanMoved', ExpressionAttributeNames: { '#n': 'name', '#r': 'region', '#s': 'status' } })); res.json({ connections: result.Items || [] }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.put('/api/connections/:id', async (req, res) => {
  try {
    const accountId = req.params.id;
    const name = String(req.body.name || '').trim();
    const accessKeyId = String(req.body.accessKeyId || '').trim();
    const secretAccessKey = String(req.body.secretAccessKey || '').trim();
    if (!name) return res.status(400).json({ error: '请填写账号名称' });
    if ((accessKeyId && !secretAccessKey) || (!accessKeyId && secretAccessKey)) return res.status(400).json({ error: '更新密钥时必须同时填写 Access Key 和 Secret Key' });
    const existing = await loadConnection(accountId);
    if (!existing) return res.status(404).json({ error: '连接不存在' });
    const updated = { ...existing, name };
    if (accessKeyId && secretAccessKey) {
      updated.accessKeyId = accessKeyId;
      updated.secretAccessKey = secretAccessKey;
      const identity = await stsClient(updated).send(new GetCallerIdentityCommand({}));
      if (identity.Account !== accountId) return res.status(400).json({ error: `这组密钥属于账号 ${identity.Account}，与当前账号 ${accountId} 不一致` });
      await client(updated).send(new DescribeOrganizationCommand({}));
      await saveConnection(accountId, updated);
    } else {
      await db.send(new UpdateCommand({ TableName: tableName, Key: { accountId }, UpdateExpression: 'SET #n = :name, updatedAt = :updatedAt', ExpressionAttributeNames: { '#n': 'name' }, ExpressionAttributeValues: { ':name': name, ':updatedAt': new Date().toISOString() } }));
    }
    connections.set(accountId, updated);
    invalidateOrganizationCache(accountId);
    res.json({ ok: true, accountId, name });
  } catch (e) { res.status(400).json({ error: errorMessage(e) }); }
});
app.delete('/api/connections/:id', async (req, res) => {
  try {
    const accountId = req.params.id;
    const result = await db.send(new GetCommand({ TableName: tableName, Key: { accountId } }));
    if (!result.Item) return res.status(404).json({ error: '连接不存在' });
    await db.send(new DeleteCommand({ TableName: tableName, Key: { accountId } }));
    try {
      await secrets.send(new DeleteSecretCommand({ SecretId: result.Item.secretArn || `org-ou-manager/${accountId}`, ForceDeleteWithoutRecovery: true }));
    } catch (error) {
      if (error.name !== 'ResourceNotFoundException') throw error;
    }
    connections.delete(accountId);
    invalidateOrganizationCache(accountId);
    res.json({ ok: true, accountId });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/accounts/:id', async (req, res) => { try { const c = await loadConnection(req.params.id); if (!c) return res.status(404).json({ error: '连接不存在' }); res.json(await organizationData(req.params.id, c, req.query.refresh === '1')); } catch (e) { res.status(400).json({ error: errorMessage(e) }); } });
app.put('/api/connections/:id/ou-config', async (req, res) => {
  try {
    const accountId = req.params.id;
    const blockedOuId = String(req.body.blockedOuId || '').trim();
    const temporaryOuId = String(req.body.temporaryOuId || '').trim() || null;
    if (!blockedOuId) return res.status(400).json({ error: '请选择“禁止 SP/RI”对应的 OU' });
    if (temporaryOuId && temporaryOuId === blockedOuId) return res.status(400).json({ error: '临时 OU 和禁止 SP/RI OU 不能相同' });
    const c = await loadConnection(accountId);
    if (!c) return res.status(404).json({ error: '连接不存在' });
    const data = await organizationData(accountId, c, false);
    const validIds = new Set((data.availableOus || []).map(ou => ou.Id));
    if (!validIds.has(blockedOuId) || (temporaryOuId && !validIds.has(temporaryOuId))) return res.status(400).json({ error: '选择的 OU 不属于当前组织，请刷新后重试' });
    await db.send(new UpdateCommand({
      TableName: tableName,
      Key: { accountId },
      UpdateExpression: 'SET blockedOuId = :blocked, temporaryOuId = :temporary, ouConfigured = :configured, updatedAt = :updatedAt',
      ExpressionAttributeValues: { ':blocked': blockedOuId, ':temporary': temporaryOuId, ':configured': true, ':updatedAt': new Date().toISOString() }
    }));
    c.blockedOuId = blockedOuId;
    c.temporaryOuId = temporaryOuId;
    c.ouConfigured = true;
    invalidateOrganizationCache(accountId);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: errorMessage(e) }); }
});
app.post('/api/move', async (req, res) => {
  try { const { connectionId, accountId, destinationParentId } = req.body; const c = await loadConnection(connectionId); if (!c) return res.status(404).json({ error: '连接不存在' }); const parents = await client(c).send(new ListParentsCommand({ ChildId: accountId })); const sourceParentId = parents.Parents?.[0]?.Id; if (!sourceParentId) throw new Error('找不到账号当前所在的 Root/OU'); await client(c).send(new MoveAccountCommand({ AccountId: accountId, SourceParentId: sourceParentId, DestinationParentId: destinationParentId })); invalidateOrganizationCache(connectionId); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
async function scanConnection(connectionId) {
    const c = await loadConnection(connectionId);
    if (!c) throw new Error('连接不存在');
    const data = await accounts(c);
    const managementId = data.organization?.ManagementAccountId || data.organization?.MasterAccountId;
    const targets = data.accounts.filter(a => ['未分组', '临时'].includes(a.Group) && a.Id !== managementId);
    if (!data.targetOus.blocked?.Id) throw new Error('请先确认“禁止 SP/RI”对应的 OU');
    const orgClient = client(c);
    const moved = [];
    for (const account of targets) {
      await orgClient.send(new MoveAccountCommand({ AccountId: account.Id, SourceParentId: account.ParentId, DestinationParentId: data.targetOus.blocked.Id }));
      moved.push(account.Id);
    }
    await db.send(new UpdateCommand({ TableName: tableName, Key: { accountId: connectionId }, UpdateExpression: 'SET lastScanAt = :time, lastScanMoved = :count', ExpressionAttributeValues: { ':time': new Date().toISOString(), ':count': moved.length } }));
    invalidateOrganizationCache(connectionId);
    return { ok: true, moved, count: moved.length };
}
app.post('/api/scan', async (req, res) => {
  try {
    res.json(await scanConnection(req.body.connectionId));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/bootstrap-command', (_, res) => res.json({ command: policy }));
async function runDailyScans() {
  try {
    const result = await db.send(new ScanCommand({ TableName: tableName, ProjectionExpression: 'accountId, #s', ExpressionAttributeNames: { '#s': 'status' } }));
    for (const item of result.Items || []) {
      if (item.status !== 'CONNECTED') continue;
      try { await scanConnection(item.accountId); }
      catch (error) { console.error(`Daily scan failed for ${item.accountId}:`, errorMessage(error)); }
    }
  } catch (error) { console.error('Daily organization scan failed:', error.message); }
}
function millisecondsUntilShanghaiMidnight() {
  const now = new Date();
  const shanghaiNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const nextRun = new Date(shanghaiNow);
  nextRun.setHours(24, 0, 0, 0);
  return nextRun.getTime() - shanghaiNow.getTime();
}
function scheduleDailyScan() {
  const delay = millisecondsUntilShanghaiMidnight();
  const nextRun = new Date(Date.now() + delay).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  console.log(`Next automatic scan: ${nextRun} Asia/Shanghai`);
  setTimeout(async () => { await runDailyScans(); scheduleDailyScan(); }, delay).unref();
}
scheduleDailyScan();
app.listen(process.env.PORT || 3000, () => console.log(`Org OU Manager: http://localhost:${process.env.PORT || 3000}`));
