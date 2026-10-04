import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import InfoTip from '../src/components/InfoTip';
import SectionHeading from '../src/components/SectionHeading';

/**
 * The `info` slot is where a table's caveat goes when the table has a section
 * heading of its own. It sits BESIDE the heading and never inside it: a
 * heading's accessible name and `textContent` are computed from its content,
 * so a trigger inside it would add "About …" to the name and the hidden copy's
 * words to the text — and `run-tables.spec.ts` pins each tab's heading outline
 * by exactly that text.
 */

afterEach(cleanup);

describe('SectionHeading — the info slot', () => {
  it('keeps the heading’s name and text its own when it carries an info slot', () => {
    render(
      <SectionHeading info={<InfoTip label="About Statistics">Times in ms.</InfoTip>}>Statistics</SectionHeading>,
    );
    const heading = screen.getByRole('heading', { level: 2, name: 'Statistics' });
    expect(heading.textContent).toBe('Statistics');
    expect(heading).not.toContainElement(screen.getByRole('button', { name: 'About Statistics' }));
  });

  it('carries the slot beside an overlined heading too', () => {
    render(
      <SectionHeading overline="Run telemetry" info={<InfoTip label="About Statistics">x</InfoTip>}>
        Statistics
      </SectionHeading>,
    );
    expect(screen.getByText('Run telemetry')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Statistics' }).textContent).toBe('Statistics');
    expect(screen.getByRole('button', { name: 'About Statistics' })).toBeInTheDocument();
  });

  it('draws no trigger without info', () => {
    render(<SectionHeading>Errors</SectionHeading>);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
