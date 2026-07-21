import { HttpException, HttpStatus } from '@nestjs/common';
import { GameRoomMissionsService } from '@modules/game-room-missions/service/game-room-missions.service';
import { GameRoomParticipantsService } from '@modules/game-room-participants/service/game-room-participants.service';
import { GameStartFlowService } from '@modules/game-rooms/service/game-start-flow.service';
import { GameRoomEntity } from '@modules/game-rooms/entity/game-room.entity';
import { GameRoomsService } from '@modules/game-rooms/service/game-rooms.service';
import { DataSource, Repository } from 'typeorm';
import {
  AiChatSessionStatus,
  AiChatMessageSenderType,
  AiChatMessageType,
  AiChatRequestStatus,
  AiChatRequestType,
} from '../../shared/enums/ai-chat.enum';
import { AiChatCommandResultStatus } from '../../shared/dto/ai-chat-command.dto';
import { GameRoomStatus } from '../../shared/enums/game-room.enum';
import type { LlmFollowUpGeneratorPort } from '../../integrations/llm/llm-follow-up.port';
import type { LlmIntentParserPort } from '../../integrations/llm/llm-intent-parser.port';
import { User } from '../auth/entity/user.entity';
import { GameRoomParticipantEntity } from '../game-room-participants/entity/game-room-participant.entity';
import { DEFAULT_CLARIFICATION_MESSAGE } from './intent/ai-chat-assistant-content';
import { AI_CHAT_ERROR } from './constants/ai-chat-error.constants';
import { AiChatSessionsService } from './ai-chat-sessions.service';
import { AiChatMessage } from './entity/ai-chat-message.entity';
import { AiChatRequest } from './entity/ai-chat-request.entity';
import { AiChatSession } from './entity/ai-chat-session.entity';

