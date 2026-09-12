import ProjectConfigPage from './ProjectConfigPage';
import ProjectRules from './ProjectRules';

/**
 * SLA rules, on a page of their own — review M15.
 *
 * The panel itself is unchanged and is still composed into a TEST's page,
 * where it lists that test's rules plus the project-wide ones. What changed is
 * that the project-wide view is no longer the third section of a credentials
 * screen: a rule is authored long after a project is wired up, usually by
 * somebody with no interest in tokens, and putting it below two sections they
 * had no reason to scroll past made it read as part of first-run setup.
 *
 * `showTitle={false}` because this page's `<h1>` already says "SLA rules" —
 * see that prop's own note for why a duplicate heading is invisible on screen
 * and not to a screen reader.
 *
 * `key={slug}` for the reason `ProjectRuns` and `TestRuns` carry one: a
 * same-route param change otherwise reuses the instance and carries a
 * half-typed rule form into a project it does not belong to. Prefixed,
 * because CLAUDE.md records two siblings keyed off the same params rendering
 * one of them four times behind a console warning nobody reads.
 */
export default function ProjectRulesPage() {
  return (
    <ProjectConfigPage current="rules" heading="SLA rules">
      {({ slug }) => <ProjectRules key={`rules:${slug}`} slug={slug} showTitle={false} />}
    </ProjectConfigPage>
  );
}
