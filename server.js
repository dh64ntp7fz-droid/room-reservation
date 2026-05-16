const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3456;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const WECOM_WEBHOOK_URL = process.env.WECOM_WEBHOOK_URL || '';

// SMS 配置
const SMS_SECRET_ID = process.env.SMS_SECRET_ID || '';
const SMS_SECRET_KEY = process.env.SMS_SECRET_KEY || '';
const SMS_SDK_APP_ID = process.env.SMS_SDK_APP_ID || '';
const SMS_SIGN_NAME = process.env.SMS_SIGN_NAME || '湘阁里辣';
const SMS_TEMPLATE_ID = process.env.SMS_TEMPLATE_ID || '';

if (DATA_DIR !== __dirname && !fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let clients = [];
let lastResetDate = '';

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ── 密码哈希 ──
function hashPassword(pw) {
  return crypto.createHash('sha256').update('xglr_' + pw).digest('hex');
}
function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ── 数据加载/保存 ──
function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const data = JSON.parse(raw);
    // 旧格式迁移：检查是否有 stores 字段
    if (!data.stores) return migrateData(data);
    return data;
  } catch {
    return initData();
  }
}

function migrateData(oldData) {
  // 旧格式 {"bookings": [...]} → 新格式多门店结构
  const defaultTables = [
    {name:'爱晚亭',category:'包间'},{name:'东江湖',category:'包间'},{name:'岳麓山',category:'包间'},
    {name:'橘子洲',category:'包间'},{name:'桃花源',category:'包间'},{name:'洞庭湖',category:'包间'},
    {name:'B16',category:'大厅'},{name:'B15',category:'大厅'},{name:'B13',category:'大厅'},
    {name:'A10',category:'大厅'},{name:'A11',category:'大厅'},{name:'A12',category:'大厅'}
  ];
  const oldBookings = oldData.bookings || [];
  const newData = {
    stores: {
      dalang: {
        id:'dalang', name:'大朗环球店', tables:defaultTables, bookings:[],
        history: oldBookings.map(b=>({...b, status:'migrated', archivedAt:new Date().toISOString()}))
      }
    },
    users: {
      xgll2122: {
        username:'xgll2122', passwordHash:hashPassword('2122'), store:'dalang',
        role:'admin', createdAt:new Date().toISOString()
      }
    },
    tokens:{},
    meta:{lastReset:getDateString()}
  };
  saveData(newData);
  console.log('🔄 旧数据迁移: ' + oldBookings.length + ' 条预订 → 历史');
  return newData;
}

function initData() {
  const defaultTables = [
    { name: '爱晚亭', category: '包间' },
    { name: '东江湖', category: '包间' },
    { name: '岳麓山', category: '包间' },
    { name: '橘子洲', category: '包间' },
    { name: '桃花源', category: '包间' },
    { name: '洞庭湖', category: '包间' },
    { name: 'B16', category: '大厅' },
    { name: 'B15', category: '大厅' },
    { name: 'B13', category: '大厅' },
    { name: 'A10', category: '大厅' },
    { name: 'A11', category: '大厅' },
    { name: 'A12', category: '大厅' }
  ];
  const data = {
    stores: {
      'dalang': {
        id: 'dalang',
        name: '大朗环球店',
        tables: defaultTables,
        bookings: [],
        history: []
      }
    },
    users: {
      'xgll2122': {
        username: 'xgll2122',
        passwordHash: hashPassword('2122'),
        store: 'dalang',
        role: 'admin',
        createdAt: new Date().toISOString()
      }
    },
    tokens: {},
    meta: { lastReset: getDateString() }
  };
  saveData(data);
  return data;
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function getDateString() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  return d.toISOString().slice(0, 10);
}

// ── 自动清空 ──
function checkAutoReset() {
  const today = getDateString();
  if (today === lastResetDate) return;
  lastResetDate = today;
  
  const data = loadData();
  let resetCount = 0;
  for (const storeId in data.stores) {
    const store = data.stores[storeId];
    if (store.bookings && store.bookings.length > 0) {
      store.history = store.history || [];
      store.history.push(...store.bookings.map(b => ({
        ...b, status: 'auto_reset', archivedAt: new Date().toISOString()
      })));
      resetCount += store.bookings.length;
      store.bookings = [];
    }
  }
  data.meta.lastReset = today;
  saveData(data);
  if (resetCount > 0) {
    console.log(`🔄 凌晨自动清空: ${resetCount} 条预订已移至历史`);
    notifyAll('reset', { date: today, count: resetCount });
  }
}

