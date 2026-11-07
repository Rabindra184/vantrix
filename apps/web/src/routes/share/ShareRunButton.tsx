import * as Dialog from '@radix-ui/react-dialog';
import { buttonVariants } from '../../components/Button';
import { ShareIcon } from '../../components/icons';
import ShareDialog from './ShareDialog';

/**
 * ═══ SHARE, BESIDE THE RUN'S HEADING (spec 6.4) ═══
 *
 * The run's own action for handing it to somebody who may not be signed in:
 * a button that opens the share dialog. `RunShell` decides whether it is
 * offered at all — `run:share` (Member), a finished run, the app and never a
 * link's page — so this decides nothing and asks nothing until it is opened:
 * the dialog's read of the run's links mounts with the dialog.
 *
 * A RADIX DIALOG WITH ITS OWN TRIGGER: focus moves into it and is held
 * there, Escape and the overlay close it, and focus returns to this button
 * when it closes — the return the palette has to arrange by hand because it
 * has no trigger of its own.
 *
 * THE TRIGGER IS A RAW `<button>` WEARING `buttonVariants`, NOT `<Button>`,
 * and that is what makes the return work at all. Radix hands focus back
 * through a ref it puts on its `asChild` child, and `Button` is a plain
 * function component — under React 18 a ref on one is dropped (React says so
 * once, "Function components cannot be given refs"), so the trigger ref stayed
 * null and every close left focus on `<body>`. Every other Radix trigger in
 * the app is a raw `<button>` for this reason, and `Button`'s own docstring
 * says it has no `asChild` escape hatch.
 *
 * THE DIALOG'S CONTENT UNMOUNTS WHEN IT CLOSES, and that is load-bearing, not
 * tidiness: a created link's secret lives in the dialog's own state (and in
 * the create's mutation entry, which the dialog drops as it unmounts — see
 * `ShareDialog`); the server keeps only its hash. So closing the dialog is what
 * makes "the only time the full link is shown" true. `forceMount` here would
 * keep it on screen for the next opening.
 */
export default function ShareRunButton({ runId }: { readonly runId: string }) {
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button type="button" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
          <ShareIcon className="h-3.5 w-3.5" />
          Share
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50" />
        {/* `aria-describedby={undefined}`: the dialog's title names it, and its
            contents differ by state (a form, or the sentence saying sharing is
            off), so no one element describes it — Radix asks for the opt-out
            to be said rather than assumed. */}
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-default bg-surface p-5 text-primary shadow-panel"
        >
          <ShareDialog runId={runId} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
