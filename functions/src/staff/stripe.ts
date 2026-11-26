/**
 * Stripe subscription billing (test mode during development).
 *
 * Two paths:
 *   - `createCheckoutSession` (callable, staff): starts a subscription.
 *   - `stripeWebhook` (HTTP): the only source of truth for subscription state.
 *
 * Webhook verification uses the raw body and the signing secret. Because the
 * Express app applies `express.json()` globally, the webhook is mounted BEFORE
 * that middleware in index.ts — otherwise the raw bytes needed for signature
 * verification would already be parsed and verification would always fail.
 */
import { onRequest } from 'firebase-functions/v2/https';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import type { Request, Response } from 'express';
import Stripe from 'stripe';
import { z } from 'zod';
import { db, COLLECTIONS, FieldValue } from '../lib/firebase.js';
import { getConfig } from '../lib/config.js';
import { requireStaff, requireRole } from './auth.js';
import { audit } from '../lib/audit.js';
import { sellablePlan } from '../lib/entitlements.js';
import { loadPlans } from '../lib/entitlementStore.js';

const REGION = 'us-central1';

function stripeClient(): Stripe {
  const cfg = getConfig();
  if (!cfg.stripeKey) throw new HttpsError('failed-precondition', 'Stripe is not configured');
  if (!cfg.stripeKey.startsWith('sk_test_') && process.env.NODE_ENV !== 'production') {
    console.warn('[stripe] live key detected outside production — check configuration');
  }
  return new Stripe(cfg.stripeKey, { apiVersion: '2024-12-18.acacia' as never });
}

