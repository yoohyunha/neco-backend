# Implementation Plan: OpenAI Chat Completions Hardening and Mission Feedback

## Agent bootstrap (read this first)

This plan is **self-contained**. An implementing agent should:

1. Read **only this file** plus the **Read first** files listed on the assigned task.
2. Implement **one task at a time** in order (Task 1 → 6), unless the user names a specific task.
3. Create **exactly one git commit per completed task** (see Commit rule).
4. Write implementaion logs **only if the user explicitly asks**.
5. **Do not** open `docs/specs/`, `docs/etc/`, `docs/implementaion-logs/README.md`, or other plan files unless the user asks or a conflict blocks the task.

### Commit rule

- After a task’s acceptance criteria and verification pass: one commit for that task only.
- Subject style (Korean noun phrase): `feat(llm): …` / `refactor(llm): …` / `fix(llm): …` as appropriate.
- Do not batch multiple tasks into one commit.
- Do not push unless the user asks.
- Do not write `docs/implementaion-logs/**` unless the user asks.

### Stop rule

- Finish the assigned task, verify, commit, then stop and report.
- Do not start the next task unless the user asks.

---

## Goal

- One shared OpenAI-compatible **Chat Completions** HTTP client (`fetch`, no official SDK).
- Harden lobby AI chat (intent + follow-up) to use that client and a **5-message** history window.
- Add `ai_game_sessions` / `ai_game_requests` / `ai_realtime_events` persistence.
- After **server** judgment, **synchronously** enrich `turn-evaluated.evaluationResult.feedbackMessage` via LLM; on failure use static fallback and continue the turn.
- AI never decides pass/fail, strikes, turn ownership, or game end.

## Locked decisions

| Topic | Decision |
|-------|----------|
| HTTP API | `POST {LLM_BASE_URL}/chat/completions` via `fetch` |
| SDK | Do **not** add `openai` package |
| Default model | `gpt-5_4-mini-2026-03-17` |
| Default timeout | `60000` ms |
| Retry | Same call **once** on transient failure, then fallback |
| Lobby history | Latest **5** prior messages + current user message for intent |
| Turn feedback timing | Sync **after** server judge, **before** `turn-evaluated` |
| Feedback `request_type` | `JUDGE` |
| Extra WS `MISSION_FEEDBACK` | Not required; audit via `ai_realtime_events` |
| AI test-input generation | Out of scope |
| AI-primary hints | Out of scope (seed `hint_text` stays) |

## Out of scope

- Responses API / Assistants / `provider_conversation_id` usage
- Multi-provider failover, MQ async AI workers, cost caps
- Changing judge policy or Docker execution authority

## Static feedback fallback (keep these strings)

Used when LLM is missing/fails (already in code today):

- `PASSED` → `현재 미션 단계를 통과했습니다.`
- `FAILED` → `현재 미션 단계를 통과하지 못했습니다.`
- `ERROR` → `런타임 또는 판정 처리 오류가 발생했습니다.`

## Shared client contract (all LLM HTTP)

```ts
// Conceptual — implement under src/integrations/llm/
input: {
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  temperature: number;
  responseFormat?: { type: 'json_object' };
  timeoutMs?: number;
}
output: { content: string }
```

- URL: `${baseUrl.replace(/\/$/, '')}/chat/completions`
- Headers: `Authorization: Bearer ${LLM_API_KEY}`, `Content-Type: application/json`
- Body includes `model`, `temperature`, `messages`, optional `response_format`
- Abort on timeout; retry **once** on network error / abort / HTTP 5xx; then throw
- Callers with no API key must **not** call the client (use local fallback)

## Env defaults (Task 1)

```env
LLM_API_KEY=
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-5_4-mini-2026-03-17
LLM_TIMEOUT_MS=60000
```

Provider string in DB/session metadata remains `openai`.

---

## Task 1: Shared Chat Completions client and LLM defaults

### Read first

