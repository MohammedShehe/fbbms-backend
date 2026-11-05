// Billing tables + columns. Idempotent: runs from `npm run migrate` AND automatically when the server starts,
// so the update works even if the migration step is forgotten.
const TABLES = [
`CREATE TABLE IF NOT EXISTS billing_payments (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  business_id INT NOT NULL,
  plan VARCHAR(16) NOT NULL,
  amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  currency VARCHAR(8) NOT NULL DEFAULT 'TZS',
  days INT NOT NULL DEFAULT 0,
  method ENUM('mobile','manual','grant') NOT NULL DEFAULT 'mobile',
  status ENUM('pending','completed','failed','expired','voided') NOT NULL DEFAULT 'pending',
  provider VARCHAR(20) NULL,
  provider_ref VARCHAR(80) NULL,
  idem_key VARCHAR(40) NULL,
  phone VARCHAR(20) NULL,
  payer_user_id INT NULL,
  recorded_by INT NULL,
  autopay TINYINT(1) NOT NULL DEFAULT 0,
  applied TINYINT(1) NOT NULL DEFAULT 0,
  period_start DATETIME NULL,
  period_end DATETIME NULL,
  failure_reason VARCHAR(255) NULL,
  note VARCHAR(255) NULL,
  fees DECIMAL(14,2) NULL,
  expires_at DATETIME NULL,
  paid_at DATETIME NULL,
  last_checked DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_bp_biz (business_id, created_at),
  KEY idx_bp_ref (provider_ref),
  KEY idx_bp_status (status, created_at),
  CONSTRAINT fk_bp_biz FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
) ENGINE=InnoDB`
];
const COLS = [
  ['businesses', 'trial_ends_at', 'DATETIME NULL'],
  ['businesses', 'paid_until', 'DATETIME NULL'],
  ['businesses', 'billing_plan', 'VARCHAR(16) NULL'],
  ['businesses', 'billing_exempt', 'TINYINT(1) NOT NULL DEFAULT 0'],
  ['businesses', 'lifetime', 'TINYINT(1) NOT NULL DEFAULT 0'],
  ['businesses', 'autopay_enabled', 'TINYINT(1) NOT NULL DEFAULT 0'],
  ['businesses', 'autopay_plan', 'VARCHAR(16) NULL'],
  ['businesses', 'autopay_phone', 'VARCHAR(20) NULL'],
  ['businesses', 'autopay_by', 'INT NULL'],
  ['businesses', 'autopay_attempts', 'INT NOT NULL DEFAULT 0'],
  ['businesses', 'autopay_last_attempt', 'DATETIME NULL']
];

/** run(sql, params) must return a promise; rows(sql, params) must resolve to an array of rows. */
async function ensure(run, rows, trialDays = 30) {
  for (const t of TABLES) await run(t);
  for (const [table, col, ddl] of COLS) {
    const r = await rows('SELECT 1 AS x FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=?', [table, col]);
    if (!r.length) await run(`ALTER TABLE \`${table}\` ADD COLUMN \`${col}\` ${ddl}`);
  }
  // Businesses that existed before billing get a fresh free trial starting now.
  await run('UPDATE businesses SET trial_ends_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL ? DAY) WHERE trial_ends_at IS NULL', [trialDays]);
}
module.exports = { ensure };
