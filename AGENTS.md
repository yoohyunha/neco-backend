# AGENTS.md

Use the smallest safe change that satisfies the user's goal. Prefer outcome-first execution: define the goal, change only what is needed, verify what matters, then stop.

## 1. Collaboration style

Be concise, direct, and practical.

Prefer making progress over stopping for clarification when the request is clear enough to attempt. Ask only when missing information would materially affect correctness, data safety, security, public API behavior, user-visible behavior, or irreversible work.

When ambiguity is low-risk, make a conservative assumption, state it briefly if it matters for review, and continue.

When disagreeing with a requested approach, explain the tradeoff and suggest the simpler or safer alternative.

## 2. Classify, then scope the work

Before editing, classify the task:

- trivial: typo, copy, formatting, config value, small doc tweak
- bug fix: existing behavior is wrong
- feature: new behavior is requested
- refactor: structure change without intended behavior change
- risky: auth, security, data, schema, migration, public API, permissions, privacy, or destructive operations

Then keep the change set proportional to that class. For multi-step or risky work, give a one- or two-sentence approach update before editing. Do not narrate every command.

### Default reading order (incremental work)

Read the **minimum** needed to implement safely:

1. The user request (and the specific plan **task** if they pointed at a plan).
2. The local code paths you will change (search/open those files first).
3. Nearby tests for the same behavior.

Do **not** start by reading the full `docs/specs/` set, `docs/etc/`, `docs/plans/README.md`, `docs/plans/common-sequential-plan.md`, or `docs/implementaion-logs/**` unless:

- the user explicitly asks you to, or
- the assigned plan task’s **Read first** list says to, or
- you hit a real conflict or ambiguity in API contracts, schema, auth, or state transitions that code alone cannot resolve.

If a focused plan is self-contained (inline decisions, schema, and file lists), treat that plan task as the source of truth for the task and stay inside its read list.

### Specs are escalation, not the default

`docs/specs/` remains the conflict authority for backend contracts, but it is **not** required reading for every small change.

Open a spec only when:

- the user cites it,
- a plan task requires it,
- or code/plan disagree on a public contract and you need precedence.

When specs and code differ:

1. Name the conflicting field, status, flow, or rule.
2. Prefer the higher-priority contract in `docs/specs/00-overview.md` if you must open specs.
3. If still unclear, stop and ask—do not guess.

### Spec routing (only when escalating)

- Purpose / scope: `docs/specs/00-overview.md`
- Architecture / infra: `docs/specs/01-architecture.md`
- Domain invariants: `docs/specs/02-domain-model.md`
- Modules: `docs/specs/03-modules.md`
- Persistence: `docs/specs/04-data-model.md`
- HTTP / WebSocket contracts: `docs/specs/05-api-and-realtime.md`
- Lifecycle flows: `docs/specs/06-gameplay-lifecycle.md`
- Docker / LLM / AI authority: `docs/specs/07-integrations-and-ai.md`
- Security / testing / delivery: `docs/specs/08-security-testing-and-delivery.md`

## 3. Success criteria

A task is complete when:

- The requested behavior is implemented with the smallest safe change.
- The change is scoped to the user’s goal (or the single assigned plan task).
- Relevant validation has passed, or the reason it could not run is stated.
- Assumptions, blockers, skipped checks, or follow-up risks are called out.
- The final response summarizes what changed and how it was verified.

Do not expand into optional features, speculative cleanup, or the next plan task unless asked.

## 4. Smallest safe implementation

Default to direct code.

Add abstraction only when justified by existing duplication, clearer domain behavior, materially better testability, or an established local pattern.

Avoid unrequested configuration, generic frameworks for one-off behavior, broad rewrites, and error handling for impossible paths.

## 5. Keep the diff local

Change only the files and lines needed.

Match local style, naming, formatting, tests, and error-handling conventions.

Adjacent cleanup is allowed only when your change would otherwise leave the code inconsistent, unsafe, untyped, failing tests, or hard to verify.

Remove unused artifacts your change introduces. Mention unrelated issues instead of fixing them.

## 6. Retrieval budget

Use repository code first. Stop retrieving once you can implement or answer correctly.

Do not browse docs to improve phrasing or collect nonessential context.

Prefer: user request → assigned plan task → code/tests → (only if needed) a single conflicting spec.

## 7. Verification proportional to risk

Run the narrowest useful check:

- trivial: light check if available
- bug fix: regression test preferred
- feature: new behavior + important edges
- refactor: behavior check when practical
- risky: targeted tests plus typecheck / lint / migration as relevant

Prefer:

```bash
pnpm test -- <path-or-pattern>
pnpm typecheck
pnpm lint
```

Never claim validation passed if it was not run.

Do not delete, skip, weaken, or rewrite failing tests to force green unless the user explicitly approves. If a test is obsolete, explain and ask before changing it.

If unrelated tests fail, report them; do not fix unless asked.

## 8. Stop rules

Stop when the requested goal (or single plan task) is done and the narrowest useful validation has passed.

Do not continue into polish, extra refactors, or the next task without a user request.

Stop and ask only for material correctness, safety, security, public API, user-visible, or irreversible ambiguity.

### Plan-driven work

When the user assigns a plan under `docs/plans/`:

- Execute **one task** at a time unless they say otherwise.
- Follow that task’s **Read first** / **Do not read** lists when present.
- Create **one commit per completed task** when the plan requires it (or when the user asks to commit).
- Write `docs/implementaion-logs/**` **only when the user explicitly asks**.
- Do not push unless asked.

## 9. Final response format

For completed coding tasks, respond concisely with:

- What changed
- How it was verified
- Assumptions, skipped checks, blockers, or follow-up risks

No large code dumps unless requested. If nothing changed, say so.

## 10. Project commands

Package manager: `pnpm`. Runtime: Node.js. Framework: NestJS. Source: `src/`.

```bash
pnpm install
pnpm dev
pnpm test
pnpm test -- <path-or-pattern>
pnpm typecheck
pnpm lint
pnpm build
pnpm migration:run
```

Use the most specific command that validates the changed behavior.

## 11. Project-specific notes

- LLM integration lives under `src/integrations/llm/` and must stay behind that boundary (domain code does not call vendor SDKs directly).
- AI may interpret, explain, and assist; the server owns authoritative game state.
- Env samples: `.env.example` (JWT, Postgres, Redis, LLM, runtime).
- Docker Compose target: `app`, `postgres`, `redis`.
- Focused follow-up plans may be self-contained; prefer them over re-reading the whole worker/common plan set for small LLM or mission slices.
- Commit message format for this repo: `type(scope):` Korean noun-phrase subject; see `.cursor/rules/commit-message-rule.mdc` when committing.

Follow existing local conventions over generic preferences.
