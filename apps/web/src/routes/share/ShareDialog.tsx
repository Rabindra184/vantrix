import * as Dialog from '@radix-ui/react-dialog';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { PublicLink, PublicLinkListResponse } from '@perfportal/contracts';
import { ProblemError } from '../../api/fetch';
import { createPublicLink, fetchPublicLinks, publicLinksQueryKey, revokePublicLink } from '../../api/publicLinks';
import Badge from '../../components/Badge';
import Button, { buttonVariants } from '../../components/Button';
import FormField, { errorId } from '../../components/FormField';
import { CheckIcon, CloseIcon, CopyIcon, ShareIcon } from '../../components/icons';
import { ErrorState, LoadingState } from '../../components/States';
import { INPUT } from '../../components/tableStyles';
import { formatInstant, formatInstantSeconds } from '../format';
import { PUBLIC_LINK_STATE, PUBLIC_LINK_SUSPENDED } from '../marks';
import { EXPIRY_PRESETS, customDateBounds, expiryFor, type ExpiryPreset } from './expiry';

/**
 * What a reader agrees to by creating a link, verbatim from the spec (6.4).
 * ALWAYS VISIBLE beside Create, never behind an ⓘ: creating a link is a
 * decision about publishing, and the consequence of acting stays on screen
 * (the AI consent rule).
 */
const CONSENT =
  "Anyone with this link can read this run's Summary, Report and Logs — its project and test names included — without signing in, until it expires or is revoked.";

/** Said beside the one copy of the URL there will ever be (spec 6.4). */
const SHOWN_ONCE = 'This is the only time the full link is shown.';

/** The preset the form opens on: the shortest, so a reader who changes nothing
 *  publishes for the least time. */
const DEFAULT_PRESET: ExpiryPreset = '1w';

/** The API's own words for a failure, or the error's message. */
function problemOf(error: Error): { readonly detail: string; readonly remediation: string | undefined } {
  return error instanceof ProblemError
    ? { detail: error.detail, remediation: error.remediation }
    : { detail: error.message, remediation: undefined };
}

/**
 * ═══ SHARING ONE RUN BY LINK (spec 6.4) ═══
 *
 * Reads the run's links (`GET /v1/runs/:id/public-links`), which also says
 * whether the org lets anyone create one — a Member cannot read
 * Administration's settings, so the list carries the switch.
 *
 *   - Switched OFF: one sentence saying an admin turned links off and where
 *     they come back on, and NO FORM. The links are still listed, because
 *     deciding what to revoke matters most while sharing is off: turning it
 *     back on restores every link not expired or revoked. A live one is
 *     badged Suspended there, never Active.
 *   - Switched ON: the expiry, the date it lands on, the consent sentence and
 *     Create; then, once, the secret URL with Copy.
 *
 * Mounted only while the dialog is open (`ShareRunButton`), so its state — the
 * created URL above all — does not outlive a closing.
 */
export default function ShareDialog({ runId }: { readonly runId: string }) {
  const links = useQuery({ queryKey: publicLinksQueryKey(runId), queryFn: () => fetchPublicLinks(runId) });
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3">
        <Dialog.Title className="text-base font-semibold tracking-tight text-primary">Share this run</Dialog.Title>
        {/* A raw `<button>` under `asChild`, as `ShareRunButton`'s trigger is.
            Close itself puts no ref on its child (measured: `<Button>` here
            drew no warning and closed correctly), so this is the house
            pattern rather than a fix — kept so a ref added here later is not
            the one `Button` silently drops. */}
        <Dialog.Close asChild>
          <button type="button" aria-label="Close" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
            <CloseIcon className="h-4 w-4" />
          </button>
        </Dialog.Close>
      </div>
      <Body runId={runId} links={links} />
    </div>
  );
}

function Body({
  runId,
  links,
}: {
  readonly runId: string;
  readonly links: UseQueryResult<PublicLinkListResponse>;
}) {
  // DATA BEFORE ERROR: a re-read that fails keeps the list the reader is
  // looking at (a failed background refetch must not blank it).
  if (links.data === undefined) {
    if (links.isError) {
      const { detail, remediation } = problemOf(links.error);
      return <ErrorState title="This run’s links could not be loaded" detail={detail} remediation={remediation} />;
    }
    return <LoadingState label="Loading links…" />;
  }
  return (
    <>
      {links.data.enabled ? (
        <CreateLink runId={runId} />
      ) : (
        <p className="text-[0.8125rem] leading-relaxed text-primary">
          An admin has turned public links off for this organisation; they can be turned back on in
          Administration › Settings.
        </p>
      )}
      <LinkList runId={runId} items={links.data.items} suspended={!links.data.enabled} />
    </>
  );
}

