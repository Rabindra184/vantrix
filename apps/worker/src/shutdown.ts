// Source of truth: packages/core/src/shutdown.ts. Shared with the on-prem
// runner (apps/runner), which drives the same "run every teardown step,
// keep going past a failure, never reject" logic from its own main loop --
// see that file's own doc comment for why a plain sequential
// `await a(); await b(); ...` is not equivalent.
export { runShutdown, type ShutdownStep } from '@perfportal/core';
