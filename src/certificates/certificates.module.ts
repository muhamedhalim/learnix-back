import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { LessonProgress } from '../lessons/entities/lesson-progress.entity';
import { LessonPackage } from '../packages/entities/lesson-package.entity';
import { LessonPackageItem } from '../packages/entities/lesson-package-item.entity';
import { PackagePurchase } from '../payments/entities/package-purchase.entity';
import { User } from '../users/entities/user.entity';
import { CertificatePdfService } from './certificate-pdf.service';
import { CertificatesService } from './certificates.service';
import {
  AdminCertificatesController,
  PublicCertificatesController,
  StudentCertificatesController,
  TeacherCertificatesController,
} from './controllers';
import { Certificate, CertificateTemplate } from './entities';
import { CertificateIssuanceListener } from './listeners/certificate-issuance.listener';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Certificate,
      CertificateTemplate,
      LessonPackage,
      LessonPackageItem,
      LessonProgress,
      PackagePurchase,
      User,
    ]),
  ],
  controllers: [
    StudentCertificatesController,
    PublicCertificatesController,
    AdminCertificatesController,
    TeacherCertificatesController,
  ],
  providers: [
    CertificatesService,
    CertificatePdfService,
    CertificateIssuanceListener,
  ],
  exports: [CertificatesService],
})
export class CertificatesModule {}
