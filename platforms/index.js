/* Roteamento: descobre a plataforma de cada link pelo hostname. */
import * as instagram from './instagram.js';
import * as x from './x.js';

export const platforms = [instagram, x];

/** Retorna {platform, parsed} ou null se nenhuma plataforma reconhecer o link. */
export function detectPlatform(line) {
  for (const platform of platforms) {
    const parsed = platform.parse(line);
    if (parsed) return { platform, parsed };
  }
  return null;
}

export function parseLinks(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}
