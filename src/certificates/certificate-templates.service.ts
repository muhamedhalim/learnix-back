import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { IsNull, Repository } from 'typeorm';

import { biBody } from '../i18n/error-translator.util';
import { CreateTemplateDto, UpdateTemplateDto } from './dto';
import { Certificate } from './entities/certificate.entity';
import type { CertificateTemplateSnapshot } from './entities/certificate.entity';
import { CertificateTemplate } from './entities/certificate-template.entity';
import { CertificateTemplateStatus } from './entities/certificate-template-status.enum';

/**
 * Certificate template authoring and lifecycle (draft → published → archived), plus the
 * template-intrinsic rules issuance relies on (a published design must be complete and use only
 * supported placeholders; the issue-time snapshot). Extracted unchanged from `CertificatesService`,
 * which now depends on this service for template lookups and validation.
 */
@Injectable()
export class CertificateTemplatesService {
  constructor(
    @InjectRepository(CertificateTemplate)
    private readonly templatesRepository: Repository<CertificateTemplate>,
    @InjectRepository(Certificate)
    private readonly certificatesRepository: Repository<Certificate>,
  ) {}

  /**
   * Templates with per-template issued-certificate counts (one grouped query,
   * no N+1). Teachers see their own templates; admins see all.
   */
  public async getTemplates(
    ownerId?: string,
  ): Promise<(CertificateTemplate & { issued_count: number })[]> {
    const templates = await this.templatesRepository.find({
      ...(ownerId ? { where: { owner_id: ownerId } } : {}),
      order: { created_at: 'DESC', id: 'DESC' },
      take: 100,
    });
    if (templates.length === 0) return [];

    const counts = await this.certificatesRepository
      .createQueryBuilder('c')
      .select('c.template_id', 'template_id')
      .addSelect('COUNT(*)', 'count')
      .where('c.template_id IN (:...ids)', { ids: templates.map((t) => t.id) })
      .groupBy('c.template_id')
      .getRawMany<{ template_id: string; count: string }>();
    const countById = new Map(counts.map((r) => [r.template_id, Number.parseInt(r.count, 10)]));

    return templates.map((template) =>
      Object.assign(template, { issued_count: countById.get(template.id) ?? 0 }),
    );
  }

  /** Published platform designs plus the teacher's own published designs. */
  public async getIssuableTemplates(
    ownerId: string,
  ): Promise<(CertificateTemplate & { issued_count: number })[]> {
    const templates = await this.templatesRepository.find({
      where: [
        { owner_id: ownerId, status: CertificateTemplateStatus.PUBLISHED },
        { owner_id: IsNull(), status: CertificateTemplateStatus.PUBLISHED },
      ],
      order: { created_at: 'DESC', id: 'DESC' },
      take: 100,
    });
    if (templates.length === 0) return [];

    const counts = await this.certificatesRepository
      .createQueryBuilder('c')
      .select('c.template_id', 'template_id')
      .addSelect('COUNT(*)', 'count')
      .where('c.template_id IN (:...ids)', { ids: templates.map((template) => template.id) })
      .groupBy('c.template_id')
      .getRawMany<{ template_id: string; count: string }>();
    const countById = new Map(
      counts.map((row) => [row.template_id, Number.parseInt(row.count, 10)]),
    );

    return templates.map((template) =>
      Object.assign(template, { issued_count: countById.get(template.id) ?? 0 }),
    );
  }

  /** Lookup that tolerates a missing row (legacy certificates may point at a deleted template). */
  public findById(id: string): Promise<CertificateTemplate | null> {
    return this.templatesRepository.findOne({ where: { id } });
  }

  public async getTemplate(id: string, ownerId?: string): Promise<CertificateTemplate> {
    const template = await this.templatesRepository.findOne({
      where: ownerId ? { id, owner_id: ownerId } : { id },
    });
    if (!template) {
      throw new NotFoundException(biBody('Template not found', 'القالب غير موجود'));
    }
    return template;
  }

  /** New templates always start as DRAFTS — publishing is a separate action. */
  public async createTemplate(
    dto: CreateTemplateDto,
    ownerId?: string,
  ): Promise<CertificateTemplate> {
    const sanitized = this.sanitizeTemplateDto(dto);
    const template = this.templatesRepository.create({
      ...sanitized,
      owner_id: ownerId ?? null,
      status: CertificateTemplateStatus.DRAFT,
      is_default: false,
    });
    return this.templatesRepository.save(template);
  }

