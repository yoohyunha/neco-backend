import { Column, Entity } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';

@Entity('ai_game_sessions')
export class AiGameSession extends BaseEntity {
  @Column({ name: 'game_room_id', type: 'uuid' })
  gameRoomId!: string;

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
