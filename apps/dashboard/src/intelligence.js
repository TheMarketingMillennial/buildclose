/**
 * Company Intelligence Center.
 *
 * Configure the assistant ONCE per company instead of once per proposal. Before
 * this existed, every proposal carried its own copy of the firm's product facts,
 * objection playbook and voice, so a firm sending forty proposals a month
 * re-typed the same knowledge forty times.
 *
 * TWO AUDIENCES, and the difference is a security boundary, not a layout choice:
 *
 *   Knowledge (this file, all tabs except Authority) — readable by every staff
 *   role, because a rep needs the house voice and approved answers. Writable only
 *   by admins and managers.
 *
 *   Commercial authority (final tab) — rendered ONLY when the caller may
 *   configure it. The server refuses `getCompanyAuthority` to a rep outright, so
 *   a rep's browser never receives the price floor. Rendering the tab for them
 *   would produce an empty form that looks like "not configured" rather than
 *   "not permitted", which is worse than showing nothing.
 *
 * All role gating in this file is COSMETIC. Every callable re-reads the caller's
 * claims server-side; hiding a field here changes what is painted, never what is
 * permitted.
 */
import { call, ApiError, money } from './api.js';
import {
  h,
  clear,
  pageHead,
  card,
  field,
  input,
  textarea,
  button,
  emptyState,
  spinner,
  lineList,
  lines,
  toast,
} from './ui.js';

// ------------------------------------------------------------------ helpers

/** Minor units → a plain decimal string for editing. */
function toDollars(minor) {
  const n = Number(minor ?? 0);
  return Number.isFinite(n) ? (n / 100).toFixed(2) : '0.00';
}

/**
 * Decimal dollars → integer minor units, never negative.
 *
 * Rounds rather than truncates: 18.999 must not become 18999 (a silent one-cent
 * understatement of a contractual figure). Non-numeric input becomes 0, which is
 * the safe direction for a floor.
 */
function toMinor(value) {
  const cleaned = String(value ?? '').replace(/[^0-9.]/g, '');
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
}

/** `a | b | c` lines → arrays of trimmed cells, skipping blank lines. */
function pipeRows(text) {
  return lineList(text).map((line) => line.split('|').map((s) => s.trim()));
}

/**
 * Writing samples are prose, so a line-per-sample rule would mangle them. A line
 * of only `---` separates samples instead.
 */
function splitSamples(text) {
  return String(text || '')
    .split(/^\s*---\s*$/m)
    .map((s) => s.trim())
    .filter(Boolean);
}

function joinSamples(samples) {
  return Array.isArray(samples) ? samples.join('\n\n---\n\n') : '';
}

/** A form row that saves exactly one section. */
function sectionForm(onSubmit) {
  const errorSlot = h('div');
  const btn = button('Save', null, { type: 'submit' });
  const original = btn.textContent;
  const form = h('form', { novalidate: true });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clear(errorSlot);
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      await onSubmit();
      toast('Saved.', 'ok');
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not save.';
      errorSlot.appendChild(h('p', { class: 'form-error', text: msg }));
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  form.appendChild(errorSlot);
  form.appendChild(h('div', { class: 'row' }, btn));
  return form;
}

// --------------------------------------------------------------------- view

