/**
 * BuildClose dashboard — app.buildclose.app
 *
 * Staff-only surface for managing proposals, the AI assistant's approved
 * knowledge, and the prospect access tokens that gate the chat.
 *
 * ARCHITECTURAL NOTES
 *
 * 1. No Firebase SDK. The CSP is `script-src 'self'`, so every network call goes
 *    through src/api.js, which speaks the two REST protocols directly. This keeps
 *    a third-party script origin off the origin that holds staff sessions.
 *
 * 2. Role gating here is COSMETIC. Every callable independently re-reads the
 *    caller's custom claims server-side. Hiding a button is a courtesy; the
 *    server is the boundary. Nothing in this file is a security control.
 *
 * 3. Observed and inferred data are rendered in visibly different containers.
 *    The server separates them into `observed` / `inferred` fields precisely so
 *    they cannot be conflated, and this file never merges them into one number.
 *
 * 4. All tenant-supplied text is written with textContent (see src/ui.js), never
 *    innerHTML, because proposal titles and chat messages are untrusted input.
 */
import { auth, call, money, pct, when, ApiError } from './src/api.js';
import {
  h,
  clear,
  pageHead,
  card,
  stat,
  field,
  input,
  textarea,
  button,
  badge,
  table,
  emptyState,
  spinner,
  kv,
  mono,
  lineList,
  lines,
  toast,
  modal,
} from './src/ui.js';
import { viewIntelligence } from './src/intelligence.js';

const appEl = document.getElementById('app');

/** Session state for this tab: { uid, email, companyId, role }. */
let me = null;

// ------------------------------------------------------------------ helpers

/**
 * Normalise a Firestore timestamp that has crossed the JSON boundary.
 * The Admin SDK serialises Timestamp as {_seconds,_nanoseconds}; some callables
 * return plain millis. Accept every shape and return millis or null.
 */
function ts(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (typeof value === 'object') {
    if (typeof value.toMillis === 'function') return value.toMillis();
    const seconds = value.seconds ?? value._seconds;
    if (typeof seconds === 'number') {
      const nanos = value.nanoseconds ?? value._nanoseconds ?? 0;
      return seconds * 1000 + Math.round(nanos / 1e6);
    }
  }
  return null;
}

const when2 = (v) => when(ts(v));

const role = () => me?.role ?? null;
const RANK = { sales_rep: 1, sales_manager: 2, company_admin: 3, platform_admin: 4 };
const atLeast = (r) => (RANK[role()] ?? 0) >= (RANK[r] ?? 99);

/** Roles the server accepts for internal/agent edits (CONFIG_ROLES). */
const canConfigure = () => atLeast('sales_manager');
/** Roles the server accepts for the audit log. */
const canAudit = () => atLeast('sales_manager');
/** Roles the server accepts for team management. */
const canManageTeam = () => atLeast('company_admin');

const STATUS_TONE = {
  draft: 'neutral',
  published: 'accent',
  archived: 'neutral',
};

const ACCEPT_TONE = {
  none: 'neutral',
  accepted: 'ok',
  declined: 'danger',
  superseded: 'warn',
  pending: 'warn',
};

function statusBadge(status) {
  return badge(status || 'draft', STATUS_TONE[status] ?? 'neutral');
}

function acceptanceBadge(status) {
  const s = status || 'none';
  const label = s === 'none' ? 'not accepted' : s;
  return badge(label, ACCEPT_TONE[s] ?? 'neutral');
}

/** Reusable error handler for every async click handler. */
function fail(err) {
  if (err instanceof ApiError && err.code === 'unauthenticated') {
    me = null;
    return renderSignIn('Your session expired. Please sign in again.');
  }
  const msg = err instanceof ApiError ? err.message : 'Something went wrong.';
  toast(msg, 'error');
  return undefined;
}

// --------------------------------------------------------------- sign in

function renderSignIn(errorMessage) {
  clear(appEl);
  appEl.className = '';

  const emailInput = input({ type: 'email', autocomplete: 'username', placeholder: 'you@company.com' });
  const passwordInput = input({ type: 'password', autocomplete: 'current-password', placeholder: '••••••••' });
  const errorSlot = h('div');
  const submit = button('Sign in', null, { type: 'submit' });

  const form = h(
    'form',
    { novalidate: true },
    field('Email', emailInput),
    field('Password', passwordInput),
    errorSlot,
    submit,
  );

  if (errorMessage) errorSlot.appendChild(h('p', { class: 'form-error', text: errorMessage }));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clear(errorSlot);
    submit.disabled = true;
    submit.textContent = 'Signing in…';
    try {
      await auth.signIn(emailInput.value.trim(), passwordInput.value);
      me = await auth.claims();
      if (!me.companyId) {
        // Authenticated but unattached to a tenant: every callable will refuse.
        // Say so plainly rather than showing an empty dashboard.
        await auth.signOut();
        me = null;
        throw new ApiError(
          'no-tenant',
          'This account is not attached to a company yet. Ask your administrator to invite you.',
          403,
        );
      }
      renderShell();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Sign-in failed.';
      errorSlot.appendChild(h('p', { class: 'form-error', text: msg }));
      submit.disabled = false;
      submit.textContent = 'Sign in';
    }
  });

  appEl.appendChild(
    h(
      'div',
      { class: 'signin-wrap' },
      h(
        'div',
        { class: 'signin' },
        h(
          'div',
          { class: 'brand' },
          h('span', { class: 'brand-mark', text: 'B' }),
          h('span', { class: 'brand-name', text: 'BuildClose' }),
        ),
        h('h1', { text: 'Sign in' }),
        h('p', { class: 'sub', text: 'Staff access to proposals and analytics.' }),
        form,
      ),
    ),
  );
  emailInput.focus();
}

// ------------------------------------------------------------------- shell

const NAV = [
  { href: '#/overview', label: 'Overview', icon: '◧', show: () => true },
  { href: '#/proposals', label: 'Proposals', icon: '▤', show: () => true },
  /**
   * Intelligence Center is visible to every staff role, because every role needs
   * to READ the house voice and approved answers. The commercial-authority tab
   * inside it is hidden for reps, and the server refuses them that data outright.
   */
  { href: '#/intelligence', label: 'Intelligence', icon: '◆', show: () => true },
  { href: '#/team', label: 'Team', icon: '◍', show: canManageTeam },
  { href: '#/audit', label: 'Audit log', icon: '≡', show: canAudit },
];

function renderShell() {
  clear(appEl);
  appEl.className = 'app-shell';

  const view = h('main', { class: 'main', id: 'view', tabindex: '-1' });

  const nav = h(
    'nav',
    { class: 'nav' },
    ...NAV.filter((item) => item.show()).map((item) =>
      h(
        'a',
        { href: item.href, dataset: { nav: item.href.slice(2) } },
        h('span', { class: 'icon', text: item.icon, 'aria-hidden': 'true' }),
        h('span', { text: item.label }),
      ),
    ),
  );

  const sidebar = h(
    'aside',
    { class: 'sidebar' },
    h(
      'div',
      { class: 'sidebar-brand' },
      h('span', { class: 'mark', text: 'B' }),
      h(
        'span',
        {},
        h('span', { class: 'name', text: 'BuildClose' }),
        h('span', { class: 'tag', text: 'Build the proposal. Close the deal.' }),
      ),
    ),
    nav,
    h('div', { class: 'nav-sep' }),
    h(
      'div',
      { class: 'sidebar-foot' },
      h(
        'div',
        { class: 'who' },
        h('p', { class: 'email', text: me.email ?? '', title: me.email ?? '' }),
        h('p', { class: 'role', text: (me.role ?? '').replace(/_/g, ' ') }),
      ),
      h('button', {
        class: 'linkish',
        type: 'button',
        text: 'Sign out',
        onclick: async () => {
          await auth.signOut();
          me = null;
          renderSignIn();
        },
      }),
    ),
  );

  appEl.appendChild(sidebar);
  appEl.appendChild(view);

  router();
  window.addEventListener('hashchange', router);
}

