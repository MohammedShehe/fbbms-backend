-- FBBMS v3 additions (safe to run repeatedly). Column / enum changes to EXISTING tables are applied by scripts/migrate.js.
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS business_groups (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS suppliers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_id INT NOT NULL,
  name VARCHAR(150) NOT NULL,
  contact_person VARCHAR(120) NULL,
  phone VARCHAR(30) NULL,
  email VARCHAR(150) NULL,
  address VARCHAR(255) NULL,
  notes VARCHAR(500) NULL,
  status ENUM('active','archived') NOT NULL DEFAULT 'active',
  created_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_sup (business_id, status),
  CONSTRAINT fk_sup_biz FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS purchase_orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_id INT NOT NULL,
  po_no VARCHAR(30) NOT NULL,
  supplier_id INT NOT NULL,
  status ENUM('draft','ordered','partial','received','cancelled') NOT NULL DEFAULT 'draft',
  expected_date DATE NULL,
  notes VARCHAR(500) NULL,
  total DECIMAL(14,2) NOT NULL DEFAULT 0,          -- ordered value
  received_value DECIMAL(14,2) NOT NULL DEFAULT 0, -- value actually received (this is what we owe)
  created_by INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ordered_at DATETIME NULL,
  received_at DATETIME NULL,
  UNIQUE KEY uq_po (business_id, po_no),
  KEY idx_po_sup (business_id, supplier_id, status),
  CONSTRAINT fk_po_biz FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  CONSTRAINT fk_po_sup FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  po_id INT NOT NULL,
  product_id INT NOT NULL,
  name VARCHAR(160) NOT NULL,
  qty_ordered INT NOT NULL,
  qty_received INT NOT NULL DEFAULT 0,
  unit_cost DECIMAL(14,2) NOT NULL DEFAULT 0,
  expiry_date DATE NULL,
  CONSTRAINT fk_poi_po FOREIGN KEY (po_id) REFERENCES purchase_orders(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS supplier_payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_id INT NOT NULL,
  supplier_id INT NOT NULL,
  po_id INT NULL,
  amount DECIMAL(14,2) NOT NULL,
  method VARCHAR(20) NOT NULL DEFAULT 'cash',
  reference VARCHAR(80) NULL,
  note VARCHAR(255) NULL,
  paid_date DATE NOT NULL,
  created_by INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_sp (business_id, supplier_id),
  CONSTRAINT fk_sp_sup FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS customers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_id INT NOT NULL,
  name VARCHAR(120) NOT NULL,
  phone VARCHAR(30) NULL,
  email VARCHAR(150) NULL,
  birthday DATE NULL,
  address VARCHAR(255) NULL,
  notes VARCHAR(500) NULL,
  loyalty_points INT NOT NULL DEFAULT 0,
  marketing_ok TINYINT(1) NOT NULL DEFAULT 1,
  source VARCHAR(20) NOT NULL DEFAULT 'admin',   -- admin | pos | website | api
  status ENUM('active','archived') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_cust_phone (business_id, phone),
  KEY idx_cust (business_id, status),
  CONSTRAINT fk_cust_biz FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS loyalty_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  business_id INT NOT NULL,
  customer_id INT NOT NULL,
  points_change INT NOT NULL,
  balance_after INT NOT NULL,
  reason VARCHAR(120) NOT NULL,
  ref_type VARCHAR(20) NULL,
  ref_id INT NULL,
  user_id INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ll (customer_id, created_at)
) ENGINE=InnoDB;

-- Every money movement against a sale (split payments, later debt repayments). Method 'credit_note' = exchange credit (not cash).
CREATE TABLE IF NOT EXISTS sale_payments (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  business_id INT NOT NULL,
  sale_id INT NOT NULL,
  customer_id INT NULL,
  method VARCHAR(20) NOT NULL,
  amount DECIMAL(14,2) NOT NULL,
  reference VARCHAR(80) NULL,
  created_by INT NULL,
  created_at DATETIME NOT NULL,
  KEY idx_sp_sale (sale_id),
  KEY idx_sp_biz (business_id, created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS refunds (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_id INT NOT NULL,
  refund_no VARCHAR(30) NOT NULL,
  sale_id INT NOT NULL,
  type ENUM('refund','exchange') NOT NULL DEFAULT 'refund',
  amount DECIMAL(14,2) NOT NULL,                  -- value of goods returned
  tax_amount DECIMAL(14,2) NOT NULL DEFAULT 0,    -- tax inside that value
  cash_out DECIMAL(14,2) NOT NULL DEFAULT 0,      -- money actually handed back
  cost_recovered DECIMAL(14,2) NOT NULL DEFAULT 0,-- cost of items put back on the shelf
  method VARCHAR(20) NOT NULL DEFAULT 'cash',     -- how the customer got the money back ('credit_note' for exchanges)
  reason VARCHAR(255) NOT NULL,
  new_sale_id INT NULL,
  created_by INT NOT NULL,
  created_at DATETIME NOT NULL,
  refund_date DATE NOT NULL,
  UNIQUE KEY uq_refund_no (business_id, refund_no),
  KEY idx_rf (business_id, refund_date),
  CONSTRAINT fk_rf_biz FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS refund_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  refund_id INT NOT NULL,
  sale_item_id INT NOT NULL,
  product_id INT NULL,
  name VARCHAR(160) NOT NULL,
  qty INT NOT NULL,
  unit_price DECIMAL(14,2) NOT NULL,
  unit_cost DECIMAL(14,2) NOT NULL DEFAULT 0,
  line_total DECIMAL(14,2) NOT NULL,
  restocked TINYINT(1) NOT NULL DEFAULT 1,
  KEY idx_ri_si (sale_item_id),
  CONSTRAINT fk_ri_rf FOREIGN KEY (refund_id) REFERENCES refunds(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS cash_sessions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_id INT NOT NULL,
  status ENUM('open','closed') NOT NULL DEFAULT 'open',
  opening_float DECIMAL(14,2) NOT NULL DEFAULT 0,
  opened_by INT NOT NULL,
  opened_at DATETIME NOT NULL,
  session_date DATE NOT NULL,
  expected_cash DECIMAL(14,2) NULL,
  counted_cash DECIMAL(14,2) NULL,
  variance DECIMAL(14,2) NULL,
  breakdown LONGTEXT NULL,
  notes VARCHAR(500) NULL,
  closed_by INT NULL,
  closed_at DATETIME NULL,
  KEY idx_cs (business_id, status, session_date),
  CONSTRAINT fk_cs_biz FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS cash_movements (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_id INT NOT NULL,
  type ENUM('in','out') NOT NULL,
  amount DECIMAL(14,2) NOT NULL,
  reason VARCHAR(255) NOT NULL,
  created_by INT NOT NULL,
  created_at DATETIME NOT NULL,
  KEY idx_cm (business_id, created_at),
  CONSTRAINT fk_cm_biz FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS recurring_expenses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_id INT NOT NULL,
  category VARCHAR(80) NOT NULL,
  description VARCHAR(255) NULL,
  amount DECIMAL(14,2) NOT NULL,
  frequency ENUM('weekly','monthly') NOT NULL DEFAULT 'monthly',
  next_date DATE NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_by INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_re (business_id, active, next_date),
  CONSTRAINT fk_re_biz FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS notifications (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  business_id INT NOT NULL,
  type VARCHAR(40) NOT NULL,
  severity ENUM('info','warn','critical') NOT NULL DEFAULT 'info',
  audience ENUM('all','super') NOT NULL DEFAULT 'super',
  title VARCHAR(160) NOT NULL,
  body TEXT NULL,
  data LONGTEXT NULL,
  dedupe_key VARCHAR(100) NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_notif (business_id, dedupe_key),
  KEY idx_notif (business_id, is_read, created_at),
  CONSTRAINT fk_n_biz FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS api_keys (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_id INT NOT NULL,
  name VARCHAR(100) NOT NULL,
  key_prefix VARCHAR(20) NOT NULL,
  key_hash CHAR(64) NOT NULL,
  scopes LONGTEXT NOT NULL,
  allowed_origins LONGTEXT NULL,
  rate_limit INT NOT NULL DEFAULT 120,
  status ENUM('active','revoked') NOT NULL DEFAULT 'active',
  expires_at DATETIME NULL,
  last_used_at DATETIME NULL,
  request_count BIGINT NOT NULL DEFAULT 0,
  created_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_key_hash (key_hash),
  KEY idx_ak (business_id, status),
  CONSTRAINT fk_ak_biz FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS api_request_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  key_id INT NOT NULL,
  business_id INT NOT NULL,
  method VARCHAR(8) NOT NULL,
  path VARCHAR(120) NOT NULL,
  status SMALLINT NOT NULL,
  ms INT NOT NULL DEFAULT 0,
  ip VARCHAR(60) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_arl (business_id, created_at),
  KEY idx_arl_key (key_id, created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  business_id INT NOT NULL,
  idem_key VARCHAR(80) NOT NULL,
  response LONGTEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_idem (business_id, idem_key)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS webhooks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_id INT NOT NULL,
  url VARCHAR(400) NOT NULL,
  secret VARCHAR(80) NOT NULL,
  events LONGTEXT NOT NULL,
  status ENUM('active','disabled') NOT NULL DEFAULT 'active',
  last_status INT NULL,
  last_attempt_at DATETIME NULL,
  failure_count INT NOT NULL DEFAULT 0,
  created_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_wh (business_id, status),
  CONSTRAINT fk_wh_biz FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS ai_usage (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  business_id INT NULL,
  user_id INT NULL,
  kind VARCHAR(20) NOT NULL DEFAULT 'chat',
  model VARCHAR(80) NULL,
  question VARCHAR(300) NULL,
  prompt_tokens INT NOT NULL DEFAULT 0,
  completion_tokens INT NOT NULL DEFAULT 0,
  tool_calls INT NOT NULL DEFAULT 0,
  latency_ms INT NOT NULL DEFAULT 0,
  status ENUM('ok','error') NOT NULL DEFAULT 'ok',
  error VARCHAR(300) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ai (business_id, created_at),
  KEY idx_ai_t (created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sessions (
  id CHAR(32) PRIMARY KEY,
  user_id INT NOT NULL,
  ip VARCHAR(60) NULL,
  user_agent VARCHAR(255) NULL,
  device VARCHAR(80) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen DATETIME NULL,
  revoked TINYINT(1) NOT NULL DEFAULT 0,
  KEY idx_sess (user_id, revoked)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS login_history (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  email VARCHAR(150) NULL,
  success TINYINT(1) NOT NULL,
  ip VARCHAR(60) NULL,
  user_agent VARCHAR(255) NULL,
  note VARCHAR(80) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_lh (user_id, created_at)
) ENGINE=InnoDB;
