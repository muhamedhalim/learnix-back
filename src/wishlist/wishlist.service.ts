import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { In, IsNull, Repository } from 'typeorm';

import { CartService } from '../cart/cart.service';
import { CartItemType } from '../cart/entities/cart-item.entity';
import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonPackage } from '../packages/entities/lesson-package.entity';
import {
  AddToWishlistDto,
  TopWishlistedItemDto,
  WishlistItemResponseDto,
  WishlistQueryDto,
  WishlistResponseDto,
  WishlistSort,
} from './dto';
import { WishlistItem, WishlistItemType } from './entities/wishlist-item.entity';

/** Denormalised item details resolved in bulk for a set of wishlist entries. */
interface ResolvedItem {
  title: string;
  price: number;
  thumbnail: string | null;
}

@Injectable()
export class WishlistService {
  constructor(
    @InjectRepository(WishlistItem)
    private readonly wishlistRepository: Repository<WishlistItem>,
    @InjectRepository(Lesson)
    private readonly lessonsRepository: Repository<Lesson>,
    @InjectRepository(LessonPackage)
    private readonly packagesRepository: Repository<LessonPackage>,
    private readonly cartService: CartService,
  ) {}

  /**
   * Add an item to the wishlist. Idempotent per (user, item): a second add of
   * the same item is a 409 rather than a duplicate row.
   */
  public async addToWishlist(
    userId: string,
    dto: AddToWishlistDto,
  ): Promise<WishlistItemResponseDto> {
    // Verify the referenced item exists (and is not soft-deleted).
    await this.assertItemExists(dto.itemType, dto.itemId);

    const existing = await this.wishlistRepository.findOne({
      where: {
        user_id: userId,
        item_type: dto.itemType,
        item_id: dto.itemId,
      },
    });

    if (existing) {
      throw new ConflictException('Item is already in your wishlist');
    }

    const entry = this.wishlistRepository.create({
      user_id: userId,
      item_type: dto.itemType,
      item_id: dto.itemId,
    });
    const saved = await this.wishlistRepository.save(entry);

    const resolved = await this.resolveItems([saved]);
    return this.toResponse(saved, resolved);
  }

  /**
   * Toggle an item's wishlist membership. Returns the resulting state so a
   * catalogue "heart" button can flip without knowing the wishlist entry id.
   * Idempotent by design (calling twice returns to the original state).
   */
  public async toggle(
    userId: string,
    dto: AddToWishlistDto,
  ): Promise<{ wishlisted: boolean }> {
    const existing = await this.wishlistRepository.findOne({
      where: {
        user_id: userId,
        item_type: dto.itemType,
        item_id: dto.itemId,
      },
    });

    if (existing) {
      await this.wishlistRepository.remove(existing);
      return { wishlisted: false };
    }

    await this.assertItemExists(dto.itemType, dto.itemId);
    const entry = this.wishlistRepository.create({
      user_id: userId,
      item_type: dto.itemType,
      item_id: dto.itemId,
    });
    await this.wishlistRepository.save(entry);
    return { wishlisted: true };
  }

  /**
   * List the user's wishlist with resolved item details, filtered and sorted.
   * Item details are resolved in at most two `IN (...)` queries (no N+1).
   */
  public async getWishlist(
    userId: string,
    query: WishlistQueryDto,
  ): Promise<WishlistResponseDto> {
    const where = query.itemType
      ? { user_id: userId, item_type: query.itemType }
      : { user_id: userId };

    const entries = await this.wishlistRepository.find({
      where,
      order: { created_at: 'DESC' },
    });

    const resolved = await this.resolveItems(entries);
    const items = entries.map((entry) => this.toResponse(entry, resolved));

    this.sortItems(items, query.sort ?? WishlistSort.RECENT);

    return { items, count: items.length };
  }

  /**
   * Number of items in the user's wishlist (for the count badge).
   */
  public async getCount(userId: string): Promise<number> {
    return this.wishlistRepository.count({ where: { user_id: userId } });
  }

  /**
   * The (item_type, item_id) pairs a user has wishlisted — lets the frontend
   * render heart states across catalogue pages without per-card requests.
   */
  public async getWishlistedRefs(
    userId: string,
  ): Promise<{ itemType: WishlistItemType; itemId: string }[]> {
    const entries = await this.wishlistRepository.find({
      where: { user_id: userId },
      select: { item_type: true, item_id: true },
    });
    return entries.map((e) => ({ itemType: e.item_type, itemId: e.item_id }));
  }

  /**
   * Remove a wishlist entry by its id (ownership-scoped).
   */
  public async removeItem(userId: string, itemId: string): Promise<void> {
    const entry = await this.wishlistRepository.findOne({
      where: { id: itemId, user_id: userId },
    });

    if (!entry) {
      throw new NotFoundException('Wishlist item not found');
    }

    await this.wishlistRepository.remove(entry);
  }

  /**
   * Move a wishlisted item into the cart, then drop it from the wishlist.
   * Reuses the existing CartService so cart rules (price snapshot, duplicate
   * detection) stay in one place. If the item is already in the cart we treat
   * that as success and still remove it from the wishlist.
   */
  public async moveToCart(userId: string, itemId: string): Promise<void> {
    const entry = await this.wishlistRepository.findOne({
      where: { id: itemId, user_id: userId },
    });

    if (!entry) {
      throw new NotFoundException('Wishlist item not found');
    }

    try {
      await this.cartService.addToCart(userId, {
        itemType: entry.item_type as unknown as CartItemType,
        itemId: entry.item_id,
      });
    } catch (error) {
      // Already in cart → not an error for a "move" operation; fall through to
      // removing the wishlist entry. Any other failure propagates.
      if (!(error instanceof ConflictException)) {
        throw error;
      }
    }

    await this.wishlistRepository.remove(entry);
  }

