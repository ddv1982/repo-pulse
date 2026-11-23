const peopleMarker = /(?:^| \| )people:/i;

export function splitActivitySearch(value: string) {
  const [, literal, people] = /^("(?:[^"\\]|\\.)*")(?: \| people:(.*))?$/i.exec(value) ?? [];
  if (literal !== undefined) {
    try {
      return { search: JSON.parse(literal) as string, people: people?.trim() || '' };
    } catch {
      // Incomplete or invalid quotes remain ordinary text while typing.
    }
  }
  const separator = peopleMarker.exec(value);
  return separator
    ? { search: value.slice(0, separator.index), people: value.slice(separator.index + separator[0].length).trim() }
    : { search: value, people: '' };
}

export function joinActivitySearch(search: string, people: string) {
  const text = search.startsWith('"') || peopleMarker.test(search) ? JSON.stringify(search) : search;
  return people ? [text, `people:${people}`].filter(Boolean).join(' | ') : text;
}
