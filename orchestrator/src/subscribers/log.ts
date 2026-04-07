import { RudraEvent, RudraEventBus } from "../events";
import { log } from "../logger";

function eventData(event: RudraEvent): Record<string, unknown> {
  const { type: _type, timestamp: _timestamp, ...data } = event;
  return data;
}

export class LogEventSubscriber {
  private readonly listener = (event: RudraEvent) => {
    log(event.type, eventData(event), event.timestamp);
  };

  constructor(private readonly eventBus: RudraEventBus) {
    this.eventBus.onAny(this.listener);
  }

  close(): void {
    this.eventBus.offAny(this.listener);
  }
}