function setActiveNav() {
  const current = (location.hash || '#/overview').slice(2).split('/')[0];
  for (const link of document.querySelectorAll('.nav a')) {
    link.classList.toggle('active', link.dataset.nav === current);
  }
}

/** Central router. Every view is an async renderer that owns its own loading UI. */
async function router() {
  if (!me) return;
  const view = document.getElementById('view');
  if (!view) return;

  setActiveNav();
  const hash = location.hash || '#/overview';
  const [, route, param] = hash.match(/^#\/([^/]+)(?:\/(.+))?$/) ?? [];

  try {
    if (route === 'proposals' && param === 'new') await createProposalView(view);
    else if (route === 'proposals' && param) await viewProposal(view, decodeURIComponent(param));
    else if (route === 'proposals') await viewProposals(view);
    else if (route === 'intelligence') await viewIntelligence(view, { role: role() });
    else if (route === 'team') await viewTeam(view);
    else if (route === 'audit') await viewAudit(view);
    else await viewOverview(view);
  } catch (err) {
    clear(view);
    view.appendChild(
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'card-body' },
          h('h2', { text: 'This page could not be loaded' }),
          h('p', {
            class: 'muted',
            text: err instanceof ApiError ? err.message : 'An unexpected error occurred.',
          }),
          h('div', { class: 'row', style: { marginTop: '12px' } }, button('Retry', () => router())),
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------- overview

async function viewOverview(view) {
  clear(view);
  view.appendChild(pageHead('Overview', 'What prospects observed, and what the assistant inferred.'));

  const body = h('div');
  view.appendChild(body);
  body.appendChild(spinner('Loading analytics…'));

  const data = await call('getCompanyDashboard');
  clear(body);

  const obs = data.observed ?? {};
  const inf = data.inferred ?? {};

  // ---- Observed: counted facts from the events collection.
  const observedGrid = h(
    'div',
    { class: 'stat-grid' },
    stat('Pipeline value', money(obs.pipelineValueMinor), `${obs.activeProposals ?? 0} published proposals`),
    stat('Closed sales', money(obs.closedValueMinor), `${obs.closedSales ?? 0} accepted`),
    stat('Revenue recognised', money(obs.revenueRecognisedMinor), 'Commencement fees on accepted work'),
    stat('Conversion', pct(obs.conversionRate), 'Accepted ÷ proposals viewed'),
  );

  const engagementGrid = h(
    'div',
    { class: 'stat-grid', style: { marginTop: '12px' } },
    stat('Proposals viewed', String(obs.proposalsViewed ?? 0), 'Distinct proposals with a tracked view'),
    stat('Page views', String(obs.proposal_view ?? 0), 'All tracked views'),
    stat('Chat opened', String(obs.chat_opened ?? 0), 'Assistant opened by a prospect'),
    stat('Messages sent', String(obs.message_sent ?? 0), 'Prospect messages received'),
  );

  const observedCard = card('Prospect behaviour', observedGrid, engagementGrid);
  observedCard.classList.add('section-observed');
  body.appendChild(observedCard);

  // Security signal worth surfacing: repeated prompt-injection attempts against a
  // live proposal are an active threat indicator, not a vanity metric.
  if ((obs.injection_attempt ?? 0) > 0) {
    body.appendChild(
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'card-body' },
          h(
            'div',
            { class: 'danger-box' },
            h('strong', { text: `${obs.injection_attempt} prompt-injection attempt(s) blocked. ` }),
            'A prospect conversation tried to override the assistant\u2019s instructions. ',
            'The content was refused, but you may want to review the conversation.',
          ),
        ),
      ),
    );
  }

  // ---- Inferred: model estimates. Structurally separate, visually separate.
  body.appendChild(inferredCard(inf));

  // ---- Follow-ups recommended from observed activity.
  const followUps = data.followUps ?? [];
  const followCard = card(
    'Recommended follow-ups',
    followUps.length === 0
      ? emptyState('No follow-ups suggested right now.')
      : table(
          ['Proposal', 'Why', 'Basis'],
          followUps.map((f) => [
            h('a', { href: `#/proposals/${encodeURIComponent(f.proposalId)}`, text: f.proposalId }),
            h('span', { text: f.reason }),
            badge(f.basis, f.basis === 'observed' ? 'ok' : 'warn'),
          ]),
        ),
  );
  followCard.classList.add('section-observed');
  body.appendChild(followCard);

  // ---- AI usage for the current month.
  const usage = data.aiUsage ?? {};
  body.appendChild(
    card(
      `Assistant usage — ${usage.monthKey ?? ''}`,
      h(
        'div',
        { class: 'stat-grid' },
        stat('AI spend', `$${(usage.costUsd ?? 0).toFixed(2)}`, 'This calendar month'),
        stat('Tokens', Number(usage.tokens ?? 0).toLocaleString('en-US'), 'Prompt + completion'),
        stat('Model calls', String(usage.calls ?? 0), 'Assistant replies generated'),
        stat('Proposals', String(data.proposalCount ?? 0), 'In your scope'),
      ),
    ),
  );
}

/** Inferred-signal card. The disclaimer is rendered above the data, not after it. */
function inferredCard(inf) {
  const objections = inf.topObjections ?? [];
  const competitors = inf.competitorsMentioned ?? [];
  const interests = inf.interestDistribution ?? [];
  const questions = inf.unansweredQuestions ?? [];

  const kids = [
    h('div', { class: 'inferred-note' }, h('span', { text: '⚠' }), h('span', { text: inf.disclaimer ?? 'Estimated by the AI. Not measured behaviour.' })),
  ];

  if (objections.length) {
    kids.push(
      h('h3', { class: 'muted small', text: 'Objections raised' }),
      table(
        ['Objection', 'Times', 'Avg confidence'],
        objections.map((o) => [h('span', { text: o.type }), h('span', { class: 'num', text: String(o.count) }), h('span', { class: 'num', text: o.avgConfidence != null ? o.avgConfidence.toFixed(2) : '—' })]),
      ),
    );
  }

  if (competitors.length) {
    kids.push(
      h('h3', { class: 'muted small', text: 'Competitors mentioned' }),
      h('div', { class: 'row' }, ...competitors.map((c) => badge(`${c.name} · ${c.count}`, 'neutral'))),
    );
  }

  if (interests.length) {
    kids.push(
      h('h3', { class: 'muted small', text: 'Interest signals' }),
      h('div', { class: 'row' }, ...interests.map((i) => badge(`${i.level} · ${i.count}`, 'accent'))),
    );
  }

  if (questions.length) {
    kids.push(
      h('h3', { class: 'muted small', text: 'Questions the assistant could not answer' }),
      h(
        'ul',
        { class: 'stack', style: { paddingLeft: '18px', gap: '6px', margin: '0' } },
        ...questions.map((q) => h('li', { class: 'prewrap', text: q })),
      ),
      h('p', { class: 'muted small', text: 'Add these to the assistant\u2019s approved knowledge so the next prospect gets an answer.' }),
    );
  }

  if (kids.length === 1) {
    kids.push(emptyState('No inferred signals yet. They appear once prospects start chatting.'));
  }

  const c = card('What the assistant inferred', ...kids);
  c.classList.add('section-inferred');
  return c;
}

// ------------------------------------------------------------------- views

/**
 * Money field. The API stores minor units (integer cents) so no float ever
 * touches a price; the form is the only place dollars exist, and the conversion
 * is a single round() at the boundary.
 */
function moneyField(labelText, initialMinor, hint) {
  const el = input({
    type: 'number',
    min: '0',
    step: '0.01',
    value: initialMinor === null || initialMinor === undefined ? '' : (Number(initialMinor) / 100).toFixed(2),
  });
  return {
    node: field(labelText, el, hint),
    el,
    value: () => Math.round(Number(el.value || 0) * 100),
  };
}

