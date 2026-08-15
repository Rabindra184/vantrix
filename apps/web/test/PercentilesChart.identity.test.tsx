import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { SeriesResponseSchema } from '@perfportal/contracts';
import PercentilesChart from '../src/charts/PercentilesChart';
import fixture from './fixtures/reference-run.json';

afterEach(cleanup);

const series = SeriesResponseSchema.parse(fixture.series);

describe('PercentilesChart identity', () => {
  it('derives every testid from the caller’s id', () => {
    render(
      <>
        <PercentilesChart series={series} id="percentiles-a" title="A" />
        <PercentilesChart series={series} id="percentiles-b" title="B" />
      </>,
    );

    // Two charts, two independent control sets. A hardcoded testid gives one
    // ambiguous match per control and `getByTestId` throws.
    //
    // ALL THREE CONTROLS, not just the scale toggle. This case has always been
    // titled "every testid" and only ever checked one of them; the outcome
    // selector was added under that title, so the other two are now asserted
    // beside it rather than left to the name of the test.
    for (const id of ['percentiles-a', 'percentiles-b']) {
      expect(screen.getByTestId(`scale-toggle-${id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`band-p95-${id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`outcome-ko-${id}`)).toBeInTheDocument();
    }

    for (const bare of ['scale-toggle', 'band-p95', 'outcome-ko']) {
      expect(screen.queryByTestId(bare)).not.toBeInTheDocument();
    }
  });

  it('keeps the default identity when the caller names nothing', () => {
    render(<PercentilesChart series={series} />);
    expect(screen.getByTestId('scale-toggle-percentiles')).toBeInTheDocument();
    expect(screen.getByTestId('band-p95-percentiles')).toBeInTheDocument();
    expect(screen.getByTestId('outcome-ko-percentiles')).toBeInTheDocument();
  });

  it('opens on OK, so the chart a reader knows does not move under them', () => {
    // G-22 / RQ-05 specify the OK set, and this chart showed it exclusively
    // before the selector existed. The default is the compatibility promise.
    render(<PercentilesChart series={series} />);
    expect(screen.getByTestId('outcome-ok-percentiles')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('outcome-ko-percentiles')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('outcome-all-percentiles')).toHaveAttribute('aria-pressed', 'false');
  });
});
