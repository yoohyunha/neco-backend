import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { GameRoomParticipantEntity } from '@modules/game-room-participants/entity/game-room-participant.entity';
import { GameRoomParticipantsService } from '@modules/game-room-participants/service/game-room-participants.service';
import { GameRoomMissionsService } from '@modules/game-room-missions/service/game-room-missions.service';
import { GameRoomEntity } from '@modules/game-rooms/entity/game-room.entity';
import { GameStartFlowService } from '@modules/game-rooms/service/game-start-flow.service';
import { GameRoomsService } from '@modules/game-rooms/service/game-rooms.service';
import { DataSource, FindOptionsWhere, In, Repository } from 'typeorm';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { toSeoulIso } from '../../common/utils/date.util';
import {
  LLM_FOLLOW_UP_GENERATOR,
  type LlmFollowUpGeneratorPort,
} from '../../integrations/llm/llm-follow-up.port';
import {
  LLM_INTENT_PARSER,
  type LlmIntentParserPort,
  type LlmIntentRawResponse,
} from '../../integrations/llm/llm-intent-parser.port';
import {
  AiChatSessionStatus,
  AiChatMessageSenderType,
  AiChatMessageType,
  AiChatRequestStatus,
  AiChatRequestType,
} from '../../shared/enums/ai-chat.enum';
import {
  GameRoomParticipantMembershipStatus,
  GameRoomParticipantRole,
  GameRoomStatus,
} from '../../shared/enums/game-room.enum';
import type { AiChatCommandResultDto } from '../../shared/dto/ai-chat-command.dto';
import {
  AiChatCommandResultStatus,
  type AiChatCommandDto,
  type GameStartCommandDto,
  type RoomCreateCommandDto,
  type RoomJoinCommandDto,
  type UserInviteCommandDto,
  type UserInviteDenyCommandDto,
} from '../../shared/dto/ai-chat-command.dto';
import { User } from '../auth/entity/user.entity';
import { AI_CHAT_REQUEST_TYPE_UNPARSED } from './constants/ai-chat-internal.constants';
import {
  AI_CHAT_ERROR,
  throwAiChatError,
  throwForbiddenAccess,
} from './constants/ai-chat-error.constants';
import { CreateAiChatMessageDto } from './dto/create-ai-chat-message.dto';
import { ListAiChatSessionsQueryDto } from './dto/list-ai-chat-sessions-query.dto';
import { AiChatMessage } from './entity/ai-chat-message.entity';
import { AiChatRequest } from './entity/ai-chat-request.entity';
import { AiChatSession } from './entity/ai-chat-session.entity';
import { buildSafeStaticFollowUpContent } from './intent/ai-chat-assistant-content';
import { AiChatCommandResultMapper } from './intent/ai-chat-command-result.mapper';
import {
  AiChatIntentValidator,
  type IntentValidationUnsupported,
} from './intent/ai-chat-intent.validator';

