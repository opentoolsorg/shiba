(() => {
  let preference = null;
  try {
    preference = document.cookie.match(/(?:^|;\s*)shiba-theme=(light|dark|system)(?:;|$)/)?.[1]
      ?? localStorage.getItem('shiba-theme');
  } catch {}
  if (preference !== 'light' && preference !== 'dark' && preference !== 'system') preference = 'system';
  const dark = preference === 'dark' || (preference === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.setAttribute('content', dark ? '#09090b' : '#fafafa');
  if (document.cookie.match(/(?:^|;\s*)shiba-theme=(light|dark|system)(?:;|$)/)) {
    try { localStorage.setItem('shiba-theme', preference); } catch {}
  }
})();
