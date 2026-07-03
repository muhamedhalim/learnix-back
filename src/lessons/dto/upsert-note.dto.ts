import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

export class UpsertNoteDto {
  @ApiProperty({
    description: "The viewer's private note text for this lesson.",
    maxLength: 20_000,
  })
  @IsString()
  @MaxLength(20_000)
  public content!: string;
}
