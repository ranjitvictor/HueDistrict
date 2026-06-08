const express = require('express');
const session = require('express-session');
const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const { google } = require('googleapis');
const Anthropic = require('@anthropic-ai/sdk');
const sharp = require('sharp');
const crypto = require('crypto');
const { Readable } = require('stream');

const ROOT_FOLDER_ID = '1018xTizZybeAjs-9wlgWzJWx7mSL0k5t';
const REVIEW_FOLDER_NAME = 'Posters for Review';
const SALE_FOLDER_NAME = 'Posters for Sale';
const ORDERS_FOLDER_NAME = '_hd_orders';
const MOCKUPS_FOLDER_NAME = 'Room Mockups';

const ALLOWED_EMAILS = new Set([
  'shriyaranjit28@gmail.com',
  'arnuranj@gmail.com',
  'ranjitvictor@gmail.com',
]);

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '8mb' }));

app.use((req, res, next) => {
  if (!req.path.startsWith('/api/preview')) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
  }
  next();
});

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: true, httpOnly: true, sameSite: 'lax', maxAge: 24 * 60 * 60 * 1000 },
}));

app.use(passport.initialize());
app.use(passport.session());

passport.use(new GoogleStrategy(
  {
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: `${process.env.BASE_URL}/auth/google/callback`,
  },
  (accessToken, refreshToken, profile, done) => {
    const email = profile.emails?.[0]?.value;
    if (email && ALLOWED_EMAILS.has(email)) {
      return done(null, { email, name: profile.displayName, accessToken, refreshToken });
    }
    return done(null, false);
  }
));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/login');
}

function getDriveClient(user) {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${process.env.BASE_URL}/auth/google/callback`
  );
  auth.setCredentials({ access_token: user.accessToken, refresh_token: user.refreshToken });
  return google.drive({ version: 'v3', auth });
}

const folderCache = {};
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function parseServiceAccountKey() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) return { error: 'missing' };
  try {
    const credentials = JSON.parse(raw);
    // Railway sometimes turns real newlines in the private key into literal \n
    if (credentials.private_key && credentials.private_key.includes('\\n')) {
      credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
    }
    if (!credentials.client_email || !credentials.private_key) {
      return { error: 'incomplete' };
    }
    return { credentials };
  } catch (e) {
    return { error: 'invalid-json', detail: e.message };
  }
}

function getServiceDriveClient() {
  const parsed = parseServiceAccountKey();
  if (parsed.error) return null;
  try {
    const auth = new google.auth.GoogleAuth({ credentials: parsed.credentials, scopes: ['https://www.googleapis.com/auth/drive'] });
    return google.drive({ version: 'v3', auth });
  } catch (e) { return null; }
}

function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
}

function statusBadge(status) {
  const map = { pending: ['#fef3c7','#92400e','Pending Payment'], paid: ['#d1fae5','#065f46','Paid'], dispatched: ['#dbeafe','#1e40af','Dispatched'], cancelled: ['#fee2e2','#991b1b','Cancelled'] };
  const [bg, color, label] = map[status] || ['#f3f4f6','#374151', status];
  return `<span style="background:${bg};color:${color};font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;white-space:nowrap">${label}</span>`;
}

async function findFolder(drive, parentId, name) {
  const key = `${parentId}:${name}`;
  if (folderCache[key]) return folderCache[key];
  const res = await drive.files.list({
    q: `'${parentId}' in parents and name = '${name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  if (!res.data.files.length) throw new Error(`Folder not found: ${name}`);
  folderCache[key] = res.data.files[0].id;
  return folderCache[key];
}

async function listSubfolders(drive, parentId) {
  const res = await drive.files.list({
    q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    orderBy: 'name desc',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files;
}

async function listFiles(drive, parentId) {
  const res = await drive.files.list({
    q: `'${parentId}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name, mimeType)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files;
}

function groupPosters(files) {
  const groups = {};
  const keyMap = {}; // lowercase → canonical key

  for (const file of files) {
    const { name } = file;
    let base, type;

    if (/_ig\.(png|jpg|jpeg)$/i.test(name)) {
      base = name.replace(/_ig\.(png|jpg|jpeg)$/i, ''); type = 'ig';
    } else if (/_room\.(png|jpg|jpeg)$/i.test(name)) {
      base = name.replace(/_room\.(png|jpg|jpeg)$/i, ''); type = 'room';
    } else if (/_web\.(png|jpg|jpeg)$/i.test(name)) {
      base = name.replace(/_web\.(png|jpg|jpeg)$/i, ''); type = 'web';
    } else if (/_meta\.json$/i.test(name)) {
      base = name.replace(/_meta\.json$/i, ''); type = 'meta';
    } else if (/\.pdf$/i.test(name)) {
      base = name.replace(/\.pdf$/i, ''); type = 'pdf';
    } else {
      continue;
    }

    const lowerBase = base.toLowerCase();
    if (!keyMap[lowerBase]) {
      keyMap[lowerBase] = base;
      groups[base] = { name: base };
    }
    const key = keyMap[lowerBase];
    groups[key][type] = file;
  }
  return Object.values(groups).sort((a, b) => a.name.localeCompare(b.name));
}

async function getOrCreateSubfolder(drive, parentId, name) {
  const res = await drive.files.list({
    q: `'${parentId}' in parents and name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  if (res.data.files.length) return res.data.files[0].id;
  const created = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    supportsAllDrives: true,
    fields: 'id',
  });
  return created.data.id;
}

async function saveMetaToDrive(drive, folderId, baseName, meta) {
  const fileName = `${baseName}_meta.json`;
  const body = JSON.stringify(meta, null, 2);
  const existing = await drive.files.list({
    q: `'${folderId}' in parents and name = '${fileName.replace(/'/g, "\\'")}' and trashed = false`,
    fields: 'files(id)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  if (existing.data.files.length) {
    await drive.files.update({
      fileId: existing.data.files[0].id,
      requestBody: {},
      media: { mimeType: 'application/json', body },
      supportsAllDrives: true,
    });
  } else {
    await drive.files.create({
      requestBody: { name: fileName, parents: [folderId], mimeType: 'application/json' },
      media: { mimeType: 'application/json', body },
      supportsAllDrives: true,
      fields: 'id',
    });
  }
}

async function readMetaFromDrive(drive, fileId) {
  const r = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' }
  );
  return JSON.parse(Buffer.from(r.data).toString('utf8'));
}

async function readDriveJson(drive, folderId, filename) {
  const res = await drive.files.list({
    q: `'${folderId}' in parents and name = '${filename}' and trashed = false`,
    fields: 'files(id)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  if (!res.data.files.length) return null;
  return readMetaFromDrive(drive, res.data.files[0].id);
}

async function writeDriveJson(drive, folderId, filename, data) {
  const body = JSON.stringify(data, null, 2);
  const existing = await drive.files.list({
    q: `'${folderId}' in parents and name = '${filename}' and trashed = false`,
    fields: 'files(id)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  if (existing.data.files.length) {
    await drive.files.update({
      fileId: existing.data.files[0].id,
      requestBody: {},
      media: { mimeType: 'application/json', body },
      supportsAllDrives: true,
    });
  } else {
    await drive.files.create({
      requestBody: { name: filename, parents: [folderId], mimeType: 'application/json' },
      media: { mimeType: 'application/json', body },
      supportsAllDrives: true,
      fields: 'id',
    });
  }
}

function renderPricingHTML(config) {
  const cats = config.categories.map((cat, i) =>
    '<span class="p-tag">' +
    '<span class="p-tag-label" id="cat-label-' + i + '" contenteditable="true" ' +
    'onblur="renameCategory(' + i + ', this.textContent.trim())" ' +
    'onkeydown="if(event.key===\'Enter\'){event.preventDefault();this.blur()}">' +
    esc(cat) + '</span>' +
    '<button class="tag-del" onclick="removeCategory(' + i + ')">&#215;</button>' +
    '</span>'
  ).join('');

  const catTh = config.categories.map(cat =>
    `<th class="pt-th">${esc(cat)} (&#8377;)</th>`).join('');

  const rows = config.sizes.map((size, si) => {
    const total = config.categories.reduce((s, c) => s + (Number(size.costs[c]) || 0), 0);
    const price = Math.round(total * (1 + (Number(size.markup) || 0) / 100));
    const cells = config.categories.map((cat, ci) =>
      `<td><input class="price-input" id="c-${si}-${ci}" type="number" min="0" value="${Number(size.costs[cat]) || 0}" oninput="updateRow(${si})" placeholder="0"></td>`
    ).join('');
    return `<tr>
      <td><input class="size-input" id="sn-${si}" value="${esc(size.name)}" placeholder="Size"></td>
      ${cells}
      <td><input class="price-input" id="sm-${si}" type="number" min="0" value="${Number(size.markup) || 40}" oninput="updateRow(${si})" placeholder="40"></td>
      <td class="computed-cell" id="total-${si}">&#8377;${Math.round(total)}</td>
      <td class="price-cell" id="price-${si}">&#8377;${price}</td>
      <td><button class="del-btn" onclick="removeSize(${si})">&#215;</button></td>
    </tr>`;
  }).join('');

  return `
    <div class="section-card">
      <div class="section-title">Expense Categories</div>
      <p class="section-hint">Click a label to rename. Changes apply on Save.</p>
      <div class="tags-row">${cats}<button class="btn-ghost" onclick="addCategory()">+ Add expense</button></div>
    </div>
    <div class="section-card">
      <div class="section-title">Size Pricing</div>
      <div style="overflow-x:auto">
        <table class="pricing-table">
          <thead><tr>
            <th class="pt-th">Size</th>${catTh}
            <th class="pt-th">Markup %</th>
            <th class="pt-th" style="text-align:right;padding-right:16px">Total Cost</th>
            <th class="pt-th" style="text-align:right;padding-right:16px">Selling Price</th>
            <th></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div style="margin-top:14px"><button class="btn-ghost" onclick="addSize()">+ Add size</button></div>
    </div>
    <div style="margin-top:8px">
      <button id="save-btn" class="btn btn-green" style="width:auto;padding:10px 28px;border-radius:8px;font-size:14px" onclick="saveConfig()">Save Configuration</button>
    </div>`;
}

function buildPricingScript(config) {
  return `var cfg = ${JSON.stringify(config)};
    function calcTotal(s) { return cfg.categories.reduce(function(t,c){return t+(Number(s.costs[c])||0);},0); }
    function calcPrice(s) { return Math.round(calcTotal(s)*(1+(Number(s.markup)||0)/100)); }
    function syncInputs() {
      cfg.sizes.forEach(function(size,si){
        var n=document.getElementById('sn-'+si); if(n) size.name=n.value;
        var m=document.getElementById('sm-'+si); if(m) size.markup=Number(m.value)||0;
        cfg.categories.forEach(function(cat,ci){
          var el=document.getElementById('c-'+si+'-'+ci); if(el) size.costs[cat]=Number(el.value)||0;
        });
      });
      cfg.categories.forEach(function(cat,i){
        var el=document.getElementById('cat-label-'+i); if(el) cfg.categories[i]=el.textContent.trim()||cat;
      });
    }
    function updateRow(si) {
      syncInputs();
      var size=cfg.sizes[si];
      var tc=document.getElementById('total-'+si); if(tc) tc.textContent='\u20B9'+Math.round(calcTotal(size));
      var pc=document.getElementById('price-'+si); if(pc) pc.textContent='\u20B9'+calcPrice(size);
    }
    async function postAndReload() {
      var r=await fetch('/api/pricing/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(cfg)});
      if(r.ok){window.location.reload();}else{showToast('Error: '+await r.text());}
    }
    function renameCategory(i,newName) {
      if(!newName||newName===cfg.categories[i]) return;
      var old=cfg.categories[i]; cfg.categories[i]=newName;
      cfg.sizes.forEach(function(s){s.costs[newName]=s.costs[old]||0;delete s.costs[old];});
    }
    async function addCategory(){syncInputs();cfg.categories.push('New Expense');cfg.sizes.forEach(function(s){s.costs['New Expense']=0;});await postAndReload();}
    async function removeCategory(i){syncInputs();var c=cfg.categories[i];cfg.categories.splice(i,1);cfg.sizes.forEach(function(s){delete s.costs[c];});await postAndReload();}
    async function addSize(){syncInputs();var costs={};cfg.categories.forEach(function(c){costs[c]=0;});cfg.sizes.push({name:'New Size',costs:costs,markup:40});await postAndReload();}
    async function removeSize(i){syncInputs();cfg.sizes.splice(i,1);await postAndReload();}
    async function saveConfig(){
      syncInputs();
      var btn=document.getElementById('save-btn');
      if(btn){btn.disabled=true;btn.textContent='Saving\u2026';}
      try{
        var r=await fetch('/api/pricing/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(cfg)});
        if(r.ok){showToast('Pricing saved \u2713');}else{showToast('Error: '+await r.text());}
      }catch(e){showToast('Network error');}
      if(btn){btn.disabled=false;btn.textContent='Save Configuration';}
    }`;
}


// ── Room mockup compositing ───────────────────────────────
const mockupCache = new Map(); // previewId → { buffer, t }

function storeMockup(buffer) {
  const id = crypto.randomUUID();
  mockupCache.set(id, { buffer });
  setTimeout(() => mockupCache.delete(id), 30 * 60 * 1000);
  return id;
}

// Detect the empty (white) frame interior in a straight-on room mockup.
// Scans pixels for the largest enclosed, rectangular, near-white region
// that doesn't touch the image edges (so white walls are excluded).
async function detectFrame(mockupBuffer) {
  const DET_W = 700;
  const meta = await sharp(mockupBuffer).metadata();
  const detH = Math.max(1, Math.round((meta.height / meta.width) * DET_W));
  const { data, info } = await sharp(mockupBuffer)
    .resize(DET_W, detH, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const W = info.width, H = info.height, ch = info.channels;
  const isWhite = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const r = data[i * ch], g = data[i * ch + 1], b = data[i * ch + 2];
    if (r > 214 && g > 214 && b > 214 && (Math.max(r, g, b) - Math.min(r, g, b)) < 26) isWhite[i] = 1;
  }

  // Flood-fill connected components (4-connectivity)
  const label = new Int32Array(W * H);
  const comps = [];
  const stack = [];
  let cur = 0;
  for (let s = 0; s < W * H; s++) {
    if (!isWhite[s] || label[s]) continue;
    cur++;
    let minx = W, miny = H, maxx = 0, maxy = 0, area = 0, touchEdge = false;
    stack.push(s); label[s] = cur;
    while (stack.length) {
      const p = stack.pop();
      const x = p % W, y = (p / W) | 0;
      area++;
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) touchEdge = true;
      if (x > 0 && isWhite[p - 1] && !label[p - 1]) { label[p - 1] = cur; stack.push(p - 1); }
      if (x < W - 1 && isWhite[p + 1] && !label[p + 1]) { label[p + 1] = cur; stack.push(p + 1); }
      if (y > 0 && isWhite[p - W] && !label[p - W]) { label[p - W] = cur; stack.push(p - W); }
      if (y < H - 1 && isWhite[p + W] && !label[p + W]) { label[p + W] = cur; stack.push(p + W); }
    }
    const bw = maxx - minx + 1, bh = maxy - miny + 1;
    comps.push({ minx, miny, bw, bh, area, fill: area / (bw * bh), touchEdge });
  }

  const minArea = W * H * 0.008;
  const cand = comps.filter(c =>
    !c.touchEdge && c.fill > 0.72 && c.area > minArea &&
    c.bw > W * 0.04 && c.bh > H * 0.04 &&
    (c.bw / c.bh) > 0.2 && (c.bw / c.bh) < 5
  ).sort((a, b) => b.area - a.area);

  if (!cand.length) return null;
  const best = cand[0];
  const sx = meta.width / W, sy = meta.height / H;
  const inset = 2;
  return {
    x: Math.round((best.minx + inset) * sx),
    y: Math.round((best.miny + inset) * sy),
    w: Math.round((best.bw - 2 * inset) * sx),
    h: Math.round((best.bh - 2 * inset) * sy),
  };
}

// Fallback: ask Claude vision to locate the empty frame opening.
// Used for photographic / AI-generated mockups where the interior isn't flat white.
async function detectFrameWithClaude(mockupBuffer) {
  const meta = await sharp(mockupBuffer).metadata();
  const resized = await sharp(mockupBuffer).resize(1024, null, { fit: 'inside' }).jpeg({ quality: 85 }).toBuffer();
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: resized.toString('base64') } },
        { type: 'text', text: 'This room photo contains one empty picture frame. Give the bounding box of the EMPTY OPENING INSIDE the frame — the blank area where artwork goes, just inside the frame molding (not including the molding itself). Express it as fractions of the image dimensions, each between 0 and 1. Reply with ONLY compact JSON and nothing else: {"x":<left>,"y":<top>,"w":<width>,"h":<height>}' },
      ],
    }],
  });
  let txt = msg.content[0].text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const box = JSON.parse(txt);
  if (typeof box.x !== 'number' || typeof box.w !== 'number' || box.w <= 0 || box.h <= 0) return null;
  return {
    x: Math.round(box.x * meta.width),
    y: Math.round(box.y * meta.height),
    w: Math.round(box.w * meta.width),
    h: Math.round(box.h * meta.height),
  };
}

