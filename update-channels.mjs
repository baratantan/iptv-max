// تحديث القنوات تلقائياً — يعمل على GitHub Actions يومياً
// المصدر: قوائم iptv-org المجانية. يفلتر للجمهور العربي، يفحص الروابط من الخادم، ويحدّث channels.json
import fs from 'node:fs';

const BASE = process.env.SRC_BASE || 'https://iptv-org.github.io/iptv/';
const ARAB_ONLY = process.env.ARAB_ONLY !== '0';          // اجعلها 0 لجلب كل دول العالم
const PRUNE_NON_ARAB = process.env.PRUNE_NON_ARAB === '1'; // 1 = احذف القنوات غير العربية الموجودة سابقاً
const CONC = +(process.env.CONC || 40), TIMEOUT = +(process.env.TIMEOUT || 8000), MAX_FAILS = +(process.env.MAX_FAILS || 3);
const ARAB = ['SA','AE','QA','KW','BH','OM','YE','IQ','SY','LB','JO','PS','EG','SD','LY','TN','DZ','MA','MR','SO','DJ','KM'];

// نفس خوارزمية المعرّف في الموقع (ليبقى ربط المفضلة سليماً)
const hid = s => { let h1 = 0xdeadbeef, h2 = 0x41c6ce57; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); } h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909); h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909); return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36); };

const NSFW_RE = /(^|[^a-z])(xxx|porn|sex|erotic|adult|playboy|hustler|brazzers)([^a-z]|$)|18\+|اباحي|إباحي/i;
const CAT_EN = { news:'أخبار', sports:'رياضة', sport:'رياضة', movies:'أفلام', movie:'أفلام', series:'مسلسلات', kids:'أطفال', animation:'أطفال', children:'أطفال', music:'موسيقى', religious:'ديني', documentary:'وثائقي', entertainment:'منوعات', comedy:'منوعات', culture:'منوعات', lifestyle:'منوعات', family:'منوعات', general:'عام' };
const CAT_RULES = [
  ['أخبار', /news|أخبار|اخبار|jazeera|الجزيرة|arabiya|العربية|الحدث|cnn|bbc world|france ?24|sky news|euronews|alhurra|الحرة|روسيا اليوم/i],
  ['رياضة', /sport|bein|ssc|رياض|كرة|football|soccer|كأس|مباراة|racing|ufc|wwe|nba|nfl|tennis|golf/i],
  ['أفلام', /movie|cinema|film|أفلام|افلام|سينما|aflam/i],
  ['مسلسلات', /series|drama|مسلسل|دراما|soap|telenovela/i],
  ['أطفال', /kids|cartoon|toon|أطفال|اطفال|junior|baby|nick|disney|spacetoon|سبيستون|طيور|كراميش|boomerang|pogo|animation|anime|انمي/i],
  ['موسيقى', /music|mtv|موسيق|أغاني|اغاني|melody|ميلودي|vevo/i],
  ['ديني', /quran|قرآن|قران|islam|إسلام|اسلام|sunna|مكة|makkah|mecca|madina|iqra|اقرأ|ديني|church|christian|الكوثر/i],
  ['وثائقي', /documentary|discovery|nat ?geo|national geographic|وثائق|history|تاريخ|animal planet|علوم/i]
];

