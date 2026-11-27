export function foldSearchText(text: string) {
  const lower = text.toLowerCase();
  if (!/\P{ASCII}/u.test(lower)) return lower;
  return lower.replace(/\p{Script=Latin}[\p{Script=Latin}\p{M}]*/gu, span =>
    span.normalize('NFD').replace(/[\p{M}&&\p{Diacritic}&&[\p{Script_Extensions=Latin}\p{Script=Inherited}]]+/gv, ''),
  );
}

export const PEOPLE_LIMIT_MESSAGE = 'Enter up to 12 names and 300 characters in People.';

/** The names in a People filter, or null when it has more than 12 names or 300 characters. */
export function peopleNames(value: string): string[] | null {
  const names = parseSearchTerms(value);
  return value.length > 300 || names.length > 12 ? null : names;
}

export function parsePeople(value: string) {
  const names = peopleNames(value);
  if (!names) throw new Error(PEOPLE_LIMIT_MESSAGE);
  return names;
}

function matchesName(name: string, term: string) {
  if (name.includes(term)) return true;
  if (!/\s/u.test(term)) return false;
  const wordPattern = /[\p{L}\p{M}\p{N}]+/gu;
  const parts = term.match(wordPattern);
  if (!parts || parts.length < 2) return false;
  const words = name.match(wordPattern) || [];
  let previous = -1;
  return parts.every(part => {
    previous = words.findIndex((word, index) => index > previous && word.startsWith(part));
    return previous !== -1;
  });
}

export function parseSearchTerms(value: string) {
  return [
    ...new Set(
      value
        .split(',')
        .map(term => term.trim().toLowerCase())
        .filter(Boolean),
    ),
  ].sort();
}

export function matchesPersonName(name: string, terms: string[]) {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return false;
  if (terms.some(term => normalized.includes(term))) return true;
  const folded = foldSearchText(normalized);
  return terms.some(term => matchesName(folded, foldSearchText(term)));
}
