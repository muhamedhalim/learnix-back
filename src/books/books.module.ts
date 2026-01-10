import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Book, BookPurchase } from './entities';
import { BooksService, BookPurchasesService } from './services';
import {
  BooksController,
  TeacherBooksController,
  StudentBooksController,
  AdminBooksController,
} from './controllers';
import { Subject } from '../subjects/entities/subject.entity';
import { Payment } from '../payments/entities/payment.entity';

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
