import { ConflictException, NotFoundException } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { CartService } from '../cart/cart.service';
import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonPackage } from '../packages/entities/lesson-package.entity';
import { WishlistSort } from './dto';
import { WishlistItem, WishlistItemType } from './entities/wishlist-item.entity';
import { WishlistService } from './wishlist.service';

describe('WishlistService', () => {
  let service: WishlistService;
  const wishlistRepo = {
    findOne: jest.fn(),
    find: jest.fn(),
    findAndCount: jest.fn(),
    count: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    remove: jest.fn(),
  };
  const lessonsRepo = { find: jest.fn(), findOne: jest.fn() };
  const packagesRepo = { find: jest.fn(), findOne: jest.fn() };
  const cartService = { addToCart: jest.fn(), findCart: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WishlistService,
        { provide: getRepositoryToken(WishlistItem), useValue: wishlistRepo },
        { provide: getRepositoryToken(Lesson), useValue: lessonsRepo },
        { provide: getRepositoryToken(LessonPackage), useValue: packagesRepo },
        { provide: CartService, useValue: cartService },
      ],
    }).compile();
    service = module.get(WishlistService);
  });

  const entry = (over: Partial<WishlistItem>): WishlistItem =>
    ({
      id: 'w1',
      user_id: 'u1',
      item_type: WishlistItemType.LESSON,
      item_id: 'L1',
      created_at: new Date('2026-01-01'),
      ...over,
    }) as WishlistItem;

  describe('addToWishlist', () => {
    it('rejects a lesson that does not exist', async () => {
      lessonsRepo.findOne.mockResolvedValue(null);
      await expect(
        service.addToWishlist('u1', { itemType: WishlistItemType.LESSON, itemId: 'L1' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(wishlistRepo.save).not.toHaveBeenCalled();
    });

    it('rejects a duplicate (already wishlisted)', async () => {
      lessonsRepo.findOne.mockResolvedValue({ id: 'L1' });
      wishlistRepo.findOne.mockResolvedValue(entry({}));
      await expect(
        service.addToWishlist('u1', { itemType: WishlistItemType.LESSON, itemId: 'L1' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('saves a new entry and returns resolved details', async () => {
      lessonsRepo.findOne.mockResolvedValue({ id: 'L1' });
      wishlistRepo.findOne.mockResolvedValue(null);
      const saved = entry({});
      wishlistRepo.create.mockReturnValue(saved);
      wishlistRepo.save.mockResolvedValue(saved);
      lessonsRepo.find.mockResolvedValue([
        { id: 'L1', title: 'Algebra', price: '30.00', thumbnail: null },
      ]);

      const result = await service.addToWishlist('u1', {
        itemType: WishlistItemType.LESSON,
        itemId: 'L1',
      });

      expect(result.title).toBe('Algebra');
      expect(result.price).toBe(30);
      expect(result.available).toBe(true);
    });
  });

  describe('getWishlist', () => {
    it('resolves item details in bulk and sorts by price ascending', async () => {
      wishlistRepo.findAndCount.mockResolvedValue([
        [entry({ id: 'w1', item_id: 'L1' }), entry({ id: 'w2', item_id: 'L2' })],
        2,
      ]);
      lessonsRepo.find.mockResolvedValue([
        { id: 'L1', title: 'Pricey', price: '99.00', thumbnail: null },
        { id: 'L2', title: 'Cheap', price: '10.00', thumbnail: null },
      ]);

      const result = await service.getWishlist('u1', { sort: WishlistSort.PRICE_ASC });

      expect(lessonsRepo.find).toHaveBeenCalledTimes(1);
      expect(result.count).toBe(2);
      expect(result.items.map((i) => i.title)).toEqual(['Cheap', 'Pricey']);
    });

    it('marks unavailable items as not available', async () => {
      wishlistRepo.findAndCount.mockResolvedValue([[entry({ item_id: 'gone' })], 1]);
      lessonsRepo.find.mockResolvedValue([]);

      const result = await service.getWishlist('u1', {});
      expect(result.items[0]!.available).toBe(false);
      expect(result.items[0]!.title).toBe('Unavailable item');
    });
  });

  describe('moveToCart', () => {
    it('adds to cart then removes the wishlist entry', async () => {
      const e = entry({});
      wishlistRepo.findOne.mockResolvedValue(e);
      const cart = { id: 'cart-1', items: [] };
      cartService.addToCart.mockResolvedValue(cart);

      await expect(service.moveToCart('u1', 'w1')).resolves.toBe(cart);

      expect(cartService.addToCart).toHaveBeenCalledWith('u1', {
        itemType: WishlistItemType.LESSON,
        itemId: 'L1',
      });
      expect(wishlistRepo.remove).toHaveBeenCalledWith(e);
    });

    it('treats an already-in-cart conflict as success and still removes', async () => {
      const e = entry({});
      wishlistRepo.findOne.mockResolvedValue(e);
      cartService.addToCart.mockRejectedValue(new ConflictException('Item already in cart'));
      const existingCart = { id: 'cart-1', items: [{ id: 'item-1' }] };
      cartService.findCart.mockResolvedValue(existingCart);

      await expect(service.moveToCart('u1', 'w1')).resolves.toBe(existingCart);

      expect(wishlistRepo.remove).toHaveBeenCalledWith(e);
      expect(cartService.findCart).toHaveBeenCalledWith('u1');
    });

    it('propagates non-conflict errors and does not remove', async () => {
      wishlistRepo.findOne.mockResolvedValue(entry({}));
      cartService.addToCart.mockRejectedValue(new NotFoundException('Lesson not found'));

      await expect(service.moveToCart('u1', 'w1')).rejects.toBeInstanceOf(NotFoundException);
      expect(wishlistRepo.remove).not.toHaveBeenCalled();
    });

    it('404s when the wishlist entry is missing', async () => {
      wishlistRepo.findOne.mockResolvedValue(null);
      await expect(service.moveToCart('u1', 'missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
