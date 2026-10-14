import {
  botLinkUsername,
  displayDateTime, displayJalali, documentReadyLabel, formatListingPricePlain, formatPhoneDisplay, isDocumentReadyDue, money,
  normalizeLookupName, plusDaysISO, prefixCode, saleDocumentDueFromReady
} from '../domain/format.js';
import { buildInstallmentConfig } from '../domain/installment-config.js';
import { calcUrlFor, channelPurchaseKeyboard, channelText } from '../channel/channel.js';
import { resolveStoreAddressForInvoice } from '../invoice/invoice-template.js';
import { loadChannelMessageBundles, loadChannelStatusMessages } from '../channel/channel-messages.js';
import { sendMessagePayload, utf16Length } from '../telegram/telegram-text.js';
import {
  FIELD_LABELS, PRICE_CHANGE_STATUSES, canAssignOwner, canReleaseReservation, invoiceDiscount, invoiceMath, listingListPriceToman,
  nextInvoiceNumber, priceAfterPercentIncrease, saleAllowed, specialPrice
} from '../domain/logic.js';
import { jalaliParts } from '../domain/format.js';

let botUsernameCache = '';
async function liveBotUsername(tg) {
  if (botUsernameCache) return botUsernameCache;
  try {
    const me = await tg('getMe');
    if (me?.ok && me.result?.username) {
      botUsernameCache = botLinkUsername(me.result.username);
      return botUsernameCache;
    }
  } catch { /* fall back to env */ }
  botUsernameCache = botLinkUsername(process.env.BOT_USERNAME || 'SamiSIM0912Bot');
  return botUsernameCache;
}

export async function logChange(q, { listingId, field, from, to, by = null }) {
  if (String(from ?? '') === String(to ?? '')) return;
  await q`INSERT INTO listing_history(listing_id, field_name, old_value, new_value, changed_by)
    VALUES(${listingId}, ${field}, ${from == null ? null : String(from)}, ${to == null ? null : String(to)}, ${by})`;
}

export async function openListingByPhone(q, phone) {
  const rows = await q`SELECT * FROM listings
    WHERE regexp_replace(COALESCE(phone_number, ''), '\\D', '', 'g') = ${phone}
      AND status IN ('active', 'reserved', 'ready_transfer', 'inactive')
    ORDER BY id DESC LIMIT 1`;
  return rows[0] || null;
}

/** یک کوئری: خط باز (یا آخرین دوره) با نام مالک/انبار برای استعلام */
export async function lookupListingByPhone(q, phoneDigits) {
  const rows = await q`SELECT l.*, o.name AS owner_name, w.name AS warehouse_name, a.display_name AS reserver_name
    FROM listings l
    LEFT JOIN owners o ON o.id = l.owner_id
    LEFT JOIN warehouses w ON w.id = l.warehouse_id
    LEFT JOIN admins a ON a.telegram_user_id = l.reserved_by
    WHERE regexp_replace(COALESCE(l.phone_number, ''), '\\D', '', 'g') = ${phoneDigits}
    ORDER BY
      CASE WHEN l.status IN ('active', 'reserved', 'ready_transfer', 'inactive') THEN 0 ELSE 1 END,
      l.cycle_no DESC,
      l.id DESC
    LIMIT 1`;
  return rows[0] || null;
}

export async function activeOwnersWithUsage(q) {
  return q`SELECT o.id, o.name, o.max_line_slots, COUNT(l.id)::int AS used
    FROM owners o
    LEFT JOIN listings l ON l.owner_id = o.id AND l.status IN ('active', 'reserved', 'ready_transfer', 'inactive')
    WHERE o.active = true
    GROUP BY o.id, o.name, o.max_line_slots
    ORDER BY o.name`;
}

export async function listingById(q, id) {
  const rows = await q`SELECT l.*, o.name AS owner_name, w.name AS warehouse_name, a.display_name AS reserver_name
    FROM listings l
    LEFT JOIN owners o ON o.id = l.owner_id
    LEFT JOIN warehouses w ON w.id = l.warehouse_id
    LEFT JOIN admins a ON a.telegram_user_id = l.reserved_by
    WHERE l.id = ${id} LIMIT 1`;
  return rows[0] || null;
}

export async function ownerUsage(q, ownerId) {
  const rows = await q`SELECT COUNT(*)::int AS count FROM listings
    WHERE owner_id = ${ownerId} AND status IN ('active', 'reserved', 'ready_transfer', 'inactive')`;
  return Number(rows[0]?.count || 0);
}

export function publicOrigin(request) {
  if (request?.url) return new URL(request.url).origin;
  return process.env.PUBLIC_BASE_URL || 'https://samisim0912bot-v2-1.vercel.app';
}

function editAccepted(result) {
  return result?.ok || /not modified/i.test(result?.description || '');
}

function channelDeleteOk(result) {
  return result?.ok || /not found|can't be deleted|message to delete not found/i.test(result?.description || '');
}

export async function deleteChannelMessage(tg, chatId, messageId) {
  if (!chatId || !messageId) return true;
  const result = await tg('deleteMessage', { chat_id: chatId, message_id: messageId });
  return channelDeleteOk(result);
}