export async function viewIntelligence(view, { role }) {
  clear(view);
  view.appendChild(pageHead('Intelligence Center', 'Configure your sales knowledge once and every proposal inherits it.'));

  const loading = spinner('Loading company intelligence…');
  view.appendChild(loading);

  const canConfigure = role === 'platform_admin' || role === 'company_admin' || role === 'sales_manager';

  let data;
  let authorityData = null;
  try {
    data = await call('getCompanyIntelligence');
    if (canConfigure) {
      // Fetch authority only when the server will allow it. A rep calling this
      // would receive permission-denied, and swallowing that to show an empty
      // form would misrepresent "forbidden" as "unconfigured".
      authorityData = await call('getCompanyAuthority');
    }
  } catch (err) {
    clear(view);
    view.appendChild(pageHead('Intelligence Center', 'Configure your sales knowledge once.'));
    view.appendChild(
      card(null, emptyState(err instanceof ApiError ? err.message : 'Could not load company intelligence.')),
    );
    return;
  }

  clear(view);
  view.appendChild(pageHead('Intelligence Center', 'Configure your sales knowledge once and every proposal inherits it.'));

  const intel = data?.intelligence ?? {};
  const canEdit = data?.canEdit === true && canConfigure;

  if (!canEdit) {
    view.appendChild(
      card(
        null,
        h(
          'p',
          { class: 'muted' },
          'You can read this configuration, but only admins and sales managers can change it. ' +
            'Ask a manager if something here is wrong.',
        ),
      ),
    );
  }
  if (!data?.configured && canEdit) {
    view.appendChild(
      card(
        null,
        h(
          'p',
          { class: 'muted' },
          'Nothing is configured yet. Everything below is optional, but the assistant can only answer ' +
            'from what you put here — an empty playbook means it will escalate almost every objection.',
        ),
      ),
    );
  }

  // ------------------------------------------------------------------ tabs
  const panel = h('div', { id: 'intel-panel' });
  const tabs = h('div', { class: 'tabs', role: 'tablist' });

  const builders = [
    { key: 'profile', label: 'Company profile', build: profileTab },
    { key: 'products', label: 'Products & services', build: productsTab },
    { key: 'methodology', label: 'Sales methodology', build: methodologyTab },
    { key: 'voice', label: 'Brand voice', build: voiceTab },
    { key: 'objections', label: 'Objection playbook', build: objectionsTab },
    { key: 'faqs', label: 'FAQs', build: faqsTab },
    { key: 'policies', label: 'Commercial policies', build: policiesTab },
    { key: 'assistant', label: 'Assistant defaults', build: assistantTab },
  ];
  if (canConfigure) {
    builders.push({ key: 'authority', label: 'Commercial authority', build: authorityTab });
  }

  function select(key) {
    for (const b of tabs.children) {
      b.classList.toggle('active', b.dataset.key === key);
      b.setAttribute('aria-selected', b.dataset.key === key ? 'true' : 'false');
    }
    clear(panel);
    const builder = builders.find((b) => b.key === key);
    if (builder) builder.build(panel);
    // Read-only callers see the real values but cannot edit them. Disabling the
    // controls makes that visible rather than letting a manager's edit silently
    // fail on save.
    if (!canEdit) {
      for (const el of panel.querySelectorAll('input, textarea, select, button')) el.disabled = true;
    }
  }

  for (const b of builders) {
    tabs.appendChild(
      h('button', {
        class: 'tab',
        type: 'button',
        role: 'tab',
        dataset: { key: b.key },
        text: b.label,
        onclick: () => select(b.key),
      }),
    );
  }

  view.appendChild(tabs);
  view.appendChild(panel);
  select('profile');

  // -------------------------------------------------------------- profile
  function profileTab(host) {
    const p = intel.profile ?? {};
    const legalName = input({ value: p.legalName ?? '', placeholder: 'Meridian Studio Ltd' });
    const displayName = input({ value: p.displayName ?? '', placeholder: 'Meridian Studio' });
    const website = input({ value: p.website ?? '', placeholder: 'meridian-studio.example' });
    const teamSize = input({ value: p.teamSize ?? '', placeholder: '35 people' });
    const founded = input({ type: 'number', value: p.foundedYear ?? '', placeholder: '2014' });
    const description = textarea({ rows: 5, value: p.description ?? '' });
    const locations = textarea({ rows: 3, value: lines(p.locations) });
    const differentiators = textarea({ rows: 5, value: lines(p.differentiators) });

    const form = sectionForm(async () => {
      const year = Number(founded.value);
      await call('updateCompanyIntelligence', {
        profile: {
          legalName: legalName.value.trim(),
          displayName: displayName.value.trim(),
          website: website.value.trim(),
          description: description.value.trim(),
          foundedYear: Number.isFinite(year) && year > 1800 ? Math.round(year) : null,
          locations: lineList(locations.value),
          teamSize: teamSize.value.trim(),
          differentiators: lineList(differentiators.value),
        },
      });
    });

    form.prepend(
      card(
        'Who you are',
        h('p', { class: 'muted small', text: 'Used by the assistant to describe your firm accurately. Anything you leave blank it will not claim.' }),
        h('div', { class: 'field-row' }, field('Legal name', legalName), field('Trading name', displayName)),
        h('div', { class: 'field-row' }, field('Website', website), field('Team size', teamSize)),
        h('div', { class: 'field-row' }, field('Founded', founded), field('Locations', locations, 'One per line.')),
        field('What you do', description, 'In your own words. This is quoted as context, so keep it factual.'),
        field('Why clients choose you', differentiators, 'One per line. Only claims you can stand behind — the assistant may repeat these verbatim.'),
      ),
    );
    host.appendChild(form);
  }

  // ------------------------------------------------------------- products
  function productsTab(host) {
    const rows = Array.isArray(intel.productsServices) ? intel.productsServices : [];
    const ta = textarea({
      rows: Math.max(6, rows.length * 2 + 3),
      value: rows
        .map((r) =>
          [r.name, r.category, r.description, r.typicalTimeline, (r.deliverables ?? []).join('; ')].join(' | '),
        )
        .join('\n'),
    });

    const form = sectionForm(async () => {
      const products = pipeRows(ta.value)
        .filter((cells) => cells[0])
        .map(([name, category, description, timeline, deliverables]) => ({
          name: name ?? '',
          category: category ?? '',
          description: description ?? '',
          typicalTimeline: timeline ?? '',
          deliverables: (deliverables ?? '')
            .split(';')
            .map((s) => s.trim())
            .filter(Boolean),
        }));
      await call('updateCompanyIntelligence', { productsServices: products });
    });

    form.prepend(
      card(
        'Products and services',
        h('p', {
          class: 'muted small',
          text: 'One product per line: name | category | description | typical timeline | deliverables (semicolon-separated).',
        }),
        field('Catalogue', ta, 'These become facts the assistant may state. A product with no description is a name it cannot explain.'),
      ),
    );
    host.appendChild(form);
  }

  // ---------------------------------------------------------- methodology
  function methodologyTab(host) {
    const m = intel.salesMethodology ?? {};
    const name = input({ value: m.name ?? '', placeholder: 'Consultative discovery' });
    const stages = textarea({ rows: 5, value: lines(m.stages) });
    const questions = textarea({ rows: 6, value: lines(m.discoveryQuestions) });
    const criteria = textarea({ rows: 5, value: lines(m.qualificationCriteria) });
    const cadence = input({ value: m.followUpCadence ?? '', placeholder: 'Day 2, day 5, day 12' });
    const closing = textarea({ rows: 4, value: m.closingApproach ?? '' });
    const philosophy = textarea({ rows: 4, value: m.objectionPhilosophy ?? '' });

    const form = sectionForm(async () => {
      await call('updateCompanyIntelligence', {
        salesMethodology: {
          name: name.value.trim(),
          stages: lineList(stages.value),
          discoveryQuestions: lineList(questions.value),
          qualificationCriteria: lineList(criteria.value),
          closingApproach: closing.value.trim(),
          followUpCadence: cadence.value.trim(),
          objectionPhilosophy: philosophy.value.trim(),
        },
      });
    });

    form.prepend(
      card(
        'How you sell',
        h('p', { class: 'muted small', text: 'Guidance, not automation. The assistant does not run your process for you, but it should not contradict it either.' }),
        field('Methodology name', name),
        field('Stages', stages, 'One per line, in order.'),
        field('Discovery questions', questions, 'One per line.'),
        field('Qualification criteria', criteria, 'One per line. What makes a good-fit deal.'),
        field('Follow-up cadence', cadence),
        field('Closing approach', closing),
        field('How you handle objections', philosophy, 'Framing the assistant should adopt when a prospect pushes back.'),
      ),
    );
    host.appendChild(form);
  }

  // ----------------------------------------------------------- brand voice
  function voiceTab(host) {
    const v = intel.brandVoice ?? {};
    const toneEl = h(
      'select',
      {},
      ...['consultative', 'direct', 'warm', 'formal'].map((t) =>
        h('option', { value: t, text: t, selected: (v.tone ?? 'consultative') === t ? true : null }),
      ),
    );
    const styleNotes = textarea({ rows: 4, value: v.styleNotes ?? '' });
    const preferred = textarea({ rows: 3, value: lines(v.preferredTerms) });
    const banned = textarea({ rows: 3, value: lines(v.bannedTerms) });
    const samples = textarea({ rows: 8, value: joinSamples(v.writingSamples) });

    const form = sectionForm(async () => {
      await call('updateCompanyIntelligence', {
        brandVoice: {
          tone: toneEl.value,
          styleNotes: styleNotes.value.trim(),
          preferredTerms: lineList(preferred.value),
          bannedTerms: lineList(banned.value),
          writingSamples: splitSamples(samples.value),
        },
      });
    });

    form.prepend(
      card(
        'How you sound',
        h('div', { class: 'field-row' }, field('Tone', toneEl), field('Preferred terms', preferred, 'One per line.')),
        field('Style notes', styleNotes, 'e.g. plain English, no jargon, short sentences.'),
        field('Words to avoid', banned, 'One per line. Advisory for tone — this is not a safety control.'),
        field(
          'Writing samples',
          samples,
          'Paste excerpts of your own writing. Separate each sample with a line containing only ---',
        ),
        h('p', {
          class: 'muted small',
          text: 'Banned words shape tone only. What the assistant may never claim is set under Assistant defaults → prohibited claims.',
        }),
      ),
    );
    host.appendChild(form);
  }

  // ------------------------------------------------------------ objections
  function objectionsTab(host) {
    const rows = Array.isArray(intel.objectionPlaybook) ? intel.objectionPlaybook : [];
    const ta = textarea({
      rows: Math.max(6, rows.length * 2 + 3),
      value: rows.map((o) => [o.type, o.trigger, o.response, o.escalate === false ? 'no' : 'yes'].join(' | ')).join('\n'),
    });

    const form = sectionForm(async () => {
      const playbook = pipeRows(ta.value)
        .filter((cells) => cells[0])
        .map(([type, trigger, response, escalate]) => ({
          type: type ?? '',
          trigger: trigger ?? '',
          response: response ?? '',
          // Anything other than an explicit "no" escalates. Defaulting the other
          // way would let a typo turn an unapproved answer into an automatic one.
          escalate: String(escalate ?? '').toLowerCase() !== 'no',
        }));
      await call('updateCompanyIntelligence', { objectionPlaybook: playbook });
    });

    form.prepend(
      card(
        'Objection playbook',
        h('p', {
          class: 'muted small',
          text: 'One per line: type | when the prospect says | your approved response | yes/no to escalate.',
        }),
        field(
          'Entries',
          ta,
          'Leave the last column as "yes" unless you have an approved answer. An escalated objection is handed to a human instead of improvised.',
        ),
      ),
    );
    host.appendChild(form);
  }

  // ------------------------------------------------------------------ faqs
  function faqsTab(host) {
    const rows = Array.isArray(intel.faqs) ? intel.faqs : [];
    const ta = textarea({
      rows: Math.max(6, rows.length * 2 + 3),
      value: rows.map((f) => [f.question, f.answer, f.category].join(' | ')).join('\n'),
    });

    const form = sectionForm(async () => {
      const faqs = pipeRows(ta.value)
        .filter((cells) => cells[0])
        .map(([question, answer, category]) => ({
          question: question ?? '',
          answer: answer ?? '',
          category: category ?? '',
        }));
      await call('updateCompanyIntelligence', { faqs });
    });

    form.prepend(
      card(
        'Frequently asked questions',
        h('p', { class: 'muted small', text: 'One per line: question | answer | category.' }),
        field(
          'Questions and answers',
          ta,
          'These are the assistant’s preferred answers. Keep them factual — anything that reads as a promise becomes one.',
        ),
      ),
    );
    host.appendChild(form);
  }

  // -------------------------------------------------------------- policies
  function policiesTab(host) {
    const pol = intel.commercialPolicies ?? {};
    const rows = Array.isArray(pol.statements) ? pol.statements : [];
    const ta = textarea({
      rows: Math.max(6, rows.length * 2 + 3),
      value: rows.map((s) => [s.topic, s.statement].join(' | ')).join('\n'),
    });
    const notes = textarea({ rows: 4, value: pol.notes ?? '' });

    const form = sectionForm(async () => {
      const statements = pipeRows(ta.value)
        .filter((cells) => cells[0])
        .map(([topic, statement]) => ({ topic: topic ?? '', statement: statement ?? '' }));
      await call('updateCompanyIntelligence', { commercialPolicies: { statements, notes: notes.value.trim() } });
    });

    form.prepend(
      card(
        'Commercial policies',
        h('p', { class: 'muted small', text: 'One per line: topic | statement. e.g. Invoicing | Invoices are issued on commencement.' }),
        field('Statements', ta),
        field('Notes', notes),
        // The single most important thing to say on this screen: this text
        // describes policy, it does not authorise a concession.
        h(
          'div',
          { class: 'warn-box' },
          h('strong', { text: 'These statements explain policy — they do not grant discounts. ' }),
          'Anything that authorises a concession belongs under Commercial authority, where it is enforced as a',
          ' structured limit. A discount described only in this free text will not be offered by the assistant.',
        ),
      ),
    );
    host.appendChild(form);
  }

  // ------------------------------------------------------------- assistant
  function assistantTab(host) {
    const a = intel.assistantDefaults ?? {};
    const displayName = input({ value: a.displayName ?? 'Proposal Assistant' });
    const subtitle = input({ value: a.subtitle ?? '' });
    const welcome = textarea({ rows: 3, value: a.welcomeMessage ?? '' });
    const accent = input({ type: 'color', value: a.accentColor ?? '#1b3a6b', style: 'width:56px;height:34px;padding:2px' });
    const accentHex = input({ value: a.accentColor ?? '#1b3a6b', style: 'width:96px' });
    const persona = textarea({ rows: 2, value: a.persona ?? '' });
    const escalation = textarea({ rows: 2, value: a.escalationMessage ?? '' });
    const closing = textarea({ rows: 2, value: a.closingObjective ?? '' });
    const toneEl = h(
      'select',
      {},
      ...['consultative', 'direct', 'warm', 'formal'].map((t) =>
        h('option', { value: t, text: t, selected: (a.tone ?? 'consultative') === t ? true : null }),
      ),
    );
    const branding = h('input', { type: 'checkbox' });
    branding.checked = a.showVendorBranding === true;

    accent.addEventListener('input', () => {
      accentHex.value = accent.value;
    });
    accentHex.addEventListener('input', () => {
      if (/^#[0-9a-fA-F]{6}$/.test(accentHex.value)) accent.value = accentHex.value;
    });

    const form = sectionForm(async () => {
      await call('updateCompanyIntelligence', {
        assistantDefaults: {
          displayName: displayName.value.trim() || 'Proposal Assistant',
          subtitle: subtitle.value.trim(),
          welcomeMessage: welcome.value.trim(),
          accentColor: accentHex.value.trim(),
          showVendorBranding: branding.checked,
          persona: persona.value.trim(),
          tone: toneEl.value,
          escalationMessage: escalation.value.trim(),
          closingObjective: closing.value.trim(),
        },
      });
    });

    form.prepend(
      card(
        'Defaults for every new proposal',
        h('p', {
          class: 'muted small',
          text: 'Copied into a proposal when it is created, then editable per proposal. Changing these does not alter proposals that already exist.',
        }),
        h('div', { class: 'field-row' }, field('Display name', displayName), field('Subtitle', subtitle)),
        field('Welcome message', welcome),
        h('div', { class: 'field-row' }, field('Accent colour', h('div', { class: 'row' }, accent, accentHex)), field('Tone', toneEl)),
        field('Persona', persona),
        field('Escalation message', escalation, 'Shown when the assistant is unsure or the question is out of scope.'),
        field('Closing objective', closing, 'What the assistant is trying to achieve, as guidance.'),
        field(
          'Vendor branding',
          h('label', { class: 'check' }, branding, h('span', { text: 'Show a small "Assistant by BuildClose" badge. Off by default.' })),
        ),
      ),
    );
    host.appendChild(form);
  }

  // -------------------------------------------------------------- authority
  function authorityTab(host) {
    const a = authorityData?.authority ?? null;

    host.appendChild(
      card(
        'Commercial authority',
        h('p', { class: 'muted small' },
          'These limits are enforced server-side on every message. They are what stops the assistant conceding ' +
            'something you did not authorise — a proposal can be stricter than these values but never looser.'),
        !authorityData?.configured
          ? h('div', { class: 'warn-box' },
              h('strong', { text: 'Not configured. ' }),
              'Until you save this, the assistant behaves as before: each proposal carries its own limits and ' +
                'no company-wide ceiling applies.')
          : null,
      ),
    );

    const floor = input({ value: toDollars(a?.priceFloorMinor ?? 0), placeholder: '15000.00' });
    const ceiling = input({ type: 'number', value: a?.maxDiscountPercent ?? 0, min: '0', max: '100' });
    const terms = input({ value: a?.paymentTerms ?? '', placeholder: 'Net 14 from commencement' });
    const schedule = textarea({
      rows: Math.max(3, (a?.paymentSchedule?.length ?? 0) + 1),
      value: (a?.paymentSchedule ?? []).map((s) => `${s.label} | ${s.percent}`).join('\n'),
    });
    const approved = textarea({
      rows: Math.max(3, (a?.approvedDiscounts?.length ?? 0) + 1),
      value: (a?.approvedDiscounts ?? []).map((d) => `${d.label} | ${toDollars(d.amountMinor)} | ${d.conditions ?? ''}`).join('\n'),
    });
    const quotable = textarea({
      rows: Math.max(3, (a?.quotableAmountsMinor?.length ?? 0) + 1),
      value: (a?.quotableAmountsMinor ?? []).map((n) => toDollars(n)).join('\n'),
    });
    const boundaries = textarea({ rows: 4, value: lines(a?.negotiationBoundaries) });
    const notes = textarea({ rows: 4, value: a?.internalNotes ?? '' });

    const perms = a?.negotiationPermissions ?? {
      canOfferDiscounts: false,
      canAdjustTimeline: false,
      canWaiveFees: false,
      requiresApprovalAbovePercent: 0,
    };
    const cbDiscounts = h('input', { type: 'checkbox' });
    cbDiscounts.checked = perms.canOfferDiscounts === true;
    const cbTimeline = h('input', { type: 'checkbox' });
    cbTimeline.checked = perms.canAdjustTimeline === true;
    const cbWaive = h('input', { type: 'checkbox' });
    cbWaive.checked = perms.canWaiveFees === true;
    const approvalAbove = input({ type: 'number', value: perms.requiresApprovalAbovePercent ?? 0, min: '0', max: '100' });

    const check = (el, text) => h('label', { class: 'check' }, el, h('span', { text }));

    const form = sectionForm(async () => {
      const scheduleRows = pipeRows(schedule.value)
        .filter((cells) => cells[0])
        .map(([label, percent]) => ({ label: label ?? '', percent: Math.round(Number(percent ?? 0)) || 0 }));

      // Sum is checked client-side purely to save a round trip. The server
      // re-validates and is the authority on whether this is acceptable.
      const sum = scheduleRows.reduce((s, r) => s + r.percent, 0);
      if (scheduleRows.length > 0 && sum !== 100) {
        throw new ApiError('invalid-argument', `Payment schedule must total exactly 100% (currently ${sum}%).`, 400);
      }

      await call('updateCompanyAuthority', {
        authority: {
          priceFloorMinor: toMinor(floor.value),
          maxDiscountPercent: Math.min(100, Math.max(0, Number(ceiling.value) || 0)),
          paymentTerms: terms.value.trim(),
          paymentSchedule: scheduleRows,
          negotiationPermissions: {
            canOfferDiscounts: cbDiscounts.checked,
            canAdjustTimeline: cbTimeline.checked,
            canWaiveFees: cbWaive.checked,
            requiresApprovalAbovePercent: Math.min(100, Math.max(0, Number(approvalAbove.value) || 0)),
          },
          approvedDiscounts: pipeRows(approved.value)
            .filter((cells) => cells[0])
            .map(([label, amount, conditions]) => ({
              label: label ?? '',
              amountMinor: toMinor(amount),
              conditions: conditions ?? '',
            })),
          quotableAmountsMinor: lineList(quotable.value).map((v) => toMinor(v)).filter((n) => n > 0),
          negotiationBoundaries: lineList(boundaries.value),
          internalNotes: notes.value.trim(),
        },
      });
    });

    form.prepend(
      card(
        'Limits the assistant cannot cross',
        field('Price floor', floor, 'The lowest total you will accept. Never disclosed to a prospect — the assistant only knows it may not go below it.'),
        field('Maximum discount', ceiling, 'Ceiling on any concession, as a percentage. 0 means no discount is authorised at all.'),
        field('Payment terms', terms),
        field('Payment schedule', schedule, 'One per line: label | percent. Must total 100%.'),
      ),
      card(
        'Permissions',
        check(cbDiscounts, 'May offer discounts, within the ceiling above.'),
        check(cbTimeline, 'May adjust the delivery timeline.'),
        check(cbWaive, 'May waive fees.'),
        field('Always escalate above', approvalAbove, 'Percentage above which a human must approve, regardless of the ceiling.'),
      ),
      card(
        'Pre-approved concessions',
        h('p', { class: 'muted small', text: 'One per line: label | amount | conditions. These are the only concessions the assistant may actually offer.' }),
        approved,
        h('p', { class: 'muted small', text: 'Quotable amounts — published rates the assistant may state. A quotable amount is not an offer.' }),
        quotable,
      ),
      card(
        'Negotiation boundaries',
        h('p', { class: 'muted small', text: 'One per line. Hard rules the assistant must never cross.' }),
        boundaries,
        field('Internal notes', notes, 'Staff-only context. Never shown to a prospect.'),
      ),
    );
    host.appendChild(form);
  }
}
