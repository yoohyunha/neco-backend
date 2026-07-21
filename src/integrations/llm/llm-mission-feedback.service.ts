import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sanitizeFollowUpContent } from '../../modules/ai-chat-sessions/intent/ai-chat-assistant-content';
import { AiGameSessionsService } from '../../modules/ai-game-sessions/ai-game-sessions.service';
import { PROMPT_TEMPLATE_KEY } from '../../modules/prompt-template/constants/prompt-template-key.constants';
import { PromptTemplateService } from '../../modules/prompt-template/prompt-template.service';
import { AiGameRequestType, MissionResultJudgeStatus } from '../../shared/enums';
import {
  LLM_CHAT_COMPLETIONS_CLIENT,
  type LlmChatCompletionsClientPort,
} from './llm-chat-completions.port';
import type {
  LlmMissionFeedbackGeneratorPort,
  LlmMissionFeedbackInput,
  LlmMissionFeedbackResult,
  MissionFeedbackSource,
} from './llm-mission-feedback.port';

const DEFAULT_LLM_MODEL = 'gpt-5_4-mini-2026-03-17';
const MAX_EXECUTION_EXCERPT_LENGTH = 500;
const MISSION_FEEDBACK_USER_MESSAGE =
  '위 판정 결과를 바탕으로 짧은 한국어 피드백 문장 하나만 작성해 주세요.';

const STATIC_FEEDBACK_BY_JUDGE_STATUS: Record<MissionResultJudgeStatus, string> = {
  [MissionResultJudgeStatus.PASSED]: '현재 미션 단계를 통과했습니다.',
  [MissionResultJudgeStatus.FAILED]: '현재 미션 단계를 통과하지 못했습니다.',
  [MissionResultJudgeStatus.ERROR]: '런타임 또는 판정 처리 오류가 발생했습니다.',
};

@Injectable()
export class LlmMissionFeedbackService implements LlmMissionFeedbackGeneratorPort {
  private readonly logger = new Logger(LlmMissionFeedbackService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly promptTemplateService: PromptTemplateService,
    private readonly aiGameSessionsService: AiGameSessionsService,
    @Inject(LLM_CHAT_COMPLETIONS_CLIENT)
    private readonly chatCompletionsClient: LlmChatCompletionsClientPort,
  ) {}

  async generateMissionFeedback(
    input: LlmMissionFeedbackInput,
  ): Promise<LlmMissionFeedbackResult> {
    const staticFallback = resolveStaticMissionFeedback(input.judgeStatus);
    const templateKey = PROMPT_TEMPLATE_KEY.MISSION_FEEDBACK;
    const requestPayload = this.buildRequestPayload(input);

    let requestId: string | null = null;

    try {
      const session = await this.aiGameSessionsService.ensureActiveSession(input.gameRoomId);
      const request = await this.aiGameSessionsService.startRequest({
        aiGameSessionId: session.id,
        requestType: AiGameRequestType.JUDGE,
        requestPayload,
        turnId: input.turnId,
        missionId: input.missionId,
      });
      requestId = request.id;

      const renderedPrompt = this.promptTemplateService.renderTemplate(
        templateKey,
        this.buildTemplateVariables(requestPayload),
      );

      if (!renderedPrompt) {
        await this.safeFailRequest(requestId, {
          reason: 'template_render_failed',
          feedbackMessage: staticFallback,
        });
        return this.toStaticResult(staticFallback, null);
      }

      const apiKey = this.configService.get<string>('llm.apiKey');
      if (!apiKey) {
        await this.safeFailRequest(requestId, {
          reason: 'missing_api_key',
          feedbackMessage: staticFallback,
        });
        return this.toStaticResult(staticFallback, templateKey);
      }

      try {
        const llmContent = await this.generateWithLlmApi(renderedPrompt);
        const sanitized = sanitizeFollowUpContent(llmContent);
        if (!sanitized) {
          await this.safeFailRequest(requestId, {
            reason: 'unsafe_or_empty_output',
            feedbackMessage: staticFallback,
          });
          return this.toStaticResult(staticFallback, templateKey);
        }

        const completed = await this.tryCompleteRequest(requestId, {
          feedbackMessage: sanitized,
          feedbackSource: 'llm' satisfies MissionFeedbackSource,
        });
        if (!completed) {
          await this.safeFailRequest(requestId, {
            reason: 'persistence_failure',
            feedbackMessage: staticFallback,
          });
          return this.toStaticResult(staticFallback, templateKey);
        }

        return {
          feedbackMessage: sanitized,
          feedbackSource: 'llm',
          templateKey,
        };
      } catch (error) {
        this.logger.warn('LLM mission feedback failed; using static fallback');
        await this.safeFailRequest(requestId, {
          reason: 'api_failure',
          error: error instanceof Error ? error.message : 'unknown_error',
          feedbackMessage: staticFallback,
        });
        return this.toStaticResult(staticFallback, templateKey);
      }
    } catch {
      this.logger.warn('AI game persistence failed during mission feedback; using static fallback');
      if (requestId) {
        await this.safeFailRequest(requestId, {
          reason: 'persistence_failure',
          feedbackMessage: staticFallback,
        });
      }
      return this.toStaticResult(staticFallback, null);
    }
  }