// ===== أسماء الدول واللغات (من Intl) =====
const canonReg = c => { try { return Intl.getCanonicalLocales('und-' + c)[0].split('-')[1]; } catch { return c; } };
const canonLang = l => { try { return Intl.getCanonicalLocales(l)[0]; } catch { return l; } };
const enR = new Intl.DisplayNames(['en'], { type: 'region' }), enL = new Intl.DisplayNames(['en'], { type: 'language' });
const CN = {}, LN = {};
for (const a of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') for (const b of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
  const c = a + b, l = c.toLowerCase();
  try { const n = enR.of(c); if (n && n !== c && !/unknown/i.test(n) && canonReg(c) === c) { const k = n.toLowerCase(); if (!(k in CN)) CN[k] = c; } } catch {}
  try { const m = enL.of(l); if (m && m !== l && canonLang(l) === l) { const k = m.toLowerCase(); if (!(k in LN)) LN[k] = l; } } catch {}
}
Object.assign(CN, { 'czech republic': 'CZ', 'turkey': 'TR', 'uk': 'GB', 'macedonia': 'MK', 'palestine': 'PS' });
const toCountry = v => { if (!v) return ''; v = String(v).trim(); if (/^[A-Za-z]{2}$/.test(v)) { const c = v.toUpperCase(); return Object.values(CN).includes(c) ? c : ''; } return CN[v.toLowerCase()] || ''; };
const toLang = v => { if (!v) return ''; v = String(v).trim().toLowerCase(); if (/^[a-z]{2}$/.test(v)) return Object.values(LN).includes(v) ? v : ''; return LN[v] || ''; };
const guessCountry = (name, id, grp) => {
  let c = toCountry(String(grp || '').split(';')[0]); if (c) return c;
  const m = String(id || '').match(/\.([a-z]{2})(?:@|$)/i); if (m) { c = toCountry(m[1]); if (c) return c; }
  const p = String(name || '').match(/^([A-Za-z]{2})\s*[-|:]/); if (p) { c = toCountry(p[1]); if (c) return c; }
  return '';
};
const mapCat = g => { for (const part of String(g || '').split(';')) { const a = CAT_EN[part.trim().toLowerCase()]; if (a) return a; } return ''; };
const inferCat = name => { for (const [cat, re] of CAT_RULES) if (re.test(name || '')) return cat; return 'عام'; };

// ===== أدوات =====
function parseM3U(text) {
  const out = []; let m = null;
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (l.startsWith('#EXTINF')) {
      m = { name: (l.split(/,(.*)$/)[1] || '').trim(), logo: (l.match(/tvg-logo="([^"]*)"/) || [])[1] || '', group: (l.match(/group-title="([^"]*)"/) || [])[1] || '', id: (l.match(/tvg-id="([^"]*)"/) || [])[1] || '' };
    } else if (l && !l.startsWith('#') && m) { if (/^https?:\/\//i.test(l)) out.push({ ...m, url: l }); m = null; }
  }
  return out;
}
async function getText(url) {
  let err;
  for (let i = 0; i < 3; i++) {
    try { const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(60000) }); if (r.ok) return await r.text(); err = new Error('HTTP ' + r.status); } catch (e) { err = e; }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(url + ' ← ' + err.message);
}
async function probe(url) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0', Range: 'bytes=0-2047' }, redirect: 'follow' });
    if (r.status !== 200 && r.status !== 206) return false;
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('text/html')) return false;
    const reader = r.body.getReader(); const { value } = await reader.read(); try { await reader.cancel(); } catch {}
    if (!value || !value.length) return false;
    if (/\.m3u8(\?|$)/i.test(url) || ct.includes('mpegurl')) return new TextDecoder().decode(value).includes('#EXTM3U');
    return true;
  } catch { return false; } finally { clearTimeout(t); }
}
async function pool(items, fn) {
  let i = 0, done = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (i < items.length) { const k = i++; await fn(items[k]); if (++done % 500 === 0) console.log('  فُحصت', done, '/', items.length); }
  }));
}
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const isArab = c => c.language === 'ar' || ARAB.includes(c.country);

// ===== 1) جلب المصادر ودمجها =====
const keepList = (fs.existsSync('keep.txt') ? fs.readFileSync('keep.txt', 'utf8') : '').split(/\r?\n/).map(s => s.trim().toLowerCase()).filter(s => s && !s.startsWith('#'));
const isKept = c => keepList.some(k => (c.name || '').toLowerCase().includes(k) || (c.url || '').toLowerCase().includes(k));

const fresh = new Map();
function take(list, apply) {
  for (const it of list) {
    let c = fresh.get(it.url);
    if (!c) { c = { name: it.name, url: it.url, logo: it.logo, tvgId: it.id }; fresh.set(it.url, c); }
    apply(c, it);
  }
}
console.log('جلب المصادر من', BASE);
const [txtC, txtL, txtG] = await Promise.all(['index.country.m3u', 'index.language.m3u', 'index.category.m3u'].map(f => getText(BASE + f)));
take(parseM3U(txtC), (c, it) => { c.country ||= guessCountry(it.name, it.id, it.group); });
take(parseM3U(txtL), (c, it) => { c.language ||= toLang(String(it.group).split(';')[0]); });
take(parseM3U(txtG), (c, it) => { c.cat ||= mapCat(it.group); });
if (!fresh.size) { console.error('لم تُجلب أي قنوات، إيقاف دون تغيير.'); process.exit(1); }

