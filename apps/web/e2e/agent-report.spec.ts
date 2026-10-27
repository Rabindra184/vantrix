import { expect, test, type Locator, type Page } from '@playwright/test';
import { seedAdmin, seedRunWithAgent, seedRunWithData } from './fixtures.js';
import { apiJson, openSection, plot, signIn } from './helpers.js';
import { agentStatusPath, agentSummaryPath } from '../src/api/metricPaths.js';
import { runReportPath } from '../src/routes/paths.js';

/**
 * The Report's agent sections against a run that CARRIES an agent file — the
 * paired fixture `seedRunWithAgent` uploads (GE report parity PR 3).
 *
 * ═══ WHAT ONLY A BROWSER SAYS ═══
 *
 * Every unit case for these sections renders a transform's output into jsdom,
 * which lays nothing out and runs no ECharts: it can prove what a section ASKS
 * for and which state it chooses, never that nine figures DREW from what the
 * real API answered for a real upload, or that a filter written to the URL
 * survives a reload. So each figure here counts as drawn only when its canvas
 * holds one SVG with a `path` in it (`plot`), and every expected value is read
 * from the API the page itself reads, never written down.
 *
 * Only the fields these tests read. Deliberately NOT `@perfportal/contracts`,
 * for the reason `run-tables.spec.ts` gives: a spec that parses with the app's
 * own schema agrees with the app by construction.
 */
interface AgentSummary {
  readonly remotes: readonly string[];
  readonly hostnames: readonly string[];
  readonly injector: { readonly host: string | null };
}
interface AgentStatus {
  readonly codes: readonly string[];
}

/** GE's nine Connections charts, four DNS charts and six Load generators charts, by id. */
const CONNECTION_IDS = [
  'agent-connection-rate',
  'agent-tcp-states',
  'agent-tcp-connect-percentiles',
  'agent-tcp-connect-distribution',
  'agent-tcp-connect-percentiles-distribution',
  'agent-tls-percentiles',
  'agent-tls-distribution',
  'agent-tls-percentiles-distribution',
  'agent-bandwidth',
] as const;
const DNS_IDS = [
  'agent-dns-rate',
  'agent-dns-distribution',
  'agent-dns-percentiles-distribution',
  'agent-dns-percentiles',
] as const;
const LOAD_GENERATOR_IDS = [
  'agent-gc-count',
  'agent-gc-time',
  'agent-cpu',
  'agent-memory',
  'agent-tcp-events',
  'agent-tcp-segments',
] as const;

const section = (page: Page, id: string): Locator => page.locator(`section#${id}`);

/**
 * Every id's figure in `scope` drew: one SVG root on its canvas, holding a
 * mark. `figures` is how many agent figures the section holds in all — the
 * drawn ones plus any explaining themselves — so a section that drew a figure
 * nobody named fails here too.
 */
async function expectDrawn(scope: Locator, ids: readonly string[], figures = ids.length): Promise<void> {
  for (const id of ids) {
    const svg = plot(scope.getByTestId(`chart-${id}`));
    await expect(svg, `${id} drew`).toHaveCount(1);
    await expect(svg.locator('path').first(), `${id} has a mark`).toBeAttached();
  }
  await expect(scope.locator('figure[data-testid^="chart-agent-"]')).toHaveCount(figures);
}

/** An ECharts SVG legend's labels: its `start`-anchored texts (`run-compare.spec.ts`). */
function legend(scope: Locator, id: string): Promise<string[]> {
  return plot(scope.getByTestId(`chart-${id}`)).locator('text[text-anchor="start"]').allTextContents();
}

/**
 * The sum of one column of a chart's data table, from the exact values the
 * cells carry (`data-value`). The table is in the DOM from first paint and
 * merely `hidden` (`run-charts.spec.ts`' `readTable`), so no toggle is needed;
 * a table not yet populated sums to null, never to 0.
 */
function columnTotal(scope: Locator, id: string, column: string): Promise<number | null> {
  return scope.getByTestId(`chart-data-${id}`).evaluate((table, name) => {
    const heads = Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent?.trim() ?? '');
    const at = heads.indexOf(name);
    const rows = Array.from(table.querySelectorAll('tbody tr'));
    if (at < 1 || rows.length === 0) return null;
    // `thead th` includes the row-label column; each body row puts its label in a `th`.
    return rows.reduce((sum, tr) => sum + Number(tr.querySelectorAll('td')[at - 1]?.getAttribute('data-value')), 0);
  }, column);
}

