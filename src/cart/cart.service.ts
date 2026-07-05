import {
  ConflictException,
  Injectable,
  NotFoundException,
  NotImplementedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { In, IsNull, Repository } from 'typeorm';

import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonPackage } from '../packages/entities/lesson-package.entity';
import { AddToCartDto, CartItemResponseDto, CartResponseDto, CheckoutCartDto } from './dto';
import { Cart } from './entities/cart.entity';
import { CartItem, CartItemType } from './entities/cart-item.entity';

@Injectable()
export class CartService {
  constructor(
    @InjectRepository(Cart)
    private readonly cartsRepository: Repository<Cart>,
    @InjectRepository(CartItem)
    private readonly cartItemsRepository: Repository<CartItem>,
    @InjectRepository(Lesson)
    private readonly lessonsRepository: Repository<Lesson>,
    @InjectRepository(LessonPackage)
    private readonly packagesRepository: Repository<LessonPackage>,
  ) {}

  /**
   * Add item to cart
   * Creates cart if doesn't exist, checks for duplicates, fetches price
   */
  public async addToCart(userId: string, dto: AddToCartDto): Promise<CartResponseDto> {
    // Find or create cart
    let cart = await this.cartsRepository.findOne({
      where: { user_id: userId },
      relations: ['items'],
    });

    if (!cart) {
      cart = this.cartsRepository.create({ user_id: userId });
      cart = await this.cartsRepository.save(cart);
      cart.items = [];
    }

    // Check if item already in cart
    const existingItem = cart.items.find(
      (item) => item.item_type === dto.itemType && item.item_id === dto.itemId,
    );

    if (existingItem) {
      throw new ConflictException('Item already in cart');
    }

    // Fetch item price
    const price = await this.getItemPrice(dto.itemType, dto.itemId);

    // Create cart item
    const cartItem = this.cartItemsRepository.create({
      cart_id: cart.id,
      item_type: dto.itemType,
      item_id: dto.itemId,
      price,
    });

    await this.cartItemsRepository.save(cartItem);

    // Reload cart with items
    return await this.findCart(userId);
  }

  /**
   * Get cart for user with calculated totals
   */
  public async findCart(userId: string): Promise<CartResponseDto> {
    const cart = await this.cartsRepository.findOne({
      where: { user_id: userId },
      relations: ['items'],
    });

    if (!cart) {
      // Return empty cart
      return {
        id: '',
        items: [],
        subtotal: 0,
        discountCode: null,
        discountAmount: 0,
        total: 0,
      };
    }

    // Resolve all item titles in a fixed number of queries (2, run in parallel)
    // instead of one query per cart item — avoids an N+1 on this hot path
    // (findCart also runs after every add / remove / clear).
    const titles = await this.resolveItemTitles(cart.items);

    const items: CartItemResponseDto[] = cart.items.map((item) => ({
      id: item.id,
      itemType: item.item_type,
      itemId: item.item_id,
      itemTitle:
        titles.get(item.item_id) ??
        (item.item_type === CartItemType.LESSON ? 'Unknown Lesson' : 'Unknown Package'),
      price: item.price,
    }));

    const subtotal = items.reduce((sum, item) => sum + item.price, 0);
    const discountAmount = cart.discount_amount;
    const total = Math.max(0, subtotal - discountAmount);

    return {
      id: cart.id,
      items,
      subtotal,
      discountCode: cart.discount_code,
      discountAmount,
      total,
    };
  }

  /**
   * Remove item from cart
   */
  public async removeItem(userId: string, itemId: string): Promise<CartResponseDto> {
    const cart = await this.cartsRepository.findOne({
      where: { user_id: userId },
      relations: ['items'],
    });

    if (!cart) {
      throw new NotFoundException('Cart not found');
    }

    const item = cart.items.find((i) => i.id === itemId);

    if (!item) {
      throw new NotFoundException('Item not found in cart');
    }

    await this.cartItemsRepository.remove(item);

    // Reload cart with updated items
    return await this.findCart(userId);
  }

  /**
   * Checkout cart.
   *
   * NOT YET IMPLEMENTED. Multi-item cart checkout requires a payment design that
   * does not exist yet: the Payment schema models a single item per payment, so
   * a cart of N items needs either a "cart order" concept (Paymob charges one
   * order) or a bulk attendance-code redemption + bulk access grant.
   *
   * The previous placeholder was actively harmful: it returned a fake Paymob URL
   * and, for the attendance-code path, CLEARED THE CART and reported success
   * without redeeming the code or granting any access (silent data loss + a lie
   * to the user). Until the real flow is built we fail honestly with 501 so the
   * client shows an error instead of a false success; students purchase items
   * individually through the payments endpoints in the meantime.
   */
  public checkout(
    _userId: string,
    _dto: CheckoutCartDto,
  ): Promise<{ message: string; data: unknown }> {
    throw new NotImplementedException(
      'Cart checkout is not available yet. Please purchase items individually.',
    );
  }

  /**
   * Helper: Get item price by type and ID
   */
  private async getItemPrice(itemType: CartItemType, itemId: string): Promise<number> {
    if (itemType === CartItemType.LESSON) {
      const lesson = await this.lessonsRepository.findOne({
        where: { id: itemId, deleted_at: IsNull() },
      });

      if (!lesson) {
        throw new NotFoundException(`Lesson with ID ${itemId} not found`);
      }

      return lesson.price;
    }
    // CartItemType.PACKAGE
    const pkg = await this.packagesRepository.findOne({
      where: { id: itemId, deleted_at: IsNull() },
    });

    if (!pkg) {
      throw new NotFoundException(`Package with ID ${itemId} not found`);
    }

    return pkg.price;
  }

  /**
   * Resolve titles for a set of cart items in bulk. Groups by type and issues at
   * most two `IN (...)` queries (lessons + packages) in parallel, returning a
   * Map keyed by item id. O(1) round-trips regardless of cart size.
   */
  private async resolveItemTitles(cartItems: CartItem[]): Promise<Map<string, string>> {
    const lessonIds = cartItems
      .filter((i) => i.item_type === CartItemType.LESSON)
      .map((i) => i.item_id);
    const packageIds = cartItems
      .filter((i) => i.item_type === CartItemType.PACKAGE)
      .map((i) => i.item_id);

    const [lessons, packages] = await Promise.all([
      lessonIds.length > 0
        ? this.lessonsRepository.find({
            where: { id: In(lessonIds), deleted_at: IsNull() },
            select: { id: true, title: true },
          })
        : Promise.resolve([]),
      packageIds.length > 0
        ? this.packagesRepository.find({
            where: { id: In(packageIds), deleted_at: IsNull() },
            select: { id: true, title: true },
          })
        : Promise.resolve([]),
    ]);

    const titles = new Map<string, string>();
    for (const lesson of lessons) titles.set(lesson.id, lesson.title);
    for (const pkg of packages) titles.set(pkg.id, pkg.title);
    return titles;
  }
}
