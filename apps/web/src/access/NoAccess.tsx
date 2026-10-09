import { accessRefusal, type AccessAction } from '@perfportal/contracts';
import { AlertMark } from '../components/States';

/**
 * "You cannot do this", in the API's own words.
 *
 * The two sentences are `accessRefusal(action)`'s — the same function
 * `AccessGuard` words its 403 with — so a reader who reaches a page by URL is
 * told what that 403 would have said had they tried: what the action needs,
 * then what to do about it. That is the API's answer for an admin's page and
 * for a project the reader can see. For a project they CANNOT see it answers
 * 404 instead, which is why not-found renders before any `NoAccess`:
 * `ProjectShell` does it for its pages, and a page outside the shell does it
 * itself (Ruling P8). Nothing here is written by hand, and nothing is added:
 * no title above them, because the first sentence already names the action.
 *
 * Render it ONLY when access is known and refuses (`known && !can(action)`
 * from `useProjectAccess`, or `known && !isAdmin` from `useAdminAccess`) —
 * never while the session or the project list is still loading, when nobody
 * has been refused anything.
 *
 * ═══ THE ErrorState LOOK, WITHOUT ITS ALERT ═══
 *
 * It wears `ErrorState`'s frame — the dashed box and `AlertMark`'s warning
 * disc, the sentence in the title's weight and the remediation quieter under
 * it — because to the reader it is the same kind of moment: this page will
 * not do what they came for. But `ErrorState` is `role="alert"`, and this is
 * not an interruption: it is the page's answer to the question the reader
 * asked by opening it. So it is `role="status"` — the same choice
 * `RequestDetail` makes for "This run recorded no request named …". It is
 * mounted already holding its sentences, and a screen reader announces a live
 * region's CHANGES, not one inserted with its content, so it is read where it
 * sits, as the page's content, rather than announced. `AlertMark` is the
 * shared piece, so the status colour is still painted only inside
 * `components/States.tsx`.
 */
export function NoAccess({ action }: { readonly action: AccessAction }) {
  const { detail, remediation } = accessRefusal(action);
  return (
    <div
      role="status"
      className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-default px-6 py-14 text-center"
    >
      <AlertMark />
      <p className="max-w-md text-[0.9375rem] font-semibold tracking-tight text-primary">{detail}</p>
      <p className="max-w-md text-[0.8125rem] leading-relaxed text-muted">{remediation}</p>
    </div>
  );
}
