import { getSupabase, hasConflict } from '../_lib/supabase.js';

const supabase = getSupabase();

/**
 * PUT  /api/bookings/:id  编辑预订
 * DELETE /api/bookings/:id  删除预订
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: '缺少预订 ID' });

  // ── PUT：编辑预订 ──────────────────────────────
  if (req.method === 'PUT') {
    try {
      const { room, name, phone, people, time, date } = req.body;

      if (!room || !name || !people || !time || !date) {
        return res.status(400).json({ error: '请填写完整信息（包间/姓名/人数/时间/日期为必填）' });
      }

      // 冲突检测（排除自身）
      const conflict = await hasConflict(room, date, time, id);
      if (conflict) {
        return res.status(409).json({
          error: `⛔ ${room} 在 ${date} ${time} 前后2小时内已有其他预订！`
        });
      }

      const now = new Date().toISOString();
      const { data, error } = await supabase
        .from('bookings')
        .update({
          room,
          name,
          phone: phone || '',
          people: parseInt(people, 10),
          time,
          date,
          updated_at: now,
        })
        .eq('id', id)
        .select()
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          return res.status(404).json({ error: '未找到该预订' });
        }
        console.error('PUT /api/bookings 错误:', error);
        return res.status(500).json({ error: error.message });
      }

      return res.status(200).json(data);
    } catch (err) {
      console.error('PUT /api/bookings 异常:', err);
      return res.status(500).json({ error: '服务器内部错误' });
    }
  }

  // ── DELETE：删除预订 ───────────────────────────
  if (req.method === 'DELETE') {
    try {
      // 先查出被删预订信息（用于前端通知）
      const { data: existing } = await supabase
        .from('bookings')
        .select('id, room, date')
        .eq('id', id)
        .single();

      const { error } = await supabase.from('bookings').delete().eq('id', id);

      if (error) {
        if (error.code === 'PGRST116') {
          return res.status(404).json({ error: '未找到该预订' });
        }
        console.error('DELETE /api/bookings 错误:', error);
        return res.status(500).json({ error: error.message });
      }

      return res.status(200).json({
        success: true,
        deleted: existing || { id },
      });
    } catch (err) {
      console.error('DELETE /api/bookings 异常:', err);
      return res.status(500).json({ error: '服务器内部错误' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}