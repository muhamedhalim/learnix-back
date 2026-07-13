import { ApiProperty } from '@nestjs/swagger';

import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

import { bi } from '../../i18n/error-translator.util';
import { UserRole } from '../../users/entities/user-role.enum';

/** The only two roles the public registration endpoint may ever grant. */
const REQUESTABLE_ROLES = [UserRole.STUDENT, UserRole.TEACHER] as const;

export class RegisterDto {
  @MaxLength(100)
  public name!: string;

  @ApiProperty({ example: '123456', description: 'Password (min 6 chars)' })
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
