import { ApiProperty } from '@nestjs/swagger';

import {
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

import { bi } from '../../i18n/error-translator.util';
import { UserRole } from '../../users/entities/user-role.enum';

/** The only two roles the public registration endpoint may ever grant. */
const REQUESTABLE_ROLES = [UserRole.STUDENT, UserRole.TEACHER] as const;

export class RegisterDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(100)
  public name!: string;

  // A minimum length is a real credential-strength control, not just UX: the
  // service hashes whatever arrives, so without it an automated signup could
  // create accounts with trivially guessable one-character passwords. 8 matches
  // the frontend register/reset schema (dodline/app/[locale]/auth/schemas.ts).
  @ApiProperty({ example: 'S3curePass', description: 'Password (min 8 chars)' })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  public password!: string;

  @ApiProperty({
    example: '01000000000',
    description: 'Egyptian phone number (11 digits starting with 01)',
  })
  @IsString()
  @IsNotEmpty()
  // `[0125]`, not `[0-2,5]` — the latter is a character class containing a
  // literal comma, so it accepted `01,12345678`.
  @Matches(/^01[0125]\d{8}$/, {
    message: bi(
      'Phone must be a valid Egyptian phone number (11 digits starting with 01)',
      'يجب أن يكون رقم الهاتف رقمًا مصريًا صالحًا (11 رقمًا يبدأ بـ 01)',
    ),
  })
  public phone!: string;

  // `@IsEmail` rejects malformed addresses before the service lowercases and
  // stores them, preventing junk identities and downstream reset/notification
  // failures. The service still trims + lowercases for canonical storage.
  @IsEmail()
  @IsNotEmpty()
  public email!: string;

  @ApiProperty({
    example: UserRole.STUDENT,
    enum: REQUESTABLE_ROLES,
    description:
      'The account type being requested. This is NOT the granted role — every ' +
      'registration is created with status PENDING regardless of this value, and ' +
      'an admin must approve it before the account can log in. Restricted to ' +
      "student/teacher: the public endpoint can never request 'admin' or " +
      "'call_center'.",
  })
  @IsIn(REQUESTABLE_ROLES, {
    message: bi(
      'Requested account type must be either student or teacher',
      'يجب أن يكون نوع الحساب المطلوب إما طالب أو معلم',
    ),
  })
  public requestedRole!: UserRole;

  @ApiProperty({
    example: '01011111111',
    description:
      "Guardian's phone number. Required when requestedRole is 'student', and " +
      "must be omitted when requestedRole is 'teacher'. Accepts Egyptian national " +
      'or E.164 form; stored canonically as E.164 on a Guardian record, which must ' +
      'be verified by OTP before it receives any educational notification.',
    required: false,
  })
  @ValidateIf((dto: RegisterDto) => dto.requestedRole === UserRole.STUDENT)
  @IsString()
  @IsNotEmpty({
    message: bi(
      "Parent/guardian phone is required for a student's registration",
      'رقم هاتف ولي الأمر مطلوب عند التسجيل كطالب',
    ),
  })
  // No @Matches: the previous pattern /^01[0-2,5]\d{8}$/ contained a character
  // class with a literal comma and accepted `01,12345678`. `toE164` is now the
  // single definition of a valid number and rejects it with a 400.
  public parentPhone?: string;

  @ApiProperty({
    example: 'B.Sc. Mathematics, 5 years tutoring',
    description: "Teaching qualifications. Required when requestedRole is 'teacher'.",
    required: false,
    maxLength: 2000,
  })
  @ValidateIf((dto: RegisterDto) => dto.requestedRole === UserRole.TEACHER)
  @IsString()
  @IsNotEmpty({
    message: bi(
      "Qualifications are required for a teacher's registration",
      'المؤهلات مطلوبة عند التسجيل كمعلم',
    ),
  })
  @MaxLength(2000)
  public qualifications?: string;

  @ApiProperty({
    example: 5,
    description: "Years of teaching experience. Required when requestedRole is 'teacher'.",
    required: false,
  })
  @ValidateIf((dto: RegisterDto) => dto.requestedRole === UserRole.TEACHER)
  @IsInt()
  @Min(0)
  public yearsOfExperience?: number;

  @ApiProperty({
    example: 'Passionate mathematics teacher.',
    description: 'Optional short bio, only meaningful for teacher applications.',
    required: false,
    maxLength: 2000,
  })
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  public bio?: string;
}
