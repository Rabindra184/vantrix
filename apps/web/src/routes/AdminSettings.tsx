import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OrgSettings } from '@perfportal/contracts';
import { Switch } from '../charts/ChartControls';
import { ErrorState, LoadingState } from '../components/States';
import { ProblemError } from '../api/fetch';
import { fetchOrgSettings, orgSettingsQueryKey, updateOrgSettings } from '../api/admin';
import AdminShell, { RefreshFailed, isRefusal } from './AdminShell';

/**
 * Administration › Settings: the org's own settings, which are two switches —
 * AI features, which lets a member send a run to the deployment's AI provider
 * for a written analysis, and Public links, which lets a run be read through
 * a link by someone who is not signed in. Each is off until an admin turns it
 * on, and each sends only its own field (`{"aiEnabled": …}` or
 * `{"publicLinksEnabled": …}`), so pressing one never writes the other from a
 * value this page read earlier.
 *
 * ═══ NO PROVIDER, NO SWITCH — UNLESS IT IS ON (ruling 17) ═══
 *
 * The provider and model are the DEPLOYMENT's (`AI_PROVIDER`, `AI_MODEL`),
 * not the org's, and `PUT /v1/admin/settings` cannot set them. With none
 * configured and the switch off there is nothing to switch on, so it is not
 * drawn — a disabled switch would still claim the feature is one click away —
 * and one sentence names the variable an operator sets. An org left ON keeps
 * its switch, so it can be turned off before a later provider makes it send
 * again; the sentence is worded to be true in both states.
 *
 * ═══ THE DESCRIPTION SAYS WHAT LEAVES THE DEPLOYMENT, ON SCREEN ═══
 *
 * Turning this on is the admin's consent to data leaving the install, so one
 * VISIBLE sentence beside the switch names every category that is sent — the
 * run's figures, the names it records (simulation, requests, groups,
 * assertions) and its error messages, DEPLOYMENT.md's list — and where to:
 * the provider and model, and for an openai-compatible endpoint its HOST
 * (`aiBaseUrlHost`), from the API's own answer. A short second sentence says
 * that off also hides what was already written. A consequence of acting,
 * which the clean-UI rule keeps on screen; it is also the switch's
 * `aria-describedby`, so a screen reader hears it on focus.
 *
 * ═══ THE PAGE SHOWS WHAT THE SERVER HOLDS ═══
 *
 * The switch is not flipped optimistically: a change is a PUT, whose answer
 * IS the server's state after it, written into the cache before a re-read —
 * so a re-read that fails cannot leave the page showing OFF while sending is
 * ON. The knob moves when the PUT answers, not when it is pressed. Turning it
 * off with no provider configured removes the switch, so focus moves to the
 * operator sentence that replaces it rather than falling to the page. A
 * refused change shows the API's own detail and remediation beside the
 * switch that was pressed, which stays as it was. A refused READ
 * (`403 ADMIN_REQUIRED` for a session that is not an admin) replaces the page
 * with the refusal, under the shell (ruling W17); a 401 ends the session in
 * `queryClient.ts`, not here.
 *
 * ═══ PUBLIC LINKS: ITS SENTENCE IS ON SCREEN, FOR THE SAME REASON ═══
 *
 * Turning public links on is a decision about publishing, so its sentence —
 * what a link lets someone read, without signing in, and what turning the
 * switch off and on again does to the links that exist — is visible beside
 * the switch and is its `aria-describedby`, never behind an ⓘ (the AI
 * consent rule; spec section 6.5). It does not depend on an AI provider: the
 * two switches are independent, so it is drawn whatever the AI half shows.
 *
 * An API pod older than the switch sends no `publicLinksEnabled` and refuses
 * the field in a PUT, so through a rolling deploy there is nothing to draw:
 * no switch, rather than one reading OFF that answers 400 when pressed.
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
          {query.data.publicLinksEnabled !== undefined && <PublicLinks enabled={query.data.publicLinksEnabled} />}
        </div>
      )}
    </AdminShell>
  );
}

/** The Public links switch's sentence, verbatim from spec section 6.5. */
const PUBLIC_LINKS_SENTENCE =
  "Anyone with a public link can read that run's Summary, Report and Logs without signing in, until the link expires or is revoked. Turning this off stops every link at once; turning it back on restores the links that have not expired or been revoked.";

/**
 * One switch's change: the PUT, whose answer is written into the cache before
 * the re-read (so a failed re-read cannot show the old state), then the
 * re-read. Each switch holds its own, so a refusal is shown beside the switch
 * that was pressed. `onAnswer` runs after the answer is cached.
 */
function useSettingsChange(onAnswer?: (answer: OrgSettings) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateOrgSettings,
    onSuccess: (answer) => {
      queryClient.setQueryData(orgSettingsQueryKey, answer);
      onAnswer?.(answer);
      return queryClient.invalidateQueries({ queryKey: orgSettingsQueryKey });
    },
  });
}