const freshList = [];
for (const c of fresh.values()) {
  const geo = /\[(geo-blocked|geo blocked)\]/i.test(c.name);
  const name = c.name.replace(/\s*\[(geo-blocked|not 24\/7)\]/gi, '').trim();
  if (!name || NSFW_RE.test(name + ' ' + (c.cat || ''))) continue;
  if (!c.country) c.country = guessCountry(name, c.tvgId, '');
  const ch = { id: hid(c.url), name, url: c.url, category: c.cat || inferCat(name), type: 'live' };
  if (c.logo) ch.logo = c.logo; if (c.country) ch.country = c.country; if (c.language) ch.language = c.language; if (geo) ch.geo = 1;
  if (ARAB_ONLY && !isArab(ch)) continue;
  freshList.push(ch);
}
console.log('قنوات المصدر بعد الفلترة:', freshList.length);

// ===== 2) دمج مع القنوات الحالية =====
const existing = readJson('channels.json', []);
const status = readJson('status.json', {});
const byUrl = new Map(existing.map(c => [c.url, c]));
for (const f of freshList) {   // استكمال بيانات القنوات الموجودة دون المساس بتعديلات المدير
  const e = byUrl.get(f.url); if (!e) continue;
  if (!e.country && f.country) e.country = f.country;
  if (!e.language && f.language) e.language = f.language;
  if (!e.logo && f.logo) e.logo = f.logo;
  if ((!e.category || e.category === 'عام') && f.category !== 'عام') e.category = f.category;
  if (f.geo && !e.geo) e.geo = 1;
}
const newOnes = freshList.filter(f => !byUrl.has(f.url));
const toCheckExisting = existing.filter(c => !c.manual && !c.geo && !isKept(c));
const toCheckNew = newOnes.filter(c => !c.geo && !isKept(c));
console.log('جديدة:', newOnes.length, '| فحص الحالية:', toCheckExisting.length, '| فحص الجديدة:', toCheckNew.length);

// ===== 3) فحص الروابط =====
const alive = new Map();
await pool([...toCheckExisting, ...toCheckNew], async c => { alive.set(c.url, await probe(c.url)); });

const removed = [], kept = [];
for (const c of existing) {
  if (PRUNE_NON_ARAB && !c.manual && !isKept(c) && !isArab(c)) { removed.push(c); continue; }
  if (!alive.has(c.url)) { kept.push(c); continue; }       // يدوية أو geo أو في keep.txt
  if (alive.get(c.url)) { delete status[c.url]; kept.push(c); continue; }
  const fails = ((status[c.url] && status[c.url].fails) || 0) + 1;
  if (fails >= MAX_FAILS) { removed.push(c); delete status[c.url]; }
  else { status[c.url] = { fails }; kept.push(c); }
}
const addedAlive = newOnes.filter(c => !alive.has(c.url) || alive.get(c.url));   // الجديدة: تُضاف إن نجح فحصها أو لم تُفحص (geo/keep)

// حماية: لا نكتب إن كان الحذف كبيراً بشكل مريب (ربما بسبب عطل بالشبكة)
if (existing.length > 100 && removed.length > existing.length * 0.4) {
  console.error('الحذف كبير جداً (' + removed.length + ' من ' + existing.length + ')، إيقاف دون تغيير.'); process.exit(1);
}

const out = [...kept, ...addedAlive].sort((a, b) => (a.name || '') < (b.name || '') ? -1 : 1);
fs.writeFileSync('channels.json', JSON.stringify(out));
fs.writeFileSync('status.json', JSON.stringify(status));
const info = { updated: new Date().toISOString(), total: out.length, added: addedAlive.length, removed: removed.length, failing: Object.keys(status).length };
fs.writeFileSync('update-info.json', JSON.stringify(info));
console.log('النتيجة:', info);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### تحديث القنوات\n- الإجمالي: **${info.total}**\n- أُضيف: ${info.added}\n- حُذف (ميت ${MAX_FAILS} مرات): ${info.removed}\n- معطل مؤقتاً (قيد المراقبة): ${info.failing}\n`);
