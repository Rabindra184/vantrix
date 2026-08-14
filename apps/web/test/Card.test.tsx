import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Card from '../src/components/Card';

describe('Card', () => {
  it('renders its children inside the element the caller asked for', () => {
    const { container } = render(<Card as="figure"><p>body</p></Card>);
    expect(container.querySelector('figure')).not.toBeNull();
    expect(screen.getByText('body')).toBeInTheDocument();
  });

  /**
   * `Chart` renders its own <h3> and the e2e suite locates charts by it. A Card
   * that always drew a heading would give every chart two.
   */
  it('renders no heading when given no title', () => {
    render(<Card><p>body</p></Card>);
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('renders the description under the title when both are given', () => {
    render(<Card title="Requests" description="per second">{null}</Card>);
    expect(screen.getByRole('heading', { name: 'Requests' })).toBeInTheDocument();
    expect(screen.getByText('per second')).toBeInTheDocument();
  });
});
