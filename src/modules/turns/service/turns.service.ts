import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { toSeoulIso } from '@common/utils/date.util';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { ExecutionsService } from '@modules/executions/service/executions.service';
import { ExecutionEntity } from '@modules/executions/entity/execution.entity';
import { AiChatSession } from '@modules/ai-chat-sessions/entity/ai-chat-session.entity';
import { GameRoomMissionStepEntity } from '@modules/game-room-missions/entity/game-room-mission-step.entity';
import { GameRoomMissionEntity } from '@modules/game-room-missions/entity/game-room-mission.entity';
import { GameRoomMissionsService } from '@modules/game-room-missions/service/game-room-missions.service';
import { GameRoomParticipantEntity } from '@modules/game-room-participants/entity/game-room-participant.entity';
import { GameRoomEntity } from '@modules/game-rooms/entity/game-room.entity';
import { buildTurnEvaluationResultPayload } from '@modules/mission-results/build-turn-evaluation-result-payload';
import { MissionResultsService } from '@modules/mission-results/service/mission-results.service';
import {
  AiChatSessionStatus,
  ExecutionStatus,
  GameRoomMissionStepStatus,
  GameRoomParticipantMembershipStatus,
  GameRoomStatus,
  MissionResultJudgeStatus,
  TurnStatus,
} from '@shared/enums';
import type {
  GameStateUpdatedEvent,
  MissionResultEvent,
  RealtimeFileContentBuffer,
  RealtimeEvaluationResult,
  RealtimeMissionState,
  RealtimeMissionStepSummary,
  RealtimeProjectStructure,
  RealtimeTurnState,
  TurnChangedEvent,
  TurnEvaluatedEvent,
  TurnSubmitEvent,
} from '@modules/realtime/service/realtime.interfaces';
import {
  resolveStepPublicTestCases,
  runStepPublicCaseJudging,
  type PublicTestCaseJudgeDetail,
} from '../judge/step-public-case-judge';
import { TurnSnapshotEntity } from '../entity/turn-snapshot.entity';
import { TurnEntity } from '../entity/turn.entity';

export interface CreateInitialTurnInput {
  manager: EntityManager;
  gameRoomId: string;
  missionId: string;
  timeLimitSeconds: number;
}

export interface SubmitTurnLifecycleInput {
  gameRoomId: string;
  turnId: string;
  userId: string;
  occurredAt: string;
  files: RealtimeFileContentBuffer[];
  /**
   * When true, closes the current turn but never creates the next turn.
   * Used when disconnect will terminate the room for insufficient participants.
   */
  suppressNextTurnCreation?: boolean;
}

export interface TimeoutTurnLifecycleInput extends SubmitTurnLifecycleInput {}

export interface TurnLifecycleResult {
  submitEvent: TurnSubmitEvent;
  evaluatedEvent: TurnEvaluatedEvent;
  gameStateUpdatedEvent: GameStateUpdatedEvent;
  turnChangedEvent: TurnChangedEvent | null;
  missionResultEvent: MissionResultEvent | null;
}

interface PreparedTurnEndState {
  room: GameRoomEntity;
  mission: GameRoomMissionEntity;
  currentStep: GameRoomMissionStepEntity;
  turn: TurnEntity;
  snapshot: TurnSnapshotEntity;
  occurredAt: Date;
  suppressNextTurnCreation: boolean;
}

interface SnapshotFile {
  filePath: string;
  content: string;
  occurredAt?: string;
}

interface SnapshotExecutionOutcome {
  execution: ExecutionEntity;
  judgeStatus: MissionResultJudgeStatus;
  publicCaseResults: PublicTestCaseJudgeDetail[] | null;
}

@Injectable()
export class TurnsService {
  constructor(
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
    private readonly gameRoomMissionsService: GameRoomMissionsService,
    private readonly executionsService: ExecutionsService,
    private readonly missionResultsService: MissionResultsService,
  ) {}

