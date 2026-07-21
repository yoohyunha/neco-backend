/// <reference types="jest" />

import { DataSource, In, Repository } from 'typeorm';
import { GameRoomMissionsService } from '@modules/game-room-missions/service/game-room-missions.service';
import { GameRoomParticipantEntity } from '@modules/game-room-participants/entity/game-room-participant.entity';
import { TurnsService } from '@modules/turns/service/turns.service';
import { AiChatSession } from '@modules/ai-chat-sessions/entity/ai-chat-session.entity';
import { AiGameSession } from '@modules/ai-game-sessions/entity/ai-game-session.entity';
import { GameRoomsService } from './game-rooms.service';
import { GameRoomEntity } from '../entity/game-room.entity';
import {
  AiChatSessionStatus,
  AiGameSessionStatus,
  GameRoomParticipantMembershipStatus,
  GameRoomParticipantRole,
  GameRoomStatus,
} from '@shared/enums';

describe('GameRoomsService', () => {
  let service: GameRoomsService;
  let roomRepository: jest.Mocked<
    Pick<Repository<GameRoomEntity>, 'create' | 'save' | 'findOne'>
  >;
  let participantRepository: jest.Mocked<
    Pick<
      Repository<GameRoomParticipantEntity>,
      'count' | 'create' | 'find' | 'findOne' | 'save'
    >
  >;
  let gameRoomMissionsService: jest.Mocked<
    Pick<
      GameRoomMissionsService,
      | 'createMissionForGameStart'
      | 'validateMissionTemplateSelection'
      | 'transitionCurrentStepToInProgress'
      | 'releasePreparedRuntimeContainer'
    >
  >;
  let turnsService: jest.Mocked<Pick<TurnsService, 'createInitialTurn'>>;
  let manager: { getRepository: jest.Mock; query: jest.Mock };
  let dataSource: { transaction: jest.Mock; getRepository: jest.Mock };
  let aiChatSessionRepository: { update: jest.Mock };
  let aiGameSessionRepository: { update: jest.Mock };

  beforeEach(() => {
    roomRepository = {
      create: jest.fn(),
      findOne: jest.fn(),
      save: jest.fn(),
    };

    participantRepository = {
      count: jest.fn(),
      create: jest.fn(),
      find: jest.fn(),
      findOne: jest.fn(),
      save: jest.fn(),
    };

    gameRoomMissionsService = {
      createMissionForGameStart: jest.fn(),
      validateMissionTemplateSelection: jest.fn(),
      transitionCurrentStepToInProgress: jest.fn(),
      releasePreparedRuntimeContainer: jest.fn().mockResolvedValue(undefined),
    };

    turnsService = {
      createInitialTurn: jest.fn(),
    };

    aiChatSessionRepository = {
      update: jest.fn(),
    };

    aiGameSessionRepository = {
      update: jest.fn(),
    };

    manager = {
      getRepository: jest.fn((entity) => {
        if (entity === GameRoomEntity) {
          return roomRepository;
        }
        if (entity === AiChatSession) {
          return aiChatSessionRepository;
        }
        if (entity === AiGameSession) {
          return aiGameSessionRepository;
        }

        return participantRepository;
      }),
      query: jest.fn(),
    };

    dataSource = {
      transaction: jest.fn(async (callback) => callback(manager)),
      getRepository: jest.fn(() => participantRepository),
    };

    service = new GameRoomsService(
      dataSource as unknown as DataSource,
      gameRoomMissionsService as unknown as GameRoomMissionsService,
      turnsService as unknown as TurnsService,
    );
  });

  it('lists only rooms accessible to the authenticated user', async () => {
    participantRepository.find.mockResolvedValue([
      {
        gameRoom: {
          id: 'room-1',
          ownerUserId: 'owner-1',
          status: GameRoomStatus.WAITING,
        },
      } as GameRoomParticipantEntity,
      {
        gameRoom: {
          id: 'room-2',
          ownerUserId: 'owner-2',
          status: GameRoomStatus.IN_PROGRESS,
        },
      } as GameRoomParticipantEntity,
    ]);

    const result = await service.listAccessibleRooms('owner-1');

    expect(dataSource.getRepository).toHaveBeenCalledWith(GameRoomParticipantEntity);
    expect(participantRepository.find).toHaveBeenCalledWith({
      relations: { gameRoom: true },
      where: {
        userId: 'owner-1',
        membershipStatus: In([
          GameRoomParticipantMembershipStatus.INVITED,
          GameRoomParticipantMembershipStatus.JOINED,
        ]),
      },
      order: {
        createdAt: 'ASC',
      },
    });
    expect(result.map((room) => room.id)).toEqual(['room-1', 'room-2']);
  });

  it('returns an empty list when the authenticated user cannot access any room', async () => {
    participantRepository.find.mockResolvedValue([]);

    await expect(service.listAccessibleRooms('owner-1')).resolves.toEqual([]);
  });

  it('surfaces multiple waiting rooms as an abnormal list shape instead of changing the contract', async () => {
    participantRepository.find.mockResolvedValue([
      {
        gameRoom: {
          id: 'room-1',
          ownerUserId: 'owner-1',
          status: GameRoomStatus.WAITING,
        },
      } as GameRoomParticipantEntity,
      {
        gameRoom: {
          id: 'room-2',
          ownerUserId: 'owner-2',
          status: GameRoomStatus.WAITING,
        },
      } as GameRoomParticipantEntity,
    ]);

    const result = await service.listAccessibleRooms('owner-1');

    expect(result.map((room) => room.id)).toEqual(['room-1', 'room-2']);
    expect(
      result.filter((room) => room.status === GameRoomStatus.WAITING),
    ).toHaveLength(2);
  });

  it('creates a waiting room with an owner participant', async () => {
    participantRepository.find.mockResolvedValue([]);
    roomRepository.create.mockReturnValue({
      ownerUserId: 'owner-1',
      status: GameRoomStatus.WAITING,
      difficulty: 'EASY',
      timeLimitSeconds: 600,
      maxStrikeCount: 3,
      minParticipants: 2,
      maxParticipants: 4,
    } as GameRoomEntity);
    roomRepository.save.mockResolvedValue({
      id: 'room-1',
      ownerUserId: 'owner-1',
      status: GameRoomStatus.WAITING,
    } as GameRoomEntity);
    participantRepository.create.mockReturnValue({
      gameRoomId: 'room-1',
      userId: 'owner-1',
      role: GameRoomParticipantRole.OWNER,
      membershipStatus: GameRoomParticipantMembershipStatus.JOINED,
    } as GameRoomParticipantEntity);

    const result = await service.createRoom({
      ownerUserId: 'owner-1',
      difficulty: 'EASY',
      timeLimitSeconds: 600,
      maxStrikeCount: 3,
      minParticipants: 2,
      maxParticipants: 4,
    });

    expect(result.id).toBe('room-1');
    expect(dataSource.transaction).toHaveBeenCalled();
    expect(manager.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      ['owner-1'],
    );
    expect(roomRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId: 'owner-1',
        status: GameRoomStatus.WAITING,
      }),
    );
    expect(participantRepository.create).toHaveBeenCalledWith({
      gameRoomId: 'room-1',
      userId: 'owner-1',
      role: GameRoomParticipantRole.OWNER,
      membershipStatus: GameRoomParticipantMembershipStatus.JOINED,
    });
  });

  it('rejects creating a room when the owner already belongs to a waiting room', async () => {
    participantRepository.find.mockResolvedValue([
      {
        id: 'participant-1',
        gameRoomId: 'room-existing',
      } as GameRoomParticipantEntity,
    ]);

    await expect(
      service.createRoom({
        ownerUserId: 'owner-1',
        difficulty: 'EASY',
        timeLimitSeconds: 600,
        maxStrikeCount: 3,
        minParticipants: 2,
        maxParticipants: 4,
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'WAITING_ROOM_MEMBERSHIP_CONFLICT',
      }),
    });

    expect(dataSource.transaction).toHaveBeenCalled();
    expect(roomRepository.save).not.toHaveBeenCalled();
    expect(participantRepository.save).not.toHaveBeenCalled();
  });

  it('allows only the joined owner to start a waiting room', async () => {
    roomRepository.findOne.mockResolvedValue({
      id: 'room-1',
      ownerUserId: 'owner-1',
      status: GameRoomStatus.WAITING,
      difficulty: 'EASY',
      timeLimitSeconds: 30,
      minParticipants: 2,
      maxParticipants: 4,
    } as GameRoomEntity);
    participantRepository.findOne.mockResolvedValue(null);

    await expect(
      service.startGame({
        actorUserId: 'other-user',
        gameRoomId: 'room-1',
        missionTemplateId: 'template-1',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'GAME_ROOM_OWNER_REQUIRED',
      }),
    });

    expect(gameRoomMissionsService.createMissionForGameStart).not.toHaveBeenCalled();
  });

  it('rejects game start when the room does not meet the minimum participant count', async () => {
    roomRepository.findOne.mockResolvedValue({
      id: 'room-1',
      ownerUserId: 'owner-1',
      status: GameRoomStatus.WAITING,
      difficulty: 'EASY',
      minParticipants: 3,
      maxParticipants: 4,
    } as GameRoomEntity);
    participantRepository.findOne.mockResolvedValue({
      id: 'owner-participant-1',
      gameRoomId: 'room-1',
      userId: 'owner-1',
      role: GameRoomParticipantRole.OWNER,
      membershipStatus: GameRoomParticipantMembershipStatus.JOINED,
    } as GameRoomParticipantEntity);
    participantRepository.count.mockResolvedValue(2);

    await expect(
      service.startGame({
        actorUserId: 'owner-1',
        gameRoomId: 'room-1',
        missionTemplateId: 'template-1',
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'MINIMUM_PARTICIPANTS_NOT_MET',
      }),
    });

    expect(gameRoomMissionsService.createMissionForGameStart).not.toHaveBeenCalled();
  });

  it('creates the room mission and marks the room in progress when start validation passes', async () => {
    roomRepository.findOne.mockResolvedValue({
      id: 'room-1',
      ownerUserId: 'owner-1',
      status: GameRoomStatus.WAITING,
      difficulty: 'EASY',
      timeLimitSeconds: 30,
      minParticipants: 2,
      maxParticipants: 4,
    } as GameRoomEntity);
    participantRepository.findOne.mockResolvedValue({
      id: 'owner-participant-1',
      gameRoomId: 'room-1',
      userId: 'owner-1',
      role: GameRoomParticipantRole.OWNER,
      membershipStatus: GameRoomParticipantMembershipStatus.JOINED,
    } as GameRoomParticipantEntity);
    participantRepository.count.mockResolvedValue(2);
    gameRoomMissionsService.createMissionForGameStart.mockResolvedValue({
      id: 'mission-1',
      containerId: 'runtime-container-1',
      currentStepId: 'step-1',
      missionTemplate: {
        id: 'template-1',
        title: 'Calculator',
        description: 'Build a calculator.',
        language: 'python',
      },
    } as never);
    turnsService.createInitialTurn.mockResolvedValue({
      id: 'turn-1',
      playerUserId: 'owner-1',
      turnNumber: 1,
      status: 'IN_PROGRESS',
    } as never);
    gameRoomMissionsService.transitionCurrentStepToInProgress.mockResolvedValue({
      id: 'step-1',
      status: 'IN_PROGRESS',
    } as never);
    roomRepository.save.mockImplementation(async (room) => room as never);

    const result = await service.startGame({
      actorUserId: 'owner-1',
      gameRoomId: 'room-1',
      missionTemplateId: 'template-1',
    });

    expect(manager.query).toHaveBeenNthCalledWith(
      1,
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 1))',
      ['room-1'],
    );
    expect(manager.query).toHaveBeenNthCalledWith(
      2,
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      ['owner-1'],
    );
    expect(participantRepository.count).toHaveBeenCalledWith({
      where: {
        gameRoomId: 'room-1',
        membershipStatus: GameRoomParticipantMembershipStatus.JOINED,
      },
    });
    expect(gameRoomMissionsService.createMissionForGameStart).toHaveBeenCalledWith({
      manager,
      gameRoomId: 'room-1',
      roomDifficulty: 'EASY',
      missionTemplateId: 'template-1',
    });
    expect(
      gameRoomMissionsService.validateMissionTemplateSelection,
    ).toHaveBeenCalledWith('EASY', 'template-1');
    expect(turnsService.createInitialTurn).toHaveBeenCalledWith({
      manager,
      gameRoomId: 'room-1',
      missionId: 'mission-1',
      timeLimitSeconds: 30,
    });
    expect(
      gameRoomMissionsService.transitionCurrentStepToInProgress,
    ).toHaveBeenCalledWith({
      manager,
      gameRoomMissionId: 'mission-1',
    });
    expect(roomRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'room-1',
        status: GameRoomStatus.IN_PROGRESS,
      }),
    );
    expect(result).toEqual({
      gameRoom: expect.objectContaining({
        id: 'room-1',
        status: GameRoomStatus.IN_PROGRESS,
      }),
      gameRoomMission: expect.objectContaining({
        id: 'mission-1',
      }),
      currentTurn: expect.objectContaining({
        id: 'turn-1',
      }),
      currentStep: expect.objectContaining({
        id: 'step-1',
      }),
    });
    expect(gameRoomMissionsService.releasePreparedRuntimeContainer).not.toHaveBeenCalled();
  });

  it('reloads the mission template when mission start returns a mission without relation metadata', async () => {
    roomRepository.findOne.mockResolvedValue({
      id: 'room-1',
      ownerUserId: 'owner-1',
      status: GameRoomStatus.WAITING,
      difficulty: 'EASY',
      timeLimitSeconds: 30,
      minParticipants: 2,
      maxParticipants: 4,
    } as GameRoomEntity);
    participantRepository.findOne.mockResolvedValue({
      id: 'owner-participant-1',
      gameRoomId: 'room-1',
      userId: 'owner-1',
      role: GameRoomParticipantRole.OWNER,
      membershipStatus: GameRoomParticipantMembershipStatus.JOINED,
    } as GameRoomParticipantEntity);
    participantRepository.count.mockResolvedValue(2);
    gameRoomMissionsService.createMissionForGameStart.mockResolvedValue({
      id: 'mission-1',
      containerId: 'runtime-container-1',
      currentStepId: 'step-1',
      missionTemplateId: 'template-1',
    } as never);
    gameRoomMissionsService.validateMissionTemplateSelection.mockResolvedValue({
      id: 'template-1',
      title: 'Calculator',
      description: 'Build a calculator.',
      language: 'python',
      difficulty: 'EASY',
    } as never);
    turnsService.createInitialTurn.mockResolvedValue({
      id: 'turn-1',
      playerUserId: 'owner-1',
      turnNumber: 1,
      status: 'IN_PROGRESS',
    } as never);
    gameRoomMissionsService.transitionCurrentStepToInProgress.mockResolvedValue({
      id: 'step-1',
      status: 'IN_PROGRESS',
    } as never);
    roomRepository.save.mockImplementation(async (room) => room as never);

    const result = await service.startGame({
      actorUserId: 'owner-1',
      gameRoomId: 'room-1',
      missionTemplateId: 'template-1',
    });

    expect(
      gameRoomMissionsService.validateMissionTemplateSelection,
    ).toHaveBeenCalledWith('EASY', 'template-1');
    expect(result.gameRoomMission.missionTemplate).toEqual(
      expect.objectContaining({
        id: 'template-1',
        title: 'Calculator',
        description: 'Build a calculator.',
        language: 'python',
      }),
    );
  });

  it('removes a prepared runtime container when later start flow steps fail', async () => {
    roomRepository.findOne.mockResolvedValue({
      id: 'room-1',
      ownerUserId: 'owner-1',
      status: GameRoomStatus.WAITING,
      difficulty: 'EASY',
      timeLimitSeconds: 30,
      minParticipants: 2,
      maxParticipants: 4,
    } as GameRoomEntity);
    participantRepository.findOne.mockResolvedValue({
      id: 'owner-participant-1',
      gameRoomId: 'room-1',
      userId: 'owner-1',
      role: GameRoomParticipantRole.OWNER,
      membershipStatus: GameRoomParticipantMembershipStatus.JOINED,
    } as GameRoomParticipantEntity);
    participantRepository.count.mockResolvedValue(2);
    gameRoomMissionsService.createMissionForGameStart.mockResolvedValue({
      id: 'mission-1',
      containerId: 'runtime-container-1',
      currentStepId: 'step-1',
    } as never);
    turnsService.createInitialTurn.mockRejectedValue(new Error('turn creation failed'));

    await expect(
      service.startGame({
        actorUserId: 'owner-1',
        gameRoomId: 'room-1',
        missionTemplateId: 'template-1',
      }),
    ).rejects.toThrow('turn creation failed');

    expect(gameRoomMissionsService.releasePreparedRuntimeContainer).toHaveBeenCalledWith(
      'runtime-container-1',
    );
    expect(roomRepository.save).not.toHaveBeenCalledWith(
      expect.objectContaining({
        status: GameRoomStatus.IN_PROGRESS,
      }),
    );
  });

  it('removes a prepared runtime container when transaction commit fails after callback success', async () => {
    roomRepository.findOne.mockResolvedValue({
      id: 'room-1',
      ownerUserId: 'owner-1',
      status: GameRoomStatus.WAITING,
      difficulty: 'EASY',
      timeLimitSeconds: 30,
      minParticipants: 2,
      maxParticipants: 4,
    } as GameRoomEntity);
    participantRepository.findOne.mockResolvedValue({
      id: 'owner-participant-1',
      gameRoomId: 'room-1',
      userId: 'owner-1',
      role: GameRoomParticipantRole.OWNER,
      membershipStatus: GameRoomParticipantMembershipStatus.JOINED,
    } as GameRoomParticipantEntity);
    participantRepository.count.mockResolvedValue(2);
    gameRoomMissionsService.createMissionForGameStart.mockResolvedValue({
      id: 'mission-1',
      containerId: 'runtime-container-1',
      currentStepId: 'step-1',
    } as never);
    turnsService.createInitialTurn.mockResolvedValue({
      id: 'turn-1',
      playerUserId: 'owner-1',
      turnNumber: 1,
      status: 'IN_PROGRESS',
    } as never);
    gameRoomMissionsService.transitionCurrentStepToInProgress.mockResolvedValue({
      id: 'step-1',
      status: 'IN_PROGRESS',
    } as never);
    roomRepository.save.mockImplementation(async (room) => room as never);
    dataSource.transaction = jest.fn(async (callback) => {
      await callback(manager);
      throw new Error('transaction commit failed');
    });

    await expect(
      service.startGame({
        actorUserId: 'owner-1',
        gameRoomId: 'room-1',
        missionTemplateId: 'template-1',
      }),
    ).rejects.toThrow('transaction commit failed');

    expect(gameRoomMissionsService.releasePreparedRuntimeContainer).toHaveBeenCalledWith(
      'runtime-container-1',
    );
  });

  it('finishes the room when joined participants fall below minParticipants', async () => {
    roomRepository.findOne.mockResolvedValue({
      id: 'room-1',
      status: GameRoomStatus.IN_PROGRESS,
      minParticipants: 2,
    } as GameRoomEntity);
    participantRepository.count.mockResolvedValue(1);
    roomRepository.save.mockImplementation(async (room) => room as GameRoomEntity);

    const result = await service.finishRoomIfBelowMinParticipants('room-1');

    expect(result.finished).toBe(true);
    expect(roomRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'room-1',
        status: GameRoomStatus.FINISHED,
      }),
    );
    expect(aiChatSessionRepository.update).toHaveBeenCalledWith(
      {
        gameRoomId: 'room-1',
        status: AiChatSessionStatus.ACTIVE,
      },
      expect.objectContaining({
        status: AiChatSessionStatus.CLOSED,
      }),
    );
    expect(aiGameSessionRepository.update).toHaveBeenCalledWith(
      {
        gameRoomId: 'room-1',
        status: AiGameSessionStatus.ACTIVE,
      },
      expect.objectContaining({
        status: AiGameSessionStatus.CLOSED,
      }),
    );
  });
});
