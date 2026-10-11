// The panel: one search over everything, the Documents view (shared manuals
// and the viewer's own documents, read in place) and the Memories view.
// Plain ES modules, no build step. pdf.js renders pages to a canvas instead of
// relying on the browser's PDF viewer, which the Home Assistant Android app's
// WebView does not have.
import { $, confirmAction, getJson, layout, listItem, metaLine, placeUnder } from './common.js';
import { applyStrings, t } from './i18n.js';
import { loadMemories, openMemoryById, setSignedIn, wireMemories } from './memories.js';
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

const canvas = $('canvas');
const article = $('markdown');

const state = {
  signedIn: false,
  /** Shared manuals and the viewer's own documents; `shared` tells them apart. */
  manuals: [],
  /** The open manual: { manual, doc, page } for a PDF, { manual } for Markdown. */
  open: undefined,
  renderTask: undefined,
  pollTimer: undefined,
  /** The last /api/manuals status, for the duplicates a delete would expose. */
  status: undefined,
  /** A result to keep showing across status polls, e.g. a failed upload. */
  notice: '',
  /** Where the next file picked in the upload dialog goes: 'mine' or 'shared'. */
  uploadTo: 'shared',
};

function fileUrl(manual) {
  return `api/manuals/${encodeURIComponent(manual.id)}/file`;
}

/** Switches the sidebar and main pane between Documents and Memories. */
function setTab(tab) {
  for (const button of document.querySelectorAll('[role="tab"]')) {
    button.setAttribute('aria-selected', String(button.dataset.tab === tab));
  }
  $('documents-panel').hidden = tab !== 'documents';
  $('memories-panel').hidden = tab !== 'memories';
  $('viewer').hidden = tab !== 'documents';
  $('memory-pane').hidden = tab !== 'memories';
}

function manualItem(manual) {
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
}

function renderManualLists() {
  const mine = state.manuals.filter((m) => !m.shared);
  const shared = state.manuals.filter((m) => m.shared);
  $('my-documents').hidden = !state.signedIn;
  $('my-document-list').replaceChildren(...mine.map(manualItem));
  $('my-document-empty').hidden = mine.length > 0;
  $('manual-list').replaceChildren(...shared.map(manualItem));
  $('empty').hidden = shared.length > 0;
}

function renderStatus(status) {
  for (const id of ['upload', 'rescan', 'menu-button']) $(id).disabled = status.running;
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
  if (state.notice) parts.unshift(state.notice);
  $('status').textContent = parts.join(' · ');
}

async function loadManuals() {
  const { manuals, status } = await getJson('api/manuals');
  state.manuals = manuals;
  state.status = status;
  renderManualLists();
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
  state.notice = '';
  renderStatus(await getJson(`api/${name}`, { method: 'POST' }));
  await loadManuals();
}

function postUpload(file, overwrite) {
  const query = new URLSearchParams({ name: file.name, to: state.uploadTo });
  if (overwrite) query.set('overwrite', '1');
  return fetch(`api/upload?${query}`, { method: 'POST', body: file });
}

/** Uploads one by one, asking before replacing a file of the same name. */
async function uploadFiles(files) {
  state.notice = '';
  const failed = [];
  for (const file of files) {
    $('status').textContent = t.uploading(file.name);
    let res = await postUpload(file, false);
    if (res.status === 409) {
      const replace = await confirmAction({
        title: t.confirmOverwriteTitle(file.name),
        body: t.confirmOverwriteBody,
        ok: t.confirmOverwrite,
      });
      if (!replace) continue;
      res = await postUpload(file, true);
    }
    if (!res.ok) {
      const reason =
        res.status === 413 ? t.tooLarge : res.status === 400 ? t.notAManual : res.status;
      failed.push(`${file.name} (${reason})`);
    }
  }
  if (failed.length) state.notice = t.uploadFailed(failed.join(', '));
  await loadManuals();
}

function pickFiles(to) {
  state.uploadTo = to;
  $('upload-input').click();
}

async function deleteOpenManual() {
  const manual = state.open?.manual;
  if (!manual) return;
  // Duplicates in the status are already limited to what this viewer may see.
  const copies = (state.status?.lastSync?.duplicates ?? []).filter(
    (d) => d.of === manual.path && d.shared === manual.shared,
  );
  const where = manual.shared ? t.sharedFolder(manual.path) : t.myFolder(manual.path);
  const confirmed = await confirmAction({
    title: t.confirmDeleteTitle(manual.title),
    body: t.confirmDeleteBody(where, copies.length),
    ok: t.confirmDelete,
    danger: true,
  });
  if (!confirmed) return;

  const res = await fetch(`api/manuals/${encodeURIComponent(manual.id)}`, { method: 'DELETE' });
  // 404: already gone, which is what was asked for.
  if (!res.ok && res.status !== 404) throw new Error(`delete ${manual.path}: HTTP ${res.status}`);
  state.notice = '';
  await closeDocument();
  $('placeholder').textContent = t.pickManual;
  closeViewer();
  await loadManuals();
}

