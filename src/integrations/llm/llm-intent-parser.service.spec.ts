import { readFileSync } from 'fs';
import { join } from 'path';
import { ConfigService } from '@nestjs/config';
import type { PromptTemplateService } from '../../modules/prompt-template/prompt-template.service';
import type { LlmChatCompletionsClientPort } from './llm-chat-completions.port';
import { LlmIntentParserService } from './llm-intent-parser.service';

describe('LlmIntentParserService', () => {
  const configService = {
    get: jest.fn((key: string) => {
      if (key === 'llm.apiKey') {
        return undefined;
      }
      return undefined;
    }),
  } as unknown as ConfigService;

  const promptTemplateService = {
    renderTemplate: jest.fn(() => null),
    getActiveTemplate: jest.fn(() => null),
    refreshCache: jest.fn(),
  } as unknown as PromptTemplateService;

  let chatCompletionsClient: jest.Mocked<LlmChatCompletionsClientPort>;
  let service: LlmIntentParserService;

  beforeEach(() => {
    (configService.get as jest.Mock).mockImplementation((key: string) => {
      if (key === 'llm.apiKey') {
        return undefined;
      }
      return undefined;
    });
    chatCompletionsClient = {
      createCompletion: jest.fn(),
    };
    service = new LlmIntentParserService(
      configService,
      promptTemplateService,
      chatCompletionsClient,
    );
  });

  it('has no private Chat Completions fetch implementation', () => {
    const source = readFileSync(join(__dirname, 'llm-intent-parser.service.ts'), 'utf8');
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });

  it('falls back to default intent system prompt when seed template is absent', () => {
    expect(service.resolveIntentSystemPrompt()).toContain('ROOM_CREATE');
  });

  it('heuristically parses ROOM_CREATE messages', async () => {
    const result = await service.parseUserMessage({ message: '쉬운 난이도로 방 만들어줘' });
    expect(result.requestType).toBe('ROOM_CREATE');
    expect(result.payload).toMatchObject({ desiredDifficulty: 'EASY' });
  });

  it('heuristically parses USER_INVITE messages', async () => {
    const result = await service.parseUserMessage({ message: '@코딩고수 초대해줘' });
    expect(result.requestType).toBe('USER_INVITE');
    expect(result.payload).toMatchObject({ inviteeNicknames: ['코딩고수'] });
  });

  it('parses invite acceptance as ROOM_JOIN before USER_INVITE', async () => {
    const result = await service.parseUserMessage({
      message: '문자열 핸들링 릴레이 방 초대 수락할게',
    });
    expect(result.requestType).toBe('ROOM_JOIN');
    expect(result.payload).toMatchObject({ roomTitle: '문자열 핸들링 릴레이' });
  });

  it('parses mission template selection as ROOM_CREATE in fallback', async () => {
    const result = await service.parseUserMessage({
      message: '기초 산술 연산 미션 선택할게',
    });
    expect(result.requestType).toBe('ROOM_CREATE');
    expect(result.payload).toMatchObject({ missionTemplateTitle: '기초 산술 연산' });
  });

  it('returns null requestType for unrecognized messages', async () => {
    const result = await service.parseUserMessage({ message: '오늘 날씨 어때?' });
    expect(result.requestType).toBeNull();
    expect(result.confidence).toBe('low');
  });

  it('does not call shared client when API key is missing', async () => {
    await service.parseUserMessage({ message: '쉬운 난이도로 방 만들어줘' });
    expect(chatCompletionsClient.createCompletion).not.toHaveBeenCalled();
  });

  it('routes intent parsing through shared client with json_object and prior messages', async () => {
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
      content: JSON.stringify({
        requestType: 'ROOM_CREATE',
        confidence: 'high',
        payload: { desiredDifficulty: 'EASY' },
        assistantHint: '방 생성 요청으로 이해했어요.',
      }),
    });

    const result = await service.parseUserMessage({
      message: '쉬운 난이도로 방 만들어줘',
      gameRoomId: 'room-1',
      priorMessages: [
        { role: 'user', content: '안녕' },
        { role: 'assistant', content: '무엇을 도와드릴까요?' },
      ],
    });

    expect(chatCompletionsClient.createCompletion).toHaveBeenCalledWith({
      model: 'gpt-test',
      temperature: 0,
      responseFormat: { type: 'json_object' },
      messages: [
        { role: 'system', content: expect.stringContaining('ROOM_CREATE') },
        { role: 'user', content: '안녕' },
        { role: 'assistant', content: '무엇을 도와드릴까요?' },
        {
          role: 'user',
          content: JSON.stringify({ message: '쉬운 난이도로 방 만들어줘', gameRoomId: 'room-1' }),
        },
      ],
    });
    expect(result).toMatchObject({
      requestType: 'ROOM_CREATE',
      payload: { desiredDifficulty: 'EASY' },
    });
  });

  it('falls back to heuristics when shared client fails', async () => {
    (configService.get as jest.Mock).mockImplementation((key: string) => {
      if (key === 'llm.apiKey') {
        return 'test-key';
      }
      if (key === 'llm.model') {
        return 'gpt-test';
      }
      return undefined;
    });
    chatCompletionsClient.createCompletion.mockRejectedValue(new Error('LLM down'));

    const result = await service.parseUserMessage({ message: '쉬운 난이도로 방 만들어줘' });

    expect(result.requestType).toBe('ROOM_CREATE');
    expect(result.payload).toMatchObject({ desiredDifficulty: 'EASY' });
  });
});
