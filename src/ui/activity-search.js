// @ts-check

const peopleMarker = /(?:^| \| )people:/i;

/** @param {string} value */
export function splitActivitySearch(value) {
  const quoted = /^("(?:[^"\\]|\\.)*")(?: \| people:(.*))?$/i.exec(value);
  if (quoted) {
    try {
      return { search: /** @type {string} */ (JSON.parse(quoted[1])), people: quoted[2]?.trim() || '' };
    } catch {
      // Incomplete or invalid quotes remain ordinary text while typing.
    }
  }
  const separator = peopleMarker.exec(value);
  return separator
    ? { search: value.slice(0, separator.index), people: value.slice(separator.index + separator[0].length).trim() }
    : { search: value, people: '' };
}

/** @param {string} search @param {string} people */
export function joinActivitySearch(search, people) {
  const text = search.startsWith('"') || peopleMarker.test(search) ? JSON.stringify(search) : search;
  return people ? [text, `people:${people}`].filter(Boolean).join(' | ') : text;
}
