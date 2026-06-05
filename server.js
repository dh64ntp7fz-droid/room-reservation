const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const https = require('https');
const http = require('http');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3456;

// Supabase 配置
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ieidvazvzulsrfopjvyf.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const WECOM_WEBHOOK_URL = process.env.WECOM_WEBHOOK_URL || '';

// SMS 配置
const SMS_SECRET_ID = process.env.SMS_SECRET_ID || '';
const SMS_SECRET_KEY = process.env.SMS_SECRET_KEY || '';
const SMS_SDK_APP_ID = process.env.SMS_SDK_APP_ID || '';
const SMS_SIGN_NAME = process.env.SMS_SIGN_NAME || '湘阁里辣';
const SMS_TEMPLATE_ID = process.env.SMS_TEMPLATE_ID || '';

let clients = [];
let lastResetDate = null;

// ── 内存缓存（避免每个请求都查Supabase） ──
let dataCache = null;
let dataCacheTime = 0;
const CACHE_TTL = 60000; // 60秒缓存，足以应对冷启动，写操作后自动失效

function invalidateCache() {
  dataCache = null;
  dataCacheTime = 0;
}

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

function getDateString() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

// ── Supabase 数据操作 ──
async function loadData() {
  // 缓存命中: 8秒内直接用缓存
  if (dataCache && Date.now() - dataCacheTime < CACHE_TTL) {
    return dataCache;
  }
  try {
    const [storesRes, bookingsRes, historyRes, usersRes, tokensRes, metaRes] = await Promise.all([
      supabase.from('stores').select('*'),
      supabase.from('bookings').select('*'),
      supabase.from('history').select('*'),
      supabase.from('users').select('*'),
      supabase.from('tokens').select('*'),
      supabase.from('meta').select('*')
    ]);
    // 组装成原来的数据结构
    const stores = {};
    for (const s of (storesRes.data || [])) {
      stores[s.id] = {
        id: s.id,
        name: s.name,
        tables: s.tables_config || [],
        bookings: (bookingsRes.data || []).filter(b => b.store_id === s.id).map(b => ({
          id: b.id, tables: b.tables, name: b.name, phone: b.phone || '',
          people: b.people, time: b.time, date: b.date, note: b.note || '',
          createdBy: b.created_by || '', createdAt: b.created_at, updatedAt: b.updated_at
        })),
        history: (historyRes.data || []).filter(h => h.store_id === s.id).map(h => ({
          id: h.id, tables: h.tables, name: h.name, phone: h.phone || '',
          people: h.people, time: h.time, date: h.date, note: h.note || '',
          createdBy: h.created_by || '', createdAt: h.created_at, updatedAt: h.updated_at,
          status: h.status, archivedAt: h.archived_at, cancelledAt: h.archived_at
        }))
      };
    }

    const users = {};
    for (const u of (usersRes.data || [])) {
      users[u.username] = {
        username: u.username, passwordHash: u.password_hash,
        store: u.store, role: u.role, createdAt: u.created_at
      };
    }

    const tokens = {};
    for (const t of (tokensRes.data || [])) {
      tokens[t.token] = { username: t.username, store: t.store, role: t.role };
    }

    const metaObj = {};
    for (const m of (metaRes.data || [])) {
      metaObj[m.key] = m.value;
    }

    dataCache = { stores, users, tokens, meta: metaObj };
    dataCacheTime = Date.now();
    return dataCache;
  } catch (e) {
    console.error('❌ Supabase 数据加载失败:', e.message);
    return createDefaultData();
  }
}

function createDefaultData() {
  const defaultTables = [
    { name: '爱晚亭', category: '包间' }, { name: '东江湖', category: '包间' },
    { name: '岳麓山', category: '包间' }, { name: '橘子洲', category: '包间' },
    { name: '桃花源', category: '包间' }, { name: '洞庭湖', category: '包间' },
    { name: 'B16', category: '大厅' }, { name: 'B15', category: '大厅' },
    { name: 'B13', category: '大厅' }, { name: 'A10', category: '大厅' },
    { name: 'A11', category: '大厅' }, { name: 'A12', category: '大厅' }
  ];
  return {
    stores: {
      'dalang': { id: 'dalang', name: '大朗环球店', tables: defaultTables, bookings: [], history: [] }
    },
    users: { 'xgll2122': { username: 'xgll2122', passwordHash: hashPassword('2122'), store: 'dalang', role: 'admin', createdAt: new Date().toISOString() } },
    tokens: {},
    meta: { lastReset: getDateString() }
  };
}

