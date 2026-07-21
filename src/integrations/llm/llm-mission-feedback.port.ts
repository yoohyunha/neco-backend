import type { MissionResultJudgeStatus } from '../../shared/enums';

export const LLM_MISSION_FEEDBACK_GENERATOR = Symbol('LLM_MISSION_FEEDBACK_GENERATOR');

export type MissionFeedbackSource = 'llm' | 'static_fallback';

export interface LlmMissionFeedbackInput {
  gameRoomId: string;
  judgeStatus: MissionResultJudgeStatus;
  turnId?: string | null;
  missionId?: string | null;
  stepId?: string | null;
  stepOrder?: number | null;
  stdout?: string | null;
  stderr?: string | null;
  detectedIssueSummaries?: readonly string[];
}

export interface LlmMissionFeedbackResult {
  feedbackMessage: string;
  feedbackSource: MissionFeedbackSource;
  templateKey: string | null;
}

export interface LlmMissionFeedbackGeneratorPort {
  generateMissionFeedback(input: LlmMissionFeedbackInput): Promise<LlmMissionFeedbackResult>;
}
