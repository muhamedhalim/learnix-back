import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Payment } from '../payments/entities/payment.entity';
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
  imports: [TypeOrmModule.forFeature([Book, BookPurchase, Subject, Payment])],
  controllers: [
    BooksController,
    TeacherBooksController,
    StudentBooksController,
    AdminBooksController,
  ],
  providers: [BooksService, BookPurchasesService],
  exports: [BooksService, BookPurchasesService],
})
export class BooksModule {}
