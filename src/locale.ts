// UI language: follow DSH's language setting (Settings → General).
//
// The setting is the volatile `preference` field of the
// `@deepseek-ai/dsh-client-locale` row (a cosmokit volatile reference with
// `get()`). It is absent while the user lets the browser decide; the Host cannot
// see the browser, so the operating-system locale stands in.
//
// Strings are `L(zh, en)` values that pick their language when converted to a
// string, so text stored earlier still follows a later language change.

const LOCALE_ROW = '@deepseek-ai/dsh-client-locale'

/** Either language's rendered text, or a thunk so nested text stays lazy. */
export type TextValue = string | (() => string)

export type LocaleTag = 'zh' | 'en'

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

/** `'zh'` for any Chinese tag, otherwise `'en'`. */
export function normalizeLocale(tag: unknown): LocaleTag {
  return /^zh(?:[-_]|$)/i.test(String(tag ?? '')) ? 'zh' : 'en'
}

/** The current UI language: `'zh'` or `'en'`. */
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
 * A string in both languages that renders in the current one.
 *
 * Instances are plain values: `String(x)` and template interpolation both pick
 * the language at that moment, which is why stored text follows a later change.
 */
export class Text {
  readonly zh: TextValue
  readonly en: TextValue

  /** @param zh/en - the text in that language, or a function rendering it (so nested Text stays lazy). */
  constructor(zh: TextValue, en: TextValue) {
    this.zh = zh
    this.en = en
  }

  toString(): string {
    const v = lang() === 'zh' ? this.zh : this.en
    return typeof v === 'function' ? v() : v
  }
}

/**
 * A string in both languages that renders in the current one.
 * Interpolated values that are themselves `L(...)` must be passed through `T`
 * (or a function) so they render at display time too, not when this is built.
 */
export const L = (zh: TextValue, en: TextValue): Text => new Text(zh, en)

/** Tagged template: ``T`...${x}...` `` renders `x` lazily (at display time). */
export const T = (strings: TemplateStringsArray, ...values: unknown[]): (() => string) => () =>
  strings.reduce((out, s, i) => out + s + (i < values.length ? String(values[i]) : ''), '')
