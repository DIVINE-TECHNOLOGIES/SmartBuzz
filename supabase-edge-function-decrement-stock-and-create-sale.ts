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

import { createClient } from "npm:@supabase/supabase-js@2";

type Item = { pid: string; variantIndex?: number | null; qty: number; price: number };
type Variant = { name?: string; stock?: number; price?: number };

type ProductRow = {
  id: string;
  user_id: string;
  stock: number | null;
  gst: number | null;
  price: number | null;
  name: string;
  unit: string | null;
  hsn: string | null;
  variants: unknown;
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function getVariant(variants: unknown, variantIndex?: number | null): Variant | null {
  if (typeof variantIndex !== "number" || !Array.isArray(variants)) return null;
  return (variants[variantIndex] || null) as Variant | null;
}

function errorResponse(
  error: string,
  status: number,
  extra: Record<string, unknown> = {},
) {
  return new Response(JSON.stringify({ error, ...extra }), { status, headers: corsHeaders });
}

function databaseErrorResponse(
  fallback: string,
  err: { message?: string; code?: string; details?: string; hint?: string },
) {
  const code = err?.code || "";
  const message = err?.message || fallback;

  if (code === "23505" || /duplicate key/i.test(message)) {
    return errorResponse("Invoice number already exists. Refresh the invoice number and try again.", 409, {
      code: "DUPLICATE_INVOICE",
      details: message,
    });
  }

  if (/schema cache|column .* does not exist|could not find .* column/i.test(message)) {
    return errorResponse("Supabase database schema is out of date. Run the latest supabase-schema.sql and redeploy the Edge Function.", 500, {
      code: "SCHEMA_OUT_OF_DATE",
      details: message,
      hint: err?.hint,
    });
  }

  return errorResponse(fallback, 500, {
    code: code || "DATABASE_ERROR",
    details: message,
    hint: err?.hint,
  });
}

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  const authHeader = req.headers.get("Authorization") || "";

  // Extract user_id from JWT token
  let userId: string | null = null;
  try {
    const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        Authorization: authHeader,
        apikey: SUPABASE_SERVICE_ROLE_KEY,
      },
    });

    if (!userResp.ok) {
      return errorResponse("Unauthorized", 401);
    }

    const userJson = await userResp.json();
    userId = userJson?.id || null;
  } catch (e) {
    console.error("Auth error:", e);
    return errorResponse("Authentication failed", 401);
  }

  if (!userId) {
    return errorResponse("Unauthorized (no user)", 401);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON payload", 400);
  }

  const { customerId, invNo, saleDate, paymentMode, items, bill } = body as {
    customerId?: string | null;
    invNo?: string;
    saleDate?: string;
    paymentMode?: string;
    items?: Item[];
    bill?: { format?: string; billGstin?: string };
  };

  if (!invNo || typeof invNo !== "string") {
    return errorResponse("Missing or invalid invNo", 400);
  }

  if (!saleDate || typeof saleDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(saleDate)) {
    return errorResponse("Missing or invalid saleDate", 400);
  }

  if (!Array.isArray(items) || items.length === 0) {
    return errorResponse("Items must be a non-empty array", 400);
  }

  for (const item of items) {
    if (!item?.pid || typeof item.qty !== "number" || item.qty <= 0 || typeof item.price !== "number") {
      return errorResponse("Each item must have valid pid, qty (>0), and price", 400);
    }
  }

  const [existingSale, existingBill] = await Promise.all([
    supabase
      .from("sales")
      .select("id")
      .eq("user_id", userId)
      .eq("inv_no", invNo)
      .limit(1),
    supabase
      .from("bills")
      .select("id")
      .eq("user_id", userId)
      .eq("inv_no", invNo)
      .limit(1),
  ]);

  if (existingSale.error) {
    console.error("Sale duplicate check error:", existingSale.error);
    return databaseErrorResponse("Failed to check existing sales", existingSale.error);
  }

  if (existingBill.error) {
    console.error("Bill duplicate check error:", existingBill.error);
    return databaseErrorResponse("Failed to check existing bills", existingBill.error);
  }

  if ((existingSale.data || []).length > 0 || (existingBill.data || []).length > 0) {
    return errorResponse("Invoice number already exists. Refresh the invoice number and try again.", 409, {
      code: "DUPLICATE_INVOICE",
      invNo,
    });
  }

  const pids = items.map((i) => i.pid);

  const { data: products, error: pErr } = await supabase
    .from("products")
    .select("id, user_id, stock, gst, price, name, unit, hsn, variants")
    .in("id", pids)
    .eq("user_id", userId);

  if (pErr) {
    console.error("Product fetch error:", pErr);
    return databaseErrorResponse("Failed to fetch products", pErr);
  }

  if (!products || products.length !== pids.length) {
    const foundIds = new Set((products || []).map((p: any) => p.id));
    const missing = pids.find((id) => !foundIds.has(id));
    return errorResponse(`Product not found: ${missing}`, 404);
  }

  const prodById = new Map((products as ProductRow[]).map((p) => [p.id, p]));

  // Validate stock availability BEFORE any updates
  for (const it of items) {
    const p = prodById.get(it.pid);
    if (!p) continue;
    const variant = getVariant(p.variants, it.variantIndex);
    const availableStock = variant ? Number(variant.stock || 0) : Number(p.stock || 0);
    const stockLabel = variant?.name ? `${p.name} - ${variant.name}` : p.name;

    if (availableStock < it.qty) {
      return errorResponse(`Insufficient stock for ${stockLabel} (available: ${availableStock}, required: ${it.qty})`, 409, {
        code: "INSUFFICIENT_STOCK",
      });
    }
  }

  // Compute totals
  let subtotal = 0;
  let gstTotal = 0;
  const saleItemsSnapshot: any[] = [];
  const format = bill?.format || "Standard GST Invoice";
  const isDeliveryChallan = /delivery challan/i.test(format);

  for (const it of items) {
    const p = prodById.get(it.pid) as ProductRow;
    const variant = getVariant(p.variants, it.variantIndex);
    const linePrice = (it.price ?? (variant?.price as number | undefined) ?? p.price ?? 0) as number;
    const lineBase = it.qty * linePrice;
    const lineGst = isDeliveryChallan ? 0 : (lineBase * (p.gst ?? 0)) / 100;

    subtotal += lineBase;
    gstTotal += lineGst;

    saleItemsSnapshot.push({
      pid: it.pid,
      variantIndex: it.variantIndex ?? null,
      variantName: variant?.name || null,
      qty: it.qty,
      price: linePrice,
      gst: isDeliveryChallan ? 0 : p.gst,
      hsn: p.hsn || "",
    });
  }

  const subtotalR = round2(subtotal);
  const gstR = round2(gstTotal);
  const totalR = round2(subtotalR + gstR);

  // Update stock with optimistic locking (guard clause)
  const stockUpdateErrors: string[] = [];

  for (const it of items) {
    const p = prodById.get(it.pid) as ProductRow;
    const variants = Array.isArray(p.variants) ? [...(p.variants as Variant[])] : [];
    const variantIndex = typeof it.variantIndex === "number" ? it.variantIndex : null;
    const updatePayload: Record<string, unknown> = {};

    if (variantIndex !== null && variants[variantIndex]) {
      variants[variantIndex] = {
        ...variants[variantIndex],
        stock: Math.max(0, Number(variants[variantIndex].stock || 0) - it.qty),
      };
      updatePayload.variants = variants;
      updatePayload.stock = variants.reduce((sum, v) => sum + Number(v.stock || 0), 0);
    } else {
      updatePayload.stock = Math.max(0, Number(p.stock || 0) - it.qty);
    }

    const { error: uErr, data: updatedRows } = await supabase
      .from("products")
      .update(updatePayload)
      .eq("id", it.pid)
      .eq("user_id", userId)
      // optimistic lock on stock value
      .eq("stock", Number(p.stock))
      .select("id");

    if (uErr) stockUpdateErrors.push(`Failed to update stock for ${p.name}: stock may have changed`);
    if (!uErr && (!updatedRows || updatedRows.length !== 1)) {
      stockUpdateErrors.push(`Failed to update stock for ${p.name}: stock may have changed`);
    }
  }

  if (stockUpdateErrors.length > 0) {
    return errorResponse("Stock update conflict - some items may have sold out", 409, {
      details: stockUpdateErrors,
      code: "STOCK_UPDATE_FAILED",
    });
  }

  // Create sale record
  const { error: sErr } = await supabase
    .from("sales")
    .insert({
      user_id: userId,
      inv_no: invNo,
      customer_id: customerId || null,
      items: saleItemsSnapshot,
      subtotal: subtotalR,
      gst: gstR,
      total: totalR,
      sale_date: saleDate,
      payment_mode: paymentMode || "Cash",
    })
    .select();

  if (sErr) {
    console.error("Sale creation error:", sErr);
    return databaseErrorResponse("Failed to create sale record", sErr);
  }

  // Create bill record
  const { error: bErr } = await supabase.from("bills").insert({
    user_id: userId,
    inv_no: invNo,
    customer_id: customerId || null,
    amount: totalR,
    bill_date: saleDate,
    format,
  });

  if (bErr) {
    console.error("Bill creation error:", bErr);
    return databaseErrorResponse("Failed to create bill record", bErr);
  }

  // Update customer purchases (optional, but non-critical failure)
  if (customerId) {
    try {
      const { data: cust } = await supabase
        .from("customers")
        .select("purchases")
        .eq("id", customerId)
        .eq("user_id", userId)
        .maybeSingle();

      const existing = (cust?.purchases || []) as string[];
      const purchaseIds = items.map((it) => it.pid);
      const merged = Array.from(new Set([...existing, ...purchaseIds]));

      await supabase
        .from("customers")
        .update({ purchases: merged })
        .eq("id", customerId)
        .eq("user_id", userId);
    } catch (e) {
      console.error("Customer update warning (non-critical):", e);
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      invNo,
      total: totalR,
      subtotal: subtotalR,
      gst: gstR,
      itemCount: items.length,
    }),
    { status: 200, headers: corsHeaders },
  );
});
