/* ============================================================================
   BuildClose — buildclose.app
   ----------------------------------------------------------------------------
   The only script on this site. Two jobs:

     1. Mobile navigation toggle.
     2. The interactive product demonstration in the hero.

   THE DEMONSTRATION IS SCRIPTED. It makes no network request, calls no model,
   and reads nothing from any BuildClose system. Every answer is a constant in
   the table below, written against one FICTIONAL proposal:

       agency  Meridian Studio (fictional)
       client  Northwind & Co. (fictional)
       scope   Website & Brand Refresh
       value   GBP 18,500

   That is deliberate. A visitor must never mistake a canned answer for a live
   assistant, and a marketing page must never depend on a production API being
   reachable. The panel is labelled "Demo" in the chrome for the same reason.

   The answers are written to demonstrate the actual constraint the product
   enforces: when a question would require a concession, an invented fact, or a
   commercial term that is not in the approved document, the answer declines and
   hands the conversation back to a human. That refusal is the feature, so it is
   the thing the demo shows most clearly.

   No frameworks, no dependencies, no build step.
   ========================================================================= */

const $ = (sel, root = document) => root.querySelector(sel);

/* --------------------------------------------------------------- navigation */

function initNav() {
  const toggle = $('.nav-toggle');
  const nav = $('#site-nav');
  if (!toggle || !nav) return;

  const close = () => {
    nav.classList.remove('is-open');
    toggle.setAttribute('aria-expanded', 'false');
  };

  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', String(open));
  });

  // Close after choosing a destination, so the menu does not stay over the page.
  nav.addEventListener('click', (e) => {
    if (e.target.closest('a')) close();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && nav.classList.contains('is-open')) {
      close();
      toggle.focus();
    }
  });
}

/* ------------------------------------------------------------------- footer */

function initYear() {
  // Two selectors because the landing page uses an id and the secondary pages
  // use a class; a querySelectorAll covers both without duplicating the logic.
  const now = String(new Date().getFullYear());
  document.querySelectorAll('#year, .js-year').forEach((el) => {
    el.textContent = now;
  });
}

/* ================================================================ DEMO ==== */

/**
 * Scripted answers, keyed by the exact chip label.
 *
 * `escalate: true` renders the "handed to a person" footer, which is how the
 * real product behaves when a question crosses a commercial boundary.
 */
const ANSWERS = {
  'Can you do it cheaper?': {
    text:
      'I can\u2019t change the investment on this proposal, or offer a discount on it. ' +
      'The figure covers the scope as written, and commercial terms are set by the ' +
      'team rather than by me. If the budget is the obstacle, I can flag that for ' +
      'Meridian Studio and someone will pick it up directly.',
    escalate: true,
  },

  'What exactly is included?': {
    text:
      'Four workstreams: brand direction and a refreshed visual identity; ' +
      'design for the six core page templates; a build of the site with a content ' +
      'management setup your team can edit; and a handover session with written ' +
      'documentation. Copywriting and ongoing maintenance sit outside this scope.',
  },

  'How long will it take?': {
    text:
      'The proposal sets out ten weeks from kick-off, in four phases: discovery, ' +
      'identity, build, then launch. The plan assumes feedback within three working ' +
      'days at each review point \u2014 if that slips, the later dates move with it.',
  },

  'Can we pay in stages?': {
    text:
      'Yes \u2014 the proposal bills in three stages: 40% at kick-off, 30% at the ' +
      'design sign-off, and the remaining 30% on launch. Those are the terms as ' +
      'written, so I can confirm them but not restructure them.',
  },

  'Who else have you worked with?': {
    text:
      'I don\u2019t have client references in this document, and I won\u2019t invent ' +
      'any. Ask Meridian Studio directly and they can share work and put you in ' +
      'touch with the right people.',
    escalate: true,
  },
};

const TYPING_MS = 620;
const READ_MS = 90; // per word, for a readable reveal rather than an instant dump

function initDemo() {
  const log = $('#demo-log');
  const prompts = $('#demo-prompts');
  if (!log || !prompts) return;

  const chips = [...prompts.querySelectorAll('.chip')];
  let busy = false;

  /** Build the bubble. All text goes in via textContent — never innerHTML. */
  function bubble(role, text) {
    const el = document.createElement('div');
    el.className = `msg msg--${role}`;

    const body = document.createElement('span');
    body.textContent = text;
    el.appendChild(body);

    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  /**
   * The "handed to a human" footer.
   *
   * Appended only after the answer has finished revealing, so the escalation
   * reads as the conclusion of the reply rather than appearing before it.
   */
  function appendEscalation(el) {
    const meta = document.createElement('span');
    meta.className = 'msg__meta';

    const lock = document.createElement('span');
    lock.className = 'msg__lock';
    lock.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.textContent = 'Outside my authority \u2014 passed to Meridian Studio';

    meta.append(lock, label);
    el.appendChild(meta);
    log.scrollTop = log.scrollHeight;
  }

  function typing() {
    const el = document.createElement('div');
    el.className = 'msg msg--assistant';
    el.setAttribute('aria-label', 'Assistant is typing');

    const dots = document.createElement('span');
    dots.textContent = '\u00b7\u00b7\u00b7';
    el.appendChild(dots);

    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  /** Reveal word by word so the answer is read, not skimmed past. */
  function reveal(el, text, escalate, done) {
    const words = text.split(' ');
    let i = 0;

    const body = el.firstChild;
    body.textContent = '';

    const timer = setInterval(() => {
      body.textContent = words.slice(0, ++i).join(' ');
      log.scrollTop = log.scrollHeight;

      if (i >= words.length) {
        clearInterval(timer);
        if (escalate) appendEscalation(el);
        done();
      }
    }, READ_MS);
  }

  function ask(label) {
    if (busy) return;
    const answer = ANSWERS[label];
    if (!answer) return;

    busy = true;
    chips.forEach((c) => (c.disabled = true));

    // The prospect's question.
    bubble('prospect', label);

    const placeholder = typing();

    setTimeout(() => {
      placeholder.remove();
      const el = bubble('assistant', '');
      el.setAttribute('aria-busy', 'true');

      reveal(el, answer.text, !!answer.escalate, () => {
        el.removeAttribute('aria-busy');

        // Re-enable only the chips not yet used, so the visitor can explore the
        // remaining questions without the transcript repeating itself.
        const remaining = chips.filter((c) => !c.dataset.used);
        chips.forEach((c) => {
          c.disabled = c.dataset.used ? true : false;
        });

        if (remaining.length === 0) {
          const note = document.createElement('p');
          note.className = 'demo__foot';
          note.textContent =
            'That covers this demonstration. A real assistant answers anything about the proposal.';
          prompts.replaceChildren(note);
        }

        busy = false;
      });
    }, TYPING_MS);
  }

  chips.forEach((chip) => {
    chip.addEventListener('click', () => {
      const label = chip.dataset.prompt || chip.textContent.trim();
      chip.dataset.used = 'true';
      ask(label);
    });
  });
}

/* ------------------------------------------------------------------ start */

initNav();
initYear();
initDemo();
