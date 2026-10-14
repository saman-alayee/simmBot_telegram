import { displayJalali, formatPhoneDisplay, tehranYmd } from '../domain/format.js';
import { shouldApplySpecialSale, shouldCleanupSoldChannel, staffNotifyChatIds } from '../domain/logic.js';
import {
  announceSold, applySpecialSale, clearReserveNotice, listingById, logChange, postSpecialSaleNotice,
  publicOrigin, putSetting, syncChannel
} from './data.js';

const ADMIN_LABELS = { 1: '@samiito0912', 2: '@Samisadeghirb' };

async function tg(method, body = {}) {
  const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return response.json();
}

function sendSucceeded(result) {
  if (result == null) return true;
  return result.ok !== false;
}

function deleted(result) {
  return result?.ok || /not found|can't be deleted|message to delete not found/i.test(result?.description || '');
}

export async function expireReservations(q, send = tg) {
  const rows = await q`SELECT * FROM listings WHERE status = 'reserved' AND reserved_until IS NOT NULL AND reserved_until <= NOW()`;
  let count = 0;
  for (const row of rows) {
    const updated = (await q`UPDATE listings
      SET status = 'active', reserved_by = NULL, reserved_at = NULL, reserved_until = NULL, updated_at = NOW()
      WHERE id = ${row.id} AND status = 'reserved' AND reserved_until <= NOW()
      RETURNING *`)[0];
    if (!updated) continue;
    await logChange(q, { listingId: row.id, field: 'reserve_expire', from: `reserved:${row.reserved_by || ''}`, to: 'active', by: null });
    await logChange(q, { listingId: row.id, field: 'status', from: 'reserved', to: 'active', by: null });
    const fresh = await listingById(q, row.id);
    await clearReserveNotice(q, send, fresh);
    await syncChannel(q, send, fresh, publicOrigin());
    count += 1;
  }
  return count;
}

export async function cleanupSoldPosts(q, send = tg) {
  const rows = await q`SELECT * FROM listings
    WHERE status = 'sold' AND sold_at IS NOT NULL AND sold_at <= NOW() - INTERVAL '48 hours' AND channel_cleaned_at IS NULL`;
  let count = 0;
  for (const row of rows) {
    if (!shouldCleanupSoldChannel(row)) continue;
    const reserveNotice = row.reserved_notice_message_id
      ? await send('deleteMessage', { chat_id: row.channel_chat_id, message_id: row.reserved_notice_message_id }) : { ok: true };
    const specialNotice = row.special_sale_notice_message_id
      ? await send('deleteMessage', { chat_id: row.channel_chat_id, message_id: row.special_sale_notice_message_id }) : { ok: true };
    const reply = row.sold_reply_message_id ? await send('deleteMessage', { chat_id: row.channel_chat_id, message_id: row.sold_reply_message_id }) : { ok: true };
    const post = row.channel_message_id ? await send('deleteMessage', { chat_id: row.channel_chat_id, message_id: row.channel_message_id }) : { ok: true };
    if (deleted(reserveNotice) && deleted(specialNotice) && deleted(reply) && deleted(post)) {
      await q`UPDATE listings SET channel_cleaned_at = NOW(), channel_message_id = NULL, sold_reply_message_id = NULL,
        reserved_notice_message_id = NULL, special_sale_notice_message_id = NULL, updated_at = NOW() WHERE id = ${row.id}`;
      count += 1;
    }
  }
  return count;
}

export async function runSpecialSales(q, send = tg) {
  const rows = await q`SELECT * FROM listings
    WHERE status = 'active' AND period_started_at IS NOT NULL AND period_started_at <= NOW() - INTERVAL '60 days'
      AND (special_sale_applied_at IS NULL OR special_sale_announced_at IS NULL)`;
  let count = 0;
  for (const row of rows) {
    let current = row;
    if (shouldApplySpecialSale(row)) {
      const updated = await applySpecialSale(q, row);
      if (updated) current = updated;
    }
    if (current.special_sale_applied_at && !current.special_sale_announced_at) {
      const fresh = await listingById(q, current.id);
      await syncChannel(q, send, fresh, publicOrigin());
      await postSpecialSaleNotice(q, send, await listingById(q, current.id));
      await q`UPDATE listings SET special_sale_announced_at = NOW() WHERE id = ${current.id}`;
      count += 1;
    }
  }
  return count;
}

