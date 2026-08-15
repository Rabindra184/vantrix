/**
 * The colour theme: which of `tokens.css`'s three blocks is in force.
 *
 * THREE CHOICES, NOT TWO. `system` is the default and is a real state, not
 * the absence of one: it means "follow the OS", so a reader whose machine
 * switches to dark at sunset gets a dark app without touching anything. A
 * two-state toggle has to pick a side at first paint and then disagrees with
 * every other app on that machine for half the day.
 *
 * `system` is expressed by REMOVING `data-theme` rather than by setting it to
 * anything, which is what lets `tokens.css`'s `prefers-color-scheme` block
 * apply. That file's scoping — `:root:not([data-theme='light'])` — is the
 * other half: an explicit light choice beats a dark OS setting because the
 * attribute is present, not because a fourth block re-states the light values.
 *
 * WRITTEN BEFORE REACT MOUNTS, by the inline script in `index.html`. A theme
 * applied in an effect paints the light theme first and then repaints — the
 * white flash every dark-mode site with this bug has. The script and
 * `applyTheme` below must therefore agree about the storage key and the
 * attribute; both are exported from here and the script is a deliberate
 * hand-copy of five lines, because a module import in `<head>` would be the
 * render-blocking round trip the script exists to avoid.
 */
export type ThemeChoice = 'system' | 'light' | 'dark';

/** Shared with the pre-paint script in `index.html`. Change both together. */
export const THEME_STORAGE_KEY = 'perfportal-theme';

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === 'system' || value === 'light' || value === 'dark';
}

/**
 * The stored choice, or `system` when there is none — and also when storage
 * throws, which it does in Safari's private mode and under a
 * `Block third-party cookies` policy in an iframe. A theme preference is not
 * worth a crash on first paint.
 */
export function readTheme(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeChoice(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

/**
 * Put the choice on `<html>` and remember it.
 *
 * The attribute is what `tokens.css` keys on, and — because `charts/theme.ts`'s
 * `resolveChartMode` reads the same attribute — it is also what tells the eight
 * ECharts instances to redraw in the other palette. `Chart.tsx` observes it
 * with a MutationObserver for exactly that reason.
 */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.dataset.theme = choice;

  try {
    localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // A theme that does not survive a reload is a smaller failure than one
    // that throws on the click that set it.
  }
}