  async createInitialTurn(input: CreateInitialTurnInput): Promise<TurnEntity> {
    const participantRepository = input.manager.getRepository(
      GameRoomParticipantEntity,
    );
    const turnRepository = input.manager.getRepository(TurnEntity);
    const joinedParticipants = await participantRepository.find({
      where: {
        gameRoomId: input.gameRoomId,
        membershipStatus: GameRoomParticipantMembershipStatus.JOINED,
      },
      order: {
        createdAt: 'ASC',
      },
    });

    if (joinedParticipants.length === 0) {
      throw new ConflictException({
        code: 'TURN_PLAYER_REQUIRED',
        message: 'At least one joined participant is required to start a turn.',
      });
    }

    const startedAt = new Date();
    const firstTurn = turnRepository.create({
      gameRoomId: input.gameRoomId,
      missionId: input.missionId,
      playerUserId: joinedParticipants[0].userId,
      turnNumber: 1,
      status: TurnStatus.IN_PROGRESS,
      startedAt,
      deadlineAt: new Date(startedAt.getTime() + input.timeLimitSeconds * 1000),
      endedAt: null,
    });

    return turnRepository.save(firstTurn);
  }

  async submitTurn(input: SubmitTurnLifecycleInput): Promise<TurnLifecycleResult> {
    return this.finishTurn({
      ...input,
      trigger: TurnStatus.SUBMITTED,
    });
  }

  async timeoutTurn(input: TimeoutTurnLifecycleInput): Promise<TurnLifecycleResult> {
    return this.finishTurn({
      ...input,
      trigger: TurnStatus.TIMEOUT,
    });
  }

  private async finishTurn(input: SubmitTurnLifecycleInput & {
    trigger: TurnStatus.SUBMITTED | TurnStatus.TIMEOUT;
  }): Promise<TurnLifecycleResult> {
    const preparedState = await this.prepareTurnEndState(input);
    const executionOutcome = await this.executeSnapshot(preparedState);

    return this.applyExecutionOutcome({
      preparedState,
      executionOutcome,
      submittedStatus: input.trigger,
    });
  }

  private async prepareTurnEndState(
    input: SubmitTurnLifecycleInput & {
      trigger: TurnStatus.SUBMITTED | TurnStatus.TIMEOUT;
    },
  ): Promise<PreparedTurnEndState> {
    return this.dataSource.transaction(async (manager) => {
      await this.acquireTurnLifecycleLock(manager, input.turnId);

      const turnRepository = manager.getRepository(TurnEntity);
      const snapshotRepository = manager.getRepository(TurnSnapshotEntity);
      const roomRepository = manager.getRepository(GameRoomEntity);
      const missionRepository = manager.getRepository(GameRoomMissionEntity);
      const currentStepRepository = manager.getRepository(GameRoomMissionStepEntity);

      const turn = await this.getTurnOrThrow(turnRepository, input.turnId, input.gameRoomId);

      if (turn.playerUserId !== input.userId) {
        throw new ForbiddenException({
          code: 'TURN_PLAYER_REQUIRED',
          message: 'Only the current turn player can finish this turn.',
        });
      }

      if (turn.status !== TurnStatus.IN_PROGRESS) {
        throw new ConflictException({
          code: 'TURN_NOT_IN_PROGRESS',
          message: 'Only an in-progress turn can be finished.',
        });
      }

      const room = await this.getRoomOrThrow(roomRepository, input.gameRoomId);
      const mission = await this.getMissionOrThrow(missionRepository, turn.missionId);
      const currentStep = await this.getCurrentStepOrThrow(
        currentStepRepository,
        mission,
      );
      const occurredAt = new Date();

      const snapshot = snapshotRepository.create({
        gameRoomId: input.gameRoomId,
        turnId: turn.id,
        userId: input.userId,
        codeSnapshotJson: {
          files: input.files.map((file) => ({
            filePath: file.filePath,
            content: file.content,
            occurredAt: file.occurredAt,
          })),
        },
      });
      const savedSnapshot = await snapshotRepository.save(snapshot);

      turn.status = input.trigger;
      turn.endedAt = occurredAt;
      await turnRepository.save(turn);

      return {
        room,
        mission,
        currentStep,
        turn,
        snapshot: savedSnapshot,
        occurredAt,
        suppressNextTurnCreation: input.suppressNextTurnCreation ?? false,
      };
    });
  }

