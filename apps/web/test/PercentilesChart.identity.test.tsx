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
    expect(screen.getByTestId('scale-toggle-percentiles-a')).toBeInTheDocument();
    expect(screen.getByTestId('scale-toggle-percentiles-b')).toBeInTheDocument();
    expect(screen.queryByTestId('scale-toggle')).not.toBeInTheDocument();
  });

  it('keeps the default identity when the caller names nothing', () => {
    render(<PercentilesChart series={series} />);
    expect(screen.getByTestId('scale-toggle-percentiles')).toBeInTheDocument();
  });
});