// Clamp a frame rect to stay within the image bounds.
function clampFrame(frame, width, height) {
  const x = Math.max(0, Math.min(frame.x, width - 1));
  const y = Math.max(0, Math.min(frame.y, height - 1));
  return {
    x, y,
    w: Math.max(1, Math.min(frame.w, width - x)),
    h: Math.max(1, Math.min(frame.h, height - y)),
  };
}

// Place poster inside the frame, preserving aspect ratio (white padding).
async function composeMockup(mockupBuffer, posterBuffer, frame) {
  const meta = await sharp(mockupBuffer).metadata();
  const f = clampFrame(frame, meta.width, meta.height);
  const poster = await sharp(posterBuffer)
    .resize(f.w, f.h, { fit: 'contain', background: { r: 255, g: 255, b: 255 } })
    .toBuffer();
  return sharp(mockupBuffer)
    .composite([{ input: poster, left: f.x, top: f.y }])
    .png()
    .toBuffer();
}

async function pickRandomMockup(drive, excludeId) {
  const folderId = await findFolder(drive, ROOT_FOLDER_ID, MOCKUPS_FOLDER_NAME);
  const files = (await listFiles(drive, folderId)).filter(f => /\.(png|jpe?g)$/i.test(f.name));
  if (!files.length) throw new Error('No images in the "Room Mockups" folder');
  let pool = files;
  if (excludeId && files.length > 1) pool = files.filter(f => f.id !== excludeId);
  return pool[Math.floor(Math.random() * pool.length)];
}

async function fetchDriveBuffer(drive, fileId) {
  const r = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' }
  );
  return Buffer.from(r.data);
}

// ── Leonardo.ai ───────────────────────────────────────────
const LEONARDO_BASE = 'https://cloud.leonardo.ai/api/rest/v1';
// Default: Leonardo Phoenix/Flux model from the official recipe. Override via LEONARDO_MODEL_ID.
const LEONARDO_MODEL = process.env.LEONARDO_MODEL_ID || 'b2614463-296c-462a-9586-aafdb8f00e36';

function leonardoConfigured() { return !!process.env.LEONARDO_API_KEY; }

