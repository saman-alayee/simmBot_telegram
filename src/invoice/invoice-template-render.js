import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import { invoiceTemplateContext, invoiceTemplatePaths } from './invoice-template.js';

const fontPath = fileURLToPath(new URL('../fonts/Vazirmatn-Regular.ttf', import.meta.url));
GlobalFonts.registerFromPath(fontPath, 'Vazir');

/** عرض A4 در پیکسل (۲۱۰mm) */
const W = 1240;
const H = Math.round(W * (297 / 210));
const PAD_H = mm(7);
const PAD_V = mm(8);
const INNER = W - PAD_H * 2;

/** همان نسبت‌های invoice-template.html */
const COL_FR = [0.1, 0.57, 0.13, 0.2];
const ROW_NO = ['۱', '۲', '۳', '۴', '۵', '۶', '۷'];
const ITEM_BODY_ROWS = 7;

function mm(value) {
  return (value / 210) * W;
}

function strokeBox(ctx, x, y, w, h, color = '#222', width = 2) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.strokeRect(x, y, w, h);
}

function fillBox(ctx, x, y, w, h, color = '#fff') {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

function setFont(ctx, size, bold = false) {
  ctx.font = `${bold ? 'bold ' : ''}${size}px Vazir`;
}

function colLeft(x0, colIndex) {
  let x = x0;
  for (let i = 0; i < colIndex; i += 1) x += INNER * COL_FR[i];
  return x;
}

function colWidth(colIndex) {
  return INNER * COL_FR[colIndex];
}

function colSpanWidth(colStart, span) {
  let w = 0;
  for (let i = 0; i < span; i += 1) w += INNER * COL_FR[colStart + i];
  return w;
}

function drawColDividers(ctx, x0, y, h) {
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1.5;
  for (let c = 1; c < COL_FR.length; c += 1) {
    const x = colLeft(x0, c);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y + h);
    ctx.stroke();
  }
}

function hLine(ctx, x0, y, w) {
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(x0 + w, y);
  ctx.stroke();
}

function textInCell(ctx, x, y, w, h, text, { align = 'right', size = 18, bold = false, pad = mm(2), color = '#111' } = {}) {
  setFont(ctx, size, bold);
  ctx.direction = 'rtl';
  ctx.fillStyle = color;
  const maxW = Math.max(0, w - pad * 2);
  const ty = y + h / 2 + size * 0.42;
  if (align === 'center') {
    ctx.textAlign = 'center';
    ctx.fillText(String(text ?? ''), x + w / 2, ty, maxW);
  } else if (align === 'left') {
    ctx.textAlign = 'left';
    ctx.fillText(String(text ?? ''), x + pad, ty, maxW);
  } else {
    ctx.textAlign = 'right';
    ctx.fillText(String(text ?? ''), x + w - pad, ty, maxW);
  }
}

function wrapLines(ctx, str, maxWidth) {
  const words = String(str ?? '').split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : ['-'];
}

function drawRtlLines(ctx, rightX, topY, maxWidth, lines, { size = 18, bold = false, color = '#111', lineGap = mm(1.2) } = {}) {
  setFont(ctx, size, bold);
  ctx.direction = 'rtl';
  ctx.textAlign = 'right';
  ctx.fillStyle = color;
  let y = topY + size;
  for (const line of lines) {
    ctx.fillText(line, rightX, y, maxWidth);
    y += size + lineGap;
  }
  return y;
}

/** متن لatin/عدد — جهت LTR، تراز راست داخل بلوک فروشنده */
function drawLtrLines(ctx, rightX, topY, maxWidth, lines, { size = 18, bold = false, color = '#111', lineGap = mm(0.8) } = {}) {
  setFont(ctx, size, bold);
  ctx.direction = 'ltr';
  ctx.textAlign = 'right';
  ctx.fillStyle = color;
  let y = topY + size;
  for (const line of lines) {
    ctx.fillText(String(line ?? ''), rightX, y, maxWidth);
    y += size + lineGap;
  }
  return y;
}

