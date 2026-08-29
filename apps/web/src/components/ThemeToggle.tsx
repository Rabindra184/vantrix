import { useRef, useState, type KeyboardEvent } from 'react';
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
 * exactly one member — and this supplies all three.
 *
 * ═══ ROVING FOCUS, BECAUSE HALF THE PATTERN IS WORSE THAN NONE ═══
 *
 * This shipped with `role="radio"` and NO arrow-key handling, on the argument
 * that three tab stops cost less than an interaction with no browser test
 * over it. That trade was the wrong way round. `role="radio"` is a PROMISE to
 * assistive technology: a screen reader announces "radio button, 1 of 3" and
 * its user then presses an arrow key, because that is what the role means.
 * Nothing happened. Three plain tab stops would at least have been honest.
 *
 * So the group is one tab stop — only the checked segment has `tabIndex=0`,
 * per the APG's roving-tabindex rule — and Left/Up and Right/Down move the
 * selection with wraparound, Home/End jump to the ends, and Space selects
 * whatever has focus. Selection FOLLOWS focus here, which the APG allows and
 * prefers for a group this small with no cost to changing your mind.
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
  // One entry per option, in OPTIONS order, so an arrow key can move DOM
  // focus and not merely the checked state — a roving tabindex that never
  // moves focus leaves the keyboard user's caret on a segment that is no
  // longer the tab stop.
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  function select(next: ThemeChoice) {
    setChoice(next);
    applyTheme(next);
  }

  /**
   * Both orientations on purpose. The APG maps Right/Down and Left/Up to the
   * same movement for a radio group precisely so a user does not have to know
   * whether the author laid it out in a row or a column; this one is a row,
   * and a reader who presses Down should not meet silence.
   */
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = OPTIONS.length - 1;
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = index === last ? 0 : index + 1;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = index === 0 ? last : index - 1;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = last;
        break;
      // A `<button>` already activates on Space and Enter through `onClick`,
      // so intercepting them here would double-fire.
      default:
        return;
    }
    // Only once a key is known to be handled: an unhandled Arrow key must
    // still scroll the page.
    event.preventDefault();
    const option = OPTIONS[next];
    if (option === undefined) return;
    select(option.value);
    buttons.current[next]?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      // A pill, matching the redesign's segmented controls — the silhouette
      // change is the whole restyle; the three segments, their names and the
      // no-effect mount discipline above are untouched.
      className="flex items-center gap-0.5 rounded-full border border-default bg-sunken p-0.5"
    >
      {OPTIONS.map(({ value, label, Icon }, index) => {
        const active = value === choice;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            ref={(node) => {
              buttons.current[index] = node;
            }}
            aria-checked={active}
            // THE ROVING TABINDEX. Exactly one segment is reachable by Tab,
            // and it is the checked one — so Tab lands on the current value
            // and the arrows change it, which is what "radio group" means to
            // anyone navigating by keyboard.
            tabIndex={active ? 0 : -1}
            onKeyDown={(event) => onKeyDown(event, index)}
            // The visible content is an icon, so the NAME has to come from
            // here. "Light theme", not "Light": a screen reader announces the
            // group's name once on entry and then each option's own name, and
            // a bare "Light" among three of them is ambiguous out of context.
            aria-label={`${label} theme`}
            title={`${label} theme`}
            onClick={() => select(value)}
            className={`transition-ui flex h-7 w-7 items-center justify-center rounded-full ${
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