async function leoFetch(path, opts = {}) {
  const r = await fetch(LEONARDO_BASE + path, {
    ...opts,
    headers: {
      'accept': 'application/json',
      'content-type': 'application/json',
      'authorization': 'Bearer ' + process.env.LEONARDO_API_KEY,
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!r.ok) throw new Error('Leonardo ' + path + ' → ' + (json.error || json.raw || r.status));
  return json;
}

// Create a generation, poll until COMPLETE, return the first image URL.
async function leoGenerate(body) {
  const res = await leoFetch('/generations', { method: 'POST', body: JSON.stringify(body) });
  const id = res.sdGenerationJob && res.sdGenerationJob.generationId;
  if (!id) throw new Error('Leonardo did not return a generation id');
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const g = await leoFetch('/generations/' + id);
    const gen = g.generations_by_pk;
    if (gen && gen.status === 'COMPLETE') {
      const imgs = gen.generated_images || [];
      if (!imgs.length) throw new Error('Leonardo returned no images');
      return imgs[0].url;
    }
    if (gen && gen.status === 'FAILED') throw new Error('Leonardo generation failed');
  }
  throw new Error('Leonardo generation timed out');
}

async function downloadToBuffer(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('Image download failed: ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

// Faithful mode: generate an empty room with a blank frame to composite into.
async function leoGenerateRoom() {
  const url = await leoGenerate({
    prompt: 'A professional interior photograph of a stylish modern living room. A single picture frame hangs centered on a softly coloured accent wall. The inside of the frame is completely plain, solid white and empty — no artwork, no picture, no text inside it. Natural daylight, photorealistic, high detail.',
    modelId: LEONARDO_MODEL,
    contrast: 3.5,
    styleUUID: '5bdc3f2a-1be6-4d1c-8e77-992a30824a2c', // Stock Photo — realistic interiors
    width: 1024, height: 768, num_images: 1,
  });
  return downloadToBuffer(url);
}

// Upload an image to Leonardo, return its init image id.
async function leoUploadInitImage(buffer, ext = 'png') {
  const init = await leoFetch('/init-image', { method: 'POST', body: JSON.stringify({ extension: ext }) });
  const u = init.uploadInitImage;
  const fields = JSON.parse(u.fields);
  const form = new FormData();
  Object.entries(fields).forEach(([k, v]) => form.append(k, v));
  form.append('file', new Blob([buffer]), 'init.' + ext);
  const up = await fetch(u.url, { method: 'POST', body: form });
  if (!up.ok) throw new Error('Init image upload failed: ' + up.status);
  return u.id;
}

// Guidance mode: Leonardo paints the poster into a scene (reinterprets artwork).
async function leoGenerateScene(posterBuffer) {
  const initId = await leoUploadInitImage(posterBuffer, 'png');
  const url = await leoGenerate({
    prompt: 'a stylish, well-lit modern living room interior with a large framed art print as the focal point on the wall, interior design photography, photorealistic',
    modelId: LEONARDO_MODEL,
    contrast: 3.5,
    width: 1024, height: 768, num_images: 1,
    controlnets: [{
      initImageId: initId,
      initImageType: 'UPLOADED',
      preprocessorId: 233,       // Flux Dev — Content Reference
      strengthType: 'High',
    }],
  });
  return downloadToBuffer(url);
}

// Generate a room with a large empty bare wall (no frame) to mount a poster onto.
async function leoGenerateBareRoom() {
  const url = await leoGenerate({
    prompt: 'A professional interior photograph of a stylish modern living room with a large clear empty blank wall at eye level. Tasteful furniture below and to the sides, the wall itself is completely bare — no pictures, no frames, no posters, no wall art. Soft natural daylight, photorealistic, high detail.',
    modelId: LEONARDO_MODEL,
    contrast: 3.5,
    styleUUID: '5bdc3f2a-1be6-4d1c-8e77-992a30824a2c', // Stock Photo — realistic interiors
    width: 1024, height: 768, num_images: 1,
  });
  return downloadToBuffer(url);
}

// Ask Claude for the best clear wall area to hang a poster (fractions → pixels).
async function detectWallArea(roomBuffer) {
  const meta = await sharp(roomBuffer).metadata();
  const resized = await sharp(roomBuffer).resize(1024, null, { fit: 'inside' }).jpeg({ quality: 85 }).toBuffer();
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: resized.toString('base64') } },
        { type: 'text', text: 'This is a photo of a room with a large empty wall. Give the bounding box of the best clear, empty wall area to hang a single poster at roughly eye level — centered on open wall, not overlapping furniture, windows, lamps, or the ceiling/floor edges. Express as fractions of the image dimensions, each 0 to 1. Reply with ONLY compact JSON: {"x":<left>,"y":<top>,"w":<width>,"h":<height>}' },
      ],
    }],
  });
  let txt = msg.content[0].text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const b = JSON.parse(txt);
  if (typeof b.x !== 'number' || !(b.w > 0) || !(b.h > 0)) return null;
  return { x: Math.round(b.x * meta.width), y: Math.round(b.y * meta.height), w: Math.round(b.w * meta.width), h: Math.round(b.h * meta.height) };
}

