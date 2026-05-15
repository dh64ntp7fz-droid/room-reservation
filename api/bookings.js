import { getSupabase, hasConflict, timeToMinutes } from './_lib/supabase.js';

const supabase = getSupabase();

/**
 * GET /api/bookings?date=YYYY-MM-DD&room=包间名
 * POST /api/bookings { room, name, phone, people, time, date }
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET：查询预订 ──────────────────────────────
  if (req.method === 'GET') {
    try {
      let query = supabase
        .from('bookings')
        .select('*')
        .order('time', { ascending: true });

      if (req.query.date) query = query.eq('date', req.query.date);
      if (req.query.room) query = query.eq('room', req.query.room);

      const { data, error } = await query;
      if (error) {
        console.error('GET /api/bookings 错误:', error);
        return res.status(500).json({ error: error.message });
      }
      return res.status(200).json(data || []);
    } catch (err) {
      console.error('GET /api/bookings 异常:', err);
      return res.status(500).json({ error: '服务器内部错误' });
    }
  }

  // ── POST：新增预订 ─────────────────────────────
  if (req.method === 'POST') {
    try {
      const { room, name, phone, people, time, date } = req.body;

      // 必填校验
      if (!room || !name || !people || !time || !date) {
        return res.status(400).json({ error: '请填写完整信息（包间/姓名/人数/时间/日期为必填）' });
      }

      // 冲突检测（同包间同一天，前后2小时）
      const conflict = await hasConflict(room, date, time);
      if (conflict) {
        return res.status(409).json({
          error: `⛔ ${room} 在 ${date} ${time} 前后2小时内已有预订！`
        });
      }

      const now = new Date().toISOString();
      const booking = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        room,
        name,
        phone: phone || '',
        people: parseInt(people, 10),
        time,
        date,
        created_at: now,
        updated_at: now,
      };

      const { data, error } = await supabase
        .from('bookings')
        .insert(booking)
        .select()
        .single();

      if (error) {
        console.error('POST /api/bookings 错误:', error);
        return res.status(500).json({ error: error.message });
      }

      return res.status(201).json(data);
    } catch (err) {
      console.error('POST /api/bookings 异常:', err);
      return res.status(500).json({ error: '服务器内部错误' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}