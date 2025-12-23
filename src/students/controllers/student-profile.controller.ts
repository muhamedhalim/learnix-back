import {
  Controller,
  Get,
  Put,
  Body,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { StudentsService } from '../students.service';
import { UpdateStudentProfileDto, UpdateNotificationSettingsDto } from '../dto';
import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { JwtPayload } from '../../common/interfaces/user-request.interface';

@ApiTags('Student Profile')
@Controller('student/profile')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('student')
@ApiBearerAuth('JWT-auth')
export class StudentProfileController {
  constructor(private readonly studentsService: StudentsService) {}

  /**
   * Get current student's profile
   * Returns the authenticated student's profile with notification settings
   */
  @Get()
  @ApiOperation({
    summary: 'Get my profile',
    description:
      "Returns the authenticated student's profile including parent phone, grade level, and notification settings. Student only.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Student profile retrieved successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Student profile not found',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Not authenticated',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Not authorized (student only)',
  })
  async getProfile(@GetUser() user: JwtPayload) {
    const profile = await this.studentsService.findStudentProfile(user.userId);
    return {
      profile,
    };
  }

  /**
   * Update current student's profile
   * Students can update their parent_phone and grade_level
   */
  @Put()
  @ApiOperation({
    summary: 'Update my profile',
    description:
      "Updates the authenticated student's profile. Can update parent phone and grade level. Student only.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Profile updated successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Student profile not found',
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
    description: 'Not authorized (student only)',
  })
  async updateProfile(
    @GetUser() user: JwtPayload,
    @Body() updateDto: UpdateStudentProfileDto,
  ) {
    const profile = await this.studentsService.updateProfile(
      user.userId,
      updateDto,
    );
    return {
      message: 'Profile updated successfully',
      profile,
    };
  }

  /**
   * Get current student's stats
   * Returns lesson count, exam count, average score, etc.
   */
  @Get('stats')
  @ApiOperation({
    summary: 'Get my stats',
    description:
      "Returns the authenticated student's statistics including lessons completed, exams taken, and average score. Student only.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Stats retrieved successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Student profile not found',
  })
  async getStats(@GetUser() user: JwtPayload) {
    // First get the student profile to get the studentId
    const profile = await this.studentsService.findStudentProfile(user.userId);
    const stats = await this.studentsService.getStudentStats(profile.id);
    return {
      stats,
    };
  }

  /**
   * Update notification settings
   * Students can configure their notification preferences
   */
  @Put('notifications')
  @ApiOperation({
    summary: 'Update notification settings',
    description:
      "Updates the authenticated student's notification settings. Controls SMS, email, and various notification types. Student only.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Notification settings updated successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Student profile not found',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid notification settings',
  })
  async updateNotifications(
    @GetUser() user: JwtPayload,
    @Body() updateDto: UpdateNotificationSettingsDto,
  ) {
    const profile = await this.studentsService.updateNotificationSettings(
      user.userId,
      updateDto,
    );
    return {
      message: 'Notification settings updated successfully',
      profile,
    };
  }
}
