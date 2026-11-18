// @ts-check

// Apply before first paint; System follows the operating system even when it changes while open.
/** The modules read this through window (see src/ui/icons.js). @typedef {{ get: () => string, set: (value: string) => void, apply: () => void }} RepoPulseTheme */
(() => {
  const key = 'repo-pulse-theme';
  const query = matchMedia('(prefers-color-scheme: dark)');
  let choice = 'system';
  try {
    choice = localStorage.getItem(key) || 'system';
  } catch {}
  if (!['system', 'light', 'dark'].includes(choice)) choice = 'system';
  function apply() {
    document.documentElement.classList.toggle('dark', choice === 'dark' || (choice === 'system' && query.matches));
    document.querySelectorAll('[data-theme]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.getAttribute('data-theme') === choice));
    });
  }
  /** @type {Window & { repoPulseTheme?: RepoPulseTheme }} */ (window).repoPulseTheme = {
    get: () => choice,
    set(value) {
      if (!['system', 'light', 'dark'].includes(value)) return;
      choice = value;
      try {
        localStorage.setItem(key, choice);
      } catch {}
      apply();
    },
    apply,
  };
  query.addEventListener('change', apply);
  apply();
})();
