import { ApiProperty } from '@nestjs/swagger';

import { Book } from '../entities/book.entity';

export class PublicBookTeacherDto {
  @ApiProperty()
  public id!: string;

  @ApiProperty()
  public name!: string;

  @ApiProperty({ nullable: true })
  public profile_picture_url!: string | null;
}

export class PublicBookSubjectDto {
  @ApiProperty()
  public id!: string;

  @ApiProperty()
  public name!: string;

  @ApiProperty({ nullable: true })
  public name_ar!: string | null;

}

/** Public book catalogue model. Private storage references are intentionally absent. */
export class PublicBookResponseDto {
  @ApiProperty()
  public id!: string;
  @ApiProperty()
  public title!: string;
  @ApiProperty()
  public title_ar!: string;
  @ApiProperty({ nullable: true })
  public description!: string | null;
  @ApiProperty({ nullable: true })
  public description_ar!: string | null;
  @ApiProperty()
  public teacher_id!: string;
  @ApiProperty({ type: PublicBookTeacherDto })
  public teacher!: PublicBookTeacherDto;
  @ApiProperty()
  public subject_id!: string;
  @ApiProperty({ type: PublicBookSubjectDto })
  public subject!: PublicBookSubjectDto;
  @ApiProperty({ nullable: true })
  public cover_image!: string | null;
  @ApiProperty()
  public price!: number;
  @ApiProperty()
  public purchase_count!: number;
  @ApiProperty()
  public created_at!: Date;
}

export function toPublicBookResponse(
  book: Book,
  resolvePublicMedia: (value: string | null) => string | null,
): PublicBookResponseDto {
  return {
    id: book.id,
    title: book.title,
    title_ar: book.title_ar,
    description: book.description,
    description_ar: book.description_ar,
    teacher_id: book.teacher_id,
    teacher: {
      id: book.teacher.id,
      name: book.teacher.name,
      profile_picture_url: resolvePublicMedia(book.teacher.profile_picture_url),
    },
    subject_id: book.subject_id,
    subject: {
      id: book.subject.id,
      name: book.subject.name,
      name_ar: book.subject.name_ar,
    },
    cover_image: resolvePublicMedia(book.cover_image),
    price: Number(book.price),
    purchase_count: book.purchase_count,
    created_at: book.created_at,
  };
}