  private async executeSnapshot(
    preparedState: PreparedTurnEndState,
  ): Promise<SnapshotExecutionOutcome> {
    const projectStructure = asRecord(preparedState.mission.projectStructureJson);
    const judgePolicy = asRecord(preparedState.mission.judgePolicyJson);
    const snapshotFiles = preparedState.snapshot.codeSnapshotJson.files;
    const selectedFile =
      findSnapshotFile(snapshotFiles, preparedState.currentStep.missionTemplateStep.targetFilePath) ??
      findSnapshotFile(snapshotFiles, asString(projectStructure.entryFilePath)) ??
      snapshotFiles[0];

    const runtimeFilePath = normalizeRuntimeFilePath(
      selectedFile?.filePath ?? preparedState.currentStep.missionTemplateStep.targetFilePath,
      asString(projectStructure.rootPath) ?? '/workspace',
    );
    const runtimeCommand = resolveRuntimeCommand({
      judgePolicy,
      projectStructure,
      targetFilePath: runtimeFilePath,
      fallbackLanguage:
        inferLanguageFromProjectStructure(projectStructure) ??
        inferLanguageFromPath(runtimeFilePath),
    });
    const executionInput = {
      gameRoomId: preparedState.room.id,
      missionId: preparedState.mission.id,
      turnId: preparedState.turn.id,
      userId: preparedState.turn.playerUserId,
      containerId: preparedState.mission.containerId,
      command: runtimeCommand,
      filePath: runtimeFilePath,
      content: selectedFile?.content ?? '',
      timeoutMs:
        this.configService.get<number>('runtime.executionTimeoutMs') ?? undefined,
    };
    const publicTestCases = resolveStepPublicTestCases(
      judgePolicy,
      preparedState.currentStep.stepOrder,
    );

    if (publicTestCases === null) {
      const execution = await this.executionsService.executeTurnCode(executionInput);

      return {
        execution,
        judgeStatus: determineJudgeStatus(execution),
        publicCaseResults: null,
      };
    }

    const judgedOutcome = await runStepPublicCaseJudging(publicTestCases, (testCase) =>
      this.executionsService.executeTurnCode({
        ...executionInput,
        stdinLines: testCase.stdinLines,
      }),
    );

    return {
      execution: judgedOutcome.representativeExecution,
      judgeStatus: judgedOutcome.judgeStatus,
      publicCaseResults: judgedOutcome.caseResults,
    };
  }

  private async applyExecutionOutcome(input: {
    preparedState: PreparedTurnEndState;
    executionOutcome: SnapshotExecutionOutcome;
    submittedStatus: TurnStatus.SUBMITTED | TurnStatus.TIMEOUT;
  }): Promise<TurnLifecycleResult> {
    return this.dataSource.transaction(async (manager) => {
      await this.acquireTurnLifecycleLock(manager, input.preparedState.turn.id);

      const roomRepository = manager.getRepository(GameRoomEntity);
      const missionRepository = manager.getRepository(GameRoomMissionEntity);
      const turnRepository = manager.getRepository(TurnEntity);
      const currentStepRepository = manager.getRepository(GameRoomMissionStepEntity);

      const room = await this.getRoomOrThrow(roomRepository, input.preparedState.room.id);
      const mission = await this.getMissionOrThrow(
        missionRepository,
        input.preparedState.mission.id,
      );
      const turn = await this.getTurnOrThrow(
        turnRepository,
        input.preparedState.turn.id,
        input.preparedState.room.id,
      );
      const currentStep = await this.getCurrentStepOrThrow(
        currentStepRepository,
        mission,
      );

      const nextState = await this.resolveNextState({
        manager,
        room,
        mission,
        currentStep,
        turn,
        execution: input.executionOutcome.execution,
        judgeStatus: input.executionOutcome.judgeStatus,
        publicCaseResults: input.executionOutcome.publicCaseResults,
        snapshot: input.preparedState.snapshot,
        occurredAt: input.preparedState.occurredAt,
        suppressNextTurnCreation: input.preparedState.suppressNextTurnCreation,
      });
      const hydratedMission = await this.getMissionOrThrow(
        missionRepository,
        nextState.mission.id,
      );

      return buildLifecycleEvents({
        room: nextState.room,
        mission: hydratedMission,
        currentStep: nextState.currentStep,
        evaluatedTurn: turn,
        execution: input.executionOutcome.execution,
        missionResultPayload: nextState.missionResultPayload,
        judgeStatus: nextState.judgeStatus,
        occurredAt: input.preparedState.occurredAt,
        nextTurn: nextState.nextTurn,
        snapshotId: input.preparedState.snapshot.id,
        snapshotFiles: input.preparedState.snapshot.codeSnapshotJson.files,
        submittedStatus: input.submittedStatus,
        missionFinished: nextState.missionFinished,
        suppressNextTurnCreation: input.preparedState.suppressNextTurnCreation,
      });
    });
  }

