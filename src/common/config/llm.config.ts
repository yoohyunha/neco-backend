import { registerAs } from '@nestjs/config';

export default registerAs('llm', () => ({
  apiKey: process.env.LLM_API_KEY,
  baseUrl: process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1',
  model: process.env.LLM_MODEL ?? 'gpt-5_4-mini-2026-03-17',
  timeoutMs: parseInt(process.env.LLM_TIMEOUT_MS ?? '60000', 10),
}));