// ── 自动清空 ──
async function checkAutoReset() {
  const today = getDateString();
  if (lastResetDate === null) {
    const { data } = await supabase.from('meta').select('value').eq('key', 'lastReset').single();
    lastResetDate = data?.value || today;
  }
  if (today === lastResetDate) return;
  lastResetDate = today;

  // 把当天预订移到历史
  const { data: allBookings } = await supabase.from('bookings').select('*');
  if (allBookings && allBookings.length > 0) {
    const historyRows = allBookings.map(b => ({
      id: b.id + '_reset', store_id: b.store_id, tables: b.tables,
      name: b.name, phone: b.phone, people: b.people, time: b.time,
      date: b.date, note: b.note, created_by: b.created_by,
      created_at: b.created_at, updated_at: b.updated_at,
      status: 'auto_reset', archived_at: new Date().toISOString()
    }));
    await supabase.from('history').insert(historyRows);
    await supabase.from('bookings').delete().neq('id', '');
    console.log(`🔄 凌晨自动清空: ${allBookings.length} 条预订已移至历史`);
    notifyAll('reset', { date: today, count: allBookings.length });
  }

  // 清理超过7天的历史
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  await supabase.from('history').delete().lt('archived_at', sevenDaysAgo);

  // 更新 meta
  await supabase.from('meta').upsert({ key: 'lastReset', value: today });
}

// ── SSE 通知 ──
function notifyAll(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients = clients.filter(c => { try { c.res.write(msg); return true; } catch { return false; } });
}

// ── 验证中间件 ──
function requireAuth(req, res, data) {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token || !data.tokens[token]) {
    res.status(401).json({ error: '请先登录' });
    return null;
  }
  return data.tokens[token];
}

function requireAdmin(req, res, data) {
  const user = requireAuth(req, res, data);
  if (!user) { res.status(401).json({ error: '请先登录' }); return null; }
  if (user.role !== 'admin') { res.status(403).json({ error: '需要管理员权限' }); return null; }
  return user;
}

// ── 登录 API ──
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });
  const data = await loadData();
  const user = data.users[username];
  if (!user || user.passwordHash !== hashPassword(password)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const token = newToken();
  data.tokens[token] = { username, store: user.store, role: user.role };
  await supabase.from('tokens').insert({ token, username, store: user.store, role: user.role });
  // 更新内存缓存（不清全缓存，token 刚创建需要立即可用）
  if (dataCache) {
    dataCache.tokens[token] = { username, store: user.store, role: user.role };
  }
  // 清理该用户旧的 token（超过50个就删除最旧的）
  supabase.from('tokens').select('token').eq('username', username).order('created_at', { ascending: false }).limit(100).then(({ data: oldTokens }) => {
    if (oldTokens && oldTokens.length > 50) {
      const toDelete = oldTokens.slice(50).map(t => t.token);
      supabase.from('tokens').delete().in('token', toDelete).then(() => console.log(`🧹 清理 ${toDelete.length} 个过期 token`)).catch(()=>{});
    }
  }).catch(()=>{});
  const store = data.stores[user.store];
  res.json({ token, username: user.username, store: user.store, storeName: store?.name || '', role: user.role });
});

app.get('/api/me', async (req, res) => {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  const data = await loadData();
  const user = data.tokens[token];
  if (!user) return res.status(401).json({ error: '未登录' });
  const store = data.stores[user.store];
  res.json({ username: user.username, store: user.store, storeName: store?.name || '', role: user.role, tables: store?.tables || [] });
});
// ── 公共 API ──
app.get('/api/stores', async (req, res) => {
  const data = await loadData();
  const list = Object.values(data.stores).map(s => ({ id: s.id, name: s.name }));
  res.json(list);
});

app.get('/api/store/:storeId', async (req, res) => {
  const data = await loadData();
  const store = data.stores[req.params.storeId];
  if (!store) return res.status(404).json({ error: '门店不存在' });
  res.json({ id: store.id, name: store.name, tables: store.tables });
});