  private async resolveNextState(input: {
    manager: EntityManager;
    room: GameRoomEntity;
    mission: GameRoomMissionEntity;
    currentStep: GameRoomMissionStepEntity;
    turn: TurnEntity;
    execution: ExecutionEntity;
    judgeStatus: MissionResultJudgeStatus;
    publicCaseResults: PublicTestCaseJudgeDetail[] | null;
    snapshot: TurnSnapshotEntity;
    occurredAt: Date;
    suppressNextTurnCreation: boolean;
  }): Promise<{
    room: GameRoomEntity;
    mission: GameRoomMissionEntity;
    currentStep: GameRoomMissionStepEntity | null;
    nextTurn: TurnEntity | null;
    missionResultPayload: RealtimeEvaluationResult;
    judgeStatus: MissionResultJudgeStatus;
    missionFinished: boolean;
  }> {
    const roomRepository = input.manager.getRepository(GameRoomEntity);
    const missionRepository = input.manager.getRepository(GameRoomMissionEntity);

    const judgeStatus = input.judgeStatus;
    const judgedStep = input.currentStep;
    let room = input.room;
    let mission = input.mission;
    let currentStep: GameRoomMissionStepEntity | null = input.currentStep;
    let nextTurn: TurnEntity | null = null;
    let missionFinished = false;
    let strikeCount = mission.strikeCount;

    if (judgeStatus === MissionResultJudgeStatus.PASSED) {
      const completed =
        await this.gameRoomMissionsService.completeCurrentStep({
          manager: input.manager,
          gameRoomMissionId: mission.id,
        });
      mission = completed.mission;
      currentStep = completed.nextStep;
      missionFinished = completed.missionFinished;
      strikeCount = mission.strikeCount;

      if (!missionFinished && currentStep && !input.suppressNextTurnCreation) {
        currentStep =
          await this.gameRoomMissionsService.transitionCurrentStepToInProgress({
            manager: input.manager,
            gameRoomMissionId: mission.id,
          });
        nextTurn = await this.createNextTurn(input.manager, room, mission, input.turn);
      } else if (missionFinished) {
        room.status = GameRoomStatus.FINISHED;
        await this.closeActiveAiChatSessionsForRoom(input.manager, room.id, input.occurredAt);
        room = await roomRepository.save(room);
      }
    } else if (judgeStatus === MissionResultJudgeStatus.FAILED) {
      const failedAttempt = await this.gameRoomMissionsService.recordFailedAttempt({
        manager: input.manager,
        gameRoomMissionId: mission.id,
        strikeLimit: room.maxStrikeCount,
      });
      mission = failedAttempt.mission;
      currentStep = failedAttempt.currentStep;
      missionFinished = failedAttempt.missionFinished;
      strikeCount = mission.strikeCount;

      if (!missionFinished && !input.suppressNextTurnCreation) {
        if (currentStep.status === GameRoomMissionStepStatus.READY) {
          currentStep =
            await this.gameRoomMissionsService.transitionCurrentStepToInProgress({
              manager: input.manager,
              gameRoomMissionId: mission.id,
            });
        }
        nextTurn = await this.createNextTurn(input.manager, room, mission, input.turn);
      } else if (missionFinished) {
        room.status = GameRoomStatus.FINISHED;
        await this.closeActiveAiChatSessionsForRoom(input.manager, room.id, input.occurredAt);
        room = await roomRepository.save(room);
      }
    } else {
      strikeCount = mission.strikeCount;
    }

    const missionResultPayload = buildTurnEvaluationResultPayload({
      judgeStatus,
      execution: input.execution,
      publicCaseResults: input.publicCaseResults,
      room,
      mission,
      turn: input.turn,
      currentStep: judgedStep,
      strikeCount,
      missionFinished,
    });

    await this.missionResultsService.createMissionResult({
      manager: input.manager,
      gameRoomId: room.id,
      missionId: mission.id,
      turnId: input.turn.id,
      judgeStatus,
      resultPayloadJson: missionResultPayload,
      occurredAt: input.occurredAt,
    });

    return {
      room: room.status === GameRoomStatus.FINISHED ? room : await roomRepository.save(room),
      mission: await missionRepository.save(mission),
      currentStep,
      nextTurn,
      missionResultPayload,
      judgeStatus,
      missionFinished,
    };
  }