/** label سمت راست، کادر مقدار سمت چپ (مثل .field در HTML) */
function drawField(ctx, right, top, totalW, label, value, { labelSize = 17, valueSize = 17, boxH = mm(7) } = {}) {
  const gap = mm(2);
  setFont(ctx, labelSize, true);
  ctx.direction = 'rtl';
  const labelW = Math.min(ctx.measureText(label).width + mm(2), totalW * 0.42);
  const boxW = Math.max(mm(12), totalW - labelW - gap);
  const boxX = right - totalW;
  const boxY = top + mm(3);
  strokeBox(ctx, boxX, boxY, boxW, boxH, '#777', 1);
  textInCell(ctx, boxX, boxY, boxW, boxH, value, { align: 'right', size: valueSize, pad: mm(1.5) });
  textInCell(ctx, boxX + boxW + gap, top, labelW, boxH + mm(4), label, { align: 'right', size: labelSize, bold: true });
}

/** هر سلول جدا کادر می‌شود تا colspan خط عمودی وسط متن نگذارد */
function drawRowCells(ctx, x0, y, rowH, segments, { border = '#333' } = {}) {
  let col = 0;
  let x = x0;
  for (const seg of segments) {
    const span = seg.colspan || 1;
    const segW = colSpanWidth(col, span);
    strokeBox(ctx, x, y, segW, rowH, border, 1.5);
    if (seg.text != null && seg.text !== '') {
      textInCell(ctx, x, y, segW, rowH, seg.text, {
        align: seg.align || 'right',
        size: seg.size || 18,
        bold: seg.bold || false
      });
    }
    x += segW;
    col += span;
  }
}

function drawItemsTable(ctx, x0, y, rowH, ctxData) {
  const headerRows = 1;
  const bodyRows = ITEM_BODY_ROWS;
  const tableH = rowH * (headerRows + bodyRows);
  strokeBox(ctx, x0, y, INNER, tableH, '#333', 1.5);
  drawColDividers(ctx, x0, y, tableH);

  ctx.fillStyle = '#e9e9e9';
  ctx.fillRect(x0, y, INNER, rowH);
  textInCell(ctx, colLeft(x0, 0), y, colWidth(0), rowH, 'ردیف', { align: 'center', size: 20, bold: true });
  textInCell(ctx, colLeft(x0, 1), y, colWidth(1), rowH, 'نام کالا', { align: 'center', size: 20, bold: true });
  textInCell(ctx, colLeft(x0, 2), y, colWidth(2), rowH, 'تعداد', { align: 'center', size: 20, bold: true });
  textInCell(ctx, colLeft(x0, 3), y, colWidth(3), rowH, 'قیمت واحد', { align: 'center', size: 20, bold: true });
  hLine(ctx, x0, y + rowH, INNER);

  let rowY = y + rowH;
  const firstRow = [ROW_NO[0], ctxData.product_name, ctxData.quantity, ctxData.unit_price];
  for (let r = 0; r < bodyRows; r += 1) {
    const cells = r === 0
      ? firstRow
      : [ROW_NO[r], '', '', ''];
    for (let c = 0; c < 4; c += 1) {
      textInCell(ctx, colLeft(x0, c), rowY, colWidth(c), rowH, cells[c], {
        align: c === 1 ? 'right' : 'center',
        size: 18
      });
    }
    rowY += rowH;
    if (r < bodyRows - 1) hLine(ctx, x0, rowY, INNER);
  }
  return y + tableH;
}

