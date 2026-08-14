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

// ── Todo layer (content-planning items, separate from the inspiration library) ──
const ACCOUNTS = ['AI号', '搞笑号', '旅游探店号', '海外社媒'];

function todoRowToItem(row) {
  return {
    id: row.id,
    account: row.account || '',
    summary: row.summary || '',
    painPoint: row.pain_point || '',
    done: !!row.done,
    createdAt: row.created_at,
  };
}

function todoItemToRow(item) {
  return {
    id: item.id,
    account: item.account,
    summary: item.summary,
    pain_point: item.painPoint,
    done: item.done,
    created_at: item.createdAt,
  };
}

async function dbGetAllTodos() {
  const res = await sb('todos?select=*&order=created_at.desc');
  const rows = await res.json();
  return rows.map(todoRowToItem);
}

async function dbPutTodo(item) {
  await sb('todos', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(todoItemToRow(item)),
  });
}

async function dbDeleteTodo(id) {
  await sb(`todos?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
}

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

// xhs/douyin "分享" copies a text blob, not a bare URL — the real title is sitting
// right there in the text, so pull it out instead of relying on server-side scraping.
function extractShareText(raw) {
  const text = (raw || '').trim();
  const urlMatch = text.match(/https?:\/\/\S+/);
  if (!urlMatch) return { url: text, title: '' };

  const url = urlMatch[0].replace(/[，。！？,.!?]+$/, '').trim();
  let before = text.slice(0, urlMatch.index);

  before = before.replace(/^\d+(\.\d+)?\s+/, ''); // douyin's leading "1.56 " version code
  before = before.replace(/^.*?看看【[^】]*】\s*/, ''); // "...看看【某某的作品】"
  before = before.replace(/^(复制打开抖音[，,]?\s*)/, '');
  before = before.replace(/^(复制本条消息[，,]?\s*打开【[^】]*】[^！!]*[！!]?\s*)/, '');
  before = before.replace(/^(看看这?篇?分享[~！!]*\s*)/, '');
  before = before.replace(/(\s*@\S+)+\s*$/, ''); // trailing "@某人 @..." mentions

  return { url, title: before.trim() };
}

function applyPastedShareText(raw) {
  const { url, title } = extractShareText(raw);
  if (url) $('#urlInput').value = url;
  if (title && !$('#titleInput').value) {
    $('#titleInput').value = title;
    toast('已从分享文本中识别标题');
  } else {
    toast('已粘贴');
  }
}

// downscale an image (data URL or remote URL fetched as blob) to keep storage lean.
// Resolves to null (instead of hanging forever) if the canvas export fails —
// e.g. a cross-origin image without CORS headers taints the canvas.
async function compressImage(srcDataURL, maxW = 720, quality = 0.82) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxW / img.width);
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', quality));
      } catch (e) {
        resolve(null);
      }
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

let activeView = 'inspiration'; // 'inspiration' | 'todo'
let allTodos = [];
let editingTodoId = null;
let pendingAccount = null;
let activeAccountFilter = 'all';

// ── Rendering: category tabs ─────────────────────────────────────
// Same reasoning as renderCategoryPicker: build the tabs once, toggle classes
// in-place on click — never tear down and recreate them on tap.
function renderCategoryTabs() {
  const nav = $('#categoryTabs');
  nav.innerHTML = '';
  const values = ['all', ...categories];
  const tabs = values.map((val) => {
    const btn = document.createElement('button');
    btn.className = 'catChip' + (activeCategory === val ? ' active' : '');
    btn.textContent = val === 'all' ? '全部' : val;
    nav.appendChild(btn);
    return btn;
  });
  values.forEach((val, i) => {
    tabs[i].onclick = () => {
      activeCategory = val;
      tabs.forEach((t, j) => t.classList.toggle('active', values[j] === val));
      renderGrid();
    };
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
    $('#loadError').hidden = true;
    renderGrid();
  } catch (e) {
    // don't touch allItems/renderGrid here — a failed refresh must never make
    // existing items disappear or look like "there's nothing here"
    $('#emptyState').hidden = true;
    $('#loadError').hidden = false;
  }
}

// ── Add/Edit sheet ────────────────────────────────────────────────
// Categories are multi-select: a link can belong to several categories at once.
// Rebuilds the chip row from scratch (only needed when the category list itself
// changes). Clicking a chip must NEVER tear down and recreate the row — on real
// touchscreens that reliably breaks taps on whichever chip gets swapped out from
// under the finger mid-gesture. Toggling is handled in-place, see the onclick below.
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
      chip.classList.toggle('active', pendingCategories.includes(cat));
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
    renderCategoryPicker(); // list itself changed — a full rebuild here is fine
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
      const proxied = '/api/proxy-image?url=' + encodeURIComponent(data.image);
      const compressed = await compressImage(proxied);
      if (compressed) {
        setCoverPreview(compressed);
        $('#fetchStatus').textContent = '抓取成功 ✓';
      } else {
        $('#fetchStatus').textContent = data.title ? '抓到标题，封面下载失败，可手动上传截图' : '这个平台限制较多，自动抓取失败，请手动填写标题+上传封面截图';
      }
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

// ── View switching (参考灵感 / 灵感Todo) ─────────────────────────────
function switchView(view) {
  activeView = view;
  $('#inspirationView').hidden = view !== 'inspiration';
  $('#todoView').hidden = view !== 'todo';
  $('#navInspiration').classList.toggle('active', view === 'inspiration');
  $('#navTodo').classList.toggle('active', view === 'todo');
}

// ── Todo: rendering ───────────────────────────────────────────────
// Static list (no "add new account" flow), so the tabs never need rebuilding —
// same in-place-toggle approach as renderCategoryTabs, just simpler since the
// row is built exactly once.
function renderTodoAccountTabs() {
  const nav = $('#todoAccountTabs');
  nav.innerHTML = '';
  const values = ['all', ...ACCOUNTS];
  const tabs = values.map((val) => {
    const btn = document.createElement('button');
    btn.className = 'catChip' + (activeAccountFilter === val ? ' active' : '');
    btn.textContent = val === 'all' ? '全部' : val;
    nav.appendChild(btn);
    return btn;
  });
  values.forEach((val, i) => {
    tabs[i].onclick = () => {
      activeAccountFilter = val;
      tabs.forEach((t, j) => t.classList.toggle('active', values[j] === val));
      renderTodoList();
    };
  });
}

function renderTodoList() {
  const list = $('#todoList');
  list.innerHTML = '';

  let todos = allTodos.slice();
  if (activeAccountFilter !== 'all') todos = todos.filter((t) => t.account === activeAccountFilter);
  todos.sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    return b.createdAt - a.createdAt;
  });

  $('#todoEmptyState').hidden = todos.length > 0;

  todos.forEach((t) => {
    const card = document.createElement('div');
    card.className = 'todoCard' + (t.done ? ' done' : '');

    const check = document.createElement('div');
    check.className = 'todoCheck' + (t.done ? ' checked' : '');
    check.textContent = t.done ? '✓' : '';
    check.onclick = (e) => {
      e.stopPropagation();
      toggleTodoDone(t);
    };
    card.appendChild(check);

    const body = document.createElement('div');
    body.className = 'todoBody';

    const badge = document.createElement('span');
    badge.className = 'todoAccountBadge';
    badge.textContent = t.account || '未分配账号';
    body.appendChild(badge);

    const summary = document.createElement('div');
    summary.className = 'todoSummary';
    summary.textContent = t.summary || '(未填写内容概括)';
    body.appendChild(summary);

    if (t.painPoint) {
      const pain = document.createElement('div');
      pain.className = 'todoPain';
      pain.textContent = '痛点：' + t.painPoint;
      body.appendChild(pain);
    }

    card.appendChild(body);
    card.onclick = () => openEditTodoSheet(t);
    list.appendChild(card);
  });
}

async function refreshTodos() {
  try {
    allTodos = await dbGetAllTodos();
    $('#todoLoadError').hidden = true;
    renderTodoList();
  } catch (e) {
    // don't touch allTodos/renderTodoList here — a failed refresh must never make
    // existing todos disappear or look like "there's nothing here"
    $('#todoEmptyState').hidden = true;
    $('#todoLoadError').hidden = false;
  }
}

async function toggleTodoDone(t) {
  try {
    await dbPutTodo({ ...t, done: !t.done });
    await refreshTodos();
  } catch (e) {
    toast('更新失败，请检查网络');
  }
}

// ── Todo: add/edit sheet ─────────────────────────────────────────
// Same reasoning as renderCategoryPicker: build the row once, toggle classes
// in-place on click — never tear down and recreate chips on tap.
function renderAccountPicker() {
  const wrap = $('#accountPicker');
  wrap.innerHTML = '';
  const chips = ACCOUNTS.map((acc) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (pendingAccount === acc ? ' active' : '');
    chip.textContent = acc;
    wrap.appendChild(chip);
    return chip;
  });
  ACCOUNTS.forEach((acc, i) => {
    chips[i].onclick = () => {
      pendingAccount = pendingAccount === acc ? null : acc;
      chips.forEach((c, j) => c.classList.toggle('active', ACCOUNTS[j] === pendingAccount));
    };
  });
}

function resetTodoSheet() {
  editingTodoId = null;
  pendingAccount = null;
  $('#todoSummaryInput').value = '';
  $('#todoPainInput').value = '';
  $('#todoDoneInput').checked = false;
  renderAccountPicker();
  $('#todoDeleteBtn').hidden = true;
  $('#todoSheetTitle').textContent = '添加待办';
}

function openAddTodoSheet() {
  resetTodoSheet();
  $('#todoSheetOverlay').hidden = false;
}

function openEditTodoSheet(item) {
  resetTodoSheet();
  editingTodoId = item.id;
  $('#todoSheetTitle').textContent = '编辑待办';
  pendingAccount = item.account || null;
  renderAccountPicker();
  $('#todoSummaryInput').value = item.summary || '';
  $('#todoPainInput').value = item.painPoint || '';
  $('#todoDoneInput').checked = !!item.done;
  $('#todoDeleteBtn').hidden = false;
  $('#todoSheetOverlay').hidden = false;
}

function closeTodoSheet() {
  $('#todoSheetOverlay').hidden = true;
}

async function saveTodoSheet() {
  const summary = $('#todoSummaryInput').value.trim();
  const painPoint = $('#todoPainInput').value.trim();
  if (!pendingAccount && !summary) { toast('至少选个账号或填一句内容概括'); return; }

  const item = {
    id: editingTodoId || uid(),
    account: pendingAccount,
    summary,
    painPoint,
    done: $('#todoDoneInput').checked,
    createdAt: editingTodoId ? (allTodos.find((i) => i.id === editingTodoId)?.createdAt || Date.now()) : Date.now(),
  };
  try {
    await dbPutTodo(item);
    closeTodoSheet();
    await refreshTodos();
    toast('已保存');
  } catch (e) {
    toast('保存失败，请检查网络后重试');
  }
}

async function deleteTodoCurrent() {
  if (!editingTodoId) return;
  if (!confirm('删除这条待办？')) return;
  try {
    await dbDeleteTodo(editingTodoId);
    closeTodoSheet();
    await refreshTodos();
    toast('已删除');
  } catch (e) {
    toast('删除失败，请检查网络后重试');
  }
}

// ── Wire up events ────────────────────────────────────────────────
$('#navInspiration').onclick = () => switchView('inspiration');
$('#navTodo').onclick = () => switchView('todo');
$('#retryBtn').onclick = refresh;
$('#todoRetryBtn').onclick = refreshTodos;

$('#addBtn').onclick = () => {
  if (activeView === 'todo') openAddTodoSheet();
  else openAddSheet();
};
$('#todoSheetClose').onclick = closeTodoSheet;
$('#todoSheetOverlay').addEventListener('click', (e) => { if (e.target.id === 'todoSheetOverlay') closeTodoSheet(); });
$('#todoSaveBtn').onclick = saveTodoSheet;
$('#todoDeleteBtn').onclick = deleteTodoCurrent;

$('#sheetClose').onclick = closeSheet;
$('#sheetOverlay').addEventListener('click', (e) => { if (e.target.id === 'sheetOverlay') closeSheet(); });
$('#fetchBtn').onclick = fetchMetaForUrl;
$('#saveBtn').onclick = saveSheet;
$('#deleteBtn').onclick = deleteCurrent;
$('#coverRemoveBtn').onclick = () => setCoverPreview(null);

$('#pasteBtn').onclick = async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text) applyPastedShareText(text.trim());
  } catch (e) {
    toast('无法读取剪贴板，请手动粘贴');
  }
};

// also catch a manual Cmd/Ctrl+V paste directly into the link field
$('#urlInput').addEventListener('paste', (e) => {
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if (text && /\s/.test(text.trim())) {
    e.preventDefault();
    applyPastedShareText(text.trim());
  }
});

$('#coverFileInput').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const dataURL = await fileToDataURL(file);
  const compressed = await compressImage(dataURL);
  setCoverPreview(compressed || dataURL);
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
  renderTodoAccountTabs();
  await refresh();
  await refreshTodos();
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
