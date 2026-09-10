#!/usr/bin/env node
/**
 * PC Price Compare — All-in-One
 *   node index.js              → เปิดเว็บ + API ที่ http://localhost:3001
 *   node index.js --scrape     → ดึงราคาแล้วเซฟ data/prices.json แล้วออก (ใช้กับ GitHub Actions)
 */
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, 'data', 'prices.json');
const PORT = process.env.PORT || 3001;
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-me';

/* ══════════════════ 1. CONFIG ══════════════════ */
/* แก้ไขบล็อก STORES ใน index.js เป็นดังนี้ */
const STORES = [
  { key:'jib', name:'JIB', base:'https://www.jib.co.th', mode:'static',
    searchUrl:q=>`https://www.jib.co.th/web/product/product_search/0?keyword=${encodeURIComponent(q)}`,
    sel:{ card:'.product_list, .divboxpro', name:'.promotionname, .product_name', price:'.price_total, .price', img:'img', link:'a' } },

  { key:'advice', name:'Advice', base:'https://www.advice.co.th', mode:'dynamic',
    searchUrl:q=>`https://www.advice.co.th/search?keyword=${encodeURIComponent(q)}`,
    waitFor:'.product-item',
    sel:{ card:'.product-item, [class*="product-card"]', name:'h3, .product-name', price:'.price, .text-price', img:'img', link:'a' } },

  { key:'banana', name:'BaNANA', base:'https://www.bnn.in.th', mode:'dynamic',
    searchUrl:q=>`https://www.bnn.in.th/th/search?q=${encodeURIComponent(q)}`,
    waitFor:'[class*="product"]',
    sel:{ card:'a[href*="/p/"], [class*="product-item"]', name:'h3, [class*="name"]', price:'[class*="price"]', img:'img', link:'a' } },

  { key:'ihavecpu', name:'iHAVECPU', base:'https://ihavecpu.com', mode:'dynamic',
    searchUrl:q=>`https://ihavecpu.com/product/search/${encodeURIComponent(q)}`,
    waitFor:'[class*="product"]',
    sel:{ card:'[class*="product-item"], [class*="ProductCard"]', name:'[class*="name"]', price:'[class*="price"]', img:'img', link:'a' } }
];

const WATCHLIST = [
  { sku:'cpu-9800x3d', cat:'cpu', q:'Ryzen 7 9800X3D', must:['9800x3d'], w:120, socket:'AM5' },
  { sku:'cpu-9600x',   cat:'cpu', q:'Ryzen 5 9600X',   must:['9600x'],   w:88,  socket:'AM5' },
  { sku:'cpu-14600kf', cat:'cpu', q:'i5-14600KF',      must:['14600'],   w:150, socket:'LGA1700' },
  { sku:'mb-b850plus', cat:'mb',  q:'TUF GAMING B850-PLUS', must:['b850'], w:35, socket:'AM5', ram:'DDR5' },
  { sku:'mb-b650ma',   cat:'mb',  q:'MSI PRO B650M-A', must:['b650m'],   w:30, socket:'AM5', ram:'DDR5' },
  { sku:'ram-tz5-32',  cat:'ram', q:'Trident Z5 32GB DDR5 6000', must:['32gb'], w:12, ram:'DDR5' },
  { sku:'ram-fury-32', cat:'ram', q:'Kingston FURY Beast 32GB DDR5', must:['32gb'], w:10, ram:'DDR5' },
  { sku:'vga-5070ti',  cat:'vga', q:'RTX 5070 Ti 16GB', must:['5070'],   w:300 },
  { sku:'vga-5070',    cat:'vga', q:'RTX 5070 12GB',    must:['5070'],   w:250 },
  { sku:'ssd-990pro2t',cat:'ssd', q:'Samsung 990 PRO 2TB', must:['990'], w:8 },
  { sku:'ssd-sn7100',  cat:'ssd', q:'WD Black SN7100 1TB', must:['sn7100'], w:6 },
  { sku:'psu-rm850e',  cat:'psu', q:'Corsair RM850e',   must:['rm850'],  w:0, psu:850 },
  { sku:'psu-a750gl',  cat:'psu', q:'MSI MAG A750GL',   must:['a750'],   w:0, psu:750 },
  { sku:'case-l216',   cat:'case',q:'Lian Li Lancool 216', must:['216'], w:10 },
  { sku:'cool-ak620',  cat:'cooler', q:'Deepcool AK620', must:['ak620'], w:6 },
  { sku:'mon-27gs75q', cat:'monitor', q:'LG 27GS75Q',   must:['27gs75'], w:35 }
];

