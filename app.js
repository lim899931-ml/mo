// ── DB layer (Supabase REST) ─────────────────────────────────────
const SUPABASE_URL = 'https://uhoakbiqdirvvifsgqdz.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Sm6w0H6D68plDIo_em2RSg_4xTyW-LQ';

async function sb(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase ${res.status}: ${text}`);
  }
  return res;
}

function rowToItem(row) {
  return {
    id: row.id,
    url: row.url || '',
    title: row.title || '',
    note: row.note || '',
    categories: row.categories || [],
    tags: row.tags || [],
    cover: row.cover || null,
    createdAt: row.created_at,
  };
}

function itemToRow(item) {
  return {
    id: item.id,
    url: item.url,
    title: item.title,
    note: item.note,
    categories: item.categories,
    tags: item.tags,
    cover: item.cover,
    created_at: item.createdAt,
  };
}

async function dbGetAll() {
  const res = await sb('items?select=*&order=created_at.desc');
  const rows = await res.json();
  return rows.map(rowToItem);
}

async function dbPut(item) {
  await sb('items', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(itemToRow(item)),
  });
}

async function dbDelete(id) {
  await sb(`items?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// one-time: pull anything left in the old per-device IndexedDB store into Supabase
async function migrateLocalItemsToCloud() {
  const FLAG = 'inspoLibrary_migratedToSupabase';
  if (localStorage.getItem(FLAG)) return;
  try {
    const localItems = await new Promise((resolve, reject) => {
      const req = indexedDB.open('inspoLibrary', 1);
      req.onupgradeneeded = () => resolve([]); // no existing store -> nothing to migrate
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('items')) { resolve([]); return; }
        const tx = db.transaction('items', 'readonly');
        const getAllReq = tx.objectStore('items').getAll();
        getAllReq.onsuccess = () => resolve(getAllReq.result || []);
        getAllReq.onerror = () => resolve([]);
      };
      req.onerror = () => resolve([]);
    });
    for (const it of localItems) {
      const categories = it.categories && it.categories.length ? it.categories : (it.category ? [it.category] : []);
      await dbPut({ ...it, categories }).catch(() => {});
    }
    if (localItems.length) toast(`已把本机 ${localItems.length} 条旧数据搬到云端`);
  } catch (e) {
    // no local IndexedDB data on this device/browser — nothing to do
  } finally {
    localStorage.setItem(FLAG, '1');
  }
}

// ── Categories (stored in Supabase so they sync across devices too) ─
const DEFAULT_CATEGORIES = ['旅游攻略', '市场营销', '搞笑账号灵感', '本地生活探店', '其他'];

async function loadCategories() {
  try {
    const res = await sb('categories?select=name&order=created_at.asc');
    const rows = await res.json();
    if (rows.length) return rows.map((r) => r.name);
    for (const name of DEFAULT_CATEGORIES) {
      await sb('categories', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ name, created_at: Date.now() }),
      }).catch(() => {});
    }
    return DEFAULT_CATEGORIES.slice();
  } catch (e) {
    return DEFAULT_CATEGORIES.slice();
  }
}

async function addCategoryRemote(name) {
  await sb('categories', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ name, created_at: Date.now() }),
  });
}

let categories = [];

// ── Platform detection ───────────────────────────────────────────
const PLATFORM_MAP = [
  { key: 'xhs', label: '小红书', test: /xiaohongshu\.com|xhslink\.com/i },
  { key: 'douyin', label: '抖音', test: /douyin\.com|iesdouyin\.com/i },
  { key: 'wechat', label: '微信', test: /weixin\.qq\.com|wx\.qq\.com/i },
  { key: 'x', label: 'X', test: /(^|\.)x\.com|twitter\.com/i },
  { key: 'instagram', label: 'Instagram', test: /instagram\.com/i },
];
function detectPlatform(url) {
  for (const p of PLATFORM_MAP) {
    if (p.test.test(url)) return p;
  }
  return { key: 'other', label: '其他' };
}

// items saved before multi-category support only have a single `category` string
function getItemCategories(it) {
  if (it.categories && it.categories.length) return it.categories;
  if (it.category) return [it.category];
  return [];
}

