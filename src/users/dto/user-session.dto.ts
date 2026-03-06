import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UserSessionDto {
  @ApiProperty({ description: 'Session ID' })
  public id!: string;

  @ApiPropertyOptional({ description: 'Device information (User-Agent)' })
  public deviceInfo!: string | null;

  @ApiPropertyOptional({ description: 'IP address' })
  public ipAddress!: string | null;

  @ApiProperty({ description: 'Last activity timestamp' })
  public lastActive!: Date;

  @ApiProperty({ description: 'Session creation timestamp' })
  public createdAt!: Date;

  @ApiProperty({ description: 'Session expiration timestamp' })
  public expiresAt!: Date;

  @ApiProperty({ description: 'Whether this is the current session' })
  public isCurrent!: boolean;
}

export class UserSessionListResponseDto {
  @ApiProperty({
    type: [UserSessionDto],
    description: 'Array of user sessions',
  })
  public data!: UserSessionDto[];
}

export class DeleteSessionResponseDto {
  @ApiProperty({ description: 'Success message' })
  public message!: string;
}
