import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { DatabaseModule } from './database/database.module';
import { JwtIntegrationModule } from './integrations/jwt/jwt.module';
import { AiChatSessionsModule } from './modules/ai-chat-sessions/ai-chat-sessions.module';
import { AiGameSessionsModule } from './modules/ai-game-sessions/ai-game-sessions.module';
import { AuthModule } from './modules/auth/auth.module';
import { PromptTemplateModule } from './modules/prompt-template/prompt-template.module';
import appConfig from './common/config/app.config';
import databaseConfig from './common/config/database.config';
import jwtConfig from './common/config/jwt.config';
import redisConfig from './common/config/redis.config';
import llmConfig from './common/config/llm.config';
import runtimeConfig from './common/config/runtime.config';
import { GameRoomsModule } from './modules/game-rooms/game-rooms.module';
import { GameRoomParticipantsModule } from './modules/game-room-participants/game-room-participants.module';
import { RealtimeModule } from './modules/realtime/realtime.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      load: [appConfig, databaseConfig, jwtConfig, redisConfig, llmConfig, runtimeConfig],
    }),
    DatabaseModule,
    JwtIntegrationModule,
    AuthModule,
    PromptTemplateModule,
    AiChatSessionsModule,
    AiGameSessionsModule,
    GameRoomsModule,
    GameRoomParticipantsModule,
    RealtimeModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
  ],
})
export class AppModule {}
