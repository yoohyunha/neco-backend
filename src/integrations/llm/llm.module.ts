import { Module } from '@nestjs/common';
import { AiGameSessionsModule } from '../../modules/ai-game-sessions/ai-game-sessions.module';
import { PromptTemplateModule } from '../../modules/prompt-template/prompt-template.module';
import { LLM_CHAT_COMPLETIONS_CLIENT } from './llm-chat-completions.port';
import { LlmChatCompletionsService } from './llm-chat-completions.service';
import { LLM_FOLLOW_UP_GENERATOR } from './llm-follow-up.port';
import { LlmFollowUpService } from './llm-follow-up.service';
import { LLM_INTENT_PARSER } from './llm-intent-parser.port';
import { LlmIntentParserService } from './llm-intent-parser.service';
import { LLM_MISSION_FEEDBACK_GENERATOR } from './llm-mission-feedback.port';
import { LlmMissionFeedbackService } from './llm-mission-feedback.service';

/**
 * LLM integration adapter.
 * Covers: AI chat intent parsing, feedback generation, judgment assistance.
 */
@Module({
  imports: [PromptTemplateModule, AiGameSessionsModule],
  providers: [
    LlmChatCompletionsService,
    LlmIntentParserService,
    LlmFollowUpService,
    LlmMissionFeedbackService,
    {
      provide: LLM_CHAT_COMPLETIONS_CLIENT,
      useExisting: LlmChatCompletionsService,
    },
    {
      provide: LLM_INTENT_PARSER,
      useExisting: LlmIntentParserService,
    },
    {
      provide: LLM_FOLLOW_UP_GENERATOR,
      useExisting: LlmFollowUpService,
    },
    {
      provide: LLM_MISSION_FEEDBACK_GENERATOR,
      useExisting: LlmMissionFeedbackService,
    },
  ],
  exports: [
    LLM_CHAT_COMPLETIONS_CLIENT,
    LLM_INTENT_PARSER,
    LLM_FOLLOW_UP_GENERATOR,
    LLM_MISSION_FEEDBACK_GENERATOR,
    LlmChatCompletionsService,
    LlmIntentParserService,
    LlmFollowUpService,
    LlmMissionFeedbackService,
  ],
})
export class LlmIntegrationModule {}
