// UI language: follow DSH's language setting (Settings → General).
// Same rule as dsh-workspace-trust; each plugin keeps its own copy because
// plugins never import each other's code.
//
// The setting is the volatile `preference` field of the
// `@deepseek-ai/dsh-client-locale` row (a cosmokit volatile reference with
// `get()`). It is absent while the user lets the browser decide; the Host cannot
// see the browser, so the operating-system locale stands in.
//
// Strings are `L(zh, en)` values that pick their language when converted to a
// string, so text stored earlier still follows a later language change.

const LOCALE_ROW = '@deepseek-ai/dsh-client-locale';

let source = () => undefined;

/** Set where the language preference comes from (`() => tag | undefined`). */
export function setLocaleSource(fn) {
  source = typeof fn === 'function' ? fn : () => undefined;
}

export function osLocale() {
  try { return Intl.DateTimeFormat().resolvedOptions().locale; } catch { return undefined; }
}

/** `'zh'` for any Chinese tag, otherwise `'en'`. */
export function normalizeLocale(tag) {
  return /^zh(?:[-_]|$)/i.test(String(tag ?? '')) ? 'zh' : 'en';
}

/** The current UI language: `'zh'` or `'en'`. */
export function lang() {
  let tag;
  try { tag = source(); } catch { tag = undefined; }
  return normalizeLocale(tag ?? osLocale());
}

/** Read the language preference from the loader tree; undefined when unset. */
export function preferenceFromLoader(loader) {
  const entries = loader?.entries?.();
  if (entries === undefined) return undefined;
  for (const entry of entries) {
    if (entry?.options?.name !== LOCALE_ROW) continue;
    const live = entry.fiber?.config?.preference;
    const value = live !== null && typeof live === 'object' && typeof live.get === 'function' ? live.get() : live;
    if (typeof value === 'string' && value !== '') return value;
    const raw = entry.options?.config?.preference;
    if (typeof raw === 'string' && raw !== '') return raw;
  }
  return undefined;
}

class Text {
  /** @param zh/en - a string, or a function rendering one (so nested Text stays lazy). */
  constructor(zh, en) { this.zh = zh; this.en = en; }
  toString() {
    const v = lang() === 'zh' ? this.zh : this.en;
    return typeof v === 'function' ? v() : v;
  }
}

/**
 * A string in both languages that renders in the current one.
 * Interpolated values that are themselves `L(...)` must be passed through `T`
 * (or a function) so they render at display time too, not when this is built.
 */
export const L = (zh, en) => new Text(zh, en);

/** Tagged template: `T\`...${x}...\`` renders `x` lazily (at display time). */
export const T = (strings, ...values) => () => strings.reduce((out, s, i) => out + s + (i < values.length ? String(values[i]) : ''), '');
