import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { GameRoomMissionsService } from '@modules/game-room-missions/service/game-room-missions.service';
import { GameRoomParticipantEntity } from '@modules/game-room-participants/entity/game-room-participant.entity';
import { TurnsService } from '@modules/turns/service/turns.service';
import { AiChatSession } from '@modules/ai-chat-sessions/entity/ai-chat-session.entity';
import { AiGameSession } from '@modules/ai-game-sessions/entity/ai-game-session.entity';
import { TurnEntity } from '@modules/turns/entity/turn.entity';
import { GameRoomMissionEntity } from '@modules/game-room-missions/entity/game-room-mission.entity';
import { GameRoomMissionStepEntity } from '@modules/game-room-missions/entity/game-room-mission-step.entity';
import { GameRoomEntity } from '../entity/game-room.entity';
import {
  AiChatSessionStatus,
  AiGameSessionStatus,
  GameRoomParticipantMembershipStatus,
  GameRoomParticipantRole,
  GameRoomStatus,
} from '@shared/enums';

export interface CreateGameRoomInput {
  ownerUserId: string;
  difficulty: string;
  timeLimitSeconds: number;
  maxStrikeCount: number;
  minParticipants: number;
  maxParticipants: number;
}

export interface StartGameInput {
  actorUserId: string;
  gameRoomId: string;
  missionTemplateId: string;
}

export interface StartGameResult {
  gameRoom: GameRoomEntity;
  gameRoomMission: GameRoomMissionEntity;
  currentTurn: TurnEntity;
  currentStep: GameRoomMissionStepEntity;
}

