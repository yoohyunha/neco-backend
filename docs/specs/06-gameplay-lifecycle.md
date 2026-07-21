# Gameplay Lifecycle and Sequences

## Main Entry

After login, the client composes the initial state from:

- `GET /game-rooms`
- `GET /game-room-participants`
- `GET /ai-chat-sessions`

Signup creates the user's initial AI chat session ahead of main entry, and MVP main entry should always find at least one reusable `ACTIVE` AI chat session for that user.

Decision rules:

- a `WAITING` room means lobby re-entry candidate
- an `IN_PROGRESS` room means gameplay re-entry candidate
- an invitation means invite briefing should be shown
- no room means AI-chat-led creation should be suggested
- multiple `WAITING` rooms for one user mean abnormal server state

## User Flow Summary

### Onboarding and Authentication

- signup
- signup auto-creates one initial `ACTIVE` AI chat session for the new user
- login
- first room creation guided through AI chat

### Game Room Setup

- room creation by host through AI chat
- invite users by nickname through AI chat
- invite acceptance or denial from the main screen

### Relay Coding Gameplay

- host starts the game
- mission modal is shown on entry
- only the current player edits
- hint lookup is allowed
- submit or timeout ends the turn
- AI analysis and judgment follow execution
- next player receives the next turn

### Session Management

- final result is announced by AI/system
- leaving the game exits room membership

## Room Creation Pipeline

1. The user sends an AI chat message.
2. The AI chat service interprets intent as `ROOM_CREATE`.
3. The AI layer returns a difficulty-selection prompt to the client.
4. After difficulty selection, the server returns mission template candidates for that difficulty.
5. The user confirms a mission template selection.
6. The server creates `game_room`.
7. The server creates the owner participant as `OWNER + JOINED`.
8. Runtime preparation is scheduled or started.
9. The room creation result is reflected both in chat and lobby state.
10. The AI layer returns a follow-up message describing the created room and the next suggested action.

## Invitation Pipeline

### Invite

1. The host asks AI chat to invite users.
2. The AI layer parses invite targets from natural language.
3. The server validates target existence and duplicate membership.
4. The server creates `game_room_participants` rows in `INVITED`.
5. `room-participants-updated` is broadcast.
6. The AI layer returns a follow-up message summarizing invite results and current participant count.

### Accept

1. The invitee accepts the invitation.
2. The client may first fetch invitation data and request an AI-generated invitation briefing.
3. The server verifies the invitation belongs to that user.
4. The participant status changes to `JOINED`.
5. Participant and room state are broadcast.
6. The AI layer returns a room-info and participant-summary follow-up message.

### Deny

1. The invitee denies the invitation.
2. The participant status changes to `DENIED`.
3. State change is broadcast to interested users.
4. The AI layer may return a denial-complete message while the client remains on the main screen.

## Game Start Pipeline

The server authoritatively performs:

1. verify requester is the owner
2. verify minimum participants are present
3. verify room status is `WAITING`
4. finalize the selected mission template
5. create `game_room_mission`
6. create `game_room_mission_steps`
7. set the first step to `READY`
8. create the first turn
9. change room status to `IN_PROGRESS`
10. broadcast `game-started` and `game-state-updated`
11. include enough state for gameplay entry and mission-introduction modal display on the client
12. include `missionState.projectStructure.files[*].fileUrl` so the client can fetch initial file contents for editor setup

## Code Sync Pipeline

- only the current turn player may edit
- whole-file `content` payloads are sent via `code-change`
- the server fans out `code-updated` with whole-file `content`
- realtime content updates are not persisted immediately
- the realtime layer maintains room-session and current-turn latest file content between updates

Persistence points:

- turn submission
- server-driven timeout submission

## Turn Submission and Judgment Pipeline

1. the current player sends `turn-submit`
   - external request payload: `{ gameRoomId, userId, turnId, codeSnapshot, submittedAt }`
2. the server validates player identity and turn status
3. the latest code snapshot is stored
4. the turn status becomes `SUBMITTED`
5. an execution request is created
6. if asynchronous processing is introduced later, the realtime layer may pass work through a queue boundary rather than invoking all processors inline
7. runtime execution is requested
8. execution result is collected
9. server-rule-based primary judgment runs
10. AI-generated test input creation and AI-generated result analysis are optional assistive stages around the core execution path
11. AI feedback may be generated if needed
12. `turn-evaluated` is broadcast
   - `evaluationResult` is treated as a full frontend-facing result payload, including `feedbackMessage`, `detectedIssues`, `strikeCount`, `remainingStrikeCount`, and `executionSummary`

Outcomes:

- success: current step becomes `CLEARED`, next step becomes `READY` or mission ends
- failure: strike count increases, current step stays active or fails
- processing error: the server emits an error notice, and turn state must remain explicit rather than silently corrupted

## Timeout Pipeline

1. the server detects `deadlineAt`
2. the server builds a snapshot from the latest in-memory file content buffer
3. it stores `turn_snapshots` and sets `turns.status = TIMEOUT`
4. execution, judgment, and broadcast follow the same path as manual submission

The difference from manual submit is only the trigger source and final turn status.

## Next Turn Transition

After `turn-evaluated`, the server:

- calculates the next player
- creates the next turn
- finalizes the previous turn
- broadcasts `turn-changed`
- `turn-changed.turnState` must carry the complete next-turn state required by the client timer and editor handoff

The game continues to the next turn unless strike limits or mission completion end it.

## Final Completion Pipeline

Game completion is considered when:

- the last step is cleared
- the strike limit is exceeded
- an operational policy forces termination

On completion the server:

1. stores final `mission_result`
2. may enter an intermediate judgment-processing state such as `JUDGING` while final analysis completes
3. sets `game_rooms.status = FINISHED`
4. records `game_room_missions.finished_at` when needed
5. broadcasts `mission-result` and `game-state-updated`
6. closes every `ACTIVE` `ai_chat_session` bound to that finished room so old in-game chat history is not restored on the next main entry

## Sequence Coverage

The source sequence diagrams cover:

- room creation
- host invitation
- invitee acceptance and denial
- game start
- active gameplay
- game finish

Those flows should be treated as behavioral intent support for the pipelines above, not as a stronger source than the API or data contracts.

## Sequence-Derived Notes

The source sequence diagrams add the following details, and they are now explicitly reflected here:

- room creation is a two-step AI interaction: difficulty selection first, mission template selection second
- mission template selection is delivered back as a natural-language chat message, not a separate `clientAction`
- invitation and acceptance flows include AI-generated briefing or follow-up messages, not only state mutation
- game start should provide client state for gameplay entry and mission-introduction UI
- gameplay entry state includes file metadata plus `fileUrl` values for initial editor loading
- realtime play may use Redis and queue boundaries as support layers without changing server authority
- final completion may briefly pass through a judgment-processing state before `FINISHED`

Where `sequence-diagram.md` uses labels such as `ROOM_CREATED`, `INVITATION_SENT`, `PARTICIPANT_JOINED`, or `PARTICIPANT_DENIED`, treat them as intent-level descriptions unless the same names also appear in the canonical API/WebSocket contract.