- `src/integrations/llm/llm-intent-parser.service.ts` (existing `fetch` Completions shape)
- `src/integrations/llm/llm-follow-up.service.ts` (second `fetch` to dedupe)
- `src/integrations/llm/llm.module.ts`
- `src/common/config/llm.config.ts`
- `.env.example`
- `src/modules/auth/auth.service.ts` (default model fallback)
- `src/modules/ai-chat-sessions/ai-chat-sessions.service.ts` (default model constant)

### Do not read

- Any `docs/specs/**`, `docs/etc/**`, other plans, implementaion-logs

### Do

1. Add shared client port + service under `src/integrations/llm/` implementing the contract above.
2. Wire it in `llm.module.ts` and export the token.
3. Update `.env.example` and `llm.config.ts` defaults to the locked model/timeout.
4. Update hardcoded `gpt-4o` defaults in auth / ai-chat-sessions to the locked model (or read `llm.model` only).
5. Unit-test: success, non-OK HTTP, empty content, timeout, retry-once-then-fail.
6. **Do not** yet rewrite intent/follow-up callers to use the client (Task 2). Client may be unused by callers until Task 2, or temporarily unused is OK if exported and tested.

### Done when

- [ ] Shared client exists and is covered by unit tests
- [ ] Env/config/default model strings match locked decisions
- [ ] One commit for Task 1 only

### Verify

```bash
pnpm test -- src/integrations/llm/
pnpm typecheck
```

### Commit

`feat(llm): Chat Completions 공용 클라이언트 추가` (adjust if needed; Korean noun-phrase subject)

---

## Task 2: Lobby intent + follow-up on shared client + 5-message window

### Read first

- `src/integrations/llm/llm-intent-parser.port.ts`
- `src/integrations/llm/llm-intent-parser.service.ts`
- `src/integrations/llm/llm-follow-up.port.ts`
- `src/integrations/llm/llm-follow-up.service.ts`
- Shared client from Task 1
- `src/modules/ai-chat-sessions/ai-chat-sessions.service.ts`
- `src/modules/ai-chat-sessions/ai-chat-sessions.service.spec.ts`
- Existing intent/follow-up `*.spec.ts`

### Do not read

- Specs, ERD, other plans, logs

### Do

1. Replace private `fetch` Completions in intent + follow-up with the shared client.
2. Intent: `temperature: 0`, `response_format: { type: 'json_object' }`.
3. Follow-up: `temperature: 0.3`, no JSON response_format.
4. Extend intent parse input to accept prior messages; `ai-chat-sessions` loads up to **5** prior messages for the session (oldest→newest in window) and passes them with the current user message.
5. Keep key-missing → heuristics / static follow-up; API failure → same.
6. Keep prompt-template usage as today when templates exist.
7. Update unit tests (window wiring + no private Completions `fetch` in those two services).

### Done when

- [ ] Intent/follow-up have no private Completions `fetch`
- [ ] Intent receives ≤5 prior messages + current message
- [ ] Fallbacks still work without `LLM_API_KEY`
- [ ] One commit for Task 2 only

### Verify

```bash
pnpm test -- src/integrations/llm/
pnpm test -- src/modules/ai-chat-sessions/
pnpm typecheck
```

### Commit

`refactor(llm): 로비 intent·follow-up 공용 클라이언트 전환`

---

## Task 3: Persist `ai_game_sessions`, `ai_game_requests`, `ai_realtime_events`

### Read first

- An existing AI entity + migration pair for naming patterns, e.g.:
  - `src/modules/ai-chat-sessions/entity/ai-chat-session.entity.ts`
  - `database/migrations/1747843200000-InitialAuthAndAiChat.ts` or `1747843300000-AiChatRequestsAndMessages.ts`
- `src/shared/enums/ai-chat.enum.ts` (extend or add sibling enums)
- `src/app.module.ts` (module registration pattern)
- Where rooms finish / AI chat sessions are closed (search `CLOSED` / `ai_chat_session` in `src/modules/`)

### Do not read

