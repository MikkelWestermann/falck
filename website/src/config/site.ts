const BASE = import.meta.env.BASE_URL ?? '';

export const SITE = {
  title: 'Falck',
  description: 'Falck is the AI IDE that helps non-technical teammates contribute to real codebases with guardrails and clarity.',
  url: 'https://mikkelwestermann.github.io/falck',
  theme: 'system',
  lang: 'en',
} as const;

/** Resolves a path with the base URL for subpath deployment (e.g. /falck on GitHub Pages) */
export function resolvePath(path: string): string {
  const normalizedBase = BASE === '/' ? '' : BASE.replace(/\/$/, '');
  const normalizedPath = path.startsWith('/') ? path : '/' + path;

  return normalizedBase + normalizedPath;
}
