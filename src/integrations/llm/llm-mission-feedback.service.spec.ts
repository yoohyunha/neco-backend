import { ConfigService } from '@nestjs/config';
import type { AiGameSessionsService } from '../../modules/ai-game-sessions/ai-game-sessions.service';
import { PROMPT_TEMPLATE_KEY } from '../../modules/prompt-template/constants/prompt-template-key.constants';
import type { PromptTemplateService } from '../../modules/prompt-template/prompt-template.service';
import {
  AiGameRequestStatus,
  AiGameRequestType,
  MissionResultJudgeStatus,
} from '../../shared/enums';
import type { LlmChatCompletionsClientPort } from './llm-chat-completions.port';
import {
  LlmMissionFeedbackService,
  resolveStaticMissionFeedback,
  truncateExecutionExcerpt,
} from './llm-mission-feedback.service';

describe('LlmMissionFeedbackService', () => {
  const configService = {
    get: jest.fn(),
  } as unknown as ConfigService;

  let promptTemplateService: jest.Mocked<Pick<PromptTemplateService, 'renderTemplate'>>;
  let aiGameSessionsService: jest.Mocked<
    Pick<
      AiGameSessionsService,
      'ensureActiveSession' | 'startRequest' | 'completeRequest' | 'failRequest'
    >
  >;
  let chatCompletionsClient: jest.Mocked<LlmChatCompletionsClientPort>;
  let service: LlmMissionFeedbackService;

  beforeEach(() => {
    (configService.get as jest.Mock).mockImplementation((key: string) => {
      if (key === 'llm.apiKey') {
        return 'test-key';
      }
      if (key === 'llm.model') {
        return 'gpt-test';
      }
      return undefined;
    });

    promptTemplateService = {
      renderTemplate: jest.fn().mockReturnValue('mission feedback system prompt'),
    };

    aiGameSessionsService = {
      ensureActiveSession: jest.fn().mockResolvedValue({ id: 'session-1' }),
      startRequest: jest.fn().mockResolvedValue({
        id: 'request-1',
        status: AiGameRequestStatus.RECEIVED,
      }),
      completeRequest: jest.fn().mockResolvedValue({
        id: 'request-1',
        status: AiGameRequestStatus.COMPLETED,
      }),
      failRequest: jest.fn().mockResolvedValue({
        id: 'request-1',
        status: AiGameRequestStatus.FAILED,
      }),
    };

    chatCompletionsClient = {
      createCompletion: jest.fn(),
    };

    service = new LlmMissionFeedbackService(
      configService,
      promptTemplateService as unknown as PromptTemplateService,
      aiGameSessionsService as unknown as AiGameSessionsService,
      chatCompletionsClient,
    );
  });

  it('returns static fallback strings matching existing judge-status copy', () => {
    expect(resolveStaticMissionFeedback(MissionResultJudgeStatus.PASSED)).toBe(
      '현재 미션 단계를 통과했습니다.',
    );
    expect(resolveStaticMissionFeedback(MissionResultJudgeStatus.FAILED)).toBe(
      '현재 미션 단계를 통과하지 못했습니다.',
    );
    expect(resolveStaticMissionFeedback(MissionResultJudgeStatus.ERROR)).toBe(
      '런타임 또는 판정 처리 오류가 발생했습니다.',
    );
  });

  it('truncates large execution excerpts in the JUDGE request payload', async () => {
    const longStdout = 'a'.repeat(600);
    chatCompletionsClient.createCompletion.mockResolvedValue({
      content: '표준 출력 일부를 확인하며 다음 수정을 시도해 보세요.',
    });

    await service.generateMissionFeedback({
      gameRoomId: 'room-1',
      judgeStatus: MissionResultJudgeStatus.FAILED,
      turnId: 'turn-1',
      missionId: 'mission-1',
      stepId: 'step-1',
      stepOrder: 2,
      stdout: longStdout,
      stderr: 'err',
      detectedIssueSummaries: ['케이스 A 실패'],
    });

    expect(aiGameSessionsService.startRequest).toHaveBeenCalledWith({
      aiGameSessionId: 'session-1',
      requestType: AiGameRequestType.JUDGE,
      turnId: 'turn-1',
      missionId: 'mission-1',
      requestPayload: {
        judgeStatus: MissionResultJudgeStatus.FAILED,
        stepId: 'step-1',
        stepOrder: 2,
        stdout: truncateExecutionExcerpt(longStdout),
        stderr: 'err',
        detectedIssueSummaries: ['케이스 A 실패'],
      },
    });
    expect(truncateExecutionExcerpt(longStdout).endsWith('…')).toBe(true);
    expect(truncateExecutionExcerpt(longStdout).length).toBe(501);
  });

  it('returns sanitized LLM feedback and completes JUDGE request on success', async () => {
    chatCompletionsClient.createCompletion.mockResolvedValue({
      content: '  테스트 케이스 실패 원인을 로그에서 확인해 보세요.  ',
    });

    const result = await service.generateMissionFeedback({
      gameRoomId: 'room-1',
      judgeStatus: MissionResultJudgeStatus.FAILED,
      stepOrder: 1,
      stdout: 'ok',
      stderr: '',
      detectedIssueSummaries: ['PUBLIC_TEST_CASE_FAILED'],
    });

    expect(chatCompletionsClient.createCompletion).toHaveBeenCalledWith({
      model: 'gpt-test',
      temperature: 0.3,
      messages: [
        { role: 'system', content: 'mission feedback system prompt' },
        {
          role: 'user',
          content: '위 판정 결과를 바탕으로 짧은 한국어 피드백 문장 하나만 작성해 주세요.',
        },
      ],
    });
    expect(promptTemplateService.renderTemplate).toHaveBeenCalledWith(
      PROMPT_TEMPLATE_KEY.MISSION_FEEDBACK,
      expect.objectContaining({
        judgeStatus: MissionResultJudgeStatus.FAILED,
        stepOrder: 1,
        detectedIssueSummaries: 'PUBLIC_TEST_CASE_FAILED',
      }),
    );
    expect(result).toEqual({
      feedbackMessage: '테스트 케이스 실패 원인을 로그에서 확인해 보세요.',
      feedbackSource: 'llm',
      templateKey: PROMPT_TEMPLATE_KEY.MISSION_FEEDBACK,
    });
    expect(result).not.toHaveProperty('judgeStatus');
    expect(aiGameSessionsService.completeRequest).toHaveBeenCalledWith('request-1', {
      feedbackMessage: '테스트 케이스 실패 원인을 로그에서 확인해 보세요.',
      feedbackSource: 'llm',
    });
    expect(aiGameSessionsService.failRequest).not.toHaveBeenCalled();
  });

  it('rejects unsafe LLM output, returns static fallback, and marks JUDGE request FAILED', async () => {
    chatCompletionsClient.createCompletion.mockResolvedValue({
      content: 'Bearer sk-secret1234567890 leaked',
    });

    const result = await service.generateMissionFeedback({
      gameRoomId: 'room-1',
      judgeStatus: MissionResultJudgeStatus.PASSED,
    });

    expect(result).toEqual({
      feedbackMessage: '현재 미션 단계를 통과했습니다.',
      feedbackSource: 'static_fallback',
      templateKey: PROMPT_TEMPLATE_KEY.MISSION_FEEDBACK,
    });
    expect(aiGameSessionsService.failRequest).toHaveBeenCalledWith('request-1', {
      reason: 'unsafe_or_empty_output',
      feedbackMessage: '현재 미션 단계를 통과했습니다.',
    });
    expect(aiGameSessionsService.completeRequest).not.toHaveBeenCalled();
  });

  it('returns static fallback and marks JUDGE request FAILED when API call fails', async () => {
    chatCompletionsClient.createCompletion.mockRejectedValue(new Error('LLM down'));

    const result = await service.generateMissionFeedback({
      gameRoomId: 'room-1',
      judgeStatus: MissionResultJudgeStatus.ERROR,
    });

    expect(result).toEqual({
      feedbackMessage: '런타임 또는 판정 처리 오류가 발생했습니다.',
      feedbackSource: 'static_fallback',
      templateKey: PROMPT_TEMPLATE_KEY.MISSION_FEEDBACK,
    });
    expect(aiGameSessionsService.failRequest).toHaveBeenCalledWith('request-1', {
      reason: 'api_failure',
      error: 'LLM down',
      feedbackMessage: '런타임 또는 판정 처리 오류가 발생했습니다.',
    });
    expect(aiGameSessionsService.completeRequest).not.toHaveBeenCalled();
  });

  it('returns static fallback without calling the client when API key is missing', async () => {
    (configService.get as jest.Mock).mockImplementation((key: string) => {
      if (key === 'llm.apiKey') {
        return undefined;
      }
      return undefined;
    });

    const result = await service.generateMissionFeedback({
      gameRoomId: 'room-1',
      judgeStatus: MissionResultJudgeStatus.FAILED,
    });

    expect(result.feedbackSource).toBe('static_fallback');
    expect(result.feedbackMessage).toBe('현재 미션 단계를 통과하지 못했습니다.');
    expect(chatCompletionsClient.createCompletion).not.toHaveBeenCalled();
    expect(aiGameSessionsService.failRequest).toHaveBeenCalledWith('request-1', {
      reason: 'missing_api_key',
      feedbackMessage: '현재 미션 단계를 통과하지 못했습니다.',
    });
  });
});
