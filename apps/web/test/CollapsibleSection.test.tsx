// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CollapsibleSection from '../src/components/CollapsibleSection';
import SectionHeading from '../src/components/SectionHeading';

afterEach(cleanup);

/**
 * GE's report sections and assertion bars, measured: they open and close
 * independently, start with only Requests open, and remember nothing. What GE
 * does NOT do and this does: a real heading holding a real button, and a
 * closed section that builds nothing — its queries never run and its charts
 * are never drawn into a hidden box.
 */
function renderAt(url: string, ui: React.ReactNode) {
  return render(<MemoryRouter initialEntries={[url]}>{ui}</MemoryRouter>);
}

describe('CollapsibleSection', () => {
  it('starts shut, builds nothing, and says so to assistive technology', () => {
    const build = vi.fn(() => <p>body</p>);
    renderAt('/r', <CollapsibleSection id="groups" title="Groups">{build}</CollapsibleSection>);

    const button = screen.getByRole('button', { name: 'Groups' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    const region = document.getElementById(button.getAttribute('aria-controls')!);
    expect(region, 'aria-controls must name an element that exists').not.toBeNull();
    expect(region).not.toBeVisible();
    expect(build).not.toHaveBeenCalled();
  });

  it('opens on click, and unmounts its content again when shut', async () => {
    renderAt('/r', <CollapsibleSection id="groups" title="Groups">{() => <p>body</p>}</CollapsibleSection>);
    const button = screen.getByRole('button', { name: 'Groups' });

    await userEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('body')).toBeVisible();

    await userEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('body')).toBeNull();
  });

  it('opens on arrival when asked to', () => {
    renderAt('/r', <CollapsibleSection id="requests" title="Requests" defaultOpen>{() => <p>body</p>}</CollapsibleSection>);
    expect(screen.getByRole('button', { name: 'Requests' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('body')).toBeVisible();
  });

  it('opens independently of its neighbours, as GE’s sections do', async () => {
    renderAt(
      '/r',
      <>
        <CollapsibleSection id="requests" title="Requests" defaultOpen>{() => <p>a</p>}</CollapsibleSection>
        <CollapsibleSection id="groups" title="Groups">{() => <p>b</p>}</CollapsibleSection>
      </>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Groups' }));
    expect(screen.getByRole('button', { name: 'Requests' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Groups' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('opens when the URL’s fragment names it', () => {
    renderAt('/r#load-generators', <CollapsibleSection id="load-generators" title="Load generators">{() => <p>body</p>}</CollapsibleSection>);
    expect(screen.getByRole('button', { name: 'Load generators' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('ignores a fragment naming some other section, or none at all', () => {
    renderAt(
      '/r#nope',
      <>
        <CollapsibleSection id="requests" title="Requests" defaultOpen>{() => <p>a</p>}</CollapsibleSection>
        <CollapsibleSection id="groups" title="Groups">{() => <p>b</p>}</CollapsibleSection>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Requests' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Groups' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps its heading exactly its title, with the summary and actions beside it', () => {
    renderAt(
      '/r',
      <CollapsibleSection id="platform-gates" title="Platform gates" summary="1 failed, 2 passed" actions={<button type="button">Export CSV</button>}>
        {() => null}
      </CollapsibleSection>,
    );
    const heading = screen.getByRole('heading', { level: 2, name: 'Platform gates' });
    expect(heading.textContent?.trim()).toBe('Platform gates');
    const section = screen.getByTestId('section-platform-gates');
    expect(within(section).getByText('1 failed, 2 passed')).toBeVisible();
    expect(heading).not.toContainElement(within(section).getByRole('button', { name: 'Export CSV' }));
  });
});

describe('SectionHeading', () => {
  it('renders one level down when asked, for a heading inside a section', () => {
    render(<SectionHeading level={3}>Statistics</SectionHeading>);
    expect(screen.getByRole('heading', { level: 3, name: 'Statistics' })).toBeVisible();
  });
});
