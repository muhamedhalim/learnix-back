import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { AttendanceCodesService } from '../attendance-codes.service';
import {
  AttendanceCodeFilterDto,
  GenerateAttendanceCodesDto,
  UpdateAttendanceCodeDto,
} from '../dto';

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

  @Get()
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

  @Get(':code')
  @ApiOperation({
    summary: 'Get attendance code details',
    description:
      'Returns detailed information about a specific attendance code.',
  })
  @ApiParam({ name: 'code', description: 'The attendance code string' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Code details' })
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

  @Patch(':code')
  @ApiOperation({
    summary: 'Update attendance code',
    description:
      'Updates an attendance code. Only allows updating expiration date. Cannot update used or deactivated codes.',
  })
  @ApiParam({ name: 'code', description: 'The attendance code string' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Code updated successfully',
  })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Code not found' })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Cannot update used or deactivated code',
  })
  public async updateCode(
    @Param('code') code: string,
    @Body() dto: UpdateAttendanceCodeDto,
  ): Promise<{ message: string; data: unknown }> {
    const updatedCode = await this.attendanceCodesService.updateCode(code, dto);
    return {
      message: 'Purchase code updated successfully',
      data: {
        code: updatedCode.code,
        type: updatedCode.type,
        item_id: updatedCode.item_id,
        expires_at: updatedCode.expires_at,
        is_active: updatedCode.is_active,
        is_used: updatedCode.is_used,
      },
    };
  }

  @Post(':code/deactivate')
  @ApiOperation({
    summary: 'Deactivate attendance code',
    description:
      'Deactivates an attendance code, making it unusable without deleting it. Cannot deactivate used codes.',
  })
  @ApiParam({ name: 'code', description: 'The attendance code string' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Code deactivated successfully',
  })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Code not found' })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Cannot deactivate used or already deactivated code',
  })
  public async deactivateCode(
    @Param('code') code: string,
  ): Promise<{ message: string; data: unknown }> {
    const deactivatedCode =
      await this.attendanceCodesService.deactivateCode(code);
    return {
      message: 'Purchase code deactivated successfully',
      data: {
        code: deactivatedCode.code,
        is_active: deactivatedCode.is_active,
      },
    };
  }

  @Post(':code/reactivate')
  @ApiOperation({
    summary: 'Reactivate attendance code',
    description:
      'Reactivates a previously deactivated attendance code. Cannot reactivate used or expired codes.',
  })
  @ApiParam({ name: 'code', description: 'The attendance code string' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Code reactivated successfully',
  })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Code not found' })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Cannot reactivate used or expired code',
  })
  public async reactivateCode(
    @Param('code') code: string,
  ): Promise<{ message: string; data: unknown }> {
    const reactivatedCode =
      await this.attendanceCodesService.reactivateCode(code);
    return {
      message: 'Purchase code reactivated successfully',
      data: {
        code: reactivatedCode.code,
        is_active: reactivatedCode.is_active,
      },
    };
  }

  @Get(':code/usage')
  @ApiOperation({
    summary: 'Get attendance code usage history',
    description:
      'Returns usage details for a specific attendance code, including who used it and when.',
  })
  @ApiParam({ name: 'code', description: 'The attendance code string' })
  @ApiResponse({ status: HttpStatus.OK, description: 'Code usage history' })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Code not found' })
  public async getCodeUsage(
    @Param('code') code: string,
  ): Promise<{ data: unknown }> {
    const usage = await this.attendanceCodesService.getCodeUsage(code);
    return { data: usage };
  }

  @Delete(':code')
  @ApiOperation({
    summary: 'Delete attendance code',
    description:
      'Permanently deletes an attendance code. Cannot delete used codes.',
  })
  @ApiParam({ name: 'code', description: 'The attendance code string' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Code deleted successfully',
  })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Code not found' })
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