function selectField(labelText, options, initial, hint) {
  const el = h(
    'select',
    {},
    ...options.map((o) => h('option', { value: o.value, text: o.label, selected: o.value === initial ? true : null })),
  );
  return { node: field(labelText, el, hint), el, value: () => el.value };
}

function textField(labelText, initial, opts = {}) {
  const el = input({ value: initial ?? '', ...opts });
  return { node: field(labelText, el, opts.hint), el, value: () => el.value.trim() };
}

function areaField(labelText, initial, opts = {}) {
  const el = textarea({ value: initial ?? '', rows: opts.rows ?? 4 });
  return { node: field(labelText, el, opts.hint), el, value: () => el.value.trim() };
}

/** Legible label for a proposal in a title position. */
function proposalTitle(p) {
  return p.title || '(untitled proposal)';
}

// ------------------------------------------------------------ proposals list

async function viewProposals(view) {
  clear(view);
  view.appendChild(
    pageHead(
      'Proposals',
      'Every proposal in your scope, with its acceptance state.',
      button('New proposal', () => {
        location.hash = '#/proposals/new';
      }),
    ),
  );

  const filter = selectField(
    'Filter',
    [
      { value: '', label: 'All statuses' },
      { value: 'draft', label: 'Draft' },
      { value: 'published', label: 'Published' },
      { value: 'archived', label: 'Archived' },
    ],
    '',
  );
  filter.el.style.width = 'auto';

  const body = h('div');
  view.appendChild(h('div', { class: 'row', style: { marginBottom: '14px' } }, filter.node));
  view.appendChild(body);
  body.appendChild(spinner('Loading proposals…'));

  const load = async () => {
    clear(body);
    body.appendChild(spinner('Loading proposals…'));
    const data = await call('listProposals', filter.value() ? { status: filter.value() } : {});
    clear(body);
    const rows = data.proposals ?? [];

    if (rows.length === 0) {
      body.appendChild(card(null, emptyState('No proposals yet. Create one to get started.')));
      return;
    }

    body.appendChild(
      card(
        null,
        table(
          ['Proposal', 'Prospect', 'Value', 'Commencement', 'Status', 'Acceptance', 'Updated'],
          rows.map((p) => [
            h('a', { href: `#/proposals/${encodeURIComponent(p.id)}`, text: proposalTitle(p) }),
            h(
              'div',
              {},
              h('div', { text: p.prospectName || '—' }),
              p.prospectCompany ? h('div', { class: 'muted small', text: p.prospectCompany }) : null,
            ),
            h('span', { class: 'num', text: money(p.totalValueMinor) }),
            h('span', { class: 'num', text: money(p.commencementMinor) }),
            statusBadge(p.status),
            acceptanceBadge(p.acceptanceStatus),
            h('span', { class: 'small muted nowrap', text: when2(p.updatedAt) }),
          ]),
        ),
      ),
    );
  };

  filter.el.addEventListener('change', () => {
    load().catch(fail);
  });

  await load();
}

// ---------------------------------------------------------- create proposal

async function createProposalView(view) {
  clear(view);
  view.appendChild(pageHead('New proposal', 'Commercial facts the assistant may quote — nothing here is improvised.'));

  const title = textField('Title', '', { hint: 'Shown to the prospect, e.g. "Stage One — Case Intake Platform".' });
  const prospectName = textField('Prospect name', '');
  const prospectCompany = textField('Prospect company', '');
  const prospectEmail = textField('Prospect email', '', { type: 'email' });
  const summary = areaField('Summary', '', { hint: 'One or two sentences on what this proposal covers.' });
  const total = moneyField('Total value', 0, 'Contract value in USD.');
  const commencement = moneyField('Commencement fee', 0, 'Invoiced on signature.');
  const termsNote = areaField('Terms note', '', { rows: 3, hint: 'Payment terms shown to the prospect.' });
  const validUntil = textField('Valid until', '', { type: 'date' });
  const hostedUrl = textField('Hosted proposal URL', '', {
    type: 'url',
    hint: 'Where the full proposal document lives, e.g. https://agency-proposals.com/abrica',
  });

  // Internal record. Only rendered for roles the server accepts (CONFIG_ROLES);
  // a rep never sends these fields at all, so there is nothing to reject.
  const internalFields = [];
  if (canConfigure()) {
    internalFields.push(
      moneyField('Price floor', 0, 'The lowest total you will accept. The assistant is forbidden to go below this.'),
      (() => {
        const el = input({ type: 'number', min: '0', max: '100', step: '1', value: '0' });
        return { node: field('Max discount %', el, 'Hard ceiling on any concession.'), el, value: () => Number(el.value || 0) };
      })(),
      areaField('Negotiation boundaries', '', { hint: 'One per line. E.g. "No discounts on Stage One."' }),
      areaField('Internal notes', '', { rows: 3, hint: 'Never shown to the prospect.' }),
    );
  }

  const errorSlot = h('div');
  const submit = button('Create proposal', null, { type: 'submit' });

  const form = h(
    'form',
    { novalidate: true },
    card(
      'Proposal',
      h('div', { class: 'field-row' }, title.node, prospectName.node),
      h('div', { class: 'field-row' }, prospectCompany.node, prospectEmail.node),
      summary.node,
      h('div', { class: 'field-row' }, total.node, commencement.node),
      termsNote.node,
      h('div', { class: 'field-row' }, validUntil.node, hostedUrl.node),
    ),
    internalFields.length
      ? card(
          'Internal (never sent to the prospect)',
          h('p', { class: 'muted small', text: 'Stored in a separate document the prospect surface cannot read.' }),
          h('div', { class: 'field-row' }, ...internalFields.slice(0, 2).map((f) => f.node)),
          ...internalFields.slice(2).map((f) => f.node),
        )
      : null,
    errorSlot,
    h('div', { class: 'row' }, submit),
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clear(errorSlot);
    submit.disabled = true;
    submit.textContent = 'Creating…';

    const proposal = {
      title: title.value(),
      prospectName: prospectName.value(),
      prospectCompany: prospectCompany.value(),
      prospectEmail: prospectEmail.value(),
      summary: summary.value(),
      totalValueMinor: total.value(),
      commencementMinor: commencement.value(),
      termsNote: termsNote.value(),
      validUntil: validUntil.value(),
      hostedProposalUrl: hostedUrl.value(),
    };

    if (!proposal.title) proposal.title = '';
    if (!proposal.prospectName) proposal.prospectName = '';

    const payload = { proposal };
    if (canConfigure()) {
      const [floor, maxDisc, boundaries, notes] = internalFields;
      payload.internal = {
        priceFloorMinor: floor.value(),
        maxDiscountPercent: maxDisc.value(),
        negotiationBoundaries: lineList(boundaries.el.value),
        internalNotes: notes.el.value,
      };
    }

    try {
      const res = await call('createProposal', payload);
      toast('Proposal created.', 'ok');
      location.hash = `#/proposals/${encodeURIComponent(res.id)}`;
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not create the proposal.';
      errorSlot.appendChild(h('p', { class: 'form-error', text: msg }));
      submit.disabled = false;
      submit.textContent = 'Create proposal';
    }
  });

  view.appendChild(form);
  title.el.focus();
}


// ------------------------------------------------------------ proposal detail

const DETAIL_TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'assistant', label: 'Assistant' },
  { key: 'access', label: 'Access links' },
  { key: 'conversations', label: 'Conversations' },
  { key: 'internal', label: 'Internal', show: canConfigure },
  { key: 'edit', label: 'Edit' },
];

