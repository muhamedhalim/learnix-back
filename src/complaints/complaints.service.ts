import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { PaginatedResponse, PaginationMeta } from '../common/interfaces/pagination.interface';
import { biBody } from '../i18n/error-translator.util';
import { NotificationType } from '../notifications/entities/notification-type.enum';
import { NotificationsService } from '../notifications/services/notifications.service';
import { ComplaintFilterDto, CreateComplaintDto, RespondComplaintDto } from './dto';
import { Complaint } from './entities/complaint.entity';
import { ComplaintStatus } from './enums/complaint-status.enum';

@Injectable()
export class ComplaintsService {
  constructor(
    @InjectRepository(Complaint)
    private readonly complaintsRepository: Repository<Complaint>,
    private readonly notificationsService: NotificationsService,
  ) {}

  public async createComplaint(studentId: string, dto: CreateComplaintDto): Promise<Complaint> {
    const complaint = this.complaintsRepository.create({
      student_id: studentId,
      type: dto.type,
      target_id: dto.target_id ?? null,
      subject: dto.subject,
      description: dto.description,
      status: ComplaintStatus.PENDING,
    });

    return await this.complaintsRepository.save(complaint);
  }

  public async getStudentComplaints(
    studentId: string,
    page = 1,
    limit = 20,
  ): Promise<PaginatedResponse<Complaint>> {
    const [complaints, total] = await this.complaintsRepository.findAndCount({
      where: { student_id: studentId },
      relations: ['admin'],
      order: { created_at: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    const totalPages = Math.ceil(total / limit);
    const meta: PaginationMeta = {
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    };

    return { data: complaints, meta };
  }

  public async getAllComplaints(filter: ComplaintFilterDto): Promise<PaginatedResponse<Complaint>> {
    const queryBuilder = this.complaintsRepository
      .createQueryBuilder('complaint')
      .leftJoinAndSelect('complaint.student', 'student')
      .leftJoinAndSelect('complaint.admin', 'admin');

    if (filter.status !== undefined) {
      queryBuilder.andWhere('complaint.status = :status', {
        status: filter.status,
      });
    }

    if (filter.type !== undefined) {
      queryBuilder.andWhere('complaint.type = :type', { type: filter.type });
    }

    const [complaints, total] = await queryBuilder
      .orderBy('complaint.created_at', 'DESC')
      .skip((filter.page - 1) * filter.limit)
      .take(filter.limit)
      .getManyAndCount();

    const totalPages = Math.ceil(total / filter.limit);
    const meta: PaginationMeta = {
      page: filter.page,
      limit: filter.limit,
      total,
      totalPages,
      hasNextPage: filter.page < totalPages,
      hasPrevPage: filter.page > 1,
    };

    return { data: complaints, meta };
  }

  public async respondToComplaint(
    complaintId: string,
    adminId: string,
    dto: RespondComplaintDto,
  ): Promise<Complaint> {
    const complaint = await this.complaintsRepository.findOne({
      where: { id: complaintId },
      relations: ['student'],
    });

    if (!complaint) {
      throw new NotFoundException(biBody('Complaint not found', 'الشكوى غير موجودة'));
    }

    complaint.admin_response = dto.admin_response;
    complaint.admin_id = adminId;
    complaint.responded_at = new Date();
    complaint.status = ComplaintStatus.RESOLVED;

    const updated = await this.complaintsRepository.save(complaint);

    // Send SMS notification to student's parent
    await this.notificationsService.create({
      user_id: complaint.student_id,
      type: NotificationType.CUSTOM,
      title: 'Complaint Response',
      message: `Your complaint "${complaint.subject}" has been responded to. Please check the app for details.`,
      send_sms: true,
    });

    return updated;
  }
}
