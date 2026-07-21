import { Column, Entity } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';

@Entity('ai_chat_sessions')
export class AiChatSession extends BaseEntity {
  @Column({ name: 'requester_user_id', type: 'uuid' })
  requesterUserId!: string;

  @Column({ name: 'game_room_id', type: 'uuid', nullable: true })
  gameRoomId!: string | null;

  @Column({ name: 'provider_conversation_id', type: 'text', nullable: true })
  providerConversationId!: string | null;

  @Column({ type: 'text' })
  provider!: string;

  @Column({ name: 'llm_model', type: 'text' })
  llmModel!: string;

  @Column({ type: 'text' })
  status!: string;

  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closedAt!: Date | null;
}