async function viewProposal(view, id) {
  clear(view);
  const body = h('div');
  view.appendChild(body);
  body.appendChild(spinner('Loading proposal…'));

  const data = await call('getProposal', { id });
  clear(body);

  const p = data.proposal ?? {};
  const agent = data.agent ?? {};
  const internal = data.internal ?? null;

  view.insertBefore(
    pageHead(
      proposalTitle(p),
      `${p.prospectName || 'Unknown prospect'}${p.prospectCompany ? ` · ${p.prospectCompany}` : ''}`,
      h(
        'div',
        { class: 'row' },
        statusBadge(p.status),
        acceptanceBadge(p.acceptanceStatus),
        h('a', { class: 'btn btn-ghost btn-sm', href: '#/proposals', text: '← All proposals' }),
      ),
    ),
    body,
  );

  const panel = h('div', { id: 'detail-panel' });
  body.appendChild(panel);

  const tabs = DETAIL_TABS.filter((t) => (t.show ? t.show() : true));
  const current = (location.hash.split('/')[3] || 'overview').split('?')[0];
  const activeKey = tabs.some((t) => t.key === current) ? current : 'overview';

  const tabBar = h(
    'div',
    { class: 'tabs', role: 'tablist' },
    ...tabs.map((t) =>
      h('button', {
        class: `tab${t.key === activeKey ? ' active' : ''}`,
        type: 'button',
        role: 'tab',
        text: t.label,
        'aria-selected': t.key === activeKey ? 'true' : 'false',
        onclick: () => {
          for (const el of tabBar.querySelectorAll('.tab')) {
            el.classList.remove('active');
            el.setAttribute('aria-selected', 'false');
          }
          const self = tabBar.querySelectorAll('.tab')[tabs.indexOf(t)];
          self.classList.add('active');
          self.setAttribute('aria-selected', 'true');
          renderTab(t.key);
        },
      }),
    ),
  );
  body.insertBefore(tabBar, panel);

  const reload = () => {
    // Re-fetch and re-render the whole detail page: lifecycle changes (publish,
    // archive) alter the header badges as well as the tab body.
    viewProposal(view, id).catch(fail);
  };

  function renderTab(key) {
    clear(panel);
    if (key === 'assistant') renderAssistantTab(panel, id, agent, reload);
    else if (key === 'access') renderAccessTab(panel, id);
    else if (key === 'conversations') renderConversationsTab(panel, id);
    else if (key === 'internal') renderInternalTab(panel, id, internal, reload);
    else if (key === 'edit') renderEditTab(panel, id, p, reload);
    else renderOverviewTab(panel, id, p, reload);
  }

  renderTab(activeKey);
}


// ------------------------------------------------------------ overview tab

function renderOverviewTab(panel, id, p, reload) {
  const stack = h('div');

  // ---- lifecycle actions. Each one is confirmed because they are not trivially
  // reversible (archiving revokes every live token).
  const actions = h('div', { class: 'row' });

  if (p.status === 'draft') {
    actions.appendChild(
      button(
        'Publish',
        async () => {
          try {
            await call('publishProposal', { id });
            toast('Proposal published.', 'ok');
            reload();
          } catch (err) {
            fail(err);
          }
        },
        { variant: 'primary' },
      ),
    );
  }

  if (p.status === 'published') {
    actions.appendChild(
      button(
        'Unpublish',
        async () => {
          try {
            await call('unpublishProposal', { id });
            toast('Proposal returned to draft. Existing links stop working.', 'ok');
            reload();
          } catch (err) {
            fail(err);
          }
        },
        { variant: 'ghost' },
      ),
    );
  }

  actions.appendChild(
    button(
      'Duplicate',
      async () => {
        try {
          const res = await call('duplicateProposal', { id });
          toast('Duplicated as a new draft. Access tokens are not copied.', 'ok');
          location.hash = `#/proposals/${encodeURIComponent(res.id)}`;
        } catch (err) {
          fail(err);
        }
      },
      { variant: 'ghost' },
    ),
  );

  if (p.status !== 'archived' && canConfigure()) {
    actions.appendChild(
      button(
        'Archive',
        async () => {
          const ok = await modal({
            title: 'Archive this proposal?',
            body: h(
              'div',
              {},
              h('p', {
                text: 'Archiving revokes every live access link for this proposal. Anyone holding a shared link will immediately lose access.',
              }),
              h('p', { class: 'warn-box', text: 'This is recorded in the audit log.' }),
            ),
            actions: [{ label: 'Archive', value: true, variant: 'danger' }],
            dismissLabel: 'Cancel',
          });
          if (!ok) return;
          try {
            const res = await call('archiveProposal', { id });
            toast(`Archived. ${res.tokensRevoked ?? 0} link(s) revoked.`, 'ok');
            reload();
          } catch (err) {
            fail(err);
          }
        },
        { variant: 'danger' },
      ),
    );
  }

  stack.appendChild(actions);

  // ---- commercial facts
  stack.appendChild(
    card(
      'Commercial terms',
      h(
        'dl',
        { class: 'kv-list' },
        kv('Total value', money(p.totalValueMinor)),
        kv('Commencement fee', money(p.commencementMinor)),
        kv('Valid until', p.validUntil || '—'),
        kv('Document version', String(p.documentVersion ?? 1)),
        kv('Document hash', mono(p.documentHash || 'not yet computed')),
        kv(
          'Hosted proposal',
          p.hostedProposalUrl
            ? h('a', { href: p.hostedProposalUrl, target: '_blank', rel: 'noopener noreferrer', text: p.hostedProposalUrl })
            : '—',
        ),
      ),
    ),
  );

  if (p.summary) {
    stack.appendChild(card('Summary', h('p', { class: 'prewrap', text: p.summary })));
  }
  if (p.termsNote) {
    stack.appendChild(card('Terms note', h('p', { class: 'prewrap', text: p.termsNote })));
  }

  // ---- analytics: observed vs inferred, kept apart.
  const analyticsSlot = h('div');
  stack.appendChild(analyticsSlot);
  analyticsSlot.appendChild(spinner('Loading analytics…'));

  call('getProposalAnalytics', { proposalId: id })
    .then((data) => {
      clear(analyticsSlot);
      const ev = data.events ?? {};

      const observedCard = card(
        'Prospect activity',
        h(
          'div',
          { class: 'stat-grid' },
          stat('Views', String(ev.proposal_view ?? 0), 'Tracked page views'),
          stat('Chat opened', String(ev.chat_opened ?? 0), 'Assistant opened'),
          stat('Messages', String(ev.message_sent ?? 0), 'Prospect messages'),
          stat('Conversations', String(data.conversations ?? 0), 'Distinct sessions'),
        ),
      );
      observedCard.classList.add('section-observed');
      analyticsSlot.appendChild(observedCard);

      const acceptance = data.acceptance;
      if (acceptance) {
        analyticsSlot.appendChild(
          card(
            'Acceptance record',
            h(
              'dl',
              { class: 'kv-list' },
              kv('Accepted by', acceptance.fullName || '—'),
              kv('Accepted at', when2(acceptance.acceptedAt)),
              kv('Document version', String(acceptance.documentVersion ?? '—')),
              kv('Document hash', mono(acceptance.documentHash || '—')),
              kv('Signature', acceptance.signatureProvider ? acceptance.signatureProvider : 'Native acceptance (no external e-signature)'),
            ),
            h('p', {
              class: 'muted small',
              text: 'Recorded natively with an explicit consent step, timestamp and canonical document hash. E-signature providers can be layered on later without changing this record.',
            }),
          ),
        );
      }

      const inf = data.inferred ?? {};
      const objections = inf.objections ?? [];
      const questions = inf.unansweredQuestions ?? [];
      const inferredKids = [
        h('div', { class: 'inferred-note' }, h('span', { text: '\u26a0' }), h('span', { text: inf.disclaimer ?? 'Estimated by the AI. Not measured behaviour.' })),
      ];
      if (objections.length) {
        inferredKids.push(
          table(['Objection', 'Times'], objections.map((o) => [h('span', { text: o.type }), h('span', { class: 'num', text: String(o.count) })])),
        );
      }
      if (questions.length) {
        inferredKids.push(
          h('h3', { class: 'muted small', text: 'Unanswered questions' }),
          h('ul', { style: { paddingLeft: '18px', margin: '0', display: 'grid', gap: '6px' } }, ...questions.map((q) => h('li', { class: 'prewrap', text: q }))),
        );
      }
      if (inferredKids.length === 1) inferredKids.push(emptyState('No inferred signals yet.'));
      const ic = card('What the assistant inferred', ...inferredKids);
      ic.classList.add('section-inferred');
      analyticsSlot.appendChild(ic);
    })
    .catch((err) => {
      clear(analyticsSlot);
      analyticsSlot.appendChild(h('div', { class: 'card' }, h('div', { class: 'card-body' }, h('p', { class: 'muted', text: err instanceof ApiError ? err.message : 'Analytics unavailable.' }))));
    });

  panel.appendChild(stack);
}