async function openAgentRun(page: Page): Promise<{ runId: string; summary: AgentSummary }> {
  const admin = await seedAdmin();
  const runId = await seedRunWithAgent(admin.orgId);
  await signIn(page, admin);
  await page.goto(runReportPath(runId));
  const summary = await apiJson<AgentSummary>(page, agentSummaryPath(runId));
  return { runId, summary };
}

test('Connections draws its nine charts, and a chosen remote narrows them and survives a reload', async ({ page }) => {
  const { summary } = await openAgentRun(page);
  // The fixture's own precondition: two remotes is what makes the filter a select.
  expect(summary.remotes.length).toBeGreaterThanOrEqual(2);

  await openSection(page, 'connections', 'Connections');
  const connections = section(page, 'connections');
  await expectDrawn(connections, CONNECTION_IDS);

  await expect.poll(() => columnTotal(connections, 'agent-connection-rate', 'Opened')).not.toBeNull();
  const everyRemote = await columnTotal(connections, 'agent-connection-rate', 'Opened');

  // THE SAME REMOTE ON BOTH SIDES OF A RELOAD. The fixture's two remotes open
  // thirty connections each, so remote-against-remote cannot tell a filter
  // that applies from one that does not; every-remote against one remote can,
  // and is read from the page rather than from the fixture.
  const remote = summary.remotes[0]!;
  const select = connections.getByLabel('Remote', { exact: true });
  await select.selectOption(remote);

  await expect.poll(() => new URL(page.url()).searchParams.get('remote')).toBe(remote);
  // Polled until the narrowed table has ARRIVED: while the remote's read is in
  // flight the table is a placeholder and sums to null, which is also "not the
  // every-remote total" and would pass for the wrong reason.
  let oneRemote: number | null = null;
  await expect
    .poll(async () => {
      oneRemote = await columnTotal(connections, 'agent-connection-rate', 'Opened');
      return oneRemote !== null && oneRemote !== everyRemote;
    })
    .toBe(true);

  await page.reload();
  await openSection(page, 'connections', 'Connections');
  await expect(connections.getByLabel('Remote', { exact: true })).toHaveValue(remote);
  expect(new URL(page.url()).searchParams.get('remote')).toBe(remote);
  // The figures that do not depend on TLS. The fixture's first remote is its
  // plain-HTTP server, which handshakes nothing, so its three TLS figures say
  // so rather than draw — all nine are still there.
  await expectDrawn(
    connections,
    CONNECTION_IDS.filter((id) => !id.startsWith('agent-tls-')),
    CONNECTION_IDS.length,
  );
  await expect.poll(() => columnTotal(connections, 'agent-connection-rate', 'Opened')).toBe(oneRemote);
});

/**
 * DEVIATION FROM THE BRIEF, by the controller's ruling "Hostname control
 * follows the remote rule" (progress.md): one hostname is a read-only field
 * naming it, because a select whose every option draws the same data is a
 * control that does nothing. The fixture resolves ONE hostname, so this
 * asserts the field — and that no select stands in for it.
 */
test('DNS draws its four charts, naming the one hostname the run resolved', async ({ page }) => {
  const { summary } = await openAgentRun(page);
  expect(summary.hostnames).toHaveLength(1);

  await openSection(page, 'dns', 'DNS');
  const dns = section(page, 'dns');
  await expectDrawn(dns, DNS_IDS);

  const field = dns.locator('dl').filter({ has: page.locator('dt', { hasText: /^Hostname$/ }) });
  await expect(field.locator('dd')).toHaveText(summary.hostnames[0]!);
  await expect(dns.getByRole('combobox')).toHaveCount(0);
});

