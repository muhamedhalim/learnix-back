# API route inventory (runtime-derived)

Generated 2026-10-19 by `test/e2e/route-inventory.e2e-spec.ts` (`ROUTE_INVENTORY_OUT=<file>`) with `MARKETPLACE_ENABLED=true`. **705 unique METHOD+path combinations declared, 705 present on the live Express router, 0 live-but-undeclared.** All paths are relative to `/api/v1` except `GET /metrics`.

`E2E ref` = a supertest call to this METHOD+path is statically detectable in `test/e2e/**` (a lower bound: calls built through helpers or variables are not detected). Every row is additionally covered by `route-authorization-sweep.e2e-spec.ts` (anonymous 401, wrong-role 403, in-role no-5xx).

| Method | Path | Handler | Guards | Roles | E2E ref |
|---|---|---|---|---|---|
| GET | `/admin/activity-log/action-types` | ActivityLogsController.getActivityActionTypes | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/attendance` | AdminAttendanceController.getAllAttendance | HybridAuthGuard + RolesGuard | admin | yes |
| GET | `/admin/attendance-codes` | AdminAttendanceCodesController.findAll | HybridAuthGuard + RolesGuard | admin | no |
| DELETE | `/admin/attendance-codes/:code` | AdminAttendanceCodesController.remove | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/attendance-codes/:code` | AdminAttendanceCodesController.findOne | HybridAuthGuard + RolesGuard | admin | no |
| PATCH | `/admin/attendance-codes/:code` | AdminAttendanceCodesController.updateCode | HybridAuthGuard + RolesGuard | admin | no |
| POST | `/admin/attendance-codes/:code/deactivate` | AdminAttendanceCodesController.deactivateCode | HybridAuthGuard + RolesGuard | admin | no |
| POST | `/admin/attendance-codes/:code/reactivate` | AdminAttendanceCodesController.reactivateCode | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/attendance-codes/:code/usage` | AdminAttendanceCodesController.getCodeUsage | HybridAuthGuard + RolesGuard | admin | no |
| POST | `/admin/attendance-codes/bulk` | BulkOperationsController.generateBulkCodes | HybridAuthGuard + RolesGuard | admin | no |
| POST | `/admin/attendance-codes/generate` | AdminAttendanceCodesController.generate | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/attendance-codes/stats` | AdminAttendanceCodesController.getStats | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/attendance/export/:format` | AdminAttendanceController.exportAttendance | HybridAuthGuard + RolesGuard | admin | yes |
| GET | `/admin/audit-log` | ActivityLogsController.getAdminAuditLog | HybridAuthGuard + RolesGuard | admin | yes |
| GET | `/admin/audit-log/action-types` | ActivityLogsController.getAuditActionTypes | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/books` | AdminBooksController.findAll | HybridAuthGuard + RolesGuard | admin | no |
| DELETE | `/admin/books/:id` | AdminBooksController.delete | HybridAuthGuard + RolesGuard | admin | yes |
| GET | `/admin/books/:id` | AdminBooksController.findOne | HybridAuthGuard + RolesGuard | admin | yes |
| DELETE | `/admin/books/:id/permanent` | AdminBooksController.hardDelete | HybridAuthGuard + RolesGuard | admin | no |
| POST | `/admin/books/:id/restore` | AdminBooksController.restore | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/books/purchases/all` | AdminBooksController.getAllPurchases | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/call-center/canned-responses` | SupportManagementAdminController.canned | JwtAuthGuard + RolesGuard | admin | no |
| POST | `/admin/call-center/canned-responses` | SupportManagementAdminController.createCanned | JwtAuthGuard + RolesGuard | admin | yes |
| DELETE | `/admin/call-center/canned-responses/:id` | SupportManagementAdminController.deleteCanned | JwtAuthGuard + RolesGuard | admin | yes |
| PUT | `/admin/call-center/canned-responses/:id` | SupportManagementAdminController.updateCanned | JwtAuthGuard + RolesGuard | admin | yes |
| GET | `/admin/call-center/knowledge-base` | SupportManagementAdminController.articles | JwtAuthGuard + RolesGuard | admin | no |
| POST | `/admin/call-center/knowledge-base` | SupportManagementAdminController.createArticle | JwtAuthGuard + RolesGuard | admin | yes |
| DELETE | `/admin/call-center/knowledge-base/:id` | SupportManagementAdminController.deleteArticle | JwtAuthGuard + RolesGuard | admin | yes |
| PUT | `/admin/call-center/knowledge-base/:id` | SupportManagementAdminController.updateArticle | JwtAuthGuard + RolesGuard | admin | no |
| DELETE | `/admin/call-center/sla-policy` | SupportManagementAdminController.deletePolicy | JwtAuthGuard + RolesGuard | admin | yes |
| GET | `/admin/call-center/sla-policy` | SupportManagementAdminController.getPolicy | JwtAuthGuard + RolesGuard | admin | no |
| PUT | `/admin/call-center/sla-policy` | SupportManagementAdminController.putPolicy | JwtAuthGuard + RolesGuard | admin | yes |
| GET | `/admin/certificates` | AdminCertificatesController.list | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/certificates/:id/pdf` | AdminCertificatesController.pdf | HybridAuthGuard + RolesGuard | admin | no |
| POST | `/admin/certificates/:id/reissue` | AdminCertificatesController.reissue | HybridAuthGuard + RolesGuard | admin | yes |
| POST | `/admin/certificates/:id/revoke` | AdminCertificatesController.revoke | HybridAuthGuard + RolesGuard | admin | yes |
| GET | `/admin/certificates/analytics` | AdminCertificatesController.analytics | HybridAuthGuard + RolesGuard | admin | no |
| POST | `/admin/certificates/issue` | AdminCertificatesController.issue | HybridAuthGuard + RolesGuard | admin | yes |
| GET | `/admin/certificates/templates` | AdminCertificatesController.templates | HybridAuthGuard + RolesGuard | admin | no |
| POST | `/admin/certificates/templates` | AdminCertificatesController.createTemplate | HybridAuthGuard + RolesGuard | admin | yes |
| DELETE | `/admin/certificates/templates/:id` | AdminCertificatesController.deleteTemplate | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/certificates/templates/:id` | AdminCertificatesController.template | HybridAuthGuard + RolesGuard | admin | no |
| PATCH | `/admin/certificates/templates/:id` | AdminCertificatesController.updateTemplate | HybridAuthGuard + RolesGuard | admin | yes |
| POST | `/admin/certificates/templates/:id/archive` | AdminCertificatesController.archiveTemplate | HybridAuthGuard + RolesGuard | admin | no |
| POST | `/admin/certificates/templates/:id/duplicate` | AdminCertificatesController.duplicateTemplate | HybridAuthGuard + RolesGuard | admin | no |
| POST | `/admin/certificates/templates/:id/publish` | AdminCertificatesController.publishTemplate | HybridAuthGuard + RolesGuard | admin | yes |
| POST | `/admin/certificates/templates/:id/unpublish` | AdminCertificatesController.unpublishTemplate | HybridAuthGuard + RolesGuard | admin | no |
| POST | `/admin/certificates/templates/preview/pdf` | AdminCertificatesController.previewTemplate | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/code-batches` | AdminCodeBatchesController.list | HybridAuthGuard + RolesGuard | admin | no |
| POST | `/admin/code-batches` | AdminCodeBatchesController.create | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/code-batches/:id` | AdminCodeBatchesController.detail | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/code-batches/:id/timeline` | AdminCodeBatchesController.timeline | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/code-exports` | AdminCodeExportsController.list | HybridAuthGuard + RolesGuard | admin | no |
| POST | `/admin/code-exports` | AdminCodeExportsController.create | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/code-exports/:id` | AdminCodeExportsController.detail | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/code-exports/:id/download` | AdminCodeExportsController.download | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/codes` | AdminCodesController.list | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/codes/:id/qr` | AdminCodesController.qr | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/codes/analytics` | AdminCodesController.analytics | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/codes/analytics/dashboard` | AdminCodesController.dashboard | HybridAuthGuard + RolesGuard | admin | no |
| POST | `/admin/codes/bulk` | AdminCodesController.bulk | HybridAuthGuard + RolesGuard | admin | no |
| DELETE | `/admin/comments/:commentId` | CommentsAdminController.deleteComment | JwtAuthGuard + RolesGuard | admin | no |
| GET | `/admin/complaints` | ComplaintsAdminController.getAllComplaints | JwtAuthGuard + RolesGuard | admin | no |
| POST | `/admin/complaints/:id/respond` | ComplaintsAdminController.respondToComplaint | JwtAuthGuard + RolesGuard | admin | yes |
| GET | `/admin/discount-codes` | AdminDiscountCodesController.findAll | HybridAuthGuard + RolesGuard | admin | no |
| POST | `/admin/discount-codes` | AdminDiscountCodesController.create | HybridAuthGuard + RolesGuard | admin | no |
| DELETE | `/admin/discount-codes/:id` | AdminDiscountCodesController.remove | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/discount-codes/:id` | AdminDiscountCodesController.findOne | HybridAuthGuard + RolesGuard | admin | no |
| PATCH | `/admin/discount-codes/:id` | AdminDiscountCodesController.update | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/discount-codes/:id/usage` | AdminDiscountCodesController.getUsage | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/exams` | AdminExamsController.list | HybridAuthGuard + RolesGuard | admin | yes |
| GET | `/admin/exams/:id` | AdminExamsController.getOne | HybridAuthGuard + RolesGuard | admin | no |
| POST | `/admin/exams/:id/archive` | AdminExamsController.archive | HybridAuthGuard + RolesGuard | admin | no |
| POST | `/admin/exams/:id/unarchive` | AdminExamsController.unarchive | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/finance/audit` | AdminFinanceController.financeAuditTrail | FinancePermissionsGuard + HybridAuthGuard + RolesGuard | admin | yes |
| GET | `/admin/finance/audit/actions` | AdminFinanceController.financeAuditActions | FinancePermissionsGuard + HybridAuthGuard + RolesGuard | admin | yes |
| GET | `/admin/finance/manual-methods` | AdminFinanceController.listMethods | FinancePermissionsGuard + HybridAuthGuard + RolesGuard | admin | no |
| POST | `/admin/finance/manual-methods` | AdminFinanceController.createMethod | FinancePermissionsGuard + HybridAuthGuard + RolesGuard | admin | no |
| PATCH | `/admin/finance/manual-methods/:id` | AdminFinanceController.updateMethod | FinancePermissionsGuard + HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/finance/manual-submissions` | AdminFinanceController.listSubmissions | FinancePermissionsGuard + HybridAuthGuard + RolesGuard | admin | yes |
| POST | `/admin/finance/manual-submissions/:id/approve` | AdminFinanceController.approveSubmission | FinancePermissionsGuard + HybridAuthGuard + RolesGuard | admin | no |
| POST | `/admin/finance/manual-submissions/:id/cancel` | AdminFinanceController.cancelSubmission | FinancePermissionsGuard + HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/finance/manual-submissions/:id/proof` | AdminFinanceController.proof | FinancePermissionsGuard + HybridAuthGuard + RolesGuard | admin | no |
| POST | `/admin/finance/manual-submissions/:id/reject` | AdminFinanceController.rejectSubmission | FinancePermissionsGuard + HybridAuthGuard + RolesGuard | admin | no |
| POST | `/admin/finance/manual-submissions/:id/request-information` | AdminFinanceController.requestInformation | FinancePermissionsGuard + HybridAuthGuard + RolesGuard | admin | no |
| POST | `/admin/finance/manual-submissions/:id/review` | AdminFinanceController.startReview | FinancePermissionsGuard + HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/finance/manual-submissions/stats` | AdminFinanceController.submissionStats | FinancePermissionsGuard + HybridAuthGuard + RolesGuard | admin | yes |
| GET | `/admin/finance/orders` | AdminFinanceController.listOrders | FinancePermissionsGuard + HybridAuthGuard + RolesGuard | admin | yes |
| GET | `/admin/finance/reconciliation` | AdminFinanceController.reconciliation | FinancePermissionsGuard + HybridAuthGuard + RolesGuard | admin | yes |
| GET | `/admin/finance/refunds` | AdminFinanceController.listRefunds | FinancePermissionsGuard + HybridAuthGuard + RolesGuard | admin | no |
| POST | `/admin/finance/refunds` | AdminFinanceController.requestRefund | FinancePermissionsGuard + HybridAuthGuard + RolesGuard | admin | yes |
| POST | `/admin/finance/refunds/:id/complete` | AdminFinanceController.completeRefund | FinancePermissionsGuard + HybridAuthGuard + RolesGuard | admin | no |
| POST | `/admin/finance/refunds/:id/process-gateway` | AdminFinanceController.processGatewayRefund | FinancePermissionsGuard + HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/finance/reports` | AdminFinanceController.reports | FinancePermissionsGuard + HybridAuthGuard + RolesGuard | admin | yes |
| GET | `/admin/finance/reports/export` | AdminFinanceController.exportReports | FinancePermissionsGuard + HybridAuthGuard + RolesGuard | admin | yes |
| GET | `/admin/finance/reports/reconciliation-warnings` | AdminFinanceController.reportReconciliationWarnings | FinancePermissionsGuard + HybridAuthGuard + RolesGuard | admin | yes |
| GET | `/admin/finance/settlements` | AdminFinanceController.listSettlements | FinancePermissionsGuard + HybridAuthGuard + RolesGuard | admin | no |
| POST | `/admin/finance/settlements` | AdminFinanceController.createSettlement | FinancePermissionsGuard + HybridAuthGuard + RolesGuard | admin | yes |
| GET | `/admin/finance/settlements/:id` | AdminFinanceController.settlementDetails | FinancePermissionsGuard + HybridAuthGuard + RolesGuard | admin | yes |
| POST | `/admin/finance/settlements/:id/approve` | AdminFinanceController.approveSettlement | FinancePermissionsGuard + HybridAuthGuard + RolesGuard | admin | yes |
| POST | `/admin/finance/settlements/:id/cancel` | AdminFinanceController.cancelSettlement | FinancePermissionsGuard + HybridAuthGuard + RolesGuard | admin | no |
| POST | `/admin/finance/settlements/:id/pay` | AdminFinanceController.paySettlement | FinancePermissionsGuard + HybridAuthGuard + RolesGuard | admin | yes |
| POST | `/admin/finance/settlements/:id/reject` | AdminFinanceController.rejectSettlement | FinancePermissionsGuard + HybridAuthGuard + RolesGuard | admin | yes |
| GET | `/admin/finance/settlements/teacher-balances` | AdminFinanceController.teacherBalances | FinancePermissionsGuard + HybridAuthGuard + RolesGuard | admin | yes |
| GET | `/admin/gamification/rule-sets` | AdminGamificationController.history | HybridAuthGuard + RolesGuard | admin | no |
| POST | `/admin/gamification/rule-sets` | AdminGamificationController.create | HybridAuthGuard + RolesGuard | admin | no |
| PATCH | `/admin/gamification/rule-sets/:id/enabled` | AdminGamificationController.setEnabled | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/gamification/rule-sets/current` | AdminGamificationController.current | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/lessons` | AdminLessonsController.findAll | HybridAuthGuard + RolesGuard | admin | no |
| DELETE | `/admin/lessons/:id` | AdminLessonsController.delete | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/lessons/:id` | AdminLessonsController.findOne | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/lessons/:id/stats` | AdminLessonsController.getStats | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/lessons/:lessonId/sessions` | AdminLessonSessionsController.list | HybridAuthGuard + RolesGuard | admin | yes |
| GET | `/admin/notifications` | AdminNotificationsController.findAll | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/notifications/:notificationId` | AdminNotificationsController.getNotificationDetails | HybridAuthGuard + RolesGuard | admin | no |
| POST | `/admin/notifications/:notificationId/retry` | AdminNotificationsController.retryNotification | HybridAuthGuard + RolesGuard | admin | no |
| POST | `/admin/notifications/bulk-send` | BulkOperationsController.sendBulkNotifications | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/notifications/campaigns` | AdminNotificationsController.listCampaigns | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/notifications/campaigns/:campaignId` | AdminNotificationsController.getCampaign | HybridAuthGuard + RolesGuard | admin | no |
| POST | `/admin/notifications/deliveries/:deliveryId/retry` | AdminNotificationsController.retryDelivery | HybridAuthGuard + RolesGuard | admin | no |
| POST | `/admin/notifications/manual` | AdminNotificationsController.sendManualNotification | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/notifications/stats` | AdminNotificationsController.getStatistics | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/packages` | AdminPackagesController.findAll | HybridAuthGuard + RolesGuard | admin | yes |
| DELETE | `/admin/packages/:id` | AdminPackagesController.delete | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/packages/:id` | AdminPackagesController.findOne | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/packages/:id/stats` | AdminPackagesController.getStats | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/parent-messages` | AdminParentMessagesController.list | HybridAuthGuard + RolesGuard | admin | no |
| POST | `/admin/parent-messages/:id/retry` | AdminParentMessagesController.retry | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/parent-messages/queue-health` | AdminParentMessagesController.queueHealth | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/parent-messages/stats` | AdminParentMessagesController.stats | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/payments` | AdminPaymentsController.getAllPayments | FinancePermissionsGuard + HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/payments/:id` | AdminPaymentsController.getPaymentById | FinancePermissionsGuard + HybridAuthGuard + RolesGuard | admin | no |
| POST | `/admin/payments/:id/extend` | AdminPaymentsController.extendLessonAccess | FinancePermissionsGuard + HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/payments/lesson-purchases` | AdminPaymentsController.getAllLessonPurchases | FinancePermissionsGuard + HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/payments/revenue` | AdminPaymentsController.getRevenue | FinancePermissionsGuard + HybridAuthGuard + RolesGuard | admin | no |
| DELETE | `/admin/reviews/:type/:reviewId` | AdminReviewsController.remove | JwtAuthGuard + RolesGuard | admin | no |
| PATCH | `/admin/reviews/:type/:reviewId/status` | AdminReviewsController.moderate | JwtAuthGuard + RolesGuard | admin | yes |
| GET | `/admin/reviews/lessons` | AdminReviewsController.lessonReviews | JwtAuthGuard + RolesGuard | admin | no |
| GET | `/admin/reviews/teachers` | AdminReviewsController.teacherReviews | JwtAuthGuard + RolesGuard | admin | no |
| GET | `/admin/students` | AdminStudentsController.findAll | HybridAuthGuard + RolesGuard | admin | yes |
| DELETE | `/admin/students/:id` | AdminStudentsController.permanentlyDelete | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/students/:id` | AdminStudentsController.findOne | HybridAuthGuard + RolesGuard | admin | yes |
| POST | `/admin/students/:id/approve` | AdminStudentsController.approve | HybridAuthGuard + RolesGuard | admin | yes |
| GET | `/admin/students/:id/deletion-preview` | AdminStudentsController.deletionPreview | HybridAuthGuard + RolesGuard | admin | no |
| POST | `/admin/students/:id/reject` | AdminStudentsController.reject | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/students/:id/stats` | AdminStudentsController.getStats | HybridAuthGuard + RolesGuard | admin | no |
| POST | `/admin/students/bulk-import` | BulkOperationsController.importStudents | HybridAuthGuard + RolesGuard | admin | no |
| POST | `/admin/students/bulk-import/preview` | BulkOperationsController.previewStudentImport | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/students/pending` | AdminStudentsController.findPending | HybridAuthGuard + RolesGuard | admin | yes |
| GET | `/admin/subjects` | AdminSubjectsController.findAll | HybridAuthGuard + RolesGuard | admin | yes |
| POST | `/admin/subjects` | AdminSubjectsController.create | HybridAuthGuard + RolesGuard | admin | no |
| DELETE | `/admin/subjects/:id` | AdminSubjectsController.remove | HybridAuthGuard + RolesGuard | admin | yes |
| PUT | `/admin/subjects/:id` | AdminSubjectsController.update | HybridAuthGuard + RolesGuard | admin | yes |
| POST | `/admin/subjects/:id/approve` | AdminSubjectsController.approve | HybridAuthGuard + RolesGuard | admin | yes |
| POST | `/admin/subjects/:id/reactivate` | AdminSubjectsController.reactivate | HybridAuthGuard + RolesGuard | admin | yes |
| POST | `/admin/subjects/:id/reject` | AdminSubjectsController.reject | HybridAuthGuard + RolesGuard | admin | yes |
| POST | `/admin/subjects/:id/suspend` | AdminSubjectsController.suspend | HybridAuthGuard + RolesGuard | admin | yes |
| GET | `/admin/subjects/counts` | AdminSubjectsController.getSubjectsWithCounts | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/subjects/pending` | AdminSubjectsController.findPending | HybridAuthGuard + RolesGuard | admin | yes |
| GET | `/admin/teachers` | AdminTeachersController.findAll | HybridAuthGuard + RolesGuard | admin | yes |
| DELETE | `/admin/teachers/:id` | AdminTeachersController.permanentlyDelete | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/teachers/:id` | AdminTeachersController.findOne | HybridAuthGuard + RolesGuard | admin | yes |
| POST | `/admin/teachers/:id/approve` | AdminTeachersController.approve | HybridAuthGuard + RolesGuard | admin | yes |
| GET | `/admin/teachers/:id/deletion-preview` | AdminTeachersController.deletionPreview | HybridAuthGuard + RolesGuard | admin | no |
| POST | `/admin/teachers/:id/reject` | AdminTeachersController.reject | HybridAuthGuard + RolesGuard | admin | yes |
| GET | `/admin/teachers/:id/stats` | AdminTeachersController.getStats | HybridAuthGuard + RolesGuard | admin | no |
| POST | `/admin/teachers/:id/subjects` | AdminTeachersController.assignSubjects | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/teachers/pending` | AdminTeachersController.findPending | HybridAuthGuard + RolesGuard | admin | yes |
| POST | `/admin/teachers/promote` | AdminTeachersController.promote | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/users/:userId/activity-stats` | ActivityLogsController.getUserActivityStats | HybridAuthGuard + RolesGuard | admin | no |
| POST | `/admin/users/bulk-action` | BulkOperationsController.bulkUserAction | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/admin/wishlist/analytics/top` | AdminWishlistController.top | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/analytics/admin/dashboard` | AnalyticsController.getAdminDashboard | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/analytics/exams/:examId` | AnalyticsController.getExamAnalytics | HybridAuthGuard + RolesGuard | admin, teacher | yes |
| GET | `/analytics/lessons` | AnalyticsController.getLessonAnalyticsBatch | HybridAuthGuard + RolesGuard | admin, teacher | no |
| GET | `/analytics/lessons/:lessonId` | AnalyticsController.getLessonAnalytics | HybridAuthGuard + RolesGuard | admin, teacher | no |
| GET | `/analytics/quiz/student` | QuizAnalyticsController.student | HybridAuthGuard + RolesGuard | student | yes |
| GET | `/analytics/quiz/teacher` | QuizAnalyticsController.teacher | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/analytics/quiz/teacher/exams/:examId` | QuizAnalyticsController.examQuestions | HybridAuthGuard + RolesGuard | teacher | yes |
| GET | `/analytics/student/dashboard` | AnalyticsController.getStudentDashboard | HybridAuthGuard + RolesGuard | student | no |
| GET | `/analytics/teacher/dashboard` | AnalyticsController.getTeacherDashboard | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/attendance-codes/redeem` | AttendanceCodesController.redeemCode | HybridAuthGuard + RolesGuard | student | no |
| POST | `/attendance-codes/verify` | AttendanceCodesController.verifyCode | HybridAuthGuard + RolesGuard | student | no |
| GET | `/auth/csrf-token` | AuthController.getCsrfToken | public | - | yes |
| POST | `/auth/forgot-password` | AuthController.forgotPassword | public | - | no |
| POST | `/auth/login` | AuthController.login | public | - | yes |
| POST | `/auth/logout` | AuthController.logout | JwtAuthGuard | - | yes |
| POST | `/auth/refresh` | AuthController.refresh | public | - | yes |
| POST | `/auth/register` | AuthController.register | public | - | yes |
| POST | `/auth/reset-password` | AuthController.resetPassword | public | - | no |
| GET | `/books` | BooksController.findAll | public | - | yes |
| GET | `/books/:id` | BooksController.findOne | public | - | yes |
| GET | `/callcenter/agents` | CallCenterController.getActiveAgents | HybridAuthGuard + RolesGuard | admin, call_center | yes |
| GET | `/callcenter/dashboard` | CallCenterController.dashboard | HybridAuthGuard + RolesGuard | admin, call_center | no |
| GET | `/callcenter/finance/payments` | CallCenterController.financePayments | HybridAuthGuard + RolesGuard | admin, call_center | yes |
| GET | `/callcenter/finance/receivables` | CallCenterController.financeReceivables | HybridAuthGuard + RolesGuard | admin, call_center | yes |
| GET | `/callcenter/finance/settlements` | CallCenterController.financeSettlements | HybridAuthGuard + RolesGuard | admin, call_center | yes |
| GET | `/callcenter/notifications` | CallCenterController.supportNotifications | HybridAuthGuard + RolesGuard | admin, call_center | yes |
| GET | `/callcenter/reports` | CallCenterController.reports | HybridAuthGuard + RolesGuard | admin, call_center | yes |
| GET | `/callcenter/resources/canned-responses` | CallCenterController.cannedResponses | HybridAuthGuard + RolesGuard | admin, call_center | yes |
| GET | `/callcenter/resources/knowledge-base` | CallCenterController.knowledgeBase | HybridAuthGuard + RolesGuard | admin, call_center | yes |
| GET | `/callcenter/sla` | CallCenterController.sla | HybridAuthGuard + RolesGuard | admin, call_center | yes |
| GET | `/callcenter/students` | CallCenterController.searchStudents | HybridAuthGuard + RolesGuard | admin, call_center | yes |
| GET | `/callcenter/students/:studentId` | CallCenterController.getStudentProfile | HybridAuthGuard + RolesGuard | admin, call_center | yes |
| PUT | `/callcenter/students/:studentId` | CallCenterController.updateStudent | HybridAuthGuard + RolesGuard | admin, call_center | yes |
| GET | `/callcenter/tickets` | ComplaintsCallCenterController.list | JwtAuthGuard + RolesGuard | admin, call_center | yes |
| GET | `/callcenter/tickets/:id` | ComplaintsCallCenterController.getOne | JwtAuthGuard + RolesGuard | admin, call_center | yes |
| PATCH | `/callcenter/tickets/:id/assignment` | ComplaintsCallCenterController.assign | JwtAuthGuard + RolesGuard | admin, call_center | yes |
| POST | `/callcenter/tickets/:id/attachments` | ComplaintsCallCenterController.addAttachment | JwtAuthGuard + RolesGuard | admin, call_center | yes |
| GET | `/callcenter/tickets/:id/attachments/:attachmentId/download` | ComplaintsCallCenterController.downloadAttachment | JwtAuthGuard + RolesGuard | admin, call_center | yes |
| POST | `/callcenter/tickets/:id/messages` | ComplaintsCallCenterController.addMessage | JwtAuthGuard + RolesGuard | admin, call_center | yes |
| PATCH | `/callcenter/tickets/:id/status` | ComplaintsCallCenterController.transition | JwtAuthGuard + RolesGuard | admin, call_center | yes |
| GET | `/callcenter/users` | CallCenterController.searchSupportUsers | HybridAuthGuard + RolesGuard | admin, call_center | yes |
| GET | `/callcenter/users/:userId` | CallCenterController.getSupportUser | HybridAuthGuard + RolesGuard | admin, call_center | yes |
| POST | `/callcenter/users/:userId/terminate-sessions` | CallCenterController.terminateSupportUserSessions | HybridAuthGuard + RolesGuard | admin, call_center | yes |
| GET | `/cart` | CartController.getCart | HybridAuthGuard + RolesGuard | student | no |
| POST | `/cart/checkout` | CartController.checkout | HybridAuthGuard + RolesGuard | student | no |
| POST | `/cart/items` | CartController.addToCart | HybridAuthGuard + RolesGuard | student | no |
| DELETE | `/cart/items/:itemId` | CartController.removeItem | HybridAuthGuard + RolesGuard | student | no |
| GET | `/certificates/public` | PublicCertificatesController.gallery | public | - | yes |
| GET | `/certificates/verify/:code` | PublicCertificatesController.verify | public | - | yes |
| GET | `/certificates/verify/:code/pdf` | PublicCertificatesController.pdf | public | - | yes |
| POST | `/discount-codes/verify` | DiscountCodesController.verifyCode | HybridAuthGuard | - | no |
| GET | `/health` | HealthController.liveness | public | - | yes |
| POST | `/health/actions/export` | HealthController.exportReport | HybridAuthGuard + RolesGuard | admin | no |
| POST | `/health/actions/run` | HealthController.runFull | HybridAuthGuard + RolesGuard | admin | no |
| POST | `/health/actions/test-email` | HealthController.testEmail | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/health/alerts` | HealthController.alertRules | HybridAuthGuard + RolesGuard | admin | yes |
| PATCH | `/health/alerts/:id` | HealthController.updateAlertRule | HybridAuthGuard + RolesGuard | admin | yes |
| GET | `/health/all` | HealthController.dashboard | HybridAuthGuard + RolesGuard | admin | no |
| POST | `/health/components/:id/recheck` | HealthController.recheck | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/health/errors` | HealthController.recentErrors | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/health/incidents` | HealthController.incidentHistory | HybridAuthGuard + RolesGuard | admin | yes |
| GET | `/health/metrics` | HealthController.metricHistory | HybridAuthGuard + RolesGuard | admin | no |
| POST | `/health/queues/:name/action` | HealthController.queueAction | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/health/readiness` | HealthController.readiness | public | - | no |
| GET | `/health/summary` | HealthController.dashboardSummary | HybridAuthGuard + RolesGuard | admin | no |
| POST | `/init-admin` | AppController.initAdmin | InitAdminGuard | - | no |
| GET | `/leaderboard` | GamificationPublicController.getLeaderboard | public | - | yes |
| GET | `/leaderboard/scopes` | GamificationPublicController.getScopes | public | - | no |
| GET | `/lessons` | LessonsController.findAll | public | - | yes |
| GET | `/lessons/:id` | LessonsController.findOne | public | - | yes |
| GET | `/lessons/:id/attachments` | LessonsController.getAttachments | HybridAuthGuard | - | no |
| GET | `/lessons/:id/attachments/:attachmentId/download` | LessonsController.downloadAttachment | HybridAuthGuard | - | no |
| POST | `/lessons/:id/enter` | SessionController.enterLesson | HybridAuthGuard + RolesGuard | student | yes |
| POST | `/lessons/:id/exit` | SessionController.exitLesson | HybridAuthGuard + RolesGuard | student | yes |
| GET | `/lessons/:id/note` | LessonsController.getNote | HybridAuthGuard | - | no |
| PUT | `/lessons/:id/note` | LessonsController.saveNote | HybridAuthGuard | - | no |
| GET | `/lessons/:id/signed-url` | LessonsController.getSignedUrl | HybridAuthGuard | - | no |
| GET | `/lessons/:lessonId/comments` | CommentsPublicController.getCommentsByLesson | public | - | yes |
| GET | `/lessons/:lessonId/reviews` | ReviewsPublicController.getLessonReviews | public | - | yes |
| GET | `/lessons/:lessonId/sessions` | PublicLessonSessionsController.list | public | - | yes |
| PATCH | `/lessons/sessions/:sessionId/progress` | SessionController.updateProgress | HybridAuthGuard + RolesGuard | student | no |
| GET | `/lessons/subject/:subjectId` | LessonsController.findBySubject | public | - | no |
| GET | `/lessons/teacher/:teacherId` | LessonsController.findByTeacher | public | - | no |
| POST | `/marketplace/admin/applicants/:userId/reset-attempts` | AdminApplicationsController.resetAttempts | JwtAuthGuard + RolesGuard | admin | yes |
| GET | `/marketplace/admin/applications` | AdminApplicationsController.listQueue | JwtAuthGuard + RolesGuard | admin | yes |
| GET | `/marketplace/admin/applications/:id` | AdminApplicationsController.getDossier | JwtAuthGuard + RolesGuard | admin | yes |
| POST | `/marketplace/admin/applications/:id/approve` | AdminApplicationsController.approve | JwtAuthGuard + RolesGuard | admin | yes |
| POST | `/marketplace/admin/applications/:id/reject` | AdminApplicationsController.reject | JwtAuthGuard + RolesGuard | admin | yes |
| GET | `/marketplace/admin/categories` | AdminCategoriesController.list | JwtAuthGuard + RolesGuard | admin | no |
| POST | `/marketplace/admin/categories` | AdminCategoriesController.create | JwtAuthGuard + RolesGuard | admin | yes |
| DELETE | `/marketplace/admin/categories/:id` | AdminCategoriesController.remove | JwtAuthGuard + RolesGuard | admin | yes |
| PATCH | `/marketplace/admin/categories/:id` | AdminCategoriesController.update | JwtAuthGuard + RolesGuard | admin | yes |
| GET | `/marketplace/admin/commission` | AdminReportingController.getCommission | FinancePermissionsGuard + JwtAuthGuard + RolesGuard | admin | yes |
| PUT | `/marketplace/admin/commission` | AdminReportingController.setCommission | FinancePermissionsGuard + JwtAuthGuard + RolesGuard | admin | no |
| GET | `/marketplace/admin/courses` | AdminCoursesController.list | JwtAuthGuard + RolesGuard | admin | no |
| POST | `/marketplace/admin/courses/:id/approve` | AdminCoursesController.approve | JwtAuthGuard + RolesGuard | admin | yes |
| GET | `/marketplace/admin/courses/:id/content` | AdminCoursesController.getContent | JwtAuthGuard + RolesGuard | admin | yes |
| GET | `/marketplace/admin/courses/:id/lessons/:lessonId/video` | AdminCoursesController.getLessonVideo | JwtAuthGuard + RolesGuard | admin | yes |
| POST | `/marketplace/admin/courses/:id/reject` | AdminCoursesController.reject | JwtAuthGuard + RolesGuard | admin | yes |
| POST | `/marketplace/admin/courses/:id/remove` | AdminCourseRemovalController.remove | FinancePermissionsGuard + JwtAuthGuard + RolesGuard | admin | yes |
| POST | `/marketplace/admin/courses/:id/unpublish` | AdminCoursesController.unpublish | JwtAuthGuard + RolesGuard | admin | no |
| GET | `/marketplace/admin/exports/earnings` | AdminReportingController.exportEarnings | FinancePermissionsGuard + JwtAuthGuard + RolesGuard | admin | no |
| GET | `/marketplace/admin/exports/ledger` | AdminReportingController.exportLedger | FinancePermissionsGuard + JwtAuthGuard + RolesGuard | admin | no |
| GET | `/marketplace/admin/exports/payouts` | AdminReportingController.exportPayouts | FinancePermissionsGuard + JwtAuthGuard + RolesGuard | admin | no |
| GET | `/marketplace/admin/exports/sales` | AdminReportingController.exportSales | FinancePermissionsGuard + JwtAuthGuard + RolesGuard | admin | yes |
| GET | `/marketplace/admin/instructors` | AdminInstructorsController.roster | JwtAuthGuard + RolesGuard | admin | yes |
| GET | `/marketplace/admin/instructors/:id` | AdminInstructorsController.getFullRecord | JwtAuthGuard + RolesGuard | admin | no |
| POST | `/marketplace/admin/instructors/:id/profile-changes/approve` | AdminInstructorsController.approveProfileChanges | JwtAuthGuard + RolesGuard | admin | no |
| POST | `/marketplace/admin/instructors/:id/profile-changes/reject` | AdminInstructorsController.rejectProfileChanges | JwtAuthGuard + RolesGuard | admin | no |
| POST | `/marketplace/admin/instructors/:id/reinstate` | AdminInstructorsController.reinstate | JwtAuthGuard + RolesGuard | admin | no |
| POST | `/marketplace/admin/instructors/:id/suspend` | AdminInstructorsController.suspend | JwtAuthGuard + RolesGuard | admin | yes |
| GET | `/marketplace/admin/ledger` | AdminLedgerController.list | FinancePermissionsGuard + JwtAuthGuard + RolesGuard | admin | yes |
| POST | `/marketplace/admin/ledger/adjustments` | AdminLedgerController.createAdjustment | FinancePermissionsGuard + JwtAuthGuard + RolesGuard | admin | yes |
| GET | `/marketplace/admin/orders/:id/money-trail` | AdminReportingController.getMoneyTrail | FinancePermissionsGuard + JwtAuthGuard + RolesGuard | admin | no |
| GET | `/marketplace/admin/overview` | AdminOverviewController.getOverview | JwtAuthGuard + RolesGuard | admin | yes |
| GET | `/marketplace/admin/payouts` | AdminPayoutController.queue | FinancePermissionsGuard + JwtAuthGuard + RolesGuard | admin | yes |
| GET | `/marketplace/admin/payouts/:id` | AdminPayoutController.get | FinancePermissionsGuard + JwtAuthGuard + RolesGuard | admin | yes |
| POST | `/marketplace/admin/payouts/:id/approve` | AdminPayoutController.approve | FinancePermissionsGuard + JwtAuthGuard + RolesGuard | admin | yes |
| POST | `/marketplace/admin/payouts/:id/failed` | AdminPayoutController.markFailed | FinancePermissionsGuard + JwtAuthGuard + RolesGuard | admin | yes |
| POST | `/marketplace/admin/payouts/:id/paid` | AdminPayoutController.markPaid | FinancePermissionsGuard + JwtAuthGuard + RolesGuard | admin | yes |
| POST | `/marketplace/admin/payouts/:id/processing` | AdminPayoutController.markProcessing | FinancePermissionsGuard + JwtAuthGuard + RolesGuard | admin | yes |
| POST | `/marketplace/admin/payouts/:id/reject` | AdminPayoutController.reject | FinancePermissionsGuard + JwtAuthGuard + RolesGuard | admin | yes |
| GET | `/marketplace/admin/payouts/report` | AdminPayoutController.report | FinancePermissionsGuard + JwtAuthGuard + RolesGuard | admin | yes |
| GET | `/marketplace/admin/reconciliation` | AdminReportingController.getReconciliation | FinancePermissionsGuard + JwtAuthGuard + RolesGuard | admin | yes |
| GET | `/marketplace/admin/refunds` | AdminRefundController.queue | FinancePermissionsGuard + JwtAuthGuard + RolesGuard | admin | yes |
| GET | `/marketplace/admin/refunds/:id` | AdminRefundController.get | FinancePermissionsGuard + JwtAuthGuard + RolesGuard | admin | no |
| POST | `/marketplace/admin/refunds/:id/retry` | AdminRefundController.retry | FinancePermissionsGuard + JwtAuthGuard + RolesGuard | admin | yes |
| POST | `/marketplace/admin/refunds/discretionary` | AdminRefundController.discretionary | FinancePermissionsGuard + JwtAuthGuard + RolesGuard | admin | yes |
| GET | `/marketplace/admin/reviews` | AdminReviewController.queue | JwtAuthGuard + RolesGuard | admin | yes |
| POST | `/marketplace/admin/reviews/:id/moderate` | AdminReviewController.moderate | JwtAuthGuard + RolesGuard | admin | yes |
| GET | `/marketplace/admin/sales` | AdminReportingController.getSales | FinancePermissionsGuard + JwtAuthGuard + RolesGuard | admin | yes |
| POST | `/marketplace/applications` | ApplicationsController.create | JwtAuthGuard | - | yes |
| GET | `/marketplace/applications/me` | ApplicationsController.getMine | JwtAuthGuard | - | yes |
| PATCH | `/marketplace/applications/me` | ApplicationsController.update | JwtAuthGuard | - | yes |
| POST | `/marketplace/applications/me/documents` | ApplicationsController.uploadDocument | JwtAuthGuard | - | yes |
| POST | `/marketplace/applications/me/submit` | ApplicationsController.submit | JwtAuthGuard | - | yes |
| POST | `/marketplace/applications/me/withdraw` | ApplicationsController.withdraw | JwtAuthGuard | - | yes |
| POST | `/marketplace/applications/public` | PublicApplicationsController.submitPublic | public | - | no |
| GET | `/marketplace/categories` | PublicCategoriesController.list | public | - | yes |
| POST | `/marketplace/checkout/enroll-free` | FreeEnrollmentController.enrollFree | JwtAuthGuard + PerAccountThrottlerGuard | - | yes |
| POST | `/marketplace/checkout/orders` | LearnerCheckoutController.createOrder | JwtAuthGuard | - | yes |
| POST | `/marketplace/checkout/orders/:id/pay` | LearnerCheckoutController.pay | JwtAuthGuard | - | no |
| GET | `/marketplace/courses` | PublicCatalogController.list | public | - | yes |
| GET | `/marketplace/courses/:slug` | PublicCatalogController.detail | OptionalJwtAuthGuard | - | yes |
| GET | `/marketplace/courses/:slug/curriculum` | PublicCatalogController.curriculum | public | - | yes |
| GET | `/marketplace/courses/:slug/preview/:lessonId` | PublicCatalogController.preview | public | - | yes |
| GET | `/marketplace/courses/:slug/reviews` | PublicReviewController.list | public | - | yes |
| GET | `/marketplace/instructor/courses` | InstructorCoursesController.list | ApprovedInstructorGuard + JwtAuthGuard | - | yes |
| POST | `/marketplace/instructor/courses` | InstructorCoursesController.create | ApprovedInstructorGuard + JwtAuthGuard | - | yes |
| POST | `/marketplace/instructor/courses/:courseId/lessons` | InstructorCurriculumController.createLesson | ApprovedInstructorGuard + JwtAuthGuard | - | yes |
| DELETE | `/marketplace/instructor/courses/:courseId/lessons/:lessonId` | InstructorCurriculumController.deleteLesson | ApprovedInstructorGuard + JwtAuthGuard | - | yes |
| PATCH | `/marketplace/instructor/courses/:courseId/lessons/:lessonId` | InstructorCurriculumController.updateLesson | ApprovedInstructorGuard + JwtAuthGuard | - | yes |
| GET | `/marketplace/instructor/courses/:courseId/lessons/:lessonId/video-status` | InstructorCurriculumController.getVideoStatus | ApprovedInstructorGuard + JwtAuthGuard | - | no |
| POST | `/marketplace/instructor/courses/:courseId/lessons/:lessonId/video-upload/aws` | InstructorCurriculumController.startAwsVideoUpload | ApprovedInstructorGuard + JwtAuthGuard | - | no |
| POST | `/marketplace/instructor/courses/:courseId/lessons/:lessonId/video-upload/aws/:uploadId/abort` | InstructorCurriculumController.awsAbort | ApprovedInstructorGuard + JwtAuthGuard | - | no |
| GET | `/marketplace/instructor/courses/:courseId/lessons/:lessonId/video-upload/aws/:uploadId/parts` | InstructorCurriculumController.awsListParts | ApprovedInstructorGuard + JwtAuthGuard | - | no |
| POST | `/marketplace/instructor/courses/:courseId/lessons/:lessonId/video-upload/aws/:uploadId/parts` | InstructorCurriculumController.awsPartUrls | ApprovedInstructorGuard + JwtAuthGuard | - | no |
| POST | `/marketplace/instructor/courses/:courseId/lessons/:lessonId/video-upload/aws/complete` | InstructorCurriculumController.completeAwsVideoUpload | ApprovedInstructorGuard + JwtAuthGuard | - | no |
| POST | `/marketplace/instructor/courses/:courseId/lessons/reorder` | InstructorCurriculumController.reorderLessons | ApprovedInstructorGuard + JwtAuthGuard | - | no |
| POST | `/marketplace/instructor/courses/:courseId/sections` | InstructorCurriculumController.createSection | ApprovedInstructorGuard + JwtAuthGuard | - | yes |
| DELETE | `/marketplace/instructor/courses/:courseId/sections/:sectionId` | InstructorCurriculumController.deleteSection | ApprovedInstructorGuard + JwtAuthGuard | - | yes |
| PATCH | `/marketplace/instructor/courses/:courseId/sections/:sectionId` | InstructorCurriculumController.updateSection | ApprovedInstructorGuard + JwtAuthGuard | - | yes |
| POST | `/marketplace/instructor/courses/:courseId/sections/reorder` | InstructorCurriculumController.reorderSections | ApprovedInstructorGuard + JwtAuthGuard | - | no |
| GET | `/marketplace/instructor/courses/:courseId/video-upload/capabilities` | InstructorCurriculumController.awsVideoCapabilities | ApprovedInstructorGuard + JwtAuthGuard | - | no |
| DELETE | `/marketplace/instructor/courses/:id` | InstructorCoursesController.remove | ApprovedInstructorGuard + JwtAuthGuard | - | yes |
| GET | `/marketplace/instructor/courses/:id` | InstructorCoursesController.get | ApprovedInstructorGuard + JwtAuthGuard | - | yes |
| PATCH | `/marketplace/instructor/courses/:id` | InstructorCoursesController.update | ApprovedInstructorGuard + JwtAuthGuard | - | yes |
| GET | `/marketplace/instructor/courses/:id/curriculum` | InstructorCoursesController.getCurriculum | ApprovedInstructorGuard + JwtAuthGuard | - | yes |
| POST | `/marketplace/instructor/courses/:id/publish` | InstructorCoursesController.publish | ApprovedInstructorGuard + JwtAuthGuard | - | yes |
| GET | `/marketplace/instructor/courses/:id/readiness` | InstructorCoursesController.readinessCheck | ApprovedInstructorGuard + JwtAuthGuard | - | yes |
| POST | `/marketplace/instructor/courses/:id/reopen-for-edit` | InstructorCoursesController.reopenForEdit | ApprovedInstructorGuard + JwtAuthGuard | - | no |
| POST | `/marketplace/instructor/courses/:id/republish` | InstructorCoursesController.republish | ApprovedInstructorGuard + JwtAuthGuard | - | yes |
| GET | `/marketplace/instructor/courses/:id/review-decisions` | InstructorCoursesController.listReviewDecisions | ApprovedInstructorGuard + JwtAuthGuard | - | yes |
| POST | `/marketplace/instructor/courses/:id/submit` | InstructorCoursesController.submit | ApprovedInstructorGuard + JwtAuthGuard | - | yes |
| POST | `/marketplace/instructor/courses/:id/unpublish` | InstructorCoursesController.unpublish | ApprovedInstructorGuard + JwtAuthGuard | - | yes |
| GET | `/marketplace/instructor/earnings` | InstructorEarningsController.list | ApprovedInstructorGuard + JwtAuthGuard | - | no |
| GET | `/marketplace/instructor/earnings/balance` | InstructorEarningsController.balance | ApprovedInstructorGuard + JwtAuthGuard | - | yes |
| GET | `/marketplace/instructor/ledger` | InstructorLedgerController.list | ApprovedInstructorGuard + JwtAuthGuard | - | yes |
| GET | `/marketplace/instructor/payout-accounts` | InstructorPayoutController.listAccounts | ApprovedInstructorGuard + JwtAuthGuard | - | yes |
| POST | `/marketplace/instructor/payout-accounts` | InstructorPayoutController.createAccount | ApprovedInstructorGuard + JwtAuthGuard | - | yes |
| DELETE | `/marketplace/instructor/payout-accounts/:id` | InstructorPayoutController.removeAccount | ApprovedInstructorGuard + JwtAuthGuard | - | yes |
| PATCH | `/marketplace/instructor/payout-accounts/:id` | InstructorPayoutController.updateAccount | ApprovedInstructorGuard + JwtAuthGuard | - | yes |
| POST | `/marketplace/instructor/payout-accounts/:id/default` | InstructorPayoutController.setDefaultAccount | ApprovedInstructorGuard + JwtAuthGuard | - | yes |
| GET | `/marketplace/instructor/payouts` | InstructorPayoutController.listRequests | ApprovedInstructorGuard + JwtAuthGuard | - | yes |
| POST | `/marketplace/instructor/payouts` | InstructorPayoutController.createRequest | ApprovedInstructorGuard + JwtAuthGuard + PayoutRequestThrottlerGuard | - | yes |
| GET | `/marketplace/instructor/payouts/:id` | InstructorPayoutController.getRequest | ApprovedInstructorGuard + JwtAuthGuard | - | yes |
| POST | `/marketplace/instructor/payouts/:id/cancel` | InstructorPayoutController.cancelRequest | ApprovedInstructorGuard + JwtAuthGuard | - | yes |
| GET | `/marketplace/instructor/profile` | InstructorProfileController.getProfile | ApprovedInstructorGuard + JwtAuthGuard | - | yes |
| PATCH | `/marketplace/instructor/profile` | InstructorProfileController.updateProfile | ApprovedInstructorGuard + JwtAuthGuard | - | yes |
| GET | `/marketplace/instructor/reviews` | InstructorReviewController.list | ApprovedInstructorGuard + JwtAuthGuard | - | yes |
| DELETE | `/marketplace/instructor/reviews/:id/reply` | InstructorReviewController.deleteReply | ApprovedInstructorGuard + JwtAuthGuard | - | yes |
| POST | `/marketplace/instructor/reviews/:id/reply` | InstructorReviewController.createReply | ApprovedInstructorGuard + JwtAuthGuard | - | yes |
| PUT | `/marketplace/instructor/reviews/:id/reply` | InstructorReviewController.updateReply | ApprovedInstructorGuard + JwtAuthGuard | - | yes |
| GET | `/marketplace/instructors/:slug` | PublicInstructorController.getProfile | public | - | yes |
| GET | `/marketplace/me/certificates` | LearnerCertificatesController.myCertificates | JwtAuthGuard | - | yes |
| GET | `/marketplace/me/certificates/:id/pdf` | LearnerCertificatesController.download | JwtAuthGuard | - | no |
| PATCH | `/marketplace/me/certificates/:id/visibility` | LearnerCertificatesController.setVisibility | JwtAuthGuard | - | no |
| GET | `/marketplace/me/enrollments` | LearnerPlayerController.listMine | JwtAuthGuard | - | yes |
| GET | `/marketplace/me/enrollments/:id/lessons/:lessonId` | LearnerPlayerController.getLessonContent | JwtAuthGuard | - | yes |
| PUT | `/marketplace/me/enrollments/:id/lessons/:lessonId/progress` | LearnerPlayerController.updateProgress | JwtAuthGuard | - | yes |
| GET | `/marketplace/me/enrollments/:id/player` | LearnerPlayerController.getPlayer | JwtAuthGuard | - | yes |
| GET | `/marketplace/me/orders` | LearnerOrdersController.list | JwtAuthGuard | - | yes |
| GET | `/marketplace/me/orders/:id` | LearnerOrdersController.get | JwtAuthGuard | - | yes |
| POST | `/marketplace/me/orders/:id/refund` | LearnerRefundController.requestRefund | JwtAuthGuard + RefundRequestThrottlerGuard | - | yes |
| GET | `/marketplace/me/orders/:id/refund-eligibility` | LearnerRefundController.checkEligibility | JwtAuthGuard | - | yes |
| GET | `/marketplace/me/reviews` | LearnerReviewController.list | JwtAuthGuard | - | no |
| POST | `/marketplace/me/reviews` | LearnerReviewController.create | JwtAuthGuard | - | yes |
| DELETE | `/marketplace/me/reviews/:id` | LearnerReviewController.remove | JwtAuthGuard | - | yes |
| GET | `/marketplace/me/reviews/:id` | LearnerReviewController.get | JwtAuthGuard | - | yes |
| PATCH | `/marketplace/me/reviews/:id` | LearnerReviewController.update | JwtAuthGuard | - | yes |
| POST | `/marketplace/reviews/:id/report` | ReviewReportController.report | JwtAuthGuard | - | yes |
| GET | `/media/public/:folder/:filename` | MediaController.serve | public | - | no |
| GET | `/notification-settings` | NotificationSettingsController.getSettings | HybridAuthGuard + RolesGuard | student | yes |
| PUT | `/notification-settings` | NotificationSettingsController.updateSettings | HybridAuthGuard + RolesGuard | student | yes |
| GET | `/notifications` | NotificationsController.getMyNotifications | HybridAuthGuard + RolesGuard | admin, call_center, student, teacher | yes |
| POST | `/notifications/:id/read` | NotificationsController.markAsRead | HybridAuthGuard + RolesGuard | admin, call_center, student, teacher | yes |
| GET | `/notifications/push/devices` | PushDevicesController.list | HybridAuthGuard | - | yes |
| POST | `/notifications/push/devices` | PushDevicesController.register | HybridAuthGuard | - | yes |
| DELETE | `/notifications/push/devices/:id` | PushDevicesController.remove | HybridAuthGuard | - | yes |
| GET | `/notifications/push/devices/public-key` | PushDevicesController.publicKey | HybridAuthGuard | - | no |
| POST | `/notifications/push/devices/unregister` | PushDevicesController.unregister | HybridAuthGuard | - | yes |
| POST | `/notifications/read-all` | NotificationsController.markAllAsRead | HybridAuthGuard + RolesGuard | admin, call_center, student, teacher | yes |
| GET | `/notifications/unread/count` | NotificationsController.getUnreadCount | HybridAuthGuard + RolesGuard | admin, call_center, student, teacher | yes |
| GET | `/packages` | PackagesController.findAll | public | - | yes |
| GET | `/packages/:id` | PackagesController.findOne | public | - | yes |
| GET | `/packages/:id/preview` | PackagesController.preview | public | - | yes |
| GET | `/packages/:id/preview/lessons/:lessonId/playback` | PackagesController.previewPlayback | public | - | no |
| GET | `/packages/:packageId/reviews/summary` | ReviewsPublicController.getPackageReviewSummary | public | - | no |
| GET | `/packages/teacher/:teacherId` | PackagesController.findByTeacher | public | - | no |
| GET | `/payments/access/:id` | PaymentsController.checkLessonAccess | HybridAuthGuard + RolesGuard | student | no |
| GET | `/payments/access/:itemType/:id` | PaymentsController.checkItemAccess | HybridAuthGuard + RolesGuard | student | no |
| POST | `/payments/checkout/quote` | OrdersController.quote | HybridAuthGuard + RolesGuard | student | no |
| GET | `/payments/easykash/return/:paymentId` | PaymentsReturnController.handleReturn | public | - | yes |
| GET | `/payments/manual/submissions` | ManualPaymentsController.mine | HybridAuthGuard + RolesGuard | student | no |
| POST | `/payments/manual/submissions` | ManualPaymentsController.submit | HybridAuthGuard + RolesGuard | student | no |
| GET | `/payments/my-lessons` | PaymentsController.getMyLessons | HybridAuthGuard + RolesGuard | student | no |
| GET | `/payments/my-packages` | PaymentsController.getMyPackages | HybridAuthGuard + RolesGuard | student | yes |
| GET | `/payments/my-purchases` | PaymentsController.getMyPurchases | HybridAuthGuard + RolesGuard | student | no |
| GET | `/payments/orders` | OrdersController.list | HybridAuthGuard + RolesGuard | student | yes |
| POST | `/payments/orders` | OrdersController.create | HybridAuthGuard + RolesGuard | student | no |
| GET | `/payments/orders/:id` | OrdersController.detail | HybridAuthGuard + RolesGuard | student | no |
| POST | `/payments/orders/:id/gateway` | OrdersController.startGateway | HybridAuthGuard + RolesGuard | student | no |
| POST | `/payments/purchase/book` | PaymentsController.purchaseBook | HybridAuthGuard + RolesGuard | student | no |
| POST | `/payments/purchase/lesson` | PaymentsController.purchaseLesson | HybridAuthGuard + RolesGuard | student | no |
| POST | `/payments/purchase/package` | PaymentsController.purchasePackage | HybridAuthGuard + RolesGuard | student | no |
| POST | `/payments/reopen/:id` | PaymentsController.reopenLesson | HybridAuthGuard + RolesGuard | student | no |
| POST | `/payments/webhook` | PaymentsWebhookController.handleWebhook | public | - | yes |
| POST | `/payments/webhook/callback` | PaymentsWebhookController.handleCallback | public | - | no |
| GET | `/ranks` | GamificationPublicController.getRanks | public | - | no |
| GET | `/reports/admin/platform` | ReportsController.getPlatformReport | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/reports/student/progress` | ReportsController.getStudentProgress | HybridAuthGuard + RolesGuard | student | yes |
| GET | `/reports/teacher/follow-up` | ReportsController.getTeacherFollowUp | HybridAuthGuard + RolesGuard | teacher | yes |
| GET | `/reports/teacher/summary` | ReportsController.getTeacherSummary | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/search` | SearchController.search | OptionalHybridAuthGuard | - | no |
| GET | `/search/in-course/:packageId` | SearchController.inCourse | OptionalHybridAuthGuard | - | no |
| GET | `/search/recent` | SearchController.recent | OptionalHybridAuthGuard | - | no |
| GET | `/search/suggestions` | SearchController.suggestions | OptionalHybridAuthGuard | - | no |
| GET | `/student/activity-log` | ActivityLogsController.getStudentActivityLog | HybridAuthGuard + RolesGuard | student | no |
| GET | `/student/attendance` | StudentAttendanceController.getMyAttendance | HybridAuthGuard + RolesGuard | student | no |
| GET | `/student/attendance/stats` | StudentAttendanceController.getMyStats | HybridAuthGuard + RolesGuard | student | no |
| GET | `/student/books` | StudentBooksController.getMyBooks | HybridAuthGuard + RolesGuard | student | no |
| GET | `/student/books/:id/access` | StudentBooksController.checkAccess | HybridAuthGuard + RolesGuard | student | no |
| GET | `/student/books/:id/download` | StudentBooksController.getDownloadUrl | HybridAuthGuard + RolesGuard | student | no |
| GET | `/student/books/:id/download/file` | StudentBooksController.downloadFile | HybridAuthGuard + RolesGuard | student | no |
| POST | `/student/books/purchase` | StudentBooksController.purchaseBook | HybridAuthGuard + RolesGuard | student | no |
| GET | `/student/certificates` | StudentCertificatesController.myCertificates | HybridAuthGuard + RolesGuard | student | yes |
| GET | `/student/certificates/:id/pdf` | StudentCertificatesController.download | HybridAuthGuard + RolesGuard | student | yes |
| PATCH | `/student/certificates/:id/visibility` | StudentCertificatesController.setVisibility | HybridAuthGuard + RolesGuard | student | yes |
| GET | `/student/certificates/course-progress` | StudentCertificatesController.courseProgressBatch | HybridAuthGuard + RolesGuard | student | no |
| GET | `/student/certificates/course-progress/:packageId` | StudentCertificatesController.courseProgress | HybridAuthGuard + RolesGuard | student | no |
| GET | `/student/complaints` | ComplaintsStudentController.getOwnComplaints | JwtAuthGuard + RolesGuard | student | no |
| POST | `/student/complaints` | ComplaintsStudentController.createComplaint | JwtAuthGuard + RolesGuard | student | yes |
| GET | `/student/complaints/:id` | ComplaintsStudentController.getOwnComplaint | JwtAuthGuard + RolesGuard | student | yes |
| POST | `/student/complaints/:id/messages` | ComplaintsStudentController.addMessage | JwtAuthGuard + RolesGuard | student | yes |
| GET | `/student/exams` | StudentExamsController.list | HybridAuthGuard + RolesGuard | student | no |
| GET | `/student/exams/:id/result` | StudentExamsController.result | HybridAuthGuard + RolesGuard | student | yes |
| POST | `/student/exams/:id/start` | StudentExamsController.start | HybridAuthGuard + RolesGuard | student | yes |
| GET | `/student/exams/attempts/:attemptId` | StudentExamsController.getAttempt | HybridAuthGuard + RolesGuard | student | no |
| PATCH | `/student/exams/attempts/:attemptId/answers` | StudentExamsController.save | HybridAuthGuard + RolesGuard | student | yes |
| POST | `/student/exams/attempts/:attemptId/submit` | StudentExamsController.submit | HybridAuthGuard + RolesGuard | student | yes |
| GET | `/student/exams/question-bank` | StudentExamsController.questionBank | HybridAuthGuard + RolesGuard | student | no |
| GET | `/student/game/profile` | StudentPracticeController.myProfile | HybridAuthGuard + RolesGuard | student | yes |
| GET | `/student/guardians` | StudentGuardiansController.list | HybridAuthGuard + RolesGuard | student | no |
| POST | `/student/guardians` | StudentGuardiansController.link | HybridAuthGuard + RolesGuard | student | no |
| DELETE | `/student/guardians/:guardianId` | StudentGuardiansController.unlink | HybridAuthGuard + RolesGuard | student | no |
| PATCH | `/student/guardians/:guardianId/phone` | StudentGuardiansController.changePhone | HybridAuthGuard + RolesGuard | student | no |
| PATCH | `/student/guardians/:guardianId/preferences` | StudentGuardiansController.updatePreferences | HybridAuthGuard + RolesGuard | student | no |
| POST | `/student/guardians/:guardianId/primary` | StudentGuardiansController.setPrimary | HybridAuthGuard + RolesGuard | student | no |
| PATCH | `/student/guardians/:guardianId/profile` | StudentGuardiansController.updateProfile | HybridAuthGuard + RolesGuard | student | no |
| POST | `/student/guardians/:guardianId/verification/confirm` | StudentGuardiansController.confirm | HybridAuthGuard + RolesGuard | student | no |
| POST | `/student/guardians/:guardianId/verification/request` | StudentGuardiansController.requestCode | HybridAuthGuard + RolesGuard | student | no |
| GET | `/student/homework` | StudentHomeworkController.list | HybridAuthGuard + RolesGuard | student | no |
| GET | `/student/homework/:homeworkId/resource` | StudentHomeworkController.resource | HybridAuthGuard + RolesGuard | student | no |
| GET | `/student/homework/:homeworkId/submission/file` | StudentHomeworkController.submissionFile | HybridAuthGuard + RolesGuard | student | no |
| POST | `/student/homework/:homeworkId/submit` | StudentHomeworkController.submit | HybridAuthGuard + RolesGuard | student | no |
| POST | `/student/homework/:homeworkId/upload` | StudentHomeworkController.upload | HybridAuthGuard + RolesGuard | student | no |
| GET | `/student/lesson-sessions` | StudentLessonSessionsController.list | HybridAuthGuard + RolesGuard | student | yes |
| POST | `/student/lesson-sessions/reservations` | StudentLessonSessionsController.reserve | HybridAuthGuard + RolesGuard | student | no |
| DELETE | `/student/lesson-sessions/reservations/:bookingId` | StudentLessonSessionsController.release | HybridAuthGuard + RolesGuard | student | no |
| GET | `/student/lessons` | StudentLessonsController.browseLessons | HybridAuthGuard + RolesGuard | student | no |
| POST | `/student/lessons/:lessonId/comments` | CommentsStudentController.createComment | JwtAuthGuard + RolesGuard | student | no |
| GET | `/student/lessons/:lessonId/progress` | StudentLessonsController.getProgress | HybridAuthGuard + RolesGuard | student | yes |
| POST | `/student/lessons/:lessonId/progress` | StudentLessonsController.updateProgress | HybridAuthGuard + RolesGuard | student | yes |
| DELETE | `/student/lessons/:lessonId/reviews` | ReviewsStudentController.deleteLessonReview | HybridAuthGuard + RolesGuard | student | no |
| PATCH | `/student/lessons/:lessonId/reviews` | ReviewsStudentController.updateLessonReview | HybridAuthGuard + RolesGuard | student | no |
| POST | `/student/lessons/:lessonId/reviews` | ReviewsStudentController.createLessonReview | HybridAuthGuard + RolesGuard | student | no |
| GET | `/student/lessons/my/progress` | StudentLessonsController.getAllProgress | HybridAuthGuard + RolesGuard | student | yes |
| POST | `/student/practice/answer` | StudentPracticeController.answer | HybridAuthGuard + RolesGuard | student | yes |
| GET | `/student/practice/next` | StudentPracticeController.next | HybridAuthGuard + RolesGuard | student | yes |
| POST | `/student/practice/session` | StudentPracticeController.startSession | HybridAuthGuard + RolesGuard | student | yes |
| POST | `/student/practice/session/:id/end` | StudentPracticeController.endSession | HybridAuthGuard + RolesGuard | student | no |
| GET | `/student/profile` | StudentProfileController.getProfile | HybridAuthGuard + RolesGuard | student | no |
| PUT | `/student/profile` | StudentProfileController.updateProfile | HybridAuthGuard + RolesGuard | student | yes |
| PUT | `/student/profile/notifications` | StudentProfileController.updateNotifications | HybridAuthGuard + RolesGuard | student | no |
| GET | `/student/profile/stats` | StudentProfileController.getStats | HybridAuthGuard + RolesGuard | student | no |
| GET | `/student/questions/question-bank` | StudentQuestionsController.listPublic | HybridAuthGuard + RolesGuard | student | no |
| POST | `/student/reviews/:type/:reviewId/helpful` | ReviewsStudentController.toggleHelpful | HybridAuthGuard + RolesGuard | student | no |
| DELETE | `/student/teachers/:teacherId/reviews` | ReviewsStudentController.deleteTeacherReview | HybridAuthGuard + RolesGuard | student | no |
| PATCH | `/student/teachers/:teacherId/reviews` | ReviewsStudentController.updateTeacherReview | HybridAuthGuard + RolesGuard | student | no |
| POST | `/student/teachers/:teacherId/reviews` | ReviewsStudentController.createTeacherReview | HybridAuthGuard + RolesGuard | student | no |
| GET | `/students` | StudentsController.findAll | public | - | yes |
| GET | `/students/:id` | StudentsController.findOne | public | - | no |
| GET | `/subjects` | SubjectsController.findAll | public | - | yes |
| GET | `/subjects/:id` | SubjectsController.findOne | public | - | yes |
| GET | `/subjects/:id/teachers` | SubjectsController.findTeachersBySubject | public | - | no |
| GET | `/teacher/activity-log` | ActivityLogsController.getTeacherActivityLog | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/books` | TeacherBooksController.findMyBooks | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/books` | TeacherBooksController.create | HybridAuthGuard + RolesGuard | teacher | no |
| DELETE | `/teacher/books/:id` | TeacherBooksController.delete | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/books/:id` | TeacherBooksController.findOne | HybridAuthGuard + RolesGuard | teacher | no |
| PUT | `/teacher/books/:id` | TeacherBooksController.update | HybridAuthGuard + RolesGuard | teacher | yes |
| GET | `/teacher/books/revenue` | TeacherBooksController.getRevenue | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/certificates/analytics` | TeacherCertificatesController.analytics | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/certificates/issue` | TeacherCertificatesController.issue | HybridAuthGuard + RolesGuard | teacher | yes |
| GET | `/teacher/certificates/issued` | TeacherCertificatesController.list | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/certificates/issued/:id/pdf` | TeacherCertificatesController.issuedPdf | HybridAuthGuard + RolesGuard | teacher | yes |
| POST | `/teacher/certificates/issued/:id/reissue` | TeacherCertificatesController.reissue | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/certificates/issued/:id/revoke` | TeacherCertificatesController.revoke | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/certificates/preview/:packageId/pdf` | TeacherCertificatesController.preview | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/certificates/templates` | TeacherCertificatesController.templates | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/certificates/templates` | TeacherCertificatesController.createTemplate | HybridAuthGuard + RolesGuard | teacher | yes |
| DELETE | `/teacher/certificates/templates/:id` | TeacherCertificatesController.deleteTemplate | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/certificates/templates/:id` | TeacherCertificatesController.template | HybridAuthGuard + RolesGuard | teacher | yes |
| PATCH | `/teacher/certificates/templates/:id` | TeacherCertificatesController.updateTemplate | HybridAuthGuard + RolesGuard | teacher | yes |
| POST | `/teacher/certificates/templates/:id/archive` | TeacherCertificatesController.archiveTemplate | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/certificates/templates/:id/duplicate` | TeacherCertificatesController.duplicateTemplate | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/certificates/templates/:id/publish` | TeacherCertificatesController.publishTemplate | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/certificates/templates/:id/unpublish` | TeacherCertificatesController.unpublishTemplate | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/certificates/templates/available` | TeacherCertificatesController.availableTemplates | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/certificates/templates/preview/pdf` | TeacherCertificatesController.previewTemplate | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/comments/:commentId/reply` | CommentsTeacherController.addReply | JwtAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/complaints` | ComplaintsTeacherController.getOwnComplaints | JwtAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/complaints` | ComplaintsTeacherController.createComplaint | JwtAuthGuard + RolesGuard | teacher | yes |
| GET | `/teacher/complaints/:id` | ComplaintsTeacherController.getOwnComplaint | JwtAuthGuard + RolesGuard | teacher | yes |
| POST | `/teacher/complaints/:id/messages` | ComplaintsTeacherController.addMessage | JwtAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/exams` | TeacherExamsController.list | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/exams` | TeacherExamsController.create | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/exams/:examId/omr-sheets` | TeacherOmrController.list | HybridAuthGuard + RolesGuard | teacher | yes |
| POST | `/teacher/exams/:examId/omr-sheets` | TeacherOmrController.scan | HybridAuthGuard + RolesGuard | teacher | yes |
| GET | `/teacher/exams/:examId/omr-sheets/:sheetId` | TeacherOmrController.getOne | HybridAuthGuard + RolesGuard | teacher | yes |
| PATCH | `/teacher/exams/:examId/omr-sheets/:sheetId/answers/:examQuestionId` | TeacherOmrController.patchAnswer | HybridAuthGuard + RolesGuard | teacher | yes |
| POST | `/teacher/exams/:examId/omr-sheets/:sheetId/confirm` | TeacherOmrController.confirm | HybridAuthGuard + RolesGuard | teacher | yes |
| GET | `/teacher/exams/:examId/omr-sheets/:sheetId/image` | TeacherOmrController.image | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/exams/:examId/omr-sheets/:sheetId/pdf` | TeacherOmrController.pdf | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/exams/:examId/omr-sheets/:sheetId/reprocess` | TeacherOmrController.reprocess | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/exams/:examId/omr-sheets/:sheetId/review` | TeacherOmrController.review | HybridAuthGuard + RolesGuard | teacher | yes |
| POST | `/teacher/exams/:examId/omr-sheets/generate` | TeacherOmrController.generate | HybridAuthGuard + RolesGuard | teacher | yes |
| DELETE | `/teacher/exams/:id` | TeacherExamsController.remove | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/exams/:id` | TeacherExamsController.getOne | HybridAuthGuard + RolesGuard | teacher | no |
| PUT | `/teacher/exams/:id` | TeacherExamsController.update | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/exams/:id/answers/:answerId/grade` | TeacherGradingController.grade | HybridAuthGuard + RolesGuard | teacher | yes |
| POST | `/teacher/exams/:id/archive` | TeacherExamsController.archive | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/exams/:id/attempts/:attemptId` | TeacherGradingController.attempt | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/exams/:id/publish` | TeacherExamsController.publish | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/exams/:id/questions` | TeacherExamsController.attach | HybridAuthGuard + RolesGuard | teacher | no |
| DELETE | `/teacher/exams/:id/questions/:examQuestionId` | TeacherExamsController.detach | HybridAuthGuard + RolesGuard | teacher | no |
| PATCH | `/teacher/exams/:id/questions/reorder` | TeacherExamsController.reorderQuestions | HybridAuthGuard + RolesGuard | teacher | yes |
| PATCH | `/teacher/exams/:id/schedule` | TeacherExamsController.reschedule | HybridAuthGuard + RolesGuard | teacher | yes |
| POST | `/teacher/exams/:id/sections` | TeacherExamsController.addSection | HybridAuthGuard + RolesGuard | teacher | no |
| DELETE | `/teacher/exams/:id/sections/:sectionId` | TeacherExamsController.removeSection | HybridAuthGuard + RolesGuard | teacher | no |
| PATCH | `/teacher/exams/:id/sections/reorder` | TeacherExamsController.reorderSections | HybridAuthGuard + RolesGuard | teacher | yes |
| GET | `/teacher/exams/:id/submissions` | TeacherGradingController.submissions | HybridAuthGuard + RolesGuard | teacher | yes |
| POST | `/teacher/exams/:id/unarchive` | TeacherExamsController.unarchive | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/finance/orders` | TeacherFinanceController.ordersList | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/finance/orders/:id` | TeacherFinanceController.orderDetails | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/finance/refunds` | TeacherFinanceController.refundList | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/finance/settlements` | TeacherFinanceController.settlementList | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/finance/settlements/:id` | TeacherFinanceController.settlementDetails | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/finance/settlements/request` | TeacherFinanceController.requestSettlement | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/finance/wallet` | TeacherFinanceController.wallet | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/gamification/campaigns` | TeacherGamificationController.list | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/gamification/campaigns` | TeacherGamificationController.create | HybridAuthGuard + RolesGuard | teacher | no |
| PATCH | `/teacher/gamification/campaigns/:id` | TeacherGamificationController.update | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/homework` | TeacherHomeworkController.list | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/homework/:homeworkId` | TeacherHomeworkController.detail | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/homework/:homeworkId/resource` | TeacherHomeworkController.homeworkResource | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/homework/:homeworkId/submissions` | TeacherHomeworkController.submissions | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/homework/:homeworkId/submissions/:submissionId` | TeacherHomeworkController.submissionDetail | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/homework/:homeworkId/submissions/:submissionId/file` | TeacherHomeworkController.submissionFile | HybridAuthGuard + RolesGuard | teacher | no |
| PATCH | `/teacher/homework/:homeworkId/submissions/:submissionId/grade` | TeacherHomeworkController.grade | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/homework/analytics` | TeacherHomeworkController.analytics | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/homework/dashboard` | TeacherHomeworkController.dashboard | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/lessons` | TeacherLessonsController.findMyLessons | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/lessons` | TeacherLessonsController.create | HybridAuthGuard + RolesGuard | teacher | yes |
| DELETE | `/teacher/lessons/:id` | TeacherLessonsController.delete | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/lessons/:id` | TeacherLessonsController.findOne | HybridAuthGuard + RolesGuard | teacher | yes |
| PUT | `/teacher/lessons/:id` | TeacherLessonsController.update | HybridAuthGuard + RolesGuard | teacher | yes |
| POST | `/teacher/lessons/:id/publish` | TeacherLessonsController.publish | HybridAuthGuard + RolesGuard | teacher | no |
| DELETE | `/teacher/lessons/:id/video` | TeacherLessonsController.deleteVideo | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/lessons/:id/video/aws/complete` | TeacherLessonsController.completeAwsVideoUpload | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/lessons/:id/video/aws/upload` | TeacherLessonsController.startAwsVideoUpload | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/lessons/:id/video/status` | TeacherLessonsController.getVideoStatus | HybridAuthGuard + RolesGuard | teacher | no |
| PUT | `/teacher/lessons/:id/visibility` | TeacherLessonsController.setVisibility | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/lessons/:lessonId/attachments` | TeacherLessonContentController.listAttachments | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/lessons/:lessonId/attachments` | TeacherLessonContentController.addAttachment | HybridAuthGuard + RolesGuard | teacher | no |
| DELETE | `/teacher/lessons/:lessonId/attachments/:attachmentId` | TeacherLessonContentController.deleteAttachment | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/lessons/:lessonId/attendance` | TeacherAttendanceController.getLessonAttendance | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/lessons/:lessonId/attendance` | TeacherAttendanceController.markAttendance | HybridAuthGuard + RolesGuard | teacher | no |
| DELETE | `/teacher/lessons/:lessonId/attendance/:id` | TeacherAttendanceController.deleteAttendance | HybridAuthGuard + RolesGuard | teacher | no |
| PATCH | `/teacher/lessons/:lessonId/attendance/:id` | TeacherAttendanceController.updateAttendance | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/lessons/:lessonId/attendance/stats` | TeacherAttendanceController.getLessonStats | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/lessons/:lessonId/homework` | TeacherLessonContentController.listHomework | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/lessons/:lessonId/homework` | TeacherLessonContentController.addHomework | HybridAuthGuard + RolesGuard | teacher | no |
| DELETE | `/teacher/lessons/:lessonId/homework/:homeworkId` | TeacherLessonContentController.deleteHomework | HybridAuthGuard + RolesGuard | teacher | no |
| PATCH | `/teacher/lessons/:lessonId/homework/:homeworkId` | TeacherLessonContentController.updateHomework | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/lessons/:lessonId/homework/:homeworkId/publish` | TeacherLessonContentController.publishHomework | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/lessons/:lessonId/homework/:homeworkId/resource` | TeacherLessonContentController.homeworkResource | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/lessons/:lessonId/homework/:homeworkId/submissions` | TeacherLessonContentController.listHomeworkSubmissions | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/lessons/:lessonId/homework/:homeworkId/submissions/:submissionId/file` | TeacherLessonContentController.submissionFile | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/lessons/:lessonId/homework/:homeworkId/submissions/:submissionId/grade` | TeacherLessonContentController.gradeHomework | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/lessons/:lessonId/sessions` | TeacherLessonSessionsController.list | HybridAuthGuard + RolesGuard | teacher | yes |
| POST | `/teacher/lessons/:lessonId/sessions` | TeacherLessonSessionsController.create | HybridAuthGuard + RolesGuard | teacher | no |
| PATCH | `/teacher/lessons/:lessonId/sessions/:sessionId` | TeacherLessonSessionsController.update | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/lessons/:lessonId/sessions/:sessionId/attendance` | TeacherAttendanceController.markScheduledSessionAttendance | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/lessons/:lessonId/sessions/:sessionId/cancel` | TeacherLessonSessionsController.cancel | HybridAuthGuard + RolesGuard | teacher | no |
| DELETE | `/teacher/lessons/:lessonId/sessions/:sessionId/meeting` | TeacherLessonSessionsController.clearMeeting | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/lessons/:lessonId/sessions/:sessionId/meeting` | TeacherLessonSessionsController.generateMeeting | HybridAuthGuard + RolesGuard | teacher | yes |
| GET | `/teacher/lessons/video/aws/capabilities` | TeacherLessonsController.awsVideoCapabilities | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/meeting-accounts` | TeacherMeetingAccountsController.list | HybridAuthGuard + RolesGuard | teacher | no |
| DELETE | `/teacher/meeting-accounts/:provider` | TeacherMeetingAccountsController.disconnect | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/meeting-accounts/:provider/connect` | TeacherMeetingAccountsController.connect | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/meeting-accounts/callback` | TeacherMeetingAccountsController.callback | public | - | no |
| GET | `/teacher/meeting-providers` | TeacherMeetingProvidersController.list | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/packages` | TeacherPackagesController.findMyPackages | HybridAuthGuard + RolesGuard | teacher | yes |
| POST | `/teacher/packages` | TeacherPackagesController.create | HybridAuthGuard + RolesGuard | teacher | no |
| DELETE | `/teacher/packages/:id` | TeacherPackagesController.delete | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/packages/:id` | TeacherPackagesController.findOne | HybridAuthGuard + RolesGuard | teacher | no |
| PUT | `/teacher/packages/:id` | TeacherPackagesController.update | HybridAuthGuard + RolesGuard | teacher | no |
| PATCH | `/teacher/packages/:id/active` | TeacherPackagesController.toggleActive | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/packages/:id/chapters` | TeacherPackagesController.listChapters | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/packages/:id/chapters` | TeacherPackagesController.createChapter | HybridAuthGuard + RolesGuard | teacher | no |
| DELETE | `/teacher/packages/:id/chapters/:chapterId` | TeacherPackagesController.deleteChapter | HybridAuthGuard + RolesGuard | teacher | no |
| PATCH | `/teacher/packages/:id/chapters/:chapterId` | TeacherPackagesController.updateChapter | HybridAuthGuard + RolesGuard | teacher | no |
| PATCH | `/teacher/packages/:id/curriculum` | TeacherPackagesController.reorderCurriculum | HybridAuthGuard + RolesGuard | teacher | no |
| DELETE | `/teacher/packages/:id/lessons` | TeacherPackagesController.removeLessons | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/packages/:id/lessons` | TeacherPackagesController.addLessons | HybridAuthGuard + RolesGuard | teacher | no |
| PATCH | `/teacher/packages/:id/status` | TeacherPackagesController.updateStatus | HybridAuthGuard + RolesGuard | teacher | yes |
| POST | `/teacher/parent-broadcast/preview` | TeacherBroadcastController.preview | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/parent-broadcast/send` | TeacherBroadcastController.send | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/parent-messages` | TeacherParentMessagesController.list | HybridAuthGuard + RolesGuard | teacher | yes |
| POST | `/teacher/parent-messages/:id/retry` | TeacherParentMessagesController.retry | HybridAuthGuard + RolesGuard | teacher | yes |
| GET | `/teacher/parent-messages/stats` | TeacherParentMessagesController.stats | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/profile` | TeacherProfileController.getProfile | HybridAuthGuard + RolesGuard | teacher | yes |
| PUT | `/teacher/profile` | TeacherProfileController.updateProfile | HybridAuthGuard + RolesGuard | teacher | yes |
| GET | `/teacher/profile/stats` | TeacherProfileController.getStats | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/questions` | TeacherQuestionsController.list | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/questions` | TeacherQuestionsController.create | HybridAuthGuard + RolesGuard | teacher | no |
| DELETE | `/teacher/questions/:id` | TeacherQuestionsController.remove | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/questions/:id` | TeacherQuestionsController.findOne | HybridAuthGuard + RolesGuard | teacher | no |
| PUT | `/teacher/questions/:id` | TeacherQuestionsController.update | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/questions/:id/versions` | TeacherQuestionsController.versions | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/revenue` | TeacherPaymentsController.getRevenue | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/revenue/lessons` | TeacherPaymentsController.getRevenueByLesson | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/revenue/packages` | TeacherPaymentsController.getRevenueByPackage | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/reviews` | ReviewsTeacherController.myLessonReviews | JwtAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/reviews/:reviewId/reply` | ReviewsTeacherController.reply | JwtAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/reviews/profile/:reviewId/reply` | ReviewsTeacherController.replyToProfileReview | JwtAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/students` | TeacherStudentsController.list | HybridAuthGuard + RolesGuard | teacher | yes |
| GET | `/teacher/students/:studentId` | TeacherStudentsController.detail | HybridAuthGuard + RolesGuard | teacher | yes |
| GET | `/teacher/students/:studentId/guardians` | TeacherGuardiansController.list | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/students/:studentId/guardians/:guardianId/resend-otp` | TeacherGuardiansController.resendOtp | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/students/:studentId/message` | TeacherStudentsController.sendMessage | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/students/:studentId/timeline` | TeacherStudentsController.timelineFor | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/subjects` | TeacherSubjectsController.findMine | HybridAuthGuard + RolesGuard | teacher | yes |
| POST | `/teacher/subjects` | TeacherSubjectsController.create | HybridAuthGuard + RolesGuard | teacher | yes |
| DELETE | `/teacher/subjects/:id` | TeacherSubjectsController.remove | HybridAuthGuard + RolesGuard | teacher | yes |
| GET | `/teacher/subjects/:id` | TeacherSubjectsController.findOne | HybridAuthGuard + RolesGuard | teacher | yes |
| PUT | `/teacher/subjects/:id` | TeacherSubjectsController.update | HybridAuthGuard + RolesGuard | teacher | yes |
| GET | `/teacher/subjects/selectable` | TeacherSubjectsController.findSelectable | HybridAuthGuard + RolesGuard | teacher | yes |
| POST | `/teacher/uploads/book-file` | TeacherUploadsController.uploadBookFile | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/uploads/direct/:id/abort` | DirectUploadsController.abort | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/uploads/direct/:id/complete` | DirectUploadsController.complete | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/uploads/direct/:id/parts` | DirectUploadsController.listParts | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/uploads/direct/:id/parts` | DirectUploadsController.partUrls | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/uploads/direct/capabilities` | DirectUploadsController.capabilities | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/uploads/direct/init` | DirectUploadsController.init | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/uploads/file` | TeacherUploadsController.uploadFile | HybridAuthGuard + RolesGuard | teacher | no |
| POST | `/teacher/uploads/image` | TeacherUploadsController.uploadImage | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teacher/wishlist/analytics/top` | TeacherWishlistController.top | HybridAuthGuard + RolesGuard | teacher | no |
| GET | `/teachers` | TeachersController.findAll | public | - | yes |
| GET | `/teachers/:id` | TeachersController.findOne | public | - | yes |
| GET | `/teachers/:teacherId/reviews` | ReviewsPublicController.getTeacherReviews | public | - | no |
| GET | `/teachers/by-subject/:subjectId` | TeachersController.findBySubject | public | - | no |
| GET | `/u/:username` | GamificationPublicController.getProfile | public | - | yes |
| GET | `/uploads/:folder/:filename` | UploadsController.serveUploadedFile | public | - | yes |
| GET | `/uploads/admin/files` | UploadsController.getAdminUserFiles | HybridAuthGuard + RolesGuard | admin | no |
| DELETE | `/uploads/files/:fileId` | UploadsController.deleteFile | HybridAuthGuard | - | no |
| GET | `/uploads/files/:fileId/usage` | UploadsController.getFileUsage | HybridAuthGuard | - | yes |
| GET | `/uploads/teacher/files` | UploadsController.getTeacherFiles | HybridAuthGuard + RolesGuard | teacher | yes |
| GET | `/users` | UsersController.findAll | HybridAuthGuard + RolesGuard | admin | no |
| DELETE | `/users/:id` | UsersController.remove | HybridAuthGuard + RolesGuard | admin | no |
| GET | `/users/:id` | UsersController.findOne | HybridAuthGuard + RolesGuard | admin | yes |
| PUT | `/users/:id` | UsersController.update | HybridAuthGuard + RolesGuard | admin | yes |
| PATCH | `/users/:id/call-center-role` | UsersController.assignCallCenterRole | HybridAuthGuard + RolesGuard | admin | yes |
| GET | `/users/call-center` | UsersController.findCallCenterEmployees | HybridAuthGuard + RolesGuard | admin | no |
| POST | `/users/call-center` | UsersController.createCallCenterEmployee | HybridAuthGuard + RolesGuard | admin | yes |
| DELETE | `/users/me` | UsersController.deleteOwnAccount | HybridAuthGuard | - | no |
| GET | `/users/me` | UsersController.getProfile | HybridAuthGuard | - | yes |
| PUT | `/users/me` | UsersController.updateProfile | HybridAuthGuard | - | yes |
| DELETE | `/users/me/profile-picture` | UsersController.deleteProfilePicture | HybridAuthGuard | - | no |
| POST | `/users/me/profile-picture` | UsersController.uploadProfilePicture | HybridAuthGuard | - | no |
| GET | `/users/me/sessions` | UsersController.getUserSessions | HybridAuthGuard | - | yes |
| DELETE | `/users/me/sessions/:sessionId` | UsersController.deleteSession | HybridAuthGuard | - | yes |
| GET | `/webhooks/whatsapp` | WhatsAppWebhookController.verify | public | - | no |
| POST | `/webhooks/whatsapp` | WhatsAppWebhookController.receive | public | - | no |
| GET | `/wishlist` | WishlistController.list | HybridAuthGuard + RolesGuard | student | no |
| GET | `/wishlist/count` | WishlistController.count | HybridAuthGuard + RolesGuard | student | no |
| POST | `/wishlist/items` | WishlistController.add | HybridAuthGuard + RolesGuard | student | no |
| DELETE | `/wishlist/items/:itemId` | WishlistController.remove | HybridAuthGuard + RolesGuard | student | no |
| POST | `/wishlist/items/:itemId/move-to-cart` | WishlistController.moveToCart | HybridAuthGuard + RolesGuard | student | no |
| GET | `/wishlist/refs` | WishlistController.refs | HybridAuthGuard + RolesGuard | student | no |
| POST | `/wishlist/toggle` | WishlistController.toggle | HybridAuthGuard + RolesGuard | student | no |
| GET | `/metrics` | MetricsController.getMetrics | MetricsBearerGuard | - | no |
