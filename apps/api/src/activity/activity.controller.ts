import { Controller, Get, Query, Req } from '@nestjs/common';
import {
  ActivityResponseSchema,
  attentionReasons,
  type ActivityResponse,
  type RunStatus,
  type RunVerdict,
} from '@perfportal/contracts';
import { ActivityRepository, type ActivityAttentionRow, type ActivityRows } from '@perfportal/persistence';
import type { Request } from 'express';
import { Scopes } from '../auth/scopes.decorator.js';
import { singleValue } from '../common/validation.js';
import { checkTally } from '../runs/check-tally.js';
import { ATTENTION_WINDOW_MS, glanceDays, resolveTimeZone } from './days.js';

/**
 * What the portfolio home page draws, in one response: a seven-day glance, a
 * pass rate, a running count, runs per project, the tests that need attention
 * and the last run. One request because the app's gate asks it on every cold
 * load to learn whether the signed-in user has an organisation at all, and the
 * page it lands on should not then ask five more questions.
 *
 * ═══ SCOPED BY CREDENTIAL, NOT BY URL — `GET /v1/tests`'s RULE ═══
 *
 * A session is org-scoped on purpose (`Tenant.projectId` is absent for one) and
 * sees its whole organisation. A bearer token is minted against ONE project and
 * sees that project alone. The scope below is that one rule, and nothing here
 * names a project by slug, so there is no slug to point at another project with.
 *
 * ═══ BOTH WINDOWS ARE ON ARRIVAL, AND `tz` ONLY DRAWS THE CALENDAR ═══
 *
 * Every count is on `run.created_at`, the moment a run arrived, never on when
 * its load test ran. `tz` decides where a calendar day starts and so which of
 * the seven glance days a run lands in; it does not move the attention window,
 * which is the 604 800 000 ms before now whatever the zone. A request without
 * `tz` is asked in UTC.
 *
 * ═══ ZONE FIRST, THEN THE CALENDAR ═══
 *
 * `glanceDays` takes a zone that has already passed `resolveTimeZone`: an
 * unvalidated one is a RangeError out of `Intl`, which would surface here as a
 * 500 for a request only the caller can have got wrong. `singleValue` goes
 * before that for the reason it exists: a repeated `tz` arrives as an array.
 *
 * ═══ THE PARSE AT THE END IS A GUARD, NOT A FORMALITY ═══
 *
 * A row the SQL listed as needing attention is listed BECAUSE one of four
 * clauses held, and the contract demands at least one reason for it. If the
 * SQL predicate and `attentionReasons` ever disagree the row comes back with
 * none and the parse throws: a loud 500 on one page, never a silent
 * disagreement between a count and the line it counts.
 */
@Controller('/v1/activity')
export class ActivityController {
  constructor(private readonly activity: ActivityRepository) {}

  @Get()
  @Scopes('read')
  async get(@Req() req: Request, @Query('tz') tz?: unknown): Promise<ActivityResponse> {
    const tenant = req.tenant!;
    const zone = resolveTimeZone(singleValue('tz', tz));
    // ONE instant for the whole request: the window's end, the calendar's
    // "today" and the attention read all agree about what "now" is.
    const now = new Date();
    const { dates, boundaries } = glanceDays(zone, now);
    const attentionFrom = new Date(now.getTime() - ATTENTION_WINDOW_MS);

    const rows = await this.activity.read(
      { orgId: tenant.orgId, projectId: tenant.projectId },
      { attentionFrom, attentionTo: now, dayBoundaries: boundaries },
    );

    const days = rows.days.map((day, i) => ({
      date: dates[i]!,
      total: day.total,
      successful: day.successful,
      needsAttention: day.needsAttention,
    }));
    const runCount = days.reduce((sum, day) => sum + day.total, 0);
    const successful = days.reduce((sum, day) => sum + day.successful, 0);
    const needingAttention = days.reduce((sum, day) => sum + day.needsAttention, 0);
    // Finished runs only: an in-flight run is in `runCount` and on neither side
    // of this. A FRACTION, and null for `0 / 0`, which is not a rate.
    const finished = successful + needingAttention;

    return ActivityResponseSchema.parse({
      window: { from: attentionFrom.toISOString(), to: now.toISOString(), tz: zone },
      days,
      runCount,
      passRate: finished === 0 ? null : successful / finished,
      running: rows.running,
      byProject: rows.byProject.map((entry) => ({
        project: { slug: entry.project.slug, name: entry.project.name },
        runs: entry.runs,
      })),
      attention: rows.attention.map(toAttentionRow),
      attentionTotal: rows.attentionTotal,
      lastRun: toLastRun(rows.lastRun),
    });
  }
}

/**
 * A listed test (or test-less run) on the wire: the checks as a tally, the
 * reasons from the shared rule, the instants as ISO strings.
 *
 * `toISOString()` and not the driver's own serialisation because the contract's
 * `startedAt` is `z.string().datetime()`, which accepts a Z-suffixed instant
 * only. The `status`/`verdict` casts are provisional exactly as
 * `OrgTestsController` documents: the repository reads them as plain strings
 * and has no business importing the contract's enums, and the parse above is
 * the actual validation.
 *
 * Every field is NAMED, never spread: `tsc`'s excess-property check applies to
 * an object literal and not to a spread, so a mistyped key inside one would
 * compile and send nothing.
 */
function toAttentionRow(row: ActivityAttentionRow): ActivityResponse['attention'][number] {
  const run = row.run;
  const status = run.status as RunStatus;
  const verdict = run.verdict as RunVerdict | null;
  const checks = checkTally(run.toolAssertions);
  return {
    test: row.test === null ? null : { slug: row.test.slug, name: row.test.name },
    project: { slug: row.project.slug, name: row.project.name },
    run: {
      id: run.id,
      runNumber: run.runNumber,
      status,
      verdict,
      startedAt: run.startedAt.toISOString(),
      durationMs: run.durationMs,
      checks,
      simulation: run.simulation,
    },
    reasons: attentionReasons({ status, verdict, checks }),
  };
}

function toLastRun(row: ActivityRows['lastRun']): ActivityResponse['lastRun'] {
  if (row === null) return null;
  return {
    id: row.id,
    runNumber: row.runNumber,
    test: row.test === null ? null : { slug: row.test.slug, name: row.test.name },
    project: { slug: row.project.slug, name: row.project.name },
    startedAt: row.startedAt.toISOString(),
  };
}
