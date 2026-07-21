import { ConflictException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import { ExecutionEntity } from '@modules/executions/entity/execution.entity';
import { ExecutionsService } from '@modules/executions/service/executions.service';
import { AiChatSession } from '@modules/ai-chat-sessions/entity/ai-chat-session.entity';
import { AiGameSession } from '@modules/ai-game-sessions/entity/ai-game-session.entity';
import { GameRoomMissionStepEntity } from '@modules/game-room-missions/entity/game-room-mission-step.entity';
import { GameRoomMissionEntity } from '@modules/game-room-missions/entity/game-room-mission.entity';
import { GameRoomMissionsService } from '@modules/game-room-missions/service/game-room-missions.service';
import { GameRoomParticipantEntity } from '@modules/game-room-participants/entity/game-room-participant.entity';
import { GameRoomEntity } from '@modules/game-rooms/entity/game-room.entity';
import { MissionResultsService } from '@modules/mission-results/service/mission-results.service';
import {
  AiChatSessionStatus,
  AiGameSessionStatus,
  ExecutionStatus,
  GameRoomMissionStepStatus,
  GameRoomParticipantMembershipStatus,
  GameRoomStatus,
  MissionResultJudgeStatus,
  TurnStatus,
} from '@shared/enums';
import { TurnSnapshotEntity } from '../entity/turn-snapshot.entity';
import { TurnEntity } from '../entity/turn.entity';
import { TurnsService } from './turns.service';

describe('TurnsService', () => {
  it('persists snapshot, execution outcome, and next turn on successful submit', async () => {
    const room = createRoom();
    const mission = createMission();
    mission.projectStructureJson = {
      ...mission.projectStructureJson,
      files: [
        {
          filePath: 'main.py',
          language: 'python',
          fileUrl: 'data:text/plain;charset=utf-8,print(%22old%22)%0A',
        },
      ],
    };
    const currentStep = createCurrentStep();
    mission.missionTemplate = {
      id: 'template-1',
      title: 'Calculator Relay',
      description: 'Complete the calculator mission.',
      language: 'python',
    } as never;
    mission.steps = [
      currentStep,
      {
        ...currentStep,
        id: 'step-2',
        missionTemplateStepId: 'template-step-2',
        stepOrder: 2,
        status: GameRoomMissionStepStatus.READY,
        missionTemplateStep: {
          ...currentStep.missionTemplateStep,
          id: 'template-step-2',
          stepOrder: 2,
          title: 'Compute result',
          description: 'Calculate the final answer.',
        },
      },
    ];
    const turn = createTurn();
    const participants = createParticipants();
    const snapshots: TurnSnapshotEntity[] = [];
    const turns = [turn];
    const manager = createManager({
      room,
      mission,
      currentStep,
      turns,
      participants,
      snapshots,
    });
    const dataSource = {
      transaction: jest.fn(async (callback: (manager: EntityManager) => unknown) =>
        callback(manager as unknown as EntityManager),
      ),
    } as unknown as DataSource;
    const gameRoomMissionsService: jest.Mocked<
      Pick<
        GameRoomMissionsService,
        'completeCurrentStep' | 'recordFailedAttempt' | 'transitionCurrentStepToInProgress'
      >
    > = {
      completeCurrentStep: jest.fn().mockResolvedValue({
        mission: {
          id: mission.id,
          gameRoomId: mission.gameRoomId,
          missionTemplateId: mission.missionTemplateId,
          currentStepId: 'step-2',
          containerId: mission.containerId,
          strikeCount: 0,
          judgePolicyJson: mission.judgePolicyJson,
          projectStructureJson: mission.projectStructureJson,
          startedAt: mission.startedAt,
          finishedAt: mission.finishedAt,
          createdAt: mission.createdAt,
          updatedAt: mission.updatedAt,
        },
        clearedStep: {
          ...currentStep,
          status: GameRoomMissionStepStatus.CLEARED,
        },
        nextStep: {
          ...currentStep,
          id: 'step-2',
          stepOrder: 2,
          status: GameRoomMissionStepStatus.READY,
        },
        missionFinished: false,
      }),
      recordFailedAttempt: jest.fn(),
      transitionCurrentStepToInProgress: jest.fn().mockResolvedValue({
        ...currentStep,
        id: 'step-2',
        missionTemplateStepId: 'template-step-2',
        stepOrder: 2,
        status: GameRoomMissionStepStatus.IN_PROGRESS,
        missionTemplateStep: {
          ...currentStep.missionTemplateStep,
          id: 'template-step-2',
          stepOrder: 2,
          title: 'Compute result',
          description: 'Calculate the final answer.',
        },
      }),
    };
    const executionsService: jest.Mocked<Pick<ExecutionsService, 'executeTurnCode'>> = {
      executeTurnCode: jest.fn().mockResolvedValue({
        id: 'execution-1',
        status: ExecutionStatus.SUCCESS,
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        runtimeFailureCode: null,
        runtimeFailureMessage: null,
      } as ExecutionEntity),
    };
    const missionResultsService: jest.Mocked<
      Pick<MissionResultsService, 'createMissionResult'>
    > = {
      createMissionResult: jest.fn().mockResolvedValue({} as never),
    };
    const service = new TurnsService(
      {
        get: jest.fn().mockReturnValue(10000),
      } as unknown as ConfigService,
      dataSource,
      gameRoomMissionsService as unknown as GameRoomMissionsService,
      executionsService as unknown as ExecutionsService,
      missionResultsService as unknown as MissionResultsService,
    );

    const result = await service.submitTurn({
      gameRoomId: room.id,
      turnId: turn.id,
      userId: turn.playerUserId,
      occurredAt: '2026-05-26T10:00:10+09:00',
      files: [
        {
          gameRoomId: room.id,
          turnId: turn.id,
          userId: turn.playerUserId,
          filePath: 'main.py',
          content: 'print("done")\n',
          occurredAt: '2026-05-26T10:00:00+09:00',
        },
      ],
    });

    expect(snapshots).toHaveLength(1);
    expect(turn.status).toBe(TurnStatus.SUBMITTED);
    expect(executionsService.executeTurnCode).toHaveBeenCalledWith(
      expect.objectContaining({
        gameRoomId: room.id,
        missionId: mission.id,
        turnId: turn.id,
        filePath: '/workspace/main.py',
        content: 'print("done")\n',
      }),
    );
    expect(gameRoomMissionsService.completeCurrentStep).toHaveBeenCalled();
    expect(gameRoomMissionsService.transitionCurrentStepToInProgress).toHaveBeenCalled();
    expect(missionResultsService.createMissionResult).toHaveBeenCalledWith(
      expect.objectContaining({
        judgeStatus: MissionResultJudgeStatus.PASSED,
      }),
    );
    expect(result.turnChangedEvent).toMatchObject({
      gameRoomId: room.id,
      previousTurnId: turn.id,
      nextPlayerId: 'user-2',
      missionState: {
        title: 'Calculator Relay',
        description: 'Complete the calculator mission.',
        language: 'python',
        gameRoomMissionStepId: 'step-2',
        missionTemplateStepId: 'template-step-2',
        stepOrder: 2,
        stepTitle: 'Compute result',
        stepDescription: 'Calculate the final answer.',
        steps: [
          expect.objectContaining({
            gameRoomMissionStepId: 'step-1',
            title: 'Parse stdin',
          }),
          expect.objectContaining({
            gameRoomMissionStepId: 'step-2',
            title: 'Compute result',
            description: 'Calculate the final answer.',
          }),
        ],
      },
      turnState: {
        turnId: 'turn-2',
        turnNumber: 2,
        currentPlayerId: 'user-2',
        timeLimitSeconds: room.timeLimitSeconds,
        remainingTimeSeconds: room.timeLimitSeconds,
        status: TurnStatus.IN_PROGRESS,
      },
    });
    expect(result.turnChangedEvent?.missionState?.projectStructure.files[0]).toMatchObject({
      filePath: 'main.py',
      content: 'print("done")\n',
      fileUrl: 'data:text/plain;charset=utf-8,print(%22done%22)%0A',
    });
    expect(result.missionResultEvent).toBeNull();
    expect(result.gameStateUpdatedEvent.gameState).toMatchObject({
      status: GameRoomStatus.IN_PROGRESS,
    });
    expect(result.gameStateUpdatedEvent.missionState).toMatchObject({
      title: 'Calculator Relay',
      description: 'Complete the calculator mission.',
      language: 'python',
      gameRoomMissionStepId: 'step-2',
      missionTemplateStepId: 'template-step-2',
      stepOrder: 2,
      stepTitle: 'Compute result',
      stepDescription: 'Calculate the final answer.',
      projectStructure: {
        files: [
          expect.objectContaining({
            filePath: 'main.py',
            content: 'print("done")\n',
            fileUrl: 'data:text/plain;charset=utf-8,print(%22done%22)%0A',
          }),
        ],
      },
    });
  });

  it('finishes the room and emits mission-result when timeout reaches strike limit', async () => {
    const room = createRoom();
    room.maxStrikeCount = 1;
    const mission = createMission();
    mission.strikeCount = 0;
    const currentStep = createCurrentStep();
    const turn = createTurn();
    const participants = createParticipants();
    const snapshots: TurnSnapshotEntity[] = [];
    const turns = [turn];
    const manager = createManager({
      room,
      mission,
      currentStep,
      turns,
      participants,
      snapshots,
    });
    const dataSource = {
      transaction: jest.fn(async (callback: (manager: EntityManager) => unknown) =>
        callback(manager as unknown as EntityManager),
      ),
    } as unknown as DataSource;
    const gameRoomMissionsService: jest.Mocked<
      Pick<
        GameRoomMissionsService,
        'completeCurrentStep' | 'recordFailedAttempt' | 'transitionCurrentStepToInProgress'
      >
    > = {
      completeCurrentStep: jest.fn(),
      recordFailedAttempt: jest.fn().mockResolvedValue({
        mission: {
          ...mission,
          currentStepId: null,
          strikeCount: 1,
          finishedAt: new Date('2026-05-26T01:00:10.000Z'),
        },
        currentStep: {
          ...currentStep,
          status: GameRoomMissionStepStatus.FAILED,
        },
        strikeLimitReached: true,
        missionFinished: true,
      }),
      transitionCurrentStepToInProgress: jest.fn(),
    };
    const executionsService: jest.Mocked<Pick<ExecutionsService, 'executeTurnCode'>> = {
      executeTurnCode: jest.fn().mockResolvedValue({
        id: 'execution-1',
        status: ExecutionStatus.TIMEOUT,
        exitCode: null,
        stdout: '',
        stderr: 'timeout',
        runtimeFailureCode: null,
        runtimeFailureMessage: null,
      } as ExecutionEntity),
    };
    const missionResultsService: jest.Mocked<
      Pick<MissionResultsService, 'createMissionResult'>
    > = {
      createMissionResult: jest.fn().mockResolvedValue({} as never),
    };
    const service = new TurnsService(
      {
        get: jest.fn().mockReturnValue(10000),
      } as unknown as ConfigService,
      dataSource,
      gameRoomMissionsService as unknown as GameRoomMissionsService,
      executionsService as unknown as ExecutionsService,
      missionResultsService as unknown as MissionResultsService,
    );

    const result = await service.timeoutTurn({
      gameRoomId: room.id,
      turnId: turn.id,
      userId: turn.playerUserId,
      occurredAt: '2026-05-26T10:00:10+09:00',
      files: [
        {
          gameRoomId: room.id,
          turnId: turn.id,
          userId: turn.playerUserId,
          filePath: 'main.py',
          content: 'print("timeout")\n',
          occurredAt: '2026-05-26T10:00:00+09:00',
        },
      ],
    });

    expect(turn.status).toBe(TurnStatus.TIMEOUT);
    expect(gameRoomMissionsService.recordFailedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        strikeLimit: 1,
      }),
    );
    expect(missionResultsService.createMissionResult).toHaveBeenCalledWith(
      expect.objectContaining({
        judgeStatus: MissionResultJudgeStatus.FAILED,
      }),
    );
    expect(result.turnChangedEvent).toBeNull();
    expect(result.missionResultEvent).toMatchObject({
      gameRoomId: room.id,
      missionResult: expect.objectContaining({
        missionId: mission.id,
        judgeStatus: MissionResultJudgeStatus.FAILED,
        isMissionCleared: false,
      }),
    });
    expect(result.gameStateUpdatedEvent.gameState).toMatchObject({
      status: GameRoomStatus.FINISHED,
    });
    expect(manager.aiChatSessionRepository.update).toHaveBeenCalledWith(
      {
        gameRoomId: room.id,
        status: AiChatSessionStatus.ACTIVE,
      },
      expect.objectContaining({
        status: AiChatSessionStatus.CLOSED,
      }),
    );
    expect(manager.aiGameSessionRepository.update).toHaveBeenCalledWith(
      {
        gameRoomId: room.id,
        status: AiGameSessionStatus.ACTIVE,
      },
      expect.objectContaining({
        status: AiGameSessionStatus.CLOSED,
      }),
    );
  });

  it('rejects duplicate submit when the turn is no longer in progress', async () => {
    const room = createRoom();
    const mission = createMission();
    const currentStep = createCurrentStep();
    const turn = {
      ...createTurn(),
      status: TurnStatus.SUBMITTED,
    };
    const manager = createManager({
      room,
      mission,
      currentStep,
      turns: [turn],
      participants: createParticipants(),
      snapshots: [],
    });
    const dataSource = {
      transaction: jest.fn(async (callback: (manager: EntityManager) => unknown) =>
        callback(manager as unknown as EntityManager),
      ),
    } as unknown as DataSource;
    const service = new TurnsService(
      {
        get: jest.fn().mockReturnValue(10000),
      } as unknown as ConfigService,
      dataSource,
      {} as GameRoomMissionsService,
      {} as ExecutionsService,
      {} as MissionResultsService,
    );

    await expect(
      service.submitTurn({
        gameRoomId: room.id,
        turnId: turn.id,
        userId: turn.playerUserId,
        occurredAt: '2026-05-26T10:00:10+09:00',
        files: [],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects submit from a non-current turn player', async () => {
    const room = createRoom();
    const mission = createMission();
    const currentStep = createCurrentStep();
    const turn = createTurn();
    const manager = createManager({
      room,
      mission,
      currentStep,
      turns: [turn],
      participants: createParticipants(),
      snapshots: [],
    });
    const dataSource = {
      transaction: jest.fn(async (callback: (manager: EntityManager) => unknown) =>
        callback(manager as unknown as EntityManager),
      ),
    } as unknown as DataSource;
    const service = new TurnsService(
      {
        get: jest.fn().mockReturnValue(10000),
      } as unknown as ConfigService,
      dataSource,
      {} as GameRoomMissionsService,
      {} as ExecutionsService,
      {} as MissionResultsService,
    );

    await expect(
      service.submitTurn({
        gameRoomId: room.id,
        turnId: turn.id,
        userId: 'user-2',
        occurredAt: '2026-05-26T10:00:10+09:00',
        files: [],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('uses the same finish pipeline for timeout as manual submit', async () => {
    const room = createRoom();
    const mission = createMission();
    const currentStep = createCurrentStep();
    const turn = createTurn();
    const participants = createParticipants();
    const snapshots: TurnSnapshotEntity[] = [];
    const turns = [turn];
    const manager = createManager({
      room,
      mission,
      currentStep,
      turns,
      participants,
      snapshots,
    });
    const dataSource = {
      transaction: jest.fn(async (callback: (manager: EntityManager) => unknown) =>
        callback(manager as unknown as EntityManager),
      ),
    } as unknown as DataSource;
    const executionsService: jest.Mocked<Pick<ExecutionsService, 'executeTurnCode'>> = {
      executeTurnCode: jest.fn().mockResolvedValue({
        id: 'execution-timeout',
        status: ExecutionStatus.TIMEOUT,
        exitCode: null,
        stdout: '',
        stderr: 'timeout',
        runtimeFailureCode: null,
        runtimeFailureMessage: null,
      } as ExecutionEntity),
    };
    const gameRoomMissionsService: jest.Mocked<
      Pick<GameRoomMissionsService, 'recordFailedAttempt'>
    > = {
      recordFailedAttempt: jest.fn().mockResolvedValue({
        mission,
        currentStep,
        missionFinished: false,
      }),
    };
    const missionResultsService: jest.Mocked<
      Pick<MissionResultsService, 'createMissionResult'>
    > = {
      createMissionResult: jest.fn().mockResolvedValue({} as never),
    };
    const service = new TurnsService(
      {
        get: jest.fn().mockReturnValue(10000),
      } as unknown as ConfigService,
      dataSource,
      gameRoomMissionsService as unknown as GameRoomMissionsService,
      executionsService as unknown as ExecutionsService,
      missionResultsService as unknown as MissionResultsService,
    );

    const result = await service.timeoutTurn({
      gameRoomId: room.id,
      turnId: turn.id,
      userId: turn.playerUserId,
      occurredAt: '2026-05-26T10:00:10+09:00',
      files: [],
    });

    expect(turn.status).toBe(TurnStatus.TIMEOUT);
    expect(result.submitEvent.turnId).toBe(turn.id);
    expect(executionsService.executeTurnCode).toHaveBeenCalled();
    expect(missionResultsService.createMissionResult).toHaveBeenCalled();
  });

  it('creates the next turn on failed timeout when room progression continues', async () => {
    const room = createRoom();
    const mission = createMission();
    const currentStep = createCurrentStep();
    const turn = createTurn();
    const participants = createParticipants();
    const snapshots: TurnSnapshotEntity[] = [];
    const turns = [turn];
    const manager = createManager({
      room,
      mission,
      currentStep,
      turns,
      participants,
      snapshots,
    });
    const dataSource = {
      transaction: jest.fn(async (callback: (manager: EntityManager) => unknown) =>
        callback(manager as unknown as EntityManager),
      ),
    } as unknown as DataSource;
    const gameRoomMissionsService: jest.Mocked<
      Pick<
        GameRoomMissionsService,
        'completeCurrentStep' | 'recordFailedAttempt' | 'transitionCurrentStepToInProgress'
      >
    > = {
      completeCurrentStep: jest.fn(),
      recordFailedAttempt: jest.fn().mockResolvedValue({
        mission: {
          ...mission,
          strikeCount: 1,
        },
        currentStep,
        missionFinished: false,
      }),
      transitionCurrentStepToInProgress: jest.fn().mockResolvedValue(currentStep),
    };
    const executionsService: jest.Mocked<Pick<ExecutionsService, 'executeTurnCode'>> = {
      executeTurnCode: jest.fn().mockResolvedValue({
        id: 'execution-1',
        status: ExecutionStatus.FAILED,
        exitCode: 1,
        stdout: '',
        stderr: 'failed',
        runtimeFailureCode: null,
        runtimeFailureMessage: null,
      } as ExecutionEntity),
    };
    const missionResultsService: jest.Mocked<
      Pick<MissionResultsService, 'createMissionResult'>
    > = {
      createMissionResult: jest.fn().mockResolvedValue({} as never),
    };
    const service = new TurnsService(
      {
        get: jest.fn().mockReturnValue(10000),
      } as unknown as ConfigService,
      dataSource,
      gameRoomMissionsService as unknown as GameRoomMissionsService,
      executionsService as unknown as ExecutionsService,
      missionResultsService as unknown as MissionResultsService,
    );

    const result = await service.timeoutTurn({
      gameRoomId: room.id,
      turnId: turn.id,
      userId: turn.playerUserId,
      occurredAt: '2026-05-26T10:00:10+09:00',
      files: [
        {
          gameRoomId: room.id,
          turnId: turn.id,
          userId: turn.playerUserId,
          filePath: 'main.py',
          content: 'print("timeout")\n',
          occurredAt: '2026-05-26T10:00:00+09:00',
        },
      ],
    });

    expect(turn.status).toBe(TurnStatus.TIMEOUT);
    expect(turns).toHaveLength(2);
    expect(result.turnChangedEvent).not.toBeNull();
    expect(gameRoomMissionsService.recordFailedAttempt).toHaveBeenCalled();
    expect(missionResultsService.createMissionResult).toHaveBeenCalled();
  });

  it('suppresses next turn creation for disconnect-induced room termination', async () => {
    const room = createRoom();
    const mission = createMission();
    const currentStep = createCurrentStep();
    const turn = createTurn();
    const participants = createParticipants();
    const snapshots: TurnSnapshotEntity[] = [];
    const turns = [turn];
    const manager = createManager({
      room,
      mission,
      currentStep,
      turns,
      participants,
      snapshots,
    });
    const dataSource = {
      transaction: jest.fn(async (callback: (manager: EntityManager) => unknown) =>
        callback(manager as unknown as EntityManager),
      ),
    } as unknown as DataSource;
    const gameRoomMissionsService: jest.Mocked<
      Pick<
        GameRoomMissionsService,
        'completeCurrentStep' | 'recordFailedAttempt' | 'transitionCurrentStepToInProgress'
      >
    > = {
      completeCurrentStep: jest.fn(),
      recordFailedAttempt: jest.fn().mockResolvedValue({
        mission: {
          ...mission,
          strikeCount: 1,
        },
        currentStep,
        missionFinished: false,
      }),
      transitionCurrentStepToInProgress: jest.fn(),
    };
    const executionsService: jest.Mocked<Pick<ExecutionsService, 'executeTurnCode'>> = {
      executeTurnCode: jest.fn().mockResolvedValue({
        id: 'execution-1',
        status: ExecutionStatus.FAILED,
        exitCode: 1,
        stdout: '',
        stderr: 'failed',
        runtimeFailureCode: null,
        runtimeFailureMessage: null,
      } as ExecutionEntity),
    };
    const missionResultsService: jest.Mocked<
      Pick<MissionResultsService, 'createMissionResult'>
    > = {
      createMissionResult: jest.fn().mockResolvedValue({} as never),
    };
    const service = new TurnsService(
      {
        get: jest.fn().mockReturnValue(10000),
      } as unknown as ConfigService,
      dataSource,
      gameRoomMissionsService as unknown as GameRoomMissionsService,
      executionsService as unknown as ExecutionsService,
      missionResultsService as unknown as MissionResultsService,
    );

    const result = await service.timeoutTurn({
      gameRoomId: room.id,
      turnId: turn.id,
      userId: turn.playerUserId,
      occurredAt: '2026-05-26T10:00:10+09:00',
      files: [
        {
          gameRoomId: room.id,
          turnId: turn.id,
          userId: turn.playerUserId,
          filePath: 'main.py',
          content: 'print("timeout")\n',
          occurredAt: '2026-05-26T10:00:00+09:00',
        },
      ],
      suppressNextTurnCreation: true,
    });

    expect(turn.status).toBe(TurnStatus.TIMEOUT);
    expect(turns).toHaveLength(1);
    expect(result.turnChangedEvent).toBeNull();
    expect(gameRoomMissionsService.transitionCurrentStepToInProgress).not.toHaveBeenCalled();
    expect(gameRoomMissionsService.recordFailedAttempt).toHaveBeenCalled();
    expect(missionResultsService.createMissionResult).toHaveBeenCalled();
    expect(result.gameStateUpdatedEvent.gameState).toMatchObject({
      status: GameRoomStatus.FINISHED,
      turnState: null,
    });
  });

  it('keeps processing errors explicit without advancing to the next turn', async () => {
    const room = createRoom();
    const mission = createMission();
    const currentStep = createCurrentStep();
    const turn = createTurn();
    const participants = createParticipants();
    const snapshots: TurnSnapshotEntity[] = [];
    const turns = [turn];
    const manager = createManager({
      room,
      mission,
      currentStep,
      turns,
      participants,
      snapshots,
    });
    const dataSource = {
      transaction: jest.fn(async (callback: (manager: EntityManager) => unknown) =>
        callback(manager as unknown as EntityManager),
      ),
    } as unknown as DataSource;
    const gameRoomMissionsService: jest.Mocked<
      Pick<
        GameRoomMissionsService,
        'completeCurrentStep' | 'recordFailedAttempt' | 'transitionCurrentStepToInProgress'
      >
    > = {
      completeCurrentStep: jest.fn(),
      recordFailedAttempt: jest.fn(),
      transitionCurrentStepToInProgress: jest.fn(),
    };
    const executionsService: jest.Mocked<Pick<ExecutionsService, 'executeTurnCode'>> = {
      executeTurnCode: jest.fn().mockResolvedValue({
        id: 'execution-1',
        status: ExecutionStatus.FAILED,
        exitCode: null,
        stdout: '',
        stderr: '',
        runtimeFailureCode: 'RUNTIME_CONTAINER_UNAVAILABLE',
        runtimeFailureMessage: 'Mission runtime container is not available.',
      } as ExecutionEntity),
    };
    const missionResultsService: jest.Mocked<
      Pick<MissionResultsService, 'createMissionResult'>
    > = {
      createMissionResult: jest.fn().mockResolvedValue({} as never),
    };
    const service = new TurnsService(
      {
        get: jest.fn().mockReturnValue(10000),
      } as unknown as ConfigService,
      dataSource,
      gameRoomMissionsService as unknown as GameRoomMissionsService,
      executionsService as unknown as ExecutionsService,
      missionResultsService as unknown as MissionResultsService,
    );

    const result = await service.submitTurn({
      gameRoomId: room.id,
      turnId: turn.id,
      userId: turn.playerUserId,
      occurredAt: '2026-05-26T10:00:10+09:00',
      files: [
        {
          gameRoomId: room.id,
          turnId: turn.id,
          userId: turn.playerUserId,
          filePath: 'main.py',
          content: 'print("broken")\n',
          occurredAt: '2026-05-26T10:00:00+09:00',
        },
      ],
    });

    expect(gameRoomMissionsService.completeCurrentStep).not.toHaveBeenCalled();
    expect(gameRoomMissionsService.recordFailedAttempt).not.toHaveBeenCalled();
    expect(result.turnChangedEvent).toBeNull();
    expect(result.missionResultEvent).toBeNull();
    expect(result.gameStateUpdatedEvent.gameState).toMatchObject({
      status: GameRoomStatus.IN_PROGRESS,
      turnState: null,
    });
    expect(missionResultsService.createMissionResult).toHaveBeenCalledWith(
      expect.objectContaining({
        judgeStatus: MissionResultJudgeStatus.ERROR,
      }),
    );
  });

  it('judges calculator public cases for the current step and passes when all match', async () => {
    const room = createRoom();
    const mission = createCalculatorMission();
    const currentStep = createCurrentStep();
    const turn = createTurn();
    const participants = createParticipants();
    const snapshots: TurnSnapshotEntity[] = [];
    const turns = [turn];
    const manager = createManager({
      room,
      mission,
      currentStep,
      turns,
      participants,
      snapshots,
    });
    const dataSource = {
      transaction: jest.fn(async (callback: (manager: EntityManager) => unknown) =>
        callback(manager as unknown as EntityManager),
      ),
    } as unknown as DataSource;
    const gameRoomMissionsService: jest.Mocked<
      Pick<
        GameRoomMissionsService,
        'completeCurrentStep' | 'recordFailedAttempt' | 'transitionCurrentStepToInProgress'
      >
    > = {
      completeCurrentStep: jest.fn().mockResolvedValue({
        mission: {
          ...mission,
          currentStepId: 'step-2',
        },
        nextStep: {
          ...currentStep,
          id: 'step-2',
          stepOrder: 2,
        },
        missionFinished: false,
      }),
      recordFailedAttempt: jest.fn(),
      transitionCurrentStepToInProgress: jest.fn().mockResolvedValue(currentStep),
    };
    const executionsService: jest.Mocked<Pick<ExecutionsService, 'executeTurnCode'>> = {
      executeTurnCode: jest
        .fn()
        .mockResolvedValueOnce({
          id: 'execution-1',
          status: ExecutionStatus.SUCCESS,
          exitCode: 0,
          stdout: '5',
          stderr: '',
          runtimeFailureCode: null,
          runtimeFailureMessage: null,
        } as ExecutionEntity)
        .mockResolvedValueOnce({
          id: 'execution-2',
          status: ExecutionStatus.SUCCESS,
          exitCode: 0,
          stdout: '6',
          stderr: '',
          runtimeFailureCode: null,
          runtimeFailureMessage: null,
        } as ExecutionEntity),
    };
    const missionResultsService: jest.Mocked<
      Pick<MissionResultsService, 'createMissionResult'>
    > = {
      createMissionResult: jest.fn().mockResolvedValue({} as never),
    };
    const service = new TurnsService(
      {
        get: jest.fn().mockReturnValue(10000),
      } as unknown as ConfigService,
      dataSource,
      gameRoomMissionsService as unknown as GameRoomMissionsService,
      executionsService as unknown as ExecutionsService,
      missionResultsService as unknown as MissionResultsService,
    );

    await service.submitTurn({
      gameRoomId: room.id,
      turnId: turn.id,
      userId: turn.playerUserId,
      occurredAt: '2026-05-26T10:00:10+09:00',
      files: [
        {
          gameRoomId: room.id,
          turnId: turn.id,
          userId: turn.playerUserId,
          filePath: 'main.py',
          content: 'print("calculator")\n',
          occurredAt: '2026-05-26T10:00:00+09:00',
        },
      ],
    });

    expect(executionsService.executeTurnCode).toHaveBeenCalledTimes(2);
    expect(executionsService.executeTurnCode).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        stdinLines: ['2', '+', '3'],
        containerId: mission.containerId,
      }),
    );
    expect(executionsService.executeTurnCode).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        stdinLines: ['10', '+', '-4'],
      }),
    );
    expect(missionResultsService.createMissionResult).toHaveBeenCalledWith(
      expect.objectContaining({
        judgeStatus: MissionResultJudgeStatus.PASSED,
        resultPayloadJson: expect.objectContaining({
          publicCaseResults: expect.arrayContaining([
            expect.objectContaining({
              name: 'add_positive_integers',
              outcome: 'PASSED',
            }),
            expect.objectContaining({
              name: 'add_negative_integer',
              outcome: 'PASSED',
            }),
          ]),
        }),
      }),
    );
  });

  it('marks calculator step as failed when stdout does not match expectedStdout', async () => {
    const room = createRoom();
    const mission = createCalculatorMission();
    const currentStep = createCurrentStep();
    const turn = createTurn();
    const manager = createManager({
      room,
      mission,
      currentStep,
      turns: [turn],
      participants: createParticipants(),
      snapshots: [],
    });
    const dataSource = {
      transaction: jest.fn(async (callback: (manager: EntityManager) => unknown) =>
        callback(manager as unknown as EntityManager),
      ),
    } as unknown as DataSource;
    const gameRoomMissionsService: jest.Mocked<
      Pick<
        GameRoomMissionsService,
        'recordFailedAttempt' | 'transitionCurrentStepToInProgress'
      >
    > = {
      recordFailedAttempt: jest.fn().mockResolvedValue({
        mission: {
          ...mission,
          strikeCount: 1,
        },
        currentStep,
        missionFinished: false,
      }),
      transitionCurrentStepToInProgress: jest.fn().mockResolvedValue(currentStep),
    };
    const executionsService: jest.Mocked<Pick<ExecutionsService, 'executeTurnCode'>> = {
      executeTurnCode: jest.fn().mockResolvedValue({
        id: 'execution-1',
        status: ExecutionStatus.SUCCESS,
        exitCode: 0,
        stdout: '6',
        stderr: '',
        runtimeFailureCode: null,
        runtimeFailureMessage: null,
      } as ExecutionEntity),
    };
    const missionResultsService: jest.Mocked<
      Pick<MissionResultsService, 'createMissionResult'>
    > = {
      createMissionResult: jest.fn().mockResolvedValue({} as never),
    };
    const service = new TurnsService(
      {
        get: jest.fn().mockReturnValue(10000),
      } as unknown as ConfigService,
      dataSource,
      gameRoomMissionsService as unknown as GameRoomMissionsService,
      executionsService as unknown as ExecutionsService,
      missionResultsService as unknown as MissionResultsService,
    );

    const result = await service.submitTurn({
      gameRoomId: room.id,
      turnId: turn.id,
      userId: turn.playerUserId,
      occurredAt: '2026-05-26T10:00:10+09:00',
      files: [
        {
          gameRoomId: room.id,
          turnId: turn.id,
          userId: turn.playerUserId,
          filePath: 'main.py',
          content: 'print("wrong")\n',
          occurredAt: '2026-05-26T10:00:00+09:00',
        },
      ],
    });

    expect(executionsService.executeTurnCode).toHaveBeenCalledTimes(2);
    expect(gameRoomMissionsService.recordFailedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        gameRoomMissionId: mission.id,
        strikeLimit: room.maxStrikeCount,
      }),
    );
    expect(result.turnChangedEvent).not.toBeNull();
    expect(result.missionResultEvent).toBeNull();
    expect(missionResultsService.createMissionResult).toHaveBeenCalledWith(
      expect.objectContaining({
        judgeStatus: MissionResultJudgeStatus.FAILED,
        resultPayloadJson: expect.objectContaining({
          strikeCount: 1,
          stepOrder: 1,
          stepJudgingSummary: {
            totalCases: 2,
            passedCount: 1,
            failedCount: 1,
            errorCount: 0,
          },
          publicCaseResults: expect.arrayContaining([
            expect.objectContaining({
              name: 'add_positive_integers',
              expectedStdout: '5',
              actualStdout: '6',
              outcome: 'FAILED',
            }),
          ]),
          detectedIssues: [
            expect.objectContaining({
              issueType: 'PUBLIC_TEST_CASE_FAILED',
              caseName: 'add_positive_integers',
              message:
                '공개 테스트 "add_positive_integers" 실패: expected "5", actual "6"',
            }),
          ],
        }),
      }),
    );
  });

  it('finishes calculator mission and emits mission-result when strike limit is reached', async () => {
    const room = createRoom();
    room.maxStrikeCount = 1;
    const mission = createCalculatorMission();
    const currentStep = createCurrentStep();
    const turn = createTurn();
    const manager = createManager({
      room,
      mission,
      currentStep,
      turns: [turn],
      participants: createParticipants(),
      snapshots: [],
    });
    const dataSource = {
      transaction: jest.fn(async (callback: (manager: EntityManager) => unknown) =>
        callback(manager as unknown as EntityManager),
      ),
    } as unknown as DataSource;
    const gameRoomMissionsService: jest.Mocked<
      Pick<GameRoomMissionsService, 'recordFailedAttempt'>
    > = {
      recordFailedAttempt: jest.fn().mockResolvedValue({
        mission: {
          ...mission,
          strikeCount: 1,
          currentStepId: null,
          finishedAt: new Date('2026-05-26T01:00:10.000Z'),
        },
        currentStep: {
          ...currentStep,
          status: GameRoomMissionStepStatus.FAILED,
        },
        missionFinished: true,
      }),
    };
    const executionsService: jest.Mocked<Pick<ExecutionsService, 'executeTurnCode'>> = {
      executeTurnCode: jest.fn().mockResolvedValue({
        id: 'execution-1',
        status: ExecutionStatus.SUCCESS,
        exitCode: 0,
        stdout: 'wrong',
        stderr: '',
        runtimeFailureCode: null,
        runtimeFailureMessage: null,
      } as ExecutionEntity),
    };
    const missionResultsService: jest.Mocked<
      Pick<MissionResultsService, 'createMissionResult'>
    > = {
      createMissionResult: jest.fn().mockResolvedValue({} as never),
    };
    const service = new TurnsService(
      {
        get: jest.fn().mockReturnValue(10000),
      } as unknown as ConfigService,
      dataSource,
      gameRoomMissionsService as unknown as GameRoomMissionsService,
      executionsService as unknown as ExecutionsService,
      missionResultsService as unknown as MissionResultsService,
    );

    const result = await service.submitTurn({
      gameRoomId: room.id,
      turnId: turn.id,
      userId: turn.playerUserId,
      occurredAt: '2026-05-26T10:00:10+09:00',
      files: [
        {
          gameRoomId: room.id,
          turnId: turn.id,
          userId: turn.playerUserId,
          filePath: 'main.py',
          content: 'print("wrong")\n',
          occurredAt: '2026-05-26T10:00:00+09:00',
        },
      ],
    });

    expect(gameRoomMissionsService.recordFailedAttempt).toHaveBeenCalled();
    expect(result.turnChangedEvent).toBeNull();
    expect(result.missionResultEvent).toMatchObject({
      missionResult: expect.objectContaining({
        judgeStatus: MissionResultJudgeStatus.FAILED,
        strikeCount: 1,
        stepJudgingSummary: expect.objectContaining({
          failedCount: 2,
        }),
        isMissionCleared: false,
      }),
    });
    expect(result.gameStateUpdatedEvent.gameState).toMatchObject({
      status: GameRoomStatus.FINISHED,
    });
    expect(manager.aiChatSessionRepository.update).toHaveBeenCalledWith(
      {
        gameRoomId: room.id,
        status: AiChatSessionStatus.ACTIVE,
      },
      expect.objectContaining({
        status: AiChatSessionStatus.CLOSED,
      }),
    );
    expect(manager.aiGameSessionRepository.update).toHaveBeenCalledWith(
      {
        gameRoomId: room.id,
        status: AiGameSessionStatus.ACTIVE,
      },
      expect.objectContaining({
        status: AiGameSessionStatus.CLOSED,
      }),
    );
  });

  it('records runtime ERROR for calculator public cases without incrementing strike', async () => {
    const room = createRoom();
    const mission = createCalculatorMission();
    const currentStep = createCurrentStep();
    const turn = createTurn();
    const manager = createManager({
      room,
      mission,
      currentStep,
      turns: [turn],
      participants: createParticipants(),
      snapshots: [],
    });
    const dataSource = {
      transaction: jest.fn(async (callback: (manager: EntityManager) => unknown) =>
        callback(manager as unknown as EntityManager),
      ),
    } as unknown as DataSource;
    const gameRoomMissionsService: jest.Mocked<
      Pick<
        GameRoomMissionsService,
        'completeCurrentStep' | 'recordFailedAttempt' | 'transitionCurrentStepToInProgress'
      >
    > = {
      completeCurrentStep: jest.fn(),
      recordFailedAttempt: jest.fn(),
      transitionCurrentStepToInProgress: jest.fn(),
    };
    const executionsService: jest.Mocked<Pick<ExecutionsService, 'executeTurnCode'>> = {
      executeTurnCode: jest
        .fn()
        .mockResolvedValueOnce({
          id: 'execution-1',
          status: ExecutionStatus.FAILED,
          exitCode: null,
          stdout: '',
          stderr: '',
          runtimeFailureCode: 'RUNTIME_EXECUTION_FAILED',
          runtimeFailureMessage: 'Container exec failed.',
        } as ExecutionEntity)
        .mockResolvedValueOnce({
          id: 'execution-2',
          status: ExecutionStatus.SUCCESS,
          exitCode: 0,
          stdout: '6',
          stderr: '',
          runtimeFailureCode: null,
          runtimeFailureMessage: null,
        } as ExecutionEntity),
    };
    const missionResultsService: jest.Mocked<
      Pick<MissionResultsService, 'createMissionResult'>
    > = {
      createMissionResult: jest.fn().mockResolvedValue({} as never),
    };
    const service = new TurnsService(
      {
        get: jest.fn().mockReturnValue(10000),
      } as unknown as ConfigService,
      dataSource,
      gameRoomMissionsService as unknown as GameRoomMissionsService,
      executionsService as unknown as ExecutionsService,
      missionResultsService as unknown as MissionResultsService,
    );

    const result = await service.submitTurn({
      gameRoomId: room.id,
      turnId: turn.id,
      userId: turn.playerUserId,
      occurredAt: '2026-05-26T10:00:10+09:00',
      files: [
        {
          gameRoomId: room.id,
          turnId: turn.id,
          userId: turn.playerUserId,
          filePath: 'main.py',
          content: 'print("broken")\n',
          occurredAt: '2026-05-26T10:00:00+09:00',
        },
      ],
    });

    expect(gameRoomMissionsService.recordFailedAttempt).not.toHaveBeenCalled();
    expect(result.turnChangedEvent).toBeNull();
    expect(missionResultsService.createMissionResult).toHaveBeenCalledWith(
      expect.objectContaining({
        judgeStatus: MissionResultJudgeStatus.ERROR,
        resultPayloadJson: expect.objectContaining({
          stepJudgingSummary: {
            totalCases: 2,
            passedCount: 1,
            failedCount: 0,
            errorCount: 1,
          },
          detectedIssues: [
            expect.objectContaining({
              issueType: 'RUNTIME_ERROR',
              caseName: 'add_positive_integers',
              message: 'Container exec failed.',
            }),
          ],
        }),
      }),
    );
  });

  it('accepts divide-by-zero and invalid-number calculator contracts', async () => {
    const room = createRoom();
    const mission = createCalculatorMission({
      stepOrder: 6,
      testCases: [
        {
          name: 'division_by_zero',
          stdinLines: ['8', '/', '0'],
          expectedStdout: 'ERROR: division by zero',
        },
        {
          name: 'invalid_left_number',
          stdinLines: ['abc', '+', '3'],
          expectedStdout: 'ERROR: invalid number',
        },
      ],
    });
    const currentStep = {
      ...createCurrentStep(),
      stepOrder: 6,
    };
    const turn = createTurn();
    const manager = createManager({
      room,
      mission,
      currentStep,
      turns: [turn],
      participants: createParticipants(),
      snapshots: [],
    });
    const dataSource = {
      transaction: jest.fn(async (callback: (manager: EntityManager) => unknown) =>
        callback(manager as unknown as EntityManager),
      ),
    } as unknown as DataSource;
    const gameRoomMissionsService: jest.Mocked<
      Pick<
        GameRoomMissionsService,
        'completeCurrentStep' | 'transitionCurrentStepToInProgress'
      >
    > = {
      completeCurrentStep: jest.fn().mockResolvedValue({
        mission,
        nextStep: currentStep,
        missionFinished: false,
      }),
      transitionCurrentStepToInProgress: jest.fn().mockResolvedValue(currentStep),
    };
    const executionsService: jest.Mocked<Pick<ExecutionsService, 'executeTurnCode'>> = {
      executeTurnCode: jest
        .fn()
        .mockResolvedValueOnce({
          id: 'execution-div-zero',
          status: ExecutionStatus.SUCCESS,
          exitCode: 0,
          stdout: 'ERROR: division by zero',
          stderr: '',
          runtimeFailureCode: null,
          runtimeFailureMessage: null,
        } as ExecutionEntity)
        .mockResolvedValueOnce({
          id: 'execution-invalid-number',
          status: ExecutionStatus.SUCCESS,
          exitCode: 0,
          stdout: 'ERROR: invalid number',
          stderr: '',
          runtimeFailureCode: null,
          runtimeFailureMessage: null,
        } as ExecutionEntity),
    };
    const missionResultsService: jest.Mocked<
      Pick<MissionResultsService, 'createMissionResult'>
    > = {
      createMissionResult: jest.fn().mockResolvedValue({} as never),
    };
    const service = new TurnsService(
      {
        get: jest.fn().mockReturnValue(10000),
      } as unknown as ConfigService,
      dataSource,
      gameRoomMissionsService as unknown as GameRoomMissionsService,
      executionsService as unknown as ExecutionsService,
      missionResultsService as unknown as MissionResultsService,
    );

    await service.submitTurn({
      gameRoomId: room.id,
      turnId: turn.id,
      userId: turn.playerUserId,
      occurredAt: '2026-05-26T10:00:10+09:00',
      files: [
        {
          gameRoomId: room.id,
          turnId: turn.id,
          userId: turn.playerUserId,
          filePath: 'main.py',
          content: 'print("contracts")\n',
          occurredAt: '2026-05-26T10:00:00+09:00',
        },
      ],
    });

    expect(executionsService.executeTurnCode).toHaveBeenCalledTimes(2);
    expect(missionResultsService.createMissionResult).toHaveBeenCalledWith(
      expect.objectContaining({
        judgeStatus: MissionResultJudgeStatus.PASSED,
        resultPayloadJson: expect.objectContaining({
          publicCaseResults: [
            expect.objectContaining({
              name: 'division_by_zero',
              outcome: 'PASSED',
            }),
            expect.objectContaining({
              name: 'invalid_left_number',
              outcome: 'PASSED',
            }),
          ],
        }),
      }),
    );
  });

  it('accepts calculator error strings for unsupported operators', async () => {
    const room = createRoom();
    const mission = createCalculatorMission({
      stepOrder: 5,
      testCases: [
        {
          name: 'unsupported_operator',
          stdinLines: ['8', '%', '3'],
          expectedStdout: 'ERROR: unsupported operator',
        },
      ],
    });
    const currentStep = {
      ...createCurrentStep(),
      stepOrder: 5,
    };
    const turn = createTurn();
    const manager = createManager({
      room,
      mission,
      currentStep,
      turns: [turn],
      participants: createParticipants(),
      snapshots: [],
    });
    const dataSource = {
      transaction: jest.fn(async (callback: (manager: EntityManager) => unknown) =>
        callback(manager as unknown as EntityManager),
      ),
    } as unknown as DataSource;
    const gameRoomMissionsService: jest.Mocked<
      Pick<
        GameRoomMissionsService,
        'completeCurrentStep' | 'transitionCurrentStepToInProgress'
      >
    > = {
      completeCurrentStep: jest.fn().mockResolvedValue({
        mission,
        nextStep: currentStep,
        missionFinished: false,
      }),
      transitionCurrentStepToInProgress: jest.fn().mockResolvedValue(currentStep),
    };
    const executionsService: jest.Mocked<Pick<ExecutionsService, 'executeTurnCode'>> = {
      executeTurnCode: jest.fn().mockResolvedValue({
        id: 'execution-1',
        status: ExecutionStatus.SUCCESS,
        exitCode: 0,
        stdout: 'ERROR: unsupported operator',
        stderr: '',
        runtimeFailureCode: null,
        runtimeFailureMessage: null,
      } as ExecutionEntity),
    };
    const missionResultsService: jest.Mocked<
      Pick<MissionResultsService, 'createMissionResult'>
    > = {
      createMissionResult: jest.fn().mockResolvedValue({} as never),
    };
    const service = new TurnsService(
      {
        get: jest.fn().mockReturnValue(10000),
      } as unknown as ConfigService,
      dataSource,
      gameRoomMissionsService as unknown as GameRoomMissionsService,
      executionsService as unknown as ExecutionsService,
      missionResultsService as unknown as MissionResultsService,
    );

    await service.submitTurn({
      gameRoomId: room.id,
      turnId: turn.id,
      userId: turn.playerUserId,
      occurredAt: '2026-05-26T10:00:10+09:00',
      files: [
        {
          gameRoomId: room.id,
          turnId: turn.id,
          userId: turn.playerUserId,
          filePath: 'main.py',
          content: 'print("operator")\n',
          occurredAt: '2026-05-26T10:00:00+09:00',
        },
      ],
    });

    expect(missionResultsService.createMissionResult).toHaveBeenCalledWith(
      expect.objectContaining({
        judgeStatus: MissionResultJudgeStatus.PASSED,
        resultPayloadJson: expect.objectContaining({
          feedbackMessage: expect.any(String),
          detectedIssues: [],
          strikeCount: 0,
          remainingStrikeCount: room.maxStrikeCount,
          executionSummary: expect.objectContaining({
            status: ExecutionStatus.SUCCESS,
            exitCode: 0,
          }),
        }),
      }),
    );
  });
});

