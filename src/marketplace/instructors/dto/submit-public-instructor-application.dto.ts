import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, Matches } from 'class-validator';

import { bi } from '../../../i18n/error-translator.util';
import { UpdateInstructorApplicationDto } from './update-instructor-application.dto';

/**
 * A marketplace instructor application from someone with no account yet.
 *
 * It reuses the whole signed-in application shape and adds only the contact
 * details needed to provision an account *if* an admin approves. It carries no
 * role, no password and no academic fields: this endpoint requests instructor
 * capability, never an academic student or teacher account, and grants nothing
 * by itself.
 *
 * The profile fields stay optional here for the same reason they are optional
 * for a draft — `InstructorApplicationService.submitPublic` enforces FR-011's
 * mandatory set at submission and reports precisely which ones are missing.
 */
export class SubmitPublicInstructorApplicationDto extends UpdateInstructorApplicationDto {
  @ApiProperty({
    example: 'applicant@example.com',
    description:
      'Contact email. Must not already belong to an account — an existing user signs in and applies as themselves instead.',
  })
  @IsEmail()
  @IsNotEmpty()
  public applicant_email!: string;

  @ApiProperty({
    example: '01011111111',
    description: "Contact phone, matching the platform's existing phone format.",
  })
  @Matches(/^01[0125]\d{8}$/, {
    message: bi(
      'Phone must be a valid Egyptian phone number (11 digits starting with 01)',
      'يجب أن يكون رقم الهاتف رقمًا مصريًا صالحًا (11 رقمًا يبدأ بـ 01)',
    ),
  })
  public applicant_phone!: string;
}
