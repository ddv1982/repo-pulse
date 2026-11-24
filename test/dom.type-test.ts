// A compile-time test, checked by `npm run check:types`: setHtml takes only SafeHtml built by `html`. The check fails
// when a line marked as an expected error compiles, for example if SafeHtml lost its private-field brand and became a
// plain object type that strings and lookalikes match. Nothing imports this file and nothing calls it.
import { setHtml } from '../src/ui/dom.ts';
import { html, type SafeHtml } from '../src/ui/format.ts';

export function setHtmlTakesOnlySafeHtml(element: Element, built: SafeHtml) {
  setHtml(element, html`<b>built</b>`);
  setHtml(element, built);
  // @ts-expect-error A raw string is not SafeHtml.
  setHtml(element, '<b>raw</b>');
  // @ts-expect-error A plain array, even of SafeHtml, is not SafeHtml; html`${array}` joins one.
  setHtml(element, [html`<b>one</b>`, html`<b>two</b>`]);
  // @ts-expect-error An object with SafeHtml's public members but not its private field is not SafeHtml.
  setHtml(element, { toString: () => '<b>lookalike</b>' });
}
