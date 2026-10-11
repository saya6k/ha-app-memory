// Ingress panel for the appliance manuals. Plain ES module, no build step.
// pdf.js renders pages to a canvas instead of relying on the browser's PDF
// viewer, which the Home Assistant Android app's WebView does not have.
import * as pdfjs from './pdfjs/pdf.min.mjs';
import { Lexer, Parser } from './vendor/marked.esm.js';
import DOMPurify from './vendor/purify.es.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs/pdf.worker.min.mjs', document.baseURI).href;

// Links in a manual leave the panel rather than replacing it inside the
// Home Assistant frame.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

const STRINGS = {
  en: {
    title: 'Manuals',
    rescan: 'Rescan manuals folder',
    more: 'More actions',
    reindex: 'Reindex everything',
    reset: 'Clear the index',
    search: 'Search manuals',
    searchPlaceholder: 'Search, e.g. how to clean the drum',
    results: 'Results',
    allManuals: 'All manuals',
    emptyTitle: 'No manuals yet',
    emptyBody:
      "Copy PDF or Markdown manuals into the share folder's manuals directory, then rescan.",
    back: 'Back to list',
    previous: 'Previous page',
    next: 'Next page',
    page: 'Page',
    openOriginal: 'Open the original file',
    pickManual: 'Pick a manual to read it here.',
    pages: (n) => `${n} pages`,
    pageN: (n) => `p. ${n}`,
    markdown: 'Markdown',
    notSearchable: 'No text — not searchable',
    indexing: (file) => `Indexing ${file} …`,
    indexingStart: 'Scanning the manuals folder …',
    reindexing: 'Rebuilding the index …',
    resetting: 'Clearing the index …',
    failed: (n) => `${n} file(s) could not be read`,
    duplicates: (n) => `${n} duplicate file(s) skipped`,
    noResults: 'No matching passages.',
    searching: 'Searching …',
    error: 'Something went wrong. Try again.',
    dirMissing: 'The /share/manuals folder does not exist yet.',
    loadFailed: 'Could not open this manual.',
    cancel: 'Cancel',
    confirmReindexTitle: 'Reindex every manual?',
    confirmReindexBody:
      'The index is cleared and every file is read and embedded again. Search finds less until it finishes, which can take a while with many manuals.',
    confirmReindex: 'Reindex',
    confirmResetTitle: 'Clear the manual index?',
    confirmResetBody:
      'Every manual is removed from search and from this list. Your files in /share/manuals are not touched, and the index is rebuilt on the next rescan or add-on start. Saved memories are not affected.',
    confirmReset: 'Clear',
  },
  ko: {
    title: '설명서',
    rescan: '설명서 폴더 다시 스캔',
    more: '추가 작업',
    reindex: '전체 재인덱싱',
    reset: '인덱스 초기화',
    search: '설명서 검색',
    searchPlaceholder: '검색 (예: 통세척 방법)',
    results: '검색 결과',
    allManuals: '전체 설명서',
    emptyTitle: '아직 설명서가 없습니다',
    emptyBody: '아래 폴더에 PDF나 Markdown 설명서를 복사한 뒤 다시 스캔하세요.',
    back: '목록으로',
    previous: '이전 페이지',
    next: '다음 페이지',
    page: '페이지',
    openOriginal: '원본 파일 열기',
    pickManual: '왼쪽에서 설명서를 고르세요.',
    pages: (n) => `${n}쪽`,
    pageN: (n) => `${n}쪽`,
    markdown: 'Markdown',
    notSearchable: '텍스트 없음 — 검색 불가',
    indexing: (file) => `인덱싱 중: ${file} …`,
    indexingStart: '설명서 폴더를 스캔하는 중 …',
    reindexing: '인덱스를 다시 만드는 중 …',
    resetting: '인덱스를 지우는 중 …',
    failed: (n) => `${n}개 파일을 읽지 못했습니다`,
    duplicates: (n) => `중복 파일 ${n}개를 건너뛰었습니다`,
    noResults: '일치하는 내용이 없습니다.',
    searching: '검색 중 …',
    error: '문제가 생겼습니다. 다시 시도하세요.',
    dirMissing: '/share/manuals 폴더가 아직 없습니다.',
    loadFailed: '이 설명서를 열 수 없습니다.',
    cancel: '취소',
    confirmReindexTitle: '모든 설명서를 다시 인덱싱할까요?',
    confirmReindexBody:
      '인덱스를 비우고 모든 파일을 다시 읽어 임베딩합니다. 끝날 때까지는 검색 결과가 줄어들고, 설명서가 많으면 시간이 걸립니다.',
    confirmReindex: '재인덱싱',
    confirmResetTitle: '설명서 인덱스를 초기화할까요?',
    confirmResetBody:
      '모든 설명서가 검색과 이 목록에서 빠집니다. /share/manuals의 파일은 그대로이고, 다음에 다시 스캔하거나 애드온이 시작될 때 인덱스가 다시 만들어집니다. 저장된 기억에는 영향이 없습니다.',
    confirmReset: '초기화',
  },
};

