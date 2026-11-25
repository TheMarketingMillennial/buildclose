/*!
 * BuildClose embeddable widget
 * Build the proposal. Close the deal.
 *
 * Usage (paste where you want the launcher to appear):
 *   <script src="https://agent.buildclose.app/widget.js"
 *           data-bc="bc_pk_…"        // prospect access token for this proposal
 *           data-label="Questions about this proposal?"
 *           defer></script>
 *
 * Design notes:
 *  - The token NEVER enters a URL. It is handed to the iframe with postMessage
 *    after an origin handshake, so it cannot leak via Referer headers, browser
 *    history, or server access logs.
 *  - The chat runs on agent.buildclose.app, isolated from both the customer page
 *    it is embedded in and the admin dashboard (app.buildclose.app). This page
 *    cannot read the conversation.
 *  - No dependencies, no build step, ~5 KB.
 */
(function () {
  'use strict';

  var script = document.currentScript;
  if (!script) return;

  var token = script.getAttribute('data-bc') || '';
  if (!token) {
    console.warn('[BuildClose] missing data-bc attribute; widget not started');
    return;
  }

  // Where the chat app lives. Overridable for staging or self-hosting.
  var CHAT_ORIGIN = (script.getAttribute('data-chat-origin') || 'https://agent.buildclose.app').replace(/\/+$/, '');

  var LABEL = script.getAttribute('data-label') || 'Questions about this proposal?';
  var ACCENT = script.getAttribute('data-accent') || '#1B3A6B';
  var POSITION = script.getAttribute('data-position') === 'left' ? 'left' : 'right';
  // Eager by default: mounting the frame on load is what registers a proposal
  // view for a prospect who reads the page but never opens the chat. Set
  // data-lazy="true" to defer the iframe until the launcher is clicked.
  var LAZY = script.getAttribute('data-lazy') === 'true';

  // Guard against double-injection when a CMS repeats the snippet.
  if (window.__buildCloseWidgetLoaded) return;
  window.__buildCloseWidgetLoaded = true;

  var open = false;
  var ready = false;
  var frame = null;
  var pendingAccept = false;

  // ---------------------------------------------------------------- styles
  var css = [
    '.bcw-root{position:fixed;bottom:20px;z-index:2147483000;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif}',
    '.bcw-root.bcw-right{right:20px}',
    '.bcw-root.bcw-left{left:20px}',
    '.bcw-panel{position:fixed;bottom:88px;width:400px;height:min(620px,calc(100vh - 120px));max-width:calc(100vw - 32px);',
    'background:#fff;border-radius:14px;box-shadow:0 24px 64px -12px rgba(16,24,40,.28),0 0 0 1px rgba(16,24,40,.08);',
    'overflow:hidden;display:none;opacity:0;transform:translateY(8px);transition:opacity .18s ease,transform .18s ease}',
    '.bcw-root.bcw-right .bcw-panel{right:20px}',
    '.bcw-root.bcw-left .bcw-panel{left:20px}',
    '.bcw-panel.bcw-open{display:block}',
    '.bcw-panel.bcw-visible{opacity:1;transform:translateY(0)}',
    '.bcw-frame{width:100%;height:100%;border:0;display:block;background:#fff}',
    '.bcw-btn{display:flex;align-items:center;gap:9px;border:0;cursor:pointer;padding:13px 18px;border-radius:999px;',
    'font-size:14px;font-weight:600;color:#fff;box-shadow:0 8px 24px -6px rgba(16,24,40,.32);transition:transform .15s ease,box-shadow .15s ease}',
    '.bcw-btn:hover{transform:translateY(-1px);box-shadow:0 12px 28px -8px rgba(16,24,40,.4)}',
    '.bcw-btn:focus-visible{outline:2px solid #fff;outline-offset:2px;box-shadow:0 0 0 4px rgba(27,58,107,.45)}',
    '.bcw-btn svg{display:block;flex:none}',
    '.bcw-hide{display:none!important}',
    '@media(max-width:480px){.bcw-panel{width:calc(100vw - 24px);height:calc(100vh - 110px);bottom:80px}',
    '.bcw-root.bcw-right .bcw-panel{right:12px}.bcw-root.bcw-left .bcw-panel{left:12px}.bcw-root.bcw-right{right:12px}.bcw-root.bcw-left{left:12px}}',
    '@media(prefers-reduced-motion:reduce){.bcw-panel,.bcw-btn{transition:none}}',
  ].join('');

  var styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ------------------------------------------------------------------- DOM
  var root = document.createElement('div');
  root.className = 'bcw-root bcw-' + POSITION;

  var panel = document.createElement('div');
  panel.className = 'bcw-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Proposal assistant');
  panel.setAttribute('aria-modal', 'false');

  var button = document.createElement('button');
  button.type = 'button';
  button.className = 'bcw-btn';
  button.style.background = ACCENT;
  button.setAttribute('aria-expanded', 'false');
  button.innerHTML =
    '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-3.9-.9L3 21l1.9-4.6A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4Z" ' +
    'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
    '<span>' + LABEL.replace(/[<>&]/g, '') + '</span>';

  root.appendChild(panel);
  root.appendChild(button);
  document.body.appendChild(root);

  // --------------------------------------------------------------- iframe
  function mountFrame() {
    if (frame) return;
    frame = document.createElement('iframe');
    frame.className = 'bcw-frame';
    frame.title = 'Proposal assistant';
    /**
     * Sandbox: allow-same-origin IS required, and omitting it was a real bug.
     *
     * Without it the frame gets an OPAQUE origin, so `self.origin` is "null".
     * Two things then break, both fatal:
     *   1. the frame's own module script (/embed/app.js) is fetched as a
     *      cross-origin request from "null" and blocked by the host's CORS policy;
     *   2. every API call would carry `Origin: null`, which the backend allowlist
     *      correctly rejects.
     * The result was a widget that mounted and then sat on "Connecting…" forever.
     *
     * allow-same-origin is only dangerous when the framed document is
     * SAME-ORIGIN with the embedder — then the frame could reach into the parent
     * and strip its own sandbox. This frame is always CROSS-ORIGIN (the chat app
     * lives on its own hostnames by design, requirement 3), so allow-same-origin
     * gives it its own origin and nothing more: it cannot touch this page's DOM,
     * cannot read this page's storage, and cannot read cookies for this site.
     *
     * Do NOT "fix" this by making the backend accept Origin: null — that would
     * let any sandboxed frame anywhere in the world call the API.
     */
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox');
    frame.setAttribute('allow', 'clipboard-write');
    frame.src = CHAT_ORIGIN + '/embed';
    panel.appendChild(frame);
  }

  /**
   * Handshake. The chat app announces readiness; only then do we send the token,
   * and only to our own configured origin. event.origin is verified on every
   * inbound message so a hostile frame cannot impersonate the chat app.
   */
  function onMessage(event) {
    if (event.origin !== CHAT_ORIGIN) return;
    var data = event.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === 'bc:ready') {
      ready = true;
      send({ type: 'bc:init', token: token, embedOrigin: window.location.origin });
      if (pendingAccept) {
        // The host page asked for acceptance before the frame finished loading.
        pendingAccept = false;
        send({ type: 'bc:accept' });
      }
    } else if (data.type === 'bc:resize' && typeof data.height === 'number') {
      // Height is clamped so a compromised frame cannot cover the page.
      var h = Math.max(320, Math.min(Number(data.height) || 0, Math.round(window.innerHeight * 0.85)));
      panel.style.height = h + 'px';
    } else if (data.type === 'bc:close') {
      setOpen(false);
    } else if (data.type === 'bc:accepted') {
      button.querySelector('span').textContent = 'Proposal accepted';
    }
  }

  function send(payload) {
    if (!frame || !frame.contentWindow) return;
    frame.contentWindow.postMessage(payload, CHAT_ORIGIN);
  }

  window.addEventListener('message', onMessage);

  // Mount now unless the host opted into lazy loading. Without this the page
  // records nothing for a prospect who reads without opening the assistant.
  if (!LAZY) mountFrame();

  // ------------------------------------------------------------- open/close
  function setOpen(next) {
    if (next === open) return;
    open = next;
    button.setAttribute('aria-expanded', open ? 'true' : 'false');

    if (open) {
      mountFrame();
      panel.classList.add('bcw-open');
      // Next frame so the transition actually runs.
      requestAnimationFrame(function () {
        panel.classList.add('bcw-visible');
      });
      button.classList.add('bcw-hide');
      // If the frame was already ready (reopen), re-send the handshake.
      if (ready) send({ type: 'bc:init', token: token, embedOrigin: window.location.origin });
      send({ type: 'bc:open' });
    } else {
      panel.classList.remove('bcw-visible');
      button.classList.remove('bcw-hide');
      setTimeout(function () {
        if (!open) panel.classList.remove('bcw-open');
      }, 180);
      send({ type: 'bc:close' });
    }
  }

  button.addEventListener('click', function () {
    setOpen(true);
  });

  // Escape closes, but only when focus is inside the widget.
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && open && panel.contains(document.activeElement)) {
      setOpen(false);
      button.focus();
    }
  });

  // Public hook: allow the host page to open the assistant programmatically,
  // e.g. from a "Ask a question" link.
  window.BuildClose = {
    open: function () {
      setOpen(true);
    },
    close: function () {
      setOpen(false);
    },
    /**
     * Open the assistant directly on the native acceptance screen. Lets a
     * proposal page offer "Accept this proposal" as a first-class action while
     * keeping ONE acceptance implementation inside the frame, where the session
     * token already lives. Reusing it means the acceptance record, the document
     * hash check and the stale-terms handling are the same code path the chat
     * CTA exercises.
     */
    openAcceptance: function () {
      setOpen(true);
      if (ready) send({ type: 'bc:accept' });
      else pendingAccept = true;
    },
  };
})();
