/**
 * BuildClose — prospect chat app (embed surface).
 *
 * Runs on agent.buildclose.app — the AI chatbot infrastructure host, which is a
 * different origin from the customer dashboard (app.buildclose.app). Identity model:
 *
 *   1. The parent widget loads this page in a sandboxed iframe.
 *   2. We announce readiness with `bc:ready`.
 *   3. The widget replies `bc:init` carrying the proposal token.
 *   4. We exchange that token for a session (memory only — never storage).
 *
 * Because the token arrives over postMessage rather than the URL, it never
 * appears in Referer headers, history, or access logs. The parent origin is
 * captured at init and used to scope every outbound message.
 */
import { ApiClient, ApiError, money } from '../src/api.js';

const API_BASE = window.__BC_API_BASE__ || document.documentElement.dataset.apiBase || '';

const el = {
  app: /** @type {HTMLElement} */ (document.getElementById('app')),
  title: /** @type {HTMLElement} */ (document.getElementById('title')),
  subtitle: /** @type {HTMLElement} */ (document.getElementById('subtitle')),
  loading: /** @type {HTMLElement} */ (document.getElementById('loading')),
  error: /** @type {HTMLElement} */ (document.getElementById('error')),
  errorMsg: /** @type {HTMLElement} */ (document.getElementById('error-msg')),
  retry: /** @type {HTMLButtonElement} */ (document.getElementById('retry')),
  chat: /** @type {HTMLElement} */ (document.getElementById('chat')),
  log: /** @type {HTMLElement} */ (document.getElementById('log')),
  typing: /** @type {HTMLElement} */ (document.getElementById('typing')),
  form: /** @type {HTMLFormElement} */ (document.getElementById('form')),
  input: /** @type {HTMLTextAreaElement} */ (document.getElementById('input')),
  send: /** @type {HTMLButtonElement} */ (document.getElementById('send')),
  close: /** @type {HTMLButtonElement} */ (document.getElementById('close')),
  disclosure: /** @type {HTMLElement} */ (document.getElementById('disclosure')),
  accept: /** @type {HTMLElement} */ (document.getElementById('accept')),
  acceptBack: /** @type {HTMLButtonElement} */ (document.getElementById('accept-back')),
  acceptForm: /** @type {HTMLFormElement} */ (document.getElementById('accept-form')),
  acceptErr: /** @type {HTMLElement} */ (document.getElementById('accept-err')),
  acceptSubmit: /** @type {HTMLButtonElement} */ (document.getElementById('accept-submit')),
  terms: /** @type {HTMLElement} */ (document.getElementById('terms')),
  done: /** @type {HTMLElement} */ (document.getElementById('done')),
  doneMsg: /** @type {HTMLElement} */ (document.getElementById('done-msg')),
  doneClose: /** @type {HTMLButtonElement} */ (document.getElementById('done-close')),
};

const api = new ApiClient(API_BASE);

let parentOrigin = '';
let terms = /** @type {Terms | null} */ (null);
let busy = false;
let started = false;
/** Set when the host asks for acceptance before /api/terms has resolved. */
let wantAccept = false;

// ---------------------------------------------------------------- messaging

function postToParent(payload) {
  if (!parentOrigin) return;
  window.parent.postMessage(payload, parentOrigin);
}

/**
 * Announce readiness.
 *
 * This is the ONE message that cannot be sent to a known origin, because the
 * whole point of it is "tell me who you are". `parentOrigin` is still empty at
 * this moment. Sending it through postToParent() was a real bug: the guard
 * dropped the message, the widget never replied with bc:init, and the iframe sat
 * on its loading state forever. Invisible to the API tests, which call the
 * endpoints directly and never run the handshake.
 *
 * Posting to '*' is safe here and only here: the payload is a constant string
 * with no token, no id and no prospect data. The parent verifies event.origin
 * against its own configured chat origin before replying, and every subsequent
 * message goes to that pinned origin.
 */
