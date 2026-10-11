// The Memories view: the viewer's own facts and the shared ones, with an
// editor to add, change and delete them. Other people's facts never reach here.
import { $, confirmAction, getJson, layout, listItem, metaLine } from './common.js';
import { t } from './i18n.js';

const state = {
  signedIn: false,
  mine: [],
  shared: [],
  /** The fact being edited, 'new' for an unsaved one, or undefined. */
  selected: undefined,
};

function shortDate(iso) {
  return new Date(iso).toLocaleDateString();
}

function renderList(listId, emptyId, facts) {
  $(listId).replaceChildren(
    ...facts.map((fact) =>
      listItem({
        title: fact.content,
        meta: metaLine(
          ...(fact.tags.length ? [fact.tags.join(', ')] : []),
          shortDate(fact.updatedAt),
        ),
        current: state.selected?.id === fact.id,
        onClick: () => openMemory(fact),
      }),
    ),
  );
  $(emptyId).hidden = facts.length > 0;
}

function render() {
  $('my-memories').hidden = !state.signedIn;
  $('signed-out-memories').hidden = state.signedIn;
  renderList('my-memory-list', 'my-memory-empty', state.mine);
  renderList('shared-memory-list', 'shared-memory-empty', state.shared);
}

export async function loadMemories() {
  const { mine, shared } = await getJson('api/facts');
  state.mine = mine;
  state.shared = shared;
  // Keep an open editor on the fresh copy of its fact.
  if (state.selected && state.selected !== 'new') {
    state.selected = [...mine, ...shared].find((f) => f.id === state.selected.id);
    if (!state.selected) closeEditor();
  }
  render();
}

export function setSignedIn(signedIn) {
  state.signedIn = signedIn;
  render();
}

/** Opens a fact by id, as a search hit does; loads the lists if needed. */
export async function openMemoryById(id) {
  let fact = [...state.mine, ...state.shared].find((f) => f.id === id);
  if (!fact) {
    await loadMemories();
    fact = [...state.mine, ...state.shared].find((f) => f.id === id);
  }
  if (fact) openMemory(fact);
}

function showEditor() {
  layout.dataset.view = 'viewer';
  $('memory-placeholder').hidden = true;
  $('memory-form').hidden = false;
  $('memory-status').textContent = '';
}

function openMemory(fact) {
  state.selected = fact;
  showEditor();
  $('memory-title').textContent = fact.shared ? t.shared : t.mine;
  $('memory-content').value = fact.content;
  $('memory-tags').value = fact.tags.join(', ');
  // Who it belongs to is fixed once saved.
  $('memory-scope').hidden = true;
  $('memory-delete').hidden = false;
  render();
  $('memory-content').focus();
}

export function newMemory() {
  state.selected = 'new';
  showEditor();
  $('memory-title').textContent = t.newMemory;
  $('memory-content').value = '';
  $('memory-tags').value = '';
  // Without a signed-in user there is nobody to keep it for: shared only.
  $('memory-scope').hidden = !state.signedIn;
  $('memory-scope-personal').checked = state.signedIn;
  $('memory-scope-shared').checked = !state.signedIn;
  $('memory-delete').hidden = true;
  render();
  $('memory-content').focus();
}

function closeEditor() {
  state.selected = undefined;
  $('memory-form').hidden = true;
  $('memory-placeholder').hidden = false;
}

function tagsFromInput() {
  return $('memory-tags')
    .value.split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

async function saveMemory(event) {
  event.preventDefault();
  const content = $('memory-content').value.trim();
  if (!content) return;
  const isNew = state.selected === 'new';
  const saved = await getJson(isNew ? 'api/facts' : `api/facts/${state.selected.id}`, {
    method: isNew ? 'POST' : 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content,
      tags: tagsFromInput(),
      ...(isNew ? { shared: $('memory-scope-shared').checked } : {}),
    }),
  });
  await loadMemories();
  openMemory([...state.mine, ...state.shared].find((f) => f.id === saved.id) ?? saved);
  $('memory-status').textContent = t.saved;
}

async function deleteMemory() {
  const fact = state.selected;
  if (!fact || fact === 'new') return;
  const confirmed = await confirmAction({
    title: t.confirmDeleteMemoryTitle,
    body: t.confirmDeleteMemoryBody,
    ok: t.confirmDelete,
    danger: true,
  });
  if (!confirmed) return;
  const res = await fetch(`api/facts/${encodeURIComponent(fact.id)}`, { method: 'DELETE' });
  // 404: already gone, which is what was asked for.
  if (!res.ok && res.status !== 404) throw new Error(`delete memory: HTTP ${res.status}`);
  closeEditor();
  layout.dataset.view = 'list';
  await loadMemories();
}

export function wireMemories(showError) {
  $('new-memory').addEventListener('click', newMemory);
  $('memory-form').addEventListener('submit', (event) => saveMemory(event).catch(showError));
  $('memory-delete').addEventListener('click', () => deleteMemory().catch(showError));
  $('memory-back').addEventListener('click', () => {
    layout.dataset.view = 'list';
  });
}
