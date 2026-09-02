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
//
// 02.09.2026: баг — при переходе С feed.html (публичная лента, где сессия
// часто успевает состариться, её там подолгу читают, а страница не форсит
// refresh) НА любую приватную страницу иногда на долю секунды мелькала форма
// входа, после чего index.html сам тут же отправлял обратно на
// dashboard.html. Причина — гонка при холодной загрузке страницы: первый же
// getSession() иногда успевал отработать раньше, чем клиент Supabase
// дочитал/обновил токен из localStorage, и ложно возвращал session:null,
// хотя сессия на самом деле была жива (это подтверждал сам index.html долей
// секунды спустя). Раньше на такой единичный null редирект срабатывал сразу,
// без права на пересмотр.
//
// Фикс — не доверять первому null слепо: если getSession() ничего не нашёл,
// даём клиенту короткий шанс (до 800мс) прислать актуальное состояние через
// onAuthStateChange, и только если и оно молчит — редиректим по-настоящему.
// Для реально разлогиненного пользователя это добавляет максимум ~0.8с
// перед ожидаемым редиректом на index.html, поведение не меняется.
export async function requireSession() {
  let { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    session = await new Promise((resolve) => {
      let settled = false;
      const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
        if (settled) return;
        settled = true;
        sub.subscription.unsubscribe();
        resolve(s);
      });
      setTimeout(() => {
        if (settled) return;
        settled = true;
        sub.subscription.unsubscribe();
        resolve(null);
      }, 800);
    });
  }
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
