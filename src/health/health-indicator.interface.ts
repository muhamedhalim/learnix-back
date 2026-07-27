import type { HealthComponentResult } from './health.types';

export interface HealthIndicator {
  readonly id: string;
  check(force?: boolean): Promise<HealthComponentResult | HealthComponentResult[]>;
}