test('Load generators names its machine and draws six charts, Memory listing Heap used', async ({ page }) => {
  const { summary } = await openAgentRun(page);

  await openSection(page, 'load-generators', 'Load generators');
  const loadGenerators = section(page, 'load-generators');
  await expectDrawn(loadGenerators, LOAD_GENERATOR_IDS);

  const field = loadGenerators.locator('dl').filter({ has: page.locator('dt', { hasText: /^Load generator$/ }) });
  await expect(field.locator('dd')).toHaveText(summary.injector.host ?? 'Unknown host');

  await expect.poll(() => legend(loadGenerators, 'agent-memory')).toContain('Heap used');

  // A brushed window reaches the section's own read: the shell's window, from the URL.
  const windowed: URL[] = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.pathname.endsWith('/agent/injectors')) windowed.push(url);
  });
  await page.goto(`${page.url().split('?')[0]!.split('#')[0]!}?from=2000&to=6000#load-generators`);
  await openSection(page, 'load-generators', 'Load generators');
  await expect.poll(() => windowed.some((u) => u.searchParams.get('from') === '2000' && u.searchParams.get('to') === '6000')).toBe(true);
});

test('Requests draws Responses per Second by Status, one legend entry per status code', async ({ page }) => {
  const { runId } = await openAgentRun(page);
  const { codes } = await apiJson<AgentStatus>(page, agentStatusPath(runId));
  expect(codes.length).toBeGreaterThanOrEqual(2);

  // Requests is open on arrival (`defaultOpen`); `openSection` checks before clicking.
  await openSection(page, 'requests', 'Requests');
  const requests = section(page, 'requests');
  const figure = requests.getByTestId('chart-agent-status');
  await expect(figure.getByRole('heading', { name: 'Responses per Second by Status', exact: true })).toBeVisible();
  await expect(plot(figure)).toHaveCount(1);
  await expect(plot(figure).locator('path').first()).toBeAttached();

  await expect.poll(async () => [...(await legend(requests, 'agent-status'))].sort()).toEqual([...codes].sort());
});

test('a run with no agent file says so in DNS, and keeps generator telemetry in Connections', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithData(admin.orgId);
  await signIn(page, admin);
  await page.goto(runReportPath(runId));

  await openSection(page, 'dns', 'DNS');
  await expect(section(page, 'dns').getByText('No agent data for this run')).toBeVisible();
  await expect(section(page, 'dns').locator('figure[data-testid^="chart-agent-"]')).toHaveCount(0);

  await openSection(page, 'connections', 'Connections');
  await expect(section(page, 'connections').getByText('No generator telemetry recorded')).toBeVisible();
  await expect(section(page, 'connections').locator('figure[data-testid^="chart-agent-"]')).toHaveCount(0);
});

/**
 * A STALE `?remote=` DRAWS EVERY REMOTE, AND IS NEVER SENT (Review Focus 1).
 * A link whose remote the run does not carry would otherwise reach the API as
 * a filter matching nothing and draw nine empty charts over a run that
 * recorded plenty. Both halves are asserted: what the page shows, and that no
 * request ever carried the stale value.
 */
test('a stale remote link opens Connections drawn for every remote', async ({ page }) => {
  const admin = await seedAdmin();
  const runId = await seedRunWithAgent(admin.orgId);
  await signIn(page, admin);

  const carried: string[] = [];
  // API requests only: the page's own navigation carries the stale link, which is the point.
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.pathname.startsWith('/v1/') && url.searchParams.get('remote') === 'nope') carried.push(req.url());
  });

  await page.goto(`${runReportPath(runId)}?remote=nope#connections`);
  await openSection(page, 'connections', 'Connections');
  const connections = section(page, 'connections');
  await expectDrawn(connections, CONNECTION_IDS);
  await expect(connections.getByLabel('Remote', { exact: true })).toHaveValue('*');
  // And the page says why every remote is drawn under a link that named one.
  await expect(connections.getByTestId('filter-unknown')).toHaveText(
    'This link named nope, which this run never contacted; showing all remotes.',
  );

  // Every remote's total, from a page the reader opened without the stale link.
  await expect.poll(() => columnTotal(connections, 'agent-connection-rate', 'Opened')).not.toBeNull();
  const everyRemote = await columnTotal(connections, 'agent-connection-rate', 'Opened');
  await page.goto(`${runReportPath(runId)}#connections`);
  await openSection(page, 'connections', 'Connections');
  await expectDrawn(connections, CONNECTION_IDS);
  await expect.poll(() => columnTotal(connections, 'agent-connection-rate', 'Opened')).toBe(everyRemote);

  expect(carried).toEqual([]);
});