// ----------------------------------------------------------- assistant tab

function renderAssistantTab(panel, id, agent, reload) {
  if (!canConfigure()) {
    panel.appendChild(card(null, emptyState('Your role cannot change the assistant configuration.')));
    return;
  }

  const displayName = textField('Display name', agent.displayName ?? 'Proposal Assistant', {
    hint: 'How the assistant introduces itself. Default is neutral — the prospect should see the seller\u2019s identity, not the vendor\u2019s.',
  });
  const subtitle = textField('Subtitle', agent.subtitle ?? '', { hint: 'One line under the name in the chat header.' });
  const welcome = areaField('Welcome message', agent.welcomeMessage ?? '', { rows: 3, hint: 'The assistant\u2019s opening line. Leave blank to use a generic greeting.' });

  const accent = input({ type: 'color', value: agent.accentColor ?? '#1b3a6b', style: 'width:56px;height:34px;padding:2px' });
  const accentHex = input({ value: agent.accentColor ?? '#1b3a6b', style: 'width:96px' });

  const toneEl = h(
    'select',
    {},
    ...['consultative', 'direct', 'warm', 'formal'].map((t) =>
      h('option', { value: t, text: t, selected: (agent.tone ?? 'consultative') === t ? true : null }),
    ),
  );

  const brandingEl = h('input', { type: 'checkbox' });
  brandingEl.checked = agent.showVendorBranding === true;

  const persona = areaField('Persona', agent.persona ?? '', { rows: 2 });
  const closing = areaField('Closing objective', agent.closingObjective ?? '', { rows: 2, hint: 'What the assistant is trying to achieve, phrased as guidance.' });
  const escalation = areaField('Escalation message', agent.escalationMessage ?? '', { rows: 2, hint: 'Shown when the assistant is unsure or the question is out of scope.' });

  const valuePointsEl = textarea({ rows: 5, value: lines(agent.valuePoints) });
  const factsEl = textarea({ rows: 6, value: lines(agent.productFacts) });
  const prohibitedEl = textarea({ rows: 5, value: lines(agent.prohibitedClaims) });

  const playbook = Array.isArray(agent.objectionPlaybook) ? agent.objectionPlaybook : [];
  const playbookEl = textarea({
    rows: Math.max(4, playbook.length * 3 + 2),
    value: playbook.map((o) => `${o.type} | ${o.trigger} | ${o.response}`).join('\n'),
  });

  accent.addEventListener('input', () => {
    accentHex.value = accent.value;
  });
  accentHex.addEventListener('input', () => {
    if (/^#[0-9a-fA-F]{6}$/.test(accentHex.value)) accent.value = accentHex.value;
  });

  const save = button('Save assistant settings', null, { type: 'submit' });
  const errorSlot = h('div');

  const form = h(
    'form',
    { novalidate: true },
    card(
      'Identity shown to the prospect',
      h('div', { class: 'field-row' }, displayName.node, subtitle.node),
      welcome.node,
      h(
        'div',
        { class: 'field-row' },
        field('Accent colour', h('div', { class: 'row' }, accent, accentHex), 'Applies to the chat header and send button.'),
        field('Tone', toneEl),
      ),
      field(
        'Vendor branding',
        h(
          'label',
          { class: 'check' },
          brandingEl,
          h('span', {
            text: 'Show a small "Assistant by BuildClose" badge in the chat. Off by default so the prospect\u2019s experience is dominated by the seller, not the platform.',
          }),
        ),
      ),
    ),
    card(
      'Behaviour',
      h('div', { class: 'field-row' }, persona.node, closing.node),
      escalation.node,
    ),
    card(
      'Approved knowledge',
      h('p', { class: 'muted small', text: 'The assistant may only state facts from these lists. Anything not listed is treated as unknown rather than guessed.' }),
      field('Value points', valuePointsEl, 'One per line. Quotable statements about the offering.'),
      field('Product facts', factsEl, 'One per line. Hard facts the assistant may state verbatim.'),
      field('Prohibited claims', prohibitedEl, 'One per line. Things the assistant must never say, e.g. "guaranteed results".'),
    ),
    card(
      'Objection playbook',
      h('p', { class: 'muted small', text: 'One per line, pipe-separated: type | trigger | response. The assistant uses these for approved rebuttals instead of improvising.' }),
      playbookEl,
    ),
    errorSlot,
    h('div', { class: 'row' }, save),
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clear(errorSlot);
    save.disabled = true;
    save.textContent = 'Saving…';

    const parsedPlaybook = lineList(playbookEl.value)
      .map((line) => {
        const [type, trigger, response] = line.split('|').map((s) => (s ?? '').trim());
        return type && trigger && response ? { type, trigger, response } : null;
      })
      .filter(Boolean);

    const payload = {
      displayName: displayName.value() || 'Proposal Assistant',
      subtitle: subtitle.value(),
      welcomeMessage: welcome.el.value.trim(),
      accentColor: accentHex.value,
      showVendorBranding: brandingEl.checked,
      tone: toneEl.value,
      persona: persona.el.value.trim(),
      closingObjective: closing.el.value.trim(),
      escalationMessage: escalation.el.value.trim(),
      valuePoints: lineList(valuePointsEl.value),
      productFacts: lineList(factsEl.value),
      prohibitedClaims: lineList(prohibitedEl.value),
      objectionPlaybook: parsedPlaybook,
    };

    try {
      await call('updateProposal', { id, agent: payload });
      toast('Assistant settings saved.', 'ok');
      reload();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not save.';
      errorSlot.appendChild(h('p', { class: 'form-error', text: msg }));
      save.disabled = false;
      save.textContent = 'Save assistant settings';
    }
  });

  panel.appendChild(form);
}


// -------------------------------------------------------------- access tab

/**
 * Access links.
 *
 * Two things this tab must make obvious, because both are easy to get wrong:
 *
 *  - The token is shown EXACTLY ONCE. Only a SHA-256 hash is stored, so there is
 *    no "show again" — if it is lost, mint a new one and revoke the old.
 *  - The embed origin is per-proposal and per-token. A token pinned to one host
 *    is refused on every other host, so a copied snippet does not work elsewhere.
 *    The server enforces this; the input below is where it is declared.
 */
