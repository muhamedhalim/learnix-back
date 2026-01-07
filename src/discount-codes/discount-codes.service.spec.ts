/* eslint-disable @typescript-eslint/unbound-method */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DiscountCodesService } from './discount-codes.service';
import {
  DiscountCode,
  DiscountCodeUsage,
  DiscountType,
  ApplicableItem,
} from './entities';
import {
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';

describe('DiscountCodesService', () => {
  let service: DiscountCodesService;
  let discountCodesRepository: jest.Mocked<Repository<DiscountCode>>;

  const mockDiscountCode: Partial<DiscountCode> = {
    id: 1,
    code: 'SAVE20',
    discount_type: DiscountType.PERCENTAGE,
    discount_value: 20,
    applicable_to: [ApplicableItem.LESSON, ApplicableItem.PACKAGE],
    item_ids: null,
    max_uses: 100,
    used_count: 0,
    min_purchase_amount: 50,
    valid_from: new Date('2025-01-01'),
    valid_until: new Date('2025-12-31'),
    is_active: true,
    description: 'Save 20% on all items',
    created_at: new Date(),
    updated_at: new Date(),
  };

  const mockQueryBuilder = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DiscountCodesService,
        {
          provide: getRepositoryToken(DiscountCode),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            findOne: jest.fn(),
            softDelete: jest.fn(),
            createQueryBuilder: jest.fn(() => mockQueryBuilder),
          },
        },
        {
          provide: getRepositoryToken(DiscountCodeUsage),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            findOne: jest.fn(),
            count: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<DiscountCodesService>(DiscountCodesService);
    discountCodesRepository = module.get(getRepositoryToken(DiscountCode));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    const createDto = {
      code: 'NEWCODE',
      discount_type: DiscountType.PERCENTAGE,
      discount_value: 15,
      applicable_to: [ApplicableItem.LESSON, ApplicableItem.PACKAGE],
      max_uses: 50,
      min_purchase_amount: 100,
      valid_from: '2025-01-01T00:00:00Z',
      valid_until: '2025-12-31T23:59:59Z',
      is_active: true,
    };

    it('should create a discount code successfully', async () => {
      discountCodesRepository.findOne.mockResolvedValue(null);
      discountCodesRepository.create.mockReturnValue(
        mockDiscountCode as DiscountCode,
      );
      discountCodesRepository.save.mockResolvedValue(
        mockDiscountCode as DiscountCode,
      );

      const result = await service.create(createDto);

      expect(result).toBeDefined();
      expect(discountCodesRepository.create).toHaveBeenCalled();
      expect(discountCodesRepository.save).toHaveBeenCalled();
    });

    it('should throw ConflictException if code already exists', async () => {
      discountCodesRepository.findOne.mockResolvedValue(
        mockDiscountCode as DiscountCode,
      );

      await expect(service.create(createDto)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should throw BadRequestException if valid_until is before valid_from', async () => {
      discountCodesRepository.findOne.mockResolvedValue(null);

      const invalidDto = {
        ...createDto,
        valid_from: '2025-12-31T00:00:00Z',
        valid_until: '2025-01-01T00:00:00Z',
      };

      await expect(service.create(invalidDto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should uppercase the code', async () => {
      discountCodesRepository.findOne.mockResolvedValue(null);
      discountCodesRepository.create.mockReturnValue(
        mockDiscountCode as DiscountCode,
      );
      discountCodesRepository.save.mockResolvedValue(
        mockDiscountCode as DiscountCode,
      );

      await service.create({ ...createDto, code: 'lowercase' });

      expect(discountCodesRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'LOWERCASE' }),
      );
    });
  });

  describe('update', () => {
    const updateDto = {
      discount_value: 25,
      is_active: false,
    };

    it('should update a discount code successfully', async () => {
      discountCodesRepository.findOne.mockResolvedValue(
        mockDiscountCode as DiscountCode,
      );
      discountCodesRepository.save.mockImplementation((code) =>
        Promise.resolve(code as DiscountCode),
      );

      const result = await service.update(1, updateDto);

      expect(result).toBeDefined();
      expect(discountCodesRepository.save).toHaveBeenCalled();
    });

    it('should throw NotFoundException if code not found', async () => {
      discountCodesRepository.findOne.mockResolvedValue(null);

      await expect(service.update(999, updateDto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should validate dates when updating', async () => {
      discountCodesRepository.findOne.mockResolvedValue(
        mockDiscountCode as DiscountCode,
      );

      const invalidUpdate = {
        valid_from: '2025-12-31T00:00:00Z',
        valid_until: '2025-01-01T00:00:00Z',
      };

      await expect(service.update(1, invalidUpdate)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('remove', () => {
    it('should soft delete a discount code', async () => {
      discountCodesRepository.findOne.mockResolvedValue(
        mockDiscountCode as DiscountCode,
      );
      discountCodesRepository.softDelete.mockResolvedValue({
        affected: 1,
      } as never);

      await service.remove(1);

      expect(discountCodesRepository.softDelete).toHaveBeenCalledWith(1);
    });

    it('should throw NotFoundException if code not found', async () => {
      discountCodesRepository.findOne.mockResolvedValue(null);

      await expect(service.remove(999)).rejects.toThrow(NotFoundException);
    });
  });

  describe('findOne', () => {
    it('should return a discount code when found', async () => {
      discountCodesRepository.findOne.mockResolvedValue(
        mockDiscountCode as DiscountCode,
      );

      const result = await service.findOne(1);

      expect(result).toBeDefined();
      expect(result.id).toBe(1);
    });

    it('should throw NotFoundException when not found', async () => {
      discountCodesRepository.findOne.mockResolvedValue(null);

      await expect(service.findOne(999)).rejects.toThrow(NotFoundException);
    });
  });

  describe('findByCode', () => {
    it('should return a discount code when found', async () => {
      discountCodesRepository.findOne.mockResolvedValue(
        mockDiscountCode as DiscountCode,
      );

      const result = await service.findByCode('SAVE20');

      expect(result).toBeDefined();
      expect(result?.code).toBe('SAVE20');
    });

    it('should return null when not found', async () => {
      discountCodesRepository.findOne.mockResolvedValue(null);

      const result = await service.findByCode('INVALID');

      expect(result).toBeNull();
    });

    it('should uppercase the search code', async () => {
      discountCodesRepository.findOne.mockResolvedValue(null);

      await service.findByCode('save20');

      expect(discountCodesRepository.findOne).toHaveBeenCalledWith({
        where: { code: 'SAVE20', deleted_at: expect.anything() },
      });
    });
  });

  describe('findAll', () => {
    it('should return paginated discount codes', async () => {
      mockQueryBuilder.getManyAndCount.mockResolvedValue([
        [mockDiscountCode],
        1,
      ]);

      const result = await service.findAll({ page: 1, limit: 20 });

      expect(result.data).toHaveLength(1);
      expect(result.meta.total).toBe(1);
      expect(result.meta.page).toBe(1);
    });

    it('should apply filters', async () => {
      mockQueryBuilder.getManyAndCount.mockResolvedValue([[], 0]);

      await service.findAll({
        page: 1,
        limit: 20,
        is_active: true,
        discount_type: DiscountType.PERCENTAGE,
        include_expired: false,
      });

      expect(mockQueryBuilder.andWhere).toHaveBeenCalled();
    });
  });
});
