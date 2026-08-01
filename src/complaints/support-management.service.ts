import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, Repository } from 'typeorm';

import { ActivityLogsService } from '../activity-logs/activity-logs.service';
import { AuditEvent } from '../activity-logs/events/audit.events';
import { SanitizationService } from '../common/sanitization/sanitization.service';
import { SupportCannedResponse } from './entities/support-canned-response.entity';
import { SupportKnowledgeArticle } from './entities/support-knowledge-article.entity';
import { SupportSlaPolicy } from './entities/support-sla-policy.entity';
import {
  SupportResourceFilterDto,
  UpsertCannedResponseDto,
  UpsertKnowledgeArticleDto,
  UpsertSupportSlaPolicyDto,
} from './dto/support-management.dto';

class SupportManagementAuditEvent extends AuditEvent {}

@Injectable()
export class SupportManagementService {
  constructor(
    @InjectRepository(SupportCannedResponse)
    private readonly canned: Repository<SupportCannedResponse>,
    @InjectRepository(SupportKnowledgeArticle)
    private readonly articles: Repository<SupportKnowledgeArticle>,
    @InjectRepository(SupportSlaPolicy) private readonly policies: Repository<SupportSlaPolicy>,
    private readonly sanitization: SanitizationService,
    private readonly audit: ActivityLogsService,
  ) {}

  async activePolicy(): Promise<SupportSlaPolicy | null> {
    return await this.policies.findOne({
      where: { is_active: true },
      order: { updated_at: 'DESC' },
    });
  }
  async adminPolicy(): Promise<SupportSlaPolicy | null> {
    return await this.activePolicy();
  }
  async upsertPolicy(dto: UpsertSupportSlaPolicyDto, actorId: string) {
    const previous = await this.activePolicy();
    const policy = await this.policies.save(
      this.policies.create({ ...dto, is_active: true, ...(previous ? { id: previous.id } : {}) }),
    );
    await this.log(
      actorId,
      previous ? 'support_sla_policy_updated' : 'support_sla_policy_created',
      'support_sla_policy',
      policy.id,
      null,
      null,
    );
    return policy;
  }
  async removePolicy(actorId: string) {
    const policy = await this.activePolicy();
    if (!policy) throw new NotFoundException('Support SLA policy not found');
    policy.is_active = false;
    await this.policies.save(policy);
    await this.log(
      actorId,
      'support_sla_policy_deleted',
      'support_sla_policy',
      policy.id,
      null,
      null,
    );
  }

  async listCanned(filter: SupportResourceFilterDto, admin = false) {
    const result = await this.page(this.canned, filter, admin ? {} : { is_active: true });
    return { ...result, data: result.data.map((item) => this.toCannedProjection(item)) };
  }
  async listArticles(filter: SupportResourceFilterDto, admin = false) {
    const result = await this.page(this.articles, filter, admin ? {} : { is_published: true });
    return { ...result, data: result.data.map((item) => this.toArticleProjection(item)) };
  }
  async saveCanned(id: string | null, dto: UpsertCannedResponseDto, actorId: string) {
    const current = id ? await this.canned.findOneBy({ id }) : null;
    if (id && !current) throw new NotFoundException('Support response not found');
    const entity = await this.canned.save(
      this.canned.create({
        ...current,
        title: this.sanitization.sanitizeStrict(dto.title),
        body: this.sanitization.sanitizeBasic(dto.body),
        ...(dto.is_active === undefined ? {} : { is_active: dto.is_active }),
        ...(current ? { updated_by: actorId } : { created_by: actorId, updated_by: actorId }),
      }),
    );
    await this.log(
      actorId,
      current ? 'support_canned_response_updated' : 'support_canned_response_created',
      'support_canned_response',
      entity.id,
      entity,
      null,
    );
    return entity;
  }
  async saveArticle(id: string | null, dto: UpsertKnowledgeArticleDto, actorId: string) {
    const current = id ? await this.articles.findOneBy({ id }) : null;
    if (id && !current) throw new NotFoundException('Knowledge article not found');
    const publishing = dto.is_published === true && !current?.is_published;
    const entity = await this.articles.save(
      this.articles.create({
        ...current,
        title: this.sanitization.sanitizeStrict(dto.title),
        body: this.sanitization.sanitizeBasic(dto.body),
        ...(dto.is_published === undefined ? {} : { is_published: dto.is_published }),
        ...(publishing ? { published_at: new Date() } : {}),
        ...(current ? { updated_by: actorId } : { created_by: actorId, updated_by: actorId }),
      }),
    );
    await this.log(
      actorId,
      current ? 'support_knowledge_article_updated' : 'support_knowledge_article_created',
      'support_knowledge_article',
      entity.id,
      entity,
      null,
    );
    return entity;
  }
  async removeCanned(id: string, actorId: string) {
    const e = await this.canned.findOneBy({ id });
    if (!e) throw new NotFoundException('Support response not found');
    await this.canned.softRemove(e);
    await this.log(
      actorId,
      'support_canned_response_deleted',
      'support_canned_response',
      id,
      e,
      null,
    );
  }
  async removeArticle(id: string, actorId: string) {
    const e = await this.articles.findOneBy({ id });
    if (!e) throw new NotFoundException('Knowledge article not found');
    await this.articles.softRemove(e);
    await this.log(
      actorId,
      'support_knowledge_article_deleted',
      'support_knowledge_article',
      id,
      e,
      null,
    );
  }

  private async page<T extends { title: string }>(
    repo: Repository<T>,
    filter: SupportResourceFilterDto,
    where: Record<string, unknown>,
  ) {
    const search = filter.search?.trim();
    const merged = search ? { ...where, title: ILike(`%${search}%`) } : where;
    const [data, total] = await repo.findAndCount({
      where: merged as never,
      order: { updated_at: 'DESC' } as never,
      skip: (filter.page - 1) * filter.limit,
      take: filter.limit,
    });
    return {
      data,
      meta: {
        page: filter.page,
        limit: filter.limit,
        total,
        totalPages: Math.ceil(total / filter.limit),
        hasNextPage: filter.page * filter.limit < total,
        hasPrevPage: filter.page > 1,
      },
    };
  }
  private async log(
    actorId: string,
    action: string,
    targetType: string,
    id: string,
    target: { title?: string } | null,
    ip: string | null,
  ) {
    await this.audit.recordAuditEvent(
      new SupportManagementAuditEvent(
        actorId,
        action,
        targetType,
        id,
        target?.title ?? null,
        null,
        ip,
      ),
    );
  }

  /** Keep persistence/audit actor identifiers out of Call Center read responses. */
  private toCannedProjection(item: SupportCannedResponse) {
    return {
      id: item.id,
      title: item.title,
      body: item.body,
      is_active: item.is_active,
      created_at: item.created_at,
      updated_at: item.updated_at,
    };
  }

  private toArticleProjection(item: SupportKnowledgeArticle) {
    return {
      id: item.id,
      title: item.title,
      body: item.body,
      is_published: item.is_published,
      published_at: item.published_at,
      created_at: item.created_at,
      updated_at: item.updated_at,
    };
  }
}
