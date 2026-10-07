import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { linkButtonClasses } from '../components/Button';
import { SkeletonTable } from '../components/Skeleton';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import TableFrame from '../components/TableFrame';
import { PlusIcon } from '../components/icons';
import { ROW, TABLE, TD, TD_NUM, TH, TH_NUM, THEAD } from '../components/tableStyles';
import { ProblemError } from '../api/fetch';
import { adminProjectsQueryKey, fetchAdminProjects } from '../api/admin';
import AdminShell, { RefreshFailed, isRefusal } from './AdminShell';
import { NEW_PROJECT_ROUTE } from './paths';

/**
 * Administration › Projects: every project in the install and how many people
 * hold a role in it, and the way to make another.
 *
 * NEW PROJECT IS THE EXISTING FORM, linked rather than rebuilt here — creating
 * a project is the same act wherever it starts, and one form means one set of
 * slug rules.
 *
 * Shown only once the list has loaded: a session refused the list
 * (`403 ADMIN_REQUIRED`) is not an admin, and creating a project needs one.
 * The same holds for a refetch the API refuses after the list has loaded
 * (ruling W17); a refetch that fails in any other way keeps the list on
 * screen, under one quiet line (ruling W14, as on Users).
 */
export default function AdminProjects() {
  const projects = useQuery({ queryKey: adminProjectsQueryKey, queryFn: fetchAdminProjects });

  return (
    <AdminShell current="projects">
      {projects.isPending ? (
        <LoadingState label="Loading projects…">
          <SkeletonTable columns={2} />
        </LoadingState>
      ) : projects.data === undefined || isRefusal(projects.error) ? (
        <ErrorState
          title="Projects could not be loaded"
          detail={projects.error instanceof ProblemError ? projects.error.detail : projects.error?.message}
          remediation={projects.error instanceof ProblemError ? projects.error.remediation : undefined}
        />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex justify-end">
            <Link to={NEW_PROJECT_ROUTE} className={linkButtonClasses}>
              <PlusIcon className="h-3.5 w-3.5" />
              New project
            </Link>
          </div>
          {projects.isError && <RefreshFailed />}
          {projects.data.projects.length === 0 ? (
            <EmptyState title="No projects yet" />
          ) : (
            <TableFrame name="Projects" label="Projects table">
              <table className={TABLE}>
                <caption className="sr-only">Projects</caption>
                <thead className={THEAD}>
                  <tr>
                    <th scope="col" className={TH}>
                      Name
                    </th>
                    <th scope="col" className={TH_NUM}>
                      Members
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {projects.data.projects.map((project) => (
                    <tr key={project.slug} className={ROW}>
                      {/* TEXT, NOT A LINK (ruling W8). The rail already links
                          every project by its name, and a project's name is
                          rail vocabulary: a page's own link under that name is
                          the collision CLAUDE.md records for "All runs". */}
                      <td className={`${TD} break-all`}>{project.name}</td>
                      <td className={TD_NUM}>{project.memberCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableFrame>
          )}
        </div>
      )}
    </AdminShell>
  );
}
