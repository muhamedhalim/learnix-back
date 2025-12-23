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
import { TeachersService } from '../teachers.service';
import { UpdateTeacherProfileDto } from '../dto';
import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { JwtPayload } from '../../common/interfaces/user-request.interface';

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
  async getProfile(@GetUser() user: JwtPayload) {
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
  async updateProfile(
    @GetUser() user: JwtPayload,
    @Body() updateDto: UpdateTeacherProfileDto,
  ) {
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
  @ApiOperation({
    summary: 'Get my stats',
    description:
      "Returns the authenticated teacher's statistics including lesson count, student count, and average rating. Teacher only.",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Stats retrieved successfully',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Teacher profile not found',
  })
  async getStats(@GetUser() user: JwtPayload) {
    // First get the teacher profile to get the teacherId
    const profile = await this.teachersService.findTeacherProfile(user.userId);
    const stats = await this.teachersService.getTeacherStats(profile.id);
    return {
      stats,
    };
  }
}
