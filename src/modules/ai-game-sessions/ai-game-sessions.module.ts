import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiGameSessionsService } from './ai-game-sessions.service';
import { AiGameRequest } from './entity/ai-game-request.entity';
import { AiGameSession } from './entity/ai-game-session.entity';
import { AiRealtimeEvent } from './entity/ai-realtime-event.entity';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([AiGameSession, AiGameRequest, AiRealtimeEvent]),
  ],
  providers: [AiGameSessionsService],
  exports: [AiGameSessionsService, TypeOrmModule],
})
export class AiGameSessionsModule {}
