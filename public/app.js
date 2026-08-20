const $ = (id) => document.getElementById(id);
const state = { connections: [], connectionId: null, accounts: [], stats: {}, targetOus: {}, filter: '全部', loading: false };

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
function openModal() { $('modal').hidden = false; $('nameInput').focus(); }
function closeModal() { $('modal').hidden = true; $('formMessage').textContent = ''; }

async function api(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}

async function loadConnections(preferredId) {
  try {
    const data = await api('/api/connections');
    state.connections = data.connections || [];
    renderConnectionSelect();
    if (!state.connections.length) { renderNoConnection(); openModal(); return; }
    const stored = preferredId || localStorage.getItem('selectedOrganization');
    state.connectionId = state.connections.some(item => item.accountId === stored) ? stored : state.connections[0].accountId;
    $('connectionSelect').value = state.connectionId;
    await loadOrganization();
  } catch (error) { renderFatal(error.message); }
}
function renderConnectionSelect() {
  $('connectionSelect').innerHTML = state.connections.length
    ? state.connections.map(item => `<option value="${escapeHtml(item.accountId)}">${escapeHtml(item.name)} · ${escapeHtml(item.accountId)}</option>`).join('')
    : '<option value="">尚未添加主账号</option>';
}
async function loadOrganization() {
  if (!state.connectionId) return;
  setLoading(true);
  try {
    const data = await api(`/api/accounts/${state.connectionId}`);
    state.accounts = data.accounts || []; state.stats = data.stats || {}; state.targetOus = data.targetOus || {};
    localStorage.setItem('selectedOrganization', state.connectionId);
    render(data);
  } catch (error) { renderFatal(error.message); }
  finally { setLoading(false); }
}

function render(data) {
  const connection = state.connections.find(item => item.accountId === state.connectionId);
  $('pageTitle').textContent = connection?.name || '组织账号';
  $('pageSubtitle').textContent = `管理账号 ${state.connectionId} · ${state.accounts.length} 个组织成员 · 每天 24:00 自动归档`;
  $('totalCount').textContent = state.stats.total ?? 0;
  $('blockedCount').textContent = state.stats.blocked ?? 0;
  $('temporaryCount').textContent = state.stats.temporary ?? 0;
  $('lastSync').textContent = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  $('blockedOuCount').textContent = state.stats.blocked ?? 0;
  $('temporaryOuCount').textContent = state.stats.temporary ?? 0;
  $('blockedOuId').textContent = state.targetOus.blocked?.Id || '未找到“禁止 SP/RI”OU';
  $('temporaryOuId').textContent = state.targetOus.temporary?.Id || '未找到“临时”OU';
  renderPending(); renderAccounts();
}
function pendingAccounts() { return state.accounts.filter(account => ['未分组', '临时'].includes(account.Group) && !account.IsManagement); }
function renderPending() {
  const pending = pendingAccounts();
  $('pendingCount').textContent = pending.length; $('pendingBadge').textContent = pending.length;
  $('attentionCard').classList.toggle('resolved', pending.length === 0);
  $('attentionCard').querySelector('.attention-icon').textContent = pending.length ? '!' : '✓';
  $('attentionCard').querySelector('.attention-copy strong').innerHTML = pending.length
    ? `<span id="pendingCount">${pending.length}</span> 个账号等待归入禁止 SP/RI`
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
  if (!name || !accessKeyId || !secretAccessKey) { $('formMessage').className = 'form-message error'; $('formMessage').textContent = '请把三个字段填写完整'; return; }
  $('connectButton').disabled = true; $('connectButton').textContent = '正在验证 AWS 权限…';
  try {
    const data = await api('/api/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, accessKeyId, secretAccessKey, region: 'us-east-1' }) });
    closeModal(); $('nameInput').value = $('accessKeyInput').value = $('secretKeyInput').value = '';
    await loadConnections(data.id); toast(`已连接 ${data.accountName}`);
  } catch (error) { $('formMessage').className = 'form-message error'; $('formMessage').textContent = error.message; }
  finally { $('connectButton').disabled = false; $('connectButton').textContent = '验证并保存连接'; }
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

$('addAccountButton').addEventListener('click', openModal);
$('closeModalButton').addEventListener('click', closeModal);
$('copyCommandButton').addEventListener('click', copyCommand);
$('connectButton').addEventListener('click', connectAccount);
$('refreshButton').addEventListener('click', loadOrganization);
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
$('modal').addEventListener('click', event => { if (event.target === $('modal')) closeModal(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('modal').hidden) closeModal(); });

loadConnections();
