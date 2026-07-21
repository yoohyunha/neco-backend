import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import {
  AiGameRequestStatus,
  AiGameRequestType,
  AiGameSessionStatus,
  AiRealtimeDeliveryStatus,
  AiRealtimeEventType,
} from '@shared/enums';
import { AiGameSessionsService } from './ai-game-sessions.service';
import { AiGameRequest } from './entity/ai-game-request.entity';
import { AiGameSession } from './entity/ai-game-session.entity';
import { AiRealtimeEvent } from './entity/ai-realtime-event.entity';

describe('AiGameSessionsService', () => {
  let configService: jest.Mocked<Pick<ConfigService, 'get'>>;
  let aiGameSessionRepository: jest.Mocked<Repository<AiGameSession>>;
  let aiGameRequestRepository: jest.Mocked<Repository<AiGameRequest>>;
  let aiRealtimeEventRepository: jest.Mocked<Repository<AiRealtimeEvent>>;
  let service: AiGameSessionsService;

  beforeEach(() => {
    configService = {
      get: jest.fn().mockReturnValue('gpt-5_4-mini-2026-03-17'),
    };

    aiGameSessionRepository = {
      findOne: jest.fn(),
      create: jest.fn((value) => value as AiGameSession),
      save: jest.fn(async (value) => ({
        id: 'session-1',
        createdAt: new Date('2026-07-21T00:00:00.000Z'),
        updatedAt: new Date('2026-07-21T00:00:00.000Z'),
        ...value,
      }) as AiGameSession),
    } as unknown as jest.Mocked<Repository<AiGameSession>>;

    aiGameRequestRepository = {
      findOne: jest.fn(),
      create: jest.fn((value) => value as AiGameRequest),
      save: jest.fn(async (value) => {
        if ('id' in value && value.id) {
          return value as AiGameRequest;
        }

        return {
          id: 'request-1',
          createdAt: new Date('2026-07-21T00:00:00.000Z'),
          updatedAt: new Date('2026-07-21T00:00:00.000Z'),
          ...value,
        } as AiGameRequest;
      }),
    } as unknown as jest.Mocked<Repository<AiGameRequest>>;

    aiRealtimeEventRepository = {
      create: jest.fn((value) => value as AiRealtimeEvent),
      save: jest.fn(async (value) => ({
        id: 'event-1',
        createdAt: new Date('2026-07-21T00:00:00.000Z'),
        ...value,
      }) as AiRealtimeEvent),
    } as unknown as jest.Mocked<Repository<AiRealtimeEvent>>;

    service = new AiGameSessionsService(
      configService as unknown as ConfigService,
      aiGameSessionRepository,
      aiGameRequestRepository,
      aiRealtimeEventRepository,
    );
  });

  describe('ensureActiveSession', () => {
    it('reuses an existing ACTIVE session for the room', async () => {
      const existing = {
        id: 'session-existing',
        gameRoomId: 'room-1',
        providerConversationId: null,
        provider: 'openai',
        llmModel: 'gpt-5_4-mini-2026-03-17',
        status: AiGameSessionStatus.ACTIVE,
        closedAt: null,
      } as AiGameSession;
      aiGameSessionRepository.findOne.mockResolvedValue(existing);

      const result = await service.ensureActiveSession('room-1');

      expect(result).toBe(existing);
      expect(aiGameSessionRepository.findOne).toHaveBeenCalledWith({
        where: {
          gameRoomId: 'room-1',
          status: AiGameSessionStatus.ACTIVE,
        },
        order: { createdAt: 'DESC' },
      });
      expect(aiGameSessionRepository.save).not.toHaveBeenCalled();
    });

    it('creates a new ACTIVE session when none exists', async () => {
      aiGameSessionRepository.findOne.mockResolvedValue(null);

      const result = await service.ensureActiveSession('room-1');

      expect(aiGameSessionRepository.create).toHaveBeenCalledWith({
        gameRoomId: 'room-1',
        providerConversationId: null,
        provider: 'openai',
        llmModel: 'gpt-5_4-mini-2026-03-17',
        status: AiGameSessionStatus.ACTIVE,
        closedAt: null,
      });
      expect(result).toEqual(
        expect.objectContaining({
          id: 'session-1',
          gameRoomId: 'room-1',
          provider: 'openai',
          status: AiGameSessionStatus.ACTIVE,
        }),
      );
    });

    it('falls back to the default model when llm config is missing', async () => {
      configService.get.mockReturnValue(undefined);
      aiGameSessionRepository.findOne.mockResolvedValue(null);

      await service.ensureActiveSession('room-1');

      expect(aiGameSessionRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          llmModel: 'gpt-5_4-mini-2026-03-17',
        }),
      );
    });
  });

  describe('request lifecycle', () => {
    it('starts a request as RECEIVED', async () => {
      const requestedAt = new Date('2026-07-21T01:00:00.000Z');

      const result = await service.startRequest({
        aiGameSessionId: 'session-1',
        requestType: AiGameRequestType.JUDGE,
        turnId: 'turn-1',
        missionId: 'mission-1',
        requestPayload: { judgeStatus: 'PASSED' },
        requestedAt,
      });

      expect(aiGameRequestRepository.create).toHaveBeenCalledWith({
        aiGameSessionId: 'session-1',
        requestType: AiGameRequestType.JUDGE,
        turnId: 'turn-1',
        missionId: 'mission-1',
        requestPayload: { judgeStatus: 'PASSED' },
        responsePayload: null,
        status: AiGameRequestStatus.RECEIVED,
        requestedAt,
        respondedAt: null,
      });
      expect(result.status).toBe(AiGameRequestStatus.RECEIVED);
      expect(result.id).toBe('request-1');
    });

    it('completes a request with response payload', async () => {
      const existing = {
        id: 'request-1',
        aiGameSessionId: 'session-1',
        requestType: AiGameRequestType.JUDGE,
        turnId: 'turn-1',
        missionId: 'mission-1',
        requestPayload: { judgeStatus: 'PASSED' },
        responsePayload: null,
        status: AiGameRequestStatus.RECEIVED,
        requestedAt: new Date('2026-07-21T01:00:00.000Z'),
        respondedAt: null,
        createdAt: new Date('2026-07-21T01:00:00.000Z'),
        updatedAt: new Date('2026-07-21T01:00:00.000Z'),
      } as AiGameRequest;
      aiGameRequestRepository.findOne.mockResolvedValue(existing);
      const respondedAt = new Date('2026-07-21T01:00:05.000Z');

      const result = await service.completeRequest(
        'request-1',
        { feedbackMessage: '통과했습니다.' },
        respondedAt,
      );

      expect(result.status).toBe(AiGameRequestStatus.COMPLETED);
      expect(result.responsePayload).toEqual({
        feedbackMessage: '통과했습니다.',
      });
      expect(result.respondedAt).toBe(respondedAt);
      expect(aiGameRequestRepository.save).toHaveBeenCalledWith(existing);
    });

    it('fails a request with optional response payload', async () => {
      const existing = {
        id: 'request-1',
        aiGameSessionId: 'session-1',
        requestType: AiGameRequestType.JUDGE,
        turnId: null,
        missionId: null,
        requestPayload: { judgeStatus: 'FAILED' },
        responsePayload: null,
        status: AiGameRequestStatus.RECEIVED,
        requestedAt: new Date('2026-07-21T01:00:00.000Z'),
        respondedAt: null,
        createdAt: new Date('2026-07-21T01:00:00.000Z'),
        updatedAt: new Date('2026-07-21T01:00:00.000Z'),
      } as AiGameRequest;
      aiGameRequestRepository.findOne.mockResolvedValue(existing);
      const respondedAt = new Date('2026-07-21T01:00:05.000Z');

      const result = await service.failRequest(
        'request-1',
        { error: 'timeout' },
        respondedAt,
      );

      expect(result.status).toBe(AiGameRequestStatus.FAILED);
      expect(result.responsePayload).toEqual({ error: 'timeout' });
      expect(result.respondedAt).toBe(respondedAt);
    });

    it('throws when completing an unknown request', async () => {
      aiGameRequestRepository.findOne.mockResolvedValue(null);

      await expect(
        service.completeRequest('missing', { ok: true }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('appendRealtimeEvent', () => {
    it('defaults deliveryStatus to PENDING without deliveredAt', async () => {
      const occurredAt = new Date('2026-07-21T01:00:10.000Z');

      await service.appendRealtimeEvent({
        aiGameRequestId: 'request-1',
        aiGameSessionId: 'session-1',
        gameRoomId: 'room-1',
        eventType: AiRealtimeEventType.MISSION_FEEDBACK,
        message: '현재 미션 단계를 통과했습니다.',
        occurredAt,
      });

      expect(aiRealtimeEventRepository.create).toHaveBeenCalledWith({
        aiGameRequestId: 'request-1',
        aiGameSessionId: 'session-1',
        gameRoomId: 'room-1',
        eventType: AiRealtimeEventType.MISSION_FEEDBACK,
        targetUserId: null,
        message: '현재 미션 단계를 통과했습니다.',
        payloadJson: null,
        deliveryStatus: AiRealtimeDeliveryStatus.PENDING,
        occurredAt,
        deliveredAt: null,
      });
    });

    it('persists SENT delivery with deliveredAt defaulted to occurredAt', async () => {
      const occurredAt = new Date('2026-07-21T01:00:10.000Z');

      const result = await service.appendRealtimeEvent({
        aiGameRequestId: 'request-1',
        aiGameSessionId: 'session-1',
        gameRoomId: 'room-1',
        eventType: AiRealtimeEventType.MISSION_FEEDBACK,
        message: '현재 미션 단계를 통과했습니다.',
        occurredAt,
        deliveryStatus: AiRealtimeDeliveryStatus.SENT,
      });

      expect(aiRealtimeEventRepository.create).toHaveBeenCalledWith({
        aiGameRequestId: 'request-1',
        aiGameSessionId: 'session-1',
        gameRoomId: 'room-1',
        eventType: AiRealtimeEventType.MISSION_FEEDBACK,
        targetUserId: null,
        message: '현재 미션 단계를 통과했습니다.',
        payloadJson: null,
        deliveryStatus: AiRealtimeDeliveryStatus.SENT,
        occurredAt,
        deliveredAt: occurredAt,
      });
      expect(result.id).toBe('event-1');
    });

    it('persists FAILED delivery without inventing deliveredAt', async () => {
      const occurredAt = new Date('2026-07-21T01:00:10.000Z');

      await service.appendRealtimeEvent({
        aiGameRequestId: 'request-1',
        aiGameSessionId: 'session-1',
        gameRoomId: 'room-1',
        eventType: AiRealtimeEventType.MISSION_FEEDBACK,
        message: '피드백 전달 실패',
        occurredAt,
        deliveryStatus: AiRealtimeDeliveryStatus.FAILED,
      });

      expect(aiRealtimeEventRepository.create).toHaveBeenCalledWith({
        aiGameRequestId: 'request-1',
        aiGameSessionId: 'session-1',
        gameRoomId: 'room-1',
        eventType: AiRealtimeEventType.MISSION_FEEDBACK,
        targetUserId: null,
        message: '피드백 전달 실패',
        payloadJson: null,
        deliveryStatus: AiRealtimeDeliveryStatus.FAILED,
        occurredAt,
        deliveredAt: null,
      });
    });
  });
});