const CATS = { cpu:'CPU', mb:'Mainboard', ram:'RAM', vga:'การ์ดจอ', ssd:'SSD',
               psu:'Power Supply', case:'เคส', cooler:'CPU Cooler', monitor:'จอมอนิเตอร์' };

/* ══════════════════ 2. HELPERS ══════════════════ */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const toNum = t => { const m = String(t||'').replace(/[,\s]/g,'').match(/(\d{2,})/); return m ? +m[1] : null; };
const norm  = s => String(s||'').toLowerCase().replace(/[^a-z0-9ก-๙\s.-]/g,' ').replace(/\s+/g,' ').trim();
const abs   = (b,u) => !u ? null : u.startsWith('http') ? u : new URL(u,b).href;

/* ══════════════════ 3. SCRAPER ══════════════════ */
let _browser = null, _pwFailed = false;
async function getBrowser(){
  if (_pwFailed) return null;
  if (_browser) return _browser;
  try {
    const { chromium } = await import('playwright');
    _browser = await chromium.launch({ args:['--no-sandbox','--disable-dev-shm-usage'] });
    return _browser;
  } catch { _pwFailed = true; console.warn('⚠️  ไม่มี Playwright — ใช้โหมด static อย่างเดียว'); return null; }
}
async function closeBrowser(){ if (_browser) { await _browser.close(); _browser = null; } }

async function getStatic(url){
  await sleep(900 + Math.random()*800);
  const res = await fetch(url, { headers:{ 'user-agent':UA, 'accept-language':'th-TH,th;q=0.9' },
                                 signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}
async function getDynamic(url, waitFor) {
  const b = await getBrowser();
  if (!b) return getStatic(url);
  const ctx = await b.newContext({ 
    locale:'th-TH', 
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    viewport:{width:1366,height:768} 
  });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil:'networkidle', timeout:60000 }); // รอนานขึ้น
    await page.waitForTimeout(5000); // **รอ 5 วินาทีให้ JS โหลดเสร็จ**
    if (waitFor) await page.waitForSelector(waitFor, { timeout:20000 }).catch(()=>{});
    return await page.content();
  } finally { await ctx.close(); }
}

function extract(html, st){
  const $ = cheerio.load(html), out = [];
  $(st.sel.card).each((_, el) => {
    const $e = $(el);
    const name  = ($e.find(st.sel.name).first().text() || $e.attr('title') || '').trim();
    const price = toNum($e.find(st.sel.price).first().text());
    const img   = abs(st.base, $e.find(st.sel.img).first().attr('src') || $e.find(st.sel.img).first().attr('data-src'));
    const href  = st.sel.link === 'self' ? $e.attr('href') : $e.find(st.sel.link).first().attr('href');
    if (name && price && price > 100) out.push({ name, price, img, url: abs(st.base, href) });
  });
  return out;
}

