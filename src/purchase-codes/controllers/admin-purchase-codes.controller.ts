import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
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
import { GetUser } from '../../common/decorators/get-user.decorator';
import { JwtPayload } from '../../common/interfaces/user-request.interface';
import { PurchaseCodesService } from '../purchase-codes.service';
import { GeneratePurchaseCodesDto, PurchaseCodeFilterDto } from '../dto';

@ApiTags('Admin - Purchase Codes')
@Controller('admin/purchase-codes')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('admin')
@ApiBearerAuth('JWT-auth')
export class AdminPurchaseCodesController {
  constructor(private readonly purchaseCodesService: PurchaseCodesService) {}

  @Post('generate')
  @ApiOperation({
    summary: 'Generate purchase codes',
    description:
      'Generates a batch of purchase codes for a specific item (lesson or package).',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Purchase codes generated successfully',
  })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Item not found' })
  async generate(
    @Body() dto: GeneratePurchaseCodesDto,
    @GetUser() user: JwtPayload,
  ) {
    const codes = await this.purchaseCodesService.generateCodes(
      dto,
      user.userId,
    );
    return {
      message: `Generated ${codes.length} purchase codes`,
      data: codes.map((c) => ({
        code: c.code,
        type: c.type,
        item_id: c.item_id,
        expires_at: c.expires_at,
      })),
    };
  }

  @Get()
  @ApiOperation({
    summary: 'Get all purchase codes',
    description:
      'Returns a paginated list of purchase codes with optional filters.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'List of purchase codes',
  })
  async findAll(@Query() filter: PurchaseCodeFilterDto) {
    return await this.purchaseCodesService.findAll(filter);
  }

  @Get('stats')
  @ApiOperation({
    summary: 'Get purchase code statistics',
    description:
      'Returns statistics about purchase codes (total, used, unused, expired).',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Purchase code statistics',
  })
  async getStats() {
    const stats = await this.purchaseCodesService.getStats();
    return { data: stats };
  }

  @Get(':code')
  @ApiOperation({
    summary: 'Get a purchase code by code string',
    description: 'Returns detailed information about a specific purchase code.',
  })
  @ApiParam({ name: 'code', type: String })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Purchase code details',
  })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Code not found' })
  async findOne(@Param('code') code: string) {
    const purchaseCode = await this.purchaseCodesService.findByCode(code);
    if (!purchaseCode) {
      return { data: null, message: 'Purchase code not found' };
    }
    return { data: purchaseCode };
  }

  @Delete(':code')
  @ApiOperation({
    summary: 'Delete a purchase code',
    description:
      'Deletes an unused purchase code. Used codes cannot be deleted.',
  })
  @ApiParam({ name: 'code', type: String })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Purchase code deleted successfully',
  })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Code not found' })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Cannot delete used code',
  })
  async remove(@Param('code') code: string) {
    await this.purchaseCodesService.remove(code);
    return { message: 'Purchase code deleted successfully' };
  }
}
