// Tables for the Barber Shop and Car Rental modules. Idempotent: runs from `npm run migrate` AND automatically when the
// server starts, so the update works even if the migration step is forgotten. Everything hangs off the same central
// `sales`, `customers`, `expenses`, `products` tables, so there is one database and one set of financial reports.
const TABLES = [
`CREATE TABLE IF NOT EXISTS barbers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_id INT NOT NULL,
  name VARCHAR(120) NOT NULL,
  phone VARCHAR(30) NULL,
  commission_pct DECIMAL(5,2) NOT NULL DEFAULT 0,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  notes VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_barber (business_id, status),
  CONSTRAINT fk_barber_biz FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS barber_services (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_id INT NOT NULL,
  name VARCHAR(120) NOT NULL,
  price DECIMAL(14,2) NOT NULL DEFAULT 0,
  duration_min INT NOT NULL DEFAULT 30,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_bsvc (business_id, name),
  CONSTRAINT fk_bsvc_biz FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS appointments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_id INT NOT NULL,
  customer_id INT NULL,
  customer_name VARCHAR(120) NOT NULL,
  customer_phone VARCHAR(30) NULL,
  service_id INT NULL,
  service_name VARCHAR(120) NOT NULL,
  barber_id INT NULL,
  kind ENUM('appointment','walkin') NOT NULL DEFAULT 'walkin',
  appt_date DATE NOT NULL,
  appt_time TIME NULL,
  queue_no INT NULL,
  status ENUM('booked','waiting','in_service','completed','cancelled','missed') NOT NULL DEFAULT 'waiting',
  price DECIMAL(14,2) NOT NULL DEFAULT 0,
  duration_min INT NOT NULL DEFAULT 30,
  notes VARCHAR(255) NULL,
  sale_id INT NULL,
  created_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_appt_day (business_id, appt_date, status),
  KEY idx_appt_cust (business_id, customer_id),
  CONSTRAINT fk_appt_biz FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS product_usage (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  business_id INT NOT NULL,
  product_id INT NOT NULL,
  qty INT NOT NULL,
  barber_id INT NULL,
  appointment_id INT NULL,
  used_on DATE NOT NULL,
  note VARCHAR(255) NULL,
  created_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_pu (business_id, used_on),
  KEY idx_pu_prod (product_id, used_on),
  CONSTRAINT fk_pu_biz FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS commission_payouts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_id INT NOT NULL,
  barber_id INT NOT NULL,
  amount DECIMAL(14,2) NOT NULL,
  method VARCHAR(20) NOT NULL DEFAULT 'cash',
  paid_on DATE NOT NULL,
  note VARCHAR(255) NULL,
  created_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_cp (business_id, barber_id, paid_on),
  CONSTRAINT fk_cp_biz FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS vehicles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_id INT NOT NULL,
  make VARCHAR(60) NOT NULL,
  model VARCHAR(60) NOT NULL,
  year SMALLINT NULL,
  plate VARCHAR(20) NOT NULL,
  color VARCHAR(30) NULL,
  transmission VARCHAR(20) NULL,
  seats TINYINT NULL,
  daily_rate DECIMAL(14,2) NOT NULL DEFAULT 0,
  status ENUM('available','rented','maintenance') NOT NULL DEFAULT 'available',
  image_url VARCHAR(255) NULL,
  mileage INT NULL,
  insurance_expiry DATE NULL,
  road_tax_expiry DATE NULL,
  next_service_date DATE NULL,
  next_service_mileage INT NULL,
  notes VARCHAR(255) NULL,
  archived TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_vehicle_plate (business_id, plate),
  KEY idx_vehicle (business_id, archived, status),
  CONSTRAINT fk_vehicle_biz FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS rental_bookings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_id INT NOT NULL,
  booking_no VARCHAR(30) NOT NULL,
  vehicle_id INT NOT NULL,
  customer_id INT NULL,
  customer_name VARCHAR(120) NOT NULL,
  customer_phone VARCHAR(30) NOT NULL,
  pickup_date DATE NOT NULL,
  pickup_time TIME NOT NULL DEFAULT '10:00:00',
  return_date DATE NOT NULL,
  return_time TIME NOT NULL DEFAULT '10:00:00',
  days INT NOT NULL DEFAULT 1,
  daily_rate DECIMAL(14,2) NOT NULL DEFAULT 0,
  charge DECIMAL(14,2) NOT NULL DEFAULT 0,
  deduction DECIMAL(14,2) NOT NULL DEFAULT 0,
  status ENUM('pending','confirmed','ongoing','completed','cancelled') NOT NULL DEFAULT 'confirmed',
  channel VARCHAR(20) NOT NULL DEFAULT 'whatsapp',
  sale_id INT NULL,
  notes VARCHAR(500) NULL,
  actual_return_date DATE NULL,
  cancel_reason VARCHAR(255) NULL,
  created_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_booking_no (business_id, booking_no),
  KEY idx_bk_vehicle (business_id, vehicle_id, status, pickup_date),
  KEY idx_bk_dates (business_id, pickup_date, return_date),
  KEY idx_bk_cust (business_id, customer_id),
  CONSTRAINT fk_bk_biz FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS rental_payments (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  business_id INT NOT NULL,
  booking_id INT NOT NULL,
  type ENUM('payment','refund','deduction') NOT NULL DEFAULT 'payment',
  amount DECIMAL(14,2) NOT NULL,
  method VARCHAR(20) NULL,
  reference VARCHAR(80) NULL,
  note VARCHAR(255) NULL,
  created_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_rp_booking (booking_id),
  KEY idx_rp_biz (business_id, created_at),
  CONSTRAINT fk_rp_biz FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
) ENGINE=InnoDB`,
`CREATE TABLE IF NOT EXISTS vehicle_maintenance (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_id INT NOT NULL,
  vehicle_id INT NOT NULL,
  kind VARCHAR(20) NOT NULL DEFAULT 'service',
  service_date DATE NOT NULL,
  mileage INT NULL,
  cost DECIMAL(14,2) NOT NULL DEFAULT 0,
  description VARCHAR(255) NULL,
  next_service_date DATE NULL,
  next_service_mileage INT NULL,
  expense_id INT NULL,
  created_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_vm (business_id, vehicle_id, service_date),
  CONSTRAINT fk_vm_biz FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
) ENGINE=InnoDB`
];

