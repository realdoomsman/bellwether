// Pre-paint theme: runs synchronously in <head> (same-origin file, allowed by `script-src 'self'`)
// so the first frame already has the right theme. An explicit choice (localStorage) wins; otherwise
// the system setting. Kept in sync afterwards by src/lib/prefs.ts.
(function () {
  var root = document.documentElement;
  var theme = 'paper';
  try {
    var stored = localStorage.getItem('bw:theme');
    if (stored === 'paper' || stored === 'after-hours') theme = stored;
    else if (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) theme = 'after-hours';
  } catch (e) {}
  root.setAttribute('data-theme', theme);
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'after-hours' ? '#0E0D0B' : '#F5F2EA');
})();
