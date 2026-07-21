export const PROMPT_TEMPLATE_KEY = {
  CHAT_INTENT_PARSE: 'chat_intent_parse',
  CHAT_FOLLOWUP_ROOM_CREATE: 'chat_followup_room_create',
  CHAT_FOLLOWUP_USER_INVITE: 'chat_followup_user_invite',
  CHAT_FOLLOWUP_ROOM_JOIN: 'chat_followup_room_join',
  CHAT_FOLLOWUP_USER_INVITE_DENY: 'chat_followup_user_invite_deny',
  CHAT_FOLLOWUP_GAME_START: 'chat_followup_game_start',
  CHAT_FOLLOWUP_ROOM_SUMMARY: 'chat_followup_room_summary',
  MISSION_FEEDBACK: 'mission_feedback',
} as const;

export type PromptTemplateKey =
  (typeof PROMPT_TEMPLATE_KEY)[keyof typeof PROMPT_TEMPLATE_KEY];
