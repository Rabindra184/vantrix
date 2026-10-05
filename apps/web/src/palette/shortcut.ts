/**
 * The palette's keyboard shortcut: which keystroke it is, and what to call it
 * on this machine.
 *
 * ═══ ⌘K AND Ctrl+K ARE BOTH ACCEPTED, ON EVERY PLATFORM ═══
 *
 * A Mac user reaches for ⌘, a Windows or Linux user for Ctrl, and a Mac user
 * on an external PC keyboard for either. Telling them apart by platform would
 * make the wrong one a dead key, so the SHORTCUT takes both and only the HINT
 * the header shows follows the platform — and `aria-keyshortcuts` names both,
 * because it is a statement about what the control accepts, not about what is
 * printed beside it.
 *
 * Alt and Shift are refused: Alt+K types a character on several layouts, and
 * Shift+⌘K is a browser's own chord. A shortcut that takes a neighbouring
 * chord is one a reader loses a key to.
 */
export function isPaletteShortcut(event: KeyboardEvent): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    // Caps Lock reports the capital.
    event.key.toLowerCase() === 'k'
  );
}

/**
 * `NavigatorUAData` is not in every TypeScript `lib.dom`, and only one field of
 * it is read here, so the shape is stated rather than imported.
 */
interface NavigatorWithUserAgentData extends Navigator {
  readonly userAgentData?: { readonly platform?: string };
}

/**
 * Whether the keyboard in front of the reader has a ⌘ key — decided from what
 * the browser says it is running on, and used only to choose which of two
 * labels to print.
 *
 * `userAgentData.platform` is where a current browser says it (`"macOS"`);
 * `navigator.platform` (`"MacIntel"`) is deprecated but is all Safari and
 * Firefox offer, so it is the fallback rather than a thing to avoid. iPads are
 * included because one with a keyboard attached has the key.
 *
 * Takes the navigator as an argument so a test can hand it a plain object;
 * with no argument it reads the real one, and answers `false` where there is
 * none (a server render, a node test).
 */
export function isApplePlatform(
  nav: Navigator | undefined = typeof navigator === 'undefined' ? undefined : navigator,
): boolean {
  if (nav === undefined) return false;
  const modern = (nav as NavigatorWithUserAgentData).userAgentData?.platform;
  const platform = typeof modern === 'string' && modern !== '' ? modern : nav.platform;
  return typeof platform === 'string' && /mac|iphone|ipad|ipod/i.test(platform);
}
