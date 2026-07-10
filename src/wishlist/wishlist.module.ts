import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CartModule } from '../cart/cart.module';
import { Lesson } from '../lessons/entities/lesson.entity';
import { LessonPackage } from '../packages/entities/lesson-package.entity';
import { AdminWishlistController } from './controllers/admin-wishlist.controller';
import { WishlistController } from './controllers/wishlist.controller';
import { WishlistItem } from './entities/wishlist-item.entity';
import { WishlistService } from './wishlist.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([WishlistItem, Lesson, LessonPackage]),
    CartModule,
  ],
  controllers: [WishlistController, AdminWishlistController],
  providers: [WishlistService],
  exports: [WishlistService],
})
export class WishlistModule {}
