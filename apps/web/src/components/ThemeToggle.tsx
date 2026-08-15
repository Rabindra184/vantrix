import { useState } from 'react';
import { MonitorIcon, MoonIcon, SunIcon } from './icons';
import { applyTheme, readTheme, type ThemeChoice } from '../theme';

/**
 * The theme control: three segments, always all visible.
 *
 * A SEGMENTED CONTROL, NOT A CYCLING ICON BUTTON. The one-button form is
 * smaller and is what most sites ship, and it is worse on every count that
 * matters here. With three states it takes up to two clicks to reach the one
 * you want and there is no way to see what the other two are without
 * travelling through them; its accessible name has to change on every press,
 * so a screen-reader user hears a different control each time; and it cannot
 * show which state is current, only which one is next — the ambiguity every
 * "does the sun mean it IS light or will BECOME light" argument comes from.
 * Three radios have none of those problems and cost about 90px.
 *
 * `role="radiogroup"` with three `role="radio"` buttons rather than a
 * `<fieldset>` of real `<input type="radio">`: the visual is a joined pill
 * where each segment is an icon, and a real radio brings a UA-drawn dot that
 * has to be hidden and a label that has to be re-associated. The ARIA pattern
 * is what a screen reader needs — a group, a name, and `aria-checked` on
 * exactly one member — and this supplies all three. Arrow-key roving focus is
 * NOT implemented, so every segment is a tab stop: three stops is a smaller
 * cost than a keyboard interaction this repo has no browser test to prove.
 *
 * No `useEffect` on mount. The theme is already on `<html>` before React runs
 * (the inline script in `index.html`), so an effect that re-applied it would
 * be a second write of a value that is already correct — and `useState`'s
 * initialiser reading the same storage keeps this component's idea of the
 * choice identical to the document's from its first render.
 */
const OPTIONS: readonly { value: ThemeChoice; label: string; Icon: typeof SunIcon }[] = [
  { value: 'light', label: 'Light', Icon: SunIcon },
  { value: 'dark', label: 'Dark', Icon: MoonIcon },
  { value: 'system', label: 'System', Icon: MonitorIcon },
];

export default function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(() =>
    typeof document === 'undefined' ? 'system' : readTheme(),
  );

  function select(next: ThemeChoice) {
    setChoice(next);
    applyTheme(next);
  }

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className="flex items-center gap-0.5 rounded-lg border border-default bg-sunken p-0.5"
    >
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = value === choice;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            // The visible content is an icon, so the NAME has to come from
            // here. "Light theme", not "Light": a screen reader announces the
            // group's name once on entry and then each option's own name, and
            // a bare "Light" among three of them is ambiguous out of context.
            aria-label={`${label} theme`}
            title={`${label} theme`}
            onClick={() => select(value)}
            className={`transition-ui flex h-7 w-7 items-center justify-center rounded-md ${
              active
                ? 'bg-surface text-primary shadow-panel'
                : 'text-muted hover:text-primary'
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        );
      })}
    </div>
  );
}
