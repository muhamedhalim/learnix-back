import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { Repository } from 'typeorm';

import { biBody } from '../../i18n/error-translator.util';
import { MarketplaceStorageService } from '../common/marketplace-storage.service';
import { InstructorApplication } from './entities/instructor-application.entity';

/**
 * Optional supporting credential files only — certificates, diplomas,
 * transcripts, portfolio documents. Government or national identity
 * documents MUST NOT be collectable here (FR-010): this endpoint has no
 * "identity document" kind at all, so there is nothing for a caller to
 * mislabel into one.
 */
const ALLOWED_DOCUMENT_TYPES = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
/** 10MB — matches the existing evidence-document ceiling (CALL_CENTER_ATTACHMENT_MAX_SIZE). Exported so the controller's upload interceptor rejects an oversized file before it reaches this service. */
export const MAX_DOCUMENT_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_DOCUMENTS_PER_APPLICATION = 10;

export interface UploadApplicationDocumentInput {
  buffer: Buffer;
  contentType: string;
  size: number;
}

@Injectable()
export class ApplicationDocumentsService {
  constructor(
    @InjectRepository(InstructorApplication)
    private readonly applications: Repository<InstructorApplication>,
    private readonly storage: MarketplaceStorageService,
  ) {}

  /** Uploads one document and appends its private storage key to the applicant's own draft/rejected application. */
  public async upload(userId: string, input: UploadApplicationDocumentInput): Promise<{ key: string }> {
    const application = await this.applications.findOne({ where: { user_id: userId } });
    if (!application) {
      throw new NotFoundException(biBody('No application found', 'لا يوجد طلب'));
    }
    if (!['draft', 'rejected'].includes(application.status)) {
      throw new ForbiddenException(
        biBody('Documents can only be uploaded to a draft or rejected application', 'يمكن رفع المستندات فقط لطلب في حالة مسودة أو مرفوض'),
      );
    }
    if (!ALLOWED_DOCUMENT_TYPES.includes(input.contentType)) {
      throw new BadRequestException(
        biBody(
          `File type must be one of: ${ALLOWED_DOCUMENT_TYPES.join(', ')}`,
          `يجب أن يكون نوع الملف أحد: ${ALLOWED_DOCUMENT_TYPES.join(', ')}`,
        ),
      );
    }
    if (input.size > MAX_DOCUMENT_SIZE_BYTES) {
      throw new BadRequestException(
        biBody(
          `File cannot exceed ${MAX_DOCUMENT_SIZE_BYTES / (1024 * 1024)}MB`,
          `لا يمكن أن يتجاوز حجم الملف ${MAX_DOCUMENT_SIZE_BYTES / (1024 * 1024)} ميجابايت`,
        ),
      );
    }
    if ((application.document_keys?.length ?? 0) >= MAX_DOCUMENTS_PER_APPLICATION) {
      throw new BadRequestException(
        biBody(
          `An application cannot carry more than ${MAX_DOCUMENTS_PER_APPLICATION} documents`,
          `لا يمكن أن يحتوي الطلب على أكثر من ${MAX_DOCUMENTS_PER_APPLICATION} مستندات`,
        ),
      );
    }

    const key = `marketplace/applications/${application.id}/documents/${randomUUID()}`;
    await this.storage.uploadPrivate({ buffer: input.buffer, path: key, contentType: input.contentType });

    application.document_keys = [...(application.document_keys ?? []), key];
    await this.applications.save(application);
    return { key };
  }

  /** A signed URL for one of an applicant's own documents, or one a reviewing administrator is entitled to see. */
  public async getSignedDocumentUrl(
    applicationId: string,
    key: string,
    requesterId: string | null,
    isAdmin: boolean,
  ): Promise<string> {
    const application = await this.applications.findOne({ where: { id: applicationId } });
    // An anonymous caller is never the owner of an ownerless (public)
    // application: without this, `null === null` would authorise anyone to
    // read another applicant's private documents.
    const isOwner = requesterId !== null && application?.user_id === requesterId;
    const authorized = () =>
      !!application && (isOwner || isAdmin) && (application.document_keys ?? []).includes(key);
    return this.storage.getSignedUrl(key, authorized);
  }
}
