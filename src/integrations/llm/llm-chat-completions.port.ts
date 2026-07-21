export const LLM_CHAT_COMPLETIONS_CLIENT = Symbol('LLM_CHAT_COMPLETIONS_CLIENT');

export type LlmChatMessageRole = 'system' | 'user' | 'assistant';

export interface LlmChatMessage {
  role: LlmChatMessageRole;
  content: string;
}

export interface LlmChatCompletionsInput {
  model: string;
  messages: LlmChatMessage[];
  temperature: number;
  responseFormat?: { type: 'json_object' };
  timeoutMs?: number;
}

export interface LlmChatCompletionsOutput {
  content: string;
}

export interface LlmChatCompletionsClientPort {
  createCompletion(input: LlmChatCompletionsInput): Promise<LlmChatCompletionsOutput>;
}
