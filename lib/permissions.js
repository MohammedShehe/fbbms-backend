// Every permission a Super Admin can grant to a Sub Admin (shopkeeper).
const PERMISSIONS = [
  { key: 'sales.create',         group: 'Sales',          label: 'Record sales (point of sale)' },
  { key: 'sales.view_all',       group: 'Sales',          label: 'See every sale in the shop (otherwise only their own)' },
  { key: 'sales.discount',       group: 'Sales',          label: 'Give discounts (capped by the shop discount limit)' },
  { key: 'sales.price_override', group: 'Sales',          label: 'Change the selling price at checkout' },
  { key: 'sales.void',           group: 'Sales',          label: 'Void a sale (stock is returned, fully audited)' },
  { key: 'sales.refund',         group: 'Sales',          label: 'Process refunds and exchanges' },
  { key: 'sales.credit',         group: 'Sales',          label: 'Sell on credit / take part payments' },
  { key: 'sales.backdate',       group: 'Sales',          label: 'Record past sales (backdate the sale date)' },
  { key: 'products.view',        group: 'Inventory',      label: 'View products and stock levels' },
  { key: 'products.manage',      group: 'Inventory',      label: 'Add and edit products, categories, website listing' },
  { key: 'products.see_cost',    group: 'Inventory',      label: 'See cost prices and profit' },
  { key: 'stock.adjust',         group: 'Inventory',      label: 'Receive stock and make stock adjustments' },
  { key: 'suppliers.manage',     group: 'Purchasing',     label: 'Manage suppliers, purchase orders and receive stock' },
  { key: 'customers.view',       group: 'Customers',      label: 'View customers and their purchase history' },
  { key: 'customers.manage',     group: 'Customers',      label: 'Add/edit customers, take debt repayments, adjust loyalty points' },
  { key: 'orders.view',          group: 'Website orders', label: 'View website orders' },
  { key: 'orders.manage',        group: 'Website orders', label: 'Contact customers, change order status, complete orders' },
  { key: 'expenses.manage',      group: 'Money',          label: 'Record expenses' },
  { key: 'cash.manage',          group: 'Money',          label: 'Open/close the till, record cash in/out, reconcile cash' },
  { key: 'reports.view',         group: 'Money',          label: 'See whole-shop dashboard, reports, finance statements and earnings' },
  { key: 'health.view',          group: 'Insights',       label: 'See Business Health, forecasts and risk flags' },
  { key: 'ai.use',               group: 'Insights',       label: 'Use the AI business assistant' }
];
const ALL_KEYS = PERMISSIONS.map(p => p.key);
const DEFAULT_SUB = ['sales.create', 'products.view', 'orders.view'];

module.exports = { PERMISSIONS, ALL_KEYS, DEFAULT_SUB };
