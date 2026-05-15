const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3456;
const WECOM_WEBHOOK_URL = process.env.WECOM_WEBHOOK_URL || '';
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

// 企业微信机器人消息推送
// 腾讯云短信推送（需要配置环境变量）
async function sendSmsNotification(type, booking) {
  const secretId = process.env.SMS_SECRET_ID;
  const secretKey = process.env.SMS_SECRET_KEY;
  const sdkAppId = process.env.SMS_SDK_APP_ID;
  const signName = process.env.SMS_SIGN_NAME || '湘阁里辣';
  const templateId = process.env.SMS_TEMPLATE_ID || '';
  
  if (!secretId || !secretKey || !sdkAppId || !templateId) {
    console.log('⚠️ SMS 凭证未配置，跳过短信推送');
    return;
  }
  if (!booking.phone) {
    console.log('⚠️ 无手机号，跳过短信推送');
    return;
  }
  
  const dateParts = (booking.date || '').split('-');
  const month = String(parseInt(dateParts[1]) || '?');
  const day = String(parseInt(dateParts[2]) || '?');
  const phoneDisplay = booking.phone || '无';
  
  // 模板参数（需根据腾讯云短信模板实际变量顺序调整）
  const templateParams = type === 'created' 
    ? [booking.name, booking.room, month, day, booking.time, String(booking.people), phoneDisplay]
    : [booking.name, booking.room, month, day, booking.time, String(booking.people)];
  
  const payload = JSON.stringify({
    SmsSdkAppId: parseInt(sdkAppId),
    SignName: signName,
    TemplateId: templateId,
    TemplateParamSet: templateParams,
    PhoneNumberSet: ['+86' + booking.phone],
    SessionContext: ''
  });
  
  // 使用腾讯云 API v3 签名（简化版，生产环境建议用 SDK）
  const crypto = require('crypto');
  const now = Math.floor(Date.now() / 1000);
  const date = new Date().toISOString().slice(0, 10);
  const service = 'sms';
  const host = 'sms.tencentcloudapi.com';
  const action = 'SendSms';
  const version = '2021-01-11';
  const algorithm = 'TC3-HMAC-SHA256';
  
  const canonicalHeaders = `content-type:application/json
host:${host}
x-tc-action:${action.toLowerCase()}
`;
  const hashedRequestPayload = crypto.createHash('sha256').update(payload).digest('hex');
  const canonicalRequest = `POST
/

${canonicalHeaders}
${hashedRequestPayload}`;
  const hashedCanonicalRequest = crypto.createHash('sha256').update(canonicalRequest).digest('hex');
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = `${algorithm}
${now}
${credentialScope}
${hashedCanonicalRequest}`;
  
  const kDate = crypto.createHmac('sha256', (`TC3${secretKey}`).toString('utf8')).update(date).digest();
  const kService = crypto.createHmac('sha256', kDate).update(service).digest();
  const kSigning = crypto.createHmac('sha256', kService).update('tc3_request').digest();
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  
  const authorization = `${algorithm} Credential=${secretId}/${credentialScope}, SignedHeaders=content-type;host;x-tc-action, Signature=${signature}`;
  
  const https = require('https');
  const options = {
    hostname: host, port: 443, path: '/',
    method: 'POST', headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'Host': host,
      'X-TC-Action': action,
      'X-TC-Version': version,
      'X-TC-Region': 'ap-guangzhou',
      'X-TC-Timestamp': String(now),
      'Authorization': authorization
    }
  };
  
  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        console.log(`📲 SMS推送: ${type} ${booking.room} →`, res.statusCode, data.slice(0, 100));
        resolve();
      });
    });
    req.on('error', (e) => { console.error('📲 SMS推送失败:', e.message); resolve(); });
    req.write(payload);
    req.end();
  });
}

async function sendWecomNotification(type, booking) {
  if (!WECOM_WEBHOOK_URL) return;
  
  const dateParts = (booking.date || '').split('-');
  const month = parseInt(dateParts[1]) || '?';
  const day = parseInt(dateParts[2]) || '?';
  const phoneDisplay = booking.phone ? booking.phone : '无';
  
  let title, content;
  if (type === 'created') {
    title = '📋 包间预订成功';
    content = `尊敬的${booking.name}，您好！您已成功预订湘阁里辣（大朗环球店）：\n` +
      `• 包间号/台号：**${booking.room}**\n` +
      `• 预定时间：**${month}月${day}号 ${booking.time}**\n` +
      `• 预定人数：**${booking.people}人**\n` +
      `• 预留手机：**${phoneDisplay}**\n` +
      `• 到店指引：可[点击导航](https://surl.amap.com/flASiCC19gwW)，餐厅有地面停车场，消费免停2小时\n` +
      `• 服务电话：0769-82238202\n` +
      `\n湘阁里辣大朗环球店全体伙伴恭候您的到来！`;
  } else if (type === 'deleted') {
    title = '⚠️ 预订已取消';
    content = `尊敬的${booking.name}，您好！您已取消湘阁里辣（大朗环球店）预订：\n` +
      `• 包间号/台号：**${booking.room}**\n` +
      `• 原定时间：**${month}月${day}号 ${booking.time}**\n` +
      `• 原定人数：**${booking.people}人**\n` +
      `\n如有需要可重新预订。`;
  } else { return; }
  
  const body = JSON.stringify({
    msgtype: 'markdown',
    markdown: { content: `## ${title}\n${content}` }
  });
  
  return new Promise((resolve) => {
    try {
      const u = new URL(WECOM_WEBHOOK_URL);
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request({
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, (res) => {
        console.log(`📱 WeCom通知: ${type} ${booking.room} → ${res.statusCode}`);
        resolve();
      });
      req.on('error', (err) => {
        console.error(`📱 WeCom通知失败: ${err.message}`);
        resolve();
      });
      req.write(body);
      req.end();
    } catch(e) {
      console.error(`📱 WeCom通知URL解析失败: ${e.message}`);
      resolve();
    }
  });
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
  sendWecomNotification('created', booking);
  sendSmsNotification('created', booking);
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
  sendWecomNotification('deleted', removed);
  sendSmsNotification('deleted', removed);
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