/** A refused change: the API's own detail and remediation. */
function ChangeRefused({ error }: { readonly error: Error }) {
  const problem = error instanceof ProblemError ? error : null;
  return (
    <div role="alert" className="rounded-lg border border-default bg-sunken p-3 text-[0.8125rem] text-primary">
      <p>{problem?.detail ?? error.message}</p>
      {problem !== null && <p className="mt-1 text-muted">{problem.remediation}</p>}
    </div>
  );
}

function AiFeatures({ settings }: { readonly settings: OrgSettings }) {
  const descriptionId = `${useId()}-ai-features`;
  const operatorRef = useRef<HTMLParagraphElement>(null);
  // Set when a change the reader made removes the switch, and spent once
  // focus has moved — never on a page that merely arrives without one.
  const [focusOperator, setFocusOperator] = useState(false);
  const mutation = useSettingsChange((answer) => {
    if (!answer.aiProviderConfigured && !answer.aiEnabled) setFocusOperator(true);
  });

  const switchHidden = !settings.aiProviderConfigured && !settings.aiEnabled;
  useEffect(() => {
    if (!focusOperator || !switchHidden) return;
    operatorRef.current?.focus();
    setFocusOperator(false);
  }, [focusOperator, switchHidden]);

  /* `tabIndex={-1}`: reachable by script, not a Tab stop — it is where focus
     lands when the switch the reader just pressed goes away. */
  const operatorLine = (
    <p
      ref={operatorRef}
      id={descriptionId}
      tabIndex={-1}
      data-testid="ai-provider-not-configured"
      className="text-[0.8125rem] text-muted"
    >
      No AI provider is configured on this deployment; an operator sets one with <code>AI_PROVIDER</code>.
    </p>
  );

  /* Off with no provider: nothing to switch on, so no switch — the one
     sentence. On with no provider (switched on while one was configured, and
     the deployment has lost it since): the switch STAYS, on, so an admin can
     turn it off — otherwise sending would resume, unseen, to whatever
     provider an operator configures next. */
  if (switchHidden) return operatorLine;

  return (
    <div className="flex flex-col gap-2">
      <Switch
        pressed={settings.aiEnabled}
        label="AI features"
        testId="ai-features-switch"
        describedBy={descriptionId}
        onClick={() => {
          // One change at a time: a second click while the first is in
          // flight would PUT the same value the knob has not yet left. Its
          // own field alone: the other switch is not re-sent.
          if (mutation.isPending) return;
          mutation.mutate({ aiEnabled: !settings.aiEnabled });
        }}
      />
      {/* VISIBLE, and the switch's description: what leaves the deployment
          is the admin's consent, read before the switch is pressed, never a
          caveat behind an ⓘ. With no provider there is no destination to
          name, so the operator line takes its place. */}
      {settings.aiProviderConfigured ? (
        <p id={descriptionId} className="text-[0.8125rem] text-muted">
          {`When on, a member can send a run's figures and the names it records — its simulation, requests, groups and assertions — with its error messages to ${destination(settings)} to write an analysis. Off also hides analyses already written.`}
        </p>
      ) : (
        operatorLine
      )}
      {mutation.isError && <ChangeRefused error={mutation.error} />}
    </div>
  );
}

/**
 * The Public links switch: its sentence always on screen and as its
 * description, and its own field alone in the PUT. The knob moves when the
 * PUT answers, not when it is pressed, as the AI switch's does.
 */
function PublicLinks({ enabled }: { readonly enabled: boolean }) {
  const descriptionId = `${useId()}-public-links`;
  const mutation = useSettingsChange();
  return (
    <div className="flex flex-col gap-2">
      <Switch
        pressed={enabled}
        label="Public links"
        testId="public-links-switch"
        describedBy={descriptionId}
        onClick={() => {
          if (mutation.isPending) return;
          mutation.mutate({ publicLinksEnabled: !enabled });
        }}
      />
      <p id={descriptionId} className="text-[0.8125rem] text-muted">
        {PUBLIC_LINKS_SENTENCE}
      </p>
      {mutation.isError && <ChangeRefused error={mutation.error} />}
    </div>
  );
}

/**
 * `provider/model`, as the deployment names them — and, for an
 * openai-compatible endpoint, the HOST the data actually goes to in front:
 * `llm.internal:8443 (openai-compatible/llama-3.3-70b)`. A provider's name
 * alone does not say whether that endpoint is on the operator's own network
 * or somebody else's. The API sends the host only (never userinfo, path or
 * query); an older API sends no host, and the provider and model are named
 * without one. A configured provider carries both of those
 * (`AdminController#settings` reads them from one config object); a missing
 * half is named as the provider alone rather than printed as `null`.
 */
function destination(settings: OrgSettings): string {
  const { aiProvider, aiModel, aiBaseUrlHost } = settings;
  const named =
    aiProvider !== null && aiModel !== null ? `${aiProvider}/${aiModel}` : (aiProvider ?? 'the configured AI provider');
  return aiProvider === 'openai-compatible' && aiBaseUrlHost != null ? `${aiBaseUrlHost} (${named})` : named;
}