  public async updateTemplate(
    id: string,
    dto: UpdateTemplateDto,
    ownerId?: string,
  ): Promise<CertificateTemplate> {
    const template = await this.getTemplate(id, ownerId);
    Object.assign(template, this.sanitizeTemplateDto(dto));
    if (template.status === CertificateTemplateStatus.PUBLISHED) {
      this.assertTemplateCanBeIssued(template);
    }
    const saved = await this.templatesRepository.save(template);
    if (saved.is_default) {
      await this.unsetOtherDefaults(saved.id, saved.owner_id);
    }
    return saved;
  }

  /**
   * Publish a draft: validates the design is complete, then makes it available
   * for issuance. A teacher's freshly published design becomes their
   * auto-issue default (platform/admin templates stay opt-in defaults).
   * Publishing NEVER creates a certificate — it only unlocks the design.
   */
  public async publishTemplate(id: string, ownerId?: string): Promise<CertificateTemplate> {
    const template = await this.getTemplate(id, ownerId);

    this.assertTemplatePlaceholders(template);

    const missing: string[] = [];
    if (!template.name?.trim()) missing.push('name');
    if (!template.title?.trim()) missing.push('title');
    if (!template.body?.trim()) missing.push('body');
    if (missing.length > 0) {
      throw new BadRequestException(
        biBody(
          `Cannot publish — missing required fields: ${missing.join(', ')}`,
          `لا يمكن النشر — حقول مطلوبة ناقصة: ${missing.join('، ')}`,
        ),
      );
    }

    template.status = CertificateTemplateStatus.PUBLISHED;
    if (template.owner_id) {
      template.is_default = true;
    }
    const saved = await this.templatesRepository.save(template);
    if (saved.is_default) {
      await this.unsetOtherDefaults(saved.id, saved.owner_id);
    }
    return saved;
  }

  /** Back to draft: hidden from issuance again, freely editable. */
  public async unpublishTemplate(id: string, ownerId?: string): Promise<CertificateTemplate> {
    const template = await this.getTemplate(id, ownerId);
    template.status = CertificateTemplateStatus.DRAFT;
    template.is_default = false;
    return this.templatesRepository.save(template);
  }

  /** Archived templates can never be used for new issuance. */
  public async archiveTemplate(id: string, ownerId?: string): Promise<CertificateTemplate> {
    const template = await this.getTemplate(id, ownerId);
    template.status = CertificateTemplateStatus.ARCHIVED;
    template.is_default = false;
    return this.templatesRepository.save(template);
  }

  /** Copy an existing design into a fresh draft owned by the caller. */
  public async duplicateTemplate(
    id: string,
    ownerId?: string,
    callerOwnerId?: string,
  ): Promise<CertificateTemplate> {
    const source = await this.getTemplate(id, ownerId);
    const copy = this.templatesRepository.create({
      name: `${source.name} (copy)`.slice(0, 120),
      title: source.title,
      title_ar: source.title_ar,
      body: source.body,
      body_ar: source.body_ar,
      signature_name: source.signature_name,
      signature_title: source.signature_title,
      signature_title_ar: source.signature_title_ar,
      accent_color: source.accent_color,
      layout: source.layout,
      font: source.font,
      title_font_size: source.title_font_size,
      body_font_size: source.body_font_size,
      text_alignment: source.text_alignment,
      owner_id: callerOwnerId ?? source.owner_id ?? null,
      status: CertificateTemplateStatus.DRAFT,
      is_default: false,
    });
    return this.templatesRepository.save(copy);
  }

  public async deleteTemplate(id: string, ownerId?: string): Promise<void> {
    const template = await this.getTemplate(id, ownerId);
    await this.templatesRepository.remove(template);
  }

  /** Only PUBLISHED templates may be used as an auto-issue default. */
  public findDefaultTemplate(ownerId?: string): Promise<CertificateTemplate | null> {
    return this.templatesRepository.findOne({
      where: ownerId
        ? { is_default: true, owner_id: ownerId, status: CertificateTemplateStatus.PUBLISHED }
        : { is_default: true, owner_id: IsNull(), status: CertificateTemplateStatus.PUBLISHED },
    });
  }

