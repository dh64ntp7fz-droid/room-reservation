/**
 * GET /api/config
 * 返回前端所需的 Supabase 配置
 * （anon key 是公开的，可暴露给前端）
 */
export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(500).json({ error: '服务器未配置 SUPABASE_URL / SUPABASE_ANON_KEY' });
  }

  return res.status(200).json({
    supabaseUrl,
    supabaseAnonKey,
  });
}