app.get('/api/store/:storeId/bookings', async (req, res) => {
  const data = await loadData();
  checkAutoReset().catch(e => console.error('自动清空检查失败:', e.message));
  const store = data.stores[req.params.storeId];
  if (!store) return res.status(404).json({ error: '门店不存在' });
  let bookings = store.bookings || [];
  const { date } = req.query;
  if (date) bookings = bookings.filter(b => b.date === date);
  res.json(bookings);
});

// ── 预订 API (需登录) ──
app.post('/api/store/:storeId/bookings', async (req, res) => {
  const data = await loadData();
  const user = requireAuth(req, res, data);
  if (!user) return res.status(401).json({ error: '请先登录' });

  const store = data.stores[req.params.storeId];
  if (!store) return res.status(404).json({ error: '门店不存在' });

  const { tables, name, phone, people, time, date, note } = req.body;
  if (!tables || !tables.length || !name || !people || !time || !date) {
    return res.status(400).json({ error: '请填写完整信息(桌台/姓名/人数/时间/日期为必填)' });
  }

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
    return res.status(409).json({ error: `⛔ ${conflicts.join('、')} 在 ${date} ${time} 前后2小时内已有预订!` });
  }

  const booking = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    tables, name, phone: phone || '', people: parseInt(people), time, date, note: note || '',
    createdBy: user.username, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };

  // 写入 Supabase
  await supabase.from('bookings').insert({
    id: booking.id, store_id: req.params.storeId, tables: booking.tables,
    name: booking.name, phone: booking.phone, people: booking.people,
    time: booking.time, date: booking.date, note: booking.note,
    created_by: booking.createdBy, created_at: booking.createdAt, updated_at: booking.updatedAt
  }); invalidateCache();

  notifyAll('updated', { action: 'created', booking, store: req.params.storeId });
  sendWecomNotification('created', booking, store.name);
  sendSmsNotification('created', booking);
  res.json(booking);
});

app.put('/api/store/:storeId/bookings/:id', async (req, res) => {
  const data = await loadData();
  const user = requireAuth(req, res, data);
  if (!user) return res.status(401).json({ error: '请先登录' });

  const store = data.stores[req.params.storeId];
  if (!store) return res.status(404).json({ error: '门店不存在' });

  const idx = (store.bookings || []).findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '预订不存在' });

  const { tables, name, phone, people, time, date, note } = req.body;
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
    return res.status(409).json({ error: `⛔ ${conflicts.join('、')} 在 ${date} ${time} 前后2小时内已有预订!` });
  }

  const updatedAt = new Date().toISOString();
  await supabase.from('bookings').update({
    tables, name, phone: phone || '', people: parseInt(people),
    time, date, note: note || '', updated_at: updatedAt
  }).eq('id', req.params.id); invalidateCache();

  const updatedBooking = { ...store.bookings[idx], tables, name, phone: phone || '', people: parseInt(people), time, date, note: note || '', updatedAt };
  notifyAll('updated', { action: 'updated', booking: updatedBooking, store: req.params.storeId });
  res.json(updatedBooking);
});

app.delete('/api/store/:storeId/bookings/:id', async (req, res) => {
  const data = await loadData();
  const user = requireAuth(req, res, data);
  if (!user) return res.status(401).json({ error: '请先登录' });

  const store = data.stores[req.params.storeId];
  if (!store) return res.status(404).json({ error: '门店不存在' });

  const idx = (store.bookings || []).findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '预订不存在' });

  const removed = store.bookings[idx];
  const archivedAt = new Date().toISOString();

  // 移到历史表
  await supabase.from('history').insert({
    id: removed.id, store_id: req.params.storeId, tables: removed.tables,
    name: removed.name, phone: removed.phone, people: removed.people,
    time: removed.time, date: removed.date, note: removed.note,
    created_by: removed.createdBy, created_at: removed.createdAt, updated_at: removed.updatedAt,
    status: 'cancelled', archived_at: archivedAt
  });
  // 从预订表删除
  await supabase.from('bookings').delete().eq('id', req.params.id); invalidateCache();

  notifyAll('updated', { action: 'deleted', id: removed.id, tables: removed.tables, store: req.params.storeId });
  sendWecomNotification('deleted', removed, store.name);
  sendSmsNotification('deleted', removed);
  res.json({ success: true });
});
// ── 历史记录 ──
app.get('/api/store/:storeId/history', async (req, res) => {
  const data = await loadData();
  const store = data.stores[req.params.storeId];
  if (!store) return res.status(404).json({ error: '门店不存在' });
  res.json(store.history || []);
});

