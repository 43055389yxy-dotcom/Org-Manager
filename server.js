import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OrganizationsClient, DescribeOrganizationCommand, DescribeOrganizationalUnitCommand, ListAccountsCommand, ListChildrenCommand, ListParentsCommand, ListRootsCommand, MoveAccountCommand } from '@aws-sdk/client-organizations';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, CreateSecretCommand, GetSecretValueCommand, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const app = express();
app.use(express.json());
app.get('/health', (_, res) => res.json({ ok: true, service: 'org-manager', time: new Date().toISOString() }));
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
app.use(express.static(publicDir));
const connections = new Map();
const dataRegion = process.env.APP_DATA_REGION || 'us-east-1';
const tableName = process.env.ORG_ACCOUNTS_TABLE || 'OrgOuAccounts';
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: dataRegion }));
const secrets = new SecretsManagerClient({ region: dataRegion });
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

function client(c) { return new OrganizationsClient({ region: c.region || 'us-east-1', credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey } }); }
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
  await db.send(new PutCommand({ TableName: tableName, Item: { accountId, name: c.name, region: c.region, secretArn, status: 'CONNECTED', updatedAt: new Date().toISOString() } }));
}
async function loadConnection(accountId) {
  if (connections.has(accountId)) return connections.get(accountId);
  const result = await db.send(new GetCommand({ TableName: tableName, Key: { accountId } }));
  if (!result.Item) return null;
  const secret = await secrets.send(new GetSecretValueCommand({ SecretId: result.Item.secretArn }));
  const credentials = JSON.parse(secret.SecretString);
  const c = { name: result.Item.name, region: result.Item.region || credentials.region || 'us-east-1', accessKeyId: credentials.accessKeyId, secretAccessKey: credentials.secretAccessKey };
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
  const temporaryOu = allOus.find(ou => ou.Name?.trim() === '临时');
  const blockedOu = allOus.find(ou => ['禁止SP/RI', '禁止 SP/RI'].includes(ou.Name?.replace(/\s+/g, ' ').trim()));
  const managementId = org.Organization?.ManagementAccountId || org.Organization?.MasterAccountId;
  const out = []; let token;
  do { const r = await orgClient.send(new ListAccountsCommand({ NextToken: token })); out.push(...(r.Accounts || [])); token = r.NextToken; } while (token);
  const enriched = [];
  for (let i = 0; i < out.length; i += 10) {
    const batch = await Promise.all(out.slice(i, i + 10).map(async (account) => {
      const result = await orgClient.send(new ListParentsCommand({ ChildId: account.Id }));
      const parent = result.Parents?.[0];
      let group = '其他 OU';
      if (parent?.Type === 'ROOT') group = '未分组';
      if (parent?.Id === temporaryOu?.Id) group = '临时';
      if (parent?.Id === blockedOu?.Id) group = '禁止 SP/RI';
      return { ...account, ParentId: parent?.Id, ParentType: parent?.Type, Group: group, IsManagement: account.Id === managementId };
    }));
    enriched.push(...batch);
  }
  return { organization: org.Organization, accounts: enriched, targetOus: { temporary: temporaryOu || null, blocked: blockedOu || null }, stats: {
    total: enriched.length,
    temporary: enriched.filter(a => a.Group === '临时').length,
    blocked: enriched.filter(a => a.Group === '禁止 SP/RI').length,
    ungrouped: enriched.filter(a => a.Group === '未分组' && !a.IsManagement).length,
    actionable: enriched.filter(a => ['未分组', '临时'].includes(a.Group) && !a.IsManagement).length
  } };
}
app.post('/api/connect', async (req, res) => {
  try {
    const { name, region, accessKeyId, secretAccessKey } = req.body;
    if (!name || !accessKeyId || !secretAccessKey) return res.status(400).json({ error: '请填写账号名称、Access Key 和 Secret Key' });
    const c = { name, region: region || 'us-east-1', accessKeyId, secretAccessKey };
    const identity = await new STSClient({ region: c.region, credentials: { accessKeyId, secretAccessKey } }).send(new GetCallerIdentityCommand({}));
    const data = await accounts(c); const id = identity.Account; connections.set(id, c);
    await saveConnection(id, c);
    res.json({ id, accountId: identity.Account, accountName: name, ...data });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/connections', async (_, res) => { try { const result = await db.send(new ScanCommand({ TableName: tableName, ProjectionExpression: 'accountId, #n, #r, #s, updatedAt, lastScanAt, lastScanMoved', ExpressionAttributeNames: { '#n': 'name', '#r': 'region', '#s': 'status' } })); res.json({ connections: result.Items || [] }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get('/api/accounts/:id', async (req, res) => { try { const c = await loadConnection(req.params.id); if (!c) return res.status(404).json({ error: '连接不存在' }); res.json(await accounts(c)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/move', async (req, res) => {
  try { const { connectionId, accountId, destinationParentId } = req.body; const c = await loadConnection(connectionId); if (!c) return res.status(404).json({ error: '连接不存在' }); const parents = await client(c).send(new ListParentsCommand({ ChildId: accountId })); const sourceParentId = parents.Parents?.[0]?.Id; if (!sourceParentId) throw new Error('找不到账号当前所在的 Root/OU'); await client(c).send(new MoveAccountCommand({ AccountId: accountId, SourceParentId: sourceParentId, DestinationParentId: destinationParentId })); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
async function scanConnection(connectionId) {
    const c = await loadConnection(connectionId);
    if (!c) throw new Error('连接不存在');
    const data = await accounts(c);
    const managementId = data.organization?.ManagementAccountId || data.organization?.MasterAccountId;
    const targets = data.accounts.filter(a => ['未分组', '临时'].includes(a.Group) && a.Id !== managementId);
    if (!data.targetOus.blocked?.Id) throw new Error('没有找到名为“禁止SP/RI”的 OU');
    const orgClient = client(c);
    const moved = [];
    for (const account of targets) {
      await orgClient.send(new MoveAccountCommand({ AccountId: account.Id, SourceParentId: account.ParentId, DestinationParentId: data.targetOus.blocked.Id }));
      moved.push(account.Id);
    }
    await db.send(new UpdateCommand({ TableName: tableName, Key: { accountId: connectionId }, UpdateExpression: 'SET lastScanAt = :time, lastScanMoved = :count', ExpressionAttributeValues: { ':time': new Date().toISOString(), ':count': moved.length } }));
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
      if (item.status === 'CONNECTED') await scanConnection(item.accountId);
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
