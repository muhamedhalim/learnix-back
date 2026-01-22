import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Complaint } from './entities/complaint.entity';
import {
  CreateComplaintDto,
  RespondComplaintDto,
  ComplaintFilterDto,
} from './dto';
import { ComplaintStatus } from './enums/complaint-status.enum';
import { NotificationsService } from '../notifications/services/notifications.service';
import { NotificationType } from '../notifications/entities/notification-type.enum';
import {
  PaginatedResponse,
  PaginationMeta,
} from '../common/interfaces/pagination.interface';

@Injectable()
export class ComplaintsService {
  constructor(
    @InjectRepository(Complaint)
    private complaintsRepository: Repository<Complaint>,
    private notificationsService: NotificationsService,
  ) {}

  async createComplaint(
    studentId: string,
    dto: CreateComplaintDto,
  ): Promise<Complaint> {
    const complaint = this.complaintsRepository.create({
      student_id: studentId,
      type: dto.type,
      target_id: dto.target_id || null,
      subject: dto.subject,
      description: dto.description,
      status: ComplaintStatus.PENDING,
    });

    return this.complaintsRepository.save(complaint);
  }

  async getStudentComplaints(
    studentId: string,
    page: number = 1,
    limit: number = 20,
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

  async getAllComplaints(
    filter: ComplaintFilterDto,
  ): Promise<PaginatedResponse<Complaint>> {
    const queryBuilder = this.complaintsRepository
      .createQueryBuilder('complaint')
      .leftJoinAndSelect('complaint.student', 'student')
      .leftJoinAndSelect('complaint.admin', 'admin');

    if (filter.status) {
      queryBuilder.andWhere('complaint.status = :status', {
        status: filter.status,
      });
    }

    if (filter.type) {
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

  async respondToComplaint(
    complaintId: string,
    adminId: string,
    dto: RespondComplaintDto,
  ): Promise<Complaint> {
    const complaint = await this.complaintsRepository.findOne({
      where: { id: complaintId },
      relations: ['student'],
    });

    if (!complaint) {
      throw new NotFoundException('Complaint not found');
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
