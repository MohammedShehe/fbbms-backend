// Vehicle reminders: servicing (by date or mileage), insurance expiry and road-tax expiry.
const { q } = require('../config/db');
const { addDays, round2 } = require('./util');

const KM_WINDOW = 500; // warn when the next service mileage is within this many km
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);

/** Returns reminders sorted by urgency for the given vehicles. window = days ahead to warn (default 14). */
function build(vehicles, today, windowDays = 14) {
  const out = [];
  const add = (v, kind, label, due, extra = {}) => { const left = due ? daysBetween(today, due) : null; out.push({ vehicle_id: v.id, vehicle: `${v.make} ${v.model}`, plate: v.plate, kind, label, due, days_left: left, overdue: left !== null && left < 0, ...extra }); };
  for (const v of vehicles) {
    if (v.archived) continue;
    if (v.next_service_date && daysBetween(today, v.next_service_date) <= windowDays) add(v, 'service_date', 'Servicing due', v.next_service_date);
    if (v.next_service_mileage && v.mileage !== null && v.mileage !== undefined && v.next_service_mileage - v.mileage <= KM_WINDOW) add(v, 'service_mileage', 'Servicing due by mileage', null, { km_left: v.next_service_mileage - v.mileage, overdue: v.mileage >= v.next_service_mileage, due_text: `${v.next_service_mileage} km (now ${v.mileage} km)` });
    if (v.insurance_expiry && daysBetween(today, v.insurance_expiry) <= windowDays) add(v, 'insurance', 'Insurance expires', v.insurance_expiry);
    if (v.road_tax_expiry && daysBetween(today, v.road_tax_expiry) <= windowDays) add(v, 'road_tax', 'Road tax expires', v.road_tax_expiry);
  }
  return out.sort((a, b) => (a.overdue === b.overdue ? (a.days_left ?? -1e9) - (b.days_left ?? -1e9) : a.overdue ? -1 : 1));
}

async function forBusiness(biz, today) {
  const vehicles = await q('SELECT id,make,model,plate,mileage,insurance_expiry,road_tax_expiry,next_service_date,next_service_mileage,archived FROM vehicles WHERE business_id=? AND archived=0', [biz.id]);
  return build(vehicles, today, Number(biz.settings.maintenance_reminder_days) || 14);
}

const text = r => r.kind === 'service_mileage' ? `${r.vehicle} (${r.plate}): ${r.overdue ? 'service overdue' : r.km_left + ' km to service'} — ${r.due_text}` : `${r.vehicle} (${r.plate}): ${r.label} ${r.overdue ? Math.abs(r.days_left) + ' day(s) ago' : r.days_left === 0 ? 'today' : 'in ' + r.days_left + ' day(s)'} (${r.due})`;

module.exports = { build, forBusiness, text, addDays, round2 };