function renderAccessTab(panel, id) {
  const stack = h('div');

  // ---- mint form
  const labelEl = input({ placeholder: 'e.g. Abrica — CFO review', maxlength: '80' });
  const expiresEl = input({ type: 'number', min: '1', max: '365', value: '30', style: 'width:110px' });
  const originsEl = textarea({
    rows: 3,
    placeholder: 'https://agency-proposals.com',
  });

  const mintMsg = h('div');
  const mintBtn = button('Create access link', null, { type: 'submit' });

  const mintForm = h(
    'form',
    { novalidate: true },
    field('Label', labelEl, 'For your own reference. Not shown to the prospect.'),
    h('div', { class: 'field-row' }, field('Expires in (days)', expiresEl)),
    field(
      'Authorized embed origins',
      originsEl,
      'One per line, e.g. https://agency-proposals.com. The link only works when the embedding page is on one of these origins. Leave blank to allow any origin (not recommended).',
    ),
    mintMsg,
    h('div', { class: 'row' }, mintBtn),
  );

  mintForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    clear(mintMsg);
    mintBtn.disabled = true;
    mintBtn.textContent = 'Creating…';

    const origins = lineList(originsEl.value).map((o) => o.replace(/\/+$/, ''));
    const bad = origins.find((o) => !/^https?:\/\/[^\s/]+$/i.test(o));

    if (bad) {
      mintMsg.appendChild(h('p', { class: 'form-error', text: `"${bad}" is not a valid origin. Use scheme + host only, e.g. https://agency-proposals.com` }));
      mintBtn.disabled = false;
      mintBtn.textContent = 'Create access link';
      return;
    }

    try {
      const res = await call('mintAccessToken', {
        proposalId: id,
        label: labelEl.value.trim() || undefined,
        expiresInDays: Number(expiresEl.value || 30),
        allowedOrigins: origins,
      });
      await presentMintedToken(res, origins);
      labelEl.value = '';
      await loadTokens();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not create the link.';
      mintMsg.appendChild(h('p', { class: 'form-error', text: msg }));
    } finally {
      mintBtn.disabled = false;
      mintBtn.textContent = 'Create access link';
    }
  });

  stack.appendChild(card('Create a link for a prospect', mintForm));

  // ---- existing tokens
  const tokenSlot = h('div');
  const tokenCard = card('Access links', tokenSlot);
  stack.appendChild(tokenCard);

  async function loadTokens() {
    clear(tokenSlot);
    tokenSlot.appendChild(spinner('Loading links…'));
    const data = await call('listAccessTokens', { proposalId: id });
    clear(tokenSlot);
    const tokens = data.tokens ?? [];

    if (tokens.length === 0) {
      tokenSlot.appendChild(emptyState('No access links yet. Create one to give the prospect access to the assistant.'));
      return;
    }

    const now = Date.now();
    tokenSlot.appendChild(
      table(
        ['Label', 'Created', 'Expires', 'Uses', 'Last used', 'State', ''],
        tokens.map((t) => {
          const expiresMs = ts(t.expiresAt);
          const revoked = Boolean(t.revokedAt);
          const expired = expiresMs !== null && expiresMs < now;
          const state = revoked ? badge('revoked', 'danger') : expired ? badge('expired', 'warn') : badge('active', 'ok');

          const revokeBtn = h('button', {
            class: 'btn btn-danger btn-sm',
            type: 'button',
            text: revoked ? 'Revoked' : 'Revoke',
          });
          if (revoked) revokeBtn.disabled = true;
          else {
            revokeBtn.addEventListener('click', async () => {
              const ok = await modal({
                title: 'Revoke this link?',
                body: h('p', {
                  text: 'Anyone using this link will immediately lose access. This cannot be undone — create a new link instead.',
                }),
                actions: [{ label: 'Revoke', value: true, variant: 'danger' }],
                dismissLabel: 'Cancel',
              });
              if (!ok) return;
              try {
                await call('revokeAccessToken', { tokenHash: t.tokenHash });
                toast('Link revoked.', 'ok');
                await loadTokens();
              } catch (err) {
                fail(err);
              }
            });
          }

          return [
            h('span', { text: t.label || '—' }),
            h('span', { class: 'small muted nowrap', text: when2(t.createdAt) }),
            h('span', { class: 'small nowrap', text: when2(t.expiresAt) }),
            h('span', { class: 'num', text: String(t.useCount ?? 0) }),
            h('span', { class: 'small muted nowrap', text: when2(t.lastExchangedAt) }),
            state,
            revokeBtn,
          ];
        }),
      ),
    );
    // Hash prefix so two links on the same proposal are distinguishable at a glance.
    tokenSlot.appendChild(
      h(
        'p',
        { class: 'muted small', style: { marginTop: '10px' } },
        'Only a hash of each link is stored. A lost link cannot be recovered — revoke it and create a new one.',
      ),
    );
  }

  panel.appendChild(stack);
  loadTokens().catch(fail);
}

/** Show the freshly minted link + embed snippet once, then forget it. */
async function presentMintedToken(res, origins) {
  const agentOrigin = window.__BC_CONFIG__?.agentOrigin ?? 'https://agent.buildclose.app';
  const token = res.token;
  const link = res.link;

  const allowed = origins.length ? origins : ['any origin (unrestricted)'];
  const primaryOrigin = origins[0] ?? '';

  const snippet =
    `<script src="${agentOrigin}/widget.js"\n` +
    `        data-bc="${token}"\n` +
    `        data-chat-origin="${agentOrigin}"\n` +
    `        data-label="Questions about this proposal?"\n` +
    `        defer></script>`;

  const copyBtn = (text, label) => {
    const b = button(label, null, { variant: 'ghost' });
    b.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
        b.textContent = 'Copied';
        setTimeout(() => {
          b.textContent = label;
        }, 1600);
      } catch {
        toast('Copy failed — select the text and copy manually.', 'error');
      }
    });
    return b;
  };

  await modal({
    title: 'Access link created',
    body: h(
      'div',
      {},
      h('div', { class: 'warn-box' }, h('strong', { text: 'Shown once. ' }), 'Copy it now — only a hash is stored, so it cannot be displayed again.'),
      h('h3', { class: 'muted small', text: 'Direct link' }),
      h('div', { class: 'secret-box', text: link }),
      h('div', { class: 'row' }, copyBtn(link, 'Copy link')),
      h('div', { class: 'divider' }),
      h('h3', { class: 'muted small', text: 'Embed snippet' }),
      h('div', { class: 'secret-box', text: snippet }),
      h('div', { class: 'row' }, copyBtn(snippet, 'Copy snippet')),
      h('div', { class: 'divider' }),
      h(
        'dl',
        { class: 'kv-list' },
        kv('Expires', when2(res.expiresAt)),
        kv('Authorized origins', allowed.join(', ')),
      ),
      primaryOrigin
        ? h(
            'p',
            { class: 'muted small' },
            `This link will only authenticate on pages served from ${primaryOrigin}. On any other host the API refuses it, even with a valid token.`,
          )
        : h('p', { class: 'warn-box', text: 'No origin was pinned. This link will work from any host — revoke it and create one with an origin if that is not intended.' }),
    ),
    dismissLabel: 'Done',
  });
}

// ------------------------------------------------------- conversations tab

function renderConversationsTab(panel, id) {
  const stack = h('div');
  const listSlot = h('div');
  const threadSlot = h('div');

  stack.appendChild(card('Conversations', listSlot));
  stack.appendChild(threadSlot);
  panel.appendChild(stack);

  const openThread = async (conversationId) => {
    clear(threadSlot);
    threadSlot.appendChild(spinner('Loading transcript…'));
    try {
      const data = await call('getConversation', { conversationId });
      clear(threadSlot);
      const messages = data.messages ?? [];

      const bubble = (m) => {
        const flagged = m.role === 'assistant' && m.meta && m.meta.blocked === true;
        return h(
          'div',
          { class: `msg msg-${m.role === 'user' ? 'user' : 'assistant'}${flagged ? ' msg-flagged' : ''}` },
          h('div', { text: m.content }),
          h(
            'div',
            { class: 'msg-meta' },
            `${m.role === 'user' ? 'Prospect' : 'Assistant'} · ${when2(m.createdAt)}`,
            flagged ? ' · response was filtered by the commercial guardrail' : '',
            m.role === 'assistant' && m.meta?.escalated ? ' · escalated' : '',
          ),
        );
      };

      threadSlot.appendChild(
        card(
          'Transcript',
          messages.length === 0
            ? emptyState('This conversation has no messages.')
            : h('div', { class: 'thread' }, ...messages.map(bubble)),
        ),
      );
    } catch (err) {
      clear(threadSlot);
      threadSlot.appendChild(
        h('div', { class: 'card' }, h('div', { class: 'card-body' }, h('p', { class: 'muted', text: err instanceof ApiError ? err.message : 'Transcript unavailable.' }))),
      );
    }
  };

  (async () => {
    listSlot.appendChild(spinner('Loading conversations…'));
    const data = await call('listConversations', { proposalId: id });
    clear(listSlot);
    const convs = data.conversations ?? [];

    if (convs.length === 0) {
      listSlot.appendChild(emptyState('No conversations yet. The assistant records a thread as soon as a prospect sends a message.'));
      return;
    }

    const rows = convs.map((c) => {
      const openBtn = button('Open', () => openThread(c.id), { variant: 'ghost' });
      openBtn.classList.add('btn-sm');
      return [
        h('span', { class: 'small muted nowrap', text: when2(c.startedAt) }),
        h('span', { class: 'small nowrap', text: when2(c.lastMessageAt) }),
        h('span', { class: 'num', text: String(c.messageCount ?? 0) }),
        badge(c.status ?? 'open', c.status === 'open' ? 'accent' : 'neutral'),
        openBtn,
      ];
    });

    listSlot.appendChild(table(['Started', 'Last message', 'Messages', 'Status', ''], rows));
  })().catch((err) => {
    clear(listSlot);
    listSlot.appendChild(h('p', { class: 'muted', text: err instanceof ApiError ? err.message : 'Could not load conversations.' }));
  });
}


