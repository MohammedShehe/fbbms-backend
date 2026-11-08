// Currencies offered when a business is registered / edited. `code` is what is stored on the business.
const CURRENCIES = [
  { code: 'TZS', label: 'TZS – Tanzanian Shilling', symbol: 'TSh' },
  { code: 'MYR', label: 'MYR (RM) – Malaysian Ringgit', symbol: 'RM' },
  { code: 'USD', label: 'USD – US Dollar', symbol: '$' },
  { code: 'EUR', label: 'EUR – Euro', symbol: '€' },
  { code: 'GBP', label: 'GBP – British Pound', symbol: '£' },
  { code: 'KES', label: 'KES – Kenyan Shilling', symbol: 'KSh' },
  { code: 'UGX', label: 'UGX – Ugandan Shilling', symbol: 'USh' },
  { code: 'RWF', label: 'RWF – Rwandan Franc', symbol: 'FRw' },
  { code: 'ZAR', label: 'ZAR – South African Rand', symbol: 'R' },
  { code: 'NGN', label: 'NGN – Nigerian Naira', symbol: '₦' },
  { code: 'GHS', label: 'GHS – Ghanaian Cedi', symbol: 'GH₵' },
  { code: 'AED', label: 'AED – UAE Dirham', symbol: 'AED' },
  { code: 'SAR', label: 'SAR – Saudi Riyal', symbol: 'SAR' },
  { code: 'INR', label: 'INR – Indian Rupee', symbol: '₹' },
  { code: 'SGD', label: 'SGD – Singapore Dollar', symbol: 'S$' },
  { code: 'IDR', label: 'IDR – Indonesian Rupiah', symbol: 'Rp' },
  { code: 'BND', label: 'BND – Brunei Dollar', symbol: 'B$' },
  { code: 'THB', label: 'THB – Thai Baht', symbol: '฿' },
  { code: 'CNY', label: 'CNY – Chinese Yuan', symbol: '¥' },
  { code: 'JPY', label: 'JPY – Japanese Yen', symbol: '¥' },
  { code: 'AUD', label: 'AUD – Australian Dollar', symbol: 'A$' },
  { code: 'CAD', label: 'CAD – Canadian Dollar', symbol: 'C$' }
];
const CODES = CURRENCIES.map(c => c.code);
// Accepts any of our codes (case-insensitive) and the common alias "RM" for ringgit. Returns null when unknown.
function normalize(input) {
  const c = String(input || '').trim().toUpperCase();
  if (c === 'RM') return 'MYR';
  return CODES.includes(c) ? c : null;
}
module.exports = { CURRENCIES, CODES, normalize };