app.get('/api/store/:storeId/history/export', async (req, res) => {
  const data = await loadData();
  const user = requireAuth(req, res, data);
  if (!user) return;
  const store = data.stores[req.params.storeId];
  if (!store) return res.status(404).json({ error: '门店不存在' });

  const BOM = '﻿';
  const headers = ['日期', '时间', '桌台', '姓名', '手机', '人数', '备注', '状态', '创建人', '创建时间', '取消/归档时间'];
  const rows = (store.history || []).map(b => {
    const dp = (b.date || '').split('-');
    const ds = `${dp[0]}年${parseInt(dp[1])}月${parseInt(dp[2])}日`;
    const status = b.status === 'cancelled' ? '已取消' : (b.status === 'auto_reset' ? '已清空' : '已完成');
    return [ds, b.time, (b.tables || []).join('/'), b.name, b.phone || '', String(b.people), b.note || '', status, b.createdBy || '', b.createdAt || '', b.cancelledAt || b.archivedAt || '']
      .map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
  });

  const csv = BOM + [headers.join(','), ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${store.name}_历史记录_${getDateString()}.csv"`);
  res.send(csv);
});

// ── 管理后台 API ──
app.post('/api/store/:storeId/tables', async (req, res) => {
  const data = await loadData();
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
  await supabase.from('stores').update({ tables_config: store.tables }).eq('id', req.params.storeId); invalidateCache();
  notifyAll('config_update', { store: req.params.storeId, tables: store.tables });
  res.json(store.tables);
});

app.delete('/api/store/:storeId/tables/:name', async (req, res) => {
  const data = await loadData();
  if (!requireAdmin(req, res, data)) return;

  const store = data.stores[req.params.storeId];
  if (!store) return res.status(404).json({ error: '门店不存在' });

  const name = decodeURIComponent(req.params.name);
  if ((store.bookings || []).some(b => b.tables && b.tables.includes(name))) {
    return res.status(400).json({ error: `桌台 ${name} 当前有预订,请先取消` });
  }

  store.tables = (store.tables || []).filter(t => t.name !== name);
  await supabase.from('stores').update({ tables_config: store.tables }).eq('id', req.params.storeId); invalidateCache();
  notifyAll('config_update', { store: req.params.storeId, tables: store.tables });
  res.json(store.tables);
});

app.post('/api/store/:storeId/tables/batch', async (req, res) => {
  const data = await loadData();
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
  await supabase.from('stores').update({ tables_config: store.tables }).eq('id', req.params.storeId); invalidateCache();
  notifyAll('config_update', { store: req.params.storeId, tables: store.tables });
  res.json({ added, tables: store.tables });
});

app.put('/api/store/:storeId/settings', async (req, res) => {
  const data = await loadData();
  if (!requireAdmin(req, res, data)) return;

  const store = data.stores[req.params.storeId];
  if (!store) return res.status(404).json({ error: '门店不存在' });

  if (req.body.name) {
    store.name = req.body.name;
    await supabase.from('stores').update({ name: store.name }).eq('id', req.params.storeId);
  }
  res.json({ name: store.name });
});

app.delete('/api/admin/stores/:storeId', async (req, res) => {
  const data = await loadData();
  if (!requireAdmin(req, res, data)) return;
  if (req.params.storeId === 'dalang') return res.status(400).json({ error: '主门店不可删除' });
  if (!data.stores[req.params.storeId]) return res.status(404).json({ error: '门店不存在' });
  await supabase.from('bookings').delete().eq('store_id', req.params.storeId);
  await supabase.from('history').delete().eq('store_id', req.params.storeId);
  await supabase.from('stores').delete().eq('id', req.params.storeId);
  res.json({ ok: true });
});
// ── 用户管理 ──
app.get('/api/admin/users', async (req, res) => {
  const data = await loadData();
  if (!requireAdmin(req, res, data)) return;
  const users = Object.values(data.users).map(u => ({
    username: u.username, store: u.store, role: u.role, createdAt: u.createdAt
  }));
  res.json(users);
});

app.post('/api/admin/users', async (req, res) => {
  const data = await loadData();
  if (!requireAdmin(req, res, data)) return;

  const { username, password, store, role } = req.body;
  if (!username || !password || !store) {
    return res.status(400).json({ error: '请填写用户名/密码/门店' });
  }
  if (data.users[username]) return res.status(400).json({ error: '用户名已存在' });

  // 如果门店不存在,自动创建
  if (!data.stores[store]) {
    const defaultTables = createDefaultData().stores.dalang.tables;
    await supabase.from('stores').insert({ id: store, name: store, tables_config: defaultTables });
    console.log('🏪 自动创建门店:', store);
  }

  await supabase.from('users').insert({
    username, password_hash: hashPassword(password), store, role: role || 'user'
  });
  res.json({ username, store, role: role || 'user' });
});

app.put('/api/admin/users/:username', async (req, res) => {
  const data = await loadData();
  if (!requireAdmin(req, res, data)) return;

  const user = data.users[req.params.username];
  if (!user) return res.status(404).json({ error: '用户不存在' });

  const updates = {};
  if (req.body.password) updates.password_hash = hashPassword(req.body.password);
  if (req.body.store) updates.store = req.body.store;
  if (req.body.role) updates.role = req.body.role;
  if (Object.keys(updates).length > 0) {
    await supabase.from('users').update(updates).eq('username', req.params.username);
  }
  res.json({ username: user.username, store: req.body.store || user.store, role: req.body.role || user.role });
});

app.delete('/api/admin/users/:username', async (req, res) => {
  const data = await loadData();
  if (!requireAdmin(req, res, data)) return;
  if (req.params.username === 'xgll2122') {
    return res.status(400).json({ error: '不能删除系统管理员' });
  }
  await supabase.from('tokens').delete().eq('username', req.params.username);
  await supabase.from('users').delete().eq('username', req.params.username);
  res.json({ success: true });
});

// ── SSE ──
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
    'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'
  });
  res.write('event: connected\ndata: {"status":"ok"}\n\n');
  const client = { id: Date.now(), res };
  clients.push(client);
  const hb = setInterval(() => { try { res.write(': \n\n'); } catch {} }, 30000);
  req.on('close', () => { clearInterval(hb); clients = clients.filter(c => c.id !== client.id); });
});

