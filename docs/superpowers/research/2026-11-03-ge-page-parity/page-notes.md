# GE page pass — 2026-11-03, org demo-perf, 0 credits left (no new runs possible)
Nav: Home · Campaigns · Tests · Organization · API tokens · Sources · Dedicated IPs · Private locations · Integrations. Header: Subscribe, Help center, org switcher, user menu.

## Home  /o/demo-perf
- "Hello, <first name>!" + "Activity in the last 7 days (Oct 27 - Nov 3, 2026)"
- Campaign progress card: score changes last 7 days; empty = PREVIEW of a filled card (score 84/100, team, 2 tests, +5 in 2 days) + "Create your first campaign"  (= backlog #10 preview-empty-state pattern)
- Tests that need attention: "1 test failed or broken - last 7 days"; table NAME(+id copy) TEAM LAST RUN(#n, name, datetime GMT+5:30, duration, status chip "Assertions failed") LINK; rows per page 10-50
- Plan & Credits card (N/A), Teams card: share of credit consumption / tests runs per team last 7 days
## Campaigns  /o/demo-perf/campaigns
- "Load-testing programs grouped by team. Monitor quality, methodology and confidence at a glance." Score runs, set targets, watch score evolve.
- Create modal: Title, Team (required; "Campaigns are permanently tied to their team."), Description. Inside NOT seen (needs creating one).
## Tests  /o/demo-perf/simulations
- Columns NAME(+test_ id copy) CAMPAIGN SOURCE(JVM badge + package) TEAM LAST RUN(#2 Run 2, datetime, 1m 31s, status) START(play) row menu; each column sortable + filterable; search by name; row checkboxes; "Create a test"; "Default load generators parameters" button
## Test page  /simulations/<test>/runs
- Header: name, Edit; facts Team, Type JVM, Injection profile "Defined in code", Package + version badge 3.15.1, Simulation class, Location (managed) 🇫🇷 Europe - Paris
- Left rail: Runs, Start new run, Trends (Last 2 runs), run list (Run n, datetime, duration, status icon), "No more runs."
- Trends: AI trends analysis (NEW) "Let AI spot patterns across your last runs…" Analyze with AI; charts per run (#1,#2 x axis, bars): Responses Status (stacked % OK/KO, KO% label, Show values toggle), Response Time Percentiles (50 90 99 99.9 99.99 Max bars), Throughput (Count/s stacked OK/KO, KO label)
## Compare  /runs/compare
- select 2–5 runs via rail checkboxes; chips #2 #1 removable; AI run comparison (NEW) "Let AI analyse the differences between your 2 runs and surface the key insights."
- Metric: Concurrent users, CPU usage, Errors, p50 p90 p95 p99 p99.9 p99.99 max, Throughput (rps). Default p99.
- Overlay line chart over elapsed time (00:00:01…00:01:31) with a range slider above it; legend Run #2 Run #1
- Table: rows * + every request (group / request), columns per run; first selected run is reference column (highlighted); others show value + % delta chip w/ arrow; pin icon column (choose reference)
## Test edit/create wizard  /simulations/<test>/edit  (Cancel / Save / Save and launch)
1 Package (JVM badge, team) + Simulation (dropdown from the package manifest) + Load test type (optional chips: Standard Stress Spike Capacity Soak Smoke)
2 Locations: type Managed | Private | Dedicated IPs; rows Location + Number of load generators + Weight distribution (Custom weight distribution toggle); Add location; TOTAL
3 Override injection profile (optional): banner "defined in simulation's code… will completely replace"; editor: INJECTION MODEL Open|Closed; one profile per scenario, exact name ("a mismatch in count or naming will cause the run to fail"); steps list; templates Ramp + plateau, Staircase, Long plateau, Spike, Single user; load-curve preview; Add step; Add another scenario
4 Load generator parameters: "Default properties: enabled" toggle showing org defaults (Java system properties, Environment variables); own key/value tables for both
5 Apply SLO: "Adding SLOs to your test will overwrite defined assertions." rows: [p50|p95|p99|p99.9|p99.99|p99.999|p99.9999 on response time | Error ratio] should be [less than | less than or equal to] [n] ms
6 Time window: Ramp up / Ramp down seconds toggles (excluded from stats)
7 Stop criteria: "Stop when the [load generators' CPU usage | global response time | global error ratio] on the last [5|10|30|60] seconds is over [n] %"
## Run page (Summary measured 2026-10-01; deltas only)
- Title "Untitled run" editable (pencil) + #2; description "No description for this run" editable (pencil)  [ours: run note — one field]
- Facts: Triggered by: User <name>; Location (private) 🇫🇷 Europe - Paris; Credits used 2; Gatling version 3.15.1; Injection profile Defined in code; "View properties"
- View properties modal: Unique ID (copy), Simulation, Triggered by; Load Generators: Java system properties, Environment Variables, Location Configuration table (Location name / Number of load generators / Dedicated IP addresses); Stop criteria ("No criterion has been set up for this run.")
- ⋮ menu: Share public link · Create custom report · Delete run
- Summary percentiles chart: gear = band checklist (Mean Min 25 50 75 80 85 90 95 99 …), * = OK|KO|* outcome picker  [ours has both]
## Report pickers  /runs/<run>/details
- Requests section bar: Charts|Table toggle, Scenario: [* Browse Checkout], Group: [* , - (no group), Cart, Catalog ▸ (nested submenu)], Request: (enabled once a group is chosen; a group with one request auto-selects it)
- State in URL: ?requests-group=Cart&requests-request=Add+To+Cart (prefixed per section)
- Every chart narrows; status chart shows only that request's codes. Each chart: pie icon + fullscreen; distribution chart has Linear/log toggle
## Organization  /organization/{settings,users,invitations,teams,usage,billing,notifications}
- Settings: org name (edit) + slug; Time zone: "Override time zone for your organization" toggle; Features management: Public links ENABLED ("create and share a public link to a run report"), AI features ENABLED
- Users: "Invite new users", search; cols NAME (+You, user_ id copy) EMAIL ORGANIZATION ROLE TEAMS; row: Edit roles, ⋮
  - Edit roles: Organization role [No role | Viewer (view Reports and Trends) | Contributor (start a Test, generate Public Links) | Tester (administrate tests) | Leader (administrate Packages) | Administrator]; Team roles rows [team][Team Viewer|Team Contributor|Team Tester|Team Leader|Team administrator (Users, Teams, API Token, Private Locations)]; "highest permission on the considered object prevails"
- Invitations tab (count 0)
- Teams: "Teams and quota settings"; Create; cols TEAM NAME(+team_ id) MEMBERS CONSUMED CREDITS & QUOTA (Unlimited, edit) RELATIONS (1 campaign? leaderboard icon, 1 package icon)
- Usage: Credits|Minutes|Runs toggles; month nav, 1 month|12 months; tiles Credits consumed, Minutes of test, Runs launched (+weekly averages), Runs stopped due to insufficient credits; Daily consumption chart (grouped by test start date UTC); By team | By test table per day; search; Download CSV
- Notifications (org-wide): Jira Cloud (create a work item automatically when a run fails; instance URL, account email, API token stored encrypted), Slack (webhook; "notified when a run ends… summary of the test run, its result, and assertion results"), Microsoft Teams (webhook, same); each Test connection + Save + a rendered preview
## API tokens  /api-tokens
- org-level list: NAME TOKEN LAST USED, search, bulk checkbox; Create: name + Organization role + Team roles (same role model as users); no expiry, no per-scope checkboxes
## Sources  /sources/packages
- tabs Packages | Git repositories (disabled: "Git repositories are only available to private location users." — contents unseen)
- Packages as measured 2026-10-02 (NAME+id, FORMAT, TEAM, TESTS count, FILENAME+size+Gatling version badge, LAST UPDATE, Upload, ⋮)
## Private locations: marketing/contact form on this trial (own load generators in private network). N/A for us (we ARE on-prem).
## Dedicated IPs: none purchased; contact sales. N/A.
## Integrations  /integrations — catalogue of docs links, filter by category
- Build tools: Maven, Gradle, sbt · CI/CD: Jenkins, GitLab CI, GitHub Actions, TeamCity, Bamboo, Azure DevOps, AWS CodeBuild, (contact sales:) Buildkite, Argo, Concourse, Tekton, Google Cloud Build, CircleCI, CI Script · Observability: Datadog, Dynatrace, OpenTelemetry, InfluxDB, New Relic · Notifications: Slack, Microsoft Teams, Jira · Protocols
## Tests › Default load generators parameters (dialog): org-wide Java system properties / JavaScript parameters + Environment variables (key/value), applied to every test unless its "Default properties" toggle is off
## User menu: My profile, About Enterprise Edition; REPORT SETTINGS (per user): Percentiles (checklist: All, Min 25 50 75 80 85 90 95 99 99.9 99.99 Max — which bands every percentile chart draws), Multiple highlight; Sign out
## NOT SEEN (each needs a write or credits): inside a Campaign; public link page; custom report builder; AI trends analysis output; AI run comparison output; a live run; a stop criterion firing; Invitations flow
## AI trends analysis (generated 2026-11-03, ~40 s, free at 0 credits, stored on the test)
- Header chips: "medium confidence", "degrading"; "Generated on 03/11/2026"; one-line lead: "Investigate recent functional errors and tail latency now — the newest run (id 2) shows slightly worse error rate and tail compared with the previous run."
- Sections (collapsible): HEALTH (headline + bullets), INSIGHTS, RECOMMENDATIONS
- HEALTH: "Latest run (id 2) is functionally unhealthy: ~16.8% KO and a bi-modal latency (fast median ~45ms plus a 2–4s tail, P100 pinned at 4191ms)." bullets: KO 16.76% matches AssertionsFailed; bimodal distribution; "P100 is identical across runs (4191ms), suggesting a hard cap or repeated timeout boundary around ~4.19s" <- CHECK: Summary said max 4159 for run 2
- INSIGHTS: "Small tail- and error-rate regression on run 2: median unchanged but P99/P99.9 and KO% ticked up…" bullets: KO 16.76% vs 15.88%; P99 ~2.5s vs ~1.3s, P99.9 ~4.1s; P50 ~44–45ms; mean 126→150ms
- RECOMMENDATIONS: fix assertion/failure causes, capture request-level logs for the 2–4 s tail, examine error logs for run 2 (KO rise with stable RPS = functional, not capacity), trace P95–P100 requests, add P95/P99 SLO assertion + alert
## AI run comparison (runs #2,#1; ~40 s)
- chips "high confidence", "Some discrepancies"; Generated on 03/11/2026
- INSIGHTS: "Runs show similar aggregate throughput but noticeable differences in tail latencies and failure counts for specific request groups." bullets: 19.03 vs 18.95 req/s (-0.4%); max concurrent VUs 10 vs 15 (+50%); OK 1,457 vs 1,435, KO 275 vs 289 (+5.1%); failure rate 15.9% (275/1,732) → 16.8% (289/1,724)
- RECOMMENDATIONS: Place Order 0 OK both runs, 176 vs 172 failures; Session p99 1,087 → 3,311 ms (+204%); Catalog / List Products p99 823 → 1,359 (+65%); compare error types for the extra 14 KOs
- EXPLORE IN CHART: "inspect p99 and p99.9 lines for 'Session' and 'Catalog / List Products'…"
- p99 figures agree with the compare table; selection NOT kept in the URL (reload loses it)
## Campaign (created perfportal-parity-probe, campaign_i8of6ow5u7gpteg1ygx1e4u74y, Default team, test linked)
- Welcome card: "group your tests around a business goal, score your performance health across three dimensions (Methodology, Objectives, Confidence) and track progress over time"; mock shows Campaign score 92 + Score trend chart
- Page: title, description, team, N tests, Created on; Edit (title/description only; team locked), Delete
- Tests table: NAME STATUS SCORE METHODOLOGY OBJECTIVES CONFIDENCE LAST RUN; Manage tests dialog (team's tests, tick, "N tests linked", Save)
- Linked test = "Pending": "added to the campaign but hasn't run yet. Its results will be included in the campaign score once it runs." -> scoring needs a NEW run (0 credits). No target fields anywhere in the campaign UI; the test page header now shows "Campaign: perfportal-parity-probe"
## Public link (generated for Run 2, expires 10/11/2026)
- Dialog: Expiration date [1 week, 2 weeks, 1 month, 6 months, 1 year, 2 years, Custom], "Public link will expire on …", Generate -> URL /o/<org>/public/<token>/simulations/<test>/runs/<run>
- Public view: logo + Help center only (no nav), Summary | Report | Logs, facts + View properties, lifecycle strip, tiles, assertions bar, charts; NO AI analysis card, no Compare, no ⋮, no edit pencils
- No revoke control found in the run menu afterwards (org Settings has only the feature toggle)
## Custom report  /runs/<run>/export
- Header: "Custom report - <test>", Back to run, Offset|Datetime, Load, Save ▾ [Save report (with data) | Save template (without data)], Preview & Print to PDF
- Default blocks: Title (editable text "28/10/2026, 17:48:02 GMT+5:30 - 1m 31s"), Status (run picker + editable text "Run 2 ended with status: Assertions failed"), Comments ("There are no comments for the run 2"), Assertions (each with value), Summary, Requests and Responses per Second, Responses per Second by Status, Response Time Percentiles
- Each block: type dropdown, per-block RUN picker (blocks can show different runs), move up/down, delete; "Add block" between every block
- Block types: GENERAL Title, Text Area, New Page · RUN Status, Comments, Assertions, Summary · CHARTS Requests(4) Groups(3) Virtual users(3) Connections(5) DNS(2) Load Generators(6) · COUNTS Requests and Responses Counts, Status Counts, Errors Counts
- Load: Template | Save; "A template contains the basic definition of all graphs, without custom texts or data."
## Accuracy observations (GE against itself), read from tooltips 2026-11-03
- Trends tooltip Run #2: 50% 45, 90% 249, 99% 2 479, 99.9% 4 095, 99.99% 4 159, Max 4 159 ms
- Trends tooltip Run #1: 50% 44, 90% 232, 99% 1 311, 99.9% 4 015, 99.99% 4 191, Max 4 191 ms
- Compare table (p99, all requests "*"): Run 2 2383, Run 1 1343. Per-run AI analysis also says Run 2 P99 = 2383.
  -> Run 2 p99 is 2479 on Trends and 2383 on Compare/AI: GE disagrees with itself by 96 ms (t-digest per view, or a different population).
  -> Run 1 p99 is 1311 on Trends and 1343 on Compare.
- AI trends analysis: "P100 is identical across runs (4191ms)" is FALSE (4159 vs 4191) — a wrong derived claim, like the per-run analysis measured 2026-11-02.
