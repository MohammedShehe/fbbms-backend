// Every permission a Super Admin can grant to a Sub Admin (shopkeeper).
const PERMISSIONS = [
  { key: 'sales.create',         group: 'Sales',          label: 'Record sales (point of sale)' },
  { key: 'sales.view_all',       group: 'Sales',          label: 'See every sale in the shop (otherwise only their own)' },
  { key: 'sales.discount',       group: 'Sales',          label: 'Give discounts (capped by the shop discount limit)' },
  { key: 'sales.price_override', group: 'Sales',          label: 'Change the selling price at checkout' },
  { key: 'sales.void',           group: 'Sales',          label: 'Void a sale (stock is returned, fully audited)' },
  { key: 'products.view',        group: 'Inventory',      label: 'View products and stock levels' },
  { key: 'products.manage',      group: 'Inventory',      label: 'Add and edit products, categories, website listing' },
  { key: 'products.see_cost',    group: 'Inventory',      label: 'See cost prices and profit' },
  { key: 'stock.adjust',         group: 'Inventory',      label: 'Receive stock and make stock adjustments' },
  { key: 'orders.view',          group: 'Website orders', label: 'View website orders' },
  { key: 'orders.manage',        group: 'Website orders', label: 'Contact customers, change order status, complete orders' },
  { key: 'expenses.manage',      group: 'Money',          label: 'Record expenses' },
  { key: 'reports.view',         group: 'Money',          label: 'See whole-shop dashboard, reports and earnings' }
];
const ALL_KEYS = PERMISSIONS.map(p => p.key);
const DEFAULT_SUB = ['sales.create', 'products.view', 'orders.view'];

module.exports = { PERMISSIONS, ALL_KEYS, DEFAULT_SUB };