// ── Helpers ───────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2200);
}

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// downscale an image (data URL or remote URL fetched as blob) to keep storage lean
async function compressImage(srcDataURL, maxW = 720, quality = 0.82) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxW / img.width);
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(srcDataURL);
    img.src = srcDataURL;
  });
}

// ── App state ─────────────────────────────────────────────────────
let allItems = [];
let activeCategory = 'all';
let searchQuery = '';
let editingId = null; // when set, sheet is in edit mode
let pendingCoverDataURL = null; // cover chosen in the add/edit sheet
let pendingTags = [];
let pendingCategories = [];

// ── Rendering: category tabs ─────────────────────────────────────
function renderCategoryTabs() {
  const nav = $('#categoryTabs');
  nav.innerHTML = '';
  const all = document.createElement('button');
  all.className = 'catChip' + (activeCategory === 'all' ? ' active' : '');
  all.textContent = '全部';
  all.onclick = () => { activeCategory = 'all'; renderCategoryTabs(); renderGrid(); };
  nav.appendChild(all);

  categories.forEach((cat) => {
    const chip = document.createElement('button');
    chip.className = 'catChip' + (activeCategory === cat ? ' active' : '');
    chip.textContent = cat;
    chip.onclick = () => { activeCategory = cat; renderCategoryTabs(); renderGrid(); };
    nav.appendChild(chip);
  });
}

// ── Rendering: grid ───────────────────────────────────────────────
function renderGrid() {
  const grid = $('#grid');
  grid.innerHTML = '';

  let items = allItems.slice().sort((a, b) => b.createdAt - a.createdAt);
  if (activeCategory !== 'all') items = items.filter((it) => getItemCategories(it).includes(activeCategory));
  if (searchQuery.trim()) {
    const q = searchQuery.trim().toLowerCase();
    items = items.filter((it) => {
      return (it.title || '').toLowerCase().includes(q) ||
        (it.note || '').toLowerCase().includes(q) ||
        (it.tags || []).some((t) => t.toLowerCase().includes(q));
    });
  }

  $('#emptyState').hidden = items.length > 0;

  items.forEach((it) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.onclick = () => openDetail(it.id);

    const imgWrap = document.createElement('div');
    imgWrap.className = 'cardImgWrap';
    if (it.cover) {
      const img = document.createElement('img');
      img.src = it.cover;
      img.loading = 'lazy';
      imgWrap.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'cardNoImg';
      ph.textContent = '🔗';
      imgWrap.appendChild(ph);
    }
    const badge = document.createElement('span');
    badge.className = 'cardPlatformBadge';
    badge.textContent = detectPlatform(it.url || '').label;
    imgWrap.appendChild(badge);
    card.appendChild(imgWrap);

    const body = document.createElement('div');
    body.className = 'cardBody';
    const title = document.createElement('div');
    title.className = 'cardTitle';
    title.textContent = it.title || '(未命名)';
    body.appendChild(title);

    const cats = getItemCategories(it);
    if (cats.length) {
      const catsWrap = document.createElement('div');
      catsWrap.className = 'cardTags';
      cats.forEach((c) => {
        const catChip = document.createElement('span');
        catChip.className = 'miniCat';
        catChip.textContent = c;
        catsWrap.appendChild(catChip);
      });
      body.appendChild(catsWrap);
    }

    if (it.tags && it.tags.length) {
      const tagsWrap = document.createElement('div');
      tagsWrap.className = 'cardTags';
      it.tags.slice(0, 3).forEach((t) => {
        const tag = document.createElement('span');
        tag.className = 'miniTag';
        tag.textContent = '#' + t;
        tagsWrap.appendChild(tag);
      });
      body.appendChild(tagsWrap);
    }
    card.appendChild(body);
    grid.appendChild(card);
  });
}

async function refresh() {
  try {
    allItems = await dbGetAll();
    renderGrid();
  } catch (e) {
    toast('加载失败，请检查网络后下拉刷新页面');
  }
}