// ── SSE 通知 ──
function notifyAll(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients = clients.filter(c => { try { c.res.write(msg); return true; } catch { return false; } });
}

// ── 验证中间件 ──
function requireAuth(req, res, data) {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token || !data.tokens[token]) return null;
  return data.tokens[token];
}

function requireAdmin(req, res, data) {
  const user = requireAuth(req, res, data);
  if (!user) { res.status(401).json({ error: '请先登录' }); return null; }
  if (user.role !== 'admin') { res.status(403).json({ error: '需要管理员权限' }); return null; }
  return user;
}

// ── 登录 API ──
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });
  const data = loadData();
  const user = data.users[username];
  if (!user || user.passwordHash !== hashPassword(password)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const token = newToken();
  data.tokens[token] = { username, store: user.store, role: user.role };
  saveData(data);
  const store = data.stores[user.store];
  res.json({
    token, username: user.username,
    store: user.store, storeName: store?.name || '',
    role: user.role
  });
});

app.get('/api/me', (req, res) => {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  const data = loadData();
  const user = data.tokens[token];
  if (!user) return res.status(401).json({ error: '未登录' });
  const store = data.stores[user.store];
  res.json({
    username: user.username,
    store: user.store, storeName: store?.name || '',
    role: user.role, tables: store?.tables || []
  });
});

// ── 公共 API ──
app.get('/api/stores', (req, res) => {
  const data = loadData();
  const list = Object.values(data.stores).map(s => ({ id: s.id, name: s.name }));
  res.json(list);
});

app.get('/api/store/:storeId', (req, res) => {
  const data = loadData();
  const store = data.stores[req.params.storeId];
  if (!store) return res.status(404).json({ error: '门店不存在' });
  res.json({ id: store.id, name: store.name, tables: store.tables });
});

app.get('/api/store/:storeId/bookings', (req, res) => {
  const data = loadData();
  checkAutoReset();
  const store = data.stores[req.params.storeId];
  if (!store) return res.status(404).json({ error: '门店不存在' });
  let bookings = store.bookings || [];
  const { date } = req.query;
  if (date) bookings = bookings.filter(b => b.date === date);
  res.json(bookings);
});

// ── 预订 API (需登录) ──
app.post('/api/store/:storeId/bookings', (req, res) => {
  const data = loadData();
  const user = requireAuth(req, res, data);
  if (!user) return;
  
  const store = data.stores[req.params.storeId];
  if (!store) return res.status(404).json({ error: '门店不存在' });
  
  const { tables, name, phone, people, time, date } = req.body;
  if (!tables || !tables.length || !name || !people || !time || !date) {
    return res.status(400).json({ error: '请填写完整信息（桌台/姓名/人数/时间/日期为必填）' });
  }
  
  // 冲突检测（多桌台）
  const tMin = timeToMinutes(time);
  const conflicts = [];
  for (const tableName of tables) {
    const hasConflict = (store.bookings || []).some(b => {
      if (b.date !== date) return false;
      if (!b.tables || !b.tables.includes(tableName)) return false;
      const bt = timeToMinutes(b.time);
      return Math.abs(tMin - bt) < 120;
    });
    if (hasConflict) conflicts.push(tableName);
  }
  
  if (conflicts.length > 0) {
    return res.status(409).json({ error: `⛔ ${conflicts.join('、')} 在 ${date} ${time} 前后2小时内已有预订！` });
  }
  
  const booking = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    tables, name, phone: phone || '', people: parseInt(people), time, date,
    createdBy: user.username,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  store.bookings = store.bookings || [];
  store.bookings.push(booking);
  saveData(data);
  notifyAll('updated', { action: 'created', booking, store: req.params.storeId });
  sendWecomNotification('created', booking, store.name);
  sendSmsNotification('created', booking);
  res.json(booking);
});

