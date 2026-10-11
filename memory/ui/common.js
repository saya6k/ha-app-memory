// Small helpers shared by the panel's modules.

export const $ = (id) => document.getElementById(id);

export const layout = document.querySelector('.layout');

export async function getJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/** A list row: a button with a title line, a meta line and an optional snippet. */
export function listItem({ title, meta, snippet, current, onClick }) {
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

export function metaLine(...parts) {
  const meta = document.createElement('span');
  meta.className = 'item-meta';
  parts.forEach((part, i) => {
    if (i > 0) meta.append(' · ');
    meta.append(part);
  });
  return meta;
}

/** Asks in an in-page dialog; resolves true when the user confirms. */
export function confirmAction({ title, body, ok, danger = false }) {
  const dialog = $('confirm');
  $('confirm-title').textContent = title;
  $('confirm-body').textContent = body;
  $('confirm-ok').textContent = ok;
  $('confirm-ok').classList.toggle('danger', danger);
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
  });
}

/** Places an open popover menu under the button that opened it. */
export function placeUnder(menu, button) {
  menu.addEventListener('toggle', (event) => {
    button.setAttribute('aria-expanded', String(event.newState === 'open'));
    if (event.newState !== 'open') return;
    const rect = button.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.left = `${Math.max(8, rect.right - menu.offsetWidth)}px`;
  });
}
