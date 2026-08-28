// Общий клиент Supabase — подключается один раз, используется и на странице
// входа, и на странице ставок.
//
// URL и ключ ниже — публичные (anon key), их можно спокойно держать в коде
// на клиенте: защита данных идёт не через секретность этого ключа, а через
// правила Row Level Security в самой базе (см. schema.sql).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://fyqqtgehhtpzwqcrmjjx.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_El4mwQ1qAf9KXCsWqp9PIw_c5n0go_4';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Достаёт текущую сессию; если пользователь не залогинен — отправляет
// на страницу входа. Используется в начале защищённых страниц (app.html).
export async function requireSession() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    window.location.href = 'index.html';
    return null;
  }
  return session;
}

// CLV Tracker включается точечно, по конкретному пользователю — через
// settings.clv_tracker_enabled (флаг ставит администратор вручную в Supabase
// Table Editor). Используется, чтобы показать/скрыть пункт "CLV Tracker" в
// навигации на всех страницах, а также на самой clv.html.
//
// ВАЖНО: settings — таблица НЕ "один пользователь = одна строка", а "один
// пользователь = одна строка НА КАЖДЫЙ канал" (личный дневник + Cybervalue +
// любые дополнительные каналы, см. channel-архитектуру). Раньше здесь был
// select().maybeSingle() совсем без фильтра — как только у пользователя
// появлялась вторая строка settings (второй канал), Supabase возвращал
// больше одной строки, maybeSingle() расценивал это как ошибку (PGRST116,
// "нужно 0 или 1 строк") и молча отдавал data:null — флаг выглядел
// выключенным, даже если админ честно проставил TRUE в нужной строке.
// Теперь — явный фильтр по текущему пользователю и проверка "включено ли
// ХОТЯ БЫ в одной из его строк" вместо ожидания ровно одной строки.
export async function isClvEnabled() {
  const { data: { session } } = await supabase.auth.getSession();
  const uid = session && session.user && session.user.id;
  if (!uid) return false;
  const { data } = await supabase
    .from('settings')
    .select('clv_tracker_enabled')
    .eq('user_id', uid)
    .eq('clv_tracker_enabled', true)
    .limit(1);
  return !!(data && data.length);
}
