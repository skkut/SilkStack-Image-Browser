/**
 * SilkStack anonymous usage ping endpoint.
 *
 * Receives one small JSON body per active install per day from the packaged
 * app (see electron/usagePing.mjs — the entire client side of this feature),
 * and writes it as a single Analytics Engine data point:
 *
 *   index1   the random install ID — used only to count distinct installs
 *   blob1    country, from request.cf.country (derived by Cloudflare's edge
 *            from the connection; the IP is never read, logged or stored)
 *   blob2    app version
 *   blob3    os
 *   blob4    plan: "free" | "pro"
 *
 * The app never sends — and this Worker never stores — the license key, the
 * license e-mail, file or folder names, image counts, prompts, tags or search
 * queries.
 *
 * Deploy steps and the dashboard queries live in ../README.md.
 */

const PLANS = new Set(['free', 'pro']);
const MAX_ID_LENGTH = 64;
const MAX_FIELD_LENGTH = 32;
const MAX_BODY_BYTES = 1024;

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response(null, { status: 405 });
    }

    // The endpoint is public by design — a desktop app cannot hold a secret —
    // so the only defense is validating the shape and dropping the rest.
    const contentLength = Number(request.headers.get('content-length') ?? 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return new Response(null, { status: 413 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(null, { status: 400 });
    }

    const { id, v, os, plan } = body ?? {};

    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LENGTH) {
      return new Response(null, { status: 400 });
    }
    if (typeof v !== 'string' || typeof os !== 'string' || !PLANS.has(plan)) {
      return new Response(null, { status: 400 });
    }

    // Every app version ever shipped keeps posting here forever — the Worker
    // can be rolled back, the users cannot. Unknown extra fields are ignored
    // and known ones are truncated rather than rejected, so an old client is
    // never refused; only the four columns above are ever stored.
    env.SILKSTACK_USAGE.writeDataPoint({
      indexes: [id],
      blobs: [
        request.cf?.country ?? 'XX',
        v.slice(0, MAX_FIELD_LENGTH),
        os.slice(0, MAX_FIELD_LENGTH),
        plan,
      ],
    });

    return new Response(null, { status: 204 });
  },
};