app.put('/api/store/:storeId/bookings/:id', (req, res) => {
  const data = loadData();
  const user = requireAuth(req, res, data);
  if (!user) return;
  
  const store = data.stores[req.params.storeId];
  if (!store) return res.status(404).json({ error: '门店不存在' });
  
  const idx = (store.bookings || []).findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '预订不存在' });
  
  const { tables, name, phone, people, time, date } = req.body;
  if (!tables || !tables.length || !name || !people || !time || !date) {
    return res.status(400).json({ error: '请填写完整信息' });
  }
  
  const tMin = timeToMinutes(time);
  const conflicts = [];
  for (const tableName of tables) {
    const hasConflict = (store.bookings || []).some(b => {
      if (b.id === req.params.id) return false;
      if (b.date !== date) return false;
      if (!b.tables || !b.tables.includes(tableName)) return false;
      const bt = timeToMinutes(b.time);
      return Math.abs(tMin - bt) < 120;
    });
    if (hasConflict) conflicts.push(tableName);
  }
  
  if (conflicts.length > 0) {
    return res.status(409).json({ error: `⛔ ${conflicts.join('、')} 在 ${date} ${time} 前后2小时内已有预订！` });
  }
  
  store.bookings[idx] = {
    ...store.bookings[idx], tables, name, phone: phone || '',
    people: parseInt(people), time, date,
    updatedAt: new Date().toISOString()
  };
  saveData(data);
  notifyAll('updated', { action: 'updated', booking: store.bookings[idx], store: req.params.storeId });
  res.json(store.bookings[idx]);
});

app.delete('/api/store/:storeId/bookings/:id', (req, res) => {
  const data = loadData();
  const user = requireAuth(req, res, data);
  if (!user) return;
  
  const store = data.stores[req.params.storeId];
  if (!store) return res.status(404).json({ error: '门店不存在' });
  
  const idx = (store.bookings || []).findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '预订不存在' });
  
  const [removed] = store.bookings.splice(idx, 1);
  store.history = store.history || [];
  store.history.push({ ...removed, status: 'cancelled', cancelledAt: new Date().toISOString() });
  saveData(data);
  notifyAll('updated', { action: 'deleted', id: removed.id, tables: removed.tables, store: req.params.storeId });
  sendWecomNotification('deleted', removed, store.name);
  sendSmsNotification('deleted', removed);
  res.json({ success: true });
});

// ── 历史记录 ──
app.get('/api/store/:storeId/history', (req, res) => {
  const data = loadData();
  const store = data.stores[req.params.storeId];
  if (!store) return res.status(404).json({ error: '门店不存在' });
  res.json(store.history || []);
});

