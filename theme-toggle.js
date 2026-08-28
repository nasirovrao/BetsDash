// Переключатель тёмной/светлой темы — общий для всех страниц EDGE.
// Хранит выбор в localStorage ('edge-theme': 'light' | отсутствует = dark),
// применяется через data-theme="light" на <html>. Сама атрибут-заявка на
// раннее применение (до отрисовки, без "мигания" не той темой) — в
// маленьком инлайн-скрипте в <head> каждой страницы (см. theme-init).
// Этот файл только рисует и обслуживает саму кнопку-переключатель.
(function () {
  function currentTheme() {
    try {
      return localStorage.getItem('edge-theme') === 'light' ? 'light' : 'dark';
    } catch (e) {
      return 'dark';
    }
  }

  function applyTheme(theme) {
    if (theme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }

  var SUN_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"></circle><line x1="12" y1="2" x2="12" y2="4.5"></line><line x1="12" y1="19.5" x2="12" y2="22"></line><line x1="4.2" y1="4.2" x2="5.9" y2="5.9"></line><line x1="18.1" y1="18.1" x2="19.8" y2="19.8"></line><line x1="2" y1="12" x2="4.5" y2="12"></line><line x1="19.5" y1="12" x2="22" y2="12"></line><line x1="4.2" y1="19.8" x2="5.9" y2="18.1"></line><line x1="18.1" y1="5.9" x2="19.8" y2="4.2"></line></svg>';
  var MOON_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"></path></svg>';

  var btn = null;

  function updateBtn(theme) {
    if (!btn) return;
    // Иконка показывает, ЧТО включится по клику (солнце = "включить
    // светлую", когда сейчас тёмная), а не текущее состояние — так
    // привычнее большинству подобных переключателей.
    btn.innerHTML = theme === 'light' ? MOON_SVG : SUN_SVG;
    btn.setAttribute('aria-label', theme === 'light' ? 'Включить тёмную тему' : 'Включить светлую тему');
    btn.title = btn.getAttribute('aria-label');
  }

  function setTheme(theme) {
    applyTheme(theme);
    try {
      localStorage.setItem('edge-theme', theme);
    } catch (e) {
      /* приватный режим / заблокировано — переключатель всё равно работает
         в рамках текущей вкладки, просто не запомнится между визитами. */
    }
    updateBtn(theme);
  }

  function init() {
    // .topbar-user есть на всех приватных страницах и на public.html;
    // .topbar .wrap — фолбэк для index.html/reset-password.html (там нет
    // topbar-user, только сам topbar).
    var host = document.querySelector('.topbar-user') || document.querySelector('.topbar .wrap');
    if (!host) return;
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-toggle-btn';
    host.insertBefore(btn, host.firstChild);
    btn.addEventListener('click', function () {
      setTheme(currentTheme() === 'light' ? 'dark' : 'light');
    });
    updateBtn(currentTheme());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
