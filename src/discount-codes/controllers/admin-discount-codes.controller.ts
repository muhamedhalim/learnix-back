import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiResponse, ApiTags } from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { PaginationMeta } from '../../common/interfaces/pagination.interface';
import { DiscountCodesService } from '../discount-codes.service';
import {
  CreateDiscountCodeDto,
  DiscountFilterDto,
  UpdateDiscountCodeDto,
} from '../dto';
import { DiscountCode } from '../entities';

@ApiTags('Admin - Discount Codes')
@Controller('admin/discount-codes')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('admin')
@ApiBearerAuth('JWT-auth')
export class AdminDiscountCodesController {
  constructor(private readonly discountCodesService: DiscountCodesService) {}

  @Post()
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Code already exists',
  })
  public async create(
    @Body() dto: CreateDiscountCodeDto,
  ): Promise<{ message: string; data: DiscountCode }> {
    const discountCode = await this.discountCodesService.create(dto);
    return {
      message: 'Discount code created successfully',
      data: discountCode,
    };
  }

  @Get()
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'List of discount codes',
  })
  public async findAll(
    @Query() filter: DiscountFilterDto,
  ): Promise<{ data: DiscountCode[]; meta: PaginationMeta }> {
    return await this.discountCodesService.findAll(filter);
  }

  @Get(':id')
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Code not found' })
  public async findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ data: DiscountCode }> {
    const discountCode = await this.discountCodesService.findOne(id);
    return { data: discountCode };
  }

  @Get(':id/usage')
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Usage statistics',
  })
  public async getUsage(@Param('id', ParseUUIDPipe) id: string): Promise<{
    data: {
      total_uses: number;
      remaining_uses: number;
      total_discount_given: number;
      users: Array<{ user_id: string; used_at: Date; discount_amount: number }>;
    };
  }> {
    const stats = await this.discountCodesService.getUsageStats(id);
    return { data: stats };
  }

  @Patch(':id')
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Code not found' })
  public async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDiscountCodeDto,
  ): Promise<{ message: string; data: DiscountCode }> {
    const discountCode = await this.discountCodesService.update(id, dto);
    return {
      message: 'Discount code updated successfully',
      data: discountCode,
    };
  }

  @Delete(':id')
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Code not found' })
  public async remove(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ message: string }> {
    await this.discountCodesService.remove(id);
    return { message: 'Discount code deleted successfully' };
  }
}
