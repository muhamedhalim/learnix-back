import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Entitlement, EntitlementStatus, ItemType } from '../entities';

@Injectable()
export class EntitlementsService {
  constructor(
    @InjectRepository(Entitlement)
    private readonly entitlements: Repository<Entitlement>,
  ) {}

  public async hasItemAccess(
    studentId: string,
    itemType: ItemType,
    itemId: string,
  ): Promise<boolean> {
    const now = new Date();
    const direct = await this.entitlements
      .createQueryBuilder('entitlement')
      .where('entitlement.student_id = :studentId', { studentId })
      .andWhere('entitlement.item_type = :itemType', { itemType })
      .andWhere('entitlement.item_id = :itemId', { itemId })
      .andWhere('entitlement.status = :status', { status: EntitlementStatus.ACTIVE })
      .andWhere('(entitlement.expires_at IS NULL OR entitlement.expires_at > :now)', { now })
      .getExists();
    if (direct || itemType !== ItemType.LESSON) return direct;

    return this.entitlements
      .createQueryBuilder('entitlement')
      .where('entitlement.student_id = :studentId', { studentId })
      .andWhere('entitlement.item_type = :packageType', { packageType: ItemType.PACKAGE })
      .andWhere('entitlement.status = :status', { status: EntitlementStatus.ACTIVE })
      .andWhere('(entitlement.expires_at IS NULL OR entitlement.expires_at > :now)', { now })
      .andWhere(
        `EXISTS (
          SELECT 1 FROM lesson_package_items item
          WHERE item.package_id = entitlement.item_id
            AND item.lesson_id = :itemId
        )`,
        { itemId },
      )
      .getExists();
  }

  public async getActive(
    studentId: string,
    itemType: ItemType,
    itemId: string,
  ): Promise<Entitlement | null> {
    return this.entitlements
      .createQueryBuilder('entitlement')
      .where('entitlement.student_id = :studentId', { studentId })
      .andWhere('entitlement.item_type = :itemType', { itemType })
      .andWhere('entitlement.item_id = :itemId', { itemId })
      .andWhere('entitlement.status = :status', { status: EntitlementStatus.ACTIVE })
      .andWhere('(entitlement.expires_at IS NULL OR entitlement.expires_at > NOW())')
      .orderBy('entitlement.granted_at', 'DESC')
      .getOne();
  }
}
