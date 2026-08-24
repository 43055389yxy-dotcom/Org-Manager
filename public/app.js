const $ = (id) => document.getElementById(id);
const state = { connections: [], connectionId: null, accounts: [], stats: {}, targetOus: {}, filter: '全部', loading: false, modalMode: 'add', editingId: null };

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
}
function initials(name = '') { return name.trim().slice(0, 1).toUpperCase() || 'A'; }
function toast(message) {
  $('toast').textContent = message; $('toast').classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').classList.remove('show'), 2600);
}
function setLoading(value) {
  state.loading = value; document.body.classList.toggle('loading', value); $('refreshButton').disabled = value;
}
function clearConnectionForm() {
  $('nameInput').value = $('accessKeyInput').value = $('secretKeyInput').value = '';
  $('formMessage').textContent = ''; $('copyStatus').textContent = ''; $('copyCommandButton').textContent = '复制命令';
}
function openAddModal() {
  state.modalMode = 'add'; state.editingId = null; clearConnectionForm();
  $('modalEyebrow').textContent = '添加连接'; $('modalTitle').textContent = '连接 AWS 管理账号';
  $('modalIntro').textContent = '只需两步。密钥会加密保存在 AWS Secrets Manager，不会保存在浏览器。';
  $('authorizationStep').hidden = false; $('formTitle').textContent = '粘贴执行结果中的连接信息';
  $('accessKeyOptional').textContent = $('secretKeyOptional').textContent = '';
  $('connectButton').textContent = '验证并保存连接'; $('modal').hidden = false; $('nameInput').focus();
}
function openEditModal(accountId) {
  const connection = state.connections.find(item => item.accountId === accountId); if (!connection) return;
  state.modalMode = 'edit'; state.editingId = accountId; clearConnectionForm();
  $('modalEyebrow').textContent = '编辑连接'; $('modalTitle').textContent = `编辑 ${connection.name}`;
  $('modalIntro').textContent = `账号 ID：${accountId}。只改名称时，AK/SK 留空即可；填写新密钥时会重新验证。`;
  $('authorizationStep').hidden = true; $('formTitle').textContent = '修改连接信息'; $('nameInput').value = connection.name || '';
  $('accessKeyOptional').textContent = $('secretKeyOptional').textContent = '（不修改请留空）';
  $('connectButton').textContent = '保存修改'; $('managerModal').hidden = true; $('modal').hidden = false; $('nameInput').focus();
}
function closeModal() { $('modal').hidden = true; $('formMessage').textContent = ''; }
function openManager() { renderManagedAccounts(); $('managerModal').hidden = false; }
function closeManager() { $('managerModal').hidden = true; }

async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}