  private async createNextTurn(
    manager: EntityManager,
    room: GameRoomEntity,
    mission: GameRoomMissionEntity,
    previousTurn: TurnEntity,
  ): Promise<TurnEntity> {
    const participantRepository = manager.getRepository(GameRoomParticipantEntity);
    const turnRepository = manager.getRepository(TurnEntity);
    const joinedParticipants = await participantRepository.find({
      where: {
        gameRoomId: room.id,
        membershipStatus: GameRoomParticipantMembershipStatus.JOINED,
      },
      order: {
        createdAt: 'ASC',
      },
    });

    if (joinedParticipants.length === 0) {
      throw new ConflictException({
        code: 'TURN_PLAYER_REQUIRED',
        message: 'No joined participant is available for the next turn.',
      });
    }

    const nextPlayerUserId = resolveNextPlayerUserId(
      joinedParticipants.map((participant) => participant.userId),
      previousTurn.playerUserId,
    );
    const startedAt = previousTurn.endedAt ?? new Date();
    const nextTurn = turnRepository.create({
      gameRoomId: room.id,
      missionId: mission.id,
      playerUserId: nextPlayerUserId,
      turnNumber: previousTurn.turnNumber + 1,
      status: TurnStatus.IN_PROGRESS,
      startedAt,
      deadlineAt: new Date(startedAt.getTime() + room.timeLimitSeconds * 1000),
      endedAt: null,
    });

    return turnRepository.save(nextTurn);
  }

  private async closeActiveAiChatSessionsForRoom(
    manager: EntityManager,
    gameRoomId: string,
    occurredAt: Date,
  ): Promise<void> {
    await manager.getRepository(AiChatSession).update(
      {
        gameRoomId,
        status: AiChatSessionStatus.ACTIVE,
      },
      {
        status: AiChatSessionStatus.CLOSED,
        closedAt: occurredAt,
      },
    );
  }

