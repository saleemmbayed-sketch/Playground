/**
 * URL slugs for buyer names.
 *
 * Lives in its own module because both the ingest path (which stores the slug
 * on every notice) and the query path (which looks buyers up by it) need it,
 * and neither should have to import the forecasting engine to get it.
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    // German transliteration must happen before diacritics are stripped,
    // otherwise "Finanzbehörde" becomes "finanzbehorde" instead of "-behoerde".
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'buyer';
}
