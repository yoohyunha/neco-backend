import { Column, Entity } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';

@Entity('ai_game_requests')
export class AiGameRequest extends BaseEntity {
  @Column({ name: 'ai_game_session_id', type: 'uuid' })
  aiGameSessionId!: string;

  @Column({ name: 'request_type', type: 'text' })
  requestType!: string;

  @Column({ name: 'turn_id', type: 'uuid', nullable: true })
  turnId!: string | null;

  @Column({ name: 'mission_id', type: 'uuid', nullable: true })
  missionId!: string | null;

  @Column({ name: 'request_payload', type: 'jsonb' })
  requestPayload!: Record<string, unknown>;

  @Column({ name: 'response_payload', type: 'jsonb', nullable: true })
  responsePayload!: Record<string, unknown> | null;

  @Column({ type: 'text' })
  status!: string;

  @Column({ name: 'requested_at', type: 'timestamptz' })
  requestedAt!: Date;

  @Column({ name: 'responded_at', type: 'timestamptz', nullable: true })
  respondedAt!: Date | null;
}