  private async acquireTurnLifecycleLock(
    manager: EntityManager,
    turnId: string,
  ): Promise<void> {
    await manager.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 2))',
      [turnId],
    );
  }

  private async getTurnOrThrow(
    repository: Repository<TurnEntity>,
    turnId: string,
    gameRoomId: string,
  ): Promise<TurnEntity> {
    const turn = await repository.findOne({
      where: {
        id: turnId,
        gameRoomId,
      },
    });

    if (!turn) {
      throw new NotFoundException({
        code: 'TURN_NOT_FOUND',
        message: 'Turn was not found.',
      });
    }

    return turn;
  }

  private async getRoomOrThrow(
    repository: Repository<GameRoomEntity>,
    gameRoomId: string,
  ): Promise<GameRoomEntity> {
    const room = await repository.findOne({
      where: { id: gameRoomId },
    });

    if (!room) {
      throw new NotFoundException({
        code: 'GAME_ROOM_NOT_FOUND',
        message: 'Game room was not found.',
      });
    }

    return room;
  }

  private async getMissionOrThrow(
    repository: Repository<GameRoomMissionEntity>,
    missionId: string,
  ): Promise<GameRoomMissionEntity> {
    const mission = await repository.findOne({
      relations: { missionTemplate: true, steps: { missionTemplateStep: true } },
      where: { id: missionId },
    });

    if (!mission) {
      throw new NotFoundException({
        code: 'GAME_ROOM_MISSION_NOT_FOUND',
        message: 'Game room mission was not found.',
      });
    }

    return mission;
  }

  private async getCurrentStepOrThrow(
    repository: Repository<GameRoomMissionStepEntity>,
    mission: GameRoomMissionEntity,
  ): Promise<GameRoomMissionStepEntity> {
    if (!mission.currentStepId) {
      throw new ConflictException({
        code: 'CURRENT_MISSION_STEP_UNAVAILABLE',
        message: 'Current mission step is not available.',
      });
    }

    const currentStep = await repository.findOne({
      relations: { missionTemplateStep: true },
      where: {
        id: mission.currentStepId,
        gameRoomMissionId: mission.id,
      },
    });

    if (!currentStep) {
      throw new ConflictException({
        code: 'CURRENT_MISSION_STEP_NOT_FOUND',
        message: 'Current mission step was not found.',
      });
    }

    return currentStep;
  }
}

function buildLifecycleEvents(input: {
  room: GameRoomEntity;
  mission: GameRoomMissionEntity;
  currentStep: GameRoomMissionStepEntity | null;
  evaluatedTurn: TurnEntity;
  execution: ExecutionEntity;
  missionResultPayload: RealtimeEvaluationResult;
  judgeStatus: MissionResultJudgeStatus;
  occurredAt: Date;
  nextTurn: TurnEntity | null;
  snapshotId: string;
  snapshotFiles: SnapshotFile[];
  submittedStatus: TurnStatus.SUBMITTED | TurnStatus.TIMEOUT;
  missionFinished: boolean;
  suppressNextTurnCreation: boolean;
}): TurnLifecycleResult {
  const occurredAt = toSeoulIso(input.occurredAt);
  const missionState = buildMissionState({
    room: input.room,
    mission: input.mission,
    currentStep: input.currentStep,
    snapshotFiles: input.snapshotFiles,
  });
  const roomForGameState =
    input.suppressNextTurnCreation && input.room.status !== GameRoomStatus.FINISHED
      ? { ...input.room, status: GameRoomStatus.FINISHED }
      : input.room;
  const gameState = buildGameState({
    room: roomForGameState,
    mission: input.mission,
    currentTurn: input.nextTurn,
  });

  return {
    submitEvent: {
      gameRoomId: input.room.id,
      turnId: input.evaluatedTurn.id,
      userId: input.evaluatedTurn.playerUserId,
      occurredAt,
    },
    evaluatedEvent: {
      gameRoomId: input.room.id,
      evaluatedTurn: {
        turnId: input.evaluatedTurn.id,
        turnNumber: input.evaluatedTurn.turnNumber,
        playerUserId: input.evaluatedTurn.playerUserId,
        status: input.submittedStatus,
      },
      evaluationResult: input.missionResultPayload,
      occurredAt,
    },
    gameStateUpdatedEvent: {
      gameRoomId: input.room.id,
      gameState,
      missionState,
      occurredAt,
    },
    turnChangedEvent:
      input.nextTurn === null
        ? null
        : {
            gameRoomId: input.room.id,
            previousTurnId: input.evaluatedTurn.id,
            missionState,
            turnState: buildTurnState(input.room, input.nextTurn),
            nextPlayerId: input.nextTurn.playerUserId,
            turnSnapshotId: input.snapshotId,
            occurredAt,
          },
    missionResultEvent:
      !input.missionFinished
        ? null
        : {
            gameRoomId: input.room.id,
            gameState,
            missionResult: {
              missionId: input.mission.id,
              ...input.missionResultPayload,
              judgeStatus: input.judgeStatus,
              isMissionCleared:
                input.judgeStatus === MissionResultJudgeStatus.PASSED,
            },
            occurredAt,
          },
  };
}

