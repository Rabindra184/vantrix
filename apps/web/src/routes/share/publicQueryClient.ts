import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { PUBLIC_LINK_REFUSAL_CODES, type PublicLinkRefusalCode } from '@perfportal/contracts';
import { ProblemError } from '../../api/fetch';

/** What the API said when it refused a public link: its code and its sentence. */
export interface PublicLinkRefusal {
  readonly code: PublicLinkRefusalCode;
  readonly detail: string;
}

const REFUSAL_CODES: ReadonlySet<string> = new Set(PUBLIC_LINK_REFUSAL_CODES);

/**
 * Whether `error` is the API refusing the LINK — a 401 carrying one of the four
 * link codes — rather than anything else that can fail a read.
 *
 * Both halves, because each alone admits the wrong thing: a 401 with a
 * session's code (`UNAUTHENTICATED`) cannot come from this credential and ends
 * nothing here, and a link code on another status is not the credential
 * check's answer.
 */
export function isPublicLinkRefusal(error: unknown): error is ProblemError & { readonly code: PublicLinkRefusalCode } {
  return error instanceof ProblemError && error.status === 401 && REFUSAL_CODES.has(error.code);
}

/**
 * ═══ THE PUBLIC PAGE'S OWN QUERY CLIENT ═══
 *
 * The app's client (`queryClient.ts`) answers a 401 by ending the session and
 * sending the reader to sign in. Behind a public link there is no session to
 * end and nothing to sign in to: a 401 there is the API saying the LINK no
 * longer reads — revoked, expired, not found, or switched off for the org —
 * and the page has to say which, in place of everything else (spec 6.1).
 *
 * So this client carries no session rule at all. Both caches hand a link
 * refusal to `onRefusal` with the API's code and detail, whichever read or
 * write it arrived on — the first read, or a section's read long after the
 * page rendered, which is how a reader learns mid-page that the link was
 * revoked (Review Focus 4). Every other failure is left to the section that
 * asked, which draws its own refusal as it does in the app.
 *
 * `retry: false` for the reason the app's client gives: a refused link
 * answers the same on every retry, and retrying only keeps the reader looking
 * at a loading line for seconds before the page that says so.
 */
export function createPublicLinkQueryClient(
  onRefusal: (code: PublicLinkRefusalCode, detail: string) => void,
): QueryClient {
  const report = (error: unknown): void => {
    if (isPublicLinkRefusal(error)) onRefusal(error.code, error.detail);
  };
  return new QueryClient({
    queryCache: new QueryCache({ onError: report }),
    mutationCache: new MutationCache({ onError: report }),
    defaultOptions: { queries: { retry: false } },
  });
}
