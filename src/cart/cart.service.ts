import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonPackage } from '../packages/entities/lesson-package.entity';
import {
  AddToCartDto,
  CartItemResponseDto,
  CartResponseDto,
  CheckoutCartDto,
  PaymentMethod,
} from './dto';
import { Cart } from './entities/cart.entity';
import { CartItem, CartItemType } from './entities/cart-item.entity';
import { IsNull, Repository } from 'typeorm';

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
  public async addToCart(
    userId: string,
    dto: AddToCartDto,
  ): Promise<CartResponseDto> {
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

    // Fetch item details and build response
    const items: CartItemResponseDto[] = [];

    for (const item of cart.items) {
      const itemTitle = await this.getItemTitle(item.item_type, item.item_id);

      items.push({
        id: item.id,
        itemType: item.item_type,
        itemId: item.item_id,
        itemTitle,
        price: item.price,
      });
    }

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
  public async removeItem(
    userId: string,
    itemId: string,
  ): Promise<CartResponseDto> {
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
   * Checkout cart
   * Note: This is a placeholder - actual payment integration with Paymob
   * and attendance codes should be done via existing PaymentsService
   */
  public async checkout(
    userId: string,
    dto: CheckoutCartDto,
  ): Promise<{ message: string; data: unknown }> {
    const cart = await this.cartsRepository.findOne({
      where: { user_id: userId },
      relations: ['items'],
    });

    if (!cart || cart.items.length === 0) {
      throw new BadRequestException('Cart is empty');
    }

    // TODO: Implement actual checkout logic
    // 1. Calculate subtotal: cart.items.reduce((sum, item) => sum + Number(item.price), 0)
    // 2. Validate discount code via DiscountCodesService if provided
    // 3. Calculate total: subtotal - discountAmount
    // 4. Create payment transaction via PaymentsService or redeem attendance code

    // Apply discount code if provided (placeholder for now)
    if (dto.discountCode != null && dto.discountCode !== '') {
      cart.discount_code = dto.discountCode;
      // TODO: Validate and apply discount code
    }

    // Process payment based on method
    if (dto.paymentMethod === PaymentMethod.PAYMOB) {
      // TODO: Create Paymob payment intent via PaymentsService
      // const transaction = await this.paymentsService.createCartCheckout(userId, cart.items, total, discountAmount);
      // Return payment URL for redirect

      return {
        message: 'Payment initiated - redirect to Paymob',
        data: {
          paymentUrl: 'https://paymob.example.com/checkout/placeholder',
          transactionId: 'placeholder-transaction-id',
        },
      };
    }
    // PaymentMethod.ATTENDANCE_CODE
    if (dto.attendanceCode == null || dto.attendanceCode === '') {
      throw new BadRequestException(
        'Attendance code required for this payment method',
      );
    }

    // TODO: Verify and redeem attendance code via AttendanceCodesService
    // const code = await this.attendanceCodesService.verifyAndRedeem(dto.attendanceCode, userId);
    // Grant access to all cart items via PaymentsService
    // await this.paymentsService.grantBulkAccess(userId, cart.items);

    // Clear cart after successful checkout
    await this.clearCart(userId);

    return {
      message: 'Checkout successful with attendance code',
      data: {
        attendanceCode: dto.attendanceCode,
        itemsGranted: cart.items.length,
      },
    };
  }

  /**
   * Clear cart (called after successful checkout)
   */
  public async clearCart(userId: string): Promise<void> {
    const cart = await this.cartsRepository.findOne({
      where: { user_id: userId },
    });

    if (cart) {
      // Cascade delete will remove all cart items
      await this.cartsRepository.remove(cart);
    }
  }

  /**
   * Helper: Get item price by type and ID
   */
  private async getItemPrice(
    itemType: CartItemType,
    itemId: string,
  ): Promise<number> {
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
   * Helper: Get item title by type and ID
   */
  private async getItemTitle(
    itemType: CartItemType,
    itemId: string,
  ): Promise<string> {
    if (itemType === CartItemType.LESSON) {
      const lesson = await this.lessonsRepository.findOne({
        where: { id: itemId, deleted_at: IsNull() },
      });

      return lesson?.title ?? 'Unknown Lesson';
    }
    // CartItemType.PACKAGE
    const pkg = await this.packagesRepository.findOne({
      where: { id: itemId, deleted_at: IsNull() },
    });

    return pkg?.title ?? 'Unknown Package';
  }
}