app.get('/api/store/:storeId/history/export', (req, res) => {
  const data = loadData();
  const store = data.stores[req.params.storeId];
  if (!store) return res.status(404).json({ error: '门店不存在' });
  
  const BOM = '\\ufeff';
  const headers = ['日期', '时间', '桌台', '姓名', '手机', '人数', '状态', '创建人', '创建时间', '取消/归档时间'];
  const rows = (store.history || []).map(b => {
    const dp = (b.date || '').split('-');
    const ds = `${dp[0]}年${parseInt(dp[1])}月${parseInt(dp[2])}日`;
    const status = b.status === 'cancelled' ? '已取消' : (b.status === 'auto_reset' ? '已清空' : '已完成');
    return [ds, b.time, (b.tables || []).join('/'), b.name, b.phone || '', String(b.people), status, b.createdBy || '', b.createdAt || '', b.cancelledAt || b.archivedAt || '']
      .map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
  });
  
  const csv = BOM + [headers.join(','), ...rows].join('\\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${store.name}_历史记录_${getDateString()}.csv"`);
  res.send(csv);
});

// ── 管理后台 API ──
// 桌台管理
app.post('/api/store/:storeId/tables', (req, res) => {
  const data = loadData();
  if (!requireAdmin(req, res, data)) return;
  
  const store = data.stores[req.params.storeId];
  if (!store) return res.status(404).json({ error: '门店不存在' });
  
  const { name, category } = req.body;
  if (!name) return res.status(400).json({ error: '桌台名称必填' });
  if ((store.tables || []).find(t => t.name === name)) {
    return res.status(400).json({ error: '桌台名称已存在' });
  }
  
  store.tables = store.tables || [];
  store.tables.push({ name, category: category || '大厅' });
  saveData(data);
  notifyAll('config_update', { store: req.params.storeId, tables: store.tables });
  res.json(store.tables);
});

app.delete('/api/store/:storeId/tables/:name', (req, res) => {
  const data = loadData();
  if (!requireAdmin(req, res, data)) return;
  
  const store = data.stores[req.params.storeId];
  if (!store) return res.status(404).json({ error: '门店不存在' });
  
  const name = decodeURIComponent(req.params.name);
  if ((store.bookings || []).some(b => b.tables && b.tables.includes(name))) {
    return res.status(400).json({ error: `桌台 ${name} 当前有预订，请先取消` });
  }
  
  store.tables = (store.tables || []).filter(t => t.name !== name);
  saveData(data);
  notifyAll('config_update', { store: req.params.storeId, tables: store.tables });
  res.json(store.tables);
});

app.post('/api/store/:storeId/tables/batch', (req, res) => {
  const data = loadData();
  if (!requireAdmin(req, res, data)) return;
  
  const store = data.stores[req.params.storeId];
  if (!store) return res.status(404).json({ error: '门店不存在' });
  
  const { tables } = req.body;
  if (!tables || !tables.length) return res.status(400).json({ error: '请提供桌台列表' });
  
  let added = 0;
  store.tables = store.tables || [];
  for (const t of tables) {
    if (!store.tables.find(ex => ex.name === t.name)) {
      store.tables.push({ name: t.name, category: t.category || '大厅' });
      added++;
    }
  }
  saveData(data);
  notifyAll('config_update', { store: req.params.storeId, tables: store.tables });
  res.json({ added, tables: store.tables });
});

// 门店设置
app.put('/api/store/:storeId/settings', (req, res) => {
  const data = loadData();
  if (!requireAdmin(req, res, data)) return;
  
  const store = data.stores[req.params.storeId];
  if (!store) return res.status(404).json({ error: '门店不存在' });
  
  if (req.body.name) store.name = req.body.name;
  saveData(data);
  res.json({ name: store.name });
});

// 用户管理
app.get('/api/admin/users', (req, res) => {
  const data = loadData();
  if (!requireAdmin(req, res, data)) return;
  
  const users = Object.values(data.users).map(u => ({
    username: u.username, store: u.store, role: u.role, createdAt: u.createdAt
  }));
  res.json(users);
});

app.post('/api/admin/users', (req, res) => {
  const data = loadData();
  if (!requireAdmin(req, res, data)) return;
  
  const { username, password, store, role } = req.body;
  if (!username || !password || !store) {
    return res.status(400).json({ error: '请填写用户名/密码/门店' });
  }
  if (data.users[username]) return res.status(400).json({ error: '用户名已存在' });
  
  data.users[username] = {
    username, passwordHash: hashPassword(password), store,
    role: role || 'user', createdAt: new Date().toISOString()
  };
  saveData(data);
  res.json({ username, store, role: role || 'user' });
});

app.put('/api/admin/users/:username', (req, res) => {
  const data = loadData();
  if (!requireAdmin(req, res, data)) return;
  
  const user = data.users[req.params.username];
  if (!user) return res.status(404).json({ error: '用户不存在' });
  
  if (req.body.password) user.passwordHash = hashPassword(req.body.password);
  if (req.body.store) user.store = req.body.store;
  if (req.body.role) user.role = req.body.role;
  saveData(data);
  res.json({ username: user.username, store: user.store, role: user.role });
});

app.delete('/api/admin/users/:username', (req, res) => {
  const data = loadData();
  if (!requireAdmin(req, res, data)) return;
  if (req.params.username === 'xgll2122') {
    return res.status(400).json({ error: '不能删除系统管理员' });
  }
  
  delete data.users[req.params.username];
  for (const t in data.tokens) {
    if (data.tokens[t].username === req.params.username) delete data.tokens[t];
  }
  saveData(data);
  res.json({ success: true });
});

// ── SSE ──
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
    'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'
  });
  res.write(`event: connected\\ndata: {"status":"ok"}\\n\\n`);
  const client = { id: Date.now(), res };
  clients.push(client);
  const hb = setInterval(() => { try { res.write(':\\n\\n'); } catch {} }, 30000);
  req.on('close', () => { clearInterval(hb); clients = clients.filter(c => c.id !== client.id); });
});

// ── 定时任务 ──
setInterval(checkAutoReset, 60000);
checkAutoReset();

// ── 工具函数 ──
function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

