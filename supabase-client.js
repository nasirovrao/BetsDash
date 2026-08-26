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
export async function isClvEnabled() {
  const { data } = await supabase.from('settings').select('clv_tracker_enabled').maybeSingle();
  return !!(data && data.clv_tracker_enabled);
}