/** Start a subscription checkout for the caller's company. */
export const createCheckoutSession = onCall(
  { region: REGION, secrets: ['STRIPE_SECRET_KEY'] },
  async (request) => {
  const identity = requireStaff(request);
  requireRole(identity, ['company_admin']);

  /**
   * The caller identifies a PLAN, not a price.
   *
   * Accepting a raw `priceId` from the browser would let a company admin post any
   * Stripe price id they can guess — including an internal or grandfathered price
   * belonging to another tier. Resolving the price server-side from a plan in our
   * own catalogue means the only purchasable prices are the ones an operator
   * attached to a sellable plan.
   */
  const parsed = z
    .object({
      planId: z.string().min(1).max(60),
      /** Monthly vs annual, chosen among the plan's prices; defaults to the first. */
      interval: z.enum(['month', 'year']).optional(),
    })
    .safeParse(request.data);
  if (!parsed.success) throw new HttpsError('invalid-argument', 'Missing plan id');

  const plans = await loadPlans();
  const plan = sellablePlan(plans, parsed.data.planId);
  if (!plan) {
    throw new HttpsError('failed-precondition', 'That plan is not available for purchase');
  }
  if (plan.stripePriceIds.length === 0) {
    throw new HttpsError('failed-precondition', 'That plan has no price configured');
  }

  const stripe = stripeClient();

  /**
   * Pick the price for the requested billing interval.
   *
   * The plan stores only price IDS, never amounts, so the interval is resolved by
   * asking Stripe to expand each candidate price and reading its `recurring`
   * interval. If Stripe cannot be reached the first price is used, because a
   * working checkout on the default interval beats a hard failure.
   */
  let priceId = plan.stripePriceIds[0]!;
  if (parsed.data.interval && plan.stripePriceIds.length > 1) {
    for (const candidate of plan.stripePriceIds) {
      try {
        const price = await stripe.prices.retrieve(candidate);
        if (price.recurring?.interval === parsed.data.interval) {
          priceId = candidate;
          break;
        }
      } catch {
        // Ignore an unresolvable candidate and keep looking.
      }
    }
  }

  const cfg = getConfig();

  const companySnap = await db.collection(COLLECTIONS.companies).doc(identity.companyId).get();
  const company = companySnap.data() as { stripeCustomerId?: string; name?: string } | undefined;

  let customerId = company?.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: identity.email,
      name: company?.name,
      // Metadata is how the webhook maps a Stripe object back to a tenant.
      metadata: { companyId: identity.companyId },
    });
    customerId = customer.id;
    await db.collection(COLLECTIONS.companies).doc(identity.companyId).update({ stripeCustomerId: customerId });
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${cfg.dashboardOrigin}/billing?status=success`,
    cancel_url: `${cfg.dashboardOrigin}/billing?status=cancelled`,
    // The plan id travels with the subscription so the webhook does not have to
    // re-derive it from the price on the first event.
    subscription_data: { metadata: { companyId: identity.companyId, planId: plan.id } },
    metadata: { companyId: identity.companyId, planId: plan.id },
  });

  return { url: session.url };
});

/**
 * Stripe webhook. Mounted with a raw body parser in index.ts.
 * Every event is validated by signature before any state is touched.
 */
export const stripeWebhook = onRequest(
  { region: REGION, secrets: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'] },
  async (req: Request, res: Response) => {
  const cfg = getConfig();
  if (!cfg.stripeKey || !cfg.stripeWebhookSecret) {
    res.status(503).json({ error: 'Stripe not configured' });
    return;
  }

  const signature = req.headers['stripe-signature'];
  if (typeof signature !== 'string') {
    res.status(400).json({ error: 'Missing signature' });
    return;
  }

  const stripe = new Stripe(cfg.stripeKey, { apiVersion: '2024-12-18.acacia' as never });

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body as Buffer, signature, cfg.stripeWebhookSecret);
  } catch (err) {
    console.error('[stripe] signature verification failed', (err as Error).message);
    res.status(400).json({ error: 'Invalid signature' });
    return;
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object as Stripe.Checkout.Session;
        // companyId travels on both the customer and the subscription metadata,
        // so whichever arrives first is enough to attribute the event.
        const companyId = s.metadata?.companyId;
        if (companyId) {
          await upsertSubscription(companyId, {
            status: 'active',
            stripeCustomerId: typeof s.customer === 'string' ? s.customer : null,
            stripeSubscriptionId: typeof s.subscription === 'string' ? s.subscription : null,
            // The plan chosen at checkout. `customer.subscription.created` will
            // arrive with the authoritative price and may overwrite this, but
            // recording it here means a tenant is never momentarily entitled to
            // nothing between the two events.
            planId: s.metadata?.planId ?? null,
          });
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        const companyId = sub.metadata?.companyId;
        if (companyId) {
          const priceId = sub.items.data[0]?.price.id ?? null;
          await upsertSubscription(companyId, {
            status: sub.status,
            stripeSubscriptionId: sub.id,
            currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
            cancelAtPeriodEnd: sub.cancel_at_period_end,
            priceId,
            /**
             * Resolve the plan from the subscription's METADATA first, then from
             * the price.
             *
             * Metadata is what we set at checkout, so it survives a price that an
             * operator later moved between plans. The price lookup is the fallback
             * for subscriptions created directly in the Stripe dashboard, where no
             * metadata exists — that path is common during a pilot when an operator
             * sets a customer up by hand, and without the fallback those customers
             * would silently resolve to no plan at all.
             */
            planId: sub.metadata?.planId ?? (await planIdForPrice(priceId)),
          });
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const companyId = sub.metadata?.companyId;
        if (companyId) {
          await upsertSubscription(companyId, { status: 'canceled', cancelAtPeriodEnd: false });
        }
        break;
      }
      case 'invoice.payment_failed': {
        const inv = event.data.object as Stripe.Invoice;
        const customerId = typeof inv.customer === 'string' ? inv.customer : null;
        if (customerId) {
          const comp = await db
            .collection(COLLECTIONS.companies)
            .where('stripeCustomerId', '==', customerId)
            .limit(1)
            .get();
          if (!comp.empty) {
            await upsertSubscription(comp.docs[0]!.id, { status: 'past_due' });
            await audit({
              companyId: comp.docs[0]!.id,
              action: 'subscription.updated',
              actorType: 'system',
              detail: { status: 'past_due', source: 'invoice.payment_failed' },
            });
          }
        }
        break;
      }
      default:
        // Unhandled event types are acknowledged so Stripe stops retrying.
        break;
    }
    res.status(200).json({ received: true });
  } catch (err) {
    console.error('[stripe] handler error', (err as Error).message);
    // 500 makes Stripe retry, which is correct for a transient write failure.
    res.status(500).json({ error: 'Handler failed' });
  }
});

/**
 * Map a Stripe price to one of our plan ids.
 *
 * Returns null rather than throwing. A price we cannot map means a subscription
 * created outside checkout — normal during a pilot — and the resolver's own
 * "unknown plan" path already fails closed on growth while leaving live
 * conversations running. Throwing here would make the webhook return 500, and
 * Stripe would retry a permanently unfixable event for days.
 */
async function planIdForPrice(priceId: string | null): Promise<string | null> {
  if (!priceId) return null;
  try {
    const plans = await loadPlans();
    return plans.find((p) => p.stripePriceIds.includes(priceId))?.id ?? null;
  } catch (err) {
    console.error('[stripe] plan lookup failed for price', priceId, (err as Error).message);
    return null;
  }
}

async function upsertSubscription(
  companyId: string,
  patch: {
    status: string;
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
    currentPeriodEnd?: Date | null;
    cancelAtPeriodEnd?: boolean;
    priceId?: string | null;
    /**
     * The plan this subscription grants.
     *
     * `undefined` means "leave whatever is stored alone" — not "clear it". That
     * distinction matters: `invoice.payment_failed` carries no plan information,
     * so if its patch cleared the field a customer's plan would vanish the first
     * time a card was declined, and they would be restricted as an *unresolved
     * plan* rather than as a payment failure. A deliberate `null` still clears.
     */
    planId?: string | null;
  },
): Promise<void> {
  await db
    .collection(COLLECTIONS.subscriptions)
    .doc(companyId)
    .set(
      {
        companyId,
        ...patch,
        // `undefined` is not a legal Firestore value and `set(merge)` would throw.
        ...(patch.planId !== undefined ? { planId: patch.planId } : {}),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

  await audit({
    companyId,
    action: 'subscription.updated',
    actorType: 'system',
    detail: { status: patch.status, ...(patch.planId ? { planId: patch.planId } : {}) },
  });
}
