jest.mock('../gateway/realtime.gateway', () => ({
  RealtimeGateway: class RealtimeGateway {},
}));

jest.mock('./realtime-event-support.service', () => ({
  RealtimeEventSupportService: class RealtimeEventSupportService {},
}));

import { ConflictException } from '@nestjs/common';
import { TurnsService } from '@modules/turns/service/turns.service';
import { DefaultRealtimeTurnSubmitService } from './realtime-defaults.service';
import { RealtimeEventSupportService } from './realtime-event-support.service';

describe('DefaultRealtimeTurnSubmitService', () => {
  it('rethrows duplicate submit conflicts without publishing lifecycle events', async () => {
    const turnsService: jest.Mocked<Pick<TurnsService, 'submitTurn'>> = {
      submitTurn: jest.fn().mockRejectedValue(
        new ConflictException({
          code: 'TURN_NOT_IN_PROGRESS',
          message: 'Only an in-progress turn can be finished.',
        }),
      ),
    };
    const realtimeEventSupportService: jest.Mocked<
      Pick<RealtimeEventSupportService, 'publishTurnLifecycleResult'>
    > = {
      publishTurnLifecycleResult: jest.fn(),
    };
    const service = new DefaultRealtimeTurnSubmitService(
      turnsService as unknown as TurnsService,
      realtimeEventSupportService as unknown as RealtimeEventSupportService,
    );

    await expect(
      service.submitTurn({
        gameRoomId: 'room-1',
        turnId: 'turn-1',
        userId: 'user-1',
        occurredAt: '2026-05-27T10:00:00+09:00',
        files: [],
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'TURN_NOT_IN_PROGRESS',
      }),
    });

    expect(realtimeEventSupportService.publishTurnLifecycleResult).not.toHaveBeenCalled();
  });

  it('rethrows non-duplicate submit conflicts', async () => {
    const turnsService: jest.Mocked<Pick<TurnsService, 'submitTurn'>> = {
      submitTurn: jest.fn().mockRejectedValue(
        new ConflictException({
          code: 'TURN_PLAYER_REQUIRED',
          message: 'No joined participant is available for the next turn.',
        }),
      ),
    };
    const realtimeEventSupportService: jest.Mocked<
      Pick<RealtimeEventSupportService, 'publishTurnLifecycleResult'>
    > = {
      publishTurnLifecycleResult: jest.fn(),
    };
    const service = new DefaultRealtimeTurnSubmitService(
      turnsService as unknown as TurnsService,
      realtimeEventSupportService as unknown as RealtimeEventSupportService,
    );

    await expect(
      service.submitTurn({
        gameRoomId: 'room-1',
        turnId: 'turn-1',
        userId: 'user-1',
        occurredAt: '2026-05-27T10:00:00+09:00',
        files: [],
      }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'TURN_PLAYER_REQUIRED',
      }),
    });

    expect(realtimeEventSupportService.publishTurnLifecycleResult).not.toHaveBeenCalled();
  });
});