// ------------------------------------------------------------- internal tab

/**
 * The internal record. Requirement 4 is structural: this lives in its own
 * Firestore document (`proposalInternal/{id}`) that no prospect-facing code path
 * ever reads. The tab simply reflects that — if `getProposal` returned
 * `internal: null` the role does not have it, and the whole tab is hidden.
 */
function renderInternalTab(panel, id, internal, reload) {
  const d = internal ?? {};

  const floor = moneyField('Price floor', d.priceFloorMinor ?? 0, 'The assistant will never concede below this.');
  const maxDisc = (() => {
    const el = input({ type: 'number', min: '0', max: '100', step: '1', value: String(d.maxDiscountPercent ?? 0) });
    return { node: field('Max discount %', el), el, value: () => Number(el.value || 0) };
  })();
  const boundaries = areaField('Negotiation boundaries', lines(d.negotiationBoundaries), { hint: 'One per line.' });
  const notes = areaField('Internal notes', d.internalNotes ?? '', { rows: 5 });

  const competitors = Array.isArray(d.competitorNotes) ? d.competitorNotes : [];
  const competitorEl = textarea({
    rows: Math.max(3, competitors.length + 2),
    value: competitors.map((c) => `${c.competitor} | ${c.posture}`).join('\n'),
  });

  const discounts = Array.isArray(d.approvedDiscounts) ? d.approvedDiscounts : [];
  const discountEl = textarea({
    rows: Math.max(3, discounts.length + 2),
    value: discounts.map((x) => `${x.label} | ${(Number(x.amountMinor ?? 0) / 100).toFixed(2)} | ${x.conditions}`).join('\n'),
  });

  const quotable = Array.isArray(d.quotableAmountsMinor) ? d.quotableAmountsMinor : [];
  const quotableEl = textarea({
    rows: Math.max(3, quotable.length + 2),
    value: quotable.map((m) => (Number(m) / 100).toFixed(2)).join('\n'),
  });

  const errorSlot = h('div');
  const save = button('Save internal record', null, { type: 'submit' });

  const form = h(
    'form',
    { novalidate: true },
    h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'card-body' },
        h(
          'div',
          { class: 'danger-box' },
          h('strong', { text: 'Never shown to the prospect. ' }),
          'This document has no client read path at all — the restriction is the document split, not a field filter.',
        ),
      ),
    ),
    card(
      'Commercial guardrails',
      h('div', { class: 'field-row' }, floor.node, maxDisc.node),
      boundaries.node,
      notes.node,
    ),
    card(
      'Competitor notes',
      h('p', { class: 'muted small', text: 'One per line: competitor | your posture. Used to steer rebuttals without naming a price.' }),
      competitorEl,
    ),
    card(
      'Approved discounts',
      h('p', { class: 'muted small', text: 'One per line: label | amount in USD | conditions. The assistant may only offer exactly these, on exactly these conditions.' }),
      discountEl,
    ),
    card(
      'Quotable amounts',
      h(
        'p',
        { class: 'muted small' },
        'One per line, in USD. Published prices the assistant may STATE. Quoting is not conceding — these are kept separate from approved discounts so "may quote" never implies "may offer".',
      ),
      quotableEl,
    ),
    errorSlot,
    h('div', { class: 'row' }, save),
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clear(errorSlot);
    save.disabled = true;
    save.textContent = 'Saving…';

    const parsedCompetitors = lineList(competitorEl.value)
      .map((line) => {
        const [competitor, posture] = line.split('|').map((s) => (s ?? '').trim());
        return competitor && posture ? { competitor, posture } : null;
      })
      .filter(Boolean);

    const parsedDiscounts = lineList(discountEl.value)
      .map((line) => {
        const [label, amount, conditions] = line.split('|').map((s) => (s ?? '').trim());
        const amountMinor = Math.round(Number(amount || 0) * 100);
        return label && Number.isFinite(amountMinor) ? { label, amountMinor, conditions: conditions ?? '' } : null;
      })
      .filter(Boolean);

    const parsedQuotable = lineList(quotableEl.value)
      .map((v) => Math.round(Number(v) * 100))
      .filter((n) => Number.isFinite(n) && n >= 0);

    try {
      await call('updateProposal', {
        id,
        internal: {
          priceFloorMinor: floor.value(),
          maxDiscountPercent: maxDisc.value(),
          negotiationBoundaries: lineList(boundaries.el.value),
          internalNotes: notes.el.value,
          competitorNotes: parsedCompetitors,
          approvedDiscounts: parsedDiscounts,
          quotableAmountsMinor: parsedQuotable,
        },
      });
      toast('Internal record saved.', 'ok');
      reload();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not save.';
      errorSlot.appendChild(h('p', { class: 'form-error', text: msg }));
      save.disabled = false;
      save.textContent = 'Save internal record';
    }
  });

  panel.appendChild(form);
}

// ----------------------------------------------------------------- edit tab

function renderEditTab(panel, id, p, reload) {
  const title = textField('Title', p.title ?? '');
  const prospectName = textField('Prospect name', p.prospectName ?? '');
  const prospectCompany = textField('Prospect company', p.prospectCompany ?? '');
  const prospectEmail = textField('Prospect email', p.prospectEmail ?? '', { type: 'email' });
  const summary = areaField('Summary', p.summary ?? '');
  const total = moneyField('Total value', p.totalValueMinor ?? 0);
  const commencement = moneyField('Commencement fee', p.commencementMinor ?? 0);
  const termsNote = areaField('Terms note', p.termsNote ?? '', { rows: 3 });
  const validUntil = textField('Valid until', p.validUntil ?? '', { type: 'date' });
  const hostedUrl = textField('Hosted proposal URL', p.hostedProposalUrl ?? '', { type: 'url' });

  const errorSlot = h('div');
  const save = button('Save changes', null, { type: 'submit' });

  const form = h(
    'form',
    { novalidate: true },
    h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'card-body' },
        h(
          'div',
          { class: 'warn-box' },
          'Changing a commercial term (title, value, commencement fee, terms note, valid date or hosted URL) issues a new document version and resets any prior acceptance to "superseded". The prospect must accept again.',
        ),
      ),
    ),
    card(
      'Proposal',
      h('div', { class: 'field-row' }, title.node, prospectName.node),
      h('div', { class: 'field-row' }, prospectCompany.node, prospectEmail.node),
      summary.node,
      h('div', { class: 'field-row' }, total.node, commencement.node),
      termsNote.node,
      h('div', { class: 'field-row' }, validUntil.node, hostedUrl.node),
    ),
    errorSlot,
    h('div', { class: 'row' }, save),
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clear(errorSlot);
    save.disabled = true;
    save.textContent = 'Saving…';

    try {
      const res = await call('updateProposal', {
        id,
        proposal: {
          title: title.value(),
          prospectName: prospectName.value(),
          prospectCompany: prospectCompany.value(),
          prospectEmail: prospectEmail.value(),
          summary: summary.el.value.trim(),
          totalValueMinor: total.value(),
          commencementMinor: commencement.value(),
          termsNote: termsNote.el.value.trim(),
          validUntil: validUntil.value(),
          hostedProposalUrl: hostedUrl.value(),
        },
      });
      toast(
        res.versionBumped
          ? 'Saved. Commercial terms changed — document version bumped and acceptance reset.'
          : 'Saved.',
        'ok',
      );
      reload();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not save.';
      errorSlot.appendChild(h('p', { class: 'form-error', text: msg }));
      save.disabled = false;
      save.textContent = 'Save changes';
    }
  });

  panel.appendChild(form);
}