// ── 企业微信通知 ──
async function sendWecomNotification(type, booking, storeName) {
  if (!WECOM_WEBHOOK_URL) return;
  
  const dp = (booking.date || '').split('-');
  const month = parseInt(dp[1]) || '?';
  const day = parseInt(dp[2]) || '?';
  const phoneDisplay = booking.phone || '无';
  const tablesDisplay = (booking.tables || []).join('、');
  
  let title, content;
  if (type === 'created') {
    title = '📋 包间预订成功';
    content = `尊敬的${booking.name}，您好！您已成功预订湘阁里辣（${storeName}）：` +
      `\n• 包间号/台号：${tablesDisplay}` +
      `\n• 预定时间：${month}月${day}号 ${booking.time}` +
      `\n• 预定人数：${booking.people}人` +
      `\n• 预留手机：${phoneDisplay}` +
      `\n• 备注：${booking.note || '无'}` +
      `\n• 到店指引：可点击导航，餐厅有地面停车场，消费免停2小时` +
      `\n• 服务电话：0769-82238202` +
      `\n\n湘阁里辣${storeName}全体伙伴恭候您的到来！`;
  } else if (type === 'deleted') {
    title = '⚠️ 预订已取消';
    content = `尊敬的${booking.name}，您好！您已取消湘阁里辣（${storeName}）预订：\\n` +
      `• 桌台号：${tablesDisplay}\\n• 原定时间：${month}月${day}日 ${booking.time}\\n` +
      `• 原定人数：${booking.people}人\\n\\n感谢您的理解，欢迎下次光临！`;
  } else return;
  
  const body = JSON.stringify({ msgtype: 'markdown', markdown: { content: `## ${title}\\n${content}` } });
  
  return new Promise((resolve) => {
    try {
      const u = new URL(WECOM_WEBHOOK_URL);
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request({
        hostname: u.hostname, port: u.port, path: u.pathname + u.search,
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, (res) => { console.log(`📱 WeCom: ${type} → ${res.statusCode}`); resolve(); });
      req.on('error', (e) => { console.error(`📱 WeCom失败:`, e.message); resolve(); });
      req.write(body); req.end();
    } catch(e) { console.error(`📱 WeCom错误:`, e.message); resolve(); }
  });
}

// ── 短信通知 ──
async function sendSmsNotification(type, booking) {
  if (!SMS_SECRET_ID || !SMS_SECRET_KEY || !SMS_SDK_APP_ID || !SMS_TEMPLATE_ID) return;
  if (!booking.phone) return;
  
  const dp = (booking.date || '').split('-');
  const tablesDisplay = (booking.tables || []).join('/');
  const params = type === 'created'
    ? [booking.name, tablesDisplay, dp[1], dp[2], booking.time, String(booking.people), booking.phone]
    : [booking.name, tablesDisplay, dp[1], dp[2], booking.time, String(booking.people)];
  
  const payload = JSON.stringify({
    SmsSdkAppId: parseInt(SMS_SDK_APP_ID), SignName: SMS_SIGN_NAME,
    TemplateId: SMS_TEMPLATE_ID, TemplateParamSet: params,
    PhoneNumberSet: ['+86' + booking.phone], SessionContext: ''
  });
  
  const crypto = require('crypto');
  const now = Math.floor(Date.now() / 1000);
  const dateStr = new Date().toISOString().slice(0, 10);
  const service = 'sms', host = 'sms.tencentcloudapi.com';
  const action = 'SendSms', version = '2021-01-11', algorithm = 'TC3-HMAC-SHA256';
  
  const canonicalHeaders = `content-type:application/json\\nhost:${host}\\nx-tc-action:${action.toLowerCase()}\\n`;
  const hashedPayload = crypto.createHash('sha256').update(payload).digest('hex');
  const canonicalRequest = `POST\\n/\\n\\n${canonicalHeaders}\\n${hashedPayload}`;
  const hashedCanonical = crypto.createHash('sha256').update(canonicalRequest).digest('hex');
  const credentialScope = `${dateStr}/${service}/tc3_request`;
  const stringToSign = `${algorithm}\\n${now}\\n${credentialScope}\\n${hashedCanonical}`;
  
  const kDate = crypto.createHmac('sha256', ('TC3' + SMS_SECRET_KEY).toString('utf8')).update(dateStr).digest();
  const kService = crypto.createHmac('sha256', kDate).update(service).digest();
  const kSigning = crypto.createHmac('sha256', kService).update('tc3_request').digest();
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  
  const authorization = `${algorithm} Credential=${SMS_SECRET_ID}/${credentialScope}, SignedHeaders=content-type;host;x-tc-action, Signature=${signature}`;
  
  const options = {
    hostname: host, port: 443, path: '/', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
      Host: host, 'X-TC-Action': action, 'X-TC-Version': version, 'X-TC-Region': 'ap-guangzhou',
      'X-TC-Timestamp': String(now), Authorization: authorization }
  };
  
  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => {
        console.log(`📲 SMS: ${type} ${booking.phone} → ${res.statusCode}`);
        resolve();
      });
    });
    req.on('error', (e) => { console.error(`📲 SMS失败:`, e.message); resolve(); });
    req.write(payload); req.end();
  });
}

// ── 启动 ──
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🏠 包间预订系统已启动: http://localhost:${PORT}`);
  console.log(`📋 默认账号: xgll2122 / 2122`);
});
