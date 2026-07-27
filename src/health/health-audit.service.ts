import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { AuditLog } from '../activity-logs/entities';
import { sanitiseMetadata } from './health-sanitizer.util';

@Injectable()
export class HealthAuditService {
  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogs: Repository<AuditLog>,
  ) {}

  public async record(input: {
    adminId: string;
    action: string;
    target: string;
    details?: Record<string, unknown>;
    ipAddress?: string | null | undefined;
  }): Promise<void> {
    await this.auditLogs.save(
      this.auditLogs.create({
        admin_id: input.adminId,
        action: input.action,
        target_type: 'health_component',
        target_id: null,
        target_name: input.target.slice(0, 200),
        details: sanitiseMetadata(input.details ?? {}),
        ip_address: input.ipAddress?.slice(0, 45) ?? null,
      }),
    );
  }
}