async function scrapeOne(st, item){
  const url = st.searchUrl(item.q);
  let html;
  try { html = st.mode === 'dynamic' ? await getDynamic(url, st.waitFor) : await getStatic(url); }
  catch(e){ return { ok:false, error:e.message, url }; }

  let list = extract(html, st);
  if (!list.length && st.mode === 'static') {
    try { list = extract(await getDynamic(url, st.waitFor), st); } catch {}
  }
  const hits = list.filter(p => (item.must||[]).every(k => norm(p.name).includes(norm(k))));
  const best = hits.sort((a,b) => a.price - b.price)[0];
  return best ? { ok:true, ...best } : { ok:false, error:`ไม่พบรุ่นที่ตรง (สแกน ${list.length})`, url };
}

async function refreshAll(){
  console.log(`\n⏳ [${new Date().toLocaleString('th-TH')}] เริ่มดึงราคา ${WATCHLIST.length} รายการ × ${STORES.length} ร้าน`);
  const result = [];
  for (const item of WATCHLIST) {
    const row = { sku:item.sku, cat:item.cat, name:item.q, img:null,
                  w:item.w||0, socket:item.socket||null, ram:item.ram||null,
                  psu:item.psu||null, prices:{} };
    for (const st of STORES) {
      const r = await scrapeOne(st, item);
      if (r.ok) { row.name = r.name; row.img ||= r.img; }
      row.prices[st.key] = { price: r.ok ? r.price : null, url: r.url, note: r.error || null };
      console.log(`  ${r.ok?'✅':'⚠️ '} ${st.name.padEnd(9)} ${item.sku.padEnd(14)} ${r.ok ? '฿'+r.price.toLocaleString() : r.error}`);
    }
    const valid = Object.entries(row.prices).filter(([,v]) => v.price > 0).sort((a,b) => a[1].price - b[1].price);
    row.best   = valid.length ? { store: valid[0][0], price: valid[0][1].price } : null;
    row.spread = valid.length > 1 ? valid.at(-1)[1].price - valid[0][1].price : 0;
    result.push(row);
  }
  await closeBrowser();
  const payload = { updated_at: new Date().toISOString(), count: result.length, data: result };
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive:true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2));
  console.log(`💾 บันทึกแล้ว → ${DATA_FILE}\n`);
  return payload;
}
const loadData = () => fs.existsSync(DATA_FILE)
  ? JSON.parse(fs.readFileSync(DATA_FILE,'utf8'))
  : { updated_at:null, count:0, data:[] };

