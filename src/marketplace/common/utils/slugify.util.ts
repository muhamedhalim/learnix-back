import { randomBytes } from 'node:crypto';

/**
 * A stable, URL-safe slug with a random suffix to avoid collisions —
 * shared by every marketplace entity that needs one (instructor, course,
 * category). Supports Arabic text (the `؀-ۿ` range) alongside ASCII.
 */
export function slugify(text: string, fallback: string): string {
  const base = text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9؀-ۿ]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const suffix = randomBytes(3).toString('hex');
  return `${base || fallback}-${suffix}`;
}
