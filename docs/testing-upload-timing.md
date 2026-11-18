# Upload timing regression checks (RHEA-235)

These changes only affect TS/Web tests. Production timeout defaults, queue
retention, animations, and Rust code are unchanged.

## Why these tests were unstable

- AC-U5 correctly timed out an unfinished real HTTP body after 20ms, but its
  successful retry inherited the same 20ms disk/scheduling budget. The test now
  restores the normal timeout through the runtime limits API after checking
  `UPLOAD_TIMEOUT`, empty storage, and no received chunks. All three concurrency
  caps are set to one, so the retry also proves the timed-out work released its
  slots. Completion and byte-exact persisted content remain checked.
- The board cancellation test spent 2500ms of its 5000ms total budget waiting
  for queue retention, in addition to DOM queries and exit animations. It now
  awaits the held upload's abort rejection inside `act`, checks the abort signal
  and active count, and advances only the retention timer. The cancelled row
  must remain until `UPLOAD_DONE_MS - 1`, then disappear after the final tick.
  Real timers are restored before awaiting the exit animation. Queued removal,
  cancelled status, absence of a created item, and no start of the removed queued
  file remain checked. Cleanup restores real timers even if an assertion fails.

## Reproduce the checks

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @dropit/server exec tsx --test --test-name-pattern='AC-U5' test/uploads.test.ts
pnpm --filter @dropit/web exec vitest run src/components/clipboard-board.test.tsx -t 'removes a queued'
pnpm --filter @dropit/server exec tsx --test test/uploads.test.ts
pnpm --filter @dropit/web exec vitest run src/components/clipboard-board.test.tsx
pnpm lint
pnpm typecheck
pnpm build
```

The full suite was run with two extra SHA-256 workers on a machine reporting six
available CPUs. This bounded harness keeps the workers alive for the whole test
command and collects and stops them before exiting:

```sh
python3 - <<'PY'
import subprocess
workers = [subprocess.Popen([
    'node', '-e', 'const {createHash}=require("node:crypto"); '
    'const b=Buffer.alloc(1024*1024); '
    'for(;;) createHash("sha256").update(b).digest()'
]) for _ in range(2)]
try:
    result = subprocess.run(['pnpm', 'test'], timeout=240)
finally:
    for worker in workers:
        worker.terminate()
    for worker in workers:
        worker.wait()
raise SystemExit(result.returncode)
PY
```

## Evidence (2026-11-18)

Reference: `ec458afd954002fe93889b5f0a11acc582aad43b` on
`migration/rhea-226-rust`; Node 22.22.0, pnpm 11.1.0.
Before delivery the branch was fast-forwarded to
`1fa73147bd009a47aaf2c6907e02f3f482f4c0d9` (only `rust/MAP.md` changed;
all tested code and configuration are identical).

- Unmodified `pnpm test` with the two workers failed in 51.08s: AC-U5's retry
  returned 400 instead of 204 at line 414, and the board cancellation test was
  reported failed at 5141ms. This was one baseline run, without retries.
- Fixed targeted cases passed; the board case took 539ms in the isolated run.
- Fixed complete upload test files passed: server 18/18; board 19/19.
- Workspace lint, typecheck, and build passed. Existing lint warnings and the
  frontend bundle-size advisory remain informational.
- Fixed `pnpm test` without extra workers passed: server 213/213, Web 248/248
  across 36 files, CLI 42/42 (503 tests total).
- The fixed full suite with the same two workers passed both affected tests
  (server 213/213, Web 247/248), but exited 1 after 91.73s because the unchanged
  `apps/web/src/app.test.tsx:191` text/live-events/reconnect case exceeded its
  5000ms test budget (6275ms). No timeout or assertion in that unrelated test was
  changed. The loaded full-suite result is not claimed as green.
- A predeclared three-round run of each targeted case with the two SHA-256
  workers passed all six invocations. Whole-command durations (including startup
  and transforms) were server 2.98/2.72/2.55s and Web 10.04/6.89/8.08s.
- Negative controls under the same load failed as intended: temporarily omitting
  the global active-slot decrement in `UploadService.put` made AC-U5's retry
  return 429 instead of 204; temporarily omitting `job.controller?.abort()` in
  queue cancellation made the board's abort-signal assertion fail (false instead
  of true). Each source file was restored byte for byte in `finally`; neither
  mutation is included in the PR.