// ------------------------------------------------------------------- team

const ROLE_OPTIONS = [
  { value: 'sales_rep', label: 'Sales rep' },
  { value: 'sales_manager', label: 'Sales manager' },
  { value: 'company_admin', label: 'Company admin' },
];

async function viewTeam(view) {
  clear(view);
  if (!canManageTeam()) {
    view.appendChild(pageHead('Team', 'Manage who can access this workspace.'));
    view.appendChild(card(null, emptyState('Only company admins can manage the team.')));
    return;
  }

  view.appendChild(pageHead('Team', 'People who can sign in to this workspace.'));

  // ---- invite form
  const emailEl = input({ type: 'email', placeholder: 'name@company.com' });
  const nameEl = input({ placeholder: 'Optional' });
  const roleEl = h('select', {}, ...ROLE_OPTIONS.map((r) => h('option', { value: r.value, text: r.label })));
  roleEl.value = 'sales_rep';

  const inviteMsg = h('div');
  const inviteBtn = button('Invite', null, { type: 'submit' });

  const inviteForm = h(
    'form',
    { novalidate: true },
    h(
      'p',
      { class: 'muted small' },
      'Invitng an email that has no account creates one and grants the role immediately. The person sets their own password via "Forgot password" on first sign-in.',
    ),
    h('div', { class: 'field-row' }, field('Email', emailEl), field('Name', nameEl)),
    field('Role', roleEl, 'You cannot grant a role at or above your own.'),
    inviteMsg,
    h('div', { class: 'row' }, inviteBtn),
  );

  inviteForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    clear(inviteMsg);
    inviteBtn.disabled = true;
    inviteBtn.textContent = 'Inviting…';
    try {
      await call('inviteStaff', {
        email: emailEl.value.trim(),
        role: roleEl.value,
        displayName: nameEl.value.trim() || undefined,
      });
      toast('Invitation sent.', 'ok');
      emailEl.value = '';
      nameEl.value = '';
      await loadStaff();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not invite.';
      inviteMsg.appendChild(h('p', { class: 'form-error', text: msg }));
    } finally {
      inviteBtn.disabled = false;
      inviteBtn.textContent = 'Invite';
    }
  });

  view.appendChild(card('Invite a team member', inviteForm));

  const staffSlot = h('div');
  view.appendChild(card('Members', staffSlot));

  async function loadStaff() {
    clear(staffSlot);
    staffSlot.appendChild(spinner('Loading team…'));
    const data = await call('listStaff');
    clear(staffSlot);
    const staff = data.staff ?? [];

    if (staff.length === 0) {
      staffSlot.appendChild(emptyState('No team members found.'));
      return;
    }

    const rows = staff.map((s) => {
      const sel = h(
        'select',
        {},
        ...ROLE_OPTIONS.map((r) => h('option', { value: r.value, text: r.label, selected: r.value === s.role ? true : null })),
      );
      sel.style.width = 'auto';
      // A role change is only offered where the server would accept it: you cannot
      // assign at or above your own rank, and admins cannot demote themselves here.
      const editable = s.uid !== me.uid && (RANK[s.role] ?? 0) < (RANK[role()] ?? 0);
      if (!editable) {
        sel.disabled = true;
      } else {
        sel.addEventListener('change', async () => {
          sel.disabled = true;
          try {
            await call('setStaffRole', { uid: s.uid, role: sel.value });
            toast('Role updated.', 'ok');
          } catch (err) {
            toast(err instanceof ApiError ? err.message : 'Could not change role.', 'error');
          }
          await loadStaff();
        });
      }

      return [
        h(
          'div',
          {},
          h('div', { text: s.email || '—' }),
          s.displayName ? h('div', { class: 'muted small', text: s.displayName }) : null,
        ),
        sel,
        badge(s.status ?? 'active', (s.status ?? 'active') === 'active' ? 'ok' : 'warn'),
        s.uid === me.uid ? badge('you', 'accent') : h('span', { class: 'muted small', text: '—' }),
      ];
    });

    staffSlot.appendChild(table(['Member', 'Role', 'Status', ''], rows));
  }

  await loadStaff();
}

// ------------------------------------------------------------------ audit

const AUDIT_LABELS = {
  'proposal.created': 'Proposal created',
  'proposal.updated': 'Proposal updated',
  'proposal.published': 'Proposal published',
  'proposal.unpublished': 'Proposal unpublished',
  'proposal.archived': 'Proposal archived',
  'token.minted': 'Access link created',
  'token.revoked': 'Access link revoked',
  'staff.invited': 'Staff invited',
  'staff.role_changed': 'Staff role changed',
  'proposal.accepted': 'Proposal accepted',
  'proposal.declined': 'Proposal declined',
};

async function viewAudit(view) {
  clear(view);
  if (!canAudit()) {
    view.appendChild(pageHead('Audit log', 'A record of material actions.'));
    view.appendChild(card(null, emptyState('Only managers and admins can read the audit log.')));
    return;
  }

  view.appendChild(pageHead('Audit log', 'Every material action in this workspace, newest first.'));

  const slot = h('div');
  view.appendChild(slot);
  slot.appendChild(spinner('Loading audit log…'));

  const data = await call('getAuditLog');
  clear(slot);
  const entries = data.entries ?? [];

  if (entries.length === 0) {
    slot.appendChild(card(null, emptyState('No recorded actions yet.')));
    return;
  }

  slot.appendChild(
    card(
      null,
      table(
        ['When', 'Action', 'Actor', 'Proposal', 'Detail'],
        entries.map((e) => [
          h('span', { class: 'small muted nowrap', text: when2(e.createdAt) }),
          h('span', { text: AUDIT_LABELS[e.action] ?? e.action }),
          h(
            'div',
            { class: 'small' },
            h('div', { text: e.actorType || '—' }),
            e.actorId ? h('div', { class: 'muted', text: String(e.actorId).slice(0, 12) }) : null,
          ),
          e.proposalId
            ? h('a', { class: 'mono', href: `#/proposals/${encodeURIComponent(e.proposalId)}`, text: String(e.proposalId).slice(0, 10) })
            : h('span', { class: 'muted', text: '—' }),
          Object.keys(e.detail ?? {}).length
            ? h('code', { class: 'mono small', text: JSON.stringify(e.detail) })
            : h('span', { class: 'muted', text: '—' }),
        ]),
      ),
    ),
  );
}

// -------------------------------------------------------------------- boot

(async function boot() {
  if (!window.__BC_CONFIG__) {
    clear(appEl);
    appEl.className = '';
    appEl.appendChild(
      h(
        'div',
        { class: 'signin-wrap' },
        h(
          'div',
          { class: 'signin' },
          h('h1', { text: 'Configuration missing' }),
          h('p', {
            class: 'sub',
            text: 'config.js was not generated. Run `node build.mjs` with FIREBASE_API_KEY and FIREBASE_APP_ID set, or check this site\u2019s environment variables.',
          }),
        ),
      ),
    );
    return;
  }

  if (!auth.isSignedIn) return renderSignIn();

  try {
    me = await auth.claims();
    if (!me.companyId) {
      await auth.signOut();
      me = null;
      return renderSignIn('This account is not attached to a company yet.');
    }
    renderShell();
  } catch {
    await auth.signOut();
    me = null;
    renderSignIn();
  }
})();