function drawSummaryTable(ctx, x0, y, rowH, ctxData) {
  const summary = [
    [
      { colspan: 2, text: `جمع تعداد: ${ctxData.total_quantity}`, bold: true },
      { text: 'سود خرید شما', align: 'center', bold: true },
      { text: '۰', align: 'center' }
    ],
    [
      { colspan: 3, text: 'ارزش افزوده', align: 'center', bold: true },
      { text: '۰', align: 'center' }
    ],
    [
      { text: 'جمع فاکتور به حروف:', bold: true },
      { colspan: 2, text: ctxData.total_words, align: 'center', size: 17 },
      { text: ctxData.total_amount, align: 'center', bold: true }
    ],
    [
      { text: 'مجموع کل قابل پرداخت', bold: true },
      { colspan: 3, text: ctxData.total_amount, align: 'center', size: 20, bold: true }
    ],
    [
      { text: 'مانده حساب با احتساب این فاکتور', bold: true },
      { colspan: 2, text: ctxData.account_balance, align: 'center' },
      { text: 'بدهکار / بستانکار', align: 'center', bold: true }
    ]
  ];

  let rowY = y;
  for (const row of summary) {
    drawRowCells(ctx, x0, rowY, rowH, row);
    rowY += rowH;
  }
  return rowY;
}

