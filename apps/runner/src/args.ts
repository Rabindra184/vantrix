import { RunnerExecutionError } from './errors.js';

/**
 * Minimal shell-like tokenizer for JVM options. It supports quotes and
 * backslash escaping, then passes tokens to spawn() without a shell.
 */
export function splitArgs(raw: string | null): string[] {
  if (!raw) return [];

  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const char of raw) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (escaped) current += '\\';
  if (quote) {
    throw new RunnerExecutionError(
      'INVALID_JAVA_OPTIONS',
      'JVM options contain an unterminated quoted string.',
      'Fix the JVM options field and queue a new run.',
    );
  }
  if (current) args.push(current);
  return args;
}

export function systemPropertyArgs(systemProperties: Record<string, string>): string[] {
  return Object.entries(systemProperties)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `-D${key}=${value}`);
}
