import { readFileSync } from 'fs';
import { join } from 'path';
import { ConfigService } from '@nestjs/config';
import { AiChatRequestType } from '../../shared/enums/ai-chat.enum';
import type { PromptTemplateService } from '../../modules/prompt-template/prompt-template.service';
import { PROMPT_TEMPLATE_KEY } from '../../modules/prompt-template/constants/prompt-template-key.constants';
import type { LlmChatCompletionsClientPort } from './llm-chat-completions.port';
import { LlmFollowUpService } from './llm-follow-up.service';

describe('LlmFollowUpService', () => {
  const configService = {
    get: jest.fn((key: string) => {
      if (key === 'llm.apiKey') {
        return undefined;
      }
      return undefined;
    }),
  } as unknown as ConfigService;

  let promptTemplateService: jest.Mocked<Pick<PromptTemplateService, 'renderTemplate'>>;
  let chatCompletionsClient: jest.Mocked<LlmChatCompletionsClientPort>;
  let service: LlmFollowUpService;

  beforeEach(() => {
    (configService.get as jest.Mock).mockImplementation((key: string) => {
      if (key === 'llm.apiKey') {
        return undefined;
      }
      return undefined;
    });
    promptTemplateService = {
      renderTemplate: jest.fn(),
    };
    chatCompletionsClient = {
      createCompletion: jest.fn(),
    };
    service = new LlmFollowUpService(
      configService,
      promptTemplateService as unknown as PromptTemplateService,
      chatCompletionsClient,
    );
  });

  it('has no private Chat Completions fetch implementation', () => {
    const source = readFileSync(join(__dirname, 'llm-follow-up.service.ts'), 'utf8');
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });

  it('uses static fallback when template is missing', async () => {
    promptTemplateService.renderTemplate.mockReturnValue(null);

    const result = await service.generateCommandFollowUp({
      command: {
        requestType: AiChatRequestType.ROOM_CREATE,
        desiredDifficulty: 'EASY',
      },
      userMessage: '쉬운 난이도로 방 만들어줘',
    });

    expect(result.followUpSource).toBe('static_fallback');
    expect(result.content).toContain('EASY');
    expect(result.templateKey).toBeNull();
    expect(chatCompletionsClient.createCompletion).not.toHaveBeenCalled();
  });

  it('uses static fallback when template renders but LLM key is absent', async () => {
    promptTemplateService.renderTemplate.mockReturnValue('system prompt for follow-up');

    const result = await service.generateCommandFollowUp({
      command: {
        requestType: AiChatRequestType.USER_INVITE,
        inviteeNicknames: ['코딩고수'],
      },
      userMessage: '@코딩고수 초대해줘',
    });

    expect(result.followUpSource).toBe('static_fallback');
    expect(result.templateKey).toBe(PROMPT_TEMPLATE_KEY.CHAT_FOLLOWUP_USER_INVITE);
    expect(result.content).toContain('코딩고수');
    expect(chatCompletionsClient.createCompletion).not.toHaveBeenCalled();
  });

  it('routes follow-up through shared client without responseFormat', async () => {
    (configService.get as jest.Mock).mockImplementation((key: string) => {
      if (key === 'llm.apiKey') {
        return 'test-key';
      }
      if (key === 'llm.model') {
        return 'gpt-test';
      }
      return undefined;
    });
    promptTemplateService.renderTemplate.mockReturnValue('Follow-up system prompt');
    chatCompletionsClient.createCompletion.mockResolvedValue({
      content: '게임을 곧 시작합니다.',
    });

    const result = await service.generateCommandFollowUp({
      command: { requestType: AiChatRequestType.GAME_START },
      userMessage: '게임 시작해줘',
    });

    expect(chatCompletionsClient.createCompletion).toHaveBeenCalledWith({
      model: 'gpt-test',
      temperature: 0.3,
      messages: [
        { role: 'system', content: 'Follow-up system prompt' },
        { role: 'user', content: '게임 시작해줘' },
      ],
    });
    expect(result.followUpSource).toBe('llm');
    expect(result.content).toBe('게임을 곧 시작합니다.');
  });

  it('uses static fallback when shared client fails', async () => {
    (configService.get as jest.Mock).mockImplementation((key: string) => {
      if (key === 'llm.apiKey') {
        return 'test-key';
      }
      if (key === 'llm.model') {
        return 'gpt-test';
      }
      return undefined;
    });
    promptTemplateService.renderTemplate.mockReturnValue('Follow-up system prompt');
    chatCompletionsClient.createCompletion.mockRejectedValue(new Error('LLM down'));

    const result = await service.generateCommandFollowUp({
      command: { requestType: AiChatRequestType.GAME_START },
      userMessage: '게임 시작해줘',
    });

    expect(result.followUpSource).toBe('static_fallback');
    expect(result.content).toBe('게임 시작 요청을 이해했어요.');
  });

  it('does not expose unsafe assistantHint in static fallback when LLM is blocked', async () => {
    promptTemplateService.renderTemplate.mockReturnValue('Follow-up system prompt');

    (configService.get as jest.Mock).mockImplementation((key: string) => {
      if (key === 'llm.apiKey') {
        return 'test-key';
      }
      if (key === 'llm.model') {
        return 'gpt-test';
      }
      return undefined;
    });

    chatCompletionsClient.createCompletion.mockResolvedValue({
      content: 'Bearer sk-secret1234567890 leaked',
    });

    const result = await service.generateCommandFollowUp({
      command: { requestType: AiChatRequestType.GAME_START },
      userMessage: '게임 시작해줘',
      assistantHint: 'Bearer sk-secret1234567890 from parser',
    });

    expect(result.followUpSource).toBe('static_fallback');
    expect(result.content).toBe('게임 시작 요청을 이해했어요.');
    expect(result.content).not.toContain('Bearer');
    expect(result.content).not.toContain('sk-secret');
  });

  it('uses static fallback when LLM returns secret-like content', async () => {
    (configService.get as jest.Mock).mockImplementation((key: string) => {
      if (key === 'llm.apiKey') {
        return 'test-key';
      }
      if (key === 'llm.model') {
        return 'gpt-test';
      }
      return undefined;
    });

    promptTemplateService.renderTemplate.mockReturnValue('Follow-up system prompt');
    chatCompletionsClient.createCompletion.mockResolvedValue({
      content: 'Bearer sk-secret1234567890 leaked',
    });

    const result = await service.generateCommandFollowUp({
      command: { requestType: AiChatRequestType.GAME_START },
      userMessage: '게임 시작해줘',
    });

    expect(result.followUpSource).toBe('static_fallback');
    expect(chatCompletionsClient.createCompletion).toHaveBeenCalled();
  });

  it('resolves room summary template when mission and difficulty are both present', () => {
    const key = service.resolveTemplateKey({
      requestType: AiChatRequestType.ROOM_CREATE,
      desiredDifficulty: 'NORMAL',
      missionTemplateTitle: '기초 산술 연산',
    });
    expect(key).toBe(PROMPT_TEMPLATE_KEY.CHAT_FOLLOWUP_ROOM_SUMMARY);
  });

  it('passes only available fields to room summary template variables', async () => {
    promptTemplateService.renderTemplate.mockImplementation((key, vars) => {
      if (key === PROMPT_TEMPLATE_KEY.CHAT_FOLLOWUP_ROOM_SUMMARY) {
        expect(vars).toEqual({
          userMessage: '기초 산술 연산 미션 선택할게',
          desiredDifficulty: 'NORMAL',
          missionTemplateTitle: '기초 산술 연산',
        });
        return null;
      }
      return null;
    });

    await service.generateCommandFollowUp({
      command: {
        requestType: AiChatRequestType.ROOM_CREATE,
        desiredDifficulty: 'NORMAL',
        missionTemplateTitle: '기초 산술 연산',
        desiredTopic: 'not-a-room-title',
      },
      userMessage: '기초 산술 연산 미션 선택할게',
    });
  });
});
