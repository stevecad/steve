import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = new URL('../src/', import.meta.url);

export async function resolve(specifier, context, next) {
  // The web app's `@/…` alias (vite.config.ts) is web/src/….
  if (specifier.startsWith('@/') && context.parentURL?.endsWith('.ts')) specifier = new URL(specifier.slice(2), SRC).href;
  if (/^(\.\.?\/|file:)/.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier) && context.parentURL?.endsWith('.ts')) {
    for (const suffix of ['.ts', '/index.ts']) {
      const url = new URL(specifier + suffix, context.parentURL);
      if (existsSync(fileURLToPath(url))) return next(url.href, context);
    }
  }
  return next(specifier, context);
}