export async function clearReserveNotice(q, tg, row) {
  if (!row?.id || !row.reserved_notice_message_id) return row;
  await deleteChannelMessage(tg, row.channel_chat_id, row.reserved_notice_message_id);
  await q`UPDATE listings SET reserved_notice_message_id = NULL, updated_at = NOW() WHERE id = ${row.id}`;
  row.reserved_notice_message_id = null;
  return row;
}

export async function postReserveNotice(q, tg, row) {
  if (!row || row.status !== 'reserved' || !row.channel_chat_id || !row.channel_message_id) return row;
  if (row.reserved_notice_message_id) return row;
  const { texts, entities } = await loadChannelMessageBundles(q, settingValue);
  const sent = await tg('sendMessage', {
    chat_id: row.channel_chat_id,
    reply_to_message_id: row.channel_message_id,
    ...sendMessagePayload(texts.channel_msg_reserved, entities.channel_msg_reserved)
  });
  if (sent?.ok) {
    await q`UPDATE listings SET reserved_notice_message_id = ${sent.result.message_id} WHERE id = ${row.id}`;
    row.reserved_notice_message_id = sent.result.message_id;
  }
  return row;
}

export async function postSpecialSaleNotice(q, tg, row) {
  if (!row?.special_sale_applied_at || row.special_sale_notice_message_id) return row;
  if (!row.channel_chat_id || !row.channel_message_id) return row;
  const { texts, entities } = await loadChannelMessageBundles(q, settingValue);
  const sent = await tg('sendMessage', {
    chat_id: row.channel_chat_id,
    reply_to_message_id: row.channel_message_id,
    ...sendMessagePayload(texts.channel_msg_special_reply, entities.channel_msg_special_reply)
  });
  if (sent?.ok) {
    await q`UPDATE listings SET special_sale_notice_message_id = ${sent.result.message_id} WHERE id = ${row.id}`;
    row.special_sale_notice_message_id = sent.result.message_id;
  }
  return row;
}

export async function clearChannelSideMessages(q, tg, row) {
  if (!row) return row;
  await clearReserveNotice(q, tg, row);
  if (row.special_sale_notice_message_id) {
    await deleteChannelMessage(tg, row.channel_chat_id, row.special_sale_notice_message_id);
    await q`UPDATE listings SET special_sale_notice_message_id = NULL, updated_at = NOW() WHERE id = ${row.id}`;
    row.special_sale_notice_message_id = null;
  }
  return row;
}

export async function getInstallmentConfig(q) {
  const rows = await q`SELECT key, value FROM settings WHERE key IN (
    'installment_interest_percent_monthly',
    'installment_month_options',
    'installment_percent_options',
    'installment_round_toman',
    'installment_sales_enabled',
    'installment_default_percent',
    'purchase_request_expire_minutes'
  )`;
  const map = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  return buildInstallmentConfig({
    interest: map.installment_interest_percent_monthly,
    monthOptions: map.installment_month_options,
    percentOptions: map.installment_percent_options,
    roundToman: map.installment_round_toman,
    salesEnabled: map.installment_sales_enabled,
    defaultPercent: map.installment_default_percent,
    requestExpireMinutes: map.purchase_request_expire_minutes
  });
}

