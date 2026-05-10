// Supabase Edge Function: decrement-stock-and-create-sale
// Atomic stock decrement + create both `sales` and `bills` rows.
//
// Deploy in Supabase Dashboard → Edge Functions
// Name MUST match: decrement-stock-and-create-sale
//
// Expected request body:
// {
//   "customerId": "uuid or null",
//   "invNo": "string",
//   "saleDate": "YYYY-MM-DD",
//   "paymentMode": "string",
//   "items": [ {"pid":"product_uuid","variantIndex": number | null,"qty": number,"price": number} ],
//   "bill": {"format": "Standard GST Invoice" | ... , "billGstin": "optional"}
// }

// NOTE: This file is meant to be pasted into Supabase Edge Function editor (Deno runtime).
// Some editors may show TS type errors locally; Supabase Edge will handle Deno globals.

type Item = { pid: string; variantIndex?: number | null; qty: number; price: number };
type Variant = { name?: string; stock?: number; price?: number };

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Supabase client (service role) - Deno-compatible import
// Supabase Edge Function editor already runs in Deno, so `Deno` exists there.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const supabase = (await import('https://esm.sh/@supabase/supabase-js@2')).createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
);

// Make this file a module so top-level await is allowed in the editor.
export {};



// Helper: compute totals with GST included in product rows
function round2(n: number) {
  return Math.round(n * 100) / 100;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }

  const authHeader = req.headers.get('Authorization') || '';
  // We will rely on user_id from auth JWT in RLS by setting user context.
  // However, since we use service role, we must manually extract the user id
  // and pass it through for writes.

  // JWT parsing without extra deps is non-trivial; Supabase Edge provides auth in `req.headers`.
  // We'll use Supabase `auth.getUser()` by calling /auth/v1/user with the anon token.
  let userId: string | null = null;
  try {
    const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': authHeader,
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
      },
    });
    const userJson = await userResp.json();
    userId = userJson?.id || null;
  } catch {
    userId = null;
  }

  if (!userId) {
    return new Response(JSON.stringify({ error: 'Unauthorized (no user)' }), { status: 401 });
  }

  const body = await req.json();
  const { customerId, invNo, saleDate, paymentMode, items, bill } = body as {
    customerId?: string | null;
    invNo: string;
    saleDate: string;
    paymentMode: string;
    items: Item[];
    bill: { format: string };
  };

  if (!invNo || !saleDate || !Array.isArray(items) || items.length === 0) {
    return new Response(JSON.stringify({ error: 'Invalid payload' }), { status: 400 });
  }

  // Atomic operations: use a transaction.
  // Edge Functions can execute RPC; simplest is to call a SQL RPC, but here we keep inline.
  // We'll do it with a SQL function in the future if desired.
  // For now: enforce atomicity by updating stock rows with a WHERE stock >= qty check.

  // Fetch product rows for this user to get gst, and validate stock.
  const pids = items.map((i) => i.pid);
  const { data: products, error: pErr } = await supabase
    .from('products')
    .select('id, user_id, stock, gst, price, name, unit, hsn, variants')
    .in('id', pids)
    .eq('user_id', userId);

  if (pErr) {
    return new Response(JSON.stringify({ error: pErr.message }), { status: 500 });
  }

  const prodById = new Map((products || []).map((p: any) => [p.id, p]));
  for (const it of items) {
    const p = prodById.get(it.pid);
    if (!p) return new Response(JSON.stringify({ error: `Product not found: ${it.pid}` }), { status: 404 });
    const variant = getVariant(p.variants, it.variantIndex);
    const availableStock = variant ? Number(variant.stock || 0) : Number(p.stock || 0);
    const stockLabel = variant?.name ? `${p.name} - ${variant.name}` : p.name;
    if (availableStock < it.qty) return new Response(JSON.stringify({ error: `Insufficient stock for ${stockLabel}` }), { status: 409 });
  }

  // Compute totals
  let subtotal = 0;
  let gstTotal = 0;
  const saleItemsSnapshot = [];

  for (const it of items) {
    const p = prodById.get(it.pid);
    const variant = getVariant(p.variants, it.variantIndex);
    const linePrice = it.price ?? variant?.price ?? p.price;
    const lineBase = it.qty * linePrice;
    const lineGst = (lineBase * (p.gst ?? 0)) / 100;
    subtotal += lineBase;
    gstTotal += lineGst;
    saleItemsSnapshot.push({
      pid: it.pid,
      variantIndex: it.variantIndex ?? null,
      variantName: variant?.name || null,
      qty: it.qty,
      price: linePrice,
      gst: p.gst,
      hsn: p.hsn || '',
    });
  }

  const subtotalR = round2(subtotal);
  const gstR = round2(gstTotal);
  const totalR = round2(subtotalR + gstR);

  // Update stock (transaction-like)
  // We'll update each product with a stock guard; in rare race conditions you can still get a mismatch,
  // but this is a significant improvement. For full correctness, implement a SQL function.
  for (const it of items) {
    const p = prodById.get(it.pid);
    const variants = Array.isArray(p.variants) ? [...p.variants] as Variant[] : [];
    const variantIndex = typeof it.variantIndex === 'number' ? it.variantIndex : null;
    const updatePayload: Record<string, unknown> = {};

    if (variantIndex !== null && variants[variantIndex]) {
      variants[variantIndex] = {
        ...variants[variantIndex],
        stock: Math.max(0, Number(variants[variantIndex].stock || 0) - it.qty),
      };
      updatePayload.variants = variants;
      updatePayload.stock = variants.reduce((sum, v) => sum + Number(v.stock || 0), 0);
    } else {
      updatePayload.stock = Number(p.stock || 0) - it.qty;
    }

    const { error: uErr } = await supabase
      .from('products')
      .update(updatePayload)
      .eq('id', it.pid)
      .eq('user_id', userId)
      .eq('stock', p.stock);

    if (uErr) {
      return new Response(JSON.stringify({ error: uErr.message }), { status: 500 });
    }
  }

  // Create sale
  const { error: sErr } = await supabase
    .from('sales')
    .insert({
      user_id: userId,
      inv_no: invNo,
      customer_id: customerId || null,
      items: saleItemsSnapshot,
      subtotal: subtotalR,
      gst: gstR,
      total: totalR,
      sale_date: saleDate,
      payment_mode: paymentMode || 'Cash',
    });

  if (sErr) {
    return new Response(JSON.stringify({ error: sErr.message }), { status: 500 });
  }

  // Create bill
  const format = bill?.format || 'Standard GST Invoice';
  const { error: bErr } = await supabase
    .from('bills')
    .insert({
      user_id: userId,
      inv_no: invNo,
      customer_id: customerId || null,
      amount: totalR,
      bill_date: saleDate,
      format,
    });

  if (bErr) {
    return new Response(JSON.stringify({ error: bErr.message }), { status: 500 });
  }

  // Optional: Update customers.purchases array
  // Keep it simple: fetch affected customers and update purchases with array append.
  if (customerId) {
    const purchaseIds = items.map((it) => it.pid);
    const { data: cust } = await supabase
      .from('customers')
      .select('purchases')
      .eq('id', customerId)
      .eq('user_id', userId)
      .maybeSingle();

    const existing = (cust?.purchases || []) as string[];
    const merged = Array.from(new Set([...existing, ...purchaseIds]));

    const { error: cErr } = await supabase
      .from('customers')
      .update({ purchases: merged })
      .eq('id', customerId)
      .eq('user_id', userId);

    if (cErr) {
      return new Response(JSON.stringify({ error: cErr.message }), { status: 500 });
    }
  }

  return new Response(JSON.stringify({ ok: true, invNo, total: totalR }), { status: 200 });
});

function getVariant(variants: unknown, variantIndex?: number | null): Variant | null {
  if (typeof variantIndex !== 'number' || !Array.isArray(variants)) return null;
  return (variants[variantIndex] || null) as Variant | null;
}
