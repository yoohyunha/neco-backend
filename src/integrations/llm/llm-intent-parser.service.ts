import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PROMPT_TEMPLATE_KEY } from '../../modules/prompt-template/constants/prompt-template-key.constants';
import { PromptTemplateService } from '../../modules/prompt-template/prompt-template.service';
import {
  LLM_CHAT_COMPLETIONS_CLIENT,
  type LlmChatCompletionsClientPort,
} from './llm-chat-completions.port';
import type {
  LlmIntentParseInput,
  LlmIntentParserPort,
  LlmIntentRawResponse,
} from './llm-intent-parser.port';

const SUPPORTED_REQUEST_TYPES = [
  'ROOM_CREATE',
  'USER_INVITE',
  'ROOM_JOIN',
  'USER_INVITE_DENY',
  'GAME_START',
] as const;

const DEFAULT_INTENT_SYSTEM_PROMPT = `You interpret Korean game-lobby chat into exactly one command intent.
Supported requestType values: ${SUPPORTED_REQUEST_TYPES.join(', ')}.
Return JSON only with keys: requestType, confidence ("high"|"low"), payload (object), assistantHint (short Korean string).
payload fields by type:
- ROOM_CREATE: desiredDifficulty (EASY|NORMAL|HARD), desiredTopic, missionTemplateId, missionTemplateTitle
- USER_INVITE: gameRoomId, inviteeNicknames (string[])
- ROOM_JOIN: gameRoomId, participantId, roomTitle
- USER_INVITE_DENY: gameRoomId, participantId
- GAME_START: gameRoomId
If the message is not a lobby command, set requestType to null and confidence to low.`;

const DEFAULT_LLM_MODEL = 'gpt-5_4-mini-2026-03-17';

@Injectable()
export class LlmIntentParserService implements LlmIntentParserPort {
  private readonly logger = new Logger(LlmIntentParserService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly promptTemplateService: PromptTemplateService,
    @Inject(LLM_CHAT_COMPLETIONS_CLIENT)
    private readonly chatCompletionsClient: LlmChatCompletionsClientPort,
  ) {}

  async parseUserMessage(input: LlmIntentParseInput): Promise<LlmIntentRawResponse> {
    const apiKey = this.configService.get<string>('llm.apiKey');
    if (!apiKey) {
      return this.parseWithHeuristics(input.message);
    }

    try {
      return await this.parseWithLlmApi(input);
    } catch {
      this.logger.warn('LLM intent parse failed; falling back to heuristics');
      return this.parseWithHeuristics(input.message);
    }
  }

  private async parseWithLlmApi(input: LlmIntentParseInput): Promise<LlmIntentRawResponse> {
    const model = this.configService.get<string>('llm.model') ?? DEFAULT_LLM_MODEL;

    const userContent = JSON.stringify({
      message: input.message,
      gameRoomId: input.gameRoomId ?? null,
    });

    const priorMessages = (input.priorMessages ?? []).map((message) => ({
      role: message.role,
      content: message.content,
    }));

    const { content } = await this.chatCompletionsClient.createCompletion({
      model,
      temperature: 0,
      responseFormat: { type: 'json_object' },
      messages: [
        { role: 'system', content: this.resolveIntentSystemPrompt() },
        ...priorMessages,
        { role: 'user', content: userContent },
      ],
    });

    const parsed = JSON.parse(content) as LlmIntentRawResponse;
    return {
      requestType: parsed.requestType ?? null,
      confidence: parsed.confidence,
      payload: parsed.payload ?? {},
      assistantHint: parsed.assistantHint,
    };
  }

  resolveIntentSystemPrompt(): string {
    const fromTemplate = this.promptTemplateService.renderTemplate(
      PROMPT_TEMPLATE_KEY.CHAT_INTENT_PARSE,
      {},
    );
    return fromTemplate ?? DEFAULT_INTENT_SYSTEM_PROMPT;
  }