function announceReady() {
  try {
    window.parent.postMessage({ type: 'bc:ready' }, '*');
  } catch {
    /* parent gone — nothing to announce to */
  }
}

function reportHeight() {
  // Report the document height so the widget can size the panel. Clamped
  // by the widget, so a measurement bug cannot cover the host page.
  const h = Math.ceil(document.documentElement.getBoundingClientRect().height);
  postToParent({ type: 'bc:resize', height: h });
}

// --------------------------------------------------------------- ui helpers

let currentSection = null;

function show(section) {
  currentSection = section;
  for (const s of [el.loading, el.error, el.chat, el.accept, el.done]) {
    s.hidden = s !== section;
  }
  reportHeight();
}

/**
 * Return to the conversation — but never pull the prospect away from a screen
 * they deliberately went to.
 *
 * The widget sends bc:open on every panel open, including a reopen after the
 * prospect closed the panel to re-read the proposal with the acceptance form
 * half-filled. Unconditionally calling show(el.chat) there would silently
 * discard their place and their typed name. Bootstrap finishing late had the
 * same effect, which is what made the acceptance test fail intermittently.
 */
function returnToChat() {
  if (currentSection === el.accept || currentSection === el.done) return;
  show(el.chat);
}

function fail(message) {
  el.errorMsg.textContent = message;
  show(el.error);
}