const lang = navigator.language?.toLowerCase().startsWith('ko') ? 'ko' : 'en';
const t = STRINGS[lang];

const $ = (id) => document.getElementById(id);
const layout = document.querySelector('.layout');
const canvas = $('canvas');
const article = $('markdown');

const state = {
  manuals: [],
  /** The open manual: { manual, doc, page } for a PDF, { manual } for Markdown. */
  open: undefined,
  renderTask: undefined,
  pollTimer: undefined,
};

function applyStrings() {
  document.documentElement.lang = lang;
  document.title = t.title;
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t[el.dataset.i18n];
  for (const el of document.querySelectorAll('[data-i18n-label]')) {
    el.setAttribute('aria-label', t[el.dataset.i18nLabel]);
    el.title = t[el.dataset.i18nLabel];
  }
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) {
    el.placeholder = t[el.dataset.i18nPlaceholder];
  }
}

function fileUrl(manual) {
  return `api/manuals/${encodeURIComponent(manual.id)}/file`;
}

async function getJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/** A list row: a button with a title line, a meta line and an optional snippet. */
function listItem({ title, meta, snippet, current, onClick }) {
  const li = document.createElement('li');
  const button = document.createElement('button');
  button.type = 'button';
  if (current) button.setAttribute('aria-current', 'true');

  const titleEl = document.createElement('span');
  titleEl.className = 'item-title';
  titleEl.textContent = title;
  button.append(titleEl, meta);

  if (snippet) {
    const snippetEl = document.createElement('span');
    snippetEl.className = 'snippet';
    snippetEl.textContent = snippet;
    button.append(snippetEl);
  }

  button.addEventListener('click', onClick);
  li.append(button);
  return li;
}

function metaLine(...parts) {
  const meta = document.createElement('span');
  meta.className = 'item-meta';
  parts.forEach((part, i) => {
    if (i > 0) meta.append(' · ');
    meta.append(part);
  });
  return meta;
}

function renderManualList() {
  const list = $('manual-list');
  list.replaceChildren(
    ...state.manuals.map((manual) => {
      const parts = [manual.format === 'pdf' ? t.pages(manual.pageCount) : t.markdown];
      if (manual.chunkCount === 0) {
        const warning = document.createElement('span');
        warning.className = 'warning';
        warning.textContent = t.notSearchable;
        parts.push(warning);
      }
      return listItem({
        title: manual.title,
        meta: metaLine(...parts),
        current: state.open?.manual.id === manual.id,
        onClick: () => openManual(manual, manual.format === 'pdf' ? 1 : 0).catch(showError),
      });
    }),
  );
  $('empty').hidden = state.manuals.length > 0;
}

function renderStatus(status) {
  for (const id of ['rescan', 'menu-button']) $(id).disabled = status.running;
  $('rescan').classList.toggle('spinning', status.running);

  const parts = [];
  if (status.operation === 'reset') {
    parts.push(t.resetting);
  } else if (status.running) {
    if (status.current) parts.push(t.indexing(status.current));
    else parts.push(status.operation === 'reindex' ? t.reindexing : t.indexingStart);
  } else if (status.lastSync && !status.lastSync.dirFound) {
    parts.push(t.dirMissing);
  } else if (status.lastSync) {
    if (status.lastSync.failed.length) parts.push(t.failed(status.lastSync.failed.length));
    if (status.lastSync.duplicates.length) {
      parts.push(t.duplicates(status.lastSync.duplicates.length));
    }
  }
  $('status').textContent = parts.join(' · ');
}