/** Re-publish channel posts so «خرید اقساطی» links match installment_sales_enabled. */
export async function refreshInstallmentChannelPosts(q, tg, request, installmentConfig = null) {
  const inst = installmentConfig || await getInstallmentConfig(q);
  const origin = publicOrigin(request);
  const rows = await q`SELECT id FROM listings
    WHERE status IN ('active', 'reserved', 'ready_transfer') AND channel_message_id IS NOT NULL`;
  let updated = 0;
  for (const row of rows) {
    const fresh = await listingById(q, row.id);
    if (!fresh) continue;
    const result = await syncChannel(q, tg, fresh, origin, inst);
    if (result) updated += 1;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  return updated;
}

export async function ownerIdByName(q, name) {
  const key = normalizeLookupName(name);
  if (!key) return null;
  const rows = await q`SELECT id, name FROM owners WHERE active = true`;
  const hit = rows.find((row) => normalizeLookupName(row.name) === key);
  return hit?.id ?? null;
}

export async function warehouseIdByName(q, name) {
  const key = normalizeLookupName(name);
  if (!key) return null;
  const rows = await q`SELECT id, name FROM warehouses WHERE active = true`;
  const hit = rows.find((row) => normalizeLookupName(row.name) === key);
  return hit?.id ?? null;
}

export async function syncChannel(q, tg, row, origin, installmentConfig = null) {
  if (!row) return null;
  const bot = await liveBotUsername(tg);
  const channelId = String(process.env.CHANNEL_ID || '').trim();
  const inst = installmentConfig || await getInstallmentConfig(q);
  const { texts, entities } = await loadChannelMessageBundles(q, settingValue);
  const calcUrl = calcUrlFor(origin, row.id);
  const text = channelText(row, {
    bot,
    calcUrl,
    installmentEnabled: inst.salesEnabled,
    statusMessages: texts,
    statusEntities: entities
  });
  const replyMarkup = channelPurchaseKeyboard(row, {
    bot,
    calcUrl,
    installmentEnabled: inst.salesEnabled,
    statusMessages: texts
  });
  if (row.channel_chat_id && row.channel_message_id) {
    const edited = await tg('editMessageText', {
      chat_id: row.channel_chat_id,
      message_id: row.channel_message_id,
      text,
      parse_mode: 'HTML',
      reply_markup: replyMarkup
    });
    if (editAccepted(edited)) return edited;
    // پست قبلی حذف شده یا قابل ویرایش نیست → شناسه کهنه را پاک کن و پست تازه بفرست
    if (/message to edit not found|message can't be edited|message is not modified/i.test(String(edited?.description || ''))) {
      await q`UPDATE listings SET channel_chat_id = NULL, channel_message_id = NULL, updated_at = NOW() WHERE id = ${row.id}`;
      row.channel_chat_id = null;
      row.channel_message_id = null;
    }
  }
  if (!channelId || row.status === 'sold') {
    return { ok: false, description: channelId ? `status=${row.status}` : 'CHANNEL_ID missing' };
  }
  const sent = await tg('sendMessage', {
    chat_id: channelId,
    text,
    parse_mode: 'HTML',
    reply_markup: replyMarkup
  });
  if (sent?.ok) {
    const previousChat = row.channel_chat_id;
    const previousMessage = row.channel_message_id;
    await q`UPDATE listings
      SET channel_chat_id = ${channelId},
          channel_message_id = ${sent.result.message_id},
          updated_at = NOW()
      WHERE id = ${row.id}`;
    if (previousChat && previousMessage && Number(previousMessage) !== Number(sent.result.message_id)) {
      await tg('deleteMessage', { chat_id: previousChat, message_id: previousMessage });
    }
  }
  return sent;
}

export async function saveListing(q, input) {
  const open = await openListingByPhone(q, input.phone);
  const ownerId = input.ownerId === undefined ? open?.owner_id ?? null : input.ownerId;
  const warehouseId = input.warehouseId === undefined ? open?.warehouse_id ?? null : input.warehouseId;
  const readyDate = input.date === undefined ? open?.document_ready_date ?? null : input.date;
  if (ownerId || warehouseId) {
    const [owner, warehouse] = await Promise.all([
      ownerId ? q`SELECT * FROM owners WHERE id = ${ownerId} AND active = true LIMIT 1`.then((rows) => rows[0]) : null,
      warehouseId ? q`SELECT id FROM warehouses WHERE id = ${warehouseId} AND active = true LIMIT 1`.then((rows) => rows[0]) : null
    ]);
    if (ownerId && !owner) throw new Error('OWNER_MISSING');
    if (warehouseId && !warehouse) throw new Error('WAREHOUSE_MISSING');
    if (owner) {
      const used = await ownerUsage(q, ownerId);
      const already = open && String(open.owner_id ?? '') === String(ownerId);
      if (!canAssignOwner({ used, max: owner.max_line_slots, alreadyOnThisOwner: already })) {
        const error = new Error('OWNER_FULL');
        error.used = used;
        error.max = Number(owner.max_line_slots ?? 10);
        throw error;
      }
    }
  }
  const cash = Math.floor(Number(input.price) / 3);
  if (open) {
    const nextStatus = ['reserved', 'ready_transfer'].includes(open.status) ? open.status : 'active';
    const updated = (await q`UPDATE listings SET
      phone_display = ${input.displayPhone},
      prefix_code = ${prefixCode(input.phone)},
      price_toman = ${input.price},
      condition_text = ${input.condition},
      payment_terms = 'الباقی ۲ تا ۸ ماهه',
      cash_amount_toman = ${cash},
      owner_id = ${ownerId},
      warehouse_id = ${warehouseId},
      document_ready_date = ${readyDate},
      status = ${nextStatus},
      updated_at = NOW()
      WHERE id = ${open.id}
      RETURNING *`)[0];
    await Promise.all([
      logChange(q, { listingId: updated.id, field: 'price_toman', from: open.price_toman, to: input.price, by: input.by }),
      logChange(q, { listingId: updated.id, field: 'condition_text', from: open.condition_text, to: input.condition, by: input.by }),
      logChange(q, { listingId: updated.id, field: 'owner_id', from: open.owner_id, to: ownerId, by: input.by }),
      logChange(q, { listingId: updated.id, field: 'warehouse_id', from: open.warehouse_id, to: warehouseId, by: input.by }),
      logChange(q, { listingId: updated.id, field: 'document_ready_date', from: open.document_ready_date, to: readyDate, by: input.by }),
      logChange(q, { listingId: updated.id, field: 'status', from: open.status, to: nextStatus, by: input.by })
    ]);
    if (Number(open.price_toman) !== Number(input.price)) {
      await q`INSERT INTO price_history(listing_id, old_price_toman, new_price_toman, change_percent, reason, changed_by)
        VALUES(${updated.id}, ${open.price_toman}, ${input.price},
          ((${input.price}::numeric - ${open.price_toman}::numeric) / NULLIF(${open.price_toman}::numeric, 0)) * 100,
          'edit', ${input.by})`;
    }
    return { row: updated, mode: 'update' };
  }
  const [cycleRow, previousSoldRows] = await Promise.all([
    q`SELECT COALESCE(MAX(cycle_no), 0)::int AS cycle FROM listings WHERE phone_number = ${input.phone}`,
    q`SELECT id FROM listings WHERE phone_number = ${input.phone} AND status = 'sold' ORDER BY id DESC LIMIT 1`
  ]);
  const cycle = Number(cycleRow[0]?.cycle || 0) + 1;
  const previousSold = previousSoldRows[0];
  const inserted = (await q`INSERT INTO listings(
      phone_number, phone_display, prefix_code, price_toman, condition_text, payment_terms,
      cash_amount_toman, created_by, owner_id, warehouse_id, document_ready_date, status,
      cycle_no, period_started_at
    ) VALUES(
      ${input.phone}, ${input.displayPhone}, ${prefixCode(input.phone)}, ${input.price}, ${input.condition},
      'الباقی ۲ تا ۸ ماهه', ${cash}, ${input.by}, ${ownerId}, ${warehouseId}, ${readyDate}, 'active', ${cycle}, NOW()
    ) RETURNING *`)[0];
  await logChange(q, { listingId: inserted.id, field: 'created', from: null, to: input.phone, by: input.by });
  if (previousSold) {
    await logChange(q, { listingId: inserted.id, field: 'reregister', from: String(previousSold.id), to: String(inserted.id), by: input.by });
  }
  return { row: inserted, mode: 'create', reopened: Boolean(previousSold) };
}

export async function reserveListing(q, id, uid) {
  const rows = await q`UPDATE listings
    SET status = 'reserved', reserved_by = ${uid}, reserved_at = NOW(), reserved_until = NOW() + INTERVAL '1 hour', updated_at = NOW()
    WHERE id = ${id} AND status = 'active'
    RETURNING *`;
  if (!rows[0]) return null;
  await Promise.all([
    logChange(q, { listingId: id, field: 'reserve', from: 'active', to: `reserved:${uid}`, by: uid }),
    logChange(q, { listingId: id, field: 'status', from: 'active', to: 'reserved', by: uid })
  ]);
  return rows[0];
}

export async function releaseListing(q, id, uid, { field = 'reserve_release', isOwner = false } = {}) {
  const current = (await q`SELECT * FROM listings WHERE id = ${id} AND status = 'reserved' LIMIT 1`)[0];
  if (!current) return null;
  if (!canReleaseReservation(current, uid, isOwner)) return { denied: true };
  const rows = await q`
    UPDATE listings AS l
    SET status = 'active', reserved_by = NULL, reserved_at = NULL, reserved_until = NULL, updated_at = NOW()
    FROM (SELECT id, reserved_by FROM listings WHERE id = ${id} AND status = 'reserved') AS prev
    WHERE l.id = prev.id
    RETURNING l.*, prev.reserved_by AS prev_reserved_by`;
  const row = rows[0];
  if (!row) return null;
  const prevReservedBy = row.prev_reserved_by;
  delete row.prev_reserved_by;
  await Promise.all([
    logChange(q, { listingId: id, field, from: `reserved:${prevReservedBy || ''}`, to: 'active', by: uid }),
    logChange(q, { listingId: id, field: 'status', from: 'reserved', to: 'active', by: uid })
  ]);
  return row;
}

export async function sellListing(q, id, uid) {
  const due = saleDocumentDueFromReady(null, new Date());
  const rows = await q`
    UPDATE listings AS l
    SET status = 'sold',
        sold_at = NOW(),
        reserved_by = NULL,
        reserved_at = NULL,
        reserved_until = NULL,
        sale_document_status = 'pending',
        sale_document_due_date = COALESCE(l.document_ready_date, ${due}::date),
        sale_document_completed_at = NULL,
        sale_document_cycle = 0,
        sale_document_last_reminded_at = NULL,
        updated_at = NOW()
    FROM (
      SELECT id, status, reserved_by FROM listings
      WHERE id = ${id} AND status IN ('active', 'reserved', 'ready_transfer')
    ) AS prev
    WHERE l.id = prev.id
    RETURNING l.*, prev.status AS prev_status, prev.reserved_by AS prev_reserved_by`;
  const row = rows[0];
  if (!row) return null;
  const prevStatus = row.prev_status;
  const prevReservedBy = row.prev_reserved_by;
  delete row.prev_status;
  delete row.prev_reserved_by;
  const logs = [
    logChange(q, { listingId: id, field: 'sale', from: prevStatus, to: 'sold', by: uid }),
    logChange(q, { listingId: id, field: 'status', from: prevStatus, to: 'sold', by: uid }),
    logChange(q, { listingId: id, field: 'sale_document_due_date', from: null, to: row.sale_document_due_date, by: uid })
  ];
  if (prevStatus === 'reserved') {
    logs.unshift(logChange(q, { listingId: id, field: 'reserve_release', from: `reserved:${prevReservedBy || ''}`, to: 'sold', by: uid }));
  }
  await Promise.all(logs);
  return row;
}

export async function clearSoldNotice(q, tg, row) {
  if (!row?.id || !row.sold_reply_message_id) return row;
  await deleteChannelMessage(tg, row.channel_chat_id, row.sold_reply_message_id);
  await q`UPDATE listings SET sold_reply_message_id = NULL, updated_at = NOW() WHERE id = ${row.id}`;
  row.sold_reply_message_id = null;
  return row;
}

export async function unsellListing(q, id, uid) {
  const rows = await q`
    UPDATE listings
    SET status = 'active',
        sold_at = NULL,
        channel_cleaned_at = NULL,
        sale_document_status = NULL,
        sale_document_due_date = NULL,
        sale_document_completed_at = NULL,
        sale_document_cycle = 0,
        sale_document_last_reminded_at = NULL,
        updated_at = NOW()
    WHERE id = ${id} AND status = 'sold'
    RETURNING *`;
  const row = rows[0];
  if (!row) return null;
  await Promise.all([
    logChange(q, { listingId: id, field: 'sale_cancel', from: 'sold', to: 'active', by: uid }),
    logChange(q, { listingId: id, field: 'status', from: 'sold', to: 'active', by: uid })
  ]);
  return row;
}

export async function completeSaleDocument(q, id, uid) {
  const rows = await q`
    UPDATE listings
    SET sale_document_status = 'done',
        sale_document_completed_at = NOW(),
        updated_at = NOW()
    WHERE id = ${id}
      AND status = 'sold'
      AND COALESCE(sale_document_status, 'pending') <> 'done'
    RETURNING *`;
  const row = rows[0];
  if (!row) return null;
  await logChange(q, { listingId: id, field: 'sale_document_status', from: 'pending', to: 'done', by: uid });
  return row;
}

export async function delaySaleDocument(q, id, uid, days = 7) {
  const nextDue = plusDaysISO(days);
  const rows = await q`
    UPDATE listings AS l
    SET sale_document_cycle = COALESCE(l.sale_document_cycle, 0) + 1,
        sale_document_due_date = ${nextDue}::date,
        sale_document_last_reminded_at = NULL,
        updated_at = NOW()
    FROM (
      SELECT id, sale_document_due_date, sale_document_cycle
      FROM listings
      WHERE id = ${id}
        AND status = 'sold'
        AND COALESCE(sale_document_status, 'pending') <> 'done'
    ) AS prev
    WHERE l.id = prev.id
    RETURNING l.*, prev.sale_document_due_date AS prev_due`;
  const row = rows[0];
  if (!row) return null;
  const prevDue = row.prev_due;
  delete row.prev_due;
  await Promise.all([
    logChange(q, { listingId: id, field: 'sale_document_due_date', from: prevDue, to: row.sale_document_due_date, by: uid }),
    logChange(q, { listingId: id, field: 'sale_document_status', from: `cycle:${Number(row.sale_document_cycle) - 1}`, to: `delay:${row.sale_document_cycle}`, by: uid })
  ]);
  return row;
}

function saleDocumentLookupLine(row) {
  if (row.status !== 'sold') return '';
  if (row.sale_document_status === 'done') {
    const when = row.sale_document_completed_at ? ` (${displayDateTime(row.sale_document_completed_at)})` : '';
    return `سند فروش: تکمیل شد${when}`;
  }
  const due = row.sale_document_due_date ? displayJalali(row.sale_document_due_date) : '-';
  const delay = Number(row.sale_document_cycle) > 0 ? ` — تأخیر ${row.sale_document_cycle}` : '';
  return `موعد سند فروش: ${due}${delay}`;
}

export async function announceSold(q, tg, row) {
  if (row?.channel_chat_id && row?.channel_message_id) {
    const { texts, entities } = await loadChannelMessageBundles(q, settingValue);
    let replyText = texts.channel_msg_sold;
    let replyEntities = [...(entities.channel_msg_sold || [])];
    if (row.document_ready_date && isDocumentReadyDue(row.document_ready_date)) {
      const extra = texts.channel_msg_sold_document_ready;
      const extraStart = utf16Length(replyText) + utf16Length('\n');
      replyText += `\n${extra}`;
      for (const ent of entities.channel_msg_sold_document_ready || []) {
        replyEntities.push({ ...ent, offset: ent.offset + extraStart });
      }
    }
    const sent = await tg('sendMessage', {
      chat_id: row.channel_chat_id,
      reply_to_message_id: row.channel_message_id,
      ...sendMessagePayload(replyText, replyEntities)
    });
    if (sent?.ok) {
      await q`UPDATE listings SET sold_reply_message_id = ${sent.result.message_id} WHERE id = ${row.id}`;
      row.sold_reply_message_id = sent.result.message_id;
    }
  }
  return row;
}

export async function historyForPhone(q, phone) {
  return q`SELECT h.field_name, h.old_value, h.new_value, h.changed_at, h.changed_by, l.cycle_no, l.id AS listing_id
    FROM listing_history h
    JOIN listings l ON l.id = h.listing_id
    WHERE regexp_replace(COALESCE(l.phone_number, ''), '\\D', '', 'g') = ${phone}
    ORDER BY h.changed_at DESC
    LIMIT 30`;
}

export function historyLines(rows, ownerMap, warehouseMap) {
  if (!rows.length) return 'تاریخچه‌ای ثبت نشده است.';
  const valueOf = (field, value) => {
    if (value == null || value === '') return '-';
    if (field === 'owner_id') return ownerMap.get(String(value)) || String(value);
    if (field === 'warehouse_id') return warehouseMap.get(String(value)) || String(value);
    if (field === 'document_ready_date') return displayJalali(value);
    if (field === 'status') return { active: 'موجود', reserved: 'رزرو شده', sold: 'فروخته شده', inactive: 'غیرفعال', ready_transfer: 'آماده انتقال' }[value] || value;
    if (field === 'price_toman' || field === 'special_sale' || field === 'manual_discount') {
      const n = Number(value);
      if (Number.isFinite(n) && String(value).trim() !== '' && !String(value).includes('→')) return `${money(n)} تومان`;
    }
    return String(value);
  };
  return rows.map((row) => {
    const label = FIELD_LABELS[row.field_name] || row.field_name;
    const who = row.changed_by ? `کاربر ${row.changed_by}` : 'سیستم';
    return `دوره ${row.cycle_no || 1} — ${label}: ${valueOf(row.field_name, row.old_value)} ← ${valueOf(row.field_name, row.new_value)}\n${displayDateTime(row.changed_at)} — ${who}`;
  }).join('\n\n');
}

async function recordPriceChange(q, { listingId, oldPrice, newPrice, by, reason }) {
  if (Number(oldPrice) === Number(newPrice)) return;
  const oldN = Number(oldPrice);
  const newN = Number(newPrice);
  const pct = oldN ? ((newN - oldN) / oldN) * 100 : null;
  await Promise.all([
    logChange(q, { listingId, field: 'price_toman', from: oldPrice, to: newPrice, by }),
    q`INSERT INTO price_history(listing_id, old_price_toman, new_price_toman, change_percent, reason, changed_by)
      VALUES(${listingId}, ${oldPrice}, ${newPrice}, ${pct}, ${reason}, ${by})`
  ]);
}

export async function applyListingPriceChange(q, { listingId, newPrice, by, reason = 'edit' }) {
  const row = (await q`SELECT * FROM listings WHERE id = ${listingId} LIMIT 1`)[0];
  if (!row) return { ok: false, reason: 'NOT_FOUND' };
  if (!PRICE_CHANGE_STATUSES.includes(String(row.status))) return { ok: false, reason: 'STATUS' };
  const oldPrice = Number(row.price_toman);
  const next = Math.round(Number(newPrice));
  if (!Number.isFinite(next) || next < 1_000_000) return { ok: false, reason: 'INVALID' };
  if (next === oldPrice) return { ok: false, reason: 'UNCHANGED' };
  const cash = Math.floor(next / 3);
  const updated = (await q`UPDATE listings SET price_toman = ${next}, cash_amount_toman = ${cash}, updated_at = NOW() WHERE id = ${listingId} RETURNING *`)[0];
  await recordPriceChange(q, { listingId, oldPrice, newPrice: next, by, reason });
  return { ok: true, row: updated, oldPrice, newPrice: next };
}

export async function increaseListingPriceByPercent(q, { listingId, percent, by }) {
  const row = (await q`SELECT * FROM listings WHERE id = ${listingId} LIMIT 1`)[0];
  if (!row) return { ok: false, reason: 'NOT_FOUND' };
  const next = priceAfterPercentIncrease(row.price_toman, percent);
  if (!next) return { ok: false, reason: 'INVALID' };
  return applyListingPriceChange(q, { listingId, newPrice: next, by, reason: 'percent_increase' });
}

const MANUAL_DISCOUNT_STATUSES = ['active', 'reserved', 'ready_transfer'];

export async function applyManualListingDiscount(q, listingId, parsed, uid) {
  const row = (await q`SELECT * FROM listings WHERE id = ${listingId} LIMIT 1`)[0];
  if (!row) return { ok: false, reason: 'NOT_FOUND' };
  if (!MANUAL_DISCOUNT_STATUSES.includes(row.status)) return { ok: false, reason: 'STATUS' };
  const listPrice = listingListPriceToman(row);
  const newPrice = Math.round(Number(parsed.final));
  if (newPrice <= 0 || newPrice >= listPrice) return { ok: false, reason: 'INVALID' };
  const cash = Math.floor(newPrice / 3);
  const updated = (await q`UPDATE listings SET
      original_price_toman = ${listPrice},
      price_toman = ${newPrice},
      cash_amount_toman = ${cash},
      updated_at = NOW()
    WHERE id = ${listingId}
    RETURNING *`)[0];
  await Promise.all([
    logChange(q, {
      listingId,
      field: 'manual_discount',
      from: String(row.price_toman),
      to: `${listPrice}→${newPrice}`,
      by: uid
    }),
    recordPriceChange(q, { listingId, oldPrice: row.price_toman, newPrice, by: uid, reason: 'manual_discount' })
  ]);
  return { ok: true, row: updated, listPrice, newPrice, discount: listPrice - newPrice };
}

export async function clearManualListingDiscount(q, listingId, uid) {
  const row = (await q`SELECT * FROM listings WHERE id = ${listingId} LIMIT 1`)[0];
  if (!row) return { ok: false, reason: 'NOT_FOUND' };
  const listPrice = listingListPriceToman(row);
  if (listPrice <= Number(row.price_toman)) return { ok: false, reason: 'NONE' };
  const cash = Math.floor(listPrice / 3);
  const updated = (await q`UPDATE listings SET
      price_toman = ${listPrice},
      original_price_toman = NULL,
      cash_amount_toman = ${cash},
      updated_at = NOW()
    WHERE id = ${listingId}
    RETURNING *`)[0];
  await Promise.all([
    logChange(q, {
      listingId,
      field: 'manual_discount',
      from: String(row.price_toman),
      to: String(listPrice),
      by: uid
    }),
    recordPriceChange(q, { listingId, oldPrice: row.price_toman, newPrice: listPrice, by: uid, reason: 'clear_discount' })
  ]);
  return { ok: true, row: updated };
}

export async function applySpecialSale(q, row) {
  const price = specialPrice(row.price_toman);
  const updated = (await q`UPDATE listings SET
      original_price_toman = COALESCE(original_price_toman, price_toman),
      price_toman = ${price},
      cash_amount_toman = ${Math.floor(price / 3)},
      special_sale_applied_at = NOW(),
      updated_at = NOW()
    WHERE id = ${row.id} AND status = 'active' AND special_sale_applied_at IS NULL
    RETURNING *`)[0];
  if (!updated) return null;
  await Promise.all([
    logChange(q, { listingId: row.id, field: 'special_sale', from: row.price_toman, to: price, by: null }),
    recordPriceChange(q, { listingId: row.id, oldPrice: row.price_toman, newPrice: price, by: null, reason: 'special_sale' })
  ]);
  return updated;
}

/** متن قیمت برای تأیید فاکتور (با تخفیف فروش ویژه در صورت وجود) */
export function invoiceDraftPriceSummary(draft, listing, inst) {
  const { price, discount, final } = invoiceDiscount(listing);
  const amounts = invoiceMath({
    price,
    discount,
    saleType: draft.sale_type,
    months: draft.months,
    percent: draft.cash_percent ?? inst.defaultPercent,
    interest: inst.interestPercentMonthly,
    roundToman: inst.roundToman
  });
  const lines = [];
  if (discount > 0) {
    lines.push(`قیمت خط: ${money(price)} تومان`);
    lines.push(`تخفیف: ${money(discount)} تومان`);
  }
  lines.push(`قیمت نهایی: ${money(amounts.final)} تومان`);
  if (draft.sale_type === 'installment') {
    lines.push(`پیش‌پرداخت (${draft.cash_percent ?? inst.defaultPercent}%): ${money(amounts.cash)} تومان`);
    if (amounts.months) {
      lines.push(`هر قسط (${amounts.months} ماه): ${money(amounts.monthly)} تومان`);
    }
  }
  return lines.join('\n');
}

export async function buildInvoice(q, draft, listing, uid) {
  const existing = (await q`SELECT * FROM invoices WHERE listing_id = ${listing.id} LIMIT 1`)[0];
  if (existing) return { invoice: existing, created: false };
  const inst = await getInstallmentConfig(q);
  const interest = inst.interestPercentMonthly;
  const storeName = (await q`SELECT value FROM settings WHERE key = 'store_name' LIMIT 1`)[0]?.value || 'سامی';
  const storePhone = (await q`SELECT value FROM settings WHERE key = 'store_phone' LIMIT 1`)[0]?.value || '';
  const storeAddressRaw = (await q`SELECT value FROM settings WHERE key = 'store_address' LIMIT 1`)[0]?.value || '';
  const storeAddress = resolveStoreAddressForInvoice(storeAddressRaw);
  const discount = invoiceDiscount(listing);
  const amounts = invoiceMath({
    ...discount,
    saleType: draft.sale_type,
    months: draft.months,
    percent: draft.cash_percent || inst.defaultPercent,
    interest,
    roundToman: inst.roundToman
  });
  const year = jalaliParts(new Date()).year;
  const last = (await q`SELECT invoice_number FROM invoices ORDER BY id DESC LIMIT 1`)[0]?.invoice_number;
  const invoiceNumber = nextInvoiceNumber(last, year);
  const { invoicePdf } = await import('../invoice/pdf.js');
  const pdf = await invoicePdf({
    invoice_number: invoiceNumber,
    created_at: new Date(),
    store_name: storeName,
    store_phone: storePhone,
    store_address: storeAddress,
    customer_name: draft.customer_name,
    national_id: draft.national_id,
    customer_phone: draft.customer_phone,
    birth_date: draft.birth_date,
    address: draft.address,
    phone_display: listing.phone_display,
    phone_number: listing.phone_number,
    condition_text: listing.condition_text,
    sale_type: draft.sale_type,
    price_toman: amounts.price,
    discount_toman: amounts.discount,
    final_toman: amounts.final,
    cash_amount_toman: amounts.cash,
    months: amounts.months,
    monthly_installment_toman: amounts.monthly,
    total_installment_toman: amounts.totalInstallment
  });
  const saved = (await q`INSERT INTO invoices(
      invoice_number, listing_id, customer_name, national_id, customer_phone, address, birth_date,
      sale_type, price_toman, discount_toman, final_toman, months, cash_amount_toman,
      monthly_installment_toman, total_installment_toman, store_name, store_phone, store_address,
      pdf_base64, created_by
    ) VALUES(
      ${invoiceNumber}, ${listing.id}, ${draft.customer_name}, ${draft.national_id}, ${draft.customer_phone},
      ${draft.address}, ${draft.birth_date}, ${draft.sale_type}, ${amounts.price}, ${amounts.discount},
      ${amounts.final}, ${amounts.months}, ${amounts.cash}, ${amounts.monthly}, ${amounts.totalInstallment},
      ${storeName}, ${storePhone}, ${storeAddress}, ${pdf.toString('base64')}, ${uid}
    ) RETURNING *`)[0];
  return { invoice: saved, created: true };
}

async function listingsForPriceScope(q, scope) {
  if (scope === 'active') {
    return q`SELECT id, phone_number, price_toman, status FROM listings
      WHERE status = 'active' AND COALESCE(price_toman, 0) > 0`;
  }
  if (scope === 'open') {
    return q`SELECT id, phone_number, price_toman, status FROM listings
      WHERE status IN ('active', 'reserved', 'ready_transfer') AND COALESCE(price_toman, 0) > 0`;
  }
  return q`SELECT id, phone_number, price_toman, status FROM listings
    WHERE status IN ('active', 'reserved', 'ready_transfer', 'inactive') AND COALESCE(price_toman, 0) > 0`;
}

export async function previewPriceIncrease(q, { percent, scope }) {
  const rows = await listingsForPriceScope(q, scope);
  let changed = 0;
  for (const row of rows) {
    const next = priceAfterPercentIncrease(row.price_toman, percent);
    if (next && next !== Number(row.price_toman)) changed += 1;
  }
  return { total: rows.length, changed };
}

export async function notifyPurchaseRequestStaff(send, { chatIds, text, replyMarkup }) {
  let sent = 0;
  for (const chat_id of chatIds) {
    const result = await send('sendMessage', { chat_id, text, reply_markup: replyMarkup });
    if (result?.ok !== false) sent += 1;
    else console.error('purchase_request_notify_failed', chat_id, result?.description || result?.error_code || result);
  }
  return sent;
}

export async function increaseListingPricesByPercent(q, { percent, scope, by }) {
  const pct = Number(percent);
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) throw new Error('INVALID_PERCENT');
  const rows = await listingsForPriceScope(q, scope);
  const updated = [];
  for (const row of rows) {
    const oldPrice = Number(row.price_toman);
    const newPrice = priceAfterPercentIncrease(oldPrice, pct);
    if (!newPrice || newPrice === oldPrice) continue;
    const applied = await applyListingPriceChange(q, { listingId: row.id, newPrice, by, reason: 'percent_increase' });
    if (!applied.ok) continue;
    updated.push({ id: row.id, phone: row.phone_number, oldPrice, newPrice, status: row.status });
  }
  return { updated, count: updated.length };
}