  /**
   * Validate an explicitly chosen issuance template: it must exist, be
   * PUBLISHED (never a draft or archived design), and — when the issuer is a
   * teacher — be either a platform template or the teacher's own.
   */
  public async resolveIssuanceTemplate(
    templateId: string,
    restrictToOwner?: string,
  ): Promise<CertificateTemplate> {
    const template = await this.getTemplate(templateId);
    if (template.status !== CertificateTemplateStatus.PUBLISHED) {
      throw new BadRequestException(
        biBody(
          'Only published templates can be used to issue certificates',
          'لا يمكن إصدار الشهادات إلا باستخدام قوالب منشورة',
        ),
      );
    }
    if (restrictToOwner && template.owner_id !== null && template.owner_id !== restrictToOwner) {
      throw new ForbiddenException(
        biBody(
          'You can only use your own or platform templates',
          'يمكنك استخدام قوالبك أو قوالب المنصة فقط',
        ),
      );
    }
    return template;
  }

  /** Published designs are executable certificate content, not free-form copy. */
  public assertTemplateCanBeIssued(template: CertificateTemplate | null): void {
    if (!template) return;
    const missing = [
      !template.name?.trim() ? 'name' : null,
      !template.title?.trim() ? 'title' : null,
      !template.body?.trim() ? 'body' : null,
    ].filter((field): field is string => field !== null);
    if (missing.length > 0) {
      throw new BadRequestException(`Certificate template is incomplete: ${missing.join(', ')}`);
    }
    this.assertTemplatePlaceholders(template);
  }

  /** Reject unsupported placeholders before they are frozen into a certificate. */
  public assertTemplatePlaceholders(template: Pick<CertificateTemplate, 'body' | 'body_ar'>): void {
    const supported = new Set(['student', 'course', 'date']);
    const unsupported = new Set<string>();
    for (const value of [template.body, template.body_ar]) {
      if (typeof value !== 'string') continue;
      for (const match of value.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
        const token = match[1]?.trim().toLowerCase();
        if (token && !supported.has(token)) unsupported.add(`{{${token}}}`);
      }
    }
    if (unsupported.size > 0) {
      throw new UnprocessableEntityException(
        `Unsupported certificate placeholders: ${[...unsupported].join(', ')}. Use {{student}}, {{course}}, or {{date}}.`,
      );
    }
  }

  public snapshotOf(template: CertificateTemplate | null): CertificateTemplateSnapshot | null {
    if (!template) return null;
    return {
      title: template.title,
      title_ar: template.title_ar,
      body: template.body,
      body_ar: template.body_ar,
      signature_name: template.signature_name,
      signature_title: template.signature_title,
      signature_title_ar: template.signature_title_ar,
      accent_color: template.accent_color,
      layout: template.layout,
      font: template.font,
      title_font_size: template.title_font_size,
      body_font_size: template.body_font_size,
      text_alignment: template.text_alignment,
    };
  }

  private async unsetOtherDefaults(keepId: string, ownerId: string | null): Promise<void> {
    const query = this.templatesRepository
      .createQueryBuilder()
      .update()
      .set({ is_default: false })
      .where('id != :keepId', { keepId })
      .andWhere('is_default = true');
    if (ownerId) {
      query.andWhere('owner_id = :ownerId', { ownerId });
    } else {
      query.andWhere('owner_id IS NULL');
    }
    await query.execute();
  }

  /** Text is rendered as escaped text in React/PDFKit; never accept markup. */
  public sanitizeTemplateDto<T extends CreateTemplateDto | UpdateTemplateDto>(dto: T): T {
    const sanitized = { ...dto } as Record<string, unknown>;
    for (const [key, value] of Object.entries(sanitized)) {
      // Validation DTO instances can carry every optional field as an own
      // `undefined` property. Leaving those values in a PATCH would erase the
      // published template's required name/body before it is snapshotted.
      if (value === undefined) {
        delete sanitized[key];
        continue;
      }
      if (typeof value === 'string') {
        sanitized[key] = value
          .replace(/[<>]/g, '')
          // eslint-disable-next-line no-control-regex -- stripping control characters is the point
          .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
          .trim();
      }
    }
    return sanitized as T;
  }
}
