import { describe, expect, it } from 'vitest';
import {
  TWO_COLUMN_THRESHOLD,
  escapeHtml,
  formatTooltipValue,
  renderTooltip,
  type TooltipRow,
} from '../src/charts/tooltip';

const row = (name: string, value: unknown): TooltipRow => ({
  marker: '<span style="background:#f00"></span>',
  name,
  value,
});

describe('escapeHtml', () => {
  it('neutralises markup in a series name', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('escapes quotes and ampersands', () => {
    expect(escapeHtml(`a&b"c'd`)).toBe('a&amp;b&quot;c&#39;d');
  });

  it('escapes the ampersand first, so an entity is not double-escaped into markup', () => {
    // '&lt;' must not come back out as '<'. Ordering bug, caught here rather
    // than by staring at the implementation.
    expect(escapeHtml('&lt;script&gt;')).toBe('&amp;lt;script&amp;gt;');
  });
});

describe('formatTooltipValue', () => {
  it('appends the unit', () => {
    expect(formatTooltipValue(15, 'ms')).toBe('15 ms');
  });

  it('rounds through formatCell rather than showing raw float noise', () => {
    // The point is that the tooltip and the data table agree, so this asserts
    // the shared behaviour rather than a literal of its own.
    expect(formatTooltipValue(122.74516052680153, 'ms')).toBe('122.75 ms');
  });

  it('renders a gap as a dash with no unit', () => {
    expect(formatTooltipValue(null, 'ms')).toBe('—');
    expect(formatTooltipValue(undefined, 'ms')).toBe('—');
  });

  it('omits the unit when none is given', () => {
    expect(formatTooltipValue(15)).toBe('15');
  });

  it('formats a scatter pair component-by-component', () => {
    // String([3, 120]) is "3,120", which on a ms axis reads as three thousand
    // one hundred twenty rather than two separate measurements.
    expect(formatTooltipValue([3, 120])).toBe('3, 120');
  });
});

describe('renderTooltip', () => {
  it('uses one column at the threshold', () => {
    const rows = Array.from({ length: TWO_COLUMN_THRESHOLD }, (_, i) => row(`s${i}`, i));
    expect(renderTooltip('12', rows)).not.toContain('data-tooltip-column="2"');
  });

  it('uses two columns above the threshold', () => {
    const rows = Array.from({ length: TWO_COLUMN_THRESHOLD + 1 }, (_, i) => row(`s${i}`, i));
    expect(renderTooltip('12', rows)).toContain('data-tooltip-column="2"');
  });

  it('fills the first column before the second, preserving series order', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(`s${i}`, i));
    const html = renderTooltip('12', rows);
    // 10 rows split 5/5: s4 ends column one, s5 begins column two.
    expect(html.indexOf('s0')).toBeLessThan(html.indexOf('s4'));
    expect(html.indexOf('s4')).toBeLessThan(html.indexOf('s5'));
  });

  it('renders every row exactly once when the count is odd', () => {
    const rows = Array.from({ length: 9 }, (_, i) => row(`s${i}`, i));
    const html = renderTooltip('12', rows);
    for (let i = 0; i < 9; i += 1) {
      expect(html.split(`s${i}<`).length - 1).toBe(1);
    }
  });

  it('escapes the title and every series name', () => {
    const html = renderTooltip('<b>t</b>', [row('<script>x</script>', 1)]);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>t</b>');
  });

  it('keeps the marker markup, which is ECharts own and not payload data', () => {
    expect(renderTooltip('12', [row('a', 1)])).toContain('background:#f00');
  });

  it('carries the unit into every row', () => {
    // Asserted on the rendered VALUES, not on a bare 'ms' substring: the
    // inline styles contain `align-items`, so counting occurrences across the
    // whole string measures the CSS as much as the data.
    const html = renderTooltip('12', [row('a', 1), row('b', 2)], 'ms');
    expect(html).toContain('1 ms');
    expect(html).toContain('2 ms');
  });
});
