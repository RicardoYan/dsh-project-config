// UI language: follow DSH's language setting (Settings → General).
//
// The setting is the volatile `preference` field of the
// `@deepseek-ai/dsh-client-locale` row (a cosmokit volatile reference with
// `get()`). It is absent while the user lets the browser decide; the Host cannot
// see the browser, so the operating-system locale stands in.
//
// DSH 0.2.2 ships eight UI languages (de/en/es/fr/ja/pt/ru/zh). Strings are
// `L(zh, en)` values that pick their language when converted to a string, so
// text stored earlier still follows a later language change. A string may carry
// a third argument with the remaining languages; without one, or when that
// language is missing from the map, English is shown — never a half-translated
// sentence.

const LOCALE_ROW = '@deepseek-ai/dsh-client-locale'

/** Either language's rendered text, or a thunk so nested text stays lazy. */
export type TextValue = string | (() => string)

/** Every UI language DSH 0.2.2 offers. */
export const LOCALES = ['de', 'en', 'es', 'fr', 'ja', 'pt', 'ru', 'zh'] as const

export type LocaleTag = (typeof LOCALES)[number]

/** The languages this plugin translates, excluding `zh`/`en`. */
export type ExtraLocales = Partial<Record<'de' | 'es' | 'fr' | 'ja' | 'pt' | 'ru', TextValue>>

/** The row shape read from the loader tree; only these fields are consulted. */
interface LoaderEntry {
  options?: { name?: string; config?: { preference?: unknown } }
  fiber?: { config?: { preference?: unknown } } | null
}

export interface LoaderLike {
  entries?: () => Iterable<LoaderEntry>
}

let source: () => string | undefined = () => undefined

/** Set where the language preference comes from (`() => tag | undefined`). */
export function setLocaleSource(fn: (() => string | undefined) | undefined): void {
  source = typeof fn === 'function' ? fn : () => undefined
}

export function osLocale(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale
  } catch {
    return undefined
  }
}

/**
 * The primary language subtag, when DSH offers it.
 *
 * Anything DSH does not ship (`en-GB`, `nb`, an unknown tag) resolves to `en`
 * rather than to an arbitrary entry in the map.
 */
export function normalizeLocale(tag: unknown): LocaleTag {
  const primary = (String(tag ?? '').toLowerCase().split(/[-_]/)[0] ?? '').trim()
  return (LOCALES as readonly string[]).includes(primary) ? (primary as LocaleTag) : 'en'
}

/** The current UI language: one of {@link LOCALES}. */
export function lang(): LocaleTag {
  let tag: string | undefined
  try {
    tag = source()
  } catch {
    tag = undefined
  }
  return normalizeLocale(tag ?? osLocale())
}

/** Read the language preference from the loader tree; undefined when unset. */
export function preferenceFromLoader(loader: LoaderLike | undefined): string | undefined {
  const entries = loader?.entries?.()
  if (entries === undefined) return undefined
  for (const entry of entries) {
    if (entry?.options?.name !== LOCALE_ROW) continue
    const live = entry.fiber?.config?.preference
    const value =
      live !== null && typeof live === 'object' && typeof (live as { get?: unknown }).get === 'function'
        ? (live as { get: () => unknown }).get()
        : live
    if (typeof value === 'string' && value !== '') return value
    const raw = entry.options?.config?.preference
    if (typeof raw === 'string' && raw !== '') return raw
  }
  return undefined
}

/**
 * A string in every language this plugin translates that renders in the current one.
 *
 * Instances are plain values: `String(x)` and template interpolation both pick
 * the language at that moment, which is why stored text follows a later change.
 * `extra` carries the remaining DSH languages; a language it does not name falls
 * back to `en`, so a partially translated sentence never renders half in one
 * language and half in another.
 */
export class Text {
  readonly zh: TextValue
  readonly en: TextValue
  readonly extra: ExtraLocales

  /**
   * @param zh/en - the text in that language, or a function rendering it (so nested Text stays lazy).
   * @param extra - the other DSH languages this string is translated into.
   */
  constructor(zh: TextValue, en: TextValue, extra: ExtraLocales = {}) {
    this.zh = zh
    this.en = en
    this.extra = extra
  }

  toString(): string {
    const tag = lang()
    let v: TextValue = this.en
    if (tag === 'zh') v = this.zh
    else if (tag !== 'en') v = this.extra[tag as keyof ExtraLocales] ?? this.en
    return typeof v === 'function' ? v() : v
  }
}

/**
 * A string that renders in the current language.
 * Interpolated values that are themselves `L(...)` must be passed through `T`
 * (or a function) so they render at display time too, not when this is built.
 * @param zh - Chinese text.
 * @param en - English text, also the fallback for every language not in `extra`.
 * @param extra - translations for the other DSH languages.
 */
export const L = (zh: TextValue, en: TextValue, extra?: ExtraLocales): Text => new Text(zh, en, extra)

/** Tagged template: ``T`...${x}...` `` renders `x` lazily (at display time). */
export const T = (strings: TemplateStringsArray, ...values: unknown[]): (() => string) => () =>
  strings.reduce((out, s, i) => out + s + (i < values.length ? String(values[i]) : ''), '')
