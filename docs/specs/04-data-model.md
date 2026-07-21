# Data Model and Persistence Rules

## Core Relationships

```text
users
 └─ refresh_tokens

game_rooms
 └─ game_room_participants
 └─ game_room_missions
     └─ game_room_mission_steps
     └─ turns
         └─ turn_snapshots
         └─ executions
         └─ mission_results

mission_templates
 └─ mission_template_steps

ai_chat_sessions
 └─ ai_chat_requests
 └─ ai_chat_messages

ai_game_sessions
 └─ ai_game_requests
 └─ ai_realtime_events
```

## Main Tables

Persistent tables currently defined in the ERD:

- `game_rooms`
- `game_room_participants`
- `docker_images`
- `docker_image_deployments`
- `mission_templates`
- `mission_template_steps`
- `game_room_missions`
- `game_room_mission_steps`
- `turns`
- `turn_snapshots`
- `executions`
- `mission_results`
- `ai_game_sessions`
- `ai_game_requests`
- `ai_chat_sessions`
- `ai_chat_requests`
- `ai_chat_messages`
- `ai_realtime_events`
- `ai_prompt_templates`

## Storage Principles

- External API fields use `camelCase`.
- Database columns use `snake_case`.
- Frequently changing structured payloads use `jsonb`.
- Code source, project structure, and judgment payloads may use `jsonb` or `text`.
- PostgreSQL must provide `pgcrypto` so migrations can use `gen_random_uuid()` for UUID defaults.

## Recommended Indexes

- `game_rooms(owner_user_id, status)`
- `game_room_participants(game_room_id, user_id)`
- `game_room_participants(user_id, membership_status)`
- `game_room_missions(game_room_id)`
- `turns(game_room_id, mission_id)`
- `executions(game_room_id, mission_id, turn_id)`
- `mission_results(game_room_id, mission_id, turn_id)`
- `ai_chat_sessions(requester_user_id)`
- `ai_chat_messages(ai_chat_session_id, created_at)`
- `ai_game_requests(ai_game_session_id, requested_at)`

Constraint intent notes:

- `ai_chat_sessions(requester_user_id, status='ACTIVE')` should be treated as unique in MVP because each user may keep closed chat history but must have at most one active AI chat session.
- The single-`WAITING`-room-per-user rule is primarily a service-layer invariant, but the storage design may add a supporting partial unique constraint or equivalent guard if needed.

## State Management Rules

- Status values are stored as `text` in the database and validated as application enums.
- Shared enums should be centrally managed under `shared/enums` or `common/constants`.
- If state values disagree across documents, the API/realtime contract wins and the storage model must be reconciled to it.

## Durable vs Ephemeral State

Durable:

- turn-end snapshots
- execution results
- mission results
- AI message history

Ephemeral or cache-like:

- latest realtime file content buffer
- live session state
- temporary fan-out support state

## ERD Notes to Preserve

- `turns.status` must use `IN_PROGRESS | SUBMITTED | TIMEOUT`.
- `game_room_participants.membership_status` must encode invite lifecycle.
- `game_room_missions.current_step_id` points to the active room mission step.
- `executions` ties runtime work back to room, mission, turn, and user context.
