import WebSocket from 'ws';
import { ConflictException } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway';
import type {
  RealtimeAuthService,
  RealtimeDisconnectService,
  RealtimeRoomAccessService,
  RealtimeSupportStateStore,
  RealtimeTurnSubmitService,
  RealtimeTurnEditService,
} from '../service/realtime.interfaces';
import { GameRoomParticipantMembershipStatus, GameRoomParticipantRole } from '@shared/enums';

function createFullTurnState(turnId = 'turn-1', currentPlayerId = 'user-1') {
  return {
    turnId,
    turnNumber: 1,
    currentPlayerId,
    startedAt: '2026-05-22T00:00:00+09:00',
    deadlineAt: '2026-05-22T00:05:00+09:00',
    timeLimitSeconds: 300,
    remainingTimeSeconds: 120,
    status: 'IN_PROGRESS',
  };
}

describe('RealtimeGateway support hooks', () => {
  it('does not mark the user disconnected until the last socket in the room closes', async () => {
    const authService: jest.Mocked<RealtimeAuthService> = {
      validateAccessToken: jest.fn().mockResolvedValue({ userId: 'user-1' }),
    };
    const roomAccessService: jest.Mocked<RealtimeRoomAccessService> = {
      getJoinRoomState: jest.fn().mockResolvedValue({
        gameRoomId: 'room-1',
        initialState: {
          gameRoomId: 'room-1',
          participants: [
            {
              userId: 'user-1',
              nickname: 'owner',
              role: GameRoomParticipantRole.OWNER,
              membershipStatus: GameRoomParticipantMembershipStatus.JOINED,
            },
          ],
          changedParticipant: null,
          gameState: {},
          missionState: null,
          occurredAt: '2026-05-22T00:00:00+09:00',
        },
      }),
    };
    const disconnectService: jest.Mocked<RealtimeDisconnectService> = {
      handleDisconnect: jest.fn().mockResolvedValue(undefined),
    };
    const turnEditService: jest.Mocked<RealtimeTurnEditService> = {
      authorizeCodeChange: jest.fn(),
    };
    const turnSubmitService: jest.Mocked<RealtimeTurnSubmitService> = {
      submitTurn: jest.fn(),
    };
    const supportStateStore: jest.Mocked<RealtimeSupportStateStore> = {
      saveCurrentTurnState: jest.fn().mockResolvedValue(undefined),
      getCurrentTurnState: jest.fn(),
      saveLatestFileContent: jest.fn(),
      getLatestFileContent: jest.fn(),
      listLatestFileContents: jest.fn(),
      clearLatestFileContents: jest.fn(),
    };

    const gateway = new RealtimeGateway(
      authService,
      roomAccessService,
      disconnectService,
      turnEditService,
      turnSubmitService,
      supportStateStore,
    );

    const firstSocket = createSocket();
    const secondSocket = createSocket();

    await gateway.handleJoinRoom(firstSocket, {
      accessToken: 'token-1',
      gameRoomId: 'room-1',
    });
    await gateway.handleJoinRoom(secondSocket, {
      accessToken: 'token-2',
      gameRoomId: 'room-1',
    });

    await gateway.handleDisconnect(firstSocket);
    expect(disconnectService.handleDisconnect).not.toHaveBeenCalled();

    await gateway.handleDisconnect(secondSocket);
    expect(disconnectService.handleDisconnect).toHaveBeenCalledTimes(1);
    expect(disconnectService.handleDisconnect).toHaveBeenCalledWith({
      gameRoomId: 'room-1',
      userId: 'user-1',
    });
  });

  it('forwards whole-file turn-submit payloads when the current turn has no buffered edits yet', async () => {
    const authService: jest.Mocked<RealtimeAuthService> = {
      validateAccessToken: jest.fn().mockResolvedValue({ userId: 'user-1' }),
    };
    const roomAccessService: jest.Mocked<RealtimeRoomAccessService> = {
      getJoinRoomState: jest.fn().mockResolvedValue({
        gameRoomId: 'room-1',
        initialState: {
          gameRoomId: 'room-1',
          participants: [
            {
              userId: 'user-1',
              nickname: 'owner',
              role: GameRoomParticipantRole.OWNER,
              membershipStatus: GameRoomParticipantMembershipStatus.JOINED,
            },
          ],
          changedParticipant: null,
          gameState: {
            status: 'IN_PROGRESS',
            turnState: createFullTurnState(),
          },
          missionState: null,
          occurredAt: '2026-05-22T00:00:00+09:00',
        },
      }),
    };
    const disconnectService: jest.Mocked<RealtimeDisconnectService> = {
      handleDisconnect: jest.fn().mockResolvedValue(undefined),
    };
    const turnEditService: jest.Mocked<RealtimeTurnEditService> = {
      authorizeCodeChange: jest.fn(),
    };
    const turnSubmitService: jest.Mocked<RealtimeTurnSubmitService> = {
      submitTurn: jest.fn().mockResolvedValue(undefined),
    };
    const supportStateStore: jest.Mocked<RealtimeSupportStateStore> = {
      saveCurrentTurnState: jest.fn().mockResolvedValue(undefined),
      getCurrentTurnState: jest.fn().mockResolvedValue({
        currentTurnId: 'turn-1',
        currentTurnUserId: 'user-1',
      }),
      saveLatestFileContent: jest.fn(),
      getLatestFileContent: jest.fn(),
      listLatestFileContents: jest.fn().mockResolvedValue([]),
      clearLatestFileContents: jest.fn(),
    };

    const gateway = new RealtimeGateway(
      authService,
      roomAccessService,
      disconnectService,
      turnEditService,
      turnSubmitService,
      supportStateStore,
    );

    const socket = createSocket();

    await gateway.handleJoinRoom(socket, {
      accessToken: 'token-1',
      gameRoomId: 'room-1',
    });

    await gateway.handleTurnSubmit(socket, {
      gameRoomId: 'room-1',
      userId: 'user-1',
      turnId: 'turn-1',
      submittedAt: '2026-05-22T00:01:00+09:00',
      codeSnapshot: {
        files: [
          {
            filePath: '/workspace/main.py',
            content: 'print("starter")\n',
          },
        ],
      },
    });

    expect(turnSubmitService.submitTurn).toHaveBeenCalledWith({
      gameRoomId: 'room-1',
      turnId: 'turn-1',
      userId: 'user-1',
      occurredAt: '2026-05-22T00:01:00+09:00',
      files: [
        {
          gameRoomId: 'room-1',
          turnId: 'turn-1',
          userId: 'user-1',
          filePath: '/workspace/main.py',
          content: 'print("starter")\n',
          occurredAt: '2026-05-22T00:01:00+09:00',
        },
      ],
    });
  });

  it('ignores malformed turn-submit files payloads before calling the submit hook', async () => {
    const authService: jest.Mocked<RealtimeAuthService> = {
      validateAccessToken: jest.fn().mockResolvedValue({ userId: 'user-1' }),
    };
    const roomAccessService: jest.Mocked<RealtimeRoomAccessService> = {
      getJoinRoomState: jest.fn().mockResolvedValue({
        gameRoomId: 'room-1',
        initialState: {
          gameRoomId: 'room-1',
          participants: [],
          changedParticipant: null,
          gameState: {
            status: 'IN_PROGRESS',
            turnState: createFullTurnState(),
          },
          missionState: null,
          occurredAt: '2026-05-22T00:00:00+09:00',
        },
      }),
    };
    const disconnectService: jest.Mocked<RealtimeDisconnectService> = {
      handleDisconnect: jest.fn().mockResolvedValue(undefined),
    };
    const turnEditService: jest.Mocked<RealtimeTurnEditService> = {
      authorizeCodeChange: jest.fn(),
    };
    const turnSubmitService: jest.Mocked<RealtimeTurnSubmitService> = {
      submitTurn: jest.fn(),
    };
    const supportStateStore: jest.Mocked<RealtimeSupportStateStore> = {
      saveCurrentTurnState: jest.fn().mockResolvedValue(undefined),
      getCurrentTurnState: jest.fn().mockResolvedValue({
        currentTurnId: 'turn-1',
        currentTurnUserId: 'user-1',
      }),
      saveLatestFileContent: jest.fn(),
      getLatestFileContent: jest.fn(),
      listLatestFileContents: jest.fn().mockResolvedValue([]),
      clearLatestFileContents: jest.fn(),
    };

    const gateway = new RealtimeGateway(
      authService,
      roomAccessService,
      disconnectService,
      turnEditService,
      turnSubmitService,
      supportStateStore,
    );
    const socket = createSocket();

    await gateway.handleJoinRoom(socket, {
      accessToken: 'token-1',
      gameRoomId: 'room-1',
    });

    await gateway.handleTurnSubmit(socket, {
      gameRoomId: 'room-1',
      userId: 'user-1',
      turnId: 'turn-1',
      submittedAt: '2026-05-22T00:01:00+09:00',
      codeSnapshot: {
        files: {} as never,
      },
    });

    expect(turnSubmitService.submitTurn).not.toHaveBeenCalled();
  });

  it('resyncs the client when the payload turnId does not match the current support-state turn', async () => {
    const authService: jest.Mocked<RealtimeAuthService> = {
      validateAccessToken: jest.fn().mockResolvedValue({ userId: 'user-1' }),
    };
    const roomAccessService: jest.Mocked<RealtimeRoomAccessService> = {
      getJoinRoomState: jest.fn().mockResolvedValue({
        gameRoomId: 'room-1',
        initialState: {
          gameRoomId: 'room-1',
          participants: [],
          changedParticipant: null,
          gameState: {
            status: 'IN_PROGRESS',
            turnState: createFullTurnState(),
          },
          missionState: null,
          occurredAt: '2026-05-22T00:00:00+09:00',
        },
      }),
    };
    const disconnectService: jest.Mocked<RealtimeDisconnectService> = {
      handleDisconnect: jest.fn().mockResolvedValue(undefined),
    };
    const turnEditService: jest.Mocked<RealtimeTurnEditService> = {
      authorizeCodeChange: jest.fn(),
    };
    const turnSubmitService: jest.Mocked<RealtimeTurnSubmitService> = {
      submitTurn: jest.fn(),
    };
    const supportStateStore: jest.Mocked<RealtimeSupportStateStore> = {
      saveCurrentTurnState: jest.fn().mockResolvedValue(undefined),
      getCurrentTurnState: jest.fn().mockResolvedValue({
        currentTurnId: 'turn-1',
        currentTurnUserId: 'user-1',
      }),
      saveLatestFileContent: jest.fn(),
      getLatestFileContent: jest.fn(),
      listLatestFileContents: jest.fn().mockResolvedValue([]),
      clearLatestFileContents: jest.fn(),
    };

    const gateway = new RealtimeGateway(
      authService,
      roomAccessService,
      disconnectService,
      turnEditService,
      turnSubmitService,
      supportStateStore,
    );
    const socket = createSocket();

    await gateway.handleJoinRoom(socket, {
      accessToken: 'token-1',
      gameRoomId: 'room-1',
    });

    await gateway.handleTurnSubmit(socket, {
      gameRoomId: 'room-1',
      userId: 'user-1',
      turnId: 'turn-2',
      submittedAt: '2026-05-22T00:01:00+09:00',
      codeSnapshot: {
        files: [],
      },
    });

    expect(turnSubmitService.submitTurn).not.toHaveBeenCalled();
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({
        event: 'turn-changed',
        data: {
          gameRoomId: 'room-1',
          previousTurnId: 'turn-2',
          missionState: null,
          turnState: createFullTurnState(),
          nextPlayerId: 'user-1',
          turnSnapshotId: 'turn-1',
          occurredAt: '2026-05-22T00:00:00+09:00',
        },
      }),
    );
  });

  it('resyncs the client when the submit service reports an already-finished turn', async () => {
    const authService: jest.Mocked<RealtimeAuthService> = {
      validateAccessToken: jest.fn().mockResolvedValue({ userId: 'user-1' }),
    };
    const roomAccessService: jest.Mocked<RealtimeRoomAccessService> = {
      getJoinRoomState: jest.fn().mockResolvedValue({
        gameRoomId: 'room-1',
        initialState: {
          gameRoomId: 'room-1',
          participants: [],
          changedParticipant: null,
          gameState: {
            status: 'IN_PROGRESS',
            turnState: createFullTurnState(),
          },
          missionState: null,
          occurredAt: '2026-05-22T00:00:00+09:00',
        },
      }),
    };
    const disconnectService: jest.Mocked<RealtimeDisconnectService> = {
      handleDisconnect: jest.fn().mockResolvedValue(undefined),
    };
    const turnEditService: jest.Mocked<RealtimeTurnEditService> = {
      authorizeCodeChange: jest.fn(),
    };
    const turnSubmitService: jest.Mocked<RealtimeTurnSubmitService> = {
      submitTurn: jest.fn().mockRejectedValue(
        new ConflictException({
          code: 'TURN_NOT_IN_PROGRESS',
          message: 'Only an in-progress turn can be finished.',
        }),
      ),
    };
    const supportStateStore: jest.Mocked<RealtimeSupportStateStore> = {
      saveCurrentTurnState: jest.fn().mockResolvedValue(undefined),
      getCurrentTurnState: jest.fn().mockResolvedValue({
        currentTurnId: 'turn-1',
        currentTurnUserId: 'user-1',
      }),
      saveLatestFileContent: jest.fn(),
      getLatestFileContent: jest.fn(),
      listLatestFileContents: jest.fn().mockResolvedValue([]),
      clearLatestFileContents: jest.fn(),
    };

    const gateway = new RealtimeGateway(
      authService,
      roomAccessService,
      disconnectService,
      turnEditService,
      turnSubmitService,
      supportStateStore,
    );
    const socket = createSocket();

    await gateway.handleJoinRoom(socket, {
      accessToken: 'token-1',
      gameRoomId: 'room-1',
    });

    await gateway.handleTurnSubmit(socket, {
      gameRoomId: 'room-1',
      userId: 'user-1',
      turnId: 'turn-1',
      submittedAt: '2026-05-22T00:01:00+09:00',
      codeSnapshot: {
        files: [],
      },
    });

    expect(turnSubmitService.submitTurn).toHaveBeenCalledTimes(1);
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({
        event: 'turn-changed',
        data: {
          gameRoomId: 'room-1',
          previousTurnId: 'turn-1',
          missionState: null,
          turnState: createFullTurnState(),
          nextPlayerId: 'user-1',
          turnSnapshotId: 'turn-1',
          occurredAt: '2026-05-22T00:00:00+09:00',
        },
      }),
    );
  });
});

function createSocket(): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    send: jest.fn(),
    close: jest.fn(),
  } as unknown as WebSocket;
}
