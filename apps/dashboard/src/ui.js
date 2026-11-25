/**
 * Tiny DOM helpers for the dashboard.
 *
 * Two rules this file exists to enforce:
 *  1. No inline event handlers and no inline <script>, because the dashboard CSP
 *     is `script-src 'self'`.
 *  2. No `innerHTML` with data. Every string that reaches the page goes through
 *     textContent, so a proposal title containing markup is displayed, not
 *     executed. (Proposal content is tenant-supplied and therefore untrusted.)
 */

/** Create an element. `class`/`text`/`dataset`/`style` are handled specially. */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = String(v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, kids);
  return el;
}

/** Append children, flattening arrays and skipping nullish/false. */
export function append(parent, kids) {
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    parent.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return parent;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

// ------------------------------------------------------------------ layout

export function pageHead(title, subtitle, actions) {
  return h(
    'header',
    { class: 'page-head' },
    h('div', { class: 'page-head-main' }, h('h1', { text: title }), subtitle ? h('p', { class: 'muted', text: subtitle }) : null),
    actions ? h('div', { class: 'page-head-actions' }, actions) : null,
  );
}

export function card(title, ...kids) {
  return h(
    'section',
    { class: 'card' },
    title ? h('header', { class: 'card-head' }, h('h2', { text: title })) : null,
    h('div', { class: 'card-body' }, kids),
  );
}

/** A KPI tile. `hint` explains what is being counted. */
export function stat(label, value, hint) {
  return h(
    'div',
    { class: 'stat' },
    h('p', { class: 'stat-label', text: label }),
    h('p', { class: 'stat-value', text: value }),
    hint ? h('p', { class: 'stat-hint', text: hint }) : null,
  );
}

export function field(labelText, control, hint) {
  const id = control.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  control.id = id;
  return h(
    'div',
    { class: 'field' },
    h('label', { for: id, text: labelText }),
    control,
    hint ? h('p', { class: 'field-hint', text: hint }) : null,
  );
}

export const input = (props) => h('input', { type: 'text', ...props });
export const textarea = (props) => h('textarea', { rows: 4, ...props });

export function button(label, onClick, opts = {}) {
  const b = h('button', { type: opts.type || 'button', class: `btn ${opts.variant || 'primary'}` }, label);
  if (onClick) b.addEventListener('click', onClick);
  if (opts.disabled) b.disabled = true;
  return b;
}

export function badge(label, tone = 'neutral') {
  return h('span', { class: `badge badge-${tone}`, text: label });
}

/** Simple table. `rows` is an array of arrays of nodes/strings. */
export function table(headers, rows, opts = {}) {
  const thead = h(
    'thead',
    {},
    h('tr', {}, ...headers.map((t) => h('th', { text: t }))),
  );
  const tbody = h(
    'tbody',
    {},
    ...rows.map((row) =>
      h('tr', { class: opts.rowHref ? 'row-link' : null }, ...row.map((cell) => h('td', {}, cell))),
    ),
  );
  return h('div', { class: 'table-wrap' }, h('table', { class: 'data-table' }, thead, tbody));
}

export function emptyState(message) {
  return h('div', { class: 'empty' }, h('p', { text: message }));
}

export function spinner(label = 'Loading…') {
  return h('div', { class: 'loading', role: 'status' }, h('span', { class: 'dot' }), h('span', { text: label }));
}

export function kv(label, value) {
  return h(
    'div',
    { class: 'kv' },
    h('dt', { text: label }),
    h('dd', {}, value instanceof Node ? value : String(value ?? '—')),
  );
}

export function mono(value) {
  return h('code', { class: 'mono', text: String(value ?? '') });
}

// -------------------------------------------------------------- misc utils

/** Textarea (one item per line) → trimmed, non-empty array. */
export function lineList(value) {
  return String(value || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Array → textarea value (one item per line). */
export function lines(items) {
  return Array.isArray(items) ? items.join('\n') : '';
}

let toastHost = null;
export function toast(message, tone = 'info') {
  if (!toastHost) {
    toastHost = h('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  const node = h('div', { class: `toast toast-${tone}` }, message);
  toastHost.appendChild(node);
  setTimeout(() => {
    node.classList.add('toast-out');
    setTimeout(() => node.remove(), 250);
  }, 4200);
}

/**
 * Blocking dialog. Used for one-time secrets (a minted access token) where the
 * value must be read deliberately before it is dismissed.
 */
export function modal({ title, body, actions = [], dismissLabel = 'Close' }) {
  return new Promise((resolve) => {
    const overlay = h('div', { class: 'modal-overlay', role: 'dialog', 'aria-modal': 'true' });
    const close = (value) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(null);
    };
    const box = h(
      'div',
      { class: 'modal' },
      h('header', { class: 'modal-head' }, h('h2', { text: title })),
      h('div', { class: 'modal-body' }, body),
      h(
        'footer',
        { class: 'modal-foot' },
        ...actions.map((a) =>
          button(a.label, () => close(a.value), { variant: a.variant || 'ghost' }),
        ),
        button(dismissLabel, () => close(null), { variant: 'primary' }),
      ),
    );
    overlay.appendChild(box);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(null);
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
  });
}