export async function renderInvoiceTemplatePng(invoice) {
  const ctxData = invoiceTemplateContext(invoice);
  const { logo } = invoiceTemplatePaths();

  const rowH = mm(9);
  const headerH = mm(46);
  const metaH = mm(50);
  const lowerH = mm(20);
  const descH = mm(64);
  const gap = mm(2.5);

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  fillBox(ctx, 0, 0, W, H);

  const x0 = PAD_H;
  let y = PAD_V;

  strokeBox(ctx, x0, y, INNER, headerH);
  const brandW = INNER * 0.42;
  ctx.beginPath();
  ctx.moveTo(x0 + brandW, y);
  ctx.lineTo(x0 + brandW, y + headerH);
  ctx.stroke();

  try {
    const img = await loadImage(logo);
    const maxW = brandW - mm(8);
    const maxH = mm(31);
    const scale = Math.min(maxW / img.width, maxH / img.height, 1);
    const iw = img.width * scale;
    const ih = img.height * scale;
    ctx.drawImage(img, x0 + (brandW - iw) / 2, y + (headerH - ih) / 2, iw, ih);
  } catch {
    setFont(ctx, 28, true);
    ctx.direction = 'ltr';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#111';
    ctx.fillText('Samiito', x0 + brandW / 2, y + headerH / 2);
  }

  const storeX = x0 + brandW + mm(3);
  const storeW = INNER - brandW - mm(6);
  const storePad = mm(5);
  const textRight = storeX + storeW - storePad;
  const textW = storeW - storePad * 2;

  textInCell(ctx, storeX, y + mm(3), storeW, mm(8), ctxData.store_title, { align: 'right', size: 28, bold: true, pad: storePad });
  textInCell(ctx, x0, y + mm(11), INNER, mm(8), 'فاکتور فروش', { align: 'center', size: 28, bold: true });

  let blockY = y + mm(16);
  blockY = drawRtlLines(ctx, textRight, blockY, textW, ['آدرس ما:'], { size: 17, bold: true, lineGap: mm(0.3) });
  setFont(ctx, 18, false);
  const addrLines = wrapLines(ctx, String(ctxData.store_address ?? ''), textW);
  blockY = drawRtlLines(ctx, textRight, blockY, textW, addrLines, { size: 18, bold: false, lineGap: mm(0.9) });

  const webPlain = ctxData.store_web_plain || String(ctxData.store_web || '').replace(/[\u2066\u2069]/g, '');
  drawLtrLines(ctx, textRight, blockY + mm(1), textW, [webPlain], {
    size: 20,
    bold: true,
    color: '#1260d8',
    lineGap: mm(0.4)
  });

  y += headerH + gap;
  strokeBox(ctx, x0, y, INNER, metaH);

  const dateW = INNER * 0.28;
  const dateRight = x0 + INNER - mm(2);
  textInCell(ctx, dateRight - dateW, y + mm(3), dateW, mm(8), `تاریخ: ${ctxData.invoice_date}`, { align: 'right', size: 22, bold: true });
  textInCell(ctx, dateRight - dateW, y + mm(11), dateW, mm(8), `ساعت: ${ctxData.invoice_time}`, { align: 'right', size: 22, bold: true });

  const invFieldW = mm(43) + mm(38);
  drawField(ctx, x0 + mm(4) + invFieldW, y + mm(2), invFieldW, 'شماره فاکتور:', ctxData.invoice_number, { labelSize: 16, valueSize: 18 });

  const custRight = dateRight - dateW - mm(2);
  const custW = custRight - x0 - mm(2);
  fillBox(ctx, x0 + mm(2), y + mm(3), mm(32), mm(8), '#174b7d');
  textInCell(ctx, x0 + mm(2), y + mm(3), mm(32), mm(8), 'مشخصات مشتری', { align: 'center', size: 19, bold: true, color: '#fff' });

  const colW = (custW - mm(3)) / 2;
  const gridRight = custRight;
  let rowY = y + mm(12);
  const step = mm(10.5);
  drawField(ctx, gridRight, rowY, colW, 'نام و نام خانوادگی:', ctxData.customer_name, { boxH: mm(7) });
  drawField(ctx, gridRight - colW - mm(3), rowY, colW, 'کد ملی:', ctxData.national_id, { boxH: mm(7) });
  rowY += step;
  drawField(ctx, gridRight, rowY, colW, 'شماره تماس:', ctxData.customer_phone, { boxH: mm(7) });
  drawField(ctx, gridRight - colW - mm(3), rowY, colW, 'تاریخ تولد:', ctxData.birth_date, { boxH: mm(7) });
  rowY += step;
  drawField(ctx, gridRight, rowY, custW, 'آدرس:', ctxData.customer_address, { boxH: mm(11), valueSize: 16 });

  y += metaH + gap;
  y = drawItemsTable(ctx, x0, y, rowH, ctxData);
  y += gap;
  y = drawSummaryTable(ctx, x0, y, rowH, ctxData);

  y += gap;
  const half = INNER / 2;
  strokeBox(ctx, x0, y, half, lowerH, '#333', 1.5);
  strokeBox(ctx, x0 + half, y, half, lowerH, '#333', 1.5);
  textInCell(ctx, x0, y, half, lowerH, `مسئول فروش این فاکتور: ${ctxData.salesperson}`, { align: 'right', size: 20, pad: mm(3) });
  textInCell(ctx, x0 + half, y, half, lowerH, `نحوه پرداخت: ${ctxData.payment_method}`, { align: 'right', size: 20, pad: mm(3) });

  y += lowerH + gap;
  strokeBox(ctx, x0, y, INNER, descH);
  textInCell(ctx, x0, y + mm(2), INNER, mm(8), 'توضیحات:', { align: 'right', size: 22, bold: true, pad: mm(3) });
  const descLines = String(ctxData.description).split('\n');
  let dy = y + mm(11);
  setFont(ctx, 18);
  ctx.direction = 'rtl';
  ctx.textAlign = 'right';
  ctx.fillStyle = '#111';
  for (const line of descLines) {
    for (const wrapped of wrapLines(ctx, line, INNER - mm(10))) {
      ctx.fillText(wrapped, x0 + INNER - mm(4), dy);
      dy += mm(5);
    }
  }
  textInCell(ctx, x0, y + descH - mm(16), INNER - mm(5), mm(8), 'کالای فاکتور فوق دریافت گردید.', { align: 'right', size: 20, bold: true });
  textInCell(ctx, x0, y + descH - mm(8), INNER - mm(5), mm(8), 'امضا مشتری گرامی: ____________________', { align: 'right', size: 20, bold: true });

  return canvas.toBuffer('image/png');
}