/* ══════════════════ 4. FRONTEND (embedded) ══════════════════ */
const HTML = /* html */`<!DOCTYPE html><html lang="th"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PC Spec Builder — เทียบราคา 4 ร้าน</title><style>
:root{--bg:#0f1216;--card:#171c23;--c2:#1e242d;--line:#2a323d;--txt:#e7ecf3;--dim:#8b97a8;--acc:#4ea8ff;--ok:#38d39f;--warn:#ffb020;--bad:#ff5d5d}
*{box-sizing:border-box;margin:0;padding:0}body{background:var(--bg);color:var(--txt);font-family:"Segoe UI",Tahoma,sans-serif;line-height:1.5}
.wrap{max-width:1280px;margin:0 auto;padding:16px}header{background:linear-gradient(135deg,#1b2735,#0f1216);border-bottom:1px solid var(--line);padding:18px 0}
h1{font-size:22px}.sub{color:var(--dim);font-size:13px;margin-top:4px}
.layout{display:grid;grid-template-columns:1fr 340px;gap:16px;margin-top:16px}@media(max-width:960px){.layout{grid-template-columns:1fr}}
.slot{background:var(--card);border:1px solid var(--line);border-radius:12px;margin-bottom:10px;overflow:hidden}
.sh{display:flex;align-items:center;gap:12px;padding:12px 14px;cursor:pointer}.sh:hover{background:var(--c2)}
.ico{width:38px;height:38px;border-radius:9px;background:#222b36;display:grid;place-items:center;font-size:19px;flex:0 0 auto}
.st{flex:1;min-width:0}.st b{font-size:14px}.st span{display:block;font-size:12px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.btn{background:var(--acc);color:#06121f;border:0;border-radius:8px;padding:7px 13px;font-weight:700;cursor:pointer;font-size:13px}
.btn.g{background:transparent;color:var(--dim);border:1px solid var(--line)}.btn:hover{filter:brightness(1.1)}
.picked{display:flex;gap:12px;padding:0 14px 14px}.picked img{width:84px;height:64px;object-fit:contain;border-radius:8px;background:#fff}
.pr{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.chip{font-size:11.5px;padding:4px 8px;border-radius:6px;background:#222b36;color:var(--dim);border:1px solid var(--line);text-decoration:none}
.chip.best{background:rgba(56,211,159,.15);border-color:var(--ok);color:var(--ok);font-weight:700}.chip b{color:var(--txt)}.chip.best b{color:var(--ok)}
aside{position:sticky;top:14px;align-self:start}.box{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:12px}
.box h3{font-size:14px;margin-bottom:10px;color:var(--acc)}
.ln{display:flex;justify-content:space-between;font-size:13px;padding:5px 0;border-bottom:1px dashed var(--line)}.ln:last-child{border:0}
.tot{font-size:20px;font-weight:800;color:var(--ok)}
.al{font-size:12.5px;padding:8px 10px;border-radius:8px;margin-top:8px}
.al.w{background:rgba(255,176,32,.12);color:var(--warn)}.al.e{background:rgba(255,93,93,.12);color:var(--bad)}.al.o{background:rgba(56,211,159,.12);color:var(--ok)}
.modal{position:fixed;inset:0;background:rgba(0,0,0,.72);display:none;z-index:50;overflow:auto;padding:24px 12px}.modal.on{display:block}
.sheet{max-width:1050px;margin:0 auto;background:var(--bg);border:1px solid var(--line);border-radius:14px;padding:16px}
.mh{display:flex;gap:10px;align-items:center;margin-bottom:12px}
input.s{flex:1;background:var(--c2);border:1px solid var(--line);color:var(--txt);padding:9px 12px;border-radius:8px;font-size:14px}
.item{display:grid;grid-template-columns:120px 1fr 470px;gap:14px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;margin-bottom:10px}
@media(max-width:900px){.item{grid-template-columns:1fr}}
.item img{width:100%;height:92px;object-fit:contain;background:#fff;border-radius:8px}
.sp{font-size:12px;color:var(--dim);margin-top:4px}
.sts{display:grid;grid-template-columns:repeat(4,1fr);gap:7px}
.sc{background:var(--c2);border:1px solid var(--line);border-radius:9px;padding:8px;text-align:center}
.sc.best{border-color:var(--ok);background:rgba(56,211,159,.1)}
.sc .nm{font-size:10.5px;color:var(--dim);text-transform:uppercase}.sc .p{font-size:15px;font-weight:800;margin:3px 0}
.sc.best .p{color:var(--ok)}.sc .x{font-size:10px;color:var(--dim)}.sc a{display:block;margin-top:5px;font-size:11px;color:var(--acc);text-decoration:none}
.tag{display:inline-block;font-size:10px;background:var(--acc);color:#06121f;border-radius:4px;padding:1px 6px;font-weight:700;margin-left:6px}
</style></head><body>
<header><div class="wrap"><h1>🖥️ PC Spec Builder — เทียบราคา JIB · Advice · BaNANA · iHAVECPU</h1>
<div class="sub" id="upd">กำลังโหลดข้อมูลราคา...</div></div></header>
<div class="wrap"><div class="layout">
<main id="slots"></main>
<aside>
<div class="box"><h3>💰 สรุปยอดรวมรายร้าน</h3><div id="tots"></div>
<div class="ln" style="margin-top:8px"><b>ซื้อผสมร้าน (ถูกสุดทีละชิ้น)</b><span class="tot" id="mix">฿0</span></div><div id="note"></div></div>
<div class="box"><h3>⚡ พลังงาน & ความเข้ากันได้</h3>
<div class="ln"><span>ประมาณการใช้ไฟ</span><b id="watt">0 W</b></div>
<div class="ln"><span>PSU แนะนำ</span><b id="psu">-</b></div><div id="compat"></div></div>
<div class="box"><button class="btn" style="width:100%" onclick="copySum()">📋 คัดลอกสเปค</button>
<button class="btn g" style="width:100%;margin-top:8px" onclick="resetAll()">🗑️ ล้างทั้งหมด</button></div>
</aside></div></div>
<div class="modal" id="modal"><div class="sheet"><div class="mh">
<b id="mt" style="font-size:17px"></b><input class="s" id="ms" placeholder="ค้นหารุ่น...">
<button class="btn g" onclick="closeM()">✕ ปิด</button></div><div id="ml"></div></div></div>
<script>
const STORES=[{k:'jib',n:'JIB'},{k:'advice',n:'Advice'},{k:'banana',n:'BaNANA'},{k:'ihavecpu',n:'iHAVECPU'}];
const CATS=[{k:'cpu',n:'CPU (ซีพียู)',i:'🧠',r:1},{k:'mb',n:'Mainboard',i:'🔲',r:1},{k:'ram',n:'RAM',i:'📊',r:1},
{k:'vga',n:'การ์ดจอ (VGA)',i:'🎮',r:0},{k:'ssd',n:'SSD / Storage',i:'💾',r:1},{k:'psu',n:'Power Supply',i:'🔌',r:1},
{k:'case',n:'เคส',i:'🗄️',r:1},{k:'cooler',n:'CPU Cooler',i:'❄️',r:0},{k:'monitor',n:'จอมอนิเตอร์',i:'🖥️',r:0}];
const DATA_URL = location.protocol==='file:' ? './data/prices.json'
  : (window.__STATIC__ ? './data/prices.json' : '/api/products');
let DB={},build=JSON.parse(localStorage.getItem('pcbuild')||'{}'),cur=null;
const fmt=n=>'฿'+Number(n||0).toLocaleString('th-TH');
const lo=p=>{const v=Object.values(p).map(x=>x&&x.price).filter(x=>x>0);return v.length?Math.min(...v):0};
const bs=p=>{let k=null,m=1/0;for(const s of STORES){const v=p[s.k]&&p[s.k].price;if(v>0&&v<m){m=v;k=s.k}}return k};

async function boot(){
  try{
    const j=await (await fetch(DATA_URL+'?t='+Date.now())).json();
    CATS.forEach(c=>DB[c.k]=[]);
    j.data.forEach(p=>{(DB[p.cat]=DB[p.cat]||[]).push(p)});
    document.getElementById('upd').textContent='อัปเดตราคาล่าสุด: '+
      (j.updated_at?new Date(j.updated_at).toLocaleString('th-TH'):'—')+' · '+j.count+' รายการ';
  }catch(e){document.getElementById('upd').innerHTML='<span style="color:#ff5d5d">โหลดข้อมูลราคาไม่สำเร็จ — รัน scraper ก่อน</span>'}
  render();
}
function render(){
  document.getElementById('slots').innerHTML=CATS.map(c=>{
    const it=build[c.k];let b='';
    if(it){const k=bs(it.prices);
      b='<div class="picked"><img src="'+(it.img||'https://placehold.co/120x90?text=No+Image')+'"><div style="flex:1;min-width:0">'+
      '<div class="sp">'+(it.socket?'Socket '+it.socket+' · ':'')+(it.ram?it.ram+' · ':'')+(it.w?it.w+'W':'')+'</div><div class="pr">'+
      STORES.map(s=>{const v=it.prices[s.k];return (!v||!v.price)
        ?'<span class="chip">'+s.n+': <b>—</b></span>'
        :'<a class="chip '+(s.k===k?'best':'')+'" target="_blank" href="'+v.url+'">'+s.n+': <b>'+fmt(v.price)+'</b></a>'}).join('')+
      '</div></div></div>'}
    return '<div class="slot"><div class="sh" onclick="openM(\\''+c.k+'\\')"><div class="ico">'+c.i+'</div>'+
      '<div class="st"><b>'+c.n+(c.r?' <span class="tag">จำเป็น</span>':'')+'</b><span>'+
      (it?it.name:'ยังไม่ได้เลือก — คลิกเพื่อเทียบราคา')+'</span></div>'+
      '<button class="btn">'+(it?'เปลี่ยน':'เลือก')+'</button></div>'+b+'</div>'}).join('');
  calc();
}
function openM(k){cur=k;document.getElementById('mt').textContent=CATS.find(c=>c.k===k).n;
  document.getElementById('ms').value='';list('');document.getElementById('modal').classList.add('on')}
function closeM(){document.getElementById('modal').classList.remove('on')}
document.getElementById('ms').addEventListener('input',e=>list(e.target.value));
function list(q){
  const arr=(DB[cur]||[]).filter(x=>x.name.toLowerCase().includes(q.toLowerCase()));
  document.getElementById('ml').innerHTML=arr.map(x=>{const k=bs(x.prices),m=lo(x.prices);
    return '<div class="item"><div><img src="'+(x.img||'https://placehold.co/300x200?text=No+Image')+'">'+
    '<button class="btn" style="width:100%;margin-top:8px" onclick="pick(\\''+x.sku+'\\')">เลือก</button></div>'+
    '<div><b style="font-size:14.5px">'+x.name+'</b><div class="sp">'+(x.socket||'')+' '+(x.ram||'')+' '+(x.w?x.w+'W':'')+'</div>'+
    '<div class="sp" style="margin-top:6px;color:var(--ok)">ถูกสุด '+fmt(m)+(x.spread>0?' · ต่างกันสูงสุด '+fmt(x.spread):'')+'</div></div>'+
    '<div class="sts">'+STORES.map(s=>{const v=x.prices[s.k]||{};
      return '<div class="sc '+(s.k===k?'best':'')+'"><div class="nm">'+s.n+'</div><div class="p">'+
      (v.price?fmt(v.price):'—')+'</div><div class="x">'+(v.price?(s.k===k?'★ ถูกสุด':'มีสินค้า'):'ไม่พบราคา')+'</div>'+
      '<a target="_blank" href="'+(v.url||'#')+'">เปิดหน้าร้าน ↗</a></div>'}).join('')+'</div></div>'}).join('')
    ||'<p style="color:var(--dim);text-align:center;padding:30px">ไม่พบสินค้าในหมวดนี้</p>';
}
function pick(sku){build[cur]=DB[cur].find(x=>x.sku===sku);save();closeM()}
function calc(){
  const it=Object.values(build);
  document.getElementById('tots').innerHTML=STORES.map(s=>{let sum=0,miss=0;
    it.forEach(x=>{const v=x.prices[s.k]&&x.prices[s.k].price;v?sum+=v:miss++});
    return '<div class="ln"><span>'+s.n+(miss?' <span style="color:var(--warn)">(ขาด '+miss+')</span>':'')+'</span><b>'+fmt(sum)+'</b></div>'}).join('');
  const mix=it.reduce((a,x)=>a+lo(x.prices),0);document.getElementById('mix').textContent=fmt(mix);
  const tl=STORES.map(s=>it.reduce((a,x)=>a+((x.prices[s.k]&&x.prices[s.k].price)||0),0)).filter(v=>v>0);
  const cheap=tl.length?Math.min(...tl):0;
  document.getElementById('note').innerHTML=(mix&&cheap>mix)
    ?'<div class="al o">💡 ซื้อผสมร้านประหยัดกว่า '+fmt(cheap-mix)+' (ยังไม่รวมค่าส่ง)</div>':'';
  const w=it.reduce((a,x)=>a+(x.w||0),0),rec=Math.ceil(w*1.4/50)*50;
  document.getElementById('watt').textContent=w+' W';document.getElementById('psu').textContent=w?rec+'W ขึ้นไป':'-';
  const msg=[];
  if(build.cpu&&build.mb&&build.cpu.socket&&build.mb.socket&&build.cpu.socket!==build.mb.socket)
    msg.push('<div class="al e">❌ CPU ('+build.cpu.socket+') ไม่ตรงกับเมนบอร์ด ('+build.mb.socket+')</div>');
  if(build.mb&&build.ram&&build.mb.ram&&build.ram.ram&&build.mb.ram!==build.ram.ram)
    msg.push('<div class="al e">❌ RAM '+build.ram.ram+' ไม่ตรงกับเมนบอร์ด '+build.mb.ram+'</div>');
  if(build.psu&&build.psu.psu&&w&&build.psu.psu<rec)
    msg.push('<div class="al w">⚠️ PSU '+build.psu.psu+'W อาจไม่พอ — แนะนำ '+rec+'W</div>');
  const ms=CATS.filter(c=>c.r&&!build[c.k]).map(c=>c.n);
  if(ms.length)msg.push('<div class="al w">⚠️ ยังขาด: '+ms.join(', ')+'</div>');
  if(!msg.length&&it.length)msg.push('<div class="al o">✅ สเปคเข้ากันได้ทั้งหมด</div>');
  document.getElementById('compat').innerHTML=msg.join('');
}
function copySum(){let t='=== สเปคคอมของฉัน ===\\n';
  CATS.forEach(c=>{const x=build[c.k];if(x){const k=bs(x.prices);
    t+=c.n+': '+x.name+' — '+fmt(lo(x.prices))+' ('+((STORES.find(s=>s.k===k)||{}).n||'-')+')\\n'}});
  t+='\\nรวมแบบผสมร้าน: '+document.getElementById('mix').textContent;
  navigator.clipboard.writeText(t).then(()=>alert('คัดลอกแล้ว!'))}
function resetAll(){if(confirm('ล้างสเปคทั้งหมด?')){build={};save()}}
function save(){localStorage.setItem('pcbuild',JSON.stringify(build));render()}
document.getElementById('modal').addEventListener('click',e=>{if(e.target.id==='modal')closeM()});
boot();
</script></body></html>`;