const COLS = [
  ['sales', 'sale_type', "VARCHAR(12) NOT NULL DEFAULT 'retail'"],
  ['sales', 'barber_id', 'INT NULL'],
  ['sales', 'commission_pct', 'DECIMAL(5,2) NOT NULL DEFAULT 0'],
  ['sales', 'commission_amount', 'DECIMAL(14,2) NOT NULL DEFAULT 0'],
  ['sales', 'appointment_id', 'INT NULL'],
  ['sales', 'booking_id', 'INT NULL'],
  ['businesses', 'next_booking', 'INT NOT NULL DEFAULT 0']
];

/** run(sql, params) must return a promise; rows(sql, params) must resolve to an array of rows. */
async function ensure(run, rows) {
  for (const t of TABLES) await run(t);
  for (const [table, col, ddl] of COLS) {
    const r = await rows('SELECT 1 AS x FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=?', [table, col]);
    if (!r.length) await run(`ALTER TABLE \`${table}\` ADD COLUMN \`${col}\` ${ddl}`);
  }
  const idx = await rows("SELECT 1 AS x FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='sales' AND index_name='idx_sale_type'");
  if (!idx.length) await run('ALTER TABLE `sales` ADD INDEX `idx_sale_type` (business_id, sale_type, sale_date)');
  // New payment methods (DuitNow QR, e-wallet) and the "used" stock movement. Only altered when not done yet.
  const colType = async (table, col) => { const r = await rows('SELECT column_type AS t FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=?', [table, col]); return r.length ? String(r[0].t || r[0].T || '') : ''; };
  if (!(await colType('sales', 'payment_method')).includes("'ewallet'")) await run("ALTER TABLE sales MODIFY COLUMN payment_method ENUM('cash','mobile_money','card','bank','qr','ewallet','other') NOT NULL DEFAULT 'cash'");
  const smt = await colType('stock_movements', 'type');
  if (smt && !smt.includes("'usage'")) await run("ALTER TABLE stock_movements MODIFY COLUMN type ENUM('opening','purchase','sale','void_return','adjustment','damage','refund_return','transfer_out','transfer_in','usage') NOT NULL");
}
module.exports = { ensure, TABLES, COLS };
