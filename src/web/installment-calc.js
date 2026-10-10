import { botLinkUsername, esc, formatPhoneDigits, toLatinDigits } from '../domain/format.js';
import { DEFAULT_INSTALLMENT } from '../domain/installment-config.js';

export function calcPageHtml(row, config, bot) {
  const inst = config || DEFAULT_INSTALLMENT;
  const price = Number(row.price_toman);
  const digits = toLatinDigits(row.phone_number).replace(/\D/g, '');
  const phone = formatPhoneDigits(digits) || row.phone_display || row.phone_number;
  const percents = inst.percentOptions.map((value) => `<button class="p" data-p="${value}">${value}%</button>`).join('');
  const months = inst.monthOptions.map((month) => `<button class="m" data-m="${month}">${month} ماه</button>`).join('');
  const round = Number(inst.roundToman) || 50_000;
  const interest = Number(inst.interestPercentMonthly) || 5;
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>خرید اقساطی سامی</title><style>body{font-family:Tahoma,Arial,sans-serif;background:#f6f7f9;padding:18px}.card{max-width:540px;margin:auto;background:#fff;border-radius:22px;padding:22px;box-shadow:0 8px 30px #0001}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:9px}.p,.m,.buy{border:0;border-radius:12px;padding:13px;font-weight:700;cursor:pointer}.p,.m{background:#eee}.active{background:#111!important;color:#fff}.result{margin-top:18px;padding:18px;background:#f0f7ff;border-radius:16px;line-height:2}.buy{width:100%;margin-top:15px;background:#111;color:#fff;font-size:17px}.muted{color:#666}</style></head><body><div class="card"><h2>خرید اقساطی</h2><div>شماره: <b dir="ltr">${esc(phone)}</b></div><h2>${price.toLocaleString('fa-IR')} تومان</h2><p>پیش‌پرداخت را انتخاب کنید:</p><div class="grid">${percents}</div><p>مدت اقساط:</p><div class="grid">${months}</div><div id="result" class="result">ابتدا پیش‌پرداخت و مدت را انتخاب کنید.</div><button id="buy" class="buy" disabled>درخواست خرید اقساطی</button><p class="muted">سود ماهانه ${interest}٪ — گرد قسط ${round.toLocaleString('fa-IR')} تومان</p></div><script>
let pct=null,months=null;const price=${price},interest=${interest},round=${round},id=${Number(row.id)},bot=${JSON.stringify(bot)};function calc(){if(!pct||!months)return;const cash=Math.floor(price*pct/100),bal=price-cash,total=bal*(1+interest/100*months),monthly=Math.ceil(total/months/round)*round;document.querySelector('#result').innerHTML='پیش‌پرداخت: <b>'+cash.toLocaleString('fa-IR')+' تومان</b><br>باقی‌مانده: '+bal.toLocaleString('fa-IR')+' تومان<br>هر قسط: <b>'+monthly.toLocaleString('fa-IR')+' تومان</b><br>جمع اقساط: '+(monthly*months).toLocaleString('fa-IR')+' تومان';document.querySelector('#buy').disabled=false;}document.querySelectorAll('.p').forEach(b=>b.onclick=()=>{document.querySelectorAll('.p').forEach(x=>x.classList.remove('active'));b.classList.add('active');pct=+b.dataset.p;calc()});document.querySelectorAll('.m').forEach(b=>b.onclick=()=>{document.querySelectorAll('.m').forEach(x=>x.classList.remove('active'));b.classList.add('active');months=+b.dataset.m;calc()});document.querySelector('#buy').onclick=()=>location.href='https://t.me/'+bot+'?start=buy_'+id+'_'+months+'_'+pct;</script></div></body></html>`;
}

export { botLinkUsername };
