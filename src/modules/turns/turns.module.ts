import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LlmIntegrationModule } from '@integrations/llm/llm.module';
import { AiGameSessionsModule } from '@modules/ai-game-sessions/ai-game-sessions.module';
import { ExecutionsModule } from '@modules/executions/executions.module';
import { GameRoomMissionsModule } from '@modules/game-room-missions/game-room-missions.module';
import { MissionResultsModule } from '@modules/mission-results/mission-results.module';
import { TurnsService } from './service/turns.service';

/**
 * Responsibilities: create/end turns, create next turn, manage submission and
 * timeout state, persist turn snapshots.
 * To be implemented by Worker 2 / Worker 3.
 */
@Module({
  imports: [
    ConfigModule,
    ExecutionsModule,
    GameRoomMissionsModule,
    MissionResultsModule,
    LlmIntegrationModule,
    AiGameSessionsModule,
  ],
  providers: [TurnsService],
  exports: [TurnsService],
})
export class TurnsModule {}
