import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('⚠️  缺少 SUPABASE_URL 或 SUPABASE_ANON_KEY 环境变量');
}

const supabase = createClient(supabaseUrl, supabaseKey);

export function getSupabase() {
  return supabase;
}

/**
 * 时间字符串转分钟数
 * @param {string} t - 格式 HH:MM
 * @returns {number}
 */
export function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/**
 * 冲突检测：同包间同一天，前后2小时（120分钟）内不可预订
 * @param {string} room
 * @param {string} date
 * @param {string} time
 * @param {string|null} excludeId - 编辑时排除自身
 * @returns {Promise<boolean>}
 */
export async function hasConflict(room, date, time, excludeId = null) {
  const { data: bookings, error } = await supabase
    .from('bookings')
    .select('id, room, date, time')
    .eq('room', room)
    .eq('date', date);

  if (error) {
    console.error('冲突检测失败:', error.message);
    return false; // 出错时不阻止预订
  }

  if (!bookings || bookings.length === 0) return false;

  const t = timeToMinutes(time);
  return bookings.some(b => {
    if (excludeId && b.id === excludeId) return false;
    const bt = timeToMinutes(b.time);
    return Math.abs(t - bt) < 120;
  });
}