// Composite the poster onto the wall as a 3D-looking mounted print with a drop shadow.
async function composeOnWall(roomBuffer, posterBuffer) {
  const meta = await sharp(roomBuffer).metadata();
  let area = null;
  try { area = await detectWallArea(roomBuffer); } catch (e) {}
  if (!area) {
    area = { x: Math.round(meta.width * 0.34), y: Math.round(meta.height * 0.16), w: Math.round(meta.width * 0.32), h: Math.round(meta.height * 0.5) };
  }
  area = clampFrame(area, meta.width, meta.height);

  const pMeta = await sharp(posterBuffer).metadata();
  const maxW = Math.round(area.w * 0.85), maxH = Math.round(area.h * 0.85);
  const scale = Math.min(maxW / pMeta.width, maxH / pMeta.height);
  const pw = Math.max(40, Math.round(pMeta.width * scale));
  const ph = Math.max(40, Math.round(pMeta.height * scale));
  const px = Math.round(area.x + (area.w - pw) / 2);
  const py = Math.round(area.y + (area.h - ph) / 2);

  // Poster with a thin dark edge so it reads as a physical object against the wall
  const poster = await sharp(posterBuffer)
    .resize(pw, ph, { fit: 'fill' })
    .extend({ top: 3, bottom: 3, left: 3, right: 3, background: { r: 22, g: 20, b: 18 } })
    .toBuffer();

  // Drop shadow — a dark rect at an offset, blurred across a full-size transparent layer
  const blur = Math.max(8, Math.round(Math.max(pw, ph) * 0.025));
  const offX = Math.round(blur * 0.5);
  const offY = Math.round(blur * 0.9);
  const darkRect = await sharp({ create: { width: pw, height: ph, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.5 } } }).png().toBuffer();
  const shadowLeft = Math.max(0, Math.min(px + offX, meta.width - pw));
  const shadowTop = Math.max(0, Math.min(py + offY, meta.height - ph));
  const shadow = await sharp({ create: { width: meta.width, height: meta.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: darkRect, left: shadowLeft, top: shadowTop }])
    .blur(blur)
    .png().toBuffer();

  return sharp(roomBuffer)
    .composite([
      { input: shadow, left: 0, top: 0 },
      { input: poster, left: Math.max(0, px - 3), top: Math.max(0, py - 3) },
    ])
    .png()
    .toBuffer();
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Drop name helpers — folder names carry a theme + a date, e.g. "Mad for Manga 22-June-2026"
function parseDropDate(name) {
  const m = name.match(/(\d{1,2})[-\s]([A-Za-z]+)[-\s](\d{4})/);
  if (!m) return null;
  const d = new Date(`${m[2]} ${m[1]}, ${m[3]}`);
  return isNaN(d.getTime()) ? null : d;
}
function stripDropDate(name) {
  return name.replace(/\s*\d{1,2}[-\s][A-Za-z]+[-\s]\d{4}\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
}
function sizePrice(size, categories) {
  const total = categories.reduce((s, c) => s + (Number(size.costs[c]) || 0), 0);
  return Math.round(total * (1 + (Number(size.markup) || 0) / 100));
}

const css = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f4f4f5; min-height: 100vh; color: #111; }
  a { color: inherit; }
  header { background: #fff; border-bottom: 1px solid #e5e7eb; height: 58px; padding: 0 28px; display: flex; align-items: center; justify-content: space-between; position: sticky; top: 0; z-index: 10; }
  .logo { font-size: 15px; font-weight: 600; text-decoration: none; }
  .hdr-right { display: flex; align-items: center; gap: 14px; }
  .email { font-size: 13px; color: #6b7280; }
  .btn-logout { font-size: 13px; color: #374151; text-decoration: none; padding: 5px 12px; border: 1px solid #d1d5db; border-radius: 6px; }
  .btn-logout:hover { background: #f3f4f6; }
  main { max-width: 1400px; margin: 0 auto; padding: 32px 28px; }
  .page-hdr { display: flex; align-items: center; gap: 14px; margin-bottom: 28px; }
  .back { font-size: 13px; color: #6b7280; text-decoration: none; white-space: nowrap; }
  .back:hover { color: #111; }
  h1 { font-size: 21px; font-weight: 600; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(200px, 100%), 1fr)); gap: 16px; }
  .poster-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(600px, 100%), 1fr)); gap: 20px; }
  .folder-card { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 20px; text-decoration: none; display: flex; flex-direction: column; gap: 10px; transition: box-shadow 0.15s; }
  .folder-card:hover { box-shadow: 0 2px 12px rgba(0,0,0,0.08); }
  .folder-icon { font-size: 26px; }
  .folder-name { font-size: 14px; font-weight: 500; line-height: 1.4; }
  .poster-card { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; overflow: hidden; display: grid; grid-template-columns: 220px 1fr; min-height: 400px; }
  .poster-img-wrap { overflow: hidden; }
  .poster-img { width: 100%; height: 100%; object-fit: cover; background: #e5e7eb; display: block; }
  .poster-body { padding: 20px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }
  .poster-name { font-size: 15px; font-weight: 600; color: #111; }
  .actions { display: flex; flex-direction: column; gap: 7px; margin-top: auto; }
  .btn { padding: 8px 12px; border-radius: 6px; font-size: 13px; font-weight: 500; border: none; cursor: pointer; text-align: center; text-decoration: none; display: block; width: 100%; transition: opacity 0.15s; }
  .btn:hover:not(:disabled) { opacity: 0.85; }
  .btn-green { background: #16a34a; color: #fff; }
  .btn-green:disabled { background: #bbf7d0; color: #166534; cursor: default; }
  .btn-listed { background: #dcfce7; color: #15803d; cursor: default; font-size: 12px; pointer-events: none; }
  .btn-gray { background: #f3f4f6; color: #374151; border: 1px solid #d1d5db; }
  .btn-gray:hover { background: #e5e7eb; }
  .btn-red { background: #fee2e2; color: #b91c1c; border: 1px solid #fecaca; }
  .btn-red:hover:not(:disabled) { background: #fecaca; }
  .empty { color: #9ca3af; font-size: 15px; padding: 64px 0; text-align: center; grid-column: 1/-1; }
  .toast { position: fixed; bottom: 24px; right: 24px; background: #111; color: #fff; padding: 12px 20px; border-radius: 8px; font-size: 14px; opacity: 0; transition: opacity 0.25s; pointer-events: none; z-index: 100; }
  .toast.show { opacity: 1; }
  .badge-missing { font-size: 11px; color: #9ca3af; text-align: center; }
  .nav-link { font-size: 13px; color: #6b7280; text-decoration: none; padding: 4px 0; border-bottom: 2px solid transparent; }
  .nav-link:hover, .nav-link.active { color: #111; border-bottom-color: #111; }
  .section-card { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 24px; margin-bottom: 20px; }
  .section-title { font-size: 15px; font-weight: 600; margin-bottom: 4px; }
  .section-hint { font-size: 12px; color: #9ca3af; margin-bottom: 14px; }
  .tags-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .p-tag { display: inline-flex; align-items: center; gap: 4px; background: #f3f4f6; border-radius: 6px; padding: 5px 6px 5px 10px; font-size: 13px; }
  .p-tag-label { outline: none; min-width: 40px; }
  .p-tag-label:focus { background: #fff; border-radius: 3px; padding: 0 2px; }
  .tag-del { background: none; border: none; cursor: pointer; color: #9ca3af; font-size: 15px; line-height: 1; padding: 0 2px; }
  .tag-del:hover { color: #b91c1c; }
  .pricing-table { width: 100%; border-collapse: collapse; font-size: 13px; min-width: 500px; }
  .pt-th { text-align: left; padding: 8px 10px; border-bottom: 2px solid #e5e7eb; color: #6b7280; font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; white-space: nowrap; }
  .pricing-table td { padding: 6px 8px; border-bottom: 1px solid #f3f4f6; vertical-align: middle; }
  .pricing-table tr:last-child td { border-bottom: none; }
  .price-input { border: 1px solid #e5e7eb; border-radius: 6px; padding: 6px 8px; font-size: 13px; width: 90px; text-align: right; font-family: inherit; background: #fafafa; }
  .price-input:focus { outline: none; border-color: #6b7280; background: #fff; }
  .size-input { border: 1px solid #e5e7eb; border-radius: 6px; padding: 6px 8px; font-size: 13px; font-weight: 600; width: 72px; font-family: inherit; background: #fafafa; }
  .size-input:focus { outline: none; border-color: #6b7280; background: #fff; }
  .computed-cell { color: #374151; font-weight: 500; text-align: right; padding-right: 16px !important; white-space: nowrap; }
  .price-cell { color: #16a34a; font-weight: 700; text-align: right; padding-right: 16px !important; white-space: nowrap; font-size: 14px; }
  .del-btn { background: none; border: none; color: #d1d5db; cursor: pointer; font-size: 18px; padding: 2px 6px; border-radius: 4px; }
  .del-btn:hover { color: #b91c1c; background: #fee2e2; }
  .meta-section { border-top: 1px solid #f3f4f6; padding-top: 10px; display: flex; flex-direction: column; gap: 7px; }
  .meta-label { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: #9ca3af; }
  .meta-input { width: 100%; font-size: 13px; font-family: inherit; border: 1px solid #e5e7eb; border-radius: 6px; padding: 6px 8px; color: #111; background: #fafafa; resize: none; transition: border-color 0.15s; }
  .meta-input:focus { outline: none; border-color: #6b7280; background: #fff; }
  .meta-row { display: flex; gap: 6px; }
  .btn-ghost { background: none; border: 1px solid #e5e7eb; color: #6b7280; font-size: 12px; padding: 5px 10px; border-radius: 6px; cursor: pointer; flex: 1; }
  .btn-ghost:hover { background: #f3f4f6; color: #111; }
  .btn-save { background: #111; color: #fff; font-size: 12px; padding: 5px 10px; border-radius: 6px; border: none; cursor: pointer; flex: 1; }
  .btn-save:hover { background: #374151; }
  .meta-status { font-size: 11px; color: #9ca3af; text-align: right; min-height: 14px; }
  .generating { color: #6b7280; font-size: 12px; display: flex; align-items: center; gap: 6px; padding: 8px 0; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .spinner { width: 12px; height: 12px; border: 2px solid #e5e7eb; border-top-color: #6b7280; border-radius: 50%; animation: spin 0.7s linear infinite; flex-shrink: 0; }
  .poster-img { cursor: zoom-in; }
  .lightbox { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.85); z-index: 200; align-items: center; justify-content: center; padding: 24px; }
  .lightbox.open { display: flex; }
  .lightbox-inner { position: relative; max-width: 90vw; max-height: 90vh; }
  .lightbox-img { max-width: 90vw; max-height: 90vh; object-fit: contain; border-radius: 4px; display: block; }
  .lightbox-close { position: absolute; top: -14px; right: -14px; width: 32px; height: 32px; background: #fff; border: none; border-radius: 50%; cursor: pointer; font-size: 18px; display: flex; align-items: center; justify-content: center; line-height: 1; box-shadow: 0 2px 8px rgba(0,0,0,0.3); }
  .lightbox-name { color: #fff; font-size: 13px; text-align: center; margin-top: 12px; opacity: 0.7; }
  .room-inner { position: relative; background: #fff; border-radius: 12px; padding: 16px; max-width: 92vw; max-height: 92vh; display: flex; flex-direction: column; gap: 12px; }
  .room-stage { display: flex; align-items: center; justify-content: center; min-width: 320px; min-height: 320px; max-width: 86vw; }
  .room-img { max-width: 86vw; max-height: 74vh; object-fit: contain; border-radius: 6px; display: block; }
  .room-loading { display: flex; align-items: center; gap: 10px; color: #6b7280; font-size: 14px; padding: 80px 40px; }
  .room-bar { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding-top: 4px; border-top: 1px solid #f3f4f6; }
  .room-status { font-size: 13px; color: #6b7280; }
  .room-btns { display: flex; gap: 8px; align-items: center; }
  .room-sources { display: flex; gap: 8px; flex-wrap: wrap; }

  @media (max-width: 700px) {
    header { padding: 6px 16px; height: auto; min-height: 56px; flex-wrap: wrap; gap: 8px; row-gap: 6px; }
    header > div:first-child { gap: 14px; flex-wrap: wrap; }
    nav { gap: 14px !important; }
    .email { display: none; }
    main { padding: 20px 16px; }
    .poster-card { grid-template-columns: 1fr; min-height: 0; }
    .poster-img-wrap { max-height: 360px; }
    .poster-img { width: 100%; height: auto; max-height: 360px; }
    .page-hdr { flex-wrap: wrap; gap: 8px; }
    h1 { font-size: 19px; }
    .section-card { padding: 16px; }
    .room-inner { padding: 12px; max-width: 96vw; }
    .room-stage { min-width: 0; min-height: 200px; max-width: 92vw; }
    .room-img { max-width: 92vw; }
    .room-bar { flex-direction: column; align-items: stretch; gap: 10px; }
    .room-btns { width: 100%; }
    .room-btns .btn { flex: 1; }
    .lightbox-inner { max-width: 96vw; }
  }
`;

const toastScript = `
  function showToast(msg, ms = 3000) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), ms);
  }
  function openLightbox(src, name) {
    const lb = document.getElementById('lightbox');
    document.getElementById('lightbox-img').src = src;
    document.getElementById('lightbox-name').textContent = name;
    lb.classList.add('open');
  }
  function closeLightbox() {
    document.getElementById('lightbox').classList.remove('open');
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });
`;

const roomScript = `
  var roomState = { folderId: null, baseName: null, webId: null, previewId: null, mockupId: null };
  function setRoomBusy(busy, text) {
    document.getElementById('room-loading').style.display = busy ? 'flex' : 'none';
    if (text) document.getElementById('room-loading-text').textContent = text;
    document.querySelectorAll('.room-sources .btn').forEach(function(b){ b.disabled = busy; });
    document.getElementById('room-accept').disabled = busy || !roomState.previewId;
  }
  function previewRoom(folderId, baseName, webId) {
    roomState = { folderId: folderId, baseName: baseName, webId: webId, previewId: null, mockupId: null };
    document.getElementById('room-img').style.display = 'none';
    document.getElementById('room-status').textContent = '';
    document.getElementById('room-accept').disabled = true;
    document.getElementById('room-modal').classList.add('open');
    srcFolder();
  }
  async function runSource(endpoint, body, label) {
    document.getElementById('room-img').style.display = 'none';
    roomState.previewId = null;
    setRoomBusy(true, label);
    try {
      var r = await fetch(endpoint, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
      if (r.ok) {
        var d = await r.json();
        roomState.previewId = d.previewId;
        if (d.mockupId) roomState.mockupId = d.mockupId;
        var img = document.getElementById('room-img');
        img.onload = function() { setRoomBusy(false); img.style.display = 'block'; document.getElementById('room-accept').disabled = false; };
        img.src = '/api/mockup-preview/' + d.previewId;
        document.getElementById('room-status').textContent = d.mockupName || '';
      } else {
        setRoomBusy(false);
        document.getElementById('room-status').textContent = 'Error: ' + await r.text();
      }
    } catch (e) {
      setRoomBusy(false);
      document.getElementById('room-status').textContent = 'Network error';
    }
  }
  function srcFolder() { runSource('/api/mockup', { webFileId: roomState.webId, excludeMockupId: roomState.mockupId }, 'Picking a room mockup…'); }
  function srcGenerate() { runSource('/api/mockup-generate', { webFileId: roomState.webId }, 'Generating a room with Leonardo… (up to a minute)'); }
  function srcScene() { runSource('/api/mockup-ai-scene', { webFileId: roomState.webId }, 'Leonardo is painting the scene… (up to a minute)'); }
  async function acceptRoom() {
    if (!roomState.previewId) return;
    var btn = document.getElementById('room-accept');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      var r = await fetch('/api/mockup-accept', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ previewId: roomState.previewId, folderId: roomState.folderId, baseName: roomState.baseName }) });
      if (r.ok) { var d = await r.json(); showToast('Saved ' + d.fileName + ' ✓'); closeRoom(); }
      else { document.getElementById('room-status').textContent = 'Error: ' + await r.text(); }
    } catch (e) { document.getElementById('room-status').textContent = 'Network error'; }
    btn.disabled = false; btn.textContent = 'Accept & Save';
  }
  function closeRoom() { document.getElementById('room-modal').classList.remove('open'); }
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeRoom(); });
`;

function layout(title, user, body, extraScript = '') {
  const topLevel = ['Posters', 'Orders', 'Pricing', 'Settings'];
  const nav = [
    { href: '/', label: 'Posters' },
    { href: '/orders', label: 'Orders' },
    { href: '/pricing', label: 'Pricing' },
    { href: '/settings', label: 'Settings' },
  ].map(l => `<a href="${l.href}" class="nav-link${title === l.label || (l.href === '/' && !topLevel.includes(title)) ? ' active' : ''}">${l.label}</a>`).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)} — HueDistrict Admin</title>
  <style>${css}</style>
</head>
<body>
  <header>
    <div style="display:flex;align-items:center;gap:24px">
      <a href="/" class="logo">HueDistrict Admin</a>
      <nav style="display:flex;gap:20px">${nav}</nav>
    </div>
    <div class="hdr-right">
      <span class="email">${esc(user.email)}</span>
      <a href="/logout" class="btn-logout">Sign out</a>
    </div>
  </header>
  <main>${body}</main>
  <div class="toast" id="toast"></div>
  <div class="lightbox" id="lightbox" onclick="if(event.target===this)closeLightbox()">
    <div class="lightbox-inner">
      <button class="lightbox-close" onclick="closeLightbox()">×</button>
      <img class="lightbox-img" id="lightbox-img" src="" alt="">
      <div class="lightbox-name" id="lightbox-name"></div>
    </div>
  </div>
  <div class="lightbox" id="room-modal" onclick="if(event.target===this)closeRoom()">
    <div class="room-inner">
      <button class="lightbox-close" onclick="closeRoom()">×</button>
      <div class="room-stage">
        <div class="room-loading" id="room-loading"><div class="spinner"></div><span id="room-loading-text">Generating room preview…</span></div>
        <img class="room-img" id="room-img" src="" alt="" style="display:none">
      </div>
      <div class="room-bar">
        <div class="room-sources">
          <button class="btn btn-gray" onclick="srcFolder()" style="width:auto;padding:8px 14px">🎲 Mockup folder</button>
          <button class="btn btn-gray" onclick="srcGenerate()" style="width:auto;padding:8px 14px">✨ Generate room</button>
          <button class="btn btn-gray" onclick="srcScene()" style="width:auto;padding:8px 14px">🖼 AI scene</button>
        </div>
        <div class="room-btns">
          <span class="room-status" id="room-status"></span>
          <button class="btn btn-green" id="room-accept" onclick="acceptRoom()" style="width:auto;padding:8px 20px" disabled>Accept &amp; Save</button>
        </div>
      </div>
    </div>
  </div>
  <script>${toastScript}${roomScript}${extraScript}</script>
</body>
</html>`;
}

const loginPage = (error = '') => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign in — HueDistrict Admin</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f4f4f5; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #fff; border-radius: 12px; padding: 48px 40px; width: 100%; max-width: 360px; box-shadow: 0 1px 3px rgba(0,0,0,0.08), 0 4px 16px rgba(0,0,0,0.06); text-align: center; }
    h1 { font-size: 20px; font-weight: 600; color: #111; margin-bottom: 6px; }
    p { color: #6b7280; font-size: 14px; margin-bottom: 32px; }
    .error { color: #b91c1c; font-size: 13px; margin-bottom: 20px; background: #fef2f2; border: 1px solid #fecaca; padding: 10px 14px; border-radius: 8px; }
    .google-btn { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; background: #fff; border: 1px solid #d1d5db; border-radius: 8px; padding: 11px 20px; text-decoration: none; color: #111; font-size: 14px; font-weight: 500; transition: background 0.15s, box-shadow 0.15s; }
    .google-btn:hover { background: #f9fafb; box-shadow: 0 1px 4px rgba(0,0,0,0.1); }
  </style>
</head>
<body>
  <div class="card">
    <h1>HueDistrict Admin</h1>
    <p>Sign in to continue</p>
    ${error ? `<div class="error">${esc(error)}</div>` : ''}
    <a href="/auth/google" class="google-btn">
      <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.32-8.16 2.32-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
      Continue with Google
    </a>
  </div>
</body>
</html>`;

// ── Routes ──────────────────────────────────────────────

app.get('/login', (req, res) => {
  const error = req.query.error === 'access_denied'
    ? 'Your account is not authorised to access this panel.'
    : '';
  res.send(loginPage(error));
});

app.get('/auth/google', passport.authenticate('google', {
  scope: ['profile', 'email', 'https://www.googleapis.com/auth/drive'],
  accessType: 'offline',
  prompt: 'consent',
}));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login?error=access_denied' }),
  (req, res) => res.redirect('/')
);

app.get('/logout', (req, res) => {
  req.logout(() => res.redirect('/login'));
});

// Dashboard — list subfolders of "Posters for Review"
app.get('/', requireAuth, async (req, res) => {
  try {
    const drive = getDriveClient(req.user);
    const reviewId = await findFolder(drive, ROOT_FOLDER_ID, REVIEW_FOLDER_NAME);
    const folders = await listSubfolders(drive, reviewId);

    // Sort by the date in the folder name (e.g. "8-June-2025"), oldest first.
    // Folders without a parseable date fall to the bottom.
    const dropTime = (name) => {
      const m = name.match(/(\d{1,2})[-\s]([A-Za-z]+)[-\s](\d{4})/);
      if (!m) return Infinity;
      const t = new Date(`${m[2]} ${m[1]}, ${m[3]}`).getTime();
      return isNaN(t) ? Infinity : t;
    };
    folders.sort((a, b) => dropTime(a.name) - dropTime(b.name));

    const items = folders.length
      ? folders.map(f => `
          <a href="/folder/${esc(f.id)}?name=${encodeURIComponent(f.name)}" class="folder-card">
            <div class="folder-icon">🗂</div>
            <div class="folder-name">${esc(f.name)}</div>
          </a>`).join('')
      : '<div class="empty">No folders yet in Posters for Review</div>';

    res.send(layout('Dashboard', req.user, `
      <div class="page-hdr"><h1>Posters for Review</h1></div>
      <div class="grid">${items}</div>
    `));
  } catch (err) {
    res.status(500).send(`<pre>Error: ${esc(err.message)}</pre>`);
  }
});

// Folder view — poster sets in a subfolder
app.get('/folder/:folderId', requireAuth, async (req, res) => {
  try {
    const drive = getDriveClient(req.user);
    const { folderId } = req.params;
    const folderName = req.query.name || 'Folder';

    const [files, saleFolderId] = await Promise.all([
      listFiles(drive, folderId),
      findFolder(drive, ROOT_FOLDER_ID, SALE_FOLDER_NAME),
    ]);

    // Check which posters are already listed for sale
    const saleSubRes = await drive.files.list({
      q: `'${saleFolderId}' in parents and name = '${folderName.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    const listedNames = new Set();
    if (saleSubRes.data.files.length) {
      const saleFiles = await listFiles(drive, saleSubRes.data.files[0].id);
      saleFiles.forEach(f => listedNames.add(f.name));
    }

    const posters = groupPosters(files);

    // Load existing meta content for posters that have it
    const metaContent = {};
    await Promise.all(posters.filter(p => p.meta).map(async p => {
      try { metaContent[p.name.toLowerCase()] = await readMetaFromDrive(drive, p.meta.id); } catch {}
    }));

    function metaSection(p) {
      const meta = metaContent[p.name.toLowerCase()];
      const safeBase = esc(p.name);
      const webId = p.web?.id || '';
      const webMime = p.web?.mimeType || 'image/jpeg';
      if (!p.web) return '';
      if (meta) {
        const tags = Array.isArray(meta.hashtags) ? meta.hashtags.join(' ') : (meta.hashtags || '');
        const modLabel = meta.modifiedAt ? `Edited ${new Date(meta.modifiedAt).toLocaleDateString()}` : `Generated ${new Date(meta.generatedAt).toLocaleDateString()}`;
        return `
          <div class="meta-section">
            <div class="meta-label">Instagram Caption</div>
            <input class="meta-input" id="title-${safeBase}" value="${esc(meta.title || '')}" placeholder="Title">
            <textarea class="meta-input" id="caption-${safeBase}" rows="4" placeholder="Caption">${esc(meta.caption || '')}</textarea>
            <textarea class="meta-input" id="hashtags-${safeBase}" rows="3" placeholder="#hashtags">${esc(tags)}</textarea>
            <div class="meta-row">
              <button class="btn-save" onclick="saveMeta(this,'${esc(folderId)}','${safeBase}')">Save</button>
              <button class="btn-ghost" onclick="generateMeta(this,'${esc(folderId)}','${safeBase}','${webId}','${esc(webMime)}','${esc(folderName)}')">↺ Regenerate</button>
            </div>
            <div class="meta-status" id="status-${safeBase}">${esc(modLabel)}</div>
          </div>`;
      }
      return `
        <div class="meta-section" id="metasec-${safeBase}">
          <div class="generating"><div class="spinner"></div>Generating caption…</div>
        </div>`;
    }

    const needsGeneration = posters
      .filter(p => p.web && !p.meta)
      .map(p => ({
        baseName: p.name,
        webFileId: p.web.id,
        webMimeType: p.web.mimeType || 'image/jpeg',
      }));

    const cards = posters.length
      ? posters.map(p => {
          const isListed = p.ig && listedNames.has(p.ig.name);
          const canApprove = p.ig && p.web;
          return `
            <div class="poster-card">
              <div class="poster-img-wrap">
                ${p.web
                  ? `<img class="poster-img" src="/api/preview/${esc(p.web.id)}" alt="${esc(p.name)}" loading="lazy" onclick="openLightbox(this.src,'${esc(p.name)}')">`
                  : `<div class="poster-img"></div>`}
              </div>
              <div class="poster-body">
                <div class="poster-name" title="${esc(p.name)}">${esc(p.name)}</div>
                ${metaSection(p)}
                <div class="actions">
                  <div class="status-actions">
                    ${isListed
                      ? `<div class="btn btn-listed">✓ Listed for Sale</div>
                         <button class="btn btn-red" onclick="unlist(this,'${esc(folderName)}','${esc(p.ig?.name||'')}','${esc(p.web?.name||'')}','${p.ig?.id||''}','${p.web?.id||''}','${esc(p.name)}')">Unlist</button>`
                      : canApprove
                        ? `<button class="btn btn-green" onclick="approve(this,'${esc(folderName)}','${p.ig.id}','${p.web.id}','${esc(p.ig.name)}','${esc(p.web.name)}','${esc(p.name)}')">Ready for Sale</button>`
                        : `<div class="badge-missing">Missing _ig or _web version</div>`}
                  </div>
                  ${p.web
                    ? `<button class="btn btn-gray" onclick="previewRoom('${esc(folderId)}','${esc(p.name)}','${p.web.id}')">🖼 Preview in Room</button>`
                    : ''}
                  ${p.pdf
                    ? `<a href="/api/download/${esc(p.pdf.id)}" class="btn btn-gray">Download PDF</a>`
                    : ''}
                </div>
              </div>
            </div>`;
        }).join('')
      : '<div class="empty">No posters in this folder</div>';

    const script = `
      const _folderId = '${esc(folderId)}';
      const _folderName = '${esc(folderName)}';

      async function generateMeta(btn, folderId, baseName, webFileId, webMimeType, folderName) {
        const sec = btn ? btn.closest('.meta-section') : document.getElementById('metasec-' + baseName);
        if (sec) sec.innerHTML = '<div class="generating"><div class="spinner"></div>Generating…</div>';
        try {
          const r = await fetch('/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folderId, baseName, webFileId, webMimeType, folderName }),
          });
          if (r.ok) {
            const meta = await r.json();
            const tags = meta.hashtags.join(' ');
            if (sec) sec.outerHTML = \`
              <div class="meta-section">
                <div class="meta-label">Instagram Caption</div>
                <input class="meta-input" id="title-\${baseName}" value="\${meta.title}" placeholder="Title">
                <textarea class="meta-input" id="caption-\${baseName}" rows="3" placeholder="Caption">\${meta.caption}</textarea>
                <textarea class="meta-input" id="hashtags-\${baseName}" rows="2" placeholder="#hashtags">\${tags}</textarea>
                <div class="meta-row">
                  <button class="btn-save" onclick="saveMeta(this,'${esc(folderId)}','\${baseName}')">Save</button>
                  <button class="btn-ghost" onclick="generateMeta(this,'${esc(folderId)}','\${baseName}','\${webFileId}','\${webMimeType}','${esc(folderName)}')">↺ Regenerate</button>
                </div>
                <div class="meta-status" id="status-\${baseName}">Generated just now</div>
              </div>\`;
            showToast('Caption generated ✓');
          } else {
            if (sec) sec.innerHTML = '<div class="badge-missing">Generation failed — <button class="btn-ghost" style="display:inline;padding:2px 8px" onclick="generateMeta(null,\\''+folderId+'\\',\\''+baseName+'\\',\\''+webFileId+'\\',\\''+webMimeType+'\\',\\''+folderName+'\\')">Retry</button></div>';
            showToast('Error: ' + await r.text());
          }
        } catch {
          showToast('Network error during generation');
        }
      }

      async function saveMeta(btn, folderId, baseName) {
        const title = document.getElementById('title-' + baseName)?.value || '';
        const caption = document.getElementById('caption-' + baseName)?.value || '';
        const hashtagsRaw = document.getElementById('hashtags-' + baseName)?.value || '';
        const hashtags = hashtagsRaw.trim().split(/\\s+/).filter(Boolean);
        btn.textContent = 'Saving…';
        try {
          const r = await fetch('/api/save-meta', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folderId, baseName, title, caption, hashtags }),
          });
          if (r.ok) {
            btn.textContent = 'Save';
            const status = document.getElementById('status-' + baseName);
            if (status) status.textContent = 'Saved just now';
            showToast('Saved ✓');
          } else {
            btn.textContent = 'Save';
            showToast('Save failed: ' + await r.text());
          }
        } catch {
          btn.textContent = 'Save';
          showToast('Network error');
        }
      }

      async function approve(btn, folderName, igId, webId, igName, webName, baseName) {
        btn.disabled = true;
        btn.textContent = 'Processing…';
        try {
          const r = await fetch('/api/approve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folderName, igId, webId, srcFolderId: _folderId, baseName }),
          });
          if (r.ok) {
            btn.closest('.status-actions').innerHTML =
              '<div class="btn btn-listed">✓ Listed for Sale</div>' +
              '<button class="btn btn-red" onclick="unlist(this,\\'' + folderName + '\\',\\'' + igName + '\\',\\'' + webName + '\\',\\'' + igId + '\\',\\'' + webId + '\\',\\'' + baseName + '\\')">Unlist</button>';
            showToast('Added to Posters for Sale ✓');
          } else {
            btn.disabled = false;
            btn.textContent = 'Ready for Sale';
            showToast('Error: ' + await r.text());
          }
        } catch {
          btn.disabled = false;
          btn.textContent = 'Ready for Sale';
          showToast('Network error — try again');
        }
      }

      async function unlist(btn, folderName, igName, webName, igId, webId, baseName) {
        if (!confirm('Remove this poster from sale? The copies in Posters for Sale will be deleted.')) return;
        btn.disabled = true;
        btn.textContent = 'Removing…';
        try {
          const r = await fetch('/api/unlist', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folderName, igName, webName, baseName }),
          });
          if (r.ok) {
            btn.closest('.status-actions').innerHTML =
              '<button class="btn btn-green" onclick="approve(this,\\'' + folderName + '\\',\\'' + igId + '\\',\\'' + webId + '\\',\\'' + igName + '\\',\\'' + webName + '\\',\\'' + baseName + '\\')">Ready for Sale</button>';
            showToast('Removed from Posters for Sale');
          } else {
            btn.disabled = false;
            btn.textContent = 'Unlist';
            showToast('Error: ' + await r.text());
          }
        } catch {
          btn.disabled = false;
          btn.textContent = 'Unlist';
          showToast('Network error — try again');
        }
      }

      // Auto-generate for new posters on page load
      const needsGen = ${JSON.stringify(needsGeneration)};
      needsGen.forEach(p => {
        generateMeta(null, _folderId, p.baseName, p.webFileId, p.webMimeType, _folderName);
      });`;

    res.send(layout(folderName, req.user, `
      <div class="page-hdr">
        <a href="/" class="back">← All folders</a>
        <h1>${esc(folderName)}</h1>
      </div>
      <div class="poster-grid">${cards}</div>
    `, script));
  } catch (err) {
    res.status(500).send(`<pre>Error: ${esc(err.message)}</pre>`);
  }
});

// Proxy web preview image (short cache ok — image won't change during session)
app.get('/api/preview/:fileId', requireAuth, async (req, res) => {
  try {
    const drive = getDriveClient(req.user);
    const [meta, response] = await Promise.all([
      drive.files.get({ fileId: req.params.fileId, fields: 'mimeType', supportsAllDrives: true }),
      drive.files.get({ fileId: req.params.fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'stream' }),
    ]);
    res.set('Content-Type', meta.data.mimeType || 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=300');
    response.data.pipe(res);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Download original PDF
app.get('/api/download/:fileId', requireAuth, async (req, res) => {
  try {
    const drive = getDriveClient(req.user);
    const [meta, response] = await Promise.all([
      drive.files.get({ fileId: req.params.fileId, fields: 'name,mimeType', supportsAllDrives: true }),
      drive.files.get({ fileId: req.params.fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'stream' }),
    ]);
    res.set('Content-Type', meta.data.mimeType);
    res.set('Content-Disposition', `attachment; filename="${meta.data.name}"`);
    response.data.pipe(res);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Copy _ig.png + _web.png to Posters for Sale
app.post('/api/approve', requireAuth, async (req, res) => {
  try {
    const { folderName, igId, webId, srcFolderId, baseName } = req.body;
    if (!folderName || !igId || !webId) return res.status(400).send('Missing fields');

    const drive = getDriveClient(req.user);
    const saleFolderId = await findFolder(drive, ROOT_FOLDER_ID, SALE_FOLDER_NAME);
    const destId = await getOrCreateSubfolder(drive, saleFolderId, folderName);

    await Promise.all([
      drive.files.copy({ fileId: igId, requestBody: { parents: [destId] }, supportsAllDrives: true }),
      drive.files.copy({ fileId: webId, requestBody: { parents: [destId] }, supportsAllDrives: true }),
    ]);

    // Also copy the room mockup if one exists in the source folder
    if (srcFolderId && baseName) {
      const roomName = `${baseName}_room.png`;
      const roomFiles = await drive.files.list({
        q: `'${srcFolderId}' in parents and name = '${roomName.replace(/'/g, "\\'")}' and trashed = false`,
        fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true,
      });
      if (roomFiles.data.files.length) {
        await drive.files.copy({ fileId: roomFiles.data.files[0].id, requestBody: { parents: [destId] }, supportsAllDrives: true });
      }
    }

    res.sendStatus(200);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Auto-generate Instagram metadata using Claude vision
app.post('/api/generate', requireAuth, async (req, res) => {
  try {
    const { folderId, baseName, webFileId, webMimeType, folderName } = req.body;
    if (!folderId || !baseName || !webFileId) return res.status(400).send('Missing fields');

    const drive = getDriveClient(req.user);

    const imgRes = await drive.files.get(
      { fileId: webFileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    );
    const imageData = Buffer.from(imgRes.data).toString('base64');
    const mediaType = (webMimeType || 'image/jpeg').includes('png') ? 'image/png' : 'image/jpeg';

    const dateMatch = folderName.match(/\d{1,2}[-\s]\w+[-\s]\d{4}/);
    const dropDate = dateMatch ? dateMatch[0] : 'an upcoming drop';

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageData } },
          { type: 'text', text: `You are an Instagram content creator for HueDistrict, a bold art poster brand from Bengaluru, India. HueDistrict creates "Posters with a pulse" — vivid, collector-grade art prints sold in limited drops. Brand voice: confident, artsy, slightly edgy. Never corporate or generic. Audience: young urban Indians who care about art, design, and culture.

Drop theme: "${folderName}"
Poster name: "${baseName}"
Drop date: ${dropDate}

Analyse the poster and generate:
1. Title: punchy, evocative, max 8 words, no hashtags
2. Caption: 2–3 sentences. Evoke the mood of the image, then a soft CTA referencing the drop date. Don't mention price.
3. Hashtags: 12–15. Mix niche art/print tags, Indian art community tags, and broad reach tags. Always include #huedistrict and #posterart.

Reply ONLY with valid JSON, no markdown:
{"title":"...","caption":"...","hashtags":["..."]}` },
        ],
      }],
    });

    const generated = JSON.parse(message.content[0].text.trim());
    const meta = { ...generated, generatedAt: new Date().toISOString(), modifiedAt: null };
    await saveMetaToDrive(drive, folderId, baseName, meta);

    res.json(meta);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Save edited metadata
app.post('/api/save-meta', requireAuth, async (req, res) => {
  try {
    const { folderId, baseName, title, caption, hashtags } = req.body;
    if (!folderId || !baseName) return res.status(400).send('Missing fields');

    const drive = getDriveClient(req.user);
    const meta = { title, caption, hashtags, modifiedAt: new Date().toISOString() };
    await saveMetaToDrive(drive, folderId, baseName, meta);

    res.sendStatus(200);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Delete _ig + _web copies from Posters for Sale
app.post('/api/unlist', requireAuth, async (req, res) => {
  try {
    const { folderName, igName, webName, baseName } = req.body;
    if (!folderName || !igName || !webName) return res.status(400).send('Missing fields');

    const drive = getDriveClient(req.user);
    const saleFolderId = await findFolder(drive, ROOT_FOLDER_ID, SALE_FOLDER_NAME);

    const subRes = await drive.files.list({
      q: `'${saleFolderId}' in parents and name = '${folderName.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    if (!subRes.data.files.length) return res.status(404).send('Sale subfolder not found');

    const saleSubId = subRes.data.files[0].id;
    const names = [igName, webName];
    if (baseName) names.push(`${baseName}_room.png`);
    const nameClause = names.map(n => `name = '${n.replace(/'/g, "\\'")}'`).join(' or ');
    const filesRes = await drive.files.list({
      q: `'${saleSubId}' in parents and (${nameClause}) and trashed = false`,
      fields: 'files(id)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    await Promise.all(filesRes.data.files.map(f =>
      drive.files.delete({ fileId: f.id, supportsAllDrives: true })
    ));

    res.sendStatus(200);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Generate a room-mockup preview (poster composited into a random frame)
app.post('/api/mockup', requireAuth, async (req, res) => {
  try {
    const { webFileId, excludeMockupId } = req.body;
    if (!webFileId) return res.status(400).send('Missing webFileId');

    const drive = getDriveClient(req.user);
    const mockup = await pickRandomMockup(drive, excludeMockupId);
    const [mockupBuf, posterBuf] = await Promise.all([
      fetchDriveBuffer(drive, mockup.id),
      fetchDriveBuffer(drive, webFileId),
    ]);

    // Fast pixel heuristic first; fall back to Claude vision for photographic mockups.
    let frame = await detectFrame(mockupBuf);
    if (!frame) {
      try { frame = await detectFrameWithClaude(mockupBuf); } catch (e) { /* fall through */ }
    }
    if (!frame) return res.status(422).send(`No empty frame detected in "${mockup.name}". Try another room.`);

    const out = await composeMockup(mockupBuf, posterBuf, frame);
    const previewId = storeMockup(out);
    res.json({ previewId, mockupId: mockup.id, mockupName: mockup.name });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get('/api/mockup-preview/:id', requireAuth, (req, res) => {
  const entry = mockupCache.get(req.params.id);
  if (!entry) return res.status(404).send('Preview expired');
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'private, max-age=600');
  res.send(entry.buffer);
});

// Save accepted mockup to Drive as {baseName}_room.png in the poster's folder
app.post('/api/mockup-accept', requireAuth, async (req, res) => {
  try {
    const { previewId, folderId, baseName } = req.body;
    if (!previewId || !folderId || !baseName) return res.status(400).send('Missing fields');
    const entry = mockupCache.get(previewId);
    if (!entry) return res.status(404).send('Preview expired — please regenerate');

    const drive = getDriveClient(req.user);
    const fileName = `${baseName}_room.png`;
    const existing = await drive.files.list({
      q: `'${folderId}' in parents and name = '${fileName.replace(/'/g, "\\'")}' and trashed = false`,
      fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    if (existing.data.files.length) {
      await drive.files.update({
        fileId: existing.data.files[0].id,
        media: { mimeType: 'image/png', body: Readable.from(entry.buffer) },
        supportsAllDrives: true,
      });
    } else {
      await drive.files.create({
        requestBody: { name: fileName, parents: [folderId], mimeType: 'image/png' },
        media: { mimeType: 'image/png', body: Readable.from(entry.buffer) },
        supportsAllDrives: true, fields: 'id',
      });
    }
    res.json({ ok: true, fileName });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Leonardo faithful mode: generate a bare-wall room, mount the poster on the
// wall as a 3D-looking print with a drop shadow (no frame-fitting needed).
app.post('/api/mockup-generate', requireAuth, async (req, res) => {
  try {
    if (!leonardoConfigured()) return res.status(503).send('Leonardo not configured — set LEONARDO_API_KEY');
    const { webFileId } = req.body;
    if (!webFileId) return res.status(400).send('Missing webFileId');
    const drive = getDriveClient(req.user);
    const posterBuf = await fetchDriveBuffer(drive, webFileId);
    const roomBuf = await leoGenerateBareRoom();
    const out = await composeOnWall(roomBuf, posterBuf);
    res.json({ previewId: storeMockup(out) });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Leonardo guidance mode: Leonardo paints the poster into a scene
app.post('/api/mockup-ai-scene', requireAuth, async (req, res) => {
  try {
    if (!leonardoConfigured()) return res.status(503).send('Leonardo not configured — set LEONARDO_API_KEY');
    const { webFileId } = req.body;
    if (!webFileId) return res.status(400).send('Missing webFileId');
    const drive = getDriveClient(req.user);
    const posterBuf = await fetchDriveBuffer(drive, webFileId);
    const out = await leoGenerateScene(posterBuf);
    res.json({ previewId: storeMockup(out) });
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Pricing configuration
app.get('/pricing', requireAuth, async (req, res) => {
  try {
    const drive = getDriveClient(req.user);
    const config = await readDriveJson(drive, ROOT_FOLDER_ID, '_hd_pricing.json') || {
      categories: ['Printing', 'Packaging', 'Shipping'],
      sizes: [
        { name: 'A1', costs: { Printing: 0, Packaging: 0, Shipping: 0 }, markup: 40 },
        { name: 'A2', costs: { Printing: 0, Packaging: 0, Shipping: 0 }, markup: 40 },
        { name: 'A3', costs: { Printing: 0, Packaging: 0, Shipping: 0 }, markup: 40 },
      ],
    };
    res.send(layout('Pricing', req.user, `
      <div class="page-hdr"><h1>Pricing Configuration</h1></div>
      ${renderPricingHTML(config)}
    `, buildPricingScript(config)));
  } catch (err) {
    res.status(500).send(`<pre>Error: ${esc(err.message)}</pre>`);
  }
});

app.post('/api/pricing/save', requireAuth, async (req, res) => {
  try {
    const config = req.body;
    if (!Array.isArray(config.categories) || !Array.isArray(config.sizes)) {
      return res.status(400).send('Invalid config');
    }
    const drive = getDriveClient(req.user);
    await writeDriveJson(drive, ROOT_FOLDER_ID, '_hd_pricing.json', {
      ...config,
      updatedAt: new Date().toISOString(),
    });
    res.sendStatus(200);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// ── Public endpoints (customer-facing, CORS) ─────────────

// Diagnostic — reports service-account health without leaking secrets
app.get('/api/sa-health', requireAuth, async (req, res) => {
  const parsed = parseServiceAccountKey();
  if (parsed.error) return res.json({ ok: false, reason: parsed.error, detail: parsed.detail || null });
  const out = { ok: true, clientEmail: parsed.credentials.client_email };
  try {
    const drive = getServiceDriveClient();
    await drive.files.get({ fileId: ROOT_FOLDER_ID, fields: 'id,name', supportsAllDrives: true });
    out.folderAccess = true;
  } catch (e) {
    out.folderAccess = false;
    out.folderError = e.message;
  }
  res.json(out);
});

app.options('/api/public-config', (req, res) => { setCors(res); res.sendStatus(200); });
app.get('/api/public-config', async (req, res) => {
  setCors(res);
  try {
    const drive = getServiceDriveClient();
    const config = drive ? (await readDriveJson(drive, ROOT_FOLDER_ID, '_hd_config.json') || {}) : {};
    const base = process.env.BASE_URL || '';
    res.json({
      upiId: config.upiId || process.env.UPI_ID || '',
      upiName: config.upiName || 'Hue District',
      qrUrl: config.qrFileId ? `${base}/api/public-img/${config.qrFileId}` : null,
    });
  } catch (e) {
    res.json({ upiId: process.env.UPI_ID || '', upiName: 'Hue District' });
  }
});

// Public drops feed for the customer site.
// A drop = subfolder of "Posters for Review". It's LIVE if its matching
// "Posters for Sale" subfolder has posters; otherwise it's UPCOMING (show date, no images).
app.options('/api/public-drops', (req, res) => { setCors(res); res.sendStatus(200); });
app.get('/api/public-drops', async (req, res) => {
  setCors(res);
  try {
    const drive = getServiceDriveClient();
    if (!drive) return res.status(503).json({ error: 'not configured' });

    const reviewId = await findFolder(drive, ROOT_FOLDER_ID, REVIEW_FOLDER_NAME);
    const reviewFolders = await listSubfolders(drive, reviewId);

    let saleId = null;
    try { saleId = await findFolder(drive, ROOT_FOLDER_ID, SALE_FOLDER_NAME); } catch {}
    const saleByName = {};
    if (saleId) (await listSubfolders(drive, saleId)).forEach(f => { saleByName[f.name] = f.id; });

    const pricing = await readDriveJson(drive, ROOT_FOLDER_ID, '_hd_pricing.json');
    const sizes = pricing && Array.isArray(pricing.sizes)
      ? pricing.sizes.map(s => ({ name: s.name, price: sizePrice(s, pricing.categories || []) }))
      : [];
    const base = process.env.BASE_URL || '';

    const drops = await Promise.all(reviewFolders.map(async (f) => {
      const date = parseDropDate(f.name);
      let posters = [];
      const saleFolderId = saleByName[f.name];
      if (saleFolderId) {
        const grouped = groupPosters(await listFiles(drive, saleFolderId)).filter(p => p.web);
        posters = grouped.map(p => ({
          name: p.name,
          images: [
            { type: 'web', url: `${base}/api/public-img/${p.web.id}` },
            ...(p.room ? [{ type: 'room', url: `${base}/api/public-img/${p.room.id}` }] : []),
          ],
        }));
      }
      return {
        theme: stripDropDate(f.name) || f.name,
        live: posters.length > 0,
        expected: date ? date.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }) : null,
        _time: date ? date.getTime() : Infinity,
        posters,
      };
    }));

    drops.sort((a, b) => a._time - b._time);
    drops.forEach(d => delete d._time);
    res.json({ drops, sizes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Public image proxy (serves product images from Drive via the service account)
app.options('/api/public-img/:fileId', (req, res) => { setCors(res); res.sendStatus(200); });
app.get('/api/public-img/:fileId', async (req, res) => {
  setCors(res);
  try {
    const drive = getServiceDriveClient();
    if (!drive) return res.status(503).send('not configured');
    const meta = await drive.files.get({ fileId: req.params.fileId, fields: 'mimeType', supportsAllDrives: true });
    const resp = await drive.files.get(
      { fileId: req.params.fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' }
    );
    res.set('Content-Type', meta.data.mimeType || 'image/png');
    res.set('Cache-Control', 'public, max-age=3600');
    resp.data.pipe(res);
  } catch (e) {
    res.status(404).send('not found');
  }
});

app.options('/api/orders', (req, res) => { setCors(res); res.sendStatus(200); });
app.post('/api/orders', async (req, res) => {
  setCors(res);
  try {
    const order = req.body;
    if (!order.id || !order.customer || !Array.isArray(order.items)) return res.status(400).send('Invalid order');
    const drive = getServiceDriveClient();
    if (!drive) return res.status(503).send('Order service not configured — set GOOGLE_SERVICE_ACCOUNT_KEY');
    const folderId = await getOrCreateSubfolder(drive, ROOT_FOLDER_ID, ORDERS_FOLDER_NAME);
    await writeDriveJson(drive, folderId, `${order.id}.json`, { ...order, status: 'pending', paidAt: null, dispatchedAt: null });
    res.json({ ok: true, orderId: order.id });
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// ── Orders management ─────────────────────────────────────

app.get('/orders', requireAuth, async (req, res) => {
  try {
    const drive = getDriveClient(req.user);
    const folderId = await getOrCreateSubfolder(drive, ROOT_FOLDER_ID, ORDERS_FOLDER_NAME);
    const files = (await listFiles(drive, folderId)).filter(f => f.name.endsWith('.json'));

    const orders = (await Promise.all(files.map(async f => {
      try { return await readMetaFromDrive(drive, f.id); } catch { return null; }
    }))).filter(Boolean).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const filter = req.query.status || 'all';
    const filtered = filter === 'all' ? orders : orders.filter(o => o.status === filter);

    const counts = { all: orders.length, pending: 0, paid: 0, dispatched: 0, cancelled: 0 };
    orders.forEach(o => { if (counts[o.status] !== undefined) counts[o.status]++; });

    const tabs = ['all', 'pending', 'paid', 'dispatched', 'cancelled'].map(s =>
      `<a href="/orders?status=${s}" class="nav-link${filter === s ? ' active' : ''}" style="font-size:13px">${s.charAt(0).toUpperCase()+s.slice(1)} (${counts[s]})</a>`
    ).join('');

    const rows = filtered.length ? filtered.map(o => {
      const date = new Date(o.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
      const items = o.items.map(i => `${i.name}${i.size ? ' · '+i.size : ''} ×${i.qty||1}`).join(', ');
      const actions = o.status === 'pending'
        ? `<button class="btn btn-green" style="font-size:12px;padding:5px 12px" onclick="updateStatus('${esc(o.id)}','paid')">Mark Paid</button>`
        : o.status === 'paid'
        ? `<button class="btn btn-green" style="font-size:12px;padding:5px 12px" onclick="updateStatus('${esc(o.id)}','dispatched')">Mark Dispatched</button>`
        : '';
      const cancel = o.status !== 'dispatched' && o.status !== 'cancelled'
        ? `<button class="btn btn-red" style="font-size:11px;padding:4px 10px;margin-left:6px" onclick="updateStatus('${esc(o.id)}','cancelled')">Cancel</button>` : '';
      return `<tr onclick="toggleDetail('${esc(o.id)}')" style="cursor:pointer">
        <td style="font-family:monospace;font-size:12px;white-space:nowrap">${esc(o.id)}</td>
        <td style="white-space:nowrap;font-size:13px">${date}</td>
        <td><div style="font-size:13px;font-weight:500">${esc(o.customer?.name||'')}</div><div style="font-size:12px;color:#6b7280">${esc(o.customer?.phone||'')}</div></td>
        <td style="font-size:13px;max-width:200px">${esc(items)}</td>
        <td style="font-weight:600;white-space:nowrap">₹${o.total||0}</td>
        <td>${statusBadge(o.status)}</td>
        <td onclick="event.stopPropagation()" style="white-space:nowrap">${actions}${cancel}</td>
      </tr>
      <tr id="detail-${esc(o.id)}" style="display:none;background:#f9fafb">
        <td colspan="7" style="padding:16px 20px">
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px;font-size:13px">
            <div><div style="font-size:11px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">Delivery Address</div>${esc(o.customer?.address||'')}${o.customer?.city ? ', '+esc(o.customer.city) : ''}${o.customer?.pincode ? ' — '+esc(o.customer.pincode) : ''}</div>
            ${o.payerUpi ? `<div><div style="font-size:11px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">Customer UPI ID</div><span style="font-family:monospace">${esc(o.payerUpi)}</span></div>` : ''}
            ${o.paidAt ? `<div><div style="font-size:11px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">Paid At</div>${new Date(o.paidAt).toLocaleString('en-IN')}</div>` : ''}
            ${o.dispatchedAt ? `<div><div style="font-size:11px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">Dispatched At</div>${new Date(o.dispatchedAt).toLocaleString('en-IN')}</div>` : ''}
          </div>
        </td>
      </tr>`;
    }).join('') : `<tr><td colspan="7" style="text-align:center;padding:48px;color:#9ca3af">No orders${filter !== 'all' ? ' with status "'+filter+'"' : ''}</td></tr>`;

    res.send(layout('Orders', req.user, `
      <div class="page-hdr"><h1>Orders</h1></div>
      <div style="display:flex;gap:16px;margin-bottom:20px;flex-wrap:wrap">${tabs}</div>
      <div class="section-card" style="padding:0;overflow:hidden">
        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead><tr style="background:#f9fafb;border-bottom:1px solid #e5e7eb">
              <th style="text-align:left;padding:10px 16px;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap">Order ID</th>
              <th style="text-align:left;padding:10px 16px;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Date</th>
              <th style="text-align:left;padding:10px 16px;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Customer</th>
              <th style="text-align:left;padding:10px 16px;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Items</th>
              <th style="text-align:left;padding:10px 16px;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Total</th>
              <th style="text-align:left;padding:10px 16px;font-size:11px;color:#6b7280;font-weight:600;text-transform:uppercase;letter-spacing:.05em">Status</th>
              <th style="padding:10px 16px"></th>
            </tr></thead>
            <tbody id="orders-body">${rows}</tbody>
          </table>
        </div>
      </div>
    `, `
      function toggleDetail(id) {
        var el = document.getElementById('detail-' + id);
        if (el) el.style.display = el.style.display === 'none' ? '' : 'none';
      }
      async function updateStatus(id, status) {
        if (!confirm('Mark order ' + id + ' as ' + status + '?')) return;
        var r = await fetch('/api/orders/' + id + '/status', {
          method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ status })
        });
        if (r.ok) { window.location.reload(); }
        else { showToast('Error: ' + await r.text()); }
      }
    `));
  } catch (e) {
    res.status(500).send(`<pre>Error: ${esc(e.message)}</pre>`);
  }
});

app.post('/api/orders/:id/status', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!['paid', 'dispatched', 'cancelled'].includes(status)) return res.status(400).send('Invalid status');

    const drive = getDriveClient(req.user);
    const folderId = await getOrCreateSubfolder(drive, ROOT_FOLDER_ID, ORDERS_FOLDER_NAME);
    const found = await drive.files.list({
      q: `'${folderId}' in parents and name = '${id}.json' and trashed = false`,
      fields: 'files(id)', supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    if (!found.data.files.length) return res.status(404).send('Order not found');

    const order = await readMetaFromDrive(drive, found.data.files[0].id);
    await writeDriveJson(drive, folderId, `${id}.json`, {
      ...order, status,
      paidAt: status === 'paid' ? new Date().toISOString() : order.paidAt,
      dispatchedAt: status === 'dispatched' ? new Date().toISOString() : order.dispatchedAt,
    });
    res.sendStatus(200);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// ── Settings ──────────────────────────────────────────────

app.get('/settings', requireAuth, async (req, res) => {
  try {
    const drive = getDriveClient(req.user);
    const config = await readDriveJson(drive, ROOT_FOLDER_ID, '_hd_config.json') || {};
    const qrSrc = config.qrFileId ? `/api/public-img/${config.qrFileId}` : '';
    res.send(layout('Settings', req.user, `
      <div class="page-hdr"><h1>Settings</h1></div>
      <div class="section-card" style="max-width:480px">
        <div class="section-title">UPI Payment Details</div>
        <p class="section-hint">These appear on the customer checkout page.</p>
        <div style="display:flex;flex-direction:column;gap:14px">
          <div>
            <div class="meta-label" style="margin-bottom:5px">UPI ID</div>
            <input class="meta-input" id="upi-id" value="${esc(config.upiId||'')}" placeholder="yourname@okicici" style="width:100%">
          </div>
          <div>
            <div class="meta-label" style="margin-bottom:5px">Display Name</div>
            <input class="meta-input" id="upi-name" value="${esc(config.upiName||'Hue District')}" placeholder="Hue District" style="width:100%">
          </div>
          <div>
            <button class="btn btn-green" style="width:auto;padding:9px 24px;border-radius:8px" onclick="saveSettings()">Save</button>
          </div>
        </div>
      </div>

      <div class="section-card" style="max-width:480px">
        <div class="section-title">Payment QR Code</div>
        <p class="section-hint">Upload your UPI QR (e.g. a merchant QR from Paytm for Business). When set, the checkout page shows this image instead of an auto-generated QR.</p>
        <div style="display:flex;flex-direction:column;gap:14px">
          <div id="qr-preview-wrap" style="display:${qrSrc ? 'block' : 'none'}">
            <img id="qr-preview" src="${qrSrc}" alt="Payment QR" style="width:200px;height:200px;object-fit:contain;border:1px solid #e5e7eb;border-radius:10px;background:#fff;padding:8px">
          </div>
          <div id="qr-empty" style="display:${qrSrc ? 'none' : 'block'};color:#9ca3af;font-size:13px">No QR uploaded yet.</div>
          <input type="file" id="qr-file" accept="image/png,image/jpeg" style="font-size:13px">
          <div style="display:flex;gap:8px">
            <button class="btn btn-green" style="width:auto;padding:9px 24px;border-radius:8px" onclick="uploadQr()">Upload QR</button>
            <button class="btn btn-red" id="qr-remove-btn" style="width:auto;padding:9px 18px;border-radius:8px;display:${qrSrc ? 'inline-block' : 'none'}" onclick="removeQr()">Remove</button>
          </div>
        </div>
      </div>
    `, `
      async function saveSettings() {
        const r = await fetch('/api/settings/save', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ upiId: document.getElementById('upi-id').value.trim(), upiName: document.getElementById('upi-name').value.trim() })
        });
        if (r.ok) { showToast('Settings saved ✓'); } else { showToast('Error: ' + await r.text()); }
      }
      async function uploadQr() {
        const f = document.getElementById('qr-file').files[0];
        if (!f) { showToast('Choose an image first'); return; }
        if (f.size > 7 * 1024 * 1024) { showToast('Image too large (max 7MB)'); return; }
        const dataUrl = await new Promise((res2) => { const fr = new FileReader(); fr.onload = () => res2(fr.result); fr.readAsDataURL(f); });
        const r = await fetch('/api/settings/qr', {
          method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ dataUrl })
        });
        if (r.ok) {
          const d = await r.json();
          const img = document.getElementById('qr-preview');
          img.src = '/api/public-img/' + d.qrFileId + '?t=' + Date.now();
          document.getElementById('qr-preview-wrap').style.display = 'block';
          document.getElementById('qr-empty').style.display = 'none';
          document.getElementById('qr-remove-btn').style.display = 'inline-block';
          showToast('QR uploaded ✓');
        } else { showToast('Error: ' + await r.text()); }
      }
      async function removeQr() {
        if (!confirm('Remove the uploaded QR? Checkout will fall back to the auto-generated QR.')) return;
        const r = await fetch('/api/settings/qr', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ remove: true }) });
        if (r.ok) {
          document.getElementById('qr-preview-wrap').style.display = 'none';
          document.getElementById('qr-empty').style.display = 'block';
          document.getElementById('qr-remove-btn').style.display = 'none';
          showToast('QR removed');
        } else { showToast('Error: ' + await r.text()); }
      }
    `));
  } catch (e) {
    res.status(500).send(`<pre>Error: ${esc(e.message)}</pre>`);
  }
});

app.post('/api/settings/save', requireAuth, async (req, res) => {
  try {
    const { upiId, upiName } = req.body;
    const drive = getDriveClient(req.user);
    const config = await readDriveJson(drive, ROOT_FOLDER_ID, '_hd_config.json') || {};
    await writeDriveJson(drive, ROOT_FOLDER_ID, '_hd_config.json', { ...config, upiId, upiName, updatedAt: new Date().toISOString() });
    res.sendStatus(200);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// Upload or remove the payment QR image
app.post('/api/settings/qr', requireAuth, async (req, res) => {
  try {
    const drive = getDriveClient(req.user);
    const config = await readDriveJson(drive, ROOT_FOLDER_ID, '_hd_config.json') || {};

    if (req.body.remove) {
      if (config.qrFileId) { try { await drive.files.delete({ fileId: config.qrFileId, supportsAllDrives: true }); } catch {} }
      delete config.qrFileId;
      await writeDriveJson(drive, ROOT_FOLDER_ID, '_hd_config.json', { ...config, updatedAt: new Date().toISOString() });
      return res.json({ ok: true });
    }

    const m = /^data:(image\/(png|jpeg));base64,(.+)$/i.exec(req.body.dataUrl || '');
    if (!m) return res.status(400).send('Invalid image (PNG or JPEG only)');
    const mime = m[1];
    const buffer = Buffer.from(m[3], 'base64');
    const ext = mime.includes('png') ? 'png' : 'jpg';

    if (config.qrFileId) { try { await drive.files.delete({ fileId: config.qrFileId, supportsAllDrives: true }); } catch {} }
    const created = await drive.files.create({
      requestBody: { name: `_hd_qr_${Date.now()}.${ext}`, parents: [ROOT_FOLDER_ID], mimeType: mime },
      media: { mimeType: mime, body: Readable.from(buffer) },
      supportsAllDrives: true, fields: 'id',
    });
    config.qrFileId = created.data.id;
    await writeDriveJson(drive, ROOT_FOLDER_ID, '_hd_config.json', { ...config, updatedAt: new Date().toISOString() });
    res.json({ ok: true, qrFileId: created.data.id });
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.listen(process.env.PORT || 3000);
