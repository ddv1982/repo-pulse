const svg = content =>
  `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${content}</svg>`;
export const icons = {
  system: svg('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4m-4 0h8"/>'),
  light: svg(
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/>',
  ),
  dark: svg('<path d="M20.9 13.1A9 9 0 0 1 10.9 3.1 9 9 0 1 0 20.9 13.1Z"/>'),
  refresh: svg('<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>'),
  pulse: svg('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'),
  branch: svg(
    '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9c0 5-6 4-11 8"/>',
  ),
};

export function themeSwitch() {
  const selected = window.repoPulseTheme?.get() || 'system';
  return `<div class="seg theme" role="group" aria-label="Theme">${['system', 'light', 'dark'].map(value => `<button type="button" data-theme="${value}" aria-label="${value[0].toUpperCase() + value.slice(1)}" title="${value[0].toUpperCase() + value.slice(1)}" aria-pressed="${value === selected}">${icons[value]}</button>`).join('')}</div>`;
}
