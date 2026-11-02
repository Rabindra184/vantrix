import { createServer, type IncomingMessage, type Server } from 'node:http';

/**
 * ═══ AN OPENAI-COMPATIBLE PROVIDER THAT ONLY EVER CITES THE RUN ═══
 *
 * The e2e stack has no model and must never call one, so the AI run analysis
 * is proven against this: a `node:http` server answering
 * `POST /v1/chat/completions` the way an OpenAI-compatible endpoint does,
 * with an analysis built from the REQUEST'S OWN FACTS. It copies two facts'
 * `display` strings verbatim into the text, so the worker's `checkNumbers`
 * passes for real — the check runs, and a stub that invented a figure would
 * have its answer refused exactly as a model's would.
 *
 * It is started by `globalSetup` (playwright.config.ts) in the RUNNER
 * process, so it is up for every spec run, every engine and every worker
 * count, and stopped by the teardown that function returns. Nothing in the
 * API calls it: the worker does, and in this stack the worker is
 * `processAiAnalysis` in `fixtures.ts`, run in-process exactly as
 * `parseUploadedRun` runs the pipeline. The API is still given
 * `AI_PROVIDER=openai-compatible` pointing here, because that is what makes
 * it answer `org_disabled` rather than `not_configured` — the state every
 * other spec now runs in, and in which the card renders nothing.
 *
 * ═══ 127.0.0.1, NAMED, AND ONE PORT ABOVE THE HARNESS ═══
 *
 * Bound to `127.0.0.1` explicitly: a wildcard bind on macOS can share a port
 * a specific `127.0.0.1` listener already holds, and a request then reaches
 * the other listener (CLAUDE.md, the test-app-loopback entry). And its port
 * is `PERFPORTAL_E2E_PORT + 1`, derived from the same variable that moves the
 * other four things the harness owns, so moving the harness moves this too.
 */
export const STUB_PORT = Number(process.env.PERFPORTAL_E2E_PORT ?? '3000') + 1;

/** What the API and the in-process worker are told the provider's base URL is. */
export const STUB_BASE_URL = `http://127.0.0.1:${String(STUB_PORT)}/v1`;

/** The model name the stub answers as; nothing reads it but the card's tooltip. */
export const STUB_MODEL = 'stub';

/** The fields of a fact the worker sends (`userMessage` in apps/worker/src/ai/prompt.ts). */
interface SentFact {
  id: string;
  label: string;
  display: string;
  text: string | null;
}

/** The marker `userMessage` puts in front of the facts' JSON. */
const FACTS_HEADER = "The run's facts, as JSON:\n";

/**
 * The facts out of a chat-completions request body. The JSON is the line
 * after the header; on a retry the worker appends `\n\n` and its feedback,
 * which is cut off before parsing.
 */
function factsOf(body: unknown): SentFact[] {
  const messages = (body as { messages?: { role: string; content: string }[] } | null)?.messages ?? [];
  const user = messages.find((m) => m.role === 'user')?.content ?? '';
  const at = user.indexOf(FACTS_HEADER);
  if (at === -1) throw new Error('ai-stub: the request carries no facts');
  const rest = user.slice(at + FACTS_HEADER.length);
  const end = rest.indexOf('\n\n');
  return JSON.parse(end === -1 ? rest : rest.slice(0, end)) as SentFact[];
}

/**
 * The analysis the stub answers with. Every number in it is a fact's `display`
 * copied whole, and no word in it is a number word (`checkNumbers` refuses
 * "one", so the text says "its baseline", never "the previous one").
 *
 * The run's request count and its p95 when the facts carry them, which every
 * run with statistics does; failing either, the first fact whose display holds
 * a digit, so a run of another shape still gets an answer that passes.
 */
export function stubAnalysis(facts: readonly SentFact[]): unknown {
  const withDigits = facts.filter((f) => /\d/.test(f.display));
  const requests = facts.find((f) => f.id === 'run.requests') ?? withDigits[0];
  const p95 = facts.find((f) => f.id === 'run.p95') ?? withDigits[1] ?? requests;
  if (requests === undefined || p95 === undefined) throw new Error('ai-stub: no fact carries a number');
  return {
    health: {
      headline: 'The run ended with its figures recorded.',
      bullets: [`This run sent ${requests.display} requests.`],
    },
    insights: {
      headline: 'The response times below come from this run’s own figures.',
      errors: [],
      assertions: [],
      injectionProfile: [],
      responseTimes: [`The p95 response time was ${p95.display}.`],
    },
    recommendations: {
      headline: 'Read this run beside its baseline before releasing.',
      bullets: ['Open Compare to read this run beside its baseline.'],
    },
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** The server itself, listening; resolves once it accepts connections. */
export function startAiStub(): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
      return;
    }
    readBody(req)
      .then((text) => {
        const content = JSON.stringify(stubAnalysis(factsOf(JSON.parse(text) as unknown)));
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ choices: [{ message: { role: 'assistant', content, refusal: null } }] }));
      })
      .catch((err: unknown) => {
        // A 400, which the worker reads as a refused request and records at
        // once — so a stub defect fails the spec on the card's failure text,
        // never as a retry loop.
        res
          .writeHead(400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      });
  });
  return new Promise((resolve, reject) => {
    server.once('error', (err) =>
      reject(
        new Error(
          `ai-stub: could not listen on 127.0.0.1:${String(STUB_PORT)} (PERFPORTAL_E2E_PORT + 1). ` +
            `Something else holds it, or set PERFPORTAL_E2E_PORT to move the whole harness. ${String(err)}`,
        ),
      ),
    );
    server.listen(STUB_PORT, '127.0.0.1', () => resolve(server));
  });
}

/** Playwright's `globalSetup`: start the stub, and hand back its teardown. */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const server = await startAiStub();
  return () =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
}
