export enum AiChatSessionStatus {
  ACTIVE = 'ACTIVE',
  CLOSED = 'CLOSED',
  ERROR = 'ERROR',
}

export enum AiChatRequestType {
  ROOM_CREATE = 'ROOM_CREATE',
  USER_INVITE = 'USER_INVITE',
  ROOM_JOIN = 'ROOM_JOIN',
  USER_INVITE_DENY = 'USER_INVITE_DENY',
  GAME_START = 'GAME_START',
}

export enum AiChatRequestStatus {
  RECEIVED = 'RECEIVED',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

export enum AiChatMessageSenderType {
  USER = 'USER',
  ASSISTANT = 'ASSISTANT',
  SYSTEM = 'SYSTEM',
}

export enum AiChatMessageType {
  TEXT = 'TEXT',
  COMMAND_RESULT = 'COMMAND_RESULT',
  SYSTEM_NOTICE = 'SYSTEM_NOTICE',
}

export enum AiRealtimeEventType {
  SYSTEM_NOTIFICATION = 'SYSTEM_NOTIFICATION',
  MISSION_FEEDBACK = 'MISSION_FEEDBACK',
  MISSION_RESULT = 'MISSION_RESULT',
}

export enum AiGameSessionStatus {
  ACTIVE = 'ACTIVE',
  CLOSED = 'CLOSED',
  ERROR = 'ERROR',
}

export enum AiGameRequestType {
  DEBUG = 'DEBUG',
  JUDGE = 'JUDGE',
}

export enum AiGameRequestStatus {
  RECEIVED = 'RECEIVED',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

export enum AiRealtimeDeliveryStatus {
  PENDING = 'PENDING',
  SENT = 'SENT',
  FAILED = 'FAILED',
}