// ── 定时任务 ──
setInterval(checkAutoReset, 60000);

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
    content = `尊敬的${booking.name},您好!您已成功预订湘阁里辣(${storeName}):\n• 包间号/台号:${tablesDisplay}\n• 预定时间:${month}月${day}号 ${booking.time}\n• 预定人数:${booking.people}人\n• 预留手机:${phoneDisplay}\n• 特别备注:${booking.note || '无'}\n• 免费停车:餐厅有地面停车场,消费免停2小时\n• [点击导航](https://surl.amap.com/flASiCC19gwW)\n• 服务电话:0769-82238202\n\n湘阁里辣${storeName}全体伙伴恭候您的到来!`;
  } else if (type === 'deleted') {
    title = '⚠️ 预订已取消';
    content = `尊敬的${booking.name},您好!\n您已取消湘阁里辣(${storeName})的预订:\n• 包间号/台号:${tablesDisplay}\n• 预定时间:${month}月${day}号 ${booking.time}\n• 预定人数:${booking.people}人\n• 预留手机:${booking.phone || '无'}\n• 特别备注:${booking.note || '无'}\n\n感谢您的理解,欢迎下次光临!`;
  } else return;

  const body = JSON.stringify({ msgtype: 'markdown', markdown: { content: `## ${title}\n${content}` } });

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

  const now = Math.floor(Date.now() / 1000);
  const dateStr = new Date().toISOString().slice(0, 10);
  const service = 'sms', host = 'sms.tencentcloudapi.com';
  const action = 'SendSms', version = '2021-01-11', algorithm = 'TC3-HMAC-SHA256';

  const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
  const hashedPayload = crypto.createHash('sha256').update(payload).digest('hex');
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${hashedPayload}`;
  const hashedCanonical = crypto.createHash('sha256').update(canonicalRequest).digest('hex');
  const credentialScope = `${dateStr}/${service}/tc3_request`;
  const stringToSign = `${algorithm}\n${now}\n${credentialScope}\n${hashedCanonical}`;

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
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`🏠 包间预订系统已启动: http://localhost:${PORT}`);
  console.log(`📋 默认账号: xgll2122 / 2122`);
  console.log(`🗄️ 数据存储: Supabase (${SUPABASE_URL})`);
  checkAutoReset().catch(e => console.error('自动清空检查失败:', e.message));
});
