import { Clock } from '../clock';

export interface Escalation {
  id: string;
  summary: string;
  status: 'created';
  createdAt: string;
}

export class EscalationStore {
  private counter = 5001;

  create(summary: string, clock: Clock): Escalation {
    return {
      id: `ESC-${this.counter++}`,
      summary,
      status: 'created',
      createdAt: clock().toISOString(),
    };
  }
}
