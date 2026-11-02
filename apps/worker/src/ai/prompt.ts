import type { RunFacts } from '@perfportal/insight';

/**
 * ═══ WHAT THE MODEL IS TOLD ═══
 * (docs/superpowers/specs/2026-11-02-ai-run-analysis-design.md, How it works §2)
 *
 * One fixed system prompt for every run and both providers, so the rules an
 * analysis was written under do not depend on which model wrote it. Every
 * rule here is ALSO enforced after the answer arrives — the schema by
 * `AiAnalysisContentSchema`, the numbers by `checkNumbers` — so the prompt is
 * how the model avoids a refusal, never the thing that makes the output safe.
 *
 * Two rules exist because of how the number check reads text:
 *
 * - A number must be copied exactly as its fact's `display` string. The check
 *   accepts a fact's displayed form and its raw value, nothing in between, so
 *   "1,234" against a display of "1,234" passes and "1.2k" never does.
 * - An error message is quoted whole or not at all. A message is admitted to
 *   carry its own numbers (a status code, a URL fragment) only where its WHOLE
 *   text appears, so a quoted fragment reads as an invented number.
 */
export const SYSTEM_PROMPT = `You write a short analysis of one finished load-test run for a performance engineer, in three sections: how the run went (health), what the figures show (insights), and what to do next (recommendations).

The facts you are given are the only things you know about the run. Each fact has an id, a label, a display string, and sometimes a text.

Rules:
- Cite only the given facts. Do not mention a figure, a request, an error or an assertion that no fact states.
- Copy each number exactly as its fact's display string, including its separators and unit. Never add, subtract, multiply, divide, convert or round a number yourself: a figure that is not a fact's display string is left out.
- Never infer a cause no fact states. Describe what the figures show; do not guess why.
- Quote an error message whole, exactly as its fact's text, or do not quote it at all. Never quote part of one.
- Write plain sentences. Do not number the items, and do not start a sentence with a list marker.
- Each insights list (errors, assertions, injectionProfile, responseTimes) may be empty. Leave it empty when you have nothing to say there rather than writing a sentence to fill it.
- Health and recommendations each need at least one sentence.`;

/** The fields of a fact the model sees: what it may cite, and how to write it. */
interface PromptFact {
  id: string;
  label: string;
  display: string;
  text: string | null;
}

/**
 * The user turn: the facts as JSON, and on a second attempt the reason the
 * first answer was refused. `value` is left out on purpose — it is the raw
 * number behind `display` (16.7634… behind "16.76%"), and a model that saw it
 * would have two spellings of one figure to choose between.
 */
export function userMessage(facts: RunFacts, feedback: string | null): string {
  const shown: PromptFact[] = facts.facts.map((f) => ({ id: f.id, label: f.label, display: f.display, text: f.text }));
  const body = `The run's facts, as JSON:\n${JSON.stringify(shown)}`;
  return feedback === null ? body : `${body}\n\n${feedback}`;
}
