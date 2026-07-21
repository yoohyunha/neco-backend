import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  AiGameRequestStatus,
  AiGameRequestType,
  AiGameSessionStatus,
  AiRealtimeDeliveryStatus,
  AiRealtimeEventType,
} from '@shared/enums';
import { AiGameRequest } from './entity/ai-game-request.entity';
import { AiGameSession } from './entity/ai-game-session.entity';
import { AiRealtimeEvent } from './entity/ai-realtime-event.entity';

const DEFAULT_AI_GAME_PROVIDER = 'openai';
const DEFAULT_AI_GAME_MODEL = 'gpt-5_4-mini-2026-03-17';

export interface StartAiGameRequestInput {
  aiGameSessionId: string;
  requestType: AiGameRequestType;
  requestPayload: Record<string, unknown>;
  turnId?: string | null;
  missionId?: string | null;
  requestedAt?: Date;
}

export interface AppendAiRealtimeEventInput {
  aiGameRequestId: string;
  aiGameSessionId: string;
  gameRoomId: string;
  eventType: AiRealtimeEventType;
  message: string;
  targetUserId?: string | null;
  payloadJson?: Record<string, unknown> | null;
  deliveryStatus?: AiRealtimeDeliveryStatus;
  occurredAt?: Date;
  deliveredAt?: Date | null;
}

@Injectable()
export class AiGameSessionsService {
  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(AiGameSession)
    private readonly aiGameSessionRepository: Repository<AiGameSession>,
    @InjectRepository(AiGameRequest)
    private readonly aiGameRequestRepository: Repository<AiGameRequest>,
    @InjectRepository(AiRealtimeEvent)
    private readonly aiRealtimeEventRepository: Repository<AiRealtimeEvent>,
  ) {}

  async ensureActiveSession(gameRoomId: string): Promise<AiGameSession> {
    const existingActiveSession = await this.aiGameSessionRepository.findOne({
      where: {
        gameRoomId,
        status: AiGameSessionStatus.ACTIVE,
      },
      order: { createdAt: 'DESC' },
    });

    if (existingActiveSession) {
      return existingActiveSession;
    }

    const session = this.aiGameSessionRepository.create({
      gameRoomId,
      providerConversationId: null,
      provider: DEFAULT_AI_GAME_PROVIDER,
      llmModel:
        this.configService.get<string>('llm.model') ?? DEFAULT_AI_GAME_MODEL,
      status: AiGameSessionStatus.ACTIVE,
      closedAt: null,
    });

    return this.aiGameSessionRepository.save(session);
  }

  async startRequest(input: StartAiGameRequestInput): Promise<AiGameRequest> {
    const requestedAt = input.requestedAt ?? new Date();
    const request = this.aiGameRequestRepository.create({
      aiGameSessionId: input.aiGameSessionId,
      requestType: input.requestType,
      turnId: input.turnId ?? null,
      missionId: input.missionId ?? null,
      requestPayload: input.requestPayload,
      responsePayload: null,
      status: AiGameRequestStatus.RECEIVED,
      requestedAt,
      respondedAt: null,
    });

    return this.aiGameRequestRepository.save(request);
  }

  async completeRequest(
    requestId: string,
    responsePayload: Record<string, unknown>,
    respondedAt: Date = new Date(),
  ): Promise<AiGameRequest> {
    const request = await this.requireRequest(requestId);
    request.status = AiGameRequestStatus.COMPLETED;
    request.responsePayload = responsePayload;
    request.respondedAt = respondedAt;
    return this.aiGameRequestRepository.save(request);
  }

  async failRequest(
    requestId: string,
    responsePayload: Record<string, unknown> | null = null,
    respondedAt: Date = new Date(),
  ): Promise<AiGameRequest> {
    const request = await this.requireRequest(requestId);
    request.status = AiGameRequestStatus.FAILED;
    request.responsePayload = responsePayload;
    request.respondedAt = respondedAt;
    return this.aiGameRequestRepository.save(request);
  }

  async appendRealtimeEvent(
    input: AppendAiRealtimeEventInput,
  ): Promise<AiRealtimeEvent> {
    const occurredAt = input.occurredAt ?? new Date();
    const deliveryStatus =
      input.deliveryStatus ?? AiRealtimeDeliveryStatus.PENDING;
    const event = this.aiRealtimeEventRepository.create({
      aiGameRequestId: input.aiGameRequestId,
      aiGameSessionId: input.aiGameSessionId,
      gameRoomId: input.gameRoomId,
      eventType: input.eventType,
      targetUserId: input.targetUserId ?? null,
      message: input.message,
      payloadJson: input.payloadJson ?? null,
      deliveryStatus,
      occurredAt,
      deliveredAt:
        input.deliveredAt ??
        (deliveryStatus === AiRealtimeDeliveryStatus.SENT ? occurredAt : null),
    });

    return this.aiRealtimeEventRepository.save(event);
  }

  private async requireRequest(requestId: string): Promise<AiGameRequest> {
    const request = await this.aiGameRequestRepository.findOne({
      where: { id: requestId },
    });

    if (!request) {
      throw new NotFoundException({
        code: 'AI_GAME_REQUEST_NOT_FOUND',
        message: 'AI game request was not found.',
      });
    }

    return request;
  }
}
