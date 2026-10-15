import { AsyncLocalStorage } from 'node:async_hooks';

// CLI language selection is separate from the scoped render context. Sampling,
// database records and user-provided content never pass through translation.
export const SUPPORTED_LOCALES = Object.freeze(['zh-CN', 'zh-TW', 'en', 'ja']);
export const DEFAULT_LOCALE = 'zh-CN';
export const LOCALE_NAMES = Object.freeze({ 'zh-CN': '简体中文', 'zh-TW': '繁體中文', en: 'English', ja: '日本語' });
const context = new AsyncLocalStorage();
let defaultLocale = DEFAULT_LOCALE;

export function normalizeLocale(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\..*$/, '').replace(/@.*$/, '').replaceAll('_', '-').toLowerCase();
  if (!name || name === 'auto') return null;
  if (name === 'c' || name === 'posix') return 'en';
  if (name === 'en' || name.startsWith('en-')) return 'en';
  if (name === 'ja' || name.startsWith('ja-')) return 'ja';
  if (name === 'zh' || name.startsWith('zh-')) {
    return /(?:^|-)(?:hant|tw|hk|mo)(?:-|$)/.test(name) ? 'zh-TW' : 'zh-CN';
  }
  return null;
}

export function resolveLocale(requested = 'auto', env = process.env) {
  if (requested && String(requested).toLowerCase() !== 'auto') {
    const normalized = normalizeLocale(requested);
    if (!normalized) throw new RangeError('Unsupported language: ' + requested + '. Supported: ' + SUPPORTED_LOCALES.join(', '));
    return normalized;
  }
  for (const key of ['CODEX_MONITOR_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const value = env[key];
    if (typeof value !== 'string' || !value.trim() || value.toLowerCase() === 'auto') continue;
    // The highest-priority configured locale wins; unsupported system locales
    // fall back to English rather than accidentally using a lower-priority one.
    return normalizeLocale(value) || 'en';
  }
  return 'en';
}

export function getLocale() { return context.getStore() || defaultLocale; }

export function setLocale(locale) {
  const normalized = normalizeLocale(locale);
  if (!normalized) throw new RangeError('Unsupported language: ' + locale);
  defaultLocale = normalized;
  return normalized;
}

export function withLocale(locale, callback) {
  const normalized = normalizeLocale(locale);
  if (!normalized) throw new RangeError('Unsupported language: ' + locale);
  return context.run(normalized, callback);
}

export function translate(catalog, key, values = {}, locale = getLocale()) {
  const entry = Object.hasOwn(catalog, key) ? catalog[key] : null;
  const language = normalizeLocale(locale) || 'en';
  const template = typeof entry === 'string' ? entry : entry?.[language] ?? entry?.en ?? entry?.['zh-CN'] ?? key;
  return String(template).replace(/\{([A-Za-z0-9_]+)\}/g, (match, name) =>
    Object.hasOwn(values, name) ? String(values[name]) : match);
}

export function createTranslator(catalog) {
  return (key, values, locale) => translate(catalog, key, values, locale);
}

export function formatAgo(timestamp, now = Date.now(), locale = getLocale()) {
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) return '—';
  const seconds = Math.round((now - timestamp) / 1000);
  if (!Number.isFinite(seconds)) return '—';
  const unit = seconds < 60 ? 'second' : seconds < 3600 ? 'minute' : seconds < 86400 ? 'hour' : 'day';
  const divisor = { second: 1, minute: 60, hour: 3600, day: 86400 }[unit];
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-Math.max(0, Math.floor(seconds / divisor)), unit);
}

