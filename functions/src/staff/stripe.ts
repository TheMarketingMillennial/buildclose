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
export const createCheckoutSession = onCall({ region: REGION }, async (request) => {
  const identity = requireStaff(request);
  requireRole(identity, ['company_admin']);

  const parsed = z.object({ priceId: z.string().min(1).max(200) }).safeParse(request.data);
  if (!parsed.success) throw new HttpsError('invalid-argument', 'Missing price id');

  const stripe = stripeClient();
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
    line_items: [{ price: parsed.data.priceId, quantity: 1 }],
    success_url: `${cfg.dashboardOrigin}/billing?status=success`,
    cancel_url: `${cfg.dashboardOrigin}/billing?status=cancelled`,
    subscription_data: { metadata: { companyId: identity.companyId } },
  });

  return { url: session.url };
});

/**
 * Stripe webhook. Mounted with a raw body parser in index.ts.
 * Every event is validated by signature before any state is touched.
 */
export const stripeWebhook = onRequest({ region: REGION }, async (req: Request, res: Response) => {
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
          });
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        const companyId = sub.metadata?.companyId;
        if (companyId) {
          await upsertSubscription(companyId, {
            status: sub.status,
            stripeSubscriptionId: sub.id,
            currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
            cancelAtPeriodEnd: sub.cancel_at_period_end,
            priceId: sub.items.data[0]?.price.id ?? null,
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

async function upsertSubscription(
  companyId: string,
  patch: {
    status: string;
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
    currentPeriodEnd?: Date | null;
    cancelAtPeriodEnd?: boolean;
    priceId?: string | null;
  },
): Promise<void> {
  await db
    .collection(COLLECTIONS.subscriptions)
    .doc(companyId)
    .set({ companyId, ...patch, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

  await audit({
    companyId,
    action: 'subscription.updated',
    actorType: 'system',
    detail: { status: patch.status },
  });
}
