import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './components/ui/dropdown-menu';
import { AlertIcon, MonitorIcon, MoonIcon, SignOutIcon, SunIcon } from './components/icons';
import { applyTheme, readTheme, type ThemeChoice } from './theme';
import { signOut } from './api/session';

/**
 * Who is signed in, the theme, and the way out — behind one control.
 *
 * ═══ WHAT THIS REPLACES (review 09-13 N03) ═══
 *
 * The header carried a brand, a truncated email, three theme buttons and Sign
 * out at equal weight. Theme is set once and Sign out is pressed at the end of
 * a session; meanwhile the question the chrome should answer — which identity
 * am I using — was a 12px span that disappeared below `sm`, because it was the
 * longest of the four and lost the contest for the row. Identity is the
 * control now and the settings live inside it, where the full address is
 * legible at every width.
 *
 * ═══ A REAL MENU, WHICH IS WHY IT IS RADIX ═══
 *
 * The first cut of this was a hand-rolled disclosure that deliberately refused
 * `role="menu"`, on the argument that a menu promises arrow keys, typeahead,
 * Home/End and a focus trap, and that half-keeping a role is worse than not
 * claiming it — the lesson the old `ThemeToggle` earned by shipping
 * `role="radio"` with no arrow handling.
 *
 * That was right about the promise and wrong about the conclusion: the answer
 * is to KEEP the promise. `@radix-ui/react-dropdown-menu` implements the APG
 * pattern, `menuitemradio` included, so the theme control is three real menu
 * radios with working arrows and a tick showing which is current — rather than
 * a `radiogroup` smuggled inside a menu (invalid ARIA) or a disclosure that
 * declines to be a menu at all.
 *
 * `ThemeToggle` is deleted with it. It existed to be a segmented control in a
 * header that no longer has room for one, and its whole interaction model —
 * roving tabindex, arrow handling, selection following focus — is what Radix
 * now provides inside the menu.
 *
 * ═══ SIGN OUT IS INLINE HERE, AND THE ORDER MATTERS ═══
 *
 * `SignOutButton` was a `<button>`, and a menu's children must be menu items,
 * so its three steps moved here rather than being wrapped. They are unchanged
 * and the middle one is the one with teeth: post, then CLEAR THE QUERY CACHE,
 * then redirect. The cache holds the previous user's runs in memory, so
 * skipping it leaves that data one back-button away with no server-side
 * component to the leak. A failed sign-out does not redirect — the cookie may
 * still be valid, and sending someone to /login while they are in fact signed
 * in tells them the opposite of the truth.
 */
export default function AccountMenu({ identity }: { readonly identity: string | null }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [failed, setFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  /* Read once, not in an effect: `theme.ts` has already written the choice to
     <html> before React runs, so an effect here would re-apply what is on
     screen and risk a flash. */
  const [choice, setChoice] = useState<ThemeChoice>(() => readTheme());

  async function onSignOut(): Promise<void> {
    if (submitting) return; // two posts race; the second 401s against a cleared cookie
    setFailed(false);
    setSubmitting(true);
    try {
      await signOut();
    } catch {
      setFailed(true);
      setSubmitting(false);
      return;
    }
    queryClient.clear();
    navigate('/login', { replace: true });
  }

  const initial = (identity ?? '?').trim().charAt(0).toUpperCase() || '?';

  return (
    /* NOT MODAL. Radix's default traps focus, locks scroll and marks the rest
       of the document inert — right for a destructive confirm, wrong for a
       settings menu in the chrome: it makes the page behind it unreadable to
       assistive technology and unscrollable, for a control someone opened to
       flip a theme. Caught by `auth.spec.ts`, which could no longer see the
       run table while the menu was open. Escape and outside-click still close
       it; only the trap and the inerting are dropped. */
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        {/* ═══ THE AVATAR IS THE WHOLE CONTROL ═══
         *
         * It was a pill — avatar, name, chevron — which is the shape that
         * reads as "identity plus a menu". In a header whose job is to get out
         * of the way, that is three pieces of chrome for one action, and the
         * name is already in the panel where it can be read in full. The
         * initial alone is the affordance; pressing it opens the menu.
         *
         * NO VISIBLE LABEL, so WCAG 2.5.3 does not bind — the initial is
         * `aria-hidden` because it is derived from the name and says nothing
         * on its own, and the accessible name lives in the `sr-only` node so
         * the button still announces whose account it opens.
         *
         * The open state is a ring rather than a colour change: the tile is
         * already the brand fill, so darkening it would read as "pressed" on
         * a control that is actually "open". */}
        <button
          type="button"
          data-testid="account-menu-trigger"
          className="transition-ui flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-mark text-[0.75rem] font-semibold text-on-brand hover:opacity-90 data-[state=open]:ring-2 data-[state=open]:ring-accent [@media(pointer:coarse)]:h-10 [@media(pointer:coarse)]:w-10"
        >
          <span aria-hidden="true">{initial}</span>
          <span className="sr-only">Account: {identity ?? 'signed in'}</span>
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-[15rem]">
        {/* IDENTITY IN FULL — the one place the whole address is legible, which
            is what the header could not manage at any width. IDENTITY ONLY:
            `Session` (api/session.ts) carries a user and no organisation, and
            the review is explicit that multi-tenant UI must not be invented. */}
        <DropdownMenuLabel>Signed in as</DropdownMenuLabel>
        <p data-testid="signed-in-as" className="px-2 pb-1 text-[0.8125rem] break-all text-primary">
          {identity ?? 'an account this page could not read'}
        </p>

        <DropdownMenuSeparator />

        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={choice}
          onValueChange={(next) => {
            const picked = next as ThemeChoice;
            setChoice(picked);
            applyTheme(picked);
          }}
        >
          {(
            [
              ['system', 'System', MonitorIcon],
              ['light', 'Light', SunIcon],
              ['dark', 'Dark', MoonIcon],
            ] as const
          ).map(([value, label, Icon]) => (
            <DropdownMenuRadioItem key={value} value={value}>
              <Icon aria-hidden="true" className="h-3.5 w-3.5 text-muted" />
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          data-testid="sign-out"
          disabled={submitting}
          /* Selecting an item closes the menu, which would unmount this one
             mid-request and take its failure message with it. So selection is
             prevented: a success closes the menu by navigating away, and a
             failure leaves it open with the reason on screen. */
          onSelect={(event) => {
            event.preventDefault();
            void onSignOut();
          }}
        >
          <SignOutIcon aria-hidden="true" className="h-3.5 w-3.5 text-muted" />
          Sign out
        </DropdownMenuItem>

        {failed && (
          <p
            role="alert"
            className="flex items-start gap-1.5 px-2 pt-1 text-[0.75rem]"
            /* INLINE, not a `text-status-failed` utility: the status colours
               live on `:root` rather than in `@theme inline`, so Tailwind
               generates no utility for them and the class would emit nothing
               at all — silently. `StatTile` and `RunList` reference them this
               same way. */
            style={{ color: 'var(--color-status-failed)' }}
          >
            <AlertIcon aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Sign out failed. You are still signed in — try again.
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
