import { useId } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OrgSettings } from '@perfportal/contracts';
import { Switch } from '../charts/ChartControls';
import InfoTip from '../components/InfoTip';
import { ErrorState, LoadingState } from '../components/States';
import { ProblemError } from '../api/fetch';
import { fetchOrgSettings, orgSettingsQueryKey, updateOrgSettings } from '../api/admin';
import AdminShell, { RefreshFailed, isRefusal } from './AdminShell';

/**
 * Administration › Settings: the org's own settings, which today is one
 * switch — AI features, which lets a member send a run to the deployment's AI
 * provider for a written analysis.
 *
 * ═══ NO PROVIDER, NO SWITCH ═══
 *
 * The provider and model are the DEPLOYMENT's (`AI_PROVIDER`, `AI_MODEL`),
 * not the org's, and `PUT /v1/admin/settings` cannot set them. With none
 * configured there is nothing for the switch to turn on, so it is not drawn —
 * a disabled switch would still claim the feature is one click away — and one
 * sentence names the variable an operator sets.
 *
 * ═══ THE DESCRIPTION SAYS WHAT LEAVES THE DEPLOYMENT ═══
 *
 * Turning this on is a decision about data leaving the install, so the
 * switch's description names exactly what is sent and to which provider and
 * model, from the API's own answer. It is the CONTROL's description — the ⓘ's
 * hidden copy, which the switch points `aria-describedby` at, as a form
 * field's hint is (`FormField`) — so a screen reader hears it on focus and the
 * page prints no paragraph under the switch (clean UI).
 *
 * ═══ THE PAGE SHOWS WHAT THE SERVER HOLDS ═══
 *
 * The switch is not flipped optimistically: a change is a PUT followed by a
 * re-read, and the knob moves when the re-read lands. A refused change shows
 * the API's own detail and remediation beside the switch, which stays as it
 * was. A refused READ (`403 ADMIN_REQUIRED` for a session that is not an
 * admin) replaces the page with the refusal, under the shell (ruling W17); a
 * 401 ends the session in `queryClient.ts`, not here.
 */
export default function AdminSettings() {
  const query = useQuery({ queryKey: orgSettingsQueryKey, queryFn: fetchOrgSettings });

  return (
    <AdminShell current="settings">
      {query.isPending ? (
        <LoadingState label="Loading settings…" />
      ) : query.data === undefined || isRefusal(query.error) ? (
        <ErrorState
          title="Settings could not be loaded"
          detail={query.error instanceof ProblemError ? query.error.detail : query.error?.message}
          remediation={query.error instanceof ProblemError ? query.error.remediation : undefined}
        />
      ) : (
        <div className="flex flex-col gap-4">
          {query.isError && <RefreshFailed />}
          <AiFeatures settings={query.data} />
        </div>
      )}
    </AdminShell>
  );
}

function AiFeatures({ settings }: { readonly settings: OrgSettings }) {
  const queryClient = useQueryClient();
  const descriptionId = `${useId()}-ai-features`;
  const mutation = useMutation({
    mutationFn: updateOrgSettings,
    /* Awaited, so the knob moves as the re-read lands rather than before it. */
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orgSettingsQueryKey }),
  });

  if (!settings.aiProviderConfigured) {
    return (
      <p data-testid="ai-provider-not-configured" className="text-[0.8125rem] text-muted">
        An operator must configure an AI provider on the deployment (<code>AI_PROVIDER</code>) before AI features can be turned on.
      </p>
    );
  }

  const problem = mutation.error instanceof ProblemError ? mutation.error : null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <Switch
          pressed={settings.aiEnabled}
          label="AI features"
          testId="ai-features-switch"
          describedBy={descriptionId}
          onClick={() => {
            // One change at a time: a second click while the first is in
            // flight would PUT the same value the knob has not yet left.
            if (mutation.isPending) return;
            mutation.mutate({ aiEnabled: !settings.aiEnabled });
          }}
        />
        <InfoTip label="About AI features" descriptionId={descriptionId}>
          {`When on, a member can send a run's figures, request names and error messages to ${destination(settings)} to write an analysis.`}
        </InfoTip>
      </div>
      {mutation.isError && (
        <div role="alert" className="rounded-lg border border-default bg-sunken p-3 text-[0.8125rem] text-primary">
          <p>{problem?.detail ?? mutation.error.message}</p>
          {problem !== null && <p className="mt-1 text-muted">{problem.remediation}</p>}
        </div>
      )}
    </div>
  );
}

/**
 * `provider/model`, as the deployment names them. A configured provider
 * carries both (`AdminController#settings` reads them from one config
 * object); a missing half is named as the provider alone rather than printed
 * as `null`.
 */
function destination(settings: OrgSettings): string {
  const { aiProvider, aiModel } = settings;
  if (aiProvider !== null && aiModel !== null) return `${aiProvider}/${aiModel}`;
  return aiProvider ?? 'the configured AI provider';
}
