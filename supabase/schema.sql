-- Supabase 数据库表结构
-- 在 Supabase Dashboard → SQL Editor 中执行此脚本

-- 1. 创建 bookings 表
CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  room TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  people INTEGER NOT NULL,
  time TEXT NOT NULL,
  date TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. 开启 Realtime（实时订阅）
ALTER PUBLICATION supabase_realtime ADD TABLE bookings;

-- 3. 开启行级安全（可选，内网工具可跳过）
-- ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;

-- 4. 创建索引（加速查询）
CREATE INDEX IF NOT EXISTS idx_bookings_room_date ON bookings(room, date);
CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date);

-- 5. 验证
SELECT 'bookings 表创建成功' AS result;
SELECT * FROM bookings LIMIT 0;