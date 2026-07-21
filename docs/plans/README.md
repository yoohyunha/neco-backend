# Backend Workstream Plan Index

## Overview

This directory splits the backend implementation plan into one shared sequential track and three parallel worker tracks, using `docs/specs/` as the source of truth.

Read order:

1. `docs/specs/00-overview.md`
2. `docs/plans/common-sequential-plan.md`
3. Your assigned worker plan under this directory

## Workstream Split

### Shared sequential work

Use [`common-sequential-plan.md`](./common-sequential-plan.md) for work that cannot safely run in parallel because it fixes contracts, data layout, or cross-stream integration order.

This includes:

- repository and NestJS scaffold foundation
- shared response, error, and request-id contracts
- database, migration, and enum baselines
- cross-stream integration after the parallel streams complete
- final stabilization and scenario verification

### Parallel worker streams

- Worker 1: [`worker-1-auth-and-ai-chat-plan.md`](./worker-1-auth-and-ai-chat-plan.md)
- Worker 2: [`worker-2-room-participant-mission-plan.md`](./worker-2-room-participant-mission-plan.md)
- Worker 3: [`worker-3-realtime-runtime-execution-plan.md`](./worker-3-realtime-runtime-execution-plan.md)

### Focused follow-up plans

- Calculator mission template, runtime, and step judging: [`calculator-mission-template-runtime-judging-plan.md`](./calculator-mission-template-runtime-judging-plan.md)
- OpenAI Chat Completions hardening and mission feedback: [`openai-llm-integration-plan.md`](./openai-llm-integration-plan.md) — self-contained; agents should follow that file’s per-task **Read first** list and skip `docs/specs/` unless the task says otherwise

## Parallelization Rules

- Do not start any worker stream before the shared foundation checkpoint in `common-sequential-plan.md` is complete.
- Workers may proceed in parallel only within the boundaries defined in their plan file.
- Any task that changes shared DTOs, enums, database migrations, or canonical event payloads must be routed back through the shared sequential track.
- After all worker plans reach their completion checkpoint, resume the shared sequential plan for integration and stabilization.