/** به‌روزرسانی متن کانال وقتی تاریخ سند رسیده (شامل فروخته‌شده). */
export async function refreshDueDocumentChannelPosts(q, send = tg) {
  const rows = await q`SELECT id FROM listings
    WHERE document_ready_date IS NOT NULL AND document_ready_date <= (NOW() AT TIME ZONE 'Asia/Tehran')::date
      AND channel_message_id IS NOT NULL AND channel_cleaned_at IS NULL`;
  let count = 0;
  for (const row of rows) {
    const fresh = await listingById(q, row.id);
    if (!fresh) continue;
    const result = await syncChannel(q, send, fresh, publicOrigin());
    if (result) count += 1;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  return count;
}

export async function markReadyTransfers(q, send = tg) {
  const rows = await q`SELECT * FROM listings
    WHERE status IN ('active', 'reserved') AND document_ready_date IS NOT NULL AND document_ready_date <= (NOW() AT TIME ZONE 'Asia/Tehran')::date`;
  let count = 0;
  for (const row of rows) {
    if (row.status === 'reserved') {
      await logChange(q, { listingId: row.id, field: 'reserve_release', from: `reserved:${row.reserved_by || ''}`, to: 'ready_transfer', by: null });
      await clearReserveNotice(q, send, row);
    }
    await q`UPDATE listings
      SET status = 'ready_transfer', reserved_by = NULL, reserved_at = NULL, reserved_until = NULL, updated_at = NOW()
      WHERE id = ${row.id}`;
    await logChange(q, { listingId: row.id, field: 'status', from: row.status, to: 'ready_transfer', by: null });
    await syncChannel(q, send, await listingById(q, row.id), publicOrigin());
    count += 1;
  }
  return count;
}

function saleDocumentReminderText(row) {
  return [
    'یادآوری سند',
    '',
    `شماره: ${formatPhoneDisplay(row.phone_number, row.phone_display)}`,
    `موعد سند: ${displayJalali(row.sale_document_due_date)}`,
    `چرخه تأخیر: ${Number(row.sale_document_cycle || 0)}`,
    '',
    'اگر سند زده شد «سند زده شد» را بزن؛ اگر هنوز نه، «تأخیر» را بزن.'
  ].join('\n');
}

function saleDocumentReminderMarkup(listingId) {
  return {
    inline_keyboard: [[{ text: 'سند زده شد', callback_data: `docdone_${listingId}` }, { text: 'تأخیر', callback_data: `docdelay_${listingId}` }]]
  };
}

export async function remindDocuments(q, send = tg, { listingId } = {}) {
  if (listingId) {
    await q`UPDATE listings
      SET sale_document_status = 'pending',
          sale_document_due_date = COALESCE(sale_document_due_date, document_ready_date, (NOW() AT TIME ZONE 'Asia/Tehran')::date),
          sale_document_cycle = COALESCE(sale_document_cycle, 0),
          updated_at = NOW()
      WHERE id = ${listingId} AND status = 'sold'
        AND (sale_document_status IS NULL OR sale_document_status NOT IN ('done', 'pending'))
        AND sale_document_completed_at IS NULL`;
  } else {
    await q`UPDATE listings
      SET sale_document_status = 'pending',
          sale_document_due_date = COALESCE(sale_document_due_date, document_ready_date, (NOW() AT TIME ZONE 'Asia/Tehran')::date),
          sale_document_cycle = COALESCE(sale_document_cycle, 0),
          updated_at = NOW()
      WHERE status = 'sold'
        AND (sale_document_status IS NULL OR sale_document_status NOT IN ('done', 'pending'))
        AND sale_document_completed_at IS NULL`;
  }

  const due = listingId
    ? await q`SELECT * FROM listings
        WHERE id = ${listingId} AND status = 'sold' AND sale_document_status = 'pending' AND sale_document_due_date IS NOT NULL
          AND sale_document_due_date <= (NOW() AT TIME ZONE 'Asia/Tehran')::date
          AND (sale_document_last_reminded_at IS NULL
            OR (sale_document_last_reminded_at AT TIME ZONE 'Asia/Tehran')::date < (NOW() AT TIME ZONE 'Asia/Tehran')::date)
        ORDER BY sale_document_due_date, id`
    : await q`SELECT * FROM listings
        WHERE status = 'sold' AND sale_document_status = 'pending' AND sale_document_due_date IS NOT NULL
          AND sale_document_due_date <= (NOW() AT TIME ZONE 'Asia/Tehran')::date
          AND (sale_document_last_reminded_at IS NULL
            OR (sale_document_last_reminded_at AT TIME ZONE 'Asia/Tehran')::date < (NOW() AT TIME ZONE 'Asia/Tehran')::date)
        ORDER BY sale_document_due_date, id`;
  if (!due.length) return 0;

  const admins = await q`SELECT telegram_user_id, priority FROM admins WHERE active = true ORDER BY priority ASC`;
  const chats = staffNotifyChatIds(process.env, admins);
  if (!chats.length) return 0;

  let sent = 0;
  for (const row of due) {
    let ok = false;
    const text = saleDocumentReminderText(row);
    const reply_markup = saleDocumentReminderMarkup(row.id);
    for (const chat_id of chats) {
      const result = await send('sendMessage', { chat_id, text, reply_markup });
      if (sendSucceeded(result)) ok = true;
    }
    if (ok) {
      await q`UPDATE listings SET sale_document_last_reminded_at = NOW(), updated_at = NOW() WHERE id = ${row.id}`;
      sent += 1;
    }
  }
  return sent;
}

export async function handoffPurchases(q, send = tg) {
  const expired = await q`SELECT pr.*, l.phone_number, l.phone_display, l.condition_text
    FROM purchase_requests pr JOIN listings l ON l.id = pr.listing_id
    WHERE pr.status = 'pending' AND pr.assigned_priority = 1 AND pr.expires_at IS NOT NULL
      AND pr.expires_at <= NOW() AND pr.handoff_notified = false`;
  const second = (await q`SELECT * FROM admins WHERE active = true AND priority = 2 ORDER BY priority LIMIT 1`)[0];
  if (!second) return 0;
  for (const row of expired) {
    await q`UPDATE purchase_requests SET assigned_admin = ${second.telegram_user_id}, assigned_priority = 2, expires_at = NOW() + INTERVAL '30 minutes', handoff_notified = true WHERE id = ${row.id}`;
    const text = `درخواست خرید ${row.request_type === 'cash' ? 'نقدی' : 'اقساطی'} #${row.id}\n\nشماره: ${formatPhoneDisplay(row.phone_number, row.phone_display)}\nوضعیت: ${row.condition_text || '-'}\nقیمت: ${Number(row.base_price_toman).toLocaleString('en-US')} تومان\n\nمشتری: ${row.customer_name || '-'}\nشناسه تلگرام: ${row.customer_telegram_id}\nشماره تماس مشتری: ${row.customer_phone ? formatPhoneDisplay(row.customer_phone) : 'ثبت نشده'}\n\nمسئول فعلی: ${ADMIN_LABELS[2]}`;
    await send('sendMessage', { chat_id: second.telegram_user_id, text, reply_markup: { inline_keyboard: [[{ text: 'پیگیری شد', callback_data: `claim_${row.id}` }]] } });
    if (row.assigned_admin) await send('sendMessage', { chat_id: row.assigned_admin, text: `درخواست خرید #${row.id} پیگیری نشد و به ادمین دیگری واگذار گردید.\nمسئول جدید: ${ADMIN_LABELS[2]}` });
  }
  return expired.length;
}

export async function greetOnce(q, send = tg) {
  const today = tehranYmd();
  const last = (await q`SELECT value FROM settings WHERE key = 'cron_greeting_on' LIMIT 1`)[0]?.value;
  if (last === today) return 0;
  const admins = await q`SELECT telegram_user_id FROM admins WHERE active = true ORDER BY priority ASC`;
  for (const admin of admins) {
    await send('sendMessage', { chat_id: admin.telegram_user_id, text: 'صبح بخیر.\nچند خط برای استوری امروز بگذارم و کدام کدها؟\nمثال: ۱۰ خط — کد ۱ و ۲' });
  }
  await putSetting(q, 'cron_greeting_on', today);
  return admins.length;
}

export async function runJobs(q, send = tg) {
  return {
    document_ready_channel: await refreshDueDocumentChannelPosts(q, send),
    ready_transfer: await markReadyTransfers(q, send),
    reservations: await expireReservations(q, send),
    sold_cleanup: await cleanupSoldPosts(q, send),
    special_sales: await runSpecialSales(q, send),
    document_reminders: await remindDocuments(q, send),
    expired: await handoffPurchases(q, send),
    greetings: await greetOnce(q, send)
  };
}