/* ══════════════════ 5. MAIN ══════════════════ */
if (process.argv.includes('--scrape')) {
  refreshAll().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
} else {
  const app = express();
  app.use(cors()); app.use(express.json());
  app.get('/', (_, res) => res.type('html').send(HTML));
  app.get('/api/products', (req, res) => {
    const d = loadData();
    res.json(req.query.cat ? { ...d, data: d.data.filter(x => x.cat === req.query.cat) } : d);
  });
  app.get('/api/products/:sku', (req, res) => {
    const p = loadData().data.find(x => x.sku === req.params.sku);
    p ? res.json(p) : res.status(404).json({ error:'ไม่พบ SKU' });
  });
  app.get('/api/health', (_, res) => res.json({ ok:true, ...loadData(), data:undefined, cats:CATS }));
  app.post('/api/refresh', (req, res) => {
    if (req.headers['x-api-key'] !== ADMIN_KEY) return res.status(401).json({ error:'unauthorized' });
    res.json({ status:'started' }); refreshAll().catch(console.error);
  });
  cron.schedule('0 6,18 * * *', () => refreshAll().catch(console.error), { timezone:'Asia/Bangkok' });
  app.listen(PORT, () => {
    console.log(`\n🚀 http://localhost:${PORT}`);
    if (!fs.existsSync(DATA_FILE)) { console.log('📡 ยังไม่มีข้อมูล — ดึงราคารอบแรก...'); refreshAll().catch(console.error); }
  });
}