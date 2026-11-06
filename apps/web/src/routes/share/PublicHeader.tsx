import { ActivityIcon } from '../../components/icons';
import { formatInstant } from '../format';

/**
 * ═══ THE WHOLE HEADER A PUBLIC LINK'S PAGE HAS ═══
 *
 * The product's name, then what the reader is holding: "Read-only link ·
 * expires <date>" (spec 6.3). No rail, no palette, no account menu — there is
 * no session behind this page to have any of them, and each would ask
 * `/auth/*` or `/v1/projects` with the cookie the link replaces.
 *
 * THE BRAND IS TEXT, NOT A LINK, unlike `AppShell`'s. Its destination there is
 * the app's home page, which a stranger meets as a sign-in form and a sharer
 * meets as the app with the link still in the address bar; nothing on this
 * page links out of `/share/<secret>`.
 *
 * `expiresAt` is null on a page that has no link to describe (a refused one),
 * where the line is simply not drawn. The date is `formatInstant`'s, the one
 * spelling the run page uses for an instant, zone included.
 *
 * Sticky at the shell header's own height token, because `RunTabs` sticks
 * beneath a header of exactly `--header-height`.
 */
export default function PublicHeader({ expiresAt }: { readonly expiresAt: string | null }) {
  return (
    <header
      data-testid="public-header"
      className="sticky top-0 z-40 flex h-header items-center gap-3 border-b border-default bg-surface/85 px-4 backdrop-blur-md sm:px-6"
    >
      <span className="flex shrink-0 items-center gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-mark text-on-brand shadow-panel">
          <ActivityIcon className="h-4 w-4" />
        </span>
        <span className="text-[0.9375rem] font-semibold tracking-tight text-primary">PerfPortal</span>
      </span>
      {expiresAt !== null && (
        <p className="ml-auto min-w-0 text-right text-[0.8125rem] text-muted">
          {`Read-only link · expires ${formatInstant(expiresAt)}`}
        </p>
      )}
    </header>
  );
}
