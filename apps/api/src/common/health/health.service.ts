import { Injectable } from '@nestjs/common';

export interface HealthStatus {
  status: 'ok';
}

@Injectable()
export class HealthService {
  getStatus(): HealthStatus {
    return { status: 'ok' };
  }
}
