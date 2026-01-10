import { Injectable, Logger } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationType } from '../entities';
import { Payment, ItemType } from '../../payments/entities';
import { ExamAttempt } from '../../exams/entities';
import { LessonPurchase } from '../../payments/entities';

/**
 * Service for triggering notifications on business events
 * Called by other modules (payments, exams, etc.)
 */
@Injectable()
export class NotificationTriggersService {
  private readonly logger = new Logger(NotificationTriggersService.name);

  constructor(private readonly notificationsService: NotificationsService) {}

  /**
   * Notify when a purchase is completed
   */
  async notifyPurchaseCompleted(payment: Payment): Promise<void> {
    try {
      const message = this.generatePurchaseMessage(payment);

      await this.notificationsService.create({
        user_id: payment.user_id,
        type: NotificationType.PURCHASE,
        title: 'Purchase Completed',
        message,
        data: {
          payment_id: payment.id,
          item_type: payment.item_type,
          item_id: payment.item_id,
          amount: payment.final_amount,
        },
        send_sms: true,
      });

      this.logger.log(
        `Purchase notification sent for payment ${payment.id} to user ${payment.user_id}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to send purchase notification for payment ${payment.id}:`,
        error,
      );
    }
  }

  /**
   * Generate purchase notification message (Arabic)
   */
  private generatePurchaseMessage(payment: Payment): string {
    const itemType =
      payment.item_type === ItemType.LESSON
        ? 'الدرس'
        : payment.item_type === ItemType.PACKAGE
          ? 'الباقة'
          : 'الكتاب';

    if (Number(payment.final_amount) === 0) {
      // Free purchase (purchase code)
      return `تم الحصول على ${itemType} بنجاح باستخدام كود الشراء. مدة الوصول: 7 أيام.`;
    }

    return `تم شراء ${itemType} بنجاح. المبلغ: ${payment.final_amount} جنيه. مدة الوصول: 7 أيام.`;
  }

  /**
   * Notify when an exam is graded
   * Note: attempt must have the exam relation loaded to access total_marks
   */
  async notifyExamGraded(
    attempt: ExamAttempt & { exam?: { total_marks: number } },
    totalMarks?: number,
  ): Promise<void> {
    try {
      const marks = totalMarks || attempt.exam?.total_marks || 100;
      const score = Number(attempt.total_score) || 0;
      const percentage = Math.round((score / marks) * 100);

      const message = `تم تصحيح الامتحان. الدرجة: ${score}/${marks} (${percentage}%)`;

      await this.notificationsService.create({
        user_id: attempt.student_id,
        type: NotificationType.EXAM_RESULT,
        title: 'Exam Graded',
        message,
        data: {
          attempt_id: attempt.id,
          exam_id: attempt.exam_id,
          score: score,
          total_marks: marks,
          percentage,
        },
        send_sms: true,
      });

      this.logger.log(
        `Exam graded notification sent for attempt ${attempt.id} to user ${attempt.student_id}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to send exam graded notification for attempt ${attempt.id}:`,
        error,
      );
    }
  }

  /**
   * Notify when lesson access is about to expire (1 day before)
   */
  async notifyLessonExpiring(purchase: LessonPurchase): Promise<void> {
    try {
      const message = `تنبيه: صلاحية الوصول للدرس ستنتهي غداً. يمكنك تجديد الوصول بنصف السعر.`;

      await this.notificationsService.create({
        user_id: purchase.student_id,
        type: NotificationType.LESSON_EXPIRING,
        title: 'Lesson Expiring Soon',
        message,
        data: {
          purchase_id: purchase.id,
          lesson_id: purchase.lesson_id,
          expires_at: purchase.access_expires_at,
        },
        send_sms: true,
      });

      this.logger.log(
        `Lesson expiry notification sent for purchase ${purchase.id} to user ${purchase.student_id}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to send lesson expiry notification for purchase ${purchase.id}:`,
        error,
      );
    }
  }

  /**
   * Notify for attendance (when student is marked present)
   */
  async notifyAttendance(
    userId: string,
    lessonName: string,
    attendedAt: Date,
  ): Promise<void> {
    try {
      const formattedDate = attendedAt.toLocaleDateString('ar-EG', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });

      const message = `تم تسجيل حضور الطالب في درس "${lessonName}" في ${formattedDate}`;

      await this.notificationsService.create({
        user_id: userId,
        type: NotificationType.ATTENDANCE,
        title: 'Attendance Recorded',
        message,
        data: {
          lesson_name: lessonName,
          attended_at: attendedAt.toISOString(),
        },
        send_sms: true,
      });

      this.logger.log(`Attendance notification sent for user ${userId}`);
    } catch (error) {
      this.logger.error(
        `Failed to send attendance notification for user ${userId}:`,
        error,
      );
    }
  }

  /**
   * Send custom notification (admin triggered)
   */
  async sendCustomNotification(
    userId: string,
    title: string,
    message: string,
    sendSms: boolean = false,
  ): Promise<void> {
    try {
      await this.notificationsService.create(
        {
          user_id: userId,
          type: NotificationType.CUSTOM,
          title,
          message,
          send_sms: sendSms,
        },
        sendSms,
      );

      this.logger.log(`Custom notification sent to user ${userId}`);
    } catch (error) {
      this.logger.error(
        `Failed to send custom notification to user ${userId}:`,
        error,
      );
    }
  }
}