- `docs/specs/**`, `docs/etc/erd.md` — schema is inlined below

### Schema to implement (inline)

**`ai_game_sessions`**

| Column | Type | Notes |
|--------|------|--------|
| id | uuid PK | |
| game_room_id | uuid NOT NULL | |
| provider_conversation_id | text NULL | leave unused |
| provider | text NOT NULL | `openai` |
| llm_model | text NOT NULL | from config |
| status | text NOT NULL | `ACTIVE` \| `CLOSED` \| `ERROR` |
| created_at / updated_at | timestamptz NOT NULL | |
| closed_at | timestamptz NULL | |

**`ai_game_requests`**

| Column | Type | Notes |
|--------|------|--------|
| id | uuid PK | |
| ai_game_session_id | uuid NOT NULL FK | |
| request_type | text NOT NULL | `DEBUG` \| `JUDGE` (turn feedback uses `JUDGE`) |
| turn_id | uuid NULL | |
| mission_id | uuid NULL | |
| request_payload | jsonb NOT NULL | |
| response_payload | jsonb NULL | |
| status | text NOT NULL | `RECEIVED` \| `COMPLETED` \| `FAILED` |
| requested_at / created_at / updated_at | timestamptz NOT NULL | |
| responded_at | timestamptz NULL | |

Index: `(ai_game_session_id, requested_at)`.

**`ai_realtime_events`**

| Column | Type | Notes |
|--------|------|--------|
| id | uuid PK | |
| ai_game_request_id | uuid NOT NULL FK | |
| ai_game_session_id | uuid NOT NULL FK | |
| game_room_id | uuid NOT NULL | |
| event_type | text NOT NULL | `SYSTEM_NOTIFICATION` \| `MISSION_FEEDBACK` \| `MISSION_RESULT` |
| target_user_id | uuid NULL | |
| message | text NOT NULL | |
| payload_json | jsonb NULL | |
| delivery_status | text NOT NULL | `PENDING` \| `SENT` \| `FAILED` |
| occurred_at / created_at | timestamptz NOT NULL | |
| delivered_at | timestamptz NULL | |

### Do

1. Migration + TypeORM entities + enums matching local style.
2. Small service: `ensureActiveSession(gameRoomId)`, start/complete/fail request, append realtime event.
3. On room finish path that already closes AI chat sessions: also close `ACTIVE` `ai_game_sessions` for that room.
4. Unit tests for ensure-session + request lifecycle.

### Done when

- [ ] Tables/entities/service exist and tests pass
- [ ] Finish-room closes active AI game sessions
- [ ] One commit for Task 3 only

### Verify

```bash
pnpm test -- <new-or-touched-ai-game-module-path>
pnpm typecheck
```

Migration run only if local Postgres is available; if not, say so in the final report and still ship migration files.

### Commit

`feat(llm): ai_game 세션·요청·이벤트 영속화 추가`

---

## Task 4: Mission feedback LLM generator + prompt seeds

### Read first

- Shared client (Task 1)
- AI game persistence service (Task 3)
- `src/modules/prompt-template/prompt-template.service.ts`
- `src/modules/prompt-template/constants/prompt-template-key.constants.ts`
- `database/seeds/ai_prompt_templates.json`
- `src/modules/ai-chat-sessions/intent/ai-chat-assistant-content.ts` (`sanitizeFollowUpContent`)
- `src/modules/mission-results/build-turn-evaluation-result-payload.ts` (static fallback strings)

### Do not read

- Specs / sequence diagrams

### Do

1. Add seed template(s) purpose `mission_feedback` (or `judge`) that ask for one short Korean feedback sentence; variables for judgeStatus, step info, truncated stdout/stderr, detected issue summaries.
2. Add generator port/service: render template → shared client → sanitize → return text; on any failure return static fallback strings above.
3. Persist attempt via Task 3 with `request_type = JUDGE` (`COMPLETED` / `FAILED`).
4. Generator must not accept or return a new judge status—wording only.
5. Truncate large execution excerpts in the request payload (keep prompts small).
6. Unit tests: success, sanitize reject, API fail → fallback + FAILED persistence.