  /** Deterministic fallback for local dev and tests when LLM is unavailable. */
  parseWithHeuristics(message: string): LlmIntentRawResponse {
    const normalized = message.trim();

    if (/거절|거부|decline/i.test(normalized)) {
      return {
        requestType: 'USER_INVITE_DENY',
        confidence: 'high',
        payload: {},
        assistantHint: '초대 거절 요청으로 이해했어요.',
      };
    }
    if (this.isInviteAcceptance(normalized)) {
      const roomTitle = this.extractRoomTitleFromJoinMessage(normalized);
      return {
        requestType: 'ROOM_JOIN',
        confidence: 'high',
        payload: roomTitle ? { roomTitle } : {},
        assistantHint: '방 참가 요청으로 이해했어요.',
      };
    }
    if (this.isInviteCreation(normalized)) {
      const nicknames = this.extractNicknames(normalized);
      return {
        requestType: 'USER_INVITE',
        confidence: 'high',
        payload: { inviteeNicknames: nicknames },
        assistantHint: '유저 초대 요청으로 이해했어요.',
      };
    }
    if (/수락|참가|join/i.test(normalized)) {
      return {
        requestType: 'ROOM_JOIN',
        confidence: 'high',
        payload: {},
        assistantHint: '방 참가 요청으로 이해했어요.',
      };
    }
    if (/시작|start/i.test(normalized)) {
      return {
        requestType: 'GAME_START',
        confidence: 'high',
        payload: {},
        assistantHint: '게임 시작 요청으로 이해했어요.',
      };
    }

    const templateTitle = this.extractMissionTemplateTitle(normalized);
    if (templateTitle || this.isMissionTemplateSelection(normalized)) {
      return {
        requestType: 'ROOM_CREATE',
        confidence: 'high',
        payload: templateTitle ? { missionTemplateTitle: templateTitle } : {},
        assistantHint: '미션 선택 요청으로 이해했어요.',
      };
    }

    if (/방.*만들|만들.*방|room create/i.test(normalized)) {
      const difficulty = this.extractDifficulty(normalized);
      return {
        requestType: 'ROOM_CREATE',
        confidence: 'high',
        payload: difficulty ? { desiredDifficulty: difficulty } : {},
        assistantHint: '방 생성 요청으로 이해했어요.',
      };
    }

    return {
      requestType: null,
      confidence: 'low',
      payload: {},
      assistantHint: '요청을 이해하지 못했어요. 방 생성, 초대, 참가, 거절, 게임 시작 중 무엇을 원하시는지 알려주세요.',
    };
  }

  private isInviteAcceptance(message: string): boolean {
    return (
      /(수락|accept)/i.test(message) && /(초대|invite)/i.test(message)
    );
  }

  private isInviteCreation(message: string): boolean {
    return /(초대|invite)/i.test(message) && !this.isInviteAcceptance(message);
  }

  private isMissionTemplateSelection(message: string): boolean {
    return /(미션|템플릿).*(선택|할게|해줘)/i.test(message);
  }

  private extractRoomTitleFromJoinMessage(message: string): string | undefined {
    const match = message.match(/^(.+?)\s*방\s*초대\s*(?:수락|accept)/i);
    return match?.[1]?.trim();
  }

  private extractDifficulty(message: string): MissionDifficultyHeuristic | undefined {
    if (/쉬운|easy/i.test(message)) {
      return 'EASY';
    }
    if (/어려운|hard/i.test(message)) {
      return 'HARD';
    }
    if (/보통|normal/i.test(message)) {
      return 'NORMAL';
    }
    return undefined;
  }

  private extractMissionTemplateTitle(message: string): string | undefined {
    const match = message.match(/(.+?)\s*(미션|템플릿).*(선택|할게|해줘)/i);
    return match?.[1]?.trim();
  }

  private extractNicknames(message: string): string[] {
    const atMentions = [...message.matchAll(/@([^\s,]+)/g)].map((m) => m[1]);
    if (atMentions.length > 0) {
      return atMentions;
    }
    const inviteMatch = message.match(/([가-힣A-Za-z0-9_]+)\s*(?:님\s*)?초대/);
    if (inviteMatch?.[1]) {
      return [inviteMatch[1]];
    }
    return [];
  }
}

type MissionDifficultyHeuristic = 'EASY' | 'NORMAL' | 'HARD';
