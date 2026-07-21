import { MigrationInterface, QueryRunner } from 'typeorm';

export class AllowClosedAiChatHistory1748329200000 implements MigrationInterface {
  name = 'AllowClosedAiChatHistory1748329200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "ai_chat_sessions"
      DROP CONSTRAINT "UQ_ai_chat_sessions_requester_user_id"
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_ai_chat_sessions_active_requester_user_id"
      ON "ai_chat_sessions" ("requester_user_id")
      WHERE "status" = 'ACTIVE'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX "IDX_ai_chat_sessions_active_requester_user_id"
    `);

    await queryRunner.query(`
      ALTER TABLE "ai_chat_sessions"
      ADD CONSTRAINT "UQ_ai_chat_sessions_requester_user_id" UNIQUE ("requester_user_id")
    `);
  }
}
