// A compile-time test, checked by `npm run check:types`: markup names an action only through `action()`, whose name must
// be one of the listed actions, and the dispatcher's table must handle every listed action and no other. The check
// fails when a line marked as an expected error compiles. Nothing imports this file and nothing calls it.
import { action, type Actions, type ActionName } from '../src/ui/actions.ts';

export function actionNamesAreChecked(table: Actions<ActionName>) {
  action('detail');
  // @ts-expect-error A name the action list does not hold.
  action('no-such-action');
  // @ts-expect-error A table without a handler for every action.
  const missing: Actions<ActionName> = { detail: () => {} };
  // @ts-expect-error A handler for a name the action list does not hold.
  const extra: Actions<'detail'> = { detail: () => {}, 'no-such-action': () => {} };
  return [table, missing, extra];
}