// ── Add/Edit sheet ────────────────────────────────────────────────
// Categories are multi-select: a link can belong to several categories at once.
function renderCategoryPicker() {
  const wrap = $('#categoryPicker');
  wrap.innerHTML = '';
  categories.forEach((cat) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (pendingCategories.includes(cat) ? ' active' : '');
    chip.textContent = cat;
    chip.dataset.cat = cat;
    chip.onclick = () => {
      const i = pendingCategories.indexOf(cat);
      if (i > -1) pendingCategories.splice(i, 1);
      else pendingCategories.push(cat);
      renderCategoryPicker();
    };
    wrap.appendChild(chip);
  });
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'chip addCat';
  addBtn.textContent = '＋ 新分类';
  addBtn.onclick = async () => {
    const name = prompt('新分类名称');
    const trimmed = name && name.trim();
    if (!trimmed || categories.includes(trimmed)) return;
    categories.push(trimmed);
    pendingCategories.push(trimmed);
    renderCategoryPicker();
    renderCategoryTabs();
    try {
      await addCategoryRemote(trimmed);
    } catch (e) {
      toast('新分类同步到云端失败，请检查网络');
    }
  };
  wrap.appendChild(addBtn);
}

function renderTagList() {
  const wrap = $('#tagList');
  wrap.innerHTML = '';
  pendingTags.forEach((tag, i) => {
    const chip = document.createElement('span');
    chip.className = 'chip tagChip';
    chip.innerHTML = `#${tag} <span class="x">✕</span>`;
    chip.querySelector('.x').onclick = () => {
      pendingTags.splice(i, 1);
      renderTagList();
    };
    wrap.appendChild(chip);
  });
}

function setCoverPreview(dataURL) {
  pendingCoverDataURL = dataURL;
  const wrap = $('#coverPreviewWrap');
  if (dataURL) {
    $('#coverPreview').src = dataURL;
    wrap.hidden = false;
  } else {
    wrap.hidden = true;
  }
}

function resetSheet() {
  editingId = null;
  pendingTags = [];
  pendingCategories = [];
  pendingCoverDataURL = null;
  $('#urlInput').value = '';
  $('#titleInput').value = '';
  $('#noteInput').value = '';
  $('#tagInput').value = '';
  $('#fetchStatus').textContent = '';
  $('#coverFileInput').value = '';
  setCoverPreview(null);
  renderTagList();
  renderCategoryPicker();
  $('#deleteBtn').hidden = true;
  $('#sheetTitle').textContent = '添加灵感';
}

function openAddSheet() {
  resetSheet();
  $('#sheetOverlay').hidden = false;
}

function openEditSheet(item) {
  resetSheet();
  editingId = item.id;
  $('#sheetTitle').textContent = '编辑灵感';
  $('#urlInput').value = item.url || '';
  $('#titleInput').value = item.title || '';
  $('#noteInput').value = item.note || '';
  pendingTags = (item.tags || []).slice();
  renderTagList();
  pendingCategories = getItemCategories(item).slice();
  renderCategoryPicker();
  setCoverPreview(item.cover || null);
  $('#deleteBtn').hidden = false;
  $('#sheetOverlay').hidden = false;
}

function closeSheet() {
  $('#sheetOverlay').hidden = true;
}

async function fetchMetaForUrl() {
  const url = $('#urlInput').value.trim();
  if (!url) { toast('先粘贴一个链接'); return; }
  $('#fetchStatus').textContent = '抓取中...';
  $('#fetchBtn').disabled = true;
  try {
    const res = await fetch('/api/fetch-meta?url=' + encodeURIComponent(url));
    const data = await res.json();
    if (data.title && !$('#titleInput').value) {
      $('#titleInput').value = data.title;
    }
    if (data.image) {
      const compressed = await compressImage(data.image);
      setCoverPreview(compressed);
      $('#fetchStatus').textContent = '抓取成功 ✓';
    } else if (data.title) {
      $('#fetchStatus').textContent = '抓到标题，封面未抓到，可手动上传截图';
    } else {
      $('#fetchStatus').textContent = '这个平台限制较多，自动抓取失败，请手动填写标题+上传封面截图';
    }
  } catch (e) {
    $('#fetchStatus').textContent = '抓取失败，请手动填写标题+上传封面截图';
  } finally {
    $('#fetchBtn').disabled = false;
  }
}