  /**
   * Admin analytics: the most-wishlisted items across all users.
   */
  public async getTopWishlisted(limit = 10): Promise<TopWishlistedItemDto[]> {
    const rows = await this.wishlistRepository
      .createQueryBuilder('w')
      .select('w.item_type', 'item_type')
      .addSelect('w.item_id', 'item_id')
      .addSelect('COUNT(*)', 'count')
      .groupBy('w.item_type')
      .addGroupBy('w.item_id')
      .orderBy('count', 'DESC')
      .limit(limit)
      .getRawMany<{ item_type: WishlistItemType; item_id: string; count: string }>();

    // Resolve titles for the ranked ids (bulk, no N+1).
    const pseudoEntries = rows.map((r) => ({
      item_type: r.item_type,
      item_id: r.item_id,
    })) as WishlistItem[];
    const resolved = await this.resolveItems(pseudoEntries);

    return rows.map((r) => ({
      itemType: r.item_type,
      itemId: r.item_id,
      title: resolved.get(this.key(r.item_type, r.item_id))?.title ?? 'Unavailable',
      wishlistCount: Number.parseInt(r.count, 10),
    }));
  }

  /* ===================== Helpers ===================== */

  private key(type: WishlistItemType, id: string): string {
    return `${type}:${id}`;
  }

  private toResponse(
    entry: WishlistItem,
    resolved: Map<string, ResolvedItem>,
  ): WishlistItemResponseDto {
    const details = resolved.get(this.key(entry.item_type, entry.item_id));
    return {
      id: entry.id,
      itemType: entry.item_type,
      itemId: entry.item_id,
      title: details?.title ?? 'Unavailable item',
      price: details?.price ?? 0,
      thumbnail: details?.thumbnail ?? null,
      available: details !== undefined,
      addedAt: entry.created_at,
    };
  }

  private sortItems(
    items: WishlistItemResponseDto[],
    sort: WishlistSort,
  ): void {
    switch (sort) {
      case WishlistSort.OLDEST:
        items.sort((a, b) => a.addedAt.getTime() - b.addedAt.getTime());
        break;
      case WishlistSort.PRICE_ASC:
        items.sort((a, b) => a.price - b.price);
        break;
      case WishlistSort.PRICE_DESC:
        items.sort((a, b) => b.price - a.price);
        break;
      case WishlistSort.TITLE:
        items.sort((a, b) => a.title.localeCompare(b.title));
        break;
      case WishlistSort.RECENT:
      default:
        items.sort((a, b) => b.addedAt.getTime() - a.addedAt.getTime());
        break;
    }
  }

  /**
   * Resolve title/price/thumbnail for a set of entries in bulk. At most two
   * queries (lessons + packages) run in parallel regardless of list size.
   */
  private async resolveItems(
    entries: Pick<WishlistItem, 'item_type' | 'item_id'>[],
  ): Promise<Map<string, ResolvedItem>> {
    const lessonIds = entries
      .filter((e) => e.item_type === WishlistItemType.LESSON)
      .map((e) => e.item_id);
    const packageIds = entries
      .filter((e) => e.item_type === WishlistItemType.PACKAGE)
      .map((e) => e.item_id);

    const [lessons, packages] = await Promise.all([
      lessonIds.length > 0
        ? this.lessonsRepository.find({
            where: { id: In(lessonIds), deleted_at: IsNull() },
            select: { id: true, title: true, price: true, thumbnail: true },
          })
        : Promise.resolve([]),
      packageIds.length > 0
        ? this.packagesRepository.find({
            where: { id: In(packageIds), deleted_at: IsNull() },
            select: { id: true, title: true, price: true, thumbnail: true },
          })
        : Promise.resolve([]),
    ]);

    const resolved = new Map<string, ResolvedItem>();
    for (const lesson of lessons) {
      resolved.set(this.key(WishlistItemType.LESSON, lesson.id), {
        title: lesson.title,
        price: Number(lesson.price),
        thumbnail: lesson.thumbnail,
      });
    }
    for (const pkg of packages) {
      resolved.set(this.key(WishlistItemType.PACKAGE, pkg.id), {
        title: pkg.title,
        price: Number(pkg.price),
        thumbnail: pkg.thumbnail,
      });
    }
    return resolved;
  }

  private async assertItemExists(
    itemType: WishlistItemType,
    itemId: string,
  ): Promise<void> {
    if (itemType === WishlistItemType.LESSON) {
      const lesson = await this.lessonsRepository.findOne({
        where: { id: itemId, deleted_at: IsNull() },
        select: { id: true },
      });
      if (!lesson) {
        throw new NotFoundException(`Lesson with ID ${itemId} not found`);
      }
      return;
    }

    const pkg = await this.packagesRepository.findOne({
      where: { id: itemId, deleted_at: IsNull() },
      select: { id: true },
    });
    if (!pkg) {
      throw new NotFoundException(`Package with ID ${itemId} not found`);
    }
  }
}
