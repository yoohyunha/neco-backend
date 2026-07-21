import { ConfigService } from '@nestjs/config';
import { LlmChatCompletionsService } from './llm-chat-completions.service';

describe('LlmChatCompletionsService', () => {
  const configService = {
    get: jest.fn((key: string) => {
      if (key === 'llm.apiKey') {
        return 'test-api-key';
      }
      if (key === 'llm.baseUrl') {
        return 'https://api.example.com/v1/';
      }
      if (key === 'llm.timeoutMs') {
        return 60000;
      }
      return undefined;
    }),
  } as unknown as ConfigService;

  let service: LlmChatCompletionsService;
  let originalFetch: typeof fetch;

  const baseInput = {
    model: 'gpt-5_4-mini-2026-03-17',
    temperature: 0,
    messages: [
      { role: 'system' as const, content: 'system' },
      { role: 'user' as const, content: 'hello' },
    ],
  };

  beforeEach(() => {
    service = new LlmChatCompletionsService(configService);
    originalFetch = global.fetch;
    jest.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns completion content on success', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'ok-content' } }],
      }),
    });
    global.fetch = fetchMock as typeof fetch;

    const result = await service.createCompletion({
      ...baseInput,
      responseFormat: { type: 'json_object' },
      timeoutMs: 5000,
    });

    expect(result).toEqual({ content: 'ok-content' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-api-key',
          'Content-Type': 'application/json',
        },
      }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({
      model: 'gpt-5_4-mini-2026-03-17',
      temperature: 0,
      messages: baseInput.messages,
      response_format: { type: 'json_object' },
    });
  });

  it('throws without retry on non-5xx HTTP errors', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
    });
    global.fetch = fetchMock as typeof fetch;

    await expect(service.createCompletion(baseInput)).rejects.toThrow('LLM HTTP 400');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws on empty completion content', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '' } }],
      }),
    });
    global.fetch = fetchMock as typeof fetch;

    await expect(service.createCompletion(baseInput)).rejects.toThrow('LLM empty response');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts on timeout and retries once then fails', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    const fetchMock = jest.fn().mockRejectedValue(abortError);
    global.fetch = fetchMock as typeof fetch;

    await expect(
      service.createCompletion({ ...baseInput, timeoutMs: 1 }),
    ).rejects.toThrow('The operation was aborted');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries once on HTTP 5xx then fails', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
    });
    global.fetch = fetchMock as typeof fetch;

    await expect(service.createCompletion(baseInput)).rejects.toThrow('LLM HTTP 503');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries once on transient failure then returns success', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'recovered' } }],
        }),
      });
    global.fetch = fetchMock as typeof fetch;

    await expect(service.createCompletion(baseInput)).resolves.toEqual({
      content: 'recovered',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
