// Business templates: the Developer picks one when registering a new shop.
const common = {
  currency: 'TZS',
  max_discount_pct: 15,
  low_stock_default: 5,
  order_note: 'We will call or WhatsApp you shortly to confirm your order and arrange payment and delivery.',
  hours: ''
};

const TEMPLATES = {
  scents: {
    label: 'Perfumes & Fragrances',
    description: 'Luxury scent boutique with a public online catalogue.',
    categories: ["Men's Perfume", "Women's Perfume", 'Unisex', 'Oud & Bakhoor', 'Body Mist & Sprays', 'Gift Sets', 'Attar & Oils', 'Home Fragrance'],
    theme: { primary: '#d4af55', accent: '#f1d98a', bg: '#0e0e10', mode: 'dark' },
    settings: { ...common, sku_prefix: 'SC', has_website: true }
  },
  sports: {
    label: 'Sports Store & Facilities',
    description: 'Sportswear, equipment and bookable facilities.',
    categories: ['Football', 'Basketball', 'Volleyball', 'Netball', 'Gym Equipment', 'Jerseys & Sportswear', 'Footwear', 'Accessories', 'Facility Booking'],
    theme: { primary: '#ff7a1a', accent: '#ffc247', bg: '#0b1020', mode: 'dark' },
    settings: { ...common, sku_prefix: 'SP', has_website: false }
  },
  barber: {
    label: 'Barber Shop',
    description: 'Services, appointments & walk-in queue, barber commissions, supplies used and daily sales.',
    categories: ['Barber Supplies', 'Retail Products'],
    theme: { primary: '#2dd4bf', accent: '#99f6e4', bg: '#0b1218', mode: 'dark' },
    currency: 'MYR',
    settings: { ...common, currency: 'MYR', timezone: 'Asia/Kuala_Lumpur', sku_prefix: 'BB', has_website: false, home: 'barber', hide_nav: ['orders'], default_commission_pct: 30, modules: { barber: true, rentals: false, suppliers: true, refunds: true, customers: true, cash: true, finance: true, health: true, alerts: true } },
    // The services the owner told us he provides (prices are set by him: they start at 0 and must be priced before use).
    starter_services: [['Haircut', 30], ['Beard trimming', 20], ['Haircut and beard', 45], ['Kids haircut', 25], ['Hairline', 15]].map(([name, duration_min]) => ({ name, duration_min })),
    // Consumables the shop records as "used": stock starts at 0 until the owner counts it.
    starter_products: ['Aftershave', 'Disposable blades', 'Cool care spray', 'Hair dye shampoo', 'White pencil', 'Cotton wool', 'Neck roll', 'Blade oil']
  },
  car_rental: {
    label: 'Self-Drive Car Rental',
    description: 'Vehicles, bookings with double-booking protection, payments & balances, calendar, maintenance reminders.',
    categories: ['Vehicle Rental'],
    theme: { primary: '#3b82f6', accent: '#93c5fd', bg: '#0a1020', mode: 'dark' },
    currency: 'MYR',
    settings: { ...common, currency: 'MYR', timezone: 'Asia/Kuala_Lumpur', sku_prefix: 'CR', has_website: false, home: 'rentals', hide_nav: ['pos', 'orders', 'products', 'stock', 'suppliers', 'refunds'], booking_channel: 'whatsapp', maintenance_reminder_days: 14, modules: { rentals: true, barber: false, suppliers: false, refunds: false, customers: true, cash: true, finance: true, health: true, alerts: true } }
  },
  general: {
    label: 'General Retail',
    description: 'A blank retail shop you can shape yourself.',
    categories: ['General', 'Accessories', 'Services'],
    theme: { primary: '#4f8cff', accent: '#8ab4ff', bg: '#0b1020', mode: 'dark' },
    settings: { ...common, sku_prefix: 'GN', has_website: false }
  }
};

module.exports = { TEMPLATES };