### Done when

- [ ] Generator + seeds + tests exist
- [ ] Not yet required to be wired into turns (Task 5)
- [ ] One commit for Task 4 only

### Verify

```bash
pnpm test -- src/integrations/llm/
pnpm test -- src/modules/prompt-template/
pnpm typecheck
```

### Commit

`feat(llm): 미션 피드백 생성기 추가`

---

## Task 5: Sync feedback into turn path before `turn-evaluated`

### Read first

- `src/modules/turns/service/turns.service.ts` (where `buildTurnEvaluationResultPayload` is used before broadcast)
- `src/modules/mission-results/build-turn-evaluation-result-payload.ts`
- `src/modules/turns/service/turns.service.spec.ts`
- Mission feedback generator (Task 4)
- AI game persistence (Task 3)
- Timeout path if separate from submit (same enrichment required)

### Do not read

- Full gameplay lifecycle specs

### Do

1. After server judgment payload is built, call feedback generator; set `feedbackMessage` to LLM text or static fallback.
2. Persist `ai_realtime_events` with `event_type = MISSION_FEEDBACK`, `delivery_status = SENT` when the message is included in `turn-evaluated` (best-effort: persistence failure must not unwind judgment).
3. Ensure timeout submission uses the same enrichment path.
4. Tests: mocked LLM success changes message; mocked failure keeps static message and still completes turn / next-turn logic.

### Done when

- [ ] Sync enrichment is on submit + timeout paths
- [ ] LLM failure cannot block turn completion
- [ ] One commit for Task 5 only

### Verify

```bash
pnpm test -- src/modules/turns/
pnpm test -- src/modules/mission-results/
pnpm typecheck
```

### Commit

`feat(llm): 턴 평가 피드백 LLM 연동`

---

## Task 6: Regression and plan-index sanity

### Read first

- Tests touched in Tasks 1–5
- `docs/plans/README.md` (confirm this plan is linked; add link only if missing)
- Hint controller/service only if needed to confirm no AI-hint regression: `src/modules/game-room-missions/controller/game-room-missions.controller.ts`

### Do not read

- Specs, implementaion-logs README

### Do

1. Fill any missing regression coverage called out in Tasks 1–5 (window size 5, retry-once, non-blocking feedback, persistence statuses).
2. Confirm no AI test-input generation was added.
3. Confirm hint API still returns seed `hintText`.
4. Confirm `docs/plans/README.md` lists this plan (already expected; fix only if absent).
5. Run a broader unit pass if practical.

### Done when

- [ ] Regressions green; out-of-scope items not introduced
- [ ] One commit for Task 6 only (or empty skip only if literally nothing to change—prefer a small test hardening commit)

### Verify

```bash
pnpm test -- src/integrations/llm/
pnpm test -- src/modules/ai-chat-sessions/
pnpm test -- src/modules/turns/
pnpm typecheck
```

Optional if environment allows: `pnpm test -- src/test/scenarios/`

### Commit

`test(llm): OpenAI 연동 회귀 검증 보강`

---

## Dependency graph

```text
Task 1 → Task 2
Task 1 → Task 4 → Task 5 → Task 6
Task 3 → Task 4
```

Task 2 and Task 3 may proceed in parallel after Task 1 if the user assigns that; default sequential agents should still do 1→2→3→4→5→6.

## Failure policy (all tasks)

| Case | Behavior |
|------|----------|
| No `LLM_API_KEY` | No HTTP; lobby heuristics/static; turn static feedback |
| HTTP/timeout after 1 retry | Same fallbacks; AI request `FAILED` when persistence exists |
| Unsafe/empty LLM text | Sanitize reject → static fallback |
| AI table write fails after judgment | Log; do not roll back judgment / turn transitions |

## Open questions

None. If the model slug is rejected by the provider, override `LLM_MODEL` in env only.