function buildGameState(input: {
  room: GameRoomEntity;
  mission: GameRoomMissionEntity;
  currentTurn: TurnEntity | null;
}): Record<string, unknown> {
  return {
    status: input.room.status,
    strikeCount: input.mission.strikeCount,
    maxStrikeCount: input.room.maxStrikeCount,
    turnState: input.currentTurn ? buildTurnState(input.room, input.currentTurn) : null,
  };
}

function buildMissionState(input: {
  room: GameRoomEntity;
  mission: GameRoomMissionEntity;
  currentStep: GameRoomMissionStepEntity | null;
  snapshotFiles: SnapshotFile[];
}): RealtimeMissionState {
  return {
    missionId: input.mission.id,
    missionTemplateId: input.mission.missionTemplateId,
    currentStepId: input.currentStep?.id ?? null,
    currentStepStatus: input.currentStep?.status ?? null,
    gameRoomMissionStepId: input.currentStep?.id ?? null,
    missionTemplateStepId: input.currentStep?.missionTemplateStepId ?? null,
    stepOrder: input.currentStep?.stepOrder ?? null,
    stepTitle: input.currentStep?.missionTemplateStep?.title ?? '',
    stepDescription: input.currentStep?.missionTemplateStep?.description ?? '',
    steps: buildMissionSteps(input.mission.steps),
    title: input.mission.missionTemplate?.title ?? '',
    description: input.mission.missionTemplate?.description ?? '',
    language: input.mission.missionTemplate?.language ?? '',
    difficulty: input.room.difficulty,
    strikeCount: input.mission.strikeCount,
    projectStructure: withSnapshotBackedProjectStructure(
      input.mission.projectStructureJson,
      input.snapshotFiles,
    ),
  };
}

function buildMissionSteps(
  missionSteps: GameRoomMissionEntity['steps'] | undefined,
): RealtimeMissionStepSummary[] {
  if (!Array.isArray(missionSteps)) {
    return [];
  }

  return missionSteps.map((step) => ({
    gameRoomMissionStepId: step.id,
    missionTemplateStepId: step.missionTemplateStepId,
    stepOrder: step.stepOrder,
    title: step.missionTemplateStep?.title ?? '',
    description: step.missionTemplateStep?.description ?? '',
    status: step.status,
    targetFilePath: step.missionTemplateStep?.targetFilePath,
  }));
}

function buildTurnState(
  room: GameRoomEntity,
  turn: TurnEntity,
): RealtimeTurnState {
  return {
    turnId: turn.id,
    turnNumber: turn.turnNumber,
    currentPlayerId: turn.playerUserId,
    startedAt: toSeoulIso(turn.startedAt),
    deadlineAt: toSeoulIso(turn.deadlineAt),
    timeLimitSeconds: room.timeLimitSeconds,
    remainingTimeSeconds: room.timeLimitSeconds,
    status: turn.status,
  };
}

function determineJudgeStatus(
  execution: ExecutionEntity,
): MissionResultJudgeStatus {
  if (execution.status === ExecutionStatus.SUCCESS) {
    return MissionResultJudgeStatus.PASSED;
  }

  if (execution.runtimeFailureCode !== null) {
    return MissionResultJudgeStatus.ERROR;
  }

  return MissionResultJudgeStatus.FAILED;
}

function resolveNextPlayerUserId(
  joinedUserIds: string[],
  currentPlayerUserId: string,
): string {
  const currentIndex = joinedUserIds.indexOf(currentPlayerUserId);

  if (currentIndex === -1) {
    return joinedUserIds[0];
  }

  return joinedUserIds[(currentIndex + 1) % joinedUserIds.length];
}

function normalizeRuntimeFilePath(
  filePath: string,
  rootPath: string,
): string {
  if (filePath.startsWith('/')) {
    return filePath;
  }

  return `${rootPath.replace(/\/$/, '')}/${filePath.replace(/^\//, '')}`;
}

