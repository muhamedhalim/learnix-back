const BASE_GATEWAY_ORDER_MINUTES = 60;
const VOUCHER_GRACE_MINUTES = 15;
const DEFAULT_CASH_EXPIRY_HOURS = 24;

/**
 * How long a hosted-gateway order stays payable. Card/wallet payments finish
 * within minutes, but a Fawry/Aman voucher is paid hours later, so the order
 * must outlive the voucher (plus a grace margin for the callback to arrive).
 * Without EasyKash configured the historical 60 minutes applies.
 */
export function gatewayOrderExpirationMinutes(env: NodeJS.ProcessEnv = process.env): number {
  if ((env['EASYKASH_API_KEY'] ?? '').trim() === '') return BASE_GATEWAY_ORDER_MINUTES;
  const hours = Number(env['EASYKASH_CASH_EXPIRY_HOURS']);
  const cashHours =
    Number.isInteger(hours) && hours >= 1 && hours <= 72 ? hours : DEFAULT_CASH_EXPIRY_HOURS;
  return Math.max(BASE_GATEWAY_ORDER_MINUTES, cashHours * 60 + VOUCHER_GRACE_MINUTES);
}