@Injectable()
export class GameRoomsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly gameRoomMissionsService: GameRoomMissionsService,
    private readonly turnsService: TurnsService,
  ) {}

  async listAccessibleRooms(userId: string): Promise<GameRoomEntity[]> {
    const participantRepository = this.dataSource.getRepository(
      GameRoomParticipantEntity,
    );
    const accessibleMemberships = await participantRepository.find({
      relations: { gameRoom: true },
      where: {
        userId,
        membershipStatus: In([
          GameRoomParticipantMembershipStatus.INVITED,
          GameRoomParticipantMembershipStatus.JOINED,
        ]),
      },
      order: {
        createdAt: 'ASC',
      },
    });

    const accessibleRooms = accessibleMemberships.map(
      (membership) => membership.gameRoom,
    );
    return accessibleRooms;
  }

  async createRoom(input: CreateGameRoomInput): Promise<GameRoomEntity> {
    return this.dataSource.transaction(async (manager) => {
      const roomRepository = manager.getRepository(GameRoomEntity);
      const participantRepository = manager.getRepository(GameRoomParticipantEntity);

      await this.acquireWaitingRoomLock(manager, input.ownerUserId);
      await this.ensureNoWaitingRoomMembership(participantRepository, input.ownerUserId);

      const gameRoom = roomRepository.create({
        ownerUserId: input.ownerUserId,
        status: GameRoomStatus.WAITING,
        difficulty: input.difficulty,
        timeLimitSeconds: input.timeLimitSeconds,
        maxStrikeCount: input.maxStrikeCount,
        minParticipants: input.minParticipants,
        maxParticipants: input.maxParticipants,
      });

      const savedRoom = await roomRepository.save(gameRoom);

      const ownerParticipant = participantRepository.create({
        gameRoomId: savedRoom.id,
        userId: input.ownerUserId,
        role: GameRoomParticipantRole.OWNER,
        membershipStatus: GameRoomParticipantMembershipStatus.JOINED,
      });

      await participantRepository.save(ownerParticipant);

      return savedRoom;
    });
  }

  async finishRoomIfBelowMinParticipants(gameRoomId: string): Promise<{
    finished: boolean;
    room: GameRoomEntity;
  }> {
    return this.dataSource.transaction(async (manager) => {
      await this.acquireRoomLifecycleLock(manager, gameRoomId);

      const roomRepository = manager.getRepository(GameRoomEntity);
      const participantRepository = manager.getRepository(GameRoomParticipantEntity);
      const room = await this.getRoomOrThrow(roomRepository, gameRoomId);

      if (room.status !== GameRoomStatus.IN_PROGRESS) {
        return {
          finished: false,
          room,
        };
      }

      const joinedParticipantCount = await participantRepository.count({
        where: {
          gameRoomId,
          membershipStatus: GameRoomParticipantMembershipStatus.JOINED,
        },
      });

      if (joinedParticipantCount >= room.minParticipants) {
        return {
          finished: false,
          room,
        };
      }

      room.status = GameRoomStatus.FINISHED;
      const closedAt = new Date();
      await this.closeActiveAiChatSessionsForRoom(manager, gameRoomId, closedAt);
      await this.closeActiveAiGameSessionsForRoom(manager, gameRoomId, closedAt);
      const savedRoom = await roomRepository.save(room);

      return {
        finished: true,
        room: savedRoom,
      };
    });
  }

  async startGame(input: StartGameInput): Promise<StartGameResult> {
    let preparedRuntimeContainerId: string | null = null;

    try {
      const result = await this.dataSource.transaction(async (manager) => {
        await this.acquireRoomLifecycleLock(manager, input.gameRoomId);
        await this.acquireWaitingRoomLock(manager, input.actorUserId);

        const roomRepository = manager.getRepository(GameRoomEntity);
        const participantRepository = manager.getRepository(GameRoomParticipantEntity);
        const gameRoom = await this.getRoomOrThrow(roomRepository, input.gameRoomId);

        this.ensureWaitingRoom(gameRoom);
        await this.ensureActiveOwnerMembership(
          participantRepository,
          gameRoom,
          input.actorUserId,
        );

        const joinedParticipantCount = await participantRepository.count({
          where: {
            gameRoomId: gameRoom.id,
            membershipStatus: GameRoomParticipantMembershipStatus.JOINED,
          },
        });

        if (joinedParticipantCount < gameRoom.minParticipants) {
          throw new ConflictException({
            code: 'MINIMUM_PARTICIPANTS_NOT_MET',
            message: 'Room does not have enough joined participants to start.',
          });
        }

        if (joinedParticipantCount > gameRoom.maxParticipants) {
          throw new ConflictException({
            code: 'MAXIMUM_PARTICIPANTS_EXCEEDED',
            message: 'Room exceeds the maximum participant limit.',
          });
        }

        const gameRoomMission =
          await this.gameRoomMissionsService.createMissionForGameStart({
            manager,
            gameRoomId: gameRoom.id,
            roomDifficulty: gameRoom.difficulty,
            missionTemplateId: input.missionTemplateId,
          });
        gameRoomMission.missionTemplate =
          await this.gameRoomMissionsService.validateMissionTemplateSelection(
            gameRoom.difficulty,
            input.missionTemplateId,
          );
        preparedRuntimeContainerId = gameRoomMission.containerId;

        const currentTurn = await this.turnsService.createInitialTurn({
          manager,
          gameRoomId: gameRoom.id,
          missionId: gameRoomMission.id,
          timeLimitSeconds: gameRoom.timeLimitSeconds,
        });
        const currentStep =
          await this.gameRoomMissionsService.transitionCurrentStepToInProgress({
            manager,
            gameRoomMissionId: gameRoomMission.id,
          });

        gameRoom.status = GameRoomStatus.IN_PROGRESS;
        const savedGameRoom = await roomRepository.save(gameRoom);

        return {
          gameRoom: savedGameRoom,
          gameRoomMission,
          currentTurn,
          currentStep,
        };
      });

      preparedRuntimeContainerId = null;

      return result;
    } catch (error) {
      if (preparedRuntimeContainerId) {
        await this.gameRoomMissionsService.releasePreparedRuntimeContainer(
          preparedRuntimeContainerId,
        );
      }

      throw error;
    }
  }

  private async ensureNoWaitingRoomMembership(
    participantRepository: Repository<GameRoomParticipantEntity>,
    userId: string,
  ): Promise<void> {
    const waitingMemberships = await participantRepository.find({
      relations: { gameRoom: true },
      where: {
        userId,
        membershipStatus: In([
          GameRoomParticipantMembershipStatus.INVITED,
          GameRoomParticipantMembershipStatus.JOINED,
        ]),
        gameRoom: {
          status: GameRoomStatus.WAITING,
        },
      },
    });

    if (waitingMemberships.length > 0) {
      throw new ConflictException({
        code: 'WAITING_ROOM_MEMBERSHIP_CONFLICT',
        message: 'User already belongs to a waiting room.',
      });
    }
  }

  private async closeActiveAiChatSessionsForRoom(
    manager: EntityManager,
    gameRoomId: string,
    closedAt: Date,
  ): Promise<void> {
    await manager.getRepository(AiChatSession).update(
      {
        gameRoomId,
        status: AiChatSessionStatus.ACTIVE,
      },
      {
        status: AiChatSessionStatus.CLOSED,
        closedAt,
      },
    );
  }

  private async closeActiveAiGameSessionsForRoom(
    manager: EntityManager,
    gameRoomId: string,
    closedAt: Date,
  ): Promise<void> {
    await manager.getRepository(AiGameSession).update(
      {
        gameRoomId,
        status: AiGameSessionStatus.ACTIVE,
      },
      {
        status: AiGameSessionStatus.CLOSED,
        closedAt,
      },
    );
  }

  private async acquireWaitingRoomLock(
    manager: EntityManager,
    userId: string,
  ): Promise<void> {
    await manager.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [userId],
    );
  }

  private async acquireRoomLifecycleLock(
    manager: EntityManager,
    gameRoomId: string,
  ): Promise<void> {
    await manager.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 1))',
      [gameRoomId],
    );
  }

  private async getRoomOrThrow(
    roomRepository: Repository<GameRoomEntity>,
    gameRoomId: string,
  ): Promise<GameRoomEntity> {
    const gameRoom = await roomRepository.findOne({
      where: { id: gameRoomId },
    });

    if (!gameRoom) {
      throw new NotFoundException({
        code: 'GAME_ROOM_NOT_FOUND',
        message: 'Game room was not found.',
      });
    }

    return gameRoom;
  }

  private ensureWaitingRoom(gameRoom: GameRoomEntity): void {
    if (gameRoom.status !== GameRoomStatus.WAITING) {
      throw new ConflictException({
        code: 'ROOM_NOT_WAITING',
        message: 'Room can only be started while it is waiting.',
      });
    }
  }

  private async ensureActiveOwnerMembership(
    participantRepository: Repository<GameRoomParticipantEntity>,
    gameRoom: GameRoomEntity,
    actorUserId: string,
  ): Promise<void> {
    const ownerMembership = await participantRepository.findOne({
      where: {
        gameRoomId: gameRoom.id,
        userId: actorUserId,
        role: GameRoomParticipantRole.OWNER,
        membershipStatus: GameRoomParticipantMembershipStatus.JOINED,
      },
    });

    if (gameRoom.ownerUserId !== actorUserId || !ownerMembership) {
      throw new ForbiddenException({
        code: 'GAME_ROOM_OWNER_REQUIRED',
        message: 'Only the room owner can perform this action.',
      });
    }
  }
}
