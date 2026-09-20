/**
 * Types for lib/i18n.js, which the browser half imports directly.
 *
 * The host half of this plugin is hand-written ESM with no build step, so it carries no
 * generated declarations. The settings page is TypeScript and imports this module to
 * share ONE string table with the host -- without a declaration file that import is an
 * implicit `any`, and `tsc --noEmit` fails (TS7016). Hand-written and deliberately
 * narrow: only what the browser actually uses.
 */

/** Supported UI languages. `follow-host` is a setting value, not a language. */
export declare const LANGUAGES: readonly ['en', 'zh'];

/** The default when the host exposes nothing and the user has not chosen. */
export declare const FALLBACK_LANGUAGE: 'en';

/** Anchor key pairs that must stay in step: injected header, and the text naming it. */
export declare const ANCHOR_PAIRS: ReadonlyArray<readonly [string, string]>;

/**
 * Look up `key` in `lang`, substituting {placeholders} from `vars`.
 *
 * A missing key falls back to English and then to the key itself, so a typo renders
 * something traceable instead of "undefined".
 */
export declare function t(
  lang: string,
  key: string,
  vars?: Record<string, unknown>,
): string;

/**
 * Resolve the language in force from this plugin's override and the host locale.
 *
 * `hostLocale` is whatever `ctx.settings.get('locale')` returned, which is `undefined`
 * when no settings provider is mounted.
 */
export declare function resolveLanguage(
  override: string | undefined,
  hostLocale: { preference?: string } | undefined,
): 'en' | 'zh';

/** Every key defined for a language, for the test that both tables stay in step. */
export declare function keysOf(lang: string): string[];
