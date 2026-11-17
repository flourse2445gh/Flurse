import { expireTrials } from '../../lib/trial.js';
import { expiringTokenTenants, TOKEN_WARN_DAYS } from '../../lib/wahealth.js';
import {
  ordersNeedingReminder, itemsByOrder, markReminderSent, customerWindowOpen,
} from '../../lib/orders.js';
import { sendWhatsAppText } from '../../lib/whatsapp.js';
import { emailDeliveryReminder } from '../../lib/notify.js';
import { handler, json, requireMethod, HttpError } from '../../lib/http.js';

// GET /api/cron/trial — invoked hourly by the Vercel cron in vercel.json.
// Vercel sends `Authorization: Bearer $CRON_SECRET` for scheduled runs.
export default handler(async (req, res) => {
  if (!requireMethod(req, res, ['GET', 'POST'])) return;

  const secret = process.env.CRON_SECRET;
  if (secret) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (token !== secret) throw new HttpError(401, 'Unauthorized');
  }

  const expired = await expireTrials();

  // A Cloud API token lapses 60 days after it was issued. Watch that clock here
  // so a shop about to go silent is visible in the logs before its customers
  // notice, rather than only on the dashboard nobody opened.
  const expiring = await expiringTokenTenants();
  for (const t of expiring) {
    console.warn(
      `WhatsApp token for ${t.slug} expires ${new Date(t.wa_token_expires_at).toISOString()} `
      + `(within ${TOKEN_WARN_DAYS} days) — owner ${t.owner_email}`,
    );
  }

  console.log(`Trial cron suspended ${expired.length} tenant(s); ${expiring.length} token(s) expiring`);
  json(res, 200, {
    suspended: expired.length,
    tenants: expired.map((t) => t.slug),
    expiringTokens: expiring.map((t) => t.slug),
    reminders: await sendDeliveryReminders(),
  });
});

// A customer who ordered for tomorrow gets one nudge on the day, so nobody is
// surprised at the door. It is sent over WhatsApp only while the 24-hour window
// is open (a free-form message outside it is rejected by Meta); otherwise the
// owner is emailed instead, so the reminder is never simply lost.
async function sendDeliveryReminders(now = new Date()) {
  const due = await ordersNeedingReminder(now);
  if (!due.length) return { sent: 0, emailed: 0, failed: 0 };

  const byTenant = new Map();
  for (const o of due) {
    if (!byTenant.has(o.tenant_id)) byTenant.set(o.tenant_id, []);
    byTenant.get(o.tenant_id).push(o);
  }

  let sent = 0;
  let emailed = 0;
  let failed = 0;

  for (const [tenantId, orders] of byTenant) {
    const items = await itemsByOrder(tenantId, orders.map((o) => o.id));
    for (const o of orders) {
      const lineItems = items.get(o.id) || [];
      const tenant = { business_name: o.business_name, owner_email: o.owner_email };
      const order = {
        total_cents: o.total_cents, fulfilment: o.fulfilment, delivery_at: o.delivery_at,
        delivery_address: o.delivery_address, recipient_name: o.recipient_name,
        recipient_phone: o.recipient_phone, delivery_note: o.delivery_note,
        payment_status: o.payment_status,
      };

      let handled = false;
      const canSend = o.wa_access_token && o.wa_phone_number_id
        && await customerWindowOpen(tenantId, o.customer_id, now);
      if (canSend) {
        try {
          await sendWhatsAppText({
            phoneNumberId: o.wa_phone_number_id,
            accessToken: o.wa_access_token,
            to: o.customer_wa_id,
            body: reminderBody(order),
          });
          sent += 1;
          handled = true;
        } catch (err) {
          console.error('Delivery reminder send failed', err.message);
        }
      }

      if (!handled) {
        // The owner email is the fallback, and it is also useful on its own:
        // it is the one reminder that survives a closed WhatsApp window.
        const ok = await emailDeliveryReminder({
          tenant, order, items: lineItems,
          customer: { waId: o.customer_wa_id, displayName: o.customer_name },
        });
        if (ok) emailed += 1;
        else failed += 1;
      }

      // Stamp either way: an attempted reminder must not be retried on the next
      // hourly run and turn into spam.
      await markReminderSent(o.id);
    }
  }
  console.log(`Delivery reminders: ${sent} sent, ${emailed} emailed, ${failed} unattempted`);
  return { sent, emailed, failed };
}

function reminderBody(order) {
  const when = order.delivery_at
    ? new Date(order.delivery_at).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
    })
    : 'kal';
  const name = order.recipient_name ? ` ${order.recipient_name} ji ke liye` : '';
  return `Reminder: aapka order${name} kal ${when} ke aas paas pahunchega 🌸 `
    + `Kuch badalna ho to abhi bata dijiye.`;
}