function hitItem(hit) {
  if (hit.type === 'memory') {
    return listItem({
      title: hit.content,
      meta: metaLine(t.tabMemories, hit.personal ? t.mine : t.shared),
      onClick: () => {
        setTab('memories');
        openMemoryById(hit.id).catch(showError);
      },
    });
  }
  const where = hit.format === 'pdf' ? t.pageN(hit.page) : (hit.section ?? hit.title);
  return listItem({
    title: hit.title,
    meta: metaLine(hit.type === 'document' ? t.myDocuments : t.sharedManuals, where),
    // Markdown passages are stored as source; drop heading markers for display.
    snippet: hit.format === 'pdf' ? hit.content : hit.content.replace(/^#{1,6}\s+/gm, ''),
    onClick: () => {
      const manual = state.manuals.find((m) => m.id === hit.manualId);
      if (manual) openManual(manual, hit.page).catch(showError);
    },
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
  list.replaceChildren(...results.map(hitItem));
}

/** Clears the viewer down to its "loading" placeholder. */
async function closeDocument() {
  state.renderTask?.cancel();
  await state.open?.doc?.destroy();
  state.open = undefined;
  $('pager').hidden = true;
  $('viewer-actions').hidden = true;
  canvas.hidden = true;
  article.hidden = true;
  article.replaceChildren();
  $('placeholder').hidden = false;
  $('placeholder').textContent = '…';
}

/** Opens a manual at a PDF page, or at a Markdown section (0 = the top). */
async function openManual(manual, location) {
  setTab('documents');
  layout.dataset.view = 'viewer';
  $('viewer-title').textContent = manual.title;
  $('open-original').href = fileUrl(manual);

  if (state.open?.manual.id !== manual.id) {
    await closeDocument();
    renderManualLists();
    try {
      if (manual.format === 'pdf') await loadPdf(manual);
      else await loadMarkdown(manual);
    } catch (error) {
      console.error(error);
      $('placeholder').textContent = t.loadFailed;
      return;
    }
    renderManualLists();
    $('placeholder').hidden = true;
    $('viewer-actions').hidden = false;
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
    ...groups.flatMap((group, index) => {
      // Reference-style links are resolved through the document's link map.
      group.links = tokens.links;
      const html = DOMPurify.sanitize(Parser.parse(group));
      // An empty part before the first heading would only add a gap; the
      // numbering of the rest is unaffected.
      if (!html.trim()) return [];
      const section = document.createElement('section');
      section.dataset.index = String(index);
      section.innerHTML = html;
      return [section];
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

function wireMenus() {
  const menu = $('menu');
  placeUnder(menu, $('menu-button'));
  for (const [id, kind, name] of [
    ['menu-reindex', 'Reindex', 'reindex'],
    ['menu-reset', 'Reset', 'reset'],
  ]) {
    $(id).addEventListener('click', async () => {
      menu.hidePopover();
      const confirmed = await confirmAction({
        title: t[`confirm${kind}Title`],
        body: t[`confirm${kind}Body`],
        ok: t[`confirm${kind}`],
        danger: kind === 'Reset',
      });
      if (!confirmed) return;
      if (name === 'reset') await closeDocument().then(closeViewer);
      await runOperation(name).catch(showError);
    });
  }

  // Signed in, the upload button asks where to; otherwise it is a shared manual.
  const uploadMenu = $('upload-menu');
  placeUnder(uploadMenu, $('upload'));
  $('upload').addEventListener('click', () => {
    if (state.signedIn) uploadMenu.togglePopover();
    else pickFiles('shared');
  });
  for (const [id, to] of [
    ['upload-mine', 'mine'],
    ['upload-shared', 'shared'],
  ]) {
    $(id).addEventListener('click', () => {
      uploadMenu.hidePopover();
      pickFiles(to);
    });
  }
}

function wire() {
  for (const button of document.querySelectorAll('[role="tab"]')) {
    button.addEventListener('click', () => setTab(button.dataset.tab));
  }
  $('rescan').addEventListener('click', () => runOperation('rescan').catch(showError));
  $('upload-input').addEventListener('change', (event) => {
    const files = [...event.target.files];
    event.target.value = ''; // so choosing the same file again still fires
    if (files.length) uploadFiles(files).catch(showError);
  });
  $('delete').addEventListener('click', () => deleteOpenManual().catch(showError));
  wireMenus();
  wireMemories(showError);

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
    if (event.target instanceof HTMLTextAreaElement) return;
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

async function start() {
  const me = await getJson('api/me');
  state.signedIn = me.signedIn;
  setSignedIn(me.signedIn);
  await Promise.all([loadManuals(), loadMemories()]);
}

applyStrings();
setTab('documents');
wire();
start().catch(showError);
