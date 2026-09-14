import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import Button from './Button';
import { ErrorState } from './States';

/**
 * The last thing between a route that throws and a blank page.
 *
 * ═══ MEASURED BEFORE IT EXISTED ═══
 *
 * `App.tsx` declares seventeen `lazy()` routes and nothing anywhere caught
 * what they throw. Blocking one chunk and navigating to its route, against the
 * built bundle: `#root` held ZERO children, `document.body` was empty, and
 * there was no header and no rail — the whole tree unmounted, with
 * `Failed to fetch dynamically imported module` on the console and nothing at
 * all on screen.
 *
 * That is not a hypothetical. It is what every reader with the app open gets
 * the moment a deploy replaces the assets they loaded: the next link they
 * click asks for a file that no longer exists.
 *
 * ═══ WHY RELOADING IS THE REMEDY, AND WHY IT IS OFFERED EITHER WAY ═══
 *
 * A stale chunk is fixed by fetching the page again — the new index.html names
 * the new files. A genuine render bug is not, and this cannot tell a reader it
 * knows which they have. So the WORDING splits on the one signal that is
 * reliable (the browser's own module-load message) and the ACTION does not: a
 * reload is the only thing a reader can do from here, and withholding it
 * because the cause might be something else would leave them with nothing.
 *
 * ═══ IT RESETS ON NAVIGATION, WITHOUT REMOUNTING ANYTHING ═══
 *
 * A caught error is state, and state survives until something clears it — so a
 * boundary that never resets turns one failed chunk into a dead application:
 * the reader clicks another link, the URL changes, and the panel stays.
 *
 * THE OBVIOUS SPELLING IS `key={pathname}`, AND IT IS WRONG HERE. A changed
 * key remounts the subtree, and these boundaries wrap `<Outlet/>`s inside
 * LAYOUT routes — `AppShell` and `RunShell` exist precisely so the shell
 * survives a navigation within it. Keyed, every tab click destroyed
 * `RunHeader` and built a fresh one, and `run-detail.spec.ts`'s "switching
 * tabs does not remount the shell" went red immediately. It tags the live DOM
 * node with an attribute React does not manage, which is the only thing that
 * can tell a remount from a re-render.
 *
 * So the reset is a state change, not a remount: clear the error when the path
 * changes AND an error is actually showing. A healthy subtree never notices
 * this component is there.
 */
class Boundary extends Component<
  { readonly children: ReactNode; readonly resetKey: string },
  { readonly error: Error | null }
> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  /* Guarded on `error !== null`, so this is a no-op on every ordinary
     navigation — the component must be invisible to a subtree that is
     working. */
  override componentDidUpdate(prev: { readonly resetKey: string }): void {
    if (this.state.error !== null && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Left on the console deliberately. This app ships no error reporter, and
    // swallowing the stack would make a caught error HARDER to diagnose than
    // the blank page it replaces.
    console.error('A route failed to render.', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    /* The browser's own words for a module that would not load. Vite, Chrome,
       Firefox and WebKit all phrase it differently, which is why this matches
       loosely and why a miss costs nothing: the fallback wording is true of
       any failure. */
    const chunk = /dynamically imported module|importing a module script failed|error loading/i.test(
      error.message,
    );

    return (
      <div className="p-6">
        <ErrorState
          title={chunk ? 'This page could not be loaded' : 'This page stopped working'}
          detail={
            chunk
              ? 'Part of the application failed to download. This usually means it was updated while the page was open.'
              : 'Something went wrong while drawing this page.'
          }
          remediation={
            chunk
              ? 'Reload to fetch the current version.'
              : 'Reload to try again. If it keeps happening, the details are in the browser console.'
          }
          action={
            <Button variant="secondary" onClick={() => window.location.reload()} data-testid="route-error-reload">
              Reload the page
            </Button>
          }
        />
      </div>
    );
  }
}

export default function RouteErrorBoundary({ children }: { readonly children: ReactNode }) {
  // See the class docstring: the path is a RESET SIGNAL, not a `key`. A key
  // would remount the layout routes these boundaries wrap.
  const { pathname } = useLocation();
  return <Boundary resetKey={pathname}>{children}</Boundary>;
}