async function loadConnections(preferredId, loadDetails = true) {
  try {
    const data = await api('/api/connections');
    state.connections = data.connections || [];
    renderConnectionSelect();
    if (!state.connections.length) { state.connectionId = null; renderNoConnection(); openAddModal(); return; }
    const stored = preferredId || localStorage.getItem('selectedOrganization');
    state.connectionId = state.connections.some(item => item.accountId === stored) ? stored : state.connections[0].accountId;
    $('connectionSelect').value = state.connectionId;
    if (loadDetails) await loadOrganization(); else renderConnectionSaved();
  } catch (error) { renderFatal(error.message); }
}
function renderConnectionSaved() {
  const connection = state.connections.find(item => item.accountId === state.connectionId);
  state.accounts = []; state.stats = {}; state.targetOus = {};
  $('pageTitle').textContent = connection?.name || '组织账号';
  $('pageSubtitle').textContent = `管理账号 ${state.connectionId} · 连接已保存，可以继续添加其他账号`;
  $('totalCount').textContent = $('blockedCount').textContent = $('temporaryCount').textContent = '—'; $('lastSync').textContent = '等待刷新';
  $('pendingBadge').textContent = '—'; $('scanButton').hidden = true;
  $('attentionCard').classList.add('resolved'); $('attentionCard').querySelector('.attention-icon').textContent = '✓';
  $('attentionTitle').textContent = '连接和密钥已经安全保存';
  $('attentionCard').querySelector('.attention-copy p').textContent = '可以继续批量添加；需要查看成员时，点击右上角刷新按钮。';
  $('pendingList').innerHTML = '<div class="empty-state">连接已保存，刷新后读取组织成员</div>';
  $('accountList').innerHTML = '<div class="empty-state">点击右上角刷新读取组织成员</div>';
  $('blockedOuId').textContent = $('temporaryOuId').textContent = '等待刷新';
  $('blockedOuCount').textContent = $('temporaryOuCount').textContent = '—';
}
function renderConnectionSelect() {
  $('connectionSelect').innerHTML = state.connections.length
    ? state.connections.map(item => `<option value="${escapeHtml(item.accountId)}">${escapeHtml(item.name)} · ${escapeHtml(item.accountId)}</option>`).join('')
    : '<option value="">尚未添加主账号</option>';
  $('manageAccountButton').disabled = state.connections.length === 0;
  renderManagedAccounts();
}
function renderManagedAccounts() {
  $('managedAccountList').innerHTML = state.connections.length ? state.connections.map(item => `
    <div class="managed-account-row">
      <span class="avatar">${escapeHtml(initials(item.name))}</span>
      <div class="row-main"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.accountId)}</small></div>
      <button class="button secondary compact edit-connection" data-account-id="${escapeHtml(item.accountId)}" type="button">编辑</button>
      <button class="button danger compact delete-connection" data-account-id="${escapeHtml(item.accountId)}" type="button">删除</button>
    </div>`).join('') : '<div class="empty-state">还没有添加主账号</div>';
}
async function loadOrganization(forceRefresh = false) {
  if (!state.connectionId) return;
  setLoading(true);
  try {
    const data = await api(`/api/accounts/${state.connectionId}${forceRefresh ? '?refresh=1' : ''}`);
    state.accounts = data.accounts || []; state.stats = data.stats || {}; state.targetOus = data.targetOus || {};
    localStorage.setItem('selectedOrganization', state.connectionId);
    render(data);
    if (data.cacheWarning) toast(`已显示缓存：${data.cacheWarning}`);
  } catch (error) { renderFatal(error.message); }
  finally { setLoading(false); }
}

