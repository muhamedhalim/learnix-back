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
import { AttendanceCodesService } from '../attendance-codes.service';
import { GenerateAttendanceCodesDto, AttendanceCodeFilterDto } from '../dto';

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
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Purchase codes generated successfully',
  })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Item not found' })
  async generate(
    @Body() dto: GenerateAttendanceCodesDto,
    @GetUser() user: JwtPayload,
  ) {
    const codes = await this.attendanceCodesService.generateCodes(
      dto,
      user.userId,
    );
    return {
      message: `Generated ${codes.length} attendance codes`,
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
    summary: 'Get all attendance codes',
    description:
      'Returns a paginated list of attendance codes with optional filters.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'List of attendance codes',
  })
  async findAll(@Query() filter: AttendanceCodeFilterDto) {
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
  async getStats() {
    const stats = await this.attendanceCodesService.getStats();
    return { data: stats };
  }

  @Get(':code')
  @ApiOperation({
    summary: 'Get a attendance code by code string',
    description:
      'Returns detailed information about a specific attendance code.',
  })
  @ApiParam({ name: 'code', type: String })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Purchase code details',
  })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, description: 'Code not found' })
  async findOne(@Param('code') code: string) {
    const attendanceCode = await this.attendanceCodesService.findByCode(code);
    if (!attendanceCode) {
      return { data: null, message: 'Purchase code not found' };
    }
    return { data: attendanceCode };
  }

  @Delete(':code')
  @ApiOperation({
    summary: 'Delete a attendance code',
    description:
      'Deletes an unused attendance code. Used codes cannot be deleted.',
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
    await this.attendanceCodesService.remove(code);
    return { message: 'Purchase code deleted successfully' };
  }
}
