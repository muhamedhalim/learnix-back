import { MiddlewareConsumer, Module, type NestModule, RequestMethod } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { deprecationWarning } from '../common/middleware/deprecation.middleware';
import { Payment } from '../payments/entities/payment.entity';
import { PaymentsModule } from '../payments/payments.module';
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
  imports: [TypeOrmModule.forFeature([Book, BookPurchase, Subject, Payment]), MediaModule, PaymentsModule],
  controllers: [
    AdminBooksController,
    BooksController,
    StudentBooksController,
    TeacherBooksController,
  ],
  providers: [BookPurchasesService, BooksService],
  exports: [BookPurchasesService, BooksService],
})
export class BooksModule implements NestModule {
  public configure(consumer: MiddlewareConsumer): void {
    // DEF-013: the legacy purchase stub never creates an Order/Payment.
    // Signal deprecation to any remaining external caller and point it at
    // the canonical Unified Checkout endpoint, without removing the route.
    consumer
      .apply(deprecationWarning('1.0', '2027-02-10', '/api/v1/payments/orders'))
      .forRoutes({ path: 'student/books/purchase', method: RequestMethod.POST });
  }
}