function render(data) {
  const connection = state.connections.find(item => item.accountId === state.connectionId);
  $('pageTitle').textContent = connection?.name || '组织账号';
  const cacheTime = data.cache?.cachedAt ? new Date(data.cache.cachedAt) : new Date();
  const cacheLabel = data.cache?.hit ? `缓存于 ${cacheTime.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '刚刚更新';
  $('pageSubtitle').textContent = `管理账号 ${state.connectionId} · ${state.accounts.length} 个组织成员 · ${cacheLabel} · 每天 24:00 自动归档`;
  $('totalCount').textContent = state.stats.total ?? 0;
  $('blockedCount').textContent = state.stats.blocked ?? 0;
  $('temporaryCount').textContent = state.stats.temporary ?? 0;
  $('lastSync').textContent = cacheTime.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  $('blockedOuCount').textContent = state.stats.blocked ?? 0;
  $('temporaryOuCount').textContent = state.stats.temporary ?? 0;
  $('blockedOuId').textContent = state.targetOus.blocked?.Id || '未找到“禁止 SP/RI”OU';
  $('temporaryOuId').textContent = state.targetOus.temporary?.Id || '未找到“临时”OU';
  renderPending(); renderAccounts();
}
function pendingAccounts() { return state.accounts.filter(account => ['未分组', '临时'].includes(account.Group) && !account.IsManagement); }
function renderPending() {
  const pending = pendingAccounts();
  $('pendingBadge').textContent = pending.length;
  $('attentionCard').classList.toggle('resolved', pending.length === 0);
  $('attentionCard').querySelector('.attention-icon').textContent = pending.length ? '!' : '✓';
  $('attentionTitle').textContent = pending.length
    ? `${pending.length} 个账号等待归入禁止 SP/RI`
    : '所有成员账号都已完成分组';
  $('attentionCard').querySelector('.attention-copy p').textContent = pending.length
    ? '包括“临时”OU 和 Root 下未分组的成员账号。'
    : '系统会在每天北京时间 24:00 检查新加入和临时分组的成员账号。';
  $('scanButton').hidden = pending.length === 0;
  $('pendingList').innerHTML = pending.length ? pending.map(account => `
    <div class="pending-row">
      <span class="avatar">${escapeHtml(initials(account.Name))}</span>
      <div class="row-main"><strong>${escapeHtml(account.Name || '未命名账号')}</strong><small>${escapeHtml(account.Group)} · ${escapeHtml(account.Id)} · ${escapeHtml(account.Email || '')}</small></div>
      <button class="mini-action move-one" data-account-id="${escapeHtml(account.Id)}" type="button">移入禁止 SP/RI</button>
    </div>`).join('') : '<div class="empty-state">当前没有需要处理的账号</div>';
}
function renderAccounts() {
  const query = $('searchInput').value.trim().toLowerCase();
  const items = state.accounts.filter(account => {
    const filterMatch = state.filter === '全部' || account.Group === state.filter;
    const queryMatch = `${account.Name || ''} ${account.Email || ''} ${account.Id || ''}`.toLowerCase().includes(query);
    return filterMatch && queryMatch;
  });
  $('accountList').innerHTML = items.length ? items.map(account => {
    const statusClass = account.Group === '禁止 SP/RI' ? 'blocked' : account.Group === '未分组' ? 'pending' : account.Group === '临时' ? 'temp' : 'other';
    const management = account.IsManagement ? ' · 管理账号' : '';
    const options = [`<option value="">调整分组…</option>`];
    if (state.targetOus.blocked?.Id && account.ParentId !== state.targetOus.blocked.Id) options.push(`<option value="${escapeHtml(state.targetOus.blocked.Id)}">移到禁止 SP/RI</option>`);
    if (state.targetOus.temporary?.Id && account.ParentId !== state.targetOus.temporary.Id) options.push(`<option value="${escapeHtml(state.targetOus.temporary.Id)}">移到临时</option>`);
    return `<div class="account-row">
      <div class="row-main"><strong>${escapeHtml(account.Name || '未命名账号')}</strong><small>${escapeHtml(account.Email || '')}${management}</small></div>
      <span class="account-id">${escapeHtml(account.Id)}</span>
      <span class="status ${statusClass}">${escapeHtml(account.Group || '未知')}</span>
      ${account.IsManagement ? '<span></span>' : `<select class="move-select" data-account-id="${escapeHtml(account.Id)}">${options.join('')}</select>`}
    </div>`;
  }).join('') : '<div class="empty-state">没有符合条件的账号</div>';
}
function renderNoConnection() {
  $('pageTitle').textContent = '添加第一个管理账号'; $('pageSubtitle').textContent = '连接 AWS Organizations 后，系统会自动识别成员账号。';
  $('totalCount').textContent = $('blockedCount').textContent = $('temporaryCount').textContent = '—';
  $('pendingList').innerHTML = '<div class="empty-state">尚未连接组织</div>'; $('accountList').innerHTML = '<div class="empty-state">尚未连接组织</div>';
}
function renderFatal(message) {
  $('accountList').innerHTML = `<div class="error-state">读取失败：${escapeHtml(message)}</div>`;
  toast(`读取失败：${message}`);
}

async function copyCommand() {
  try {
    const { command } = await api('/api/bootstrap-command');
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(command);
    else { const area = document.createElement('textarea'); area.value = command; document.body.appendChild(area); area.select(); document.execCommand('copy'); area.remove(); }
    $('copyStatus').textContent = '✓ 已复制，去 CloudShell 粘贴执行即可';
    $('copyCommandButton').textContent = '已复制';
  } catch (error) { $('copyStatus').textContent = `复制失败：${error.message}`; }
}
async function connectAccount() {
  const name = $('nameInput').value.trim(), accessKeyId = $('accessKeyInput').value.trim(), secretAccessKey = $('secretKeyInput').value.trim();
  if (!name || (state.modalMode === 'add' && (!accessKeyId || !secretAccessKey))) { $('formMessage').className = 'form-message error'; $('formMessage').textContent = state.modalMode === 'add' ? '请把三个字段填写完整' : '请填写账号名称'; return; }
  if ((accessKeyId && !secretAccessKey) || (!accessKeyId && secretAccessKey)) { $('formMessage').className = 'form-message error'; $('formMessage').textContent = '更新密钥时，AK 和 SK 必须同时填写'; return; }
  const editing = state.modalMode === 'edit';
  $('connectButton').disabled = true; $('connectButton').textContent = accessKeyId ? '正在验证 AWS 权限…' : '正在保存…';
  try {
    const data = editing
      ? await api(`/api/connections/${state.editingId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, accessKeyId, secretAccessKey }) })
      : await api('/api/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, accessKeyId, secretAccessKey, region: 'us-east-1' }) });
    const selectedId = editing ? state.editingId : data.id;
    closeModal(); clearConnectionForm(); await loadConnections(selectedId, editing); toast(editing ? '账号连接已更新' : `已保存 ${data.accountName}，可以继续添加`);
  } catch (error) { $('formMessage').className = 'form-message error'; $('formMessage').textContent = error.message; }
  finally { $('connectButton').disabled = false; $('connectButton').textContent = editing ? '保存修改' : '验证并保存连接'; }
}
async function deleteConnection(accountId) {
  const connection = state.connections.find(item => item.accountId === accountId); if (!connection) return;
  if (!confirm(`确认删除“${connection.name}”（${accountId}）？\n\n这会删除保存的连接和 AK/SK，不会删除 AWS 账号本身。`)) return;
  try {
    await api(`/api/connections/${accountId}`, { method: 'DELETE' });
    closeManager(); localStorage.removeItem('selectedOrganization');
    await loadConnections(); toast(`已删除 ${connection.name}`);
  } catch (error) { toast(`删除失败：${error.message}`); }
}
async function moveAccount(accountId, destinationParentId, destinationName) {
  if (!destinationParentId) return;
  if (!confirm(`确认把账号 ${accountId} 移到“${destinationName}”？`)) { renderAccounts(); return; }
  try {
    await api('/api/move', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connectionId: state.connectionId, accountId, destinationParentId }) });
    toast('账号分组已更新'); await loadOrganization();
  } catch (error) { toast(`移动失败：${error.message}`); renderAccounts(); }
}
async function scanUngrouped() {
  const count = pendingAccounts().length;
  if (!count || !confirm(`确认把“临时”和“未分组”中的 ${count} 个账号全部移到“禁止 SP/RI”？`)) return;
  $('scanButton').disabled = true; $('scanButton').textContent = '正在处理…';
  try {
    const data = await api('/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connectionId: state.connectionId }) });
    toast(`已处理 ${data.count} 个账号`); await loadOrganization();
  } catch (error) { toast(`处理失败：${error.message}`); }
  finally { $('scanButton').disabled = false; $('scanButton').textContent = '全部移入禁止 SP/RI'; }
}

$('addAccountButton').addEventListener('click', openAddModal);
$('manageAccountButton').addEventListener('click', openManager);
$('closeModalButton').addEventListener('click', closeModal);
$('closeManagerButton').addEventListener('click', closeManager);
$('managerAddButton').addEventListener('click', () => { closeManager(); openAddModal(); });
$('copyCommandButton').addEventListener('click', copyCommand);
$('connectButton').addEventListener('click', connectAccount);
$('refreshButton').addEventListener('click', () => loadOrganization(true));
$('scanButton').addEventListener('click', scanUngrouped);
$('connectionSelect').addEventListener('change', event => { state.connectionId = event.target.value; loadOrganization(); });
$('searchInput').addEventListener('input', renderAccounts);
$('filters').addEventListener('click', event => {
  const button = event.target.closest('.filter'); if (!button) return;
  state.filter = button.dataset.filter; document.querySelectorAll('.filter').forEach(item => item.classList.toggle('active', item === button)); renderAccounts();
});
$('pendingList').addEventListener('click', event => {
  const button = event.target.closest('.move-one'); if (!button) return;
  moveAccount(button.dataset.accountId, state.targetOus.blocked?.Id, '禁止 SP/RI');
});
$('accountList').addEventListener('change', event => {
  const select = event.target.closest('.move-select'); if (!select) return;
  moveAccount(select.dataset.accountId, select.value, select.options[select.selectedIndex].text.replace('移到', '').trim());
});
$('managedAccountList').addEventListener('click', event => {
  const editButton = event.target.closest('.edit-connection');
  if (editButton) { openEditModal(editButton.dataset.accountId); return; }
  const deleteButton = event.target.closest('.delete-connection');
  if (deleteButton) deleteConnection(deleteButton.dataset.accountId);
});
$('modal').addEventListener('click', event => { if (event.target === $('modal')) closeModal(); });
$('managerModal').addEventListener('click', event => { if (event.target === $('managerModal')) closeManager(); });
document.addEventListener('keydown', event => { if (event.key !== 'Escape') return; if (!$('modal').hidden) closeModal(); else if (!$('managerModal').hidden) closeManager(); });

loadConnections();
