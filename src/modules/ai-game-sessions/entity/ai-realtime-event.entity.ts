import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('ai_realtime_events')
export class AiRealtimeEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'ai_game_request_id', type: 'uuid' })
  aiGameRequestId!: string;

  @Column({ name: 'ai_game_session_id', type: 'uuid' })
  aiGameSessionId!: string;

  @Column({ name: 'game_room_id', type: 'uuid' })
  gameRoomId!: string;

  @Column({ name: 'event_type', type: 'text' })
  eventType!: string;

  @Column({ name: 'target_user_id', type: 'uuid', nullable: true })
  targetUserId!: string | null;

  @Column({ type: 'text' })
  message!: string;

  @Column({ name: 'payload_json', type: 'jsonb', nullable: true })
  payloadJson!: Record<string, unknown> | null;

  @Column({ name: 'delivery_status', type: 'text' })
  deliveryStatus!: string;

  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date;

  @Column({ name: 'delivered_at', type: 'timestamptz', nullable: true })
  deliveredAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
