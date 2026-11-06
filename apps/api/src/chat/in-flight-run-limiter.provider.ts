import { Provider } from '@nestjs/common';
import { InFlightRunLimiter } from './in-flight-run-limiter';
import { CHAT_SETTINGS } from './chat-settings.provider';
import { ChatSettings } from './chat.settings';

export const IN_FLIGHT_RUN_LIMITER = Symbol('IN_FLIGHT_RUN_LIMITER');

export const inFlightRunLimiterProvider: Provider = {
  provide: IN_FLIGHT_RUN_LIMITER,
  inject: [CHAT_SETTINGS],
  useFactory: (settings: ChatSettings) =>
    new InFlightRunLimiter({
      maxInFlight: settings.inFlightMaxRuns,
      maxQueued: settings.inFlightMaxQueued,
      retryAfterSeconds: settings.inFlightRetryAfterSeconds,
    }),
};
