import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseIntPipe,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { DiscountCodesService } from '../discount-codes.service';
import {
  CreateDiscountCodeDto,
  UpdateDiscountCodeDto,
  DiscountFilterDto,
} from '../dto';

@ApiTags('Admin - Discount Codes')
@Controller('admin/discount-codes')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('admin')
@ApiBearerAuth('JWT-auth')
export class AdminDiscountCodesController {
  constructor(private readonly discountCodesService: DiscountCodesService) {}

  @Post()
  @ApiOperation({
    summary: 'Create a new discount code',
    description: 'Creates a new discount code with the specified parameters.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Discount code created successfully',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Code already exists',
  })
  async create(@Body() dto: CreateDiscountCodeDto) {
    const discountCode = await this.discountCodesService.create(dto);
    return {
      message: 'Discount code created successfully',
      data: discountCode,
    };
  }

  @Get()
  @ApiOperation({
    summary: 'Get all discount codes',
    description:
      'Returns a paginated list of discount codes with optional filters.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'List of discount codes',
  })
  async findAll(@Query() filter: DiscountFilterDto) {
    return await this.discountCodesService.findAll(filter);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a discount code by ID',
    description:
      'Returns detailed information about a discount code including usage history.',
  })
  @ApiParam({ name: 'id', type: Number })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Discount code details',
  })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Code not found' })
  async findOne(@Param('id', ParseIntPipe) id: number) {
    const discountCode = await this.discountCodesService.findOne(id);
    return { data: discountCode };
  }

  @Get(':id/usage')
  @ApiOperation({
    summary: 'Get usage statistics for a discount code',
    description:
      'Returns usage statistics including who used the code and when.',
  })
  @ApiParam({ name: 'id', type: Number })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Usage statistics',
  })
  async getUsage(@Param('id', ParseIntPipe) id: number) {
    const stats = await this.discountCodesService.getUsageStats(id);
    return { data: stats };
  }

  @Put(':id')
  @ApiOperation({
    summary: 'Update a discount code',
    description:
      'Updates an existing discount code. Code value cannot be changed.',
  })
  @ApiParam({ name: 'id', type: Number })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Discount code updated successfully',
  })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Code not found' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateDiscountCodeDto,
  ) {
    const discountCode = await this.discountCodesService.update(id, dto);
    return {
      message: 'Discount code updated successfully',
      data: discountCode,
    };
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a discount code',
    description: 'Soft deletes a discount code. It will no longer be usable.',
  })
  @ApiParam({ name: 'id', type: Number })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Discount code deleted successfully',
  })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Code not found' })
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.discountCodesService.remove(id);
    return { message: 'Discount code deleted successfully' };
  }
}
