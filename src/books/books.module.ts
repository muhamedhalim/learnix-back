import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Payment } from '../payments/entities/payment.entity';
import { MediaModule } from '../media/media.module';
import { Subject } from '../subjects/entities/subject.entity';
import {
  AdminBooksController,
  BooksController,
  StudentBooksController,
  TeacherBooksController,
} from './controllers';
import { Book, BookPurchase } from './entities';
import { BookPurchasesService, BooksService } from './services';

@Module({
  imports: [TypeOrmModule.forFeature([Book, BookPurchase, Subject, Payment]), MediaModule],
  controllers: [
    AdminBooksController,
    BooksController,
    StudentBooksController,
    TeacherBooksController,
  ],
  providers: [BookPurchasesService, BooksService],
  exports: [BookPurchasesService, BooksService],
})
export class BooksModule {}
