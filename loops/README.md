# Gold Metal Alchemist — Loops

Self-learning loop engine. Full context: ../SCOPE.md.

## How it works
- `run.js <loop-name>` runs `prompts/<loop-name>.md` through headless Claude Code.
- Guards, in order: GoldBridge HALT kill switch (`~/Projects/goldbridge/HALT`) → skip;
  $10/day shared budget (summed from gma_loop_runs) → skip + escalate once.
- Every run (including skips) lands in the `gma_loop_runs` table → visible in the app
  (`GET /api/gma/runs`, `GET /api/gma/status`).

## Loops
| Loop | Schedule | Phase |
|------|----------|-------|
| alchemy-capture | 4:05pm PT + session close | 1 |
| journal-drafter | after session close (+ on-demand) | 1 |
| recon | 10:30pm PT nightly | 1 |
| cake-planner | 1:30am PT nightly | 2 (plans-only until sweep engine exists) |
| weekly-digest | Sunday 8am | 2 |

## Test a loop by hand
```
node loops/run.js recon
```

## Schedules
NOT active by default. When ready: `bash loops/launchd/install.sh`.
Emergency stop everything: `touch ~/Projects/goldbridge/HALT`.

## Rules baked into every prompt
- Report/propose only — no live trading actions, no GoldBridge config edits, ever.
- Escalate to `gma_escalations` instead of retrying forever (3-attempt spirit).
- Local math for arithmetic (sweep engine), tokens for judgment only.