function resolveRuntimeCommand(input: {
  judgePolicy: Record<string, unknown>;
  projectStructure: Record<string, unknown>;
  targetFilePath: string;
  fallbackLanguage: string | null;
}): string {
  const configuredCommand =
    asString(input.judgePolicy.command) ??
    asString(input.judgePolicy.executionCommand) ??
    asString(input.judgePolicy.runCommand);

  if (configuredCommand) {
    return configuredCommand;
  }

  const entryFilePath = normalizeRuntimeFilePath(
    asString(input.projectStructure.entryFilePath) ?? input.targetFilePath,
    asString(input.projectStructure.rootPath) ?? '/workspace',
  );
  const language = input.fallbackLanguage?.toLowerCase();

  if (language === 'typescript' || language === 'javascript') {
    return `node ${entryFilePath}`;
  }

  return `python ${entryFilePath}`;
}

function withProjectStructureFileUrls(
  projectStructureJson: Record<string, unknown>,
): Record<string, unknown> {
  const projectStructure = asRecord(projectStructureJson);
  const files = Array.isArray(projectStructure.files) ? projectStructure.files : [];

  return {
    ...projectStructure,
    files: files
      .filter((file): file is Record<string, unknown> => isRecord(file))
      .map((file) => {
        const filePath = asString(file.filePath) ?? '';
        const content = asString(file.content) ?? '';

        return {
          ...file,
          filePath,
          language:
            asString(file.language) ??
            inferLanguageFromPath(filePath) ??
            'text',
          readonly: typeof file.readonly === 'boolean' ? file.readonly : false,
          fileUrl:
            asString(file.fileUrl) ?? buildInlineFileUrl(content),
        };
      }),
  };
}

function buildInlineFileUrl(content: string): string {
  return `data:text/plain;charset=utf-8,${encodeURIComponent(content)}`;
}

function inferLanguageFromProjectStructure(
  projectStructure: Record<string, unknown>,
): string | null {
  const files = Array.isArray(projectStructure.files) ? projectStructure.files : [];
  const firstFile = files.find((file): file is Record<string, unknown> => isRecord(file));
  const explicitLanguage = firstFile ? asString(firstFile.language) : null;

  if (explicitLanguage) {
    return explicitLanguage;
  }

  return firstFile ? inferLanguageFromPath(asString(firstFile.filePath)) : null;
}

function inferLanguageFromPath(filePath: string | null | undefined): string | null {
  if (!filePath) {
    return null;
  }

  if (filePath.endsWith('.py')) {
    return 'python';
  }

  if (filePath.endsWith('.ts')) {
    return 'typescript';
  }

  if (filePath.endsWith('.js')) {
    return 'javascript';
  }

  return null;
}

function findSnapshotFile(
  files: Array<{ filePath: string; content: string; occurredAt?: string }>,
  targetFilePath: string | null | undefined,
): { filePath: string; content: string; occurredAt?: string } | null {
  if (!targetFilePath) {
    return null;
  }

  const normalizedTarget = targetFilePath.replace(/^\//, '');

  return (
    files.find((file) => file.filePath === targetFilePath) ??
    files.find((file) => file.filePath.replace(/^\//, '') === normalizedTarget) ??
    null
  );
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function withSnapshotBackedProjectStructure(
  projectStructureJson: Record<string, unknown>,
  snapshotFiles: SnapshotFile[],
): RealtimeProjectStructure {
  const projectStructure = asRecord(projectStructureJson);
  const files = Array.isArray(projectStructure.files) ? projectStructure.files : [];

  return {
    ...projectStructure,
    files: files
      .filter((file): file is Record<string, unknown> => isRecord(file))
      .map((file) => {
        const filePath = asString(file.filePath) ?? '';
        const snapshotFile = findSnapshotFile(snapshotFiles, filePath);
        const content = snapshotFile?.content ?? asString(file.content) ?? '';

        return {
          ...file,
          filePath,
          content,
          language:
            asString(file.language) ??
            inferLanguageFromPath(filePath) ??
            'text',
          readonly: typeof file.readonly === 'boolean' ? file.readonly : false,
          fileUrl: snapshotFile
            ? buildInlineFileUrl(content)
            : asString(file.fileUrl) ?? buildInlineFileUrl(content),
        };
      }),
  };
}
