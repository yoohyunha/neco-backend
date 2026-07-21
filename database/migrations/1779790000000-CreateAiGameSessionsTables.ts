import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateAiGameSessionsTables1779790000000 implements MigrationInterface {
  name = 'CreateAiGameSessionsTables1779790000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "ai_game_sessions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "game_room_id" uuid NOT NULL,
        "provider_conversation_id" text,
        "provider" text NOT NULL,
        "llm_model" text NOT NULL,
        "status" text NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "closed_at" TIMESTAMPTZ,
        CONSTRAINT "PK_ai_game_sessions" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_ai_game_sessions_game_room_id" ON "ai_game_sessions" ("game_room_id")
    `);

    await queryRunner.query(`
      CREATE TABLE "ai_game_requests" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "ai_game_session_id" uuid NOT NULL,
        "request_type" text NOT NULL,
        "turn_id" uuid,
        "mission_id" uuid,
        "request_payload" jsonb NOT NULL,
        "response_payload" jsonb,
        "status" text NOT NULL,
        "requested_at" TIMESTAMPTZ NOT NULL,
        "responded_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ai_game_requests" PRIMARY KEY ("id"),
        CONSTRAINT "FK_ai_game_requests_session_id" FOREIGN KEY ("ai_game_session_id") REFERENCES "ai_game_sessions"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_ai_game_requests_session_requested_at"
      ON "ai_game_requests" ("ai_game_session_id", "requested_at")
    `);

    await queryRunner.query(`
      CREATE TABLE "ai_realtime_events" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "ai_game_request_id" uuid NOT NULL,
        "ai_game_session_id" uuid NOT NULL,
        "game_room_id" uuid NOT NULL,
        "event_type" text NOT NULL,
        "target_user_id" uuid,
        "message" text NOT NULL,
        "payload_json" jsonb,
        "delivery_status" text NOT NULL,
        "occurred_at" TIMESTAMPTZ NOT NULL,
        "delivered_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ai_realtime_events" PRIMARY KEY ("id"),
        CONSTRAINT "FK_ai_realtime_events_request_id" FOREIGN KEY ("ai_game_request_id") REFERENCES "ai_game_requests"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_ai_realtime_events_session_id" FOREIGN KEY ("ai_game_session_id") REFERENCES "ai_game_sessions"("id") ON DELETE CASCADE
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "ai_realtime_events"`);
    await queryRunner.query(`DROP INDEX "IDX_ai_game_requests_session_requested_at"`);
    await queryRunner.query(`DROP TABLE "ai_game_requests"`);
    await queryRunner.query(`DROP INDEX "IDX_ai_game_sessions_game_room_id"`);
    await queryRunner.query(`DROP TABLE "ai_game_sessions"`);
  }
}
