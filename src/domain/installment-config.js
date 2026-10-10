import { toLatinDigits } from './format.js';

export const DEFAULT_INSTALLMENT = {
  interestPercentMonthly: 5,
  monthOptions: [2, 3, 4, 5, 6, 7, 8],
  percentOptions: [30, 40, 50, 60, 70, 80, 90],
  roundToman: 50_000,
  salesEnabled: true,
  defaultPercent: 30,
  requestExpireMinutes: 30
};

/** @deprecated use getInstallmentConfig — defaults for tests */
export const MONTH_OPTIONS = DEFAULT_INSTALLMENT.monthOptions;
export const PERCENT_OPTIONS = DEFAULT_INSTALLMENT.percentOptions;

export function parseNumberList(raw, { min = -Infinity, max = Infinity, integers = true } = {}) {
  const tokens = String(raw ?? '')
    .split(/[\s,،;]+/)
    .map((part) => Number(toLatinDigits(part.trim())))
    .filter((value) => Number.isFinite(value));
  const out = [];
  for (const value of tokens) {
    const n = integers ? Math.round(value) : value;
    if (n < min || n > max) continue;
    if (!out.includes(n)) out.push(n);
  }
  return out.sort((a, b) => a - b);
}

export function buildInstallmentConfig(values = {}) {
  const monthOptions = parseNumberList(values.monthOptions, { min: 1, max: 120, integers: true });
  const percentOptions = parseNumberList(values.percentOptions, { min: 1, max: 99, integers: true });
  const interest = Number(values.interest);
  const roundToman = Number(values.roundToman);
  const defaultPercent = Number(values.defaultPercent);
  const requestExpireMinutes = Number(values.requestExpireMinutes);
  const enabledRaw = String(values.salesEnabled ?? 'true').trim().toLowerCase();
  return {
    interestPercentMonthly: Number.isFinite(interest) && interest >= 0 && interest <= 100
      ? interest
      : DEFAULT_INSTALLMENT.interestPercentMonthly,
    monthOptions: monthOptions.length ? monthOptions : [...DEFAULT_INSTALLMENT.monthOptions],
    percentOptions: percentOptions.length ? percentOptions : [...DEFAULT_INSTALLMENT.percentOptions],
    roundToman: Number.isFinite(roundToman) && roundToman > 0 ? Math.round(roundToman) : DEFAULT_INSTALLMENT.roundToman,
    salesEnabled: !['0', 'false', 'off', 'no', 'disabled'].includes(enabledRaw),
    defaultPercent: Number.isFinite(defaultPercent) && defaultPercent > 0 && defaultPercent < 100
      ? Math.round(defaultPercent)
      : DEFAULT_INSTALLMENT.defaultPercent,
    requestExpireMinutes: Number.isFinite(requestExpireMinutes) && requestExpireMinutes >= 5 && requestExpireMinutes <= 24 * 60
      ? Math.round(requestExpireMinutes)
      : DEFAULT_INSTALLMENT.requestExpireMinutes
  };
}

export function installmentChoiceValid(months, percent, config) {
  const cfg = config || DEFAULT_INSTALLMENT;
  return cfg.monthOptions.includes(Number(months)) && cfg.percentOptions.includes(Number(percent));
}

export function formatInstallmentConfigSummary(config) {
  const c = config || DEFAULT_INSTALLMENT;
  return [
    `سود ماهانه: ${c.interestPercentMonthly}%`,
    `مدت‌های مجاز (ماه): ${c.monthOptions.join('، ')}`,
    `درصدهای پیش‌پرداخت: ${c.percentOptions.join('، ')}٪`,
    `گرد کردن قسط: ${c.roundToman.toLocaleString('en-US')} تومان`,
    `پیش‌پرداخت پیش‌فرض (لینک بدون درصد): ${c.defaultPercent}٪`,
    `انقضای درخواست خرید: ${c.requestExpireMinutes} دقیقه`,
    `فروش اقساطی: ${c.salesEnabled ? 'فعال' : 'غیرفعال'}`
  ].join('\n');
}
