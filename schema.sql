-- FBBMS v2 schema (MySQL 8 / MariaDB 10.4+)
-- Use a NEW database so your legacy data is untouched:   CREATE DATABASE fbbms CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS platform_settings (
  k VARCHAR(80) PRIMARY KEY,
  v LONGTEXT NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS businesses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  slug VARCHAR(60) NOT NULL UNIQUE,
  code VARCHAR(8) NOT NULL UNIQUE,             -- receipt / order prefix e.g. ZL
  name VARCHAR(150) NOT NULL,
  short_name VARCHAR(60) NOT NULL,
  template VARCHAR(30) NOT NULL DEFAULT 'general',
  tagline VARCHAR(200) DEFAULT NULL,
  currency VARCHAR(8) NOT NULL DEFAULT 'TZS',
  status ENUM('active','suspended') NOT NULL DEFAULT 'active',
  settings LONGTEXT NULL,                       -- JSON: contact, website content, rules
  theme LONGTEXT NULL,                          -- JSON: colours, logo
  next_receipt INT NOT NULL DEFAULT 0,
  next_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(150) NOT NULL UNIQUE,
  phone VARCHAR(30) DEFAULT NULL,
  password_hash VARCHAR(255) NOT NULL,
  is_developer TINYINT(1) NOT NULL DEFAULT 0,
  status ENUM('active','disabled') NOT NULL DEFAULT 'active',
  must_change_password TINYINT(1) NOT NULL DEFAULT 0,
  language VARCHAR(5) NULL,                     -- personal language: en | sw (NULL = business/platform default)
  last_login DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS memberships (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  business_id INT NOT NULL,
  role ENUM('super_admin','sub_admin') NOT NULL,
  permissions LONGTEXT NULL,                    -- JSON array (sub admins only)
  status ENUM('active','disabled') NOT NULL DEFAULT 'active',
  created_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_user_biz (user_id, business_id),
  CONSTRAINT fk_m_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_m_biz FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_id INT NOT NULL,
  name VARCHAR(100) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  UNIQUE KEY uq_cat (business_id, name),
  CONSTRAINT fk_c_biz FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS products (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_id INT NOT NULL,
  category_id INT NULL,
  sku VARCHAR(40) NOT NULL,
  name VARCHAR(160) NOT NULL,
  brand VARCHAR(100) DEFAULT NULL,
  size VARCHAR(50) DEFAULT NULL,
  description TEXT NULL,
  image_url VARCHAR(255) DEFAULT NULL,
  cost_price DECIMAL(14,2) NOT NULL DEFAULT 0,
  price DECIMAL(14,2) NOT NULL DEFAULT 0,
  stock_qty INT NOT NULL DEFAULT 0,
  low_stock_at INT NOT NULL DEFAULT 5,
  track_stock TINYINT(1) NOT NULL DEFAULT 1,    -- 0 = service / facility booking
  is_published TINYINT(1) NOT NULL DEFAULT 0,   -- appears on the public website
  is_featured TINYINT(1) NOT NULL DEFAULT 0,
  status ENUM('active','archived') NOT NULL DEFAULT 'active',
  created_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sku (business_id, sku),
  KEY idx_pub (business_id, is_published, status),
  CONSTRAINT fk_p_biz FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  CONSTRAINT fk_p_cat FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS stock_movements (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  business_id INT NOT NULL,
  product_id INT NOT NULL,
  type ENUM('opening','purchase','sale','void_return','adjustment','damage','usage') NOT NULL,
  qty_change INT NOT NULL,
  balance_after INT NOT NULL,
  unit_cost DECIMAL(14,2) NULL,
  ref_type VARCHAR(20) NULL,
  ref_id INT NULL,
  note VARCHAR(255) NULL,
  user_id INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_prod (product_id, created_at),
  KEY idx_biz (business_id, created_at),
  CONSTRAINT fk_sm_prod FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_id INT NOT NULL,
  order_no VARCHAR(30) NOT NULL,
  customer_name VARCHAR(120) NOT NULL,
  customer_phone VARCHAR(30) NOT NULL,
  customer_email VARCHAR(150) NULL,
  address VARCHAR(255) NULL,
  city VARCHAR(80) NULL,
  delivery_method ENUM('pickup','delivery') NOT NULL DEFAULT 'pickup',
  notes VARCHAR(500) NULL,
  items_total DECIMAL(14,2) NOT NULL DEFAULT 0,
  status ENUM('new','contacted','confirmed','completed','cancelled') NOT NULL DEFAULT 'new',
  handled_by INT NULL,
  sale_id INT NULL,
  admin_notes VARCHAR(500) NULL,
  cancel_reason VARCHAR(255) NULL,
  ip VARCHAR(60) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_order_no (business_id, order_no),
  KEY idx_status (business_id, status, created_at),
  CONSTRAINT fk_o_biz FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS order_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL,
  product_id INT NULL,
  name VARCHAR(160) NOT NULL,
  qty INT NOT NULL,
  unit_price DECIMAL(14,2) NOT NULL,
  line_total DECIMAL(14,2) NOT NULL,
  CONSTRAINT fk_oi_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sales (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_id INT NOT NULL,
  receipt_no VARCHAR(30) NOT NULL,
  source ENUM('pos','website') NOT NULL DEFAULT 'pos',
  order_id INT NULL,
  customer_name VARCHAR(120) NULL,
  customer_phone VARCHAR(30) NULL,
  payment_method ENUM('cash','mobile_money','card','bank','qr','ewallet','other') NOT NULL DEFAULT 'cash',
  subtotal DECIMAL(14,2) NOT NULL,
  discount DECIMAL(14,2) NOT NULL DEFAULT 0,
  total DECIMAL(14,2) NOT NULL,
  cost_total DECIMAL(14,2) NOT NULL DEFAULT 0,
  profit DECIMAL(14,2) NOT NULL DEFAULT 0,
  status ENUM('completed','voided') NOT NULL DEFAULT 'completed',
  void_reason VARCHAR(255) NULL,
  voided_by INT NULL,
  voided_at DATETIME NULL,
  notes VARCHAR(255) NULL,
  sold_by INT NOT NULL,
  sold_at DATETIME NOT NULL,                    -- UTC
  sale_date DATE NOT NULL,                      -- Africa/Dar_es_Salaam calendar date
  UNIQUE KEY uq_receipt (business_id, receipt_no),
  KEY idx_date (business_id, sale_date, status),
  KEY idx_seller (business_id, sold_by, sale_date),
  CONSTRAINT fk_s_biz FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS sale_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sale_id INT NOT NULL,
  product_id INT NULL,
  name VARCHAR(160) NOT NULL,
  sku VARCHAR(40) NULL,
  category VARCHAR(100) NULL,
  qty INT NOT NULL,
  list_price DECIMAL(14,2) NOT NULL,
  unit_price DECIMAL(14,2) NOT NULL,
  unit_cost DECIMAL(14,2) NOT NULL DEFAULT 0,
  line_total DECIMAL(14,2) NOT NULL,
  KEY idx_prod (product_id),
  CONSTRAINT fk_si_sale FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS expenses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_id INT NOT NULL,
  expense_date DATE NOT NULL,
  category VARCHAR(80) NOT NULL,
  description VARCHAR(255) NULL,
  amount DECIMAL(14,2) NOT NULL,
  voided TINYINT(1) NOT NULL DEFAULT 0,
  created_by INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_exp (business_id, expense_date),
  CONSTRAINT fk_e_biz FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  business_id INT NULL,
  user_id INT NULL,
  action VARCHAR(60) NOT NULL,
  entity VARCHAR(40) NULL,
  entity_id INT NULL,
  details LONGTEXT NULL,
  ip VARCHAR(60) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_a_biz (business_id, created_at),
  KEY idx_a_user (user_id, created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS otp_codes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  code_hash VARCHAR(100) NOT NULL,
  expires_at DATETIME NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  used TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_otp_user (user_id, used)
) ENGINE=InnoDB;
