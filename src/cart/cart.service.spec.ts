import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonPackage } from '../packages/entities/lesson-package.entity';
import { CartService } from './cart.service';
import { Cart } from './entities/cart.entity';
import { CartItem, CartItemType } from './entities/cart-item.entity';

describe('CartService.findCart — bulk title resolution (no N+1)', () => {
  let service: CartService;
  const cartsRepo = { findOne: jest.fn() };
  const cartItemsRepo = {};
  const lessonsRepo = { find: jest.fn(), findOne: jest.fn() };
  const packagesRepo = { find: jest.fn(), findOne: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CartService,
        { provide: getRepositoryToken(Cart), useValue: cartsRepo },
        { provide: getRepositoryToken(CartItem), useValue: cartItemsRepo },
        { provide: getRepositoryToken(Lesson), useValue: lessonsRepo },
        { provide: getRepositoryToken(LessonPackage), useValue: packagesRepo },
      ],
    }).compile();
    service = module.get(CartService);
  });

  const cartItem = (over: Partial<CartItem>): CartItem =>
    ({ id: 'ci', item_type: CartItemType.LESSON, price: 10, ...over }) as CartItem;

  it('resolves all titles with one bulk query per type (not per item)', async () => {
    cartsRepo.findOne.mockResolvedValue({
      id: 'cart-1',
      discount_amount: 0,
      discount_code: null,
      items: [
        cartItem({ id: 'a', item_type: CartItemType.LESSON, item_id: 'L1', price: 10 }),
        cartItem({ id: 'b', item_type: CartItemType.LESSON, item_id: 'L2', price: 20 }),
        cartItem({ id: 'c', item_type: CartItemType.PACKAGE, item_id: 'P1', price: 50 }),
      ],
    });
    lessonsRepo.find.mockResolvedValue([
      { id: 'L1', title: 'Lesson One' },
      { id: 'L2', title: 'Lesson Two' },
    ]);
    packagesRepo.find.mockResolvedValue([{ id: 'P1', title: 'Package One' }]);

    const result = await service.findCart('user-1');

    // Exactly one bulk query per type — no per-item findOne.
    expect(lessonsRepo.find).toHaveBeenCalledTimes(1);
    expect(packagesRepo.find).toHaveBeenCalledTimes(1);
    expect(lessonsRepo.findOne).not.toHaveBeenCalled();
    expect(packagesRepo.findOne).not.toHaveBeenCalled();

    expect(result.items.map((i) => i.itemTitle)).toEqual([
      'Lesson One',
      'Lesson Two',
      'Package One',
    ]);
    expect(result.subtotal).toBe(80);
    expect(result.total).toBe(80);
  });

  it('falls back to a placeholder title for missing/deleted items', async () => {
    cartsRepo.findOne.mockResolvedValue({
      id: 'cart-1',
      discount_amount: 0,
      discount_code: null,
      items: [cartItem({ id: 'a', item_type: CartItemType.LESSON, item_id: 'gone', price: 10 })],
    });
    lessonsRepo.find.mockResolvedValue([]); // deleted / not found
    packagesRepo.find.mockResolvedValue([]);

    const result = await service.findCart('user-1');
    expect(result.items[0]!.itemTitle).toBe('Unknown Lesson');
  });

  it('skips queries entirely for an empty cart', async () => {
    cartsRepo.findOne.mockResolvedValue(null);
    const result = await service.findCart('user-1');
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
    expect(lessonsRepo.find).not.toHaveBeenCalled();
  });
});
