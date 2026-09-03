/** FR-142, FR-144. Seven states with a closed transition table (data-model.md §6). */
export enum InstructorEarningStatus {
  PENDING_EARNINGS = 'pending_earnings',
  REFUND_CLEARANCE = 'refund_clearance',
  AVAILABLE_BALANCE = 'available_balance',
  PAYOUT_REQUESTED = 'payout_requested',
  PROCESSING = 'processing',
  PAID_OUT = 'paid_out',
  REVERSED = 'reversed',
}