function addMessage(role, text, cta) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role === 'user' ? 'me' : 'bot'}`;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  wrap.appendChild(bubble);

  if (cta) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cta';
    btn.textContent = cta.label;
    btn.addEventListener('click', () => handleCta(cta));
    wrap.appendChild(btn);
  }

  el.log.appendChild(wrap);
  el.log.scrollTop = el.log.scrollHeight;
  return wrap;
}

function addSystem(text) {
  const p = document.createElement('div');
  p.className = 'msg bot';
  const s = document.createElement('div');
  s.className = 'sys';
  s.textContent = text;
  p.appendChild(s);
  el.log.appendChild(p);
  el.log.scrollTop = el.log.scrollHeight;
}

// ------------------------------------------------------------- CTA handling

async function handleCta(cta) {
  await api.event('cta_clicked', cta.id);

  // Native actions run inside the app; anything else opens in a new tab.
  if (cta.url === 'native:accept') {
    openAcceptance();
    return;
  }
  if (cta.url.startsWith('mailto:')) {
    window.open(cta.url, '_blank', 'noopener');
    return;
  }
  window.open(cta.url, '_blank', 'noopener,noreferrer');
}

// --------------------------------------------------------------- acceptance

function openAcceptance() {
  if (!terms) return;
  el.terms.innerHTML = '';

  const dl = document.createElement('dl');
  const rows = [
    ['Proposal', terms.proposal.title],
    ['Prepared for', terms.proposal.prospectName],
    ['Total', money(terms.proposal.totalValueMinor)],
    ['Commencement payment', money(terms.proposal.commencementMinor)],
    ...(terms.proposal.validUntil ? [['Valid until', terms.proposal.validUntil]] : []),
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  }
  el.terms.appendChild(dl);

  if (terms.proposal.termsNote) {
    const note = document.createElement('p');
    note.className = 'terms-note';
    note.textContent = terms.proposal.termsNote;
    el.terms.appendChild(note);
  }

  if (terms.acceptanceStatus === 'accepted') {
    showDone('This proposal has already been accepted. Thank you.');
    return;
  }

  el.acceptErr.hidden = true;
  show(el.accept);
  el.acceptForm.querySelector('#a-name')?.focus();
}

function showDone(message) {
  el.doneMsg.textContent = message;
  show(el.done);
}

el.acceptBack.addEventListener('click', () => {
  el.acceptErr.hidden = true;
  show(el.chat);
  el.input.focus();
});

el.acceptForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!terms) return;

  const fd = new FormData(el.acceptForm);
  const fullName = String(fd.get('fullName') ?? '').trim();
  const email = String(fd.get('email') ?? '').trim();
  const title = String(fd.get('title') ?? '').trim();
  const typedSignature = String(fd.get('typedSignature') ?? '').trim();
  const consent = el.acceptForm.querySelector('#a-consent')?.checked;

  if (!fullName || !email || !typedSignature) {
    el.acceptErr.textContent = 'Please complete every required field.';
    el.acceptErr.hidden = false;
    return;
  }
  if (!consent) {
    el.acceptErr.textContent = 'Please confirm that you accept the proposal terms.';
    el.acceptErr.hidden = false;
    return;
  }

  el.acceptSubmit.disabled = true;
  el.acceptSubmit.textContent = 'Recording acceptance…';
  try {
    await api.accept({
      fullName,
      email,
      title: title || undefined,
      // Echo the exact terms this screen displayed. The server refuses if the
      // proposal changed since it was loaded.
      documentHash: terms.documentHash,
      documentVersion: terms.documentVersion,
      typedSignature,
    });
    postToParent({ type: 'bc:accepted' });
    showDone(
      'Your acceptance has been recorded with a timestamp and shared with the seller. ' +
        'A copy will follow by email.',
    );
  } catch (err) {
    const msg =
      err instanceof ApiError
        ? err.message
        : 'We could not record your acceptance. Please try again.';
    el.acceptErr.textContent = msg;
    el.acceptErr.hidden = false;
    // A stale-terms conflict cannot be fixed by retrying the same payload.
    if (err instanceof ApiError && err.code === 'stale_terms') {
      el.acceptSubmit.textContent = 'Reload required';
      return;
    }
  } finally {
    el.acceptSubmit.disabled = false;
    if (el.acceptSubmit.textContent === 'Recording acceptance…') {
      el.acceptSubmit.textContent = 'Accept proposal';
    }
  }
});

el.doneClose.addEventListener('click', () => {
  postToParent({ type: 'bc:close' });
  show(el.chat);
});

// -------------------------------------------------------------------- chat

async function sendMessage() {
  const text = el.input.value.trim();
  if (!text || busy) return;

  busy = true;
  el.input.value = '';
  el.input.style.height = 'auto';
  el.send.disabled = true;

  addMessage('user', text);
  el.typing.hidden = false;
  el.log.scrollTop = el.log.scrollHeight;
  reportHeight();

  try {
    const res = await api.chat(text);
    el.typing.hidden = true;
    addMessage('assistant', res.reply, res.cta);
    if (res.escalate) addSystem('Your representative has been notified.');
  } catch (err) {
    el.typing.hidden = true;
    if (err instanceof ApiError) {
      addMessage('assistant', err.message);
      /**
       * ANY 401 ends the session: revoked, expired, or invalid.
       *
       * This used to test for `unauthorized` and `token_expired` by name, which
       * missed `token_revoked` — the very code the API throws when a seller
       * revokes a link that is already open. The prospect got a polite bubble and
       * a composer that still accepted text into a dead session, so a revoked
       * link looked alive. Keying on the status is the durable rule: 401 means
       * "this credential is no longer good", whatever the specific code.
       */
      if (err.status === 401) {
        fail('This session has ended. Please reopen the assistant from the proposal page.');
      }
    } else {
      addMessage('assistant', 'Something went wrong. Please try again.');
    }
  } finally {
    busy = false;
    updateSendState();
    reportHeight();
  }
}

function updateSendState() {
  el.send.disabled = busy || el.input.value.trim().length === 0;
}

el.form.addEventListener('submit', (e) => {
  e.preventDefault();
  void sendMessage();
});

el.input.addEventListener('input', () => {
  el.input.style.height = 'auto';
  el.input.style.height = `${Math.min(el.input.scrollHeight, 108)}px`;
  updateSendState();
});

el.input.addEventListener('keydown', (e) => {
  // Enter sends; Shift+Enter inserts a newline. Never send mid-IME-composition.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    void sendMessage();
  }
});

el.close.addEventListener('click', () => postToParent({ type: 'bc:close' }));
el.retry.addEventListener('click', () => {
  if (terms) show(el.chat);
  else show(el.loading);
});

// --------------------------------------------------------------- bootstrap

async function begin(token, embedOrigin) {
  if (started) {
    // Re-open of an existing session: reuse it if still valid.
    if (api.isAuthenticated && terms) {
      returnToChat();
      return;
    }
    /**
     * Already bootstrapping: do NOT start a second run.
     *
     * The widget sends bc:init on every open, including an open that happens
     * while the eager-mount bootstrap is still awaiting the API. Falling through
     * used to launch a concurrent bootstrap; whichever run finished LAST then
     * called show(el.chat), which hid the acceptance form the prospect had
     * already opened. The in-flight run owns the transition — this call just
     * waits for it.
     */
    return;
  }
  started = true;
  show(el.loading);

  try {
    const proposal = await api.bootstrap(token, embedOrigin);
    el.title.textContent = proposal.title || 'Proposal';

    terms = await api.terms();

    // Identity is server-controlled and neutral by default: the assistant speaks
    // for the seller, not for BuildClose. Order matters — bootstrap only knows the
    // proposal title, so the header is finalised once /api/terms returns.
    const identity = terms.identity || {};
    el.title.textContent = identity.displayName || 'Proposal Assistant';
    el.subtitle.textContent = identity.subtitle || 'Ask anything about this proposal';

    if (identity.accentColor) {
      document.documentElement.style.setProperty('--accent', identity.accentColor);
    }
    if (identity.showVendorBranding !== true) {
      const badge = document.getElementById('vendor-badge');
      if (badge) badge.hidden = true;
    }

    if (terms.disclosure) {
      el.disclosure.textContent =
        'This is an AI assistant. Your conversation is recorded and shared with the seller so they can help you.' +
        (terms.disclosure.retentionDays
          ? ` Conversations are kept for ${terms.disclosure.retentionDays} days.`
          : '');
    }

    show(el.chat);
    await api.event('proposal_view');

    if (el.log.childElementCount === 0) {
      const greeting =
        identity.welcomeMessage && identity.welcomeMessage.trim()
          ? identity.welcomeMessage.trim()
          : `Thanks for taking a look at the ${terms.proposal.title}. ` +
            'I can walk you through the scope, the investment, or how the checkpoints work — what would be most useful?';
      addMessage('assistant', greeting);
    }
    el.input.focus();

    // A prospect can press "Accept this proposal" on the host page before this
    // frame has finished bootstrapping. That request arrives as bc:accept while
    // `terms` is still null, so it is parked in wantAccept and must be honoured
    // HERE. Previously it was set and never read: the prospect clicked Accept
    // and landed on the chat screen instead of the acceptance form.
    if (wantAccept) {
      wantAccept = false;
      openAcceptance();
    }
  } catch (err) {
    if (err instanceof ApiError) {
      fail(err.message);
    } else {
      fail('We could not load this proposal. Please try again.');
    }
  }
}

window.addEventListener('message', (event) => {
  // Only accept messages from the origin that initialised us.
  if (parentOrigin && event.origin !== parentOrigin) return;
  const data = event.data;
  if (!data || typeof data !== 'object') return;

  if (data.type === 'bc:init' && typeof data.token === 'string') {
    parentOrigin = event.origin;
    void begin(data.token, data.embedOrigin || event.origin);
  } else if (data.type === 'bc:accept') {
    // Host page asked for acceptance. If terms are not loaded yet, remember the
    // request and honour it once begin() resolves; dropping it would leave the
    // prospect staring at a chat window after clicking "Accept".
    if (terms) openAcceptance();
    else wantAccept = true;
  } else if (data.type === 'bc:open') {
    if (terms) returnToChat();
    setTimeout(() => {
      el.input.focus();
      reportHeight();
    }, 60);
  } else if (data.type === 'bc:close') {
    /* parent handles visibility */
  }
});

// Announce readiness so the widget sends the token. Must go out on '*': the
// parent's origin is what this message is asking for.
announceReady();
reportHeight();
window.addEventListener('resize', reportHeight);