/**
 * The expiry, the consent and Create — and, once a link exists, its URL.
 *
 * THE INSTANT IS COMPUTED AT SUBMIT, as the token page does it: a dialog left
 * open over lunch would otherwise create a link counted from when it opened.
 * The sentence under the select is computed at render from the same rule, so
 * it says what Create will send.
 */
function CreateLink({ runId }: { readonly runId: string }) {
  const queryClient = useQueryClient();
  const id = useId();
  const presetId = `${id}-expires`;
  const dateId = `${id}-date`;
  const expiryLineId = `${id}-expiry`;
  const [preset, setPreset] = useState<ExpiryPreset>(DEFAULT_PRESET);
  const [customDate, setCustomDate] = useState('');
  const [url, setUrl] = useState<string | null>(null);

  const now = new Date();
  const bounds = customDateBounds(now);
  /* A typed date past either bound is refused here as well as by the input's
     own `min`/`max` (which a keyboard can type past) and by the server. The
     comparison is on `yyyy-mm-dd` strings, which order as the dates do.

     THE SENTENCE NAMES WHICH SIDE, because the server's refusal has two
     (`publicLinkExpiryProblem`: no more than a minute ahead, or more than 732
     days) and the bounds here sit inside both. Before `min` — today, or a day
     already gone — is too soon, and "within the next two years" would be
     false of it; past `max` is too far. */
  const dateProblem =
    preset !== 'custom' || customDate === ''
      ? null
      : customDate < bounds.min
        ? 'Choose a date after today.'
        : customDate > bounds.max
          ? 'Choose a date within the next two years.'
          : null;
  const dateOutOfRange = dateProblem !== null;
  const candidate = dateOutOfRange ? null : expiryFor(preset, now, customDate);
  const expiry = candidate === null || Number.isNaN(candidate.getTime()) ? null : candidate;

  const create = useMutation({
    /* `gcTime: 0` KEEPS THE SECRET OUT OF THE CLIENT'S CACHE. A mutation's
       answer — here `{ link, secret }` — stays in the app-wide mutation cache
       after its observer goes, five minutes by default, where anything holding
       the client can read it. Collected the moment this form unmounts, the
       secret lives exactly as long as the dialog that shows it. */
    gcTime: 0,
    mutationFn: () => createPublicLink(runId, expiryFor(preset, new Date(), customDate).toISOString()),
    onSuccess: (response) => {
      setUrl(`${window.location.origin}/share/${response.secret}`);
      void queryClient.invalidateQueries({ queryKey: publicLinksQueryKey(runId) });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (expiry !== null) create.mutate();
  };

  const refused = create.isError ? problemOf(create.error) : null;

  return (
    <div className="flex flex-col gap-4">
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <div className="flex flex-wrap items-start gap-3">
          <div className="w-44 min-w-0">
            <FormField label="Expires" id={presetId}>
              <select
                id={presetId}
                className={INPUT}
                value={preset}
                aria-describedby={expiryLineId}
                onChange={(event) => setPreset(event.target.value as ExpiryPreset)}
              >
                {EXPIRY_PRESETS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </FormField>
          </div>
          {preset === 'custom' && (
            <div className="w-44 min-w-0">
              <FormField
                label="Expiry date"
                id={dateId}
                error={dateProblem ?? undefined}
              >
                <input
                  id={dateId}
                  type="date"
                  className={INPUT}
                  min={bounds.min}
                  max={bounds.max}
                  value={customDate}
                  aria-invalid={dateOutOfRange || undefined}
                  aria-describedby={dateOutOfRange ? errorId(dateId) : expiryLineId}
                  onChange={(event) => setCustomDate(event.target.value)}
                />
              </FormField>
            </div>
          )}
        </div>
        {/* ONE ELEMENT, ALWAYS MOUNTED, whose text follows the choice: the
            select names it in `aria-describedby`, and a polite live region
            announces the new date as the choice changes rather than being
            inserted already holding it. Empty while no date is chosen. */}
        <p id={expiryLineId} aria-live="polite" className="text-[0.8125rem] text-primary">
          {expiry === null ? '' : `This link will expire on ${formatInstant(expiry.toISOString())}.`}
        </p>
        <p className="text-[0.8125rem] leading-relaxed text-muted">{CONSENT}</p>
        {refused !== null && (
          <div role="alert" className="rounded-lg border border-default bg-sunken p-3 text-[0.8125rem] text-primary">
            {refused.detail}
            {refused.remediation !== undefined && <p className="mt-1 text-muted">{refused.remediation}</p>}
          </div>
        )}
        <div>
          {/* THE DIALOG'S ONE PRIMARY (Button.tsx's rule). Every other control
              here — Copy, Revoke, its confirmation, Close — is secondary or
              ghost, so the most prominent thing on screen is never the
              destructive one. */}
          <Button type="submit" variant="primary" loading={create.isPending} disabled={expiry === null}>
            <ShareIcon className="h-3.5 w-3.5" />
            Create link
          </Button>
        </div>
      </form>
      {/* Keyed by the URL so a second link starts with a fresh Copy button. */}
      {url !== null && <CreatedLink key={url} url={url} />}
    </div>
  );
}

/**
 * ═══ THE ONE COPY OF THE URL, ON SCREEN WHATEVER THE CLIPBOARD DOES ═══
 *
 * A read-only field holding the whole URL, selectable by hand, beside Copy.
 * The clipboard is absent on any page that is not a secure context — plain
 * http on anything but localhost, an ordinary way to reach an on-prem install
 * — and a write can be refused; either way only the Copy button's feedback
 * changes, and the URL stays exactly where it was (the token page's rule:
 * never claim a copy that did not happen).
 *
 * Focus moves to the field when it appears, which selects it: the reader is
 * already at the one thing this dialog exists to hand over.
 */
function CreatedLink({ url }: { readonly url: string }) {
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  useEffect(() => {
    field.current?.focus();
  }, []);

  const copy = async () => {
    try {
      if (typeof navigator.clipboard?.writeText !== 'function') {
        throw new Error('The clipboard is not available on this page.');
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      setCopied(false);
      setCopyFailed(true);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-default bg-sunken p-3">
      <label htmlFor={id} className="text-[0.8125rem] font-semibold text-primary">
        Public link
      </label>
      <div className="flex min-w-0 items-center gap-2">
        <input
          ref={field}
          id={id}
          data-testid="public-link-url"
          readOnly
          value={url}
          onFocus={(event) => event.currentTarget.select()}
          className={`${INPUT} min-w-0 flex-1 font-mono text-[0.75rem]`}
        />
        <Button size="sm" onClick={() => void copy()}>
          {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
          {copied ? 'Copied' : 'Copy link'}
        </Button>
      </div>
      <p className="text-[0.75rem] text-muted">{SHOWN_ONCE}</p>
      {copyFailed && (
        <p role="alert" className="text-[0.75rem] leading-snug text-muted">
          The link could not be copied automatically — a browser only allows that on a secure (https) page.
          Select it above and copy it by hand before you close this.
        </p>
      )}
    </div>
  );
}

/**
 * The run's links, newest first, each with its state, who made it and when,
 * when it expires and when it was last opened — and Revoke on a link that
 * still works.
 *
 * REVOKING TAKES TWO DELIBERATE CLICKS, inline, as the token page's does: it
 * stops the link for everyone who has it, at once. ONE ARMED AT A TIME, so
 * there is never more than one primed destructive control on screen, and
 * neither button is `primary` — Create is this dialog's one primary.
 *
 * FOCUS FOLLOWS THE READER'S OWN ACTION, and the list decides it, not each
 * row. Arming swaps Revoke for its confirmation, and a focused element that is
 * removed drops focus to the body — inside a modal, a reader who no longer
 * knows where they are. So:
 *
 *   - arming focuses that row's Cancel (never the destructive button: a second
 *     Enter must not revoke);
 *   - Cancel hands focus back to that row's Revoke;
 *   - Confirm focuses the row itself, which survives both the button the
 *     reader pressed and, once the list reads again, the Revoke beside it.
 *
 * A PER-ROW EFFECT KEYED ON "AM I ARMED" WAS WRONG IN EXACTLY ONE CASE, and it
 * is the ordinary one: arming a link while another is armed disarms the other
 * in the same render, siblings run their effects in list order, and the
 * disarmed row's "give focus back to my Revoke" ran after the armed row's
 * "focus my Cancel" whenever it sat lower in the list. A request made by the
 * handler that changed the state cannot confuse whose action it was.
 */
function LinkList({
  runId,
  items,
  suspended,
}: {
  readonly runId: string;
  readonly items: readonly PublicLink[];
  /** The org's switch is off, so no link answers: see `LinkRow`'s badge. */
  readonly suspended: boolean;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<string | null>(null);
  /* A fresh object for every request, so the effect runs once per request
     even when two in a row name the same row and target. */
  const [focusRequest, setFocusRequest] = useState<{ readonly id: string; readonly target: FocusTarget } | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const revoke = useMutation({
    mutationFn: (linkId: string) => revokePublicLink(runId, linkId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: publicLinksQueryKey(runId) });
    },
  });

  useEffect(() => {
    if (focusRequest === null) return;
    // Link ids are uuids, so quoting them in an attribute selector is safe.
    const row = list.current?.querySelector<HTMLElement>(`[data-link-id="${focusRequest.id}"]`);
    const target =
      focusRequest.target === 'row' ? row : row?.querySelector<HTMLElement>(`[data-focus="${focusRequest.target}"]`);
    target?.focus();
  }, [focusRequest]);

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-[0.8125rem] font-semibold text-primary">Links</h3>
      {items.length === 0 ? (
        <p className="text-[0.8125rem] text-muted">No links yet.</p>
      ) : (
        <ul ref={list} className="flex flex-col gap-2">
          {items.map((link) => (
            <LinkRow
              key={link.id}
              link={link}
              suspended={suspended}
              armed={confirming === link.id}
              revoking={revoke.isPending && revoke.variables === link.id}
              failure={revoke.isError && revoke.variables === link.id ? problemOf(revoke.error).detail : null}
              onArm={() => {
                setConfirming(link.id);
                setFocusRequest({ id: link.id, target: 'cancel' });
              }}
              onCancel={() => {
                setConfirming(null);
                setFocusRequest({ id: link.id, target: 'revoke' });
              }}
              onConfirm={() => {
                setConfirming(null);
                setFocusRequest({ id: link.id, target: 'row' });
                revoke.mutate(link.id);
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** Where focus goes after a row's action: its Cancel, its Revoke, or the row. */
type FocusTarget = 'cancel' | 'revoke' | 'row';

function LinkRow({
  link,
  suspended,
  armed,
  revoking,
  failure,
  onArm,
  onCancel,
  onConfirm,
}: {
  readonly link: PublicLink;
  readonly suspended: boolean;
  readonly armed: boolean;
  readonly revoking: boolean;
  readonly failure: string | null;
  readonly onArm: () => void;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const createdAt = formatInstant(link.createdAt);
  /* A live link reads SUSPENDED while the switch is off, never Active: the
     sentence above the list says links are off, and a green "Active" beside it
     would say the opposite to a reader deciding whether a link they sent still
     works. Revoke stays — the switch coming back on restores this link. */
  const mark = link.state === 'active' && suspended ? PUBLIC_LINK_SUSPENDED : PUBLIC_LINK_STATE[link.state];
  return (
    /* `tabIndex={-1}`: focusable by script only, so a confirmed revoke can keep
       the caret here (`LinkList`) without adding a tab stop per row. */
    <li
      data-testid="public-link-row"
      data-link-id={link.id}
      tabIndex={-1}
      className="flex flex-col gap-2 rounded-lg border border-default px-3 py-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span data-testid="public-link-state">
          <Badge mark={mark} />
        </span>
        {link.state === 'active' &&
          (armed ? (
            <div className="flex flex-col items-end gap-1.5">
              {/* The consequence as visible text, never a `title` on the
                  button (the token page measured why). */}
              <p className="text-[0.75rem] leading-snug text-muted">It stops working for everyone at once.</p>
              <div className="flex items-center gap-1.5">
                <Button size="sm" variant="secondary" onClick={onConfirm}>
                  Confirm revoke
                </Button>
                <Button data-focus="cancel" size="sm" variant="ghost" onClick={onCancel}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            /* NAMED AFTER ITS LINK: a list of links is a list of Revoke
               buttons, and a name that starts with the visible word keeps
               voice control's "click Revoke" working. TO THE SECOND, though
               the row says the minute: two links made one after the other —
               one per recipient — share every minute-precision instant on
               their rows, and two Revoke buttons sharing a name is the
               duplicate-name defect this repo has paid for before. */
            <Button
              data-focus="revoke"
              size="sm"
              variant="secondary"
              loading={revoking}
              aria-label={`Revoke the link created ${formatInstantSeconds(Date.parse(link.createdAt))}`}
              onClick={onArm}
            >
              Revoke
            </Button>
          ))}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[0.75rem]">
        <dt className="text-muted">Created</dt>
        <dd className="text-primary">
          {createdAt} by {link.createdBy?.name ?? 'a removed account'}
        </dd>
        <dt className="text-muted">Expires</dt>
        <dd className="text-primary">{formatInstant(link.expiresAt)}</dd>
        {link.revokedAt !== null && (
          <>
            <dt className="text-muted">Revoked</dt>
            <dd className="text-primary">
              {formatInstant(link.revokedAt)}
              {link.revokedBy === null ? '' : ` by ${link.revokedBy.name}`}
            </dd>
          </>
        )}
        <dt className="text-muted">Last opened</dt>
        <dd className="text-primary">{link.lastUsedAt === null ? 'Never' : formatInstant(link.lastUsedAt)}</dd>
      </dl>
      {failure !== null && (
        <p role="alert" className="text-[0.75rem] leading-snug text-primary">
          {failure}
        </p>
      )}
    </li>
  );
}