export function lookupText(row) {
  const reserved = row.status === 'reserved'
    ? `${displayDateTime(row.reserved_until)} — ${row.reserver_name || row.reserved_by || '-'}`
    : '-';
  return [
    `سیم‌کارت دوره ${row.cycle_no || 1}`,
    formatPhoneDisplay(row.phone_number, row.phone_display),
    '',
    (() => {
      const p = formatListingPricePlain(row);
      return p.includes('\n') ? p : `قیمت: ${p}`;
    })(),
    row.special_sale_applied_at ? 'فروش ویژه: فعال' : 'فروش ویژه: ندارد',
    `وضعیت: ${{ active: 'موجود', reserved: 'رزرو شده', sold: 'فروخته شده', inactive: 'غیرفعال', ready_transfer: 'آماده انتقال' }[row.status] || row.status}`,
    `مالک: ${row.owner_name || '-'}`,
    `انبار: ${row.warehouse_name || '-'}`,
    `تاریخ سند: ${documentReadyLabel(row.document_ready_date)}`,
    saleDocumentLookupLine(row),
    `رزرو: ${reserved}`,
    `شروع دوره: ${displayDateTime(row.period_started_at)}`,
    row.sold_at ? `زمان فروش: ${displayDateTime(row.sold_at)}` : ''
  ].filter(Boolean).join('\n');
}

export async function settingValue(q, key, fallback = null) {
  const rows = await q`SELECT value FROM settings WHERE key = ${key} LIMIT 1`;
  return rows[0]?.value ?? fallback;
}

export async function putSetting(q, key, value) {
  await q`INSERT INTO settings(key, value) VALUES(${key}, ${String(value)})
    ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`;
}