async function loadManuals() {
  const { manuals, status } = await getJson('api/manuals');
  state.manuals = manuals;
  renderManualList();
  renderStatus(status);

  // While indexing, poll so new manuals and progress show up on their own.
  clearTimeout(state.pollTimer);
  if (status.running) state.pollTimer = setTimeout(() => loadManuals().catch(showError), 2000);
}

function showError(error) {
  console.error(error);
  $('status').textContent = t.error;
}

/** POSTs an index operation (rescan, reindex, reset) and follows its progress. */
async function runOperation(name) {
  renderStatus(await getJson(`api/${name}`, { method: 'POST' }));
  await loadManuals();
}

/** Asks in an in-page dialog; resolves true when the user confirms. */
function confirmAction(kind) {
  const dialog = $('confirm');
  $('confirm-title').textContent = t[`confirm${kind}Title`];
  $('confirm-body').textContent = t[`confirm${kind}Body`];
  $('confirm-ok').textContent = t[`confirm${kind}`];
  $('confirm-ok').classList.toggle('danger', kind === 'Reset');
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
  });
}

async function search(query) {
  const section = $('results');
  const list = $('result-list');
  if (!query) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  list.replaceChildren();
  $('status').textContent = t.searching;

  const results = await getJson(`api/search?q=${encodeURIComponent(query)}&limit=10`);
  $('status').textContent = results.length ? '' : t.noResults;
  list.replaceChildren(
    ...results.map((hit) =>
      listItem({
        title: hit.title,
        meta: metaLine(hit.format === 'pdf' ? t.pageN(hit.page) : (hit.section ?? hit.title)),
        // Markdown passages are stored as source; drop heading markers for display.
        snippet: hit.format === 'pdf' ? hit.content : hit.content.replace(/^#{1,6}\s+/gm, ''),
        onClick: () => {
          const manual = state.manuals.find((m) => m.id === hit.manualId);
          if (manual) openManual(manual, hit.page).catch(showError);
        },
      }),
    ),
  );
}

/** Clears the viewer down to its "loading" placeholder. */
async function closeDocument() {
  state.renderTask?.cancel();
  await state.open?.doc?.destroy();
  state.open = undefined;
  $('pager').hidden = true;
  canvas.hidden = true;
  article.hidden = true;
  article.replaceChildren();
  $('placeholder').hidden = false;
  $('placeholder').textContent = '…';
}

/** Opens a manual at a PDF page, or at a Markdown section (0 = the top). */
async function openManual(manual, location) {
  layout.dataset.view = 'viewer';
  $('viewer-title').textContent = manual.title;
  $('open-original').href = fileUrl(manual);

  if (state.open?.manual.id !== manual.id) {
    await closeDocument();
    renderManualList();
    try {
      if (manual.format === 'pdf') await loadPdf(manual);
      else await loadMarkdown(manual);
    } catch (error) {
      console.error(error);
      $('placeholder').textContent = t.loadFailed;
      return;
    }
    renderManualList();
    $('placeholder').hidden = true;
  }

  if (manual.format === 'pdf') await showPage(location);
  else showSection(location);
}

async function loadPdf(manual) {
  const doc = await pdfjs.getDocument({
    url: fileUrl(manual),
    cMapUrl: new URL('pdfjs/cmaps/', document.baseURI).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('pdfjs/standard_fonts/', document.baseURI).href,
  }).promise;
  state.open = { manual, doc, page: 1 };
  $('page').max = String(doc.numPages);
  $('page-count').textContent = `/ ${doc.numPages}`;
  $('pager').hidden = false;
  canvas.hidden = false;
}

/**
 * Renders section by section, grouped exactly as the server's splitMarkdown
 * groups them (a new section at every top-level heading token), so the section
 * number of a search hit is the data-index to scroll to.
 */
async function loadMarkdown(manual) {
  const res = await fetch(fileUrl(manual));
  if (!res.ok) throw new Error(`${manual.path}: HTTP ${res.status}`);
  const tokens = new Lexer().lex(await res.text());

  const groups = [[]];
  for (const token of tokens) {
    if (token.type === 'heading') groups.push([]);
    groups[groups.length - 1].push(token);
  }

  article.replaceChildren(
    ...groups.map((group, index) => {
      // Reference-style links are resolved through the document's link map.
      group.links = tokens.links;
      const section = document.createElement('section');
      section.dataset.index = String(index);
      section.innerHTML = DOMPurify.sanitize(Parser.parse(group));
      return section;
    }),
  );
  state.open = { manual };
  article.hidden = false;
}

function showSection(index) {
  const target = article.querySelector(`section[data-index="${Number(index) || 0}"]`);
  const wrap = $('canvas-wrap');
  if (!target || index === 0) wrap.scrollTop = 0;
  else target.scrollIntoView({ block: 'start' });
}

async function showPage(number) {
  const open = state.open;
  if (!open?.doc) return;

  open.page = Math.min(Math.max(1, number), open.doc.numPages);
  $('page').value = String(open.page);
  $('prev').disabled = open.page <= 1;
  $('next').disabled = open.page >= open.doc.numPages;

  const page = await open.doc.getPage(open.page);
  const wrap = $('canvas-wrap');
  // Fit the page to the pane's width (less its padding), sharp on HiDPI screens.
  const available = wrap.clientWidth - 32;
  const unscaled = page.getViewport({ scale: 1 });
  const scale = Math.max(0.25, available / unscaled.width);
  const viewport = page.getViewport({ scale });
  const ratio = window.devicePixelRatio || 1;

  state.renderTask?.cancel();
  canvas.width = Math.floor(viewport.width * ratio);
  canvas.height = Math.floor(viewport.height * ratio);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;

  const task = page.render({
    canvas,
    viewport,
    transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
  });
  state.renderTask = task;
  try {
    await task.promise;
    wrap.scrollTop = 0;
  } catch (error) {
    // Cancelled by a newer render — expected while paging quickly.
    if (error?.name !== 'RenderingCancelledException') throw error;
  }
}

function closeViewer() {
  layout.dataset.view = 'list';
}

/** The ⋮ menu is a popover; place it under its button when it opens. */
function wireMenu() {
  const menu = $('menu');
  const button = $('menu-button');
  menu.addEventListener('toggle', (event) => {
    button.setAttribute('aria-expanded', String(event.newState === 'open'));
    if (event.newState !== 'open') return;
    const rect = button.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.left = `${Math.max(8, rect.right - menu.offsetWidth)}px`;
  });

  for (const [id, kind, name] of [
    ['menu-reindex', 'Reindex', 'reindex'],
    ['menu-reset', 'Reset', 'reset'],
  ]) {
    $(id).addEventListener('click', async () => {
      menu.hidePopover();
      if (!(await confirmAction(kind))) return;
      if (name === 'reset') await closeDocument().then(closeViewer);
      await runOperation(name).catch(showError);
    });
  }
}

function wire() {
  $('rescan').addEventListener('click', () => runOperation('rescan').catch(showError));
  wireMenu();

  $('search-form').addEventListener('submit', (event) => {
    event.preventDefault();
    search($('search').value.trim()).catch(showError);
  });
  $('search').addEventListener('search', () => {
    if (!$('search').value) search('').catch(showError);
  });

  $('back').addEventListener('click', closeViewer);
  $('prev').addEventListener('click', () => showPage(state.open.page - 1).catch(showError));
  $('next').addEventListener('click', () => showPage(state.open.page + 1).catch(showError));
  $('page').addEventListener('change', () =>
    showPage(Number($('page').value) || 1).catch(showError),
  );

  document.addEventListener('keydown', (event) => {
    if (!state.open?.doc || event.target instanceof HTMLInputElement) return;
    if (event.key === 'ArrowLeft') showPage(state.open.page - 1).catch(showError);
    if (event.key === 'ArrowRight') showPage(state.open.page + 1).catch(showError);
  });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.open?.doc) showPage(state.open.page).catch(showError);
    }, 200);
  });
}

applyStrings();
wire();
loadManuals().catch(showError);
