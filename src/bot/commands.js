/** @typedef {{ command: string, description: string }} BotCommand */

/** @param {BotCommand} item */
function cmd(command, description) {
  return { command, description: String(description).slice(0, 256) };
}

/** دستورات پیشنهادی برای مشتری / کاربر عادی */
export function customerBotCommands() {
  return [
    cmd('start', 'شروع و راهنمای کانال'),
    cmd('cancel', 'لغو درخواست ناتمام')
  ];
}

/**
 * دستورات پیشنهادی برای مالک ربات و ادمین (بر اساس دسترسی)
 * @param {{ isOwner?: boolean, isStaff?: boolean, allow: (key: string) => boolean }} actor
 */
export function staffBotCommands(actor) {
  /** @type {BotCommand[]} */
  const list = [
    cmd('start', 'باز کردن منوی مدیریت'),
    cmd('guide', 'راهنمای کامل کار با ربات'),
    cmd('cancel', 'لغو ثبت، فاکتور یا کار ناتمام'),
    cmd('close', 'بستن منوی پایین'),
    cmd('menu', 'همان close — بستن منو'),
    cmd('id', 'نمایش شناسه تلگرام شما')
  ];
  if (actor.allow('add_listing')) {
    list.push(cmd('excel', 'دریافت قالب ورود اکسل'));
  }
  if (actor.allow('lookup')) {
    list.push(cmd('openlines', 'لیست خطوط موجود / رزرو / آماده انتقال'));
    list.push(cmd('lookup', 'استعلام خط — بعدش شماره 0912…'));
  }
  if (actor.allow('history')) {
    list.push(cmd('history', 'تاریخچه خط — بعدش شماره'));
  }
  if (actor.allow('invoices')) {
    list.push(cmd('invoices', 'آخرین فاکتورها'));
    list.push(cmd('invoice', 'جستجوی فاکتور — شماره یا کد ملی'),
      cmd('customer', 'سوابق خرید مشتری — کد ملی یا موبایل'));
  }
  if (actor.allow('owners')) list.push(cmd('owners', 'لیست مالکین خطوط'));
  if (actor.allow('warehouses')) list.push(cmd('warehouses', 'لیست انبارها'));
  if (actor.allow('settings') || actor.isOwner) {
    list.push(cmd('toggleinstallment', 'فعال/غیرفعال فروش اقساطی'));
    list.push(cmd('priceup', 'افزایش درصدی قیمت — مثال: priceup 5'));
  }
  if (actor.allow('admin_management') || actor.isOwner) {
    list.push(cmd('admins', 'لیست ادمین‌ها'),
      cmd('setadmin', 'ثبت ادمین — اسلات و آیدی'));
  }
  if (actor.isOwner || actor.allow('partners')) {
    list.push(cmd('partners', 'لیست همکاران'));
  }
  if (actor.isOwner) {
    list.push(
      cmd('addowner', 'افزودن مالک خط — بعدش نام'),
      cmd('addwarehouse', 'افزودن انبار — بعدش نام'),
      cmd('setstorename', 'نام فروشگاه روی فاکتور'),
      cmd('setstorephone', 'تلفن فروشگاه'),
      cmd('setstoreaddress', 'آدرس فروشگاه')
    );
  }
  return list;
}

/**
 * @param {(method: string, body: object) => Promise<{ ok?: boolean }>} callTelegram
 */
export async function syncDefaultBotCommands(callTelegram) {
  return callTelegram('setMyCommands', {
    commands: customerBotCommands(),
    scope: { type: 'default' }
  });
}

/**
 * لیست پیشنهادی «/» برای همین چت خصوصی
 * @param {(method: string, body: object) => Promise<{ ok?: boolean }>} callTelegram
 */
export async function syncBotCommandsForChat(callTelegram, chatId, actor) {
  const commands = actor?.isStaff ? staffBotCommands(actor) : customerBotCommands();
  return callTelegram('setMyCommands', {
    commands,
    scope: { type: 'chat', chat_id: Number(chatId) }
  });
}