function createRoom(): GameRoomEntity {
  return {
    id: 'room-1',
    ownerUserId: 'user-1',
    status: GameRoomStatus.IN_PROGRESS,
    difficulty: 'EASY',
    timeLimitSeconds: 30,
    maxStrikeCount: 3,
    minParticipants: 2,
    maxParticipants: 4,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as GameRoomEntity;
}

function createCalculatorMission(input?: {
  stepOrder?: number;
  testCases?: Array<{
    name: string;
    stdinLines: string[];
    expectedStdout: string;
  }>;
}): GameRoomMissionEntity {
  const stepOrder = input?.stepOrder ?? 1;
  const testCases =
    input?.testCases ??
    (stepOrder === 1
      ? [
          {
            name: 'add_positive_integers',
            stdinLines: ['2', '+', '3'],
            expectedStdout: '5',
          },
          {
            name: 'add_negative_integer',
            stdinLines: ['10', '+', '-4'],
            expectedStdout: '6',
          },
        ]
      : []);

  return {
    ...createMission(),
    containerId: 'container-1',
    judgePolicyJson: {
      judgeType: 'PUBLIC_TEST_CASES',
      command: 'python /workspace/main.py',
      steps: [
        {
          stepOrder,
          testCases,
        },
      ],
    },
  } as unknown as GameRoomMissionEntity;
}

function createMission(): GameRoomMissionEntity {
  return {
    id: 'mission-1',
    gameRoomId: 'room-1',
    missionTemplateId: 'template-1',
    currentStepId: 'step-1',
    containerId: null,
    strikeCount: 0,
    judgePolicyJson: {
      command: 'python /workspace/main.py',
    },
    projectStructureJson: {
      rootPath: '/workspace',
      entryFilePath: 'main.py',
      files: [
        {
          filePath: 'main.py',
          language: 'python',
        },
      ],
    },
    startedAt: new Date(),
    finishedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as GameRoomMissionEntity;
}

function createCurrentStep(): GameRoomMissionStepEntity {
  return {
    id: 'step-1',
    gameRoomMissionId: 'mission-1',
    missionTemplateStepId: 'template-step-1',
    stepOrder: 1,
    status: GameRoomMissionStepStatus.IN_PROGRESS,
    missionTemplateStep: {
      id: 'template-step-1',
      missionTemplateId: 'template-1',
      stepOrder: 1,
      title: 'Parse stdin',
      description: 'Read the three input lines.',
      targetFilePath: 'main.py',
      successCriteria: 'Print the expected calculator result.',
      judgePolicyJson: {},
      hintText: 'hint',
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  } as GameRoomMissionStepEntity;
}

function createTurn(): TurnEntity {
  return {
    id: 'turn-1',
    gameRoomId: 'room-1',
    missionId: 'mission-1',
    playerUserId: 'user-1',
    turnNumber: 1,
    status: TurnStatus.IN_PROGRESS,
    startedAt: new Date('2026-05-26T01:00:00.000Z'),
    deadlineAt: new Date('2026-05-26T01:00:30.000Z'),
    endedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as TurnEntity;
}

function createParticipants(): GameRoomParticipantEntity[] {
  return [
    {
      id: 'participant-1',
      gameRoomId: 'room-1',
      userId: 'user-1',
      membershipStatus: GameRoomParticipantMembershipStatus.JOINED,
      createdAt: new Date('2026-05-26T00:59:00.000Z'),
    },
    {
      id: 'participant-2',
      gameRoomId: 'room-1',
      userId: 'user-2',
      membershipStatus: GameRoomParticipantMembershipStatus.JOINED,
      createdAt: new Date('2026-05-26T00:59:10.000Z'),
    },
  ] as GameRoomParticipantEntity[];
}

function createManager(input: {
  room: GameRoomEntity;
  mission: GameRoomMissionEntity;
  currentStep: GameRoomMissionStepEntity;
  turns: TurnEntity[];
  participants: GameRoomParticipantEntity[];
  snapshots: TurnSnapshotEntity[];
}) {
  const missionSteps = Array.isArray(input.mission.steps) && input.mission.steps.length > 0
    ? input.mission.steps
    : [input.currentStep];
  const aiChatSessionRepository = {
    update: jest.fn(),
  };
  const aiGameSessionRepository = {
    update: jest.fn(),
  };

  return {
    aiChatSessionRepository,
    aiGameSessionRepository,
    query: jest.fn(),
    getRepository: jest.fn((entity) => {
      if (entity === GameRoomEntity) {
        return {
          findOne: jest.fn(async ({ where }) =>
            where.id === input.room.id ? input.room : null,
          ),
          save: jest.fn(async (value) => Object.assign(input.room, value)),
        };
      }

      if (entity === GameRoomMissionEntity) {
        return {
          findOne: jest.fn(async ({ where }) =>
            where.id === input.mission.id ? input.mission : null,
          ),
          save: jest.fn(async (value) => Object.assign(input.mission, value)),
        };
      }

      if (entity === GameRoomMissionStepEntity) {
        return {
          findOne: jest.fn(async ({ where }) =>
            missionSteps.find((step) => step.id === where.id) ?? null,
          ),
          save: jest.fn(async (value) => {
            const existing = missionSteps.find((step) => step.id === value.id);

            if (existing) {
              Object.assign(existing, value);
              return existing;
            }

            missionSteps.push(value);
            return value;
          }),
        };
      }

      if (entity === TurnEntity) {
        return {
          findOne: jest.fn(async ({ where }) =>
            input.turns.find(
              (turn) => turn.id === where.id && turn.gameRoomId === where.gameRoomId,
            ) ?? null,
          ),
          create: jest.fn((value) => value),
          save: jest.fn(async (value) => {
            const existing = input.turns.find((turn) => turn.id === value.id);

            if (existing) {
              Object.assign(existing, value);
              return existing;
            }

            const createdTurn = {
              ...value,
              id: `turn-${input.turns.length + 1}`,
              createdAt: new Date(),
              updatedAt: new Date(),
            } as TurnEntity;
            input.turns.push(createdTurn);
            return createdTurn;
          }),
        };
      }

      if (entity === TurnSnapshotEntity) {
        return {
          create: jest.fn((value) => value),
          save: jest.fn(async (value) => {
            const snapshot = {
              ...value,
              id: `snapshot-${input.snapshots.length + 1}`,
              createdAt: new Date(),
              updatedAt: new Date(),
            } as TurnSnapshotEntity;
            input.snapshots.push(snapshot);
            return snapshot;
          }),
        };
      }

      if (entity === AiChatSession) {
        return aiChatSessionRepository;
      }

      if (entity === AiGameSession) {
        return aiGameSessionRepository;
      }

      return {
        find: jest.fn(async () => input.participants),
      };
    }),
  };
}
