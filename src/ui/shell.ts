import type { BrowserUi } from './browser-view.ts';
import type { Commands } from './commands.ts';
import type { Feedback } from './feedback.ts';
import type { PageState, createRefreshController } from './refresh.ts';
import type { createNavigation } from './navigation.ts';
import type { createConfirmation } from './confirm.ts';

/**
 * What the route controllers share: the navigation state in `ui`, the loaded page state, and the page's ways to load,
 * render, confirm and report. web.ts builds it once.
 */
export type Shell = {
  ui: BrowserUi;
  page: HTMLElement;
  request: typeof import('../api.ts').request;
  state: () => PageState;
  load: ReturnType<typeof createRefreshController>['load'];
  renderPage: () => void;
  navigation: ReturnType<typeof createNavigation>;
  feedback: Feedback;
  commands: Commands;
  confirm: ReturnType<typeof createConfirmation>['ask'];
};
