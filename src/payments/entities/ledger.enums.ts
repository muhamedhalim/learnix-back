export enum LedgerDirection {
  DEBIT = 'debit',
  CREDIT = 'credit',
}

export enum LedgerEntryStatus {
  POSTED = 'posted',
  PENDING = 'pending',
  SETTLED = 'settled',
  REVERSED = 'reversed',
}

export enum LedgerEntryType {
  STUDENT_PAYMENT = 'student_payment',
  ACTIVATION_CODE_SALE = 'activation_code_sale',
  PLATFORM_COLLECTED_SALE = 'platform_collected_sale',
  TEACHER_COLLECTED_SALE = 'teacher_collected_sale',
  PLATFORM_COMMISSION = 'platform_commission',
  TEACHER_EARNING_PENDING = 'teacher_earning_pending',
  TEACHER_EARNING_AVAILABLE = 'teacher_earning_available',
  REFUND = 'refund',
  COMMISSION_REVERSAL = 'commission_reversal',
  TEACHER_EARNING_REVERSAL = 'teacher_earning_reversal',
  PAYOUT = 'payout',
  PAYOUT_REVERSAL = 'payout_reversal',
  PLATFORM_RECEIVABLE = 'platform_receivable',
  RECEIVABLE_SETTLEMENT = 'receivable_settlement',
  SETTLEMENT_LIABILITY_CLEARING = 'settlement_liability_clearing',
  SETTLEMENT_DEDUCTION = 'settlement_deduction',
  SETTLEMENT_OFFSET_CLEARING = 'settlement_offset_clearing',
  MANUAL_ADJUSTMENT = 'manual_adjustment',
}