export interface AiChatSessionListItem {
  aiChatSessionId: string;
  requesterUserId: string;
  gameRoomId: string | null;
  status: string;
  provider: string;
  llmModel: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface AiChatMessageItem {
  messageId: string;
  aiChatRequestId: string | null;
  senderType: string;
  messageType: string;
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

/** Matches docs/etc/api-spec.md §9 POST messages success schema. */
export interface CreateAiChatMessageResult {
  aiChatRequestId: string;
  /** Required when requestStatus is COMPLETED or FAILED; omitted when RECEIVED. */
  requestType?: string;
  requestStatus: string;
  userMessage: AiChatMessageItem;
  assistantMessage: AiChatMessageItem;
  commandResult: AiChatCommandResultDto | null;
}

interface CommandExecutionOutcome {
  requestStatus: AiChatRequestStatus;
  command: AiChatCommandDto;
  commandResult: AiChatCommandResultDto;
  nextSessionGameRoomId: string | null;
  followUpGameRoomId: string | null;
  failureMessage?: string;
  failureCode?: string;
}

interface PendingRoomCreateContext {
  desiredDifficulty: NonNullable<RoomCreateCommandDto['desiredDifficulty']>;
}

const DEFAULT_ROOM_CREATE_SETTINGS = {
  timeLimitSeconds: 30,
  maxStrikeCount: 3,
  minParticipants: 2,
  maxParticipants: 4,
} as const;
const DEFAULT_AI_CHAT_PROVIDER = 'openai';
const DEFAULT_AI_CHAT_MODEL = 'gpt-4o';

@Injectable()
export class AiChatSessionsService {
  private readonly intentValidator = new AiChatIntentValidator();
  private readonly commandResultMapper = new AiChatCommandResultMapper();

  constructor(
    @InjectRepository(AiChatSession)
    private readonly aiChatSessionRepository: Repository<AiChatSession>,
    @InjectRepository(AiChatMessage)
    private readonly aiChatMessageRepository: Repository<AiChatMessage>,
    @InjectRepository(AiChatRequest)
    private readonly aiChatRequestRepository: Repository<AiChatRequest>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(GameRoomParticipantEntity)
    private readonly participantRepository: Repository<GameRoomParticipantEntity>,
    private readonly dataSource: DataSource,
    private readonly gameRoomsService: GameRoomsService,
    private readonly gameStartFlowService: GameStartFlowService,
    private readonly gameRoomMissionsService: GameRoomMissionsService,
    private readonly gameRoomParticipantsService: GameRoomParticipantsService,
    @Inject(LLM_INTENT_PARSER)
    private readonly llmIntentParser: LlmIntentParserPort,
    @Inject(LLM_FOLLOW_UP_GENERATOR)
    private readonly llmFollowUpGenerator: LlmFollowUpGeneratorPort,
  ) {}

  async listSessions(
    user: AuthenticatedUser,
    query: ListAiChatSessionsQueryDto,
  ): Promise<AiChatSessionListItem[]> {
    if (query.userId && query.userId !== user.userId) {
      throwForbiddenAccess('userId does not match the authenticated user');
    }

    await this.ensureActiveSession(user.userId);

    const where: FindOptionsWhere<AiChatSession> = {
      requesterUserId: user.userId,
    };

    if (query.gameRoomId) {
      where.gameRoomId = query.gameRoomId;
    }

    const sessions = await this.aiChatSessionRepository.find({
      where,
      order: { createdAt: 'ASC' },
    });

    return sessions.map((session) => this.toSessionListItem(session));
  }

  private async ensureActiveSession(userId: string): Promise<AiChatSession> {
    const existingActiveSession = await this.aiChatSessionRepository.findOne({
      where: {
        requesterUserId: userId,
        status: AiChatSessionStatus.ACTIVE,
      },
      order: { createdAt: 'DESC' },
    });

    if (existingActiveSession) {
      return existingActiveSession;
    }

    const latestSession = await this.aiChatSessionRepository.findOne({
      where: { requesterUserId: userId },
      order: { createdAt: 'DESC' },
    });

    const session = this.aiChatSessionRepository.create({
      requesterUserId: userId,
      gameRoomId: null,
      providerConversationId: null,
      provider: latestSession?.provider ?? DEFAULT_AI_CHAT_PROVIDER,
      llmModel: latestSession?.llmModel ?? DEFAULT_AI_CHAT_MODEL,
      status: AiChatSessionStatus.ACTIVE,
      closedAt: null,
    });

    return this.aiChatSessionRepository.save(session);
  }

  async listMessages(
    user: AuthenticatedUser,
    aiChatSessionId: string,
  ): Promise<AiChatMessageItem[]> {
    const session = await this.requireOwnedSession(user.userId, aiChatSessionId);

    const messages = await this.aiChatMessageRepository.find({
      where: { aiChatSessionId: session.id },
      order: { createdAt: 'ASC' },
    });

    return messages.map((message) => this.toMessageItem(message));
  }

  async createMessage(
    user: AuthenticatedUser,
    aiChatSessionId: string,
    dto: CreateAiChatMessageDto,
  ): Promise<CreateAiChatMessageResult> {
    const session = await this.requireOwnedSession(user.userId, aiChatSessionId);
    const sessionGameRoomId = await this.resolveActiveSessionGameRoomId(session.gameRoomId);
    const resolvedSession =
      sessionGameRoomId === session.gameRoomId
        ? session
        : ({ ...session, gameRoomId: sessionGameRoomId } as AiChatSession);
    const now = new Date();

    const bootstrap = await this.dataSource.transaction(async (manager) =>
      this.persistUserMessageTurn(
        manager.getRepository(AiChatRequest),
        manager.getRepository(AiChatMessage),
        aiChatSessionId,
        user,
        dto.message,
        now,
      ),
    );

    const rawIntent = await this.llmIntentParser.parseUserMessage({
      message: dto.message,
      gameRoomId: resolvedSession.gameRoomId,
    });

    const validation = this.intentValidator.validate(rawIntent);

    if (validation.outcome === 'unsupported') {
      await this.persistUnsupportedRequestHistory(
        bootstrap.savedRequest.id,
        validation,
        rawIntent,
        now,
      );
      throwAiChatError(
        validation.errorCode,
        validation.content,
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.dataSource.transaction(async (manager) => {
      const requestRepo = manager.getRepository(AiChatRequest);
      const messageRepo = manager.getRepository(AiChatMessage);

      const savedRequest = await requestRepo.findOneOrFail({
        where: { id: bootstrap.savedRequest.id },
      });

      if (validation.outcome === 'clarification') {
        return this.finalizeFailedParseTurn(
          requestRepo,
          messageRepo,
          savedRequest,
          bootstrap.savedUserMessage,
          validation.content,
          { parseOutcome: 'ambiguous' },
          now,
        );
      }

      const { assistantHint } = validation;
      const command = await this.resolveCommandWithRoomCreateContext(
        resolvedSession,
        aiChatSessionId,
        validation.command,
        dto.message,
      );
      const execution = await this.executeCommand(user, resolvedSession, command);

      if (execution.requestStatus === AiChatRequestStatus.FAILED) {
        return this.finalizeFailedCommandTurn(
          requestRepo,
          messageRepo,
          savedRequest,
          bootstrap.savedUserMessage,
          execution,
          dto.message,
          rawIntent,
          now,
        );
      }

      const followUp = await this.resolveCommandFollowUp(
        execution.command,
        dto.message,
        assistantHint,
        execution.followUpGameRoomId,
      );
      const commandResult = execution.commandResult;
      const assistantMetadata = await this.resolveAssistantMetadata(
        execution.command,
        commandResult,
        followUp.metadata,
      );

      const sessionRepo = manager.getRepository(AiChatSession);
      const managedSession = await sessionRepo.findOneOrFail({
        where: { id: session.id },
      });

      managedSession.gameRoomId = execution.nextSessionGameRoomId;
      await sessionRepo.save(managedSession);

      savedRequest.requestType = execution.command.requestType;
      savedRequest.requestPayload = {
        message: dto.message,
        command: execution.command,
        llmRaw: rawIntent,
      };
      savedRequest.responsePayload = {
        extractedCommand: execution.command,
        commandResult,
        followUp: {
          source: followUp.followUpSource,
          templateKey: followUp.templateKey,
        },
      };
      savedRequest.status = AiChatRequestStatus.COMPLETED;
      savedRequest.respondedAt = now;
      await requestRepo.save(savedRequest);

      const assistantMessage = messageRepo.create({
        aiChatSessionId,
        aiChatRequestId: savedRequest.id,
        senderType: AiChatMessageSenderType.ASSISTANT,
        senderUserId: null,
        messageType: AiChatMessageType.COMMAND_RESULT,
        content: followUp.content,
        metadataJson: assistantMetadata,
      });
      const savedAssistantMessage = await messageRepo.save(assistantMessage);

      return {
        aiChatRequestId: savedRequest.id,
        requestType: execution.command.requestType,
        requestStatus: AiChatRequestStatus.COMPLETED,
        userMessage: this.toMessageItem(bootstrap.savedUserMessage),
        assistantMessage: this.toMessageItem(savedAssistantMessage),
        commandResult,
      };
    });
  }

  private async resolveActiveSessionGameRoomId(
    gameRoomId: string | null,
  ): Promise<string | null> {
    if (!gameRoomId) {
      return null;
    }

    const room = await this.dataSource.getRepository(GameRoomEntity).findOne({
      where: { id: gameRoomId },
      select: { id: true, status: true },
    });

    if (room?.status === GameRoomStatus.FINISHED) {
      return null;
    }

    return gameRoomId;
  }

  private async persistUnsupportedRequestHistory(
    aiChatRequestId: string,
    validation: IntentValidationUnsupported,
    rawIntent: LlmIntentRawResponse,
    now: Date,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const requestRepo = manager.getRepository(AiChatRequest);
      const savedRequest = await requestRepo.findOneOrFail({
        where: { id: aiChatRequestId },
      });

      savedRequest.requestType = AI_CHAT_REQUEST_TYPE_UNPARSED;
      savedRequest.requestPayload = {
        ...(typeof savedRequest.requestPayload === 'object' && savedRequest.requestPayload !== null
          ? savedRequest.requestPayload
          : {}),
        llmRaw: rawIntent,
      };
      savedRequest.responsePayload = {
        parseOutcome: 'unsupported',
        errorCode: validation.errorCode,
        rawRequestType: validation.rawRequestType,
        llmRaw: rawIntent,
      };
      savedRequest.status = AiChatRequestStatus.FAILED;
      savedRequest.respondedAt = now;
      await requestRepo.save(savedRequest);
    });
  }

  private async persistUserMessageTurn(
    requestRepo: Repository<AiChatRequest>,
    messageRepo: Repository<AiChatMessage>,
    aiChatSessionId: string,
    user: AuthenticatedUser,
    userContent: string,
    now: Date,
  ): Promise<{ savedRequest: AiChatRequest; savedUserMessage: AiChatMessage }> {
    const request = requestRepo.create({
      aiChatSessionId,
      requestType: AI_CHAT_REQUEST_TYPE_UNPARSED,
      sourceMessageId: null,
      requestPayload: { message: userContent },
      responsePayload: null,
      status: AiChatRequestStatus.RECEIVED,
      requestedAt: now,
      respondedAt: null,
    });
    const savedRequest = await requestRepo.save(request);

    const userMessage = messageRepo.create({
      aiChatSessionId,
      aiChatRequestId: savedRequest.id,
      senderType: AiChatMessageSenderType.USER,
      senderUserId: user.userId,
      messageType: AiChatMessageType.TEXT,
      content: userContent,
      metadataJson: null,
    });
    const savedUserMessage = await messageRepo.save(userMessage);

    savedRequest.sourceMessageId = savedUserMessage.id;
    await requestRepo.save(savedRequest);

    return { savedRequest, savedUserMessage };
  }

  private async finalizeFailedParseTurn(
    requestRepo: Repository<AiChatRequest>,
    messageRepo: Repository<AiChatMessage>,
    savedRequest: AiChatRequest,
    savedUserMessage: AiChatMessage,
    assistantContent: string,
    responseMeta: Record<string, unknown>,
    now: Date,
  ): Promise<CreateAiChatMessageResult> {
    const nominalType = AiChatRequestType.ROOM_CREATE;
    const commandResult = this.commandResultMapper.toFailedResult(nominalType);

    savedRequest.requestType = nominalType;
    savedRequest.responsePayload = {
      ...responseMeta,
      commandResult,
    };
    savedRequest.status = AiChatRequestStatus.FAILED;
    savedRequest.respondedAt = now;
    await requestRepo.save(savedRequest);

    const assistantMessage = messageRepo.create({
      aiChatSessionId: savedRequest.aiChatSessionId,
      aiChatRequestId: savedRequest.id,
      senderType: AiChatMessageSenderType.ASSISTANT,
      senderUserId: null,
      messageType: AiChatMessageType.TEXT,
      content: assistantContent,
      metadataJson: { parseOutcome: responseMeta.parseOutcome },
    });
    const savedAssistantMessage = await messageRepo.save(assistantMessage);

    return {
      aiChatRequestId: savedRequest.id,
      requestType: nominalType,
      requestStatus: AiChatRequestStatus.FAILED,
      userMessage: this.toMessageItem(savedUserMessage),
      assistantMessage: this.toMessageItem(savedAssistantMessage),
      commandResult,
    };
  }

  private async finalizeFailedCommandTurn(
    requestRepo: Repository<AiChatRequest>,
    messageRepo: Repository<AiChatMessage>,
    savedRequest: AiChatRequest,
    savedUserMessage: AiChatMessage,
    execution: CommandExecutionOutcome,
    userMessage: string,
    rawIntent: LlmIntentRawResponse,
    now: Date,
  ): Promise<CreateAiChatMessageResult> {
    savedRequest.requestType = execution.command.requestType;
    savedRequest.requestPayload = {
      message: userMessage,
      command: execution.command,
      llmRaw: rawIntent,
    };
    savedRequest.responsePayload = {
      executionErrorCode: execution.failureCode,
      commandResult: execution.commandResult,
    };
    savedRequest.status = AiChatRequestStatus.FAILED;
    savedRequest.respondedAt = now;
    await requestRepo.save(savedRequest);

    const assistantMessage = messageRepo.create({
      aiChatSessionId: savedRequest.aiChatSessionId,
      aiChatRequestId: savedRequest.id,
      senderType: AiChatMessageSenderType.ASSISTANT,
      senderUserId: null,
      messageType: AiChatMessageType.COMMAND_RESULT,
      content: execution.failureMessage ?? '요청을 처리하지 못했습니다.',
      metadataJson: execution.failureCode
        ? { executionErrorCode: execution.failureCode }
        : null,
    });
    const savedAssistantMessage = await messageRepo.save(assistantMessage);

    return {
      aiChatRequestId: savedRequest.id,
      requestType: execution.command.requestType,
      requestStatus: AiChatRequestStatus.FAILED,
      userMessage: this.toMessageItem(savedUserMessage),
      assistantMessage: this.toMessageItem(savedAssistantMessage),
      commandResult: execution.commandResult,
    };
  }

  private async executeCommand(
    user: AuthenticatedUser,
    session: AiChatSession,
    command: AiChatCommandDto,
  ): Promise<CommandExecutionOutcome> {
    switch (command.requestType) {
      case AiChatRequestType.ROOM_CREATE:
        return this.executeRoomCreate(user, session, command);
      case AiChatRequestType.USER_INVITE:
        return this.executeUserInvite(user, session, command);
      case AiChatRequestType.ROOM_JOIN:
        return this.executeRoomJoin(user, session, command);
      case AiChatRequestType.USER_INVITE_DENY:
        return this.executeUserInviteDeny(user, session, command);
      case AiChatRequestType.GAME_START:
        return this.executeGameStart(user, session, command);
      default:
        return {
          requestStatus: AiChatRequestStatus.FAILED,
          command,
          commandResult: this.commandResultMapper.toFailedResult(command),
          nextSessionGameRoomId: session.gameRoomId,
          followUpGameRoomId: session.gameRoomId,
          failureCode: AI_CHAT_ERROR.COMMAND_EXECUTION_FAILED,
          failureMessage: '지원하지 않는 명령 실행입니다.',
        };
    }
  }

  private async executeRoomCreate(
    user: AuthenticatedUser,
    session: AiChatSession,
    command: RoomCreateCommandDto,
  ): Promise<CommandExecutionOutcome> {
    if (!command.desiredDifficulty || !command.missionTemplateId) {
      return {
        requestStatus: AiChatRequestStatus.COMPLETED,
        command,
        commandResult: this.commandResultMapper.toPendingResult(command),
        nextSessionGameRoomId: session.gameRoomId,
        followUpGameRoomId: session.gameRoomId,
      };
    }

    try {
      await this.gameRoomMissionsService.validateMissionTemplateSelection(
        command.desiredDifficulty,
        command.missionTemplateId,
      );

      const gameRoom = await this.gameRoomsService.createRoom({
        ownerUserId: user.userId,
        difficulty: command.desiredDifficulty,
        ...DEFAULT_ROOM_CREATE_SETTINGS,
      });
      return {
        requestStatus: AiChatRequestStatus.COMPLETED,
        command,
        commandResult: this.commandResultMapper.toSuccessResult(command, {
          gameRoomId: gameRoom.id,
          title: command.missionTemplateTitle ?? null,
          participants: null,
          started: false,
        }),
        nextSessionGameRoomId: gameRoom.id,
        followUpGameRoomId: gameRoom.id,
      };
    } catch (error) {
      return this.toFailedExecutionOutcome(command, session.gameRoomId, error);
    }
  }

  private async executeUserInvite(
    user: AuthenticatedUser,
    session: AiChatSession,
    command: UserInviteCommandDto,
  ): Promise<CommandExecutionOutcome> {
    const resolvedGameRoomId =
      command.gameRoomId ??
      session.gameRoomId ??
      (await this.resolveOwnedRoomId(user.userId));

    if (!resolvedGameRoomId) {
      return this.buildStaticExecutionFailure(
        command,
        session.gameRoomId,
        'ROOM_NOT_FOUND',
        '초대할 대기 중인 방을 찾지 못했습니다.',
      );
    }

    const resolvedCommand: UserInviteCommandDto = {
      ...command,
      gameRoomId: resolvedGameRoomId,
    };

    const invitees = await this.resolveInvitees(command.inviteeNicknames, user.userId);
    if ('failure' in invitees) {
      return invitees.failure;
    }

    try {
      await this.gameRoomParticipantsService.inviteParticipants({
        actorUserId: user.userId,
        gameRoomId: resolvedGameRoomId,
        invitedUserIds: invitees.users.map((invitee) => invitee.id),
      });

      return {
        requestStatus: AiChatRequestStatus.COMPLETED,
        command: resolvedCommand,
        commandResult: this.commandResultMapper.toSuccessResult(resolvedCommand, {
          gameRoomId: resolvedGameRoomId,
          participants: invitees.users.map((invitee) => invitee.nickname),
          started: false,
        }),
        nextSessionGameRoomId: resolvedGameRoomId,
        followUpGameRoomId: resolvedGameRoomId,
      };
    } catch (error) {
      return this.toFailedExecutionOutcome(resolvedCommand, resolvedGameRoomId, error);
    }
  }

  private async executeRoomJoin(
    user: AuthenticatedUser,
    session: AiChatSession,
    command: RoomJoinCommandDto,
  ): Promise<CommandExecutionOutcome> {
    const invitation = await this.resolveInvitationForCommand(user.userId, session, command);
    if (!invitation) {
      return this.buildStaticExecutionFailure(
        command,
        session.gameRoomId,
        'INVITATION_NOT_FOUND',
        '수락할 초대를 찾지 못했습니다.',
      );
    }

    const resolvedCommand: RoomJoinCommandDto = {
      ...command,
      gameRoomId: invitation.gameRoomId,
      participantId: invitation.id,
    };

    try {
      const participant = await this.gameRoomParticipantsService.acceptInvitation({
        actorUserId: user.userId,
        participantId: invitation.id,
      });
      const participantNames = await this.listParticipantNicknames(
        participant.gameRoomId,
        [GameRoomParticipantMembershipStatus.JOINED],
      );

      return {
        requestStatus: AiChatRequestStatus.COMPLETED,
        command: resolvedCommand,
        commandResult: this.commandResultMapper.toSuccessResult(resolvedCommand, {
          apiPath: `/v1/game-room-participants/${invitation.id}/join`,
          gameRoomId: participant.gameRoomId,
          participants: participantNames,
          started: false,
        }),
        nextSessionGameRoomId: participant.gameRoomId,
        followUpGameRoomId: participant.gameRoomId,
      };
    } catch (error) {
      return this.toFailedExecutionOutcome(resolvedCommand, invitation.gameRoomId, error);
    }
  }

  private async executeUserInviteDeny(
    user: AuthenticatedUser,
    session: AiChatSession,
    command: UserInviteDenyCommandDto,
  ): Promise<CommandExecutionOutcome> {
    const invitation = await this.resolveInvitationForCommand(user.userId, session, command);
    if (!invitation) {
      return this.buildStaticExecutionFailure(
        command,
        session.gameRoomId,
        'INVITATION_NOT_FOUND',
        '거절할 초대를 찾지 못했습니다.',
      );
    }

    const resolvedCommand: UserInviteDenyCommandDto = {
      ...command,
      gameRoomId: invitation.gameRoomId,
      participantId: invitation.id,
    };

    try {
      const participant = await this.gameRoomParticipantsService.denyInvitation({
        actorUserId: user.userId,
        participantId: invitation.id,
      });

      return {
        requestStatus: AiChatRequestStatus.COMPLETED,
        command: resolvedCommand,
        commandResult: this.commandResultMapper.toSuccessResult(resolvedCommand, {
          apiPath: `/v1/game-room-participants/${invitation.id}/deny`,
          gameRoomId: participant.gameRoomId,
          participants: null,
          started: false,
        }),
        nextSessionGameRoomId:
          session.gameRoomId === participant.gameRoomId ? null : session.gameRoomId,
        followUpGameRoomId: participant.gameRoomId,
      };
    } catch (error) {
      return this.toFailedExecutionOutcome(resolvedCommand, invitation.gameRoomId, error);
    }
  }

  private async executeGameStart(
    user: AuthenticatedUser,
    session: AiChatSession,
    command: GameStartCommandDto,
  ): Promise<CommandExecutionOutcome> {
    const resolvedGameRoomId =
      command.gameRoomId ??
      session.gameRoomId ??
      (await this.resolveOwnedRoomId(user.userId));

    if (!resolvedGameRoomId) {
      return this.buildStaticExecutionFailure(
        command,
        session.gameRoomId,
        'ROOM_NOT_FOUND',
        '시작할 방을 찾지 못했습니다.',
      );
    }

    const missionTemplateId = await this.resolveSelectedMissionTemplateId(
      session.id,
      resolvedGameRoomId,
    );
    if (!missionTemplateId) {
      return this.buildStaticExecutionFailure(
        { ...command, gameRoomId: resolvedGameRoomId },
        resolvedGameRoomId,
        AI_CHAT_ERROR.COMMAND_EXECUTION_FAILED,
        '게임을 시작하기 전에 미션 템플릿 선택이 완료되어야 합니다.',
      );
    }

    const resolvedCommand: GameStartCommandDto = {
      ...command,
      gameRoomId: resolvedGameRoomId,
    };

    try {
      const result = await this.gameStartFlowService.startGame({
        actorUserId: user.userId,
        gameRoomId: resolvedGameRoomId,
        missionTemplateId,
      });
      const participantNames = await this.listParticipantNicknames(
        resolvedGameRoomId,
        [GameRoomParticipantMembershipStatus.JOINED],
      );

      return {
        requestStatus: AiChatRequestStatus.COMPLETED,
        command: resolvedCommand,
        commandResult: this.commandResultMapper.toSuccessResult(resolvedCommand, {
          gameRoomId: resolvedGameRoomId,
          participants: participantNames,
          started: true,
        }),
        nextSessionGameRoomId: result.gameRoom.id,
        followUpGameRoomId: result.gameRoom.id,
      };
    } catch (error) {
      return this.toFailedExecutionOutcome(resolvedCommand, resolvedGameRoomId, error);
    }
  }

  private buildStaticExecutionFailure(
    command: AiChatCommandDto,
    gameRoomId: string | null,
    failureCode: string,
    failureMessage: string,
  ): CommandExecutionOutcome {
    return {
      requestStatus: AiChatRequestStatus.FAILED,
      command,
      commandResult: this.commandResultMapper.toFailedResult(command, {
        gameRoomId,
      }),
      nextSessionGameRoomId: gameRoomId,
      followUpGameRoomId: gameRoomId,
      failureCode,
      failureMessage,
    };
  }

  private toFailedExecutionOutcome(
    command: AiChatCommandDto,
    gameRoomId: string | null,
    error: unknown,
  ): CommandExecutionOutcome {
    const response = this.extractExceptionResponse(error);

    return {
      requestStatus: AiChatRequestStatus.FAILED,
      command,
      commandResult: this.commandResultMapper.toFailedResult(command, {
        gameRoomId,
      }),
      nextSessionGameRoomId: gameRoomId,
      followUpGameRoomId: gameRoomId,
      failureCode: response.code ?? AI_CHAT_ERROR.COMMAND_EXECUTION_FAILED,
      failureMessage: response.message ?? '요청을 처리하지 못했습니다.',
    };
  }

  private extractExceptionResponse(error: unknown): {
    code?: string;
    message?: string;
  } {
    if (!(error instanceof HttpException)) {
      return {
        code: AI_CHAT_ERROR.COMMAND_EXECUTION_FAILED,
        message: '요청을 처리하지 못했습니다.',
      };
    }

    const response = error.getResponse();
    if (typeof response === 'string') {
      return { message: response };
    }
    if (typeof response === 'object' && response !== null) {
      const record = response as Record<string, unknown>;
      return {
        code: typeof record.code === 'string' ? record.code : undefined,
        message: typeof record.message === 'string' ? record.message : undefined,
      };
    }

    return {};
  }

  private async resolveInvitees(
    inviteeNicknames: string[],
    actorUserId: string,
  ): Promise<
    | { users: User[] }
    | { failure: CommandExecutionOutcome }
  > {
    const dedupedNicknames = [...new Set(inviteeNicknames)];
    const users = await this.userRepository.find({
      where: { nickname: In(dedupedNicknames) },
    });
    const userByNickname = new Map(users.map((targetUser) => [targetUser.nickname, targetUser]));

    for (const nickname of dedupedNicknames) {
      const invitee = userByNickname.get(nickname);
      if (!invitee) {
        return {
          failure: this.buildStaticExecutionFailure(
            {
              requestType: AiChatRequestType.USER_INVITE,
              inviteeNicknames,
            },
            null,
            'USER_NOT_FOUND',
            `${nickname} 사용자를 찾지 못했습니다.`,
          ),
        };
      }

      if (invitee.id === actorUserId) {
        return {
          failure: this.buildStaticExecutionFailure(
            {
              requestType: AiChatRequestType.USER_INVITE,
              inviteeNicknames,
            },
            null,
            'USER_ALREADY_IN_ROOM',
            '본인은 초대할 수 없습니다.',
          ),
        };
      }
    }

    return {
      users: dedupedNicknames
        .map((nickname) => userByNickname.get(nickname))
        .filter((invitee): invitee is User => invitee !== undefined),
    };
  }

  private async resolveOwnedRoomId(userId: string): Promise<string | null> {
    const membership = await this.participantRepository.findOne({
      relations: { gameRoom: true },
      where: {
        userId,
        role: GameRoomParticipantRole.OWNER,
        membershipStatus: GameRoomParticipantMembershipStatus.JOINED,
        gameRoom: {
          status: GameRoomStatus.WAITING,
        },
      },
      order: { createdAt: 'DESC' },
    });

    return membership?.gameRoomId ?? null;
  }

  private async resolveInvitationForCommand(
    userId: string,
    session: AiChatSession,
    command: RoomJoinCommandDto | UserInviteDenyCommandDto,
  ): Promise<GameRoomParticipantEntity | null> {
    if (command.participantId) {
      return this.participantRepository.findOne({
        relations: { gameRoom: true },
        where: { id: command.participantId },
      });
    }

    const gameRoomId = command.gameRoomId ?? session.gameRoomId;
    if (gameRoomId) {
      return this.participantRepository.findOne({
        relations: { gameRoom: true },
        where: {
          gameRoomId,
          userId,
          membershipStatus: GameRoomParticipantMembershipStatus.INVITED,
        },
        order: { createdAt: 'DESC' },
      });
    }

    return this.participantRepository.findOne({
      relations: { gameRoom: true },
      where: {
        userId,
        membershipStatus: GameRoomParticipantMembershipStatus.INVITED,
      },
      order: { createdAt: 'DESC' },
    });
  }

  private async resolveSelectedMissionTemplateId(
    aiChatSessionId: string,
    gameRoomId: string,
  ): Promise<string | null> {
    const requests = await this.aiChatRequestRepository.find({
      where: {
        aiChatSessionId,
        requestType: AiChatRequestType.ROOM_CREATE,
        status: AiChatRequestStatus.COMPLETED,
      },
      order: { requestedAt: 'DESC' },
    });

    for (const request of requests) {
      const command = this.readRecord(request.requestPayload?.command);
      const responsePayload = this.readRecord(request.responsePayload);
      const commandResult = this.readRecord(responsePayload?.commandResult);
      const missionTemplateId = command?.missionTemplateId;

      if (
        typeof missionTemplateId === 'string' &&
        typeof commandResult?.gameRoomId === 'string' &&
        commandResult.gameRoomId === gameRoomId &&
        commandResult.status === AiChatCommandResultStatus.SUCCESS
      ) {
        return missionTemplateId;
      }
    }

    return null;
  }

  private async resolveCommandWithRoomCreateContext(
    session: AiChatSession,
    aiChatSessionId: string,
    command: AiChatCommandDto,
    userMessage: string,
  ): Promise<AiChatCommandDto> {
    if (
      session.gameRoomId ||
      command.requestType !== AiChatRequestType.ROOM_CREATE ||
      command.desiredDifficulty ||
      (!command.missionTemplateId &&
        !command.missionTemplateTitle &&
        !this.isMissionTemplateSelectionMessage(userMessage))
    ) {
      return command;
    }

    const pendingContext = await this.resolvePendingRoomCreateContext(aiChatSessionId);
    if (!pendingContext) {
      return command;
    }

    const templates = await this.gameRoomMissionsService.listSelectableMissionTemplates(
      pendingContext.desiredDifficulty,
    );
    const selectedTemplate = command.missionTemplateId
      ? templates.find((template) => template.templateId === command.missionTemplateId)
      : templates.find((template) =>
          this.matchesMissionTemplateTitle(command.missionTemplateTitle, template.title) ||
          this.matchesMissionTemplateTitle(userMessage, template.title),
        );

    if (!selectedTemplate) {
      return command;
    }

    return {
      ...command,
      desiredDifficulty: pendingContext.desiredDifficulty,
      missionTemplateId: selectedTemplate.templateId,
      missionTemplateTitle: selectedTemplate.title,
    };
  }

  private async resolvePendingRoomCreateContext(
    aiChatSessionId: string,
  ): Promise<PendingRoomCreateContext | null> {
    const requests = await this.aiChatRequestRepository.find({
      where: {
        aiChatSessionId,
        requestType: AiChatRequestType.ROOM_CREATE,
        status: AiChatRequestStatus.COMPLETED,
      },
      order: { requestedAt: 'DESC' },
    });

    for (const request of requests) {
      const command = this.readRecord(request.requestPayload?.command);
      const responsePayload = this.readRecord(request.responsePayload);
      const commandResult = this.readRecord(responsePayload?.commandResult);
      const desiredDifficulty = command?.desiredDifficulty;

      if (
        commandResult?.status === AiChatCommandResultStatus.PENDING &&
        this.isMissionDifficulty(desiredDifficulty)
      ) {
        return { desiredDifficulty };
      }
    }

    return null;
  }

  private matchesMissionTemplateTitle(
    selectedTitle: string | undefined,
    templateTitle: string,
  ): boolean {
    if (!selectedTitle) {
      return false;
    }

    const normalizedSelectedTitle = this.normalizeMissionTemplateTitle(selectedTitle);
    const normalizedTemplateTitle = this.normalizeMissionTemplateTitle(templateTitle);

    return (
      normalizedSelectedTitle === normalizedTemplateTitle ||
      normalizedSelectedTitle.includes(normalizedTemplateTitle) ||
      normalizedTemplateTitle.includes(normalizedSelectedTitle)
    );
  }

  private normalizeMissionTemplateTitle(title: string): string {
    return title
      .replace(/["'`]/g, '')
      .replace(/\s+/g, '')
      .replace(/(미션|템플릿|으로|진행할게요|진행할게|진행|선택할게요|선택할게|선택|해줘|할게요|할게)/g, '')
      .toLowerCase();
  }

  private isMissionTemplateSelectionMessage(message: string): boolean {
    return /(미션|템플릿).*(진행|선택|할게|해줘)/i.test(message);
  }

  private isMissionDifficulty(
    value: unknown,
  ): value is NonNullable<RoomCreateCommandDto['desiredDifficulty']> {
    return value === 'EASY' || value === 'NORMAL' || value === 'HARD';
  }

  private readRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : null;
  }

  private async listParticipantNicknames(
    gameRoomId: string,
    statuses: GameRoomParticipantMembershipStatus[],
  ): Promise<string[]> {
    const participants = await this.participantRepository.find({
      where: {
        gameRoomId,
        membershipStatus: In(statuses),
      },
      order: { createdAt: 'ASC' },
    });

    if (participants.length === 0) {
      return [];
    }

    const userIds = participants.map((participant) => participant.userId);
    const users = await this.userRepository.find({
      where: { id: In(userIds) },
    });
    const nicknameByUserId = new Map(users.map((targetUser) => [targetUser.id, targetUser.nickname]));

    return participants
      .map((participant) => nicknameByUserId.get(participant.userId))
      .filter((nickname): nickname is string => nickname !== undefined);
  }

  private async resolveCommandFollowUp(
    command: Parameters<LlmFollowUpGeneratorPort['generateCommandFollowUp']>[0]['command'],
    userMessage: string,
    assistantHint: string | undefined,
    gameRoomId: string | null,
  ) {
    try {
      return await this.llmFollowUpGenerator.generateCommandFollowUp({
        command,
        userMessage,
        assistantHint,
        gameRoomId,
      });
    } catch {
      const staticFallback = buildSafeStaticFollowUpContent(command);
      return {
        content: staticFallback.content,
        metadata: {
          ...staticFallback.metadata,
          followUpSource: 'static_fallback' as const,
          templateKey: null,
        },
        followUpSource: 'static_fallback' as const,
        templateKey: null,
      };
    }
  }

  private async resolveAssistantMetadata(
    command: AiChatCommandDto,
    commandResult: AiChatCommandResultDto,
    followUpMetadata: Record<string, unknown> | null,
  ): Promise<Record<string, unknown> | null> {
    if (
      command.requestType !== AiChatRequestType.ROOM_CREATE ||
      commandResult.status !== AiChatCommandResultStatus.PENDING
    ) {
      if (
        command.requestType === AiChatRequestType.ROOM_CREATE &&
        commandResult.status === AiChatCommandResultStatus.SUCCESS &&
        commandResult.gameRoomId
      ) {
        return {
          ...(followUpMetadata ?? {}),
          gameRoomId: commandResult.gameRoomId,
          roomStatus: GameRoomStatus.WAITING,
        };
      }

      return followUpMetadata;
    }

    if (!command.desiredDifficulty || command.missionTemplateId) {
      return followUpMetadata;
    }

    const templates = await this.gameRoomMissionsService.listSelectableMissionTemplates(
      command.desiredDifficulty,
    );

    return {
      ...(followUpMetadata ?? {}),
      difficulty: command.desiredDifficulty,
      templates,
    };
  }

  private async requireOwnedSession(
    userId: string,
    aiChatSessionId: string,
  ): Promise<AiChatSession> {
    const session = await this.aiChatSessionRepository.findOne({
      where: { id: aiChatSessionId, requesterUserId: userId },
    });

    if (!session) {
      throwAiChatError(
        AI_CHAT_ERROR.SESSION_NOT_FOUND,
        'AI chat session not found',
        HttpStatus.NOT_FOUND,
      );
    }

    return session;
  }

  private toSessionListItem(session: AiChatSession): AiChatSessionListItem {
    return {
      aiChatSessionId: session.id,
      requesterUserId: session.requesterUserId,
      gameRoomId: session.gameRoomId,
      status: session.status,
      provider: session.provider,
      llmModel: session.llmModel,
      createdAt: toSeoulIso(session.createdAt),
      updatedAt: toSeoulIso(session.updatedAt),
      closedAt: session.closedAt ? toSeoulIso(session.closedAt) : null,
    };
  }

  private toMessageItem(message: AiChatMessage): AiChatMessageItem {
    return {
      messageId: message.id,
      aiChatRequestId: message.aiChatRequestId,
      senderType: message.senderType,
      messageType: message.messageType,
      content: message.content,
      metadata: message.metadataJson,
      createdAt: toSeoulIso(message.createdAt),
    };
  }
}
