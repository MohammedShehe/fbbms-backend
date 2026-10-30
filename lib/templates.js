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
  general: {
    label: 'General Retail',
    description: 'A blank retail shop you can shape yourself.',
    categories: ['General', 'Accessories', 'Services'],
    theme: { primary: '#4f8cff', accent: '#8ab4ff', bg: '#0b1020', mode: 'dark' },
    settings: { ...common, sku_prefix: 'GN', has_website: false }
  }
};

module.exports = { TEMPLATES };
