# API and Realtime Contract

## General API Rules

- Base URL: `/v1`
- resource names: plural
- path style: `kebab-case`
- request and response fields: `camelCase`
- response wrapper: always `data`, `meta`, `error`

## Authentication

All APIs require authentication except:

- `GET /v1/auth/check-nickname`
- `POST /v1/auth/signup`
- `POST /v1/auth/login`
- `POST /v1/auth/refresh-token`

Auth request field rules:

- `POST /v1/auth/signup` accepts `passwordHash` as a SHA-256 hex string.
- `POST /v1/auth/login` accepts `passwordHash` as a SHA-256 hex string.
- `POST /v1/auth/refresh-token` returns both a new `accessToken` and a new `refreshToken`.
- On successful signup, the server automatically creates one initial `ACTIVE` AI chat session for that user.

Authorization header:

`Bearer {accessToken}`

## Response Wrapper

Success:

```json
{
  "data": {},
  "meta": {
    "requestId": "uuid"
  },
  "error": null
}
```

Error:

```json
{
  "data": null,
  "meta": {
    "requestId": "uuid"
  },
  "error": {
    "code": "ERROR_CODE",
    "message": "message"
  }
}
```

## Timestamp Policy

- All timestamps are serialized as ISO 8601 strings in `Asia/Seoul` timezone.
- The client is not expected to convert to another timezone for MVP.

## Pagination Policy

- MVP does not support pagination.
- List endpoints return the full list.
- `meta` contains `requestId` only.

## Important Domain Constants

### Room and Turn

- `GameRoomStatus`: `WAITING`, `IN_PROGRESS`, `JUDGING`, `ANALYZED`, `FINISHED`
- `TurnStatus`: `IN_PROGRESS`, `SUBMITTED`, `TIMEOUT`
- `GameRoomParticipantMembershipStatus`: `INVITED`, `JOINED`, `LEFT`, `DENIED`
- `GameRoomParticipantRole`: `OWNER`, `PARTICIPANT`
- `GameRoomMissionStepStatus`: `LOCKED`, `READY`, `IN_PROGRESS`, `CLEARED`, `FAILED`

### Execution and AI

- `ExecutionStatus`: `PENDING`, `RUNNING`, `SUCCESS`, `FAILED`, `TIMEOUT`
- `AiChatRequestType`: `ROOM_CREATE`, `USER_INVITE`, `ROOM_JOIN`, `USER_INVITE_DENY`, `GAME_START`
- `AiChatRequestStatus`: `RECEIVED`, `COMPLETED`, `FAILED`
- `AiChatMessageSenderType`: `USER`, `ASSISTANT`, `SYSTEM`
- `AiChatMessageType`: `TEXT`, `COMMAND_RESULT`, `SYSTEM_NOTICE`
- `AiRealtimeEventType`: `SYSTEM_NOTIFICATION`, `MISSION_FEEDBACK`, `MISSION_RESULT`

## Key Endpoint Categories

### Auth

- nickname duplication check
- signup
- login
- token refresh

### Main Entry

- `GET /v1/ai-chat-sessions`
- `GET /v1/game-rooms`
- `GET /v1/game-room-participants`

Main entry contract notes:

- `GET /v1/ai-chat-sessions` returns the user's AI chat session list in MVP and must guarantee at least one `ACTIVE` session for main-entry use.
- `GET /v1/game-rooms` may return multiple rooms across statuses, but the server must guarantee at most one `WAITING` room per user.
- If multiple `WAITING` rooms are returned for one user, the client should treat that as an abnormal state.

### AI Chat

- `GET /v1/ai-chat-sessions/{aiChatSessionId}/messages`
- `POST /v1/ai-chat-sessions/{aiChatSessionId}/messages`

`POST /v1/ai-chat-sessions/{aiChatSessionId}/messages` response rules:

- `requestType` uses the canonical five command values only when intent parsing has finished.
- When `requestStatus` is `RECEIVED`, `requestType` must be omitted from the success payload.
- When `requestStatus` is `COMPLETED` or `FAILED`, `requestType` is required.
- Until intent parsing is implemented, the server may persist an internal unparsed marker in storage, but that value must not appear in API responses.

### Game Start

- `POST /v1/game-rooms/{gameRoomId}/start`

### Hint

- `GET /v1/game-room-missions/{missionId}/hints?scope=current-step`

## API Design Rules

