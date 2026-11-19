// @ts-check

/** @param {string} value */
export function splitActivitySearch(value) {
  const separator = /(?:^| \| )people:/i.exec(value);
  return separator
    ? { search: value.slice(0, separator.index), people: value.slice(separator.index + separator[0].length).trim() }
    : { search: value, people: '' };
}

/** @param {string} search @param {string} people */
export function joinActivitySearch(search, people) {
  return people ? `${search ? `${search} | ` : ''}people:${people}` : search;
}
