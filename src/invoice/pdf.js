import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'node:url';
import { displayJalali, formatPhoneDigits, money, statusLabel, toLatinDigits } from '../domain/format.js';

const fontPath = fileURLToPath(new URL('../fonts/Vazirmatn-Regular.ttf', import.meta.url));
GlobalFonts.registerFromPath(fontPath, 'Vazir');

const PAGE_WIDTH = 1240;
const PAGE_HEIGHT = 1754;

function canvasToPdf(pages) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    for (const page of pages) {
      doc.addPage({ size: 'A4', margin: 0 });
      doc.image(page, 0, 0, { width: doc.page.width, height: doc.page.height });
    }
    doc.end();
  });
}

function startPage(title) {
  const canvas = createCanvas(PAGE_WIDTH, PAGE_HEIGHT);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, PAGE_WIDTH, PAGE_HEIGHT);
  ctx.direction = 'rtl';
  ctx.textAlign = 'right';
  ctx.fillStyle = '#111111';
  ctx.font = 'bold 42px Vazir';
  ctx.fillText(title, PAGE_WIDTH - 70, 90);
  ctx.strokeStyle = '#111111';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(70, 120);
  ctx.lineTo(PAGE_WIDTH - 70, 120);
  ctx.stroke();
  return { canvas, ctx, y: 170 };
}

function phoneForPdf(phoneNumber, phoneDisplay) {
  const digits = toLatinDigits(phoneNumber).replace(/\D/g, '');
  return formatPhoneDigits(digits) || phoneDisplay || phoneNumber || '-';
}

function line(ctx, label, value, y) {
  ctx.font = '28px Vazir';
  ctx.fillStyle = '#222222';
  ctx.fillText(`${label}: \u200E${value || '-'}`, PAGE_WIDTH - 70, y);
  return y + 48;
}

export async function invoicePng(invoice) {
  const { renderInvoiceTemplatePng } = await import('./invoice-template-render.js');
  return renderInvoiceTemplatePng(invoice);
}

export async function invoicePdf(invoice) {
  const png = await invoicePng(invoice);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ autoFirstPage: false });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.addPage({ size: 'A4', margin: 0 });
    doc.image(png, 0, 0, { fit: [doc.page.width, doc.page.height], align: 'center', valign: 'top' });
    doc.end();
  });
}

export async function linesPdf(rows, filters) {
  const pages = [];
  const pageSize = 24;
  const chunks = rows.length ? rows : [];
  const totalPages = Math.max(1, Math.ceil(chunks.length / pageSize));
  for (let pageNo = 0; pageNo < totalPages; pageNo += 1) {
    const page = startPage('لیست خطوط');
    const { ctx } = page;
    let y = line(ctx, 'فیلتر', filters || 'همه', page.y);
    y = line(ctx, 'صفحه', `${pageNo + 1} از ${totalPages}`, y);
    y += 10;
    const slice = chunks.slice(pageNo * pageSize, (pageNo + 1) * pageSize);
    ctx.font = '24px Vazir';
    if (!slice.length) ctx.fillText('خطی برای این فیلتر نیست.', PAGE_WIDTH - 70, y);
    for (const row of slice) {
      const text = `\u200E${phoneForPdf(row.phone_number, row.phone_display)}  |  ${money(row.price_toman)} تومان  |  ${statusLabel(row.status)}  |  ${row.owner_name || '-'}  |  ${row.warehouse_name || '-'}`;
      ctx.fillText(text, PAGE_WIDTH - 70, y);
      y += 52;
    }
    pages.push(page.canvas.toBuffer('image/png'));
  }
  return canvasToPdf(pages);
}