- Action endpoints are allowed for room creation, invitation, and similar behaviors when the target resource remains explicit.
- Return `404` for missing single resources.
- Return `[]` for empty lists.
- Never expose raw database `snake_case` fields directly.
- After the game starts, the frontend should treat WebSocket events as the primary state-update channel.

## WebSocket Events

Event names are fixed:

- `join-room`
- `room-participants-updated`
- `game-started`
- `code-change`
- `code-updated`
- `turn-submit`
- `turn-evaluated`
- `turn-changed`
- `game-state-updated`
- `mission-result`

Payload shape must follow the API spec as the external contract.

Payload-specific contract notes:

- `game-started` must include gameplay-entry state for the initial editor.
- `game-started.missionState` must include:
  - `title: string`
  - `description: string`
  - `language: string`
  - `difficulty: string`
- `game-started.missionState.projectStructure.files[*]` must include:
  - `filePath: string`
  - `language: string`
  - `readonly: boolean`
  - `fileUrl: string`
- `fileUrl` is a presigned or public URL that the client fetches to load the initial file content.
- `room-participants-updated` must always include:
  - `participants: array`
  - `changedParticipant: object | null`
- `changedParticipant` may be `null` only when the broadcast represents a full-state refresh without one specific participant transition to highlight.
- `code-change` uses whole-file synchronization payloads with `content: string`, not `codeDelta`.
- `code-updated` uses whole-file synchronization payloads with `content: string`, not `codeDelta`.
- `turn-submit` uses `{ gameRoomId, userId, turnId, codeSnapshot, submittedAt }` as the external client payload.
- `turn-changed` must include a full `turnState` payload for the next active turn.
- `turn-evaluated.evaluationResult` must include:
  - `feedbackMessage: string`
  - `detectedIssues: array`
  - `strikeCount: number`
  - `remainingStrikeCount: number`
  - `executionSummary: object`

Canonical event payload summaries:

### `room-participants-updated` (Server -> Client)

- `gameRoomId: string`
- `participants: array`
- `changedParticipant: object | null`
- `gameState: object`
- `missionState: object | null`
- `occurredAt: string`

### `game-started` (Server -> Client)

- `gameRoomId: string`
- `gameState: object`
- `missionState: object`
  - `title: string`
  - `description: string`
  - `language: string`
  - `difficulty: string`
  - `projectStructure.files[*]`
- `uiHints: object`
- `occurredAt: string`

### `code-change` (Client -> Server)

- `gameRoomId: string`
- `userId: string`
- `sessionId: string`
- `filePath: string`
- `content: string`
- `occurredAt: string`

### `code-updated` (Server -> Client)

- `gameRoomId: string`
- `userId: string`
- `filePath: string`
- `content: string`
- `occurredAt: string`

Optional field:

- `sessionId?: string`
  - allowed only when the frontend contract needs echo suppression

### `turn-submit` (Client -> Server)

- `gameRoomId: string`
- `userId: string`
- `turnId: string`
- `codeSnapshot: object`
  - `files[*].filePath: string`
  - `files[*].content: string`
- `submittedAt: string`

### `turn-evaluated` (Server -> Client)

- `gameRoomId: string`
- `evaluatedTurn: object`
- `evaluationResult: object`
  - `feedbackMessage: string`
  - `detectedIssues[*].issueType: string`
  - `detectedIssues[*].message: string`
  - `detectedIssues[*].filePath: string`
  - `detectedIssues[*].lineNumber?: number`
  - `strikeCount: number`
  - `remainingStrikeCount: number`
  - `executionSummary: object`
- `occurredAt: string`

### `turn-changed` (Server -> Client)

- `gameRoomId: string`
- `missionState: object`
- `turnState: object`
  - `turnId: string`
  - `turnNumber: number`
  - `currentPlayerId: string`
  - `startedAt: string`
  - `deadlineAt: string`
  - `timeLimitSeconds: number`
  - `remainingTimeSeconds: number`
  - `status: string`
- `nextPlayerId: string`
- `turnSnapshotId: string`
- `occurredAt: string`

## WebSocket Close Codes

| Code | Reason |
|---|---|
| `4401` | `AUTH_TOKEN_INVALID` |
| `4403` | `FORBIDDEN_RESOURCE_ACCESS` |
| `4404` | `GAME_ROOM_NOT_FOUND` |
| `1000` | normal closure |

MVP reconnection is not supported. A broken connection transitions the participant to `LEFT`.
