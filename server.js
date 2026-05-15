const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3456;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');

// 确保数据目录存在（云端挂载卷可能初始化时不存在）
if (DATA_DIR !== __dirname && !fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let clients = [];

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch {
    return { bookings: [] };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function notifyAll(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients = clients.filter(c => {
    try { c.res.write(msg); return true; } catch { return false; }
  });
}

// 时间转分钟数
function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

// 冲突检测：同包间同一天，前后2小时内不可预订
function hasConflict(room, date, time, bookings, excludeId) {
  const t = timeToMinutes(time);
  return bookings.some(b => {
    if (b.room !== room || b.date !== date) return false;
    if (excludeId && b.id === excludeId) return false;
    const bt = timeToMinutes(b.time);
    return Math.abs(t - bt) < 120; // 2小时=120分钟
  });
}

app.get('/api/bookings', (req, res) => {
  const { date, room } = req.query;
  let bookings = loadData().bookings;
  if (date) bookings = bookings.filter(b => b.date === date);
  if (room) bookings = bookings.filter(b => b.room === room);
  res.json(bookings);
});

app.post('/api/bookings', (req, res) => {
  const { room, name, phone, people, time, date } = req.body;
  if (!room || !name || !people || !time || !date) {
    return res.status(400).json({ error: '请填写完整信息（包间/姓名/人数/时间/日期为必填）' });
  }
  const data = loadData();
  
  if (hasConflict(room, date, time, data.bookings)) {
    return res.status(409).json({
      error: `⛔ ${room} 在 ${date} ${time} 前后2小时内已有预订！`
    });
  }
  
  const booking = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    room, name, phone: phone || '',
    people: parseInt(people), time, date,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  data.bookings.push(booking);
  saveData(data);
  notifyAll('updated', { action: 'created', booking });
  res.json(booking);
});

// 编辑预订
app.put('/api/bookings/:id', (req, res) => {
  const data = loadData();
  const idx = data.bookings.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '未找到该预订' });
  
  const { room, name, phone, people, time, date } = req.body;
  if (!room || !name || !people || !time || !date) {
    return res.status(400).json({ error: '请填写完整信息' });
  }
  
  if (hasConflict(room, date, time, data.bookings, req.params.id)) {
    return res.status(409).json({
      error: `⛔ ${room} 在 ${date} ${time} 前后2小时内已有其他预订！`
    });
  }
  
  const updated = {
    ...data.bookings[idx],
    room, name, phone: phone || '',
    people: parseInt(people), time, date,
    updatedAt: new Date().toISOString()
  };
  
  data.bookings[idx] = updated;
  saveData(data);
  notifyAll('updated', { action: 'updated', booking: updated });
  res.json(updated);
});

app.delete('/api/bookings/:id', (req, res) => {
  const data = loadData();
  const idx = data.bookings.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '未找到该预订' });
  const removed = data.bookings.splice(idx, 1)[0];
  saveData(data);
  notifyAll('updated', { action: 'deleted', id: removed.id, room: removed.room, date: removed.date });
  res.json({ success: true });
});

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(`event: connected\ndata: {"status":"ok"}\n\n`);
  const client = { id: Date.now(), res };
  clients.push(client);
  const heartbeat = setInterval(() => { try { res.write(':\n\n'); } catch {} }, 30000);
  req.on('close', () => {
    clearInterval(heartbeat);
    clients = clients.filter(c => c.id !== client.id);
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🏠 包间预订系统已启动: http://localhost:${PORT}`);
  console.log(`📋 局域网分享: http://<本机IP>:${PORT}`);
});
