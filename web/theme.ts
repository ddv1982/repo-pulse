// Apply before first paint; System follows the operating system even when it changes while open.
type RepoPulseTheme = { get: () => string; set: (value: string) => void; apply: () => void };
/** This classic script defines `repoPulseTheme` before the modules load; they read it through window. */
// oxlint-disable-next-line no-unused-vars -- a script-scope interface merges into the global Window type.
interface Window {
  repoPulseTheme?: RepoPulseTheme;
}
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
  window.repoPulseTheme = {
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