  private buildRequestPayload(input: LlmMissionFeedbackInput): Record<string, unknown> {
    return {
      judgeStatus: input.judgeStatus,
      stepId: input.stepId ?? null,
      stepOrder: input.stepOrder ?? null,
      stdout: truncateExecutionExcerpt(input.stdout),
      stderr: truncateExecutionExcerpt(input.stderr),
      detectedIssueSummaries: (input.detectedIssueSummaries ?? []).map((summary) =>
        truncateExecutionExcerpt(summary),
      ),
    };
  }

  private buildTemplateVariables(
    requestPayload: Record<string, unknown>,
  ): Record<string, string | number | undefined | null> {
    const summaries = Array.isArray(requestPayload.detectedIssueSummaries)
      ? requestPayload.detectedIssueSummaries.join('; ')
      : '';

    return {
      judgeStatus: String(requestPayload.judgeStatus ?? ''),
      stepId:
        requestPayload.stepId === null || requestPayload.stepId === undefined
          ? ''
          : String(requestPayload.stepId),
      stepOrder:
        typeof requestPayload.stepOrder === 'number' ? requestPayload.stepOrder : '',
      stdout: typeof requestPayload.stdout === 'string' ? requestPayload.stdout : '',
      stderr: typeof requestPayload.stderr === 'string' ? requestPayload.stderr : '',
      detectedIssueSummaries: summaries,
    };
  }

  private toStaticResult(
    feedbackMessage: string,
    templateKey: string | null,
  ): LlmMissionFeedbackResult {
    return {
      feedbackMessage,
      feedbackSource: 'static_fallback',
      templateKey,
    };
  }

  private async tryCompleteRequest(
    requestId: string,
    responsePayload: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      await this.aiGameSessionsService.completeRequest(requestId, responsePayload);
      return true;
    } catch {
      this.logger.warn(`Failed to complete AI game request ${requestId}`);
      return false;
    }
  }

  private async safeFailRequest(
    requestId: string,
    responsePayload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.aiGameSessionsService.failRequest(requestId, responsePayload);
    } catch {
      this.logger.warn(`Failed to mark AI game request ${requestId} as FAILED`);
    }
  }

  private async generateWithLlmApi(systemPrompt: string): Promise<string> {
    const model = this.configService.get<string>('llm.model') ?? DEFAULT_LLM_MODEL;

    const { content } = await this.chatCompletionsClient.createCompletion({
      model,
      temperature: 0.3,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: MISSION_FEEDBACK_USER_MESSAGE },
      ],
    });

    const trimmed = content.trim();
    if (!trimmed) {
      throw new Error('LLM empty mission feedback response');
    }
    return trimmed;
  }
}

export function resolveStaticMissionFeedback(
  judgeStatus: MissionResultJudgeStatus,
): string {
  return STATIC_FEEDBACK_BY_JUDGE_STATUS[judgeStatus];
}

export function truncateExecutionExcerpt(value: string | null | undefined): string {
  const text = (value ?? '').trim();
  if (!text) {
    return '';
  }
  if (text.length <= MAX_EXECUTION_EXCERPT_LENGTH) {
    return text;
  }
  return `${text.slice(0, MAX_EXECUTION_EXCERPT_LENGTH)}…`;
}
