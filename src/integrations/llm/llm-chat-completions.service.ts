import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  LlmChatCompletionsClientPort,
  LlmChatCompletionsInput,
  LlmChatCompletionsOutput,
} from './llm-chat-completions.port';

class RetryableLlmHttpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableLlmHttpError';
  }
}

@Injectable()
export class LlmChatCompletionsService implements LlmChatCompletionsClientPort {
  constructor(private readonly configService: ConfigService) {}

  async createCompletion(input: LlmChatCompletionsInput): Promise<LlmChatCompletionsOutput> {
    try {
      return await this.requestOnce(input);
    } catch (error) {
      if (!this.isRetryable(error)) {
        throw error;
      }
      return await this.requestOnce(input);
    }
  }

  private async requestOnce(input: LlmChatCompletionsInput): Promise<LlmChatCompletionsOutput> {
    const apiKey = this.configService.get<string>('llm.apiKey');
    if (!apiKey) {
      throw new Error('LLM API key is not configured');
    }

    const baseUrl =
      this.configService.get<string>('llm.baseUrl') ?? 'https://api.openai.com/v1';
    const timeoutMs =
      input.timeoutMs ?? this.configService.get<number>('llm.timeoutMs') ?? 60000;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const body: Record<string, unknown> = {
        model: input.model,
        temperature: input.temperature,
        messages: input.messages,
      };
      if (input.responseFormat) {
        body.response_format = input.responseFormat;
      }

      const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const message = `LLM HTTP ${response.status}`;
        if (response.status >= 500) {
          throw new RetryableLlmHttpError(message);
        }
        throw new Error(message);
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = payload.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('LLM empty response');
      }

      return { content };
    } finally {
      clearTimeout(timeout);
    }
  }

  private isRetryable(error: unknown): boolean {
    if (error instanceof RetryableLlmHttpError) {
      return true;
    }
    if (!(error instanceof Error)) {
      return false;
    }
    if (error.name === 'AbortError') {
      return true;
    }
    // Network failures from fetch typically surface as TypeError.
    return error instanceof TypeError;
  }
}