describe('AiChatSessionsService', () => {
  const user = { userId: 'user-1', loginId: 'player1' };
  const sessionId = 'session-1';

  let aiChatSessionRepository: jest.Mocked<Repository<AiChatSession>>;
  let aiChatMessageRepository: jest.Mocked<Repository<AiChatMessage>>;
  let aiChatRequestRepository: jest.Mocked<Repository<AiChatRequest>>;
  let userRepository: jest.Mocked<Repository<User>>;
  let participantRepository: jest.Mocked<Repository<GameRoomParticipantEntity>>;
  let gameRoomRepository: { findOne: jest.Mock };
  let dataSource: jest.Mocked<DataSource>;
  let gameRoomsService: jest.Mocked<GameRoomsService>;
  let gameStartFlowService: jest.Mocked<GameStartFlowService>;
  let gameRoomMissionsService: jest.Mocked<GameRoomMissionsService>;
  let gameRoomParticipantsService: jest.Mocked<GameRoomParticipantsService>;
  let llmIntentParser: jest.Mocked<LlmIntentParserPort>;
  let llmFollowUpGenerator: jest.Mocked<LlmFollowUpGeneratorPort>;
  let service: AiChatSessionsService;

  beforeEach(() => {
    aiChatSessionRepository = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn((value) => value as AiChatSession),
      save: jest.fn(async (value) => value as AiChatSession),
    } as unknown as jest.Mocked<Repository<AiChatSession>>;

    aiChatMessageRepository = {
      find: jest.fn(),
    } as unknown as jest.Mocked<Repository<AiChatMessage>>;

    aiChatRequestRepository = {
      find: jest.fn(),
    } as unknown as jest.Mocked<Repository<AiChatRequest>>;

    userRepository = {
      find: jest.fn(),
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<User>>;

    participantRepository = {
      find: jest.fn(),
      findOne: jest.fn(),
    } as unknown as jest.Mocked<Repository<GameRoomParticipantEntity>>;

    gameRoomRepository = {
      findOne: jest.fn(),
    };

    dataSource = {
      transaction: jest.fn(),
      getRepository: jest.fn((entity: unknown) => {
        if (entity === GameRoomEntity) {
          return gameRoomRepository;
        }
        throw new Error('Unexpected entity');
      }),
    } as unknown as jest.Mocked<DataSource>;

    gameRoomsService = {
      createRoom: jest.fn(),
      startGame: jest.fn(),
      listAccessibleRooms: jest.fn(),
    } as unknown as jest.Mocked<GameRoomsService>;

    gameStartFlowService = {
      startGame: jest.fn(),
    } as unknown as jest.Mocked<GameStartFlowService>;

    gameRoomMissionsService = {
      listSelectableMissionTemplates: jest.fn().mockResolvedValue([
        {
          templateId: 'template-1',
          title: '초급 미션',
          description: '쉬운 난이도 미션입니다.',
          difficulty: 'EASY',
        },
      ]),
      validateMissionTemplateSelection: jest.fn(),
    } as unknown as jest.Mocked<GameRoomMissionsService>;

    gameRoomParticipantsService = {
      inviteParticipant: jest.fn(),
      inviteParticipants: jest.fn(),
      acceptInvitation: jest.fn(),
      denyInvitation: jest.fn(),
      leaveRoom: jest.fn(),
      listParticipantsForUser: jest.fn(),
    } as unknown as jest.Mocked<GameRoomParticipantsService>;

    llmIntentParser = {
      parseUserMessage: jest.fn(),
    };

    llmFollowUpGenerator = {
      generateCommandFollowUp: jest.fn().mockResolvedValue({
        content: 'EASY 난이도로 방을 만들 준비가 됐어요. 미션을 선택해 주세요.',
        metadata: { difficulty: 'EASY', followUpSource: 'static_fallback', templateKey: null },
        followUpSource: 'static_fallback',
        templateKey: null,
      }),
    };

    service = new AiChatSessionsService(
      aiChatSessionRepository,
      aiChatMessageRepository,
      aiChatRequestRepository,
      userRepository,
      participantRepository,
      dataSource,
      gameRoomsService,
      gameStartFlowService,
      gameRoomMissionsService,
      gameRoomParticipantsService,
      llmIntentParser,
      llmFollowUpGenerator,
    );
  });

  function mockTransactions() {
    const requestRepo = {
      create: jest.fn((value) => value as AiChatRequest),
      save: jest.fn(async (value) => ({ ...value, id: 'request-1' }) as AiChatRequest),
      findOneOrFail: jest.fn(
        async () =>
          ({
            id: 'request-1',
            aiChatSessionId: sessionId,
            requestType: 'UNPARSED',
            sourceMessageId: 'msg-user',
          }) as AiChatRequest,
      ),
    };

    const messageRepo = {
      create: jest.fn((value) => value as AiChatMessage),
      save: jest
        .fn()
        .mockImplementation(async (value) => ({
          ...value,
          id: value.senderType === AiChatMessageSenderType.USER ? 'msg-user' : 'msg-assistant',
          createdAt: new Date('2026-05-04T00:11:00Z'),
        })),
    };

    (dataSource.transaction as jest.Mock).mockImplementation(
      async (callback: (manager: { getRepository: (entity: unknown) => unknown }) => unknown) => {
        const manager = {
          getRepository: (entity: unknown) => {
            if (entity === AiChatRequest) {
              return requestRepo;
            }
            if (entity === AiChatMessage) {
              return messageRepo;
            }
            if (entity === AiChatSession) {
              return {
                findOneOrFail: jest.fn(async () => ({
                  id: sessionId,
                  requesterUserId: user.userId,
                  gameRoomId: null,
                })),
                save: jest.fn(async (value) => value),
              };
            }
            throw new Error('Unexpected entity');
          },
        };
        return callback(manager);
      },
    );

    return { requestRepo, messageRepo };
  }

  describe('listSessions', () => {
    it('returns mapped sessions for the authenticated user', async () => {
      const createdAt = new Date('2026-05-04T00:10:00Z');
      const updatedAt = new Date('2026-05-04T00:12:00Z');

      aiChatSessionRepository.find.mockResolvedValue([
        {
          id: sessionId,
          requesterUserId: user.userId,
          gameRoomId: null,
          status: 'ACTIVE',
          provider: 'openai',
          llmModel: 'gpt-4o',
          createdAt,
          updatedAt,
          closedAt: null,
        } as AiChatSession,
      ]);

      const result = await service.listSessions(user, {});

      expect(result).toHaveLength(1);
      expect(result[0].createdAt).toContain('+09:00');
    });

    it('creates a new ACTIVE session when the user only has CLOSED sessions', async () => {
      const closedAt = new Date('2026-05-04T00:12:00Z');
      aiChatSessionRepository.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'closed-session-1',
          requesterUserId: user.userId,
          gameRoomId: 'finished-room-1',
          providerConversationId: null,
          provider: 'openai',
          llmModel: 'gpt-4o',
          status: AiChatSessionStatus.CLOSED,
          createdAt: new Date('2026-05-04T00:10:00Z'),
          updatedAt: closedAt,
          closedAt,
        } as AiChatSession);
      aiChatSessionRepository.save.mockResolvedValueOnce({
        id: 'active-session-2',
        requesterUserId: user.userId,
        gameRoomId: null,
        providerConversationId: null,
        provider: 'openai',
        llmModel: 'gpt-4o',
        status: AiChatSessionStatus.ACTIVE,
        createdAt: new Date('2026-05-04T00:13:00Z'),
        updatedAt: new Date('2026-05-04T00:13:00Z'),
        closedAt: null,
      } as AiChatSession);
      aiChatSessionRepository.find.mockResolvedValue([
        {
          id: 'closed-session-1',
          requesterUserId: user.userId,
          gameRoomId: 'finished-room-1',
          providerConversationId: null,
          provider: 'openai',
          llmModel: 'gpt-4o',
          status: AiChatSessionStatus.CLOSED,
          createdAt: new Date('2026-05-04T00:10:00Z'),
          updatedAt: closedAt,
          closedAt,
        } as AiChatSession,
        {
          id: 'active-session-2',
          requesterUserId: user.userId,
          gameRoomId: null,
          providerConversationId: null,
          provider: 'openai',
          llmModel: 'gpt-4o',
          status: AiChatSessionStatus.ACTIVE,
          createdAt: new Date('2026-05-04T00:13:00Z'),
          updatedAt: new Date('2026-05-04T00:13:00Z'),
          closedAt: null,
        } as AiChatSession,
      ]);

      const result = await service.listSessions(user, {});

      expect(aiChatSessionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          requesterUserId: user.userId,
          gameRoomId: null,
          status: AiChatSessionStatus.ACTIVE,
        }),
      );
      expect(result.some((session) => session.status === AiChatSessionStatus.ACTIVE)).toBe(true);
    });

    it('rejects userId that does not match the authenticated user', async () => {
      await expect(
        service.listSessions(user, { userId: 'other-user' }),
      ).rejects.toMatchObject({
        response: { code: 'FORBIDDEN_RESOURCE_ACCESS' },
        status: HttpStatus.FORBIDDEN,
      });
    });
  });

  describe('listMessages', () => {
    it('returns 404 when the session is not owned by the user', async () => {
      aiChatSessionRepository.findOne.mockResolvedValue(null);

      await expect(service.listMessages(user, sessionId)).rejects.toMatchObject({
        response: { code: AI_CHAT_ERROR.SESSION_NOT_FOUND },
        status: HttpStatus.NOT_FOUND,
      });
    });
  });

  describe('createMessage', () => {
    beforeEach(() => {
      aiChatSessionRepository.findOne.mockResolvedValue({
        id: sessionId,
        requesterUserId: user.userId,
        gameRoomId: null,
      } as AiChatSession);
      gameRoomRepository.findOne.mockResolvedValue(null);
    });

    it('persists COMPLETED ROOM_CREATE with PENDING commandResult after parsing', async () => {
      const callOrder: string[] = [];
      llmIntentParser.parseUserMessage.mockImplementation(async () => {
        callOrder.push('llm');
        return { requestType: 'ROOM_CREATE', payload: { desiredDifficulty: 'EASY' } };
      });

      const { requestRepo, messageRepo } = mockTransactions();
      (dataSource.transaction as jest.Mock).mockImplementation(async (callback) => {
        callOrder.push('tx');
        const manager = {
          getRepository: (entity: unknown) => {
            if (entity === AiChatRequest) return requestRepo;
            if (entity === AiChatMessage) return messageRepo;
            if (entity === AiChatSession) {
              return {
                findOneOrFail: jest.fn(async () => ({
                  id: sessionId,
                  requesterUserId: user.userId,
                  gameRoomId: null,
                })),
                save: jest.fn(async (value) => value),
              };
            }
            throw new Error('Unexpected entity');
          },
        };
        return callback(manager);
      });

      const result = await service.createMessage(user, sessionId, {
        message: '쉬운 난이도로 방 만들어줘',
      });

      expect(callOrder).toEqual(['tx', 'llm', 'tx']);
      expect(llmIntentParser.parseUserMessage).toHaveBeenCalledWith({
        message: '쉬운 난이도로 방 만들어줘',
        gameRoomId: null,
      });
      expect(requestRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          requestType: 'UNPARSED',
          status: AiChatRequestStatus.RECEIVED,
        }),
      );
      expect(requestRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          requestType: AiChatRequestType.ROOM_CREATE,
          status: AiChatRequestStatus.COMPLETED,
        }),
      );
      expect(messageRepo.save).toHaveBeenCalledTimes(2);
      expect(llmFollowUpGenerator.generateCommandFollowUp).toHaveBeenCalledWith(
        expect.objectContaining({
          command: expect.objectContaining({ requestType: AiChatRequestType.ROOM_CREATE }),
          userMessage: '쉬운 난이도로 방 만들어줘',
        }),
      );
      expect(requestRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          responsePayload: expect.objectContaining({
            followUp: expect.objectContaining({ source: 'static_fallback' }),
          }),
        }),
      );
      expect(result).toMatchObject({
        aiChatRequestId: 'request-1',
        requestType: AiChatRequestType.ROOM_CREATE,
        requestStatus: AiChatRequestStatus.COMPLETED,
        assistantMessage: {
          aiChatRequestId: 'request-1',
          metadata: {
            difficulty: 'EASY',
            templates: [
              {
                templateId: 'template-1',
                title: '초급 미션',
                description: '쉬운 난이도 미션입니다.',
                difficulty: 'EASY',
              },
            ],
          },
        },
        commandResult: {
          commandType: AiChatRequestType.ROOM_CREATE,
          status: AiChatCommandResultStatus.PENDING,
        },
      });
      expect(Array.isArray(result.assistantMessage.metadata?.templates)).toBe(true);
      expect(gameRoomMissionsService.listSelectableMissionTemplates).toHaveBeenCalledWith(
        'EASY',
      );
    });

    it('still persists chat when follow-up generation throws', async () => {
      llmIntentParser.parseUserMessage.mockResolvedValue({
        requestType: 'USER_INVITE',
        payload: { inviteeNicknames: ['player2'] },
      });
      userRepository.find.mockResolvedValue([
        {
          id: 'user-2',
          nickname: 'player2',
        } as User,
      ]);
      gameRoomParticipantsService.inviteParticipants.mockResolvedValue([
        {
          id: 'participant-2',
          gameRoomId: 'room-1',
          userId: 'user-2',
        } as GameRoomParticipantEntity,
      ] as never);
      aiChatSessionRepository.findOne.mockResolvedValue({
        id: sessionId,
        requesterUserId: user.userId,
        gameRoomId: 'room-1',
      } as AiChatSession);
      llmFollowUpGenerator.generateCommandFollowUp.mockRejectedValue(
        new Error('follow-up unavailable'),
      );

      const { requestRepo, messageRepo } = mockTransactions();

      const result = await service.createMessage(user, sessionId, {
        message: '@player2 초대해줘',
      });

      expect(result.requestStatus).toBe(AiChatRequestStatus.COMPLETED);
      expect(messageRepo.save).toHaveBeenCalledTimes(2);
      expect(requestRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: AiChatRequestStatus.COMPLETED,
          responsePayload: expect.objectContaining({
            followUp: expect.objectContaining({ source: 'static_fallback' }),
          }),
        }),
      );
    });

    it('executes ROOM_CREATE when difficulty and missionTemplateId are resolved', async () => {
      llmIntentParser.parseUserMessage.mockResolvedValue({
        requestType: 'ROOM_CREATE',
        payload: {
          desiredDifficulty: 'EASY',
          missionTemplateId: 'template-1',
        },
      });
      mockTransactions();
      gameRoomMissionsService.validateMissionTemplateSelection.mockResolvedValue({
        id: 'template-1',
      } as never);
      gameRoomsService.createRoom.mockResolvedValue({
        id: 'room-1',
      } as never);

      const result = await service.createMessage(user, sessionId, {
        message: '쉬운 방 만들고 template-1으로 진행할게',
      });

      expect(gameRoomsService.createRoom).toHaveBeenCalledWith({
        ownerUserId: user.userId,
        difficulty: 'EASY',
        timeLimitSeconds: 30,
        maxStrikeCount: 3,
        minParticipants: 2,
        maxParticipants: 4,
      });
      expect(result).toMatchObject({
        requestType: AiChatRequestType.ROOM_CREATE,
        requestStatus: AiChatRequestStatus.COMPLETED,
        commandResult: {
          commandType: AiChatRequestType.ROOM_CREATE,
          status: AiChatCommandResultStatus.SUCCESS,
          gameRoomId: 'room-1',
          participants: null,
          started: false,
        },
      });
    });

    it('continues pending ROOM_CREATE when the user selects a mission template by title', async () => {
      llmIntentParser.parseUserMessage.mockResolvedValue({
        requestType: 'ROOM_CREATE',
        payload: {},
      });
      llmFollowUpGenerator.generateCommandFollowUp.mockRejectedValueOnce(
        new Error('follow-up unavailable'),
      );
      gameRoomMissionsService.listSelectableMissionTemplates.mockResolvedValueOnce([
        {
          templateId: 'template-stdin-calculator',
          title: '표준 입력 계산기',
          description: '표준 입력으로 계산식을 처리하는 미션입니다.',
          difficulty: 'EASY',
        },
      ]);
      aiChatRequestRepository.find.mockResolvedValue([
        {
          requestPayload: {
            command: {
              requestType: AiChatRequestType.ROOM_CREATE,
              desiredDifficulty: 'EASY',
            },
          },
          responsePayload: {
            commandResult: {
              status: AiChatCommandResultStatus.PENDING,
              gameRoomId: null,
            },
          },
          requestedAt: new Date('2026-05-04T00:10:00Z'),
        } as unknown as AiChatRequest,
      ]);
      mockTransactions();
      gameRoomMissionsService.validateMissionTemplateSelection.mockResolvedValue({
        id: 'template-stdin-calculator',
      } as never);
      gameRoomsService.createRoom.mockResolvedValue({
        id: 'room-1',
      } as never);

      const result = await service.createMessage(user, sessionId, {
        message: '표준 입력 계산기 템플릿으로 진행할게요.',
      });

      expect(gameRoomMissionsService.validateMissionTemplateSelection).toHaveBeenCalledWith(
        'EASY',
        'template-stdin-calculator',
      );
      expect(gameRoomsService.createRoom).toHaveBeenCalledWith({
        ownerUserId: user.userId,
        difficulty: 'EASY',
        timeLimitSeconds: 30,
        maxStrikeCount: 3,
        minParticipants: 2,
        maxParticipants: 4,
      });
      expect(result).toMatchObject({
        aiChatRequestId: 'request-1',
        requestType: AiChatRequestType.ROOM_CREATE,
        requestStatus: AiChatRequestStatus.COMPLETED,
        assistantMessage: {
          aiChatRequestId: 'request-1',
          senderType: AiChatMessageSenderType.ASSISTANT,
          messageType: AiChatMessageType.COMMAND_RESULT,
          content: expect.stringContaining('방 생성을 완료'),
          metadata: {
            gameRoomId: 'room-1',
            roomStatus: 'WAITING',
          },
        },
        commandResult: {
          commandType: AiChatRequestType.ROOM_CREATE,
          status: AiChatCommandResultStatus.SUCCESS,
          apiPath: '/v1/game-rooms',
          gameRoomId: 'room-1',
          title: '표준 입력 계산기',
          participants: null,
          started: false,
        },
      });
    });

    it('continues pending ROOM_CREATE after game end when the session still references a finished room', async () => {
      aiChatSessionRepository.findOne.mockResolvedValue({
        id: sessionId,
        requesterUserId: user.userId,
        gameRoomId: 'finished-room-1',
      } as AiChatSession);
      gameRoomRepository.findOne.mockResolvedValue({
        id: 'finished-room-1',
        status: GameRoomStatus.FINISHED,
      });
      llmIntentParser.parseUserMessage.mockResolvedValue({
        requestType: 'ROOM_CREATE',
        payload: {},
      });
      llmFollowUpGenerator.generateCommandFollowUp.mockRejectedValueOnce(
        new Error('follow-up unavailable'),
      );
      gameRoomMissionsService.listSelectableMissionTemplates.mockResolvedValueOnce([
        {
          templateId: 'template-stdin-calculator',
          title: '표준 입력 계산기',
          description: '표준 입력으로 계산식을 처리하는 미션입니다.',
          difficulty: 'EASY',
        },
      ]);
      aiChatRequestRepository.find.mockResolvedValue([
        {
          requestPayload: {
            command: {
              requestType: AiChatRequestType.ROOM_CREATE,
              desiredDifficulty: 'EASY',
            },
          },
          responsePayload: {
            commandResult: {
              status: AiChatCommandResultStatus.PENDING,
              gameRoomId: null,
            },
          },
          requestedAt: new Date('2026-05-04T00:10:00Z'),
        } as unknown as AiChatRequest,
      ]);
      mockTransactions();
      gameRoomMissionsService.validateMissionTemplateSelection.mockResolvedValue({
        id: 'template-stdin-calculator',
      } as never);
      gameRoomsService.createRoom.mockResolvedValue({
        id: 'room-2',
      } as never);

      const result = await service.createMessage(user, sessionId, {
        message: '표준 입력 계산기 템플릿으로 진행할게요.',
      });

      expect(llmIntentParser.parseUserMessage).toHaveBeenCalledWith({
        message: '표준 입력 계산기 템플릿으로 진행할게요.',
        gameRoomId: null,
      });
      expect(gameRoomMissionsService.validateMissionTemplateSelection).toHaveBeenCalledWith(
        'EASY',
        'template-stdin-calculator',
      );
      expect(gameRoomsService.createRoom).toHaveBeenCalledWith({
        ownerUserId: user.userId,
        difficulty: 'EASY',
        timeLimitSeconds: 30,
        maxStrikeCount: 3,
        minParticipants: 2,
        maxParticipants: 4,
      });
      expect(result).toMatchObject({
        requestType: AiChatRequestType.ROOM_CREATE,
        requestStatus: AiChatRequestStatus.COMPLETED,
        commandResult: {
          commandType: AiChatRequestType.ROOM_CREATE,
          status: AiChatCommandResultStatus.SUCCESS,
          gameRoomId: 'room-2',
          title: '표준 입력 계산기',
        },
      });
    });

    it('executes ROOM_JOIN through the participant service when invitation context is available', async () => {
      llmIntentParser.parseUserMessage.mockResolvedValue({
        requestType: 'ROOM_JOIN',
        payload: {},
      });
      mockTransactions();
      participantRepository.findOne.mockResolvedValueOnce({
        id: 'participant-1',
        gameRoomId: 'room-1',
        userId: user.userId,
      } as GameRoomParticipantEntity);
      gameRoomParticipantsService.acceptInvitation.mockResolvedValue({
        id: 'participant-1',
        gameRoomId: 'room-1',
        userId: user.userId,
      } as GameRoomParticipantEntity);
      participantRepository.find.mockResolvedValue([
        {
          id: 'participant-owner',
          gameRoomId: 'room-1',
          userId: 'owner-1',
        } as GameRoomParticipantEntity,
        {
          id: 'participant-1',
          gameRoomId: 'room-1',
          userId: user.userId,
        } as GameRoomParticipantEntity,
      ]);
      userRepository.find.mockResolvedValue([
        { id: 'owner-1', nickname: 'owner' } as User,
        { id: user.userId, nickname: 'player1' } as User,
      ]);

      const result = await service.createMessage(user, sessionId, {
        message: '초대 수락할게',
      });

      expect(gameRoomParticipantsService.acceptInvitation).toHaveBeenCalledWith({
        actorUserId: user.userId,
        participantId: 'participant-1',
      });
      expect(result).toMatchObject({
        requestType: AiChatRequestType.ROOM_JOIN,
        requestStatus: AiChatRequestStatus.COMPLETED,
        commandResult: {
          commandType: AiChatRequestType.ROOM_JOIN,
          status: AiChatCommandResultStatus.SUCCESS,
          apiPath: '/v1/game-room-participants/participant-1/join',
          gameRoomId: 'room-1',
          participants: ['owner', 'player1'],
        },
      });
    });

    it('starts the game from the mission template selected during successful ROOM_CREATE', async () => {
      aiChatSessionRepository.findOne.mockResolvedValue({
        id: sessionId,
        requesterUserId: user.userId,
        gameRoomId: 'room-1',
      } as AiChatSession);
      llmIntentParser.parseUserMessage.mockResolvedValue({
        requestType: 'GAME_START',
        payload: {},
      });
      mockTransactions();
      aiChatRequestRepository.find.mockResolvedValue([
        {
          requestPayload: {
            command: {
              requestType: AiChatRequestType.ROOM_CREATE,
              desiredDifficulty: 'EASY',
              missionTemplateId: 'template-1',
            },
          },
          responsePayload: {
            commandResult: {
              status: AiChatCommandResultStatus.SUCCESS,
              gameRoomId: 'room-1',
            },
          },
          requestedAt: new Date(),
        } as unknown as AiChatRequest,
      ]);
      gameStartFlowService.startGame.mockResolvedValue({
        gameRoom: { id: 'room-1' },
        gameRoomMission: { id: 'mission-1' },
        currentTurn: { id: 'turn-1' },
        currentStep: { id: 'step-1' },
      } as never);
      participantRepository.find.mockResolvedValue([
        {
          id: 'participant-owner',
          gameRoomId: 'room-1',
          userId: user.userId,
        } as GameRoomParticipantEntity,
      ]);
      userRepository.find.mockResolvedValue([
        { id: user.userId, nickname: 'player1' } as User,
      ]);

      const result = await service.createMessage(user, sessionId, {
        message: '게임 시작할게',
      });

      expect(gameStartFlowService.startGame).toHaveBeenCalledWith({
        actorUserId: user.userId,
        gameRoomId: 'room-1',
        missionTemplateId: 'template-1',
      });
      expect(result).toMatchObject({
        requestType: AiChatRequestType.GAME_START,
        requestStatus: AiChatRequestStatus.COMPLETED,
        commandResult: {
          commandType: AiChatRequestType.GAME_START,
          status: AiChatCommandResultStatus.SUCCESS,
          gameRoomId: 'room-1',
          started: true,
        },
      });
    });

    it('returns FAILED commandResult when room lifecycle validation rejects the command', async () => {
      aiChatSessionRepository.findOne.mockResolvedValue({
        id: sessionId,
        requesterUserId: user.userId,
        gameRoomId: 'room-1',
      } as AiChatSession);
      llmIntentParser.parseUserMessage.mockResolvedValue({
        requestType: 'GAME_START',
        payload: {},
      });
      mockTransactions();
      aiChatRequestRepository.find.mockResolvedValue([
        {
          requestPayload: {
            command: {
              requestType: AiChatRequestType.ROOM_CREATE,
              desiredDifficulty: 'EASY',
              missionTemplateId: 'template-1',
            },
          },
          responsePayload: {
            commandResult: {
              status: AiChatCommandResultStatus.SUCCESS,
              gameRoomId: 'room-1',
            },
          },
          requestedAt: new Date(),
        } as unknown as AiChatRequest,
      ]);
      gameStartFlowService.startGame.mockRejectedValue(
        new HttpException(
          {
            code: 'ROOM_START_CONDITION_NOT_MET',
            message: 'Game start conditions are not satisfied',
          },
          HttpStatus.CONFLICT,
        ),
      );

      const result = await service.createMessage(user, sessionId, {
        message: '게임 바로 시작해',
      });

      expect(result.requestStatus).toBe(AiChatRequestStatus.FAILED);
      expect(result.assistantMessage.content).toBe('Game start conditions are not satisfied');
      expect(result.commandResult).toMatchObject({
        commandType: AiChatRequestType.GAME_START,
        status: AiChatCommandResultStatus.FAILED,
        gameRoomId: 'room-1',
      });
    });

    it('does not create a room when mission template validation fails', async () => {
      llmIntentParser.parseUserMessage.mockResolvedValue({
        requestType: 'ROOM_CREATE',
        payload: {
          desiredDifficulty: 'EASY',
          missionTemplateId: 'template-missing',
        },
      });
      mockTransactions();
      gameRoomMissionsService.validateMissionTemplateSelection.mockRejectedValue(
        new HttpException(
          {
            code: 'MISSION_TEMPLATE_NOT_FOUND',
            message: 'Mission template was not found.',
          },
          HttpStatus.NOT_FOUND,
        ),
      );

      const result = await service.createMessage(user, sessionId, {
        message: '없는 템플릿으로 방 만들어줘',
      });

      expect(gameRoomsService.createRoom).not.toHaveBeenCalled();
      expect(result.requestStatus).toBe(AiChatRequestStatus.FAILED);
      expect(result.commandResult).toMatchObject({
        commandType: AiChatRequestType.ROOM_CREATE,
        status: AiChatCommandResultStatus.FAILED,
      });
    });

    it('uses batch invite execution so invite failures do not partially persist inside ai-chat flow', async () => {
      llmIntentParser.parseUserMessage.mockResolvedValue({
        requestType: 'USER_INVITE',
        payload: { inviteeNicknames: ['player2', 'player3'] },
      });
      mockTransactions();
      aiChatSessionRepository.findOne.mockResolvedValue({
        id: sessionId,
        requesterUserId: user.userId,
        gameRoomId: 'room-1',
      } as AiChatSession);
      userRepository.find.mockResolvedValue([
        { id: 'user-2', nickname: 'player2' } as User,
        { id: 'user-3', nickname: 'player3' } as User,
      ]);
      gameRoomParticipantsService.inviteParticipants.mockResolvedValue([
        {
          id: 'participant-2',
          gameRoomId: 'room-1',
          userId: 'user-2',
        } as GameRoomParticipantEntity,
        {
          id: 'participant-3',
          gameRoomId: 'room-1',
          userId: 'user-3',
        } as GameRoomParticipantEntity,
      ] as never);

      const result = await service.createMessage(user, sessionId, {
        message: 'player2, player3 초대해줘',
      });

      expect(gameRoomParticipantsService.inviteParticipants).toHaveBeenCalledWith({
        actorUserId: user.userId,
        gameRoomId: 'room-1',
        invitedUserIds: ['user-2', 'user-3'],
      });
      expect(gameRoomParticipantsService.inviteParticipant).not.toHaveBeenCalled();
      expect(result.commandResult).toMatchObject({
        commandType: AiChatRequestType.USER_INVITE,
        status: AiChatCommandResultStatus.SUCCESS,
        participants: ['player2', 'player3'],
      });
    });

    it('resolves owner fallback only against WAITING rooms', async () => {
      llmIntentParser.parseUserMessage.mockResolvedValue({
        requestType: 'USER_INVITE',
        payload: { inviteeNicknames: ['player2'] },
      });
      mockTransactions();
      participantRepository.findOne.mockResolvedValue({
        gameRoomId: 'waiting-room-1',
      } as GameRoomParticipantEntity);
      userRepository.find.mockResolvedValue([
        { id: 'user-2', nickname: 'player2' } as User,
      ]);
      gameRoomParticipantsService.inviteParticipants.mockResolvedValue([
        {
          id: 'participant-2',
          gameRoomId: 'waiting-room-1',
          userId: 'user-2',
        } as GameRoomParticipantEntity,
      ] as never);

      const result = await service.createMessage(user, sessionId, {
        message: 'player2 초대해줘',
      });

      expect(participantRepository.findOne).toHaveBeenCalledWith({
        relations: { gameRoom: true },
        where: {
          userId: user.userId,
          role: 'OWNER',
          membershipStatus: 'JOINED',
          gameRoom: {
            status: 'WAITING',
          },
        },
        order: { createdAt: 'DESC' },
      });
      expect(gameRoomParticipantsService.inviteParticipants).toHaveBeenCalledWith({
        actorUserId: user.userId,
        gameRoomId: 'waiting-room-1',
        invitedUserIds: ['user-2'],
      });
      expect(result.commandResult?.gameRoomId).toBe('waiting-room-1');
    });

    it('returns FAILED clarification without downstream command execution', async () => {
      llmIntentParser.parseUserMessage.mockResolvedValue({
        requestType: null,
        confidence: 'low',
        assistantHint: '무엇을 도와드릴까요?',
      });

      const { requestRepo, messageRepo } = mockTransactions();

      const result = await service.createMessage(user, sessionId, {
        message: '안녕하세요',
      });

      expect(dataSource.transaction).toHaveBeenCalledTimes(2);
      expect(requestRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: AiChatRequestStatus.FAILED,
          responsePayload: expect.objectContaining({ parseOutcome: 'ambiguous' }),
        }),
      );
      expect(messageRepo.save).toHaveBeenCalledTimes(2);
      expect(result.assistantMessage.content).toBe('무엇을 도와드릴까요?');
      expect(result.requestStatus).toBe(AiChatRequestStatus.FAILED);
    });

    it('does not expose unsafe assistantHint in FAILED clarification response', async () => {
      llmIntentParser.parseUserMessage.mockResolvedValue({
        requestType: null,
        confidence: 'low',
        assistantHint: 'Bearer sk-secret1234567890 leaked',
      });

      const { messageRepo } = mockTransactions();

      const result = await service.createMessage(user, sessionId, {
        message: '안녕하세요',
      });

      expect(result.assistantMessage.content).toBe(DEFAULT_CLARIFICATION_MESSAGE);
      expect(result.assistantMessage.content).not.toContain('Bearer');
      expect(messageRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          messageType: AiChatMessageType.TEXT,
          content: DEFAULT_CLARIFICATION_MESSAGE,
        }),
      );
    });

    it('persists history then throws AI_CHAT_COMMAND_NOT_SUPPORTED for unsupported LLM intent', async () => {
      const callOrder: string[] = [];
      const llmRaw = {
        requestType: 'SEND_EMAIL',
        payload: { channel: 'email' },
        confidence: 'high' as const,
        assistantHint: '이메일을 보내 드릴게요',
      };
      llmIntentParser.parseUserMessage.mockImplementation(async () => {
        callOrder.push('llm');
        return llmRaw;
      });

      const { requestRepo, messageRepo } = mockTransactions();
      (dataSource.transaction as jest.Mock).mockImplementation(async (callback) => {
        callOrder.push('tx');
        const manager = {
          getRepository: (entity: unknown) => {
            if (entity === AiChatRequest) return requestRepo;
            if (entity === AiChatMessage) return messageRepo;
            throw new Error('Unexpected entity');
          },
        };
        return callback(manager);
      });

      await expect(
        service.createMessage(user, sessionId, { message: '이메일 보내줘' }),
      ).rejects.toMatchObject({
        response: {
          code: AI_CHAT_ERROR.COMMAND_NOT_SUPPORTED,
          message: expect.stringContaining('SEND_EMAIL'),
        },
        status: HttpStatus.BAD_REQUEST,
      });

      expect(callOrder).toEqual(['tx', 'llm', 'tx']);
      expect(dataSource.transaction).toHaveBeenCalledTimes(2);
      expect(messageRepo.save).toHaveBeenCalledTimes(1);
      const saveCalls = (requestRepo.save as jest.Mock).mock.calls;
      const unsupportedSave = saveCalls[saveCalls.length - 1][0];
      expect(unsupportedSave).toMatchObject({
        requestType: 'UNPARSED',
        status: AiChatRequestStatus.FAILED,
        requestPayload: { llmRaw },
        responsePayload: {
          parseOutcome: 'unsupported',
          errorCode: AI_CHAT_ERROR.COMMAND_NOT_SUPPORTED,
          rawRequestType: 'SEND_EMAIL',
          llmRaw,
        },
      });
    });

    it('returns 404 when posting to a session not owned by the user', async () => {
      aiChatSessionRepository.findOne.mockResolvedValue(null);

      await expect(
        service.createMessage(user, sessionId, { message: 'hello' }),
      ).rejects.toBeInstanceOf(HttpException);
    });
  });
});
