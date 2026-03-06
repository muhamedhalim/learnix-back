import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Put,
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
import { UpdateTeacherProfileDto } from '../dto';
import { TeachersService } from '../teachers.service';

@ApiTags('Teacher Profile')
@Controller('teacher/profile')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('teacher')
@ApiBearerAuth('JWT-auth')
export class TeacherProfileController {
  constructor(private readonly teachersService: TeachersService) {}

  /**
   * Get current teacher's profile
   * Returns the authenticated teacher's profile with subjects and stats
   */
  @Get()
  @ApiOperation({
    summary: 'Get my profile',
    description:
      "Returns the authenticated teacher's profile including qualifications, subjects, and rating. Teacher only.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Teacher profile retrieved successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Teacher profile not found',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Not authenticated',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Not authorized (teacher only)',
  })
  public async getProfile(@GetUser() user: JwtPayload): Promise<unknown> {
    const profile = await this.teachersService.findTeacherProfile(user.userId);
    return {
      profile,
    };
  }

  /**
   * Update current teacher's profile
   * Teachers can update their qualifications, bio, experience, and phone
   */
  @Put()
  @ApiOperation({
    summary: 'Update my profile',
    description:
      "Updates the authenticated teacher's profile. Can update qualifications, years of experience, bio, and phone number. Teacher only.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Profile updated successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Teacher profile not found',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid input data',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Not authenticated',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Not authorized (teacher only)',
  })
  public async updateProfile(
    @GetUser() user: JwtPayload,
    @Body() updateDto: UpdateTeacherProfileDto,
  ): Promise<unknown> {
    const profile = await this.teachersService.updateProfile(
      user.userId,
      updateDto,
    );
    return {
      message: 'Profile updated successfully',
      profile,
    };
  }

  /**
   * Get current teacher's stats
   * Returns lesson count, student count, earnings, etc.
   */
  @Get('stats')
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Teacher profile not found',
  })
  public async getStats(@GetUser() user: JwtPayload): Promise<unknown> {
    // First get the teacher profile to get the teacherId
    const profile = await this.teachersService.findTeacherProfile(user.userId);
    const stats = await this.teachersService.getTeacherStats(profile.id);
    return {
      stats,
    };
  }
}
