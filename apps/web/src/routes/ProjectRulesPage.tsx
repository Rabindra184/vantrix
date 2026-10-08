import ProjectShell from './ProjectShell';
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
 * `showTitle={false}` because the section is already named — by the `SLA
 * rules` tab in `ProjectShell`, carrying `aria-current="page"`. It used to be
 * named by this page's own `<h1>`; M10 made the `<h1>` the PROJECT and left
 * the section to the nav, which is the same arrangement `RunShell` uses (no
 * tab repeats its own name as a heading). The panel has no description
 * since clean UI PR 4: the empty state says a run with no rules gets no
 * verdict, and the tables' info icons say which runs each set judges.
 *
 * `key={slug}` for the reason `ProjectRuns` and `TestRuns` carry one: a
 * same-route param change otherwise reuses the instance and carries a
 * half-typed rule form into a project it does not belong to. Prefixed,
 * because CLAUDE.md records two siblings keyed off the same params rendering
 * one of them four times behind a console warning nobody reads.
 *
 * `access` is the shell's own answer, handed down rather than asked again:
 * which of the panel's controls a reader is offered is `rules:edit`'s.
 */
export default function ProjectRulesPage() {
  return (
    <ProjectShell current="rules">
      {({ slug, access }) => (
        <ProjectRules key={`rules:${slug}`} slug={slug} access={access} showTitle={false} />
      )}
    </ProjectShell>
  );
}
