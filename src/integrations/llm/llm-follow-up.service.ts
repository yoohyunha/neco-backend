import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiChatRequestType } from '../../shared/enums/ai-chat.enum';
import type { AiChatCommandDto } from '../../shared/dto/ai-chat-command.dto';
import { PROMPT_TEMPLATE_KEY } from '../../modules/prompt-template/constants/prompt-template-key.constants';
import { PromptTemplateService } from '../../modules/prompt-template/prompt-template.service';
import {
  buildSafeStaticFollowUpContent,
  sanitizeFollowUpContent,
} from '../../modules/ai-chat-sessions/intent/ai-chat-assistant-content';
import {
  LLM_CHAT_COMPLETIONS_CLIENT,
  type LlmChatCompletionsClientPort,
} from './llm-chat-completions.port';
import type {
  LlmFollowUpGeneratorPort,
  LlmFollowUpInput,
  LlmFollowUpResult,
} from './llm-follow-up.port';

const DEFAULT_LLM_MODEL = 'gpt-5_4-mini-2026-03-17';

@Injectable()
export class LlmFollowUpService implements LlmFollowUpGeneratorPort {
  private readonly logger = new Logger(LlmFollowUpService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly promptTemplateService: PromptTemplateService,
    @Inject(LLM_CHAT_COMPLETIONS_CLIENT)
    private readonly chatCompletionsClient: LlmChatCompletionsClientPort,
  ) {}

  async generateCommandFollowUp(input: LlmFollowUpInput): Promise<LlmFollowUpResult> {
    const templateKey = this.resolveTemplateKey(input.command);

    const renderedPrompt = this.promptTemplateService.renderTemplate(
      templateKey,
      this.buildTemplateVariables(input),
    );

    if (!renderedPrompt) {
      return this.toStaticResult(input.command, null, 'static_fallback');
    }

    const apiKey = this.configService.get<string>('llm.apiKey');
    if (!apiKey) {
      return this.toStaticResult(input.command, templateKey, 'static_fallback');
    }

    const staticMetadata = buildSafeStaticFollowUpContent(input.command).metadata;

    try {
      const llmContent = await this.generateWithLlmApi(renderedPrompt, input.userMessage);
      const sanitized = sanitizeFollowUpContent(llmContent);
      if (!sanitized) {
        return this.toStaticResult(input.command, templateKey, 'static_fallback');
      }

      return {
        content: sanitized,
        metadata: {
          ...staticMetadata,
          followUpSource: 'llm',
          templateKey,
        },
        followUpSource: 'llm',
        templateKey,
      };
    } catch {
      this.logger.warn(`LLM follow-up failed for ${templateKey}; using static fallback`);
      return this.toStaticResult(input.command, templateKey, 'static_fallback');
    }
  }

  resolveTemplateKey(command: AiChatCommandDto): string {
    switch (command.requestType) {
      case AiChatRequestType.ROOM_CREATE:
        if (command.missionTemplateTitle && command.desiredDifficulty) {
          return PROMPT_TEMPLATE_KEY.CHAT_FOLLOWUP_ROOM_SUMMARY;
        }
        return PROMPT_TEMPLATE_KEY.CHAT_FOLLOWUP_ROOM_CREATE;
      case AiChatRequestType.USER_INVITE:
        return PROMPT_TEMPLATE_KEY.CHAT_FOLLOWUP_USER_INVITE;
      case AiChatRequestType.ROOM_JOIN:
        return PROMPT_TEMPLATE_KEY.CHAT_FOLLOWUP_ROOM_JOIN;
      case AiChatRequestType.USER_INVITE_DENY:
        return PROMPT_TEMPLATE_KEY.CHAT_FOLLOWUP_USER_INVITE_DENY;
      case AiChatRequestType.GAME_START:
        return PROMPT_TEMPLATE_KEY.CHAT_FOLLOWUP_GAME_START;
      default:
        return PROMPT_TEMPLATE_KEY.CHAT_FOLLOWUP_ROOM_CREATE;
    }
  }

  private buildTemplateVariables(
    input: LlmFollowUpInput,
  ): Record<string, string | number | undefined | null> {
    const { command, userMessage } = input;
    const base = { userMessage };

    switch (command.requestType) {
      case AiChatRequestType.ROOM_CREATE:
        return {
          ...base,
          desiredDifficulty: command.desiredDifficulty,
          missionTemplateTitle: command.missionTemplateTitle,
        };
      case AiChatRequestType.USER_INVITE:
        return {
          ...base,
          inviteeNicknames: command.inviteeNicknames.join(', '),
        };
      case AiChatRequestType.ROOM_JOIN:
        return {
          ...base,
          roomTitle: command.roomTitle,
        };
      case AiChatRequestType.USER_INVITE_DENY:
      case AiChatRequestType.GAME_START:
        return base;
      default:
        return base;
    }
  }

  private toStaticResult(
    command: AiChatCommandDto,
    templateKey: string | null,
    followUpSource: 'static_fallback',
  ): LlmFollowUpResult {
    const staticFallback = buildSafeStaticFollowUpContent(command);
    return {
      content: staticFallback.content,
      metadata: {
        ...staticFallback.metadata,
        followUpSource,
        templateKey,
      },
      followUpSource,
      templateKey,
    };
  }

  private async generateWithLlmApi(
    systemPrompt: string,
    userMessage: string,
  ): Promise<string> {
    const model = this.configService.get<string>('llm.model') ?? DEFAULT_LLM_MODEL;

    const { content } = await this.chatCompletionsClient.createCompletion({
      model,
      temperature: 0.3,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    });

    const trimmed = content.trim();
    if (!trimmed) {
      throw new Error('LLM empty follow-up response');
    }
    return trimmed;
  }
}