async function saveSheet() {
  const url = $('#urlInput').value.trim();
  const title = $('#titleInput').value.trim();
  if (!url && !title) { toast('至少填一个链接或标题'); return; }

  const item = {
    id: editingId || uid(),
    url,
    title,
    note: $('#noteInput').value.trim(),
    categories: pendingCategories.slice(),
    tags: pendingTags.slice(),
    cover: pendingCoverDataURL,
    createdAt: editingId ? (allItems.find((i) => i.id === editingId)?.createdAt || Date.now()) : Date.now(),
  };
  try {
    await dbPut(item);
    closeSheet();
    await refresh();
    toast('已保存');
  } catch (e) {
    toast('保存失败，请检查网络后重试');
  }
}

async function deleteCurrent() {
  if (!editingId) return;
  if (!confirm('删除这条灵感？')) return;
  try {
    await dbDelete(editingId);
    closeSheet();
    closeDetail();
    await refresh();
    toast('已删除');
  } catch (e) {
    toast('删除失败，请检查网络后重试');
  }
}

// ── Detail viewer ────────────────────────────────────────────────
let detailId = null;
function openDetail(id) {
  const item = allItems.find((i) => i.id === id);
  if (!item) return;
  detailId = id;
  const platform = detectPlatform(item.url || '');

  $('#detailCover').style.display = item.cover ? 'block' : 'none';
  if (item.cover) $('#detailCover').src = item.cover;
  $('#detailTitle').textContent = item.title || '(未命名)';

  const meta = $('#detailMeta');
  meta.innerHTML = '';
  getItemCategories(item).forEach((c) => {
    const catChip = document.createElement('span');
    catChip.className = 'chip active';
    catChip.textContent = c;
    meta.appendChild(catChip);
  });
  const platChip = document.createElement('span');
  platChip.className = 'chip';
  platChip.textContent = platform.label;
  meta.appendChild(platChip);
  (item.tags || []).forEach((t) => {
    const tagChip = document.createElement('span');
    tagChip.className = 'chip tagChip';
    tagChip.textContent = '#' + t;
    meta.appendChild(tagChip);
  });

  $('#detailNote').textContent = item.note || '';
  $('#detailNote').hidden = !item.note;

  const openLink = $('#detailOpenLink');
  if (item.url) {
    openLink.href = item.url;
    openLink.hidden = false;
  } else {
    openLink.hidden = true;
  }

  $('#detailOverlay').hidden = false;
}
function closeDetail() {
  $('#detailOverlay').hidden = true;
  detailId = null;
}

// ── Wire up events ────────────────────────────────────────────────
$('#addBtn').onclick = openAddSheet;
$('#sheetClose').onclick = closeSheet;
$('#sheetOverlay').addEventListener('click', (e) => { if (e.target.id === 'sheetOverlay') closeSheet(); });
$('#fetchBtn').onclick = fetchMetaForUrl;
$('#saveBtn').onclick = saveSheet;
$('#deleteBtn').onclick = deleteCurrent;
$('#coverRemoveBtn').onclick = () => setCoverPreview(null);

$('#pasteBtn').onclick = async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) { $('#urlInput').value = text.trim(); toast('已粘贴'); }
  } catch (e) {
    toast('无法读取剪贴板，请手动粘贴');
  }
};

$('#coverFileInput').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const dataURL = await fileToDataURL(file);
  const compressed = await compressImage(dataURL);
  setCoverPreview(compressed);
};

$('#tagInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const val = $('#tagInput').value.trim().replace(/^#/, '');
    if (val && !pendingTags.includes(val)) {
      pendingTags.push(val);
      renderTagList();
    }
    $('#tagInput').value = '';
  }
});

$('#searchInput').addEventListener('input', (e) => {
  searchQuery = e.target.value;
  renderGrid();
});

$('#detailClose').onclick = closeDetail;
$('#detailOverlay').addEventListener('click', (e) => { if (e.target.id === 'detailOverlay') closeDetail(); });
$('#detailEditBtn').onclick = () => {
  const item = allItems.find((i) => i.id === detailId);
  closeDetail();
  if (item) openEditSheet(item);
};

// ── Init ──────────────────────────────────────────────────────────
(async function init() {
  await migrateLocalItemsToCloud();
  categories = await loadCategories();
  renderCategoryTabs();
  await refresh();
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
