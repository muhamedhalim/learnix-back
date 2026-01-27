import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { AttendanceCodesService } from '../attendance-codes.service';
import { AttendanceCodeFilterDto, GenerateAttendanceCodesDto } from '../dto';

@ApiTags('Admin - Attendance Codes')
@Controller('admin/attendance-codes')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('admin')
@ApiBearerAuth('JWT-auth')
export class AdminAttendanceCodesController {
  constructor(
    private readonly attendanceCodesService: AttendanceCodesService,
  ) {}

  @Post('generate')
  @ApiOperation({
    summary: 'Generate attendance codes',
    description:
      'Generates a batch of attendance codes for a specific item (lesson or package).',
  })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Item not found' })
  public async generate(
    @Body() dto: GenerateAttendanceCodesDto,
    @GetUser() user: JwtPayload,
  ): Promise<{
    message: string;
    data: Array<{
      code: string;
      type: string;
      item_id: string;
      expires_at: Date;
    }>;
  }> {
    const codes = await this.attendanceCodesService.generateCodes(
      dto,
      user.userId,
    );
    return {
      message: `Generated ${String(codes.length)} attendance codes`,
      data: codes.map((c) => ({
        code: c.code,
        type: c.type,
        item_id: c.item_id,
        expires_at: c.expires_at,
      })),
    };
  }

  @ApiResponse({
    status: HttpStatus.OK,
    description: 'List of attendance codes',
  })
  public async findAll(
    @Query() filter: AttendanceCodeFilterDto,
  ): Promise<unknown> {
    return await this.attendanceCodesService.findAll(filter);
  }

  @Get('stats')
  @ApiOperation({
    summary: 'Get attendance code statistics',
    description:
      'Returns statistics about attendance codes (total, used, unused, expired).',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Purchase code statistics',
  })
  public async getStats(): Promise<{ data: unknown }> {
    const stats = await this.attendanceCodesService.getStats();
    return { data: stats };
  }

  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Code not found' })
  public async findOne(@Param('code') code: string): Promise<{
    data: unknown;
    message?: string;
  }> {
    const attendanceCode = await this.attendanceCodesService.findByCode(code);
    if (!attendanceCode) {
      return { data: null, message: 'Purchase code not found' };
    }
    return { data: attendanceCode };
  }

  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Cannot delete used code',
  })
  public async remove(
    @Param('code') code: string,
  ): Promise<{ message: string }> {
    await this.attendanceCodesService.remove(code);
    return { message: 'Purchase code deleted successfully' };
  }
}
