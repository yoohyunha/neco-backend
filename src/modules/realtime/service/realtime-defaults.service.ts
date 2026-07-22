import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { TurnsService } from '@modules/turns/service/turns.service';
import {
  RealtimeAssistiveMessageRequest,
  RealtimeAssistiveMessageService,
  RealtimeTurnSubmitRequest,
  RealtimeTurnSubmitService,
} from './realtime.interfaces';
import { RealtimeEventSupportService } from './realtime-event-support.service';

@Injectable()
export class DefaultRealtimeTurnSubmitService implements RealtimeTurnSubmitService {
  private readonly logger = new Logger(DefaultRealtimeTurnSubmitService.name);

  constructor(
    private readonly turnsService: TurnsService,
    private readonly realtimeEventSupportService: RealtimeEventSupportService,
  ) {}

  async submitTurn(input: RealtimeTurnSubmitRequest): Promise<void> {
    try {
      const result = await this.turnsService.submitTurn({
        gameRoomId: input.gameRoomId,
        turnId: input.turnId,
        userId: input.userId,
        occurredAt: input.occurredAt,
        files: input.files,
      });

      await this.realtimeEventSupportService.publishTurnLifecycleResult(result);
    } catch (error) {
      if (error instanceof ConflictException) {
        const code = getConflictCode(error) ?? 'UNKNOWN_CONFLICT';
        this.logger.warn(
          `Turn submit conflict for room ${input.gameRoomId}, turn ${input.turnId}: ${code}`,
        );
      }

      throw error;
    }
  }
}

function getConflictCode(error: ConflictException): string | undefined {
  const response = error.getResponse();

  if (typeof response === 'object' && response !== null && 'code' in response) {
    const code = (response as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }

  return undefined;
}

@Injectable()
export class DefaultRealtimeAssistiveMessageService
  implements RealtimeAssistiveMessageService
{
  async buildNotice(_input: RealtimeAssistiveMessageRequest) {
    return null;
  }
}
