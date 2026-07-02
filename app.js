// ── Hardcoded Supabase credentials ──────────────────────────────────────────
const SUPABASE_URL = 'https://ebaawpgxkaehnvicsxvd.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImViYWF3cGd4a2FlaG52aWNzeHZkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI0NjI1NTYsImV4cCI6MjA5ODAzODU1Nn0.qsx3hCs7aKzbGSNsDjPibSyIbxAmecDk-2jMkWmed4o';

const state = {
  client: null,
  session: null,
  authMode: 'login',
  page: 'dashboard',
  business: null,
  role: null, // 'owner' | 'employee'
  settings: { low_stock_threshold: 10, default_gst: 12, default_unit: 'pcs' },
  products: [],
  variants: [],
  customers: [],
  invoices: [],
  invoiceItems: [],
  stockMovements: [],
  billLines: [],
};


const pages = {
  dashboard: ['Dashboard', 'Today at a glance'],
  products: ['Products', 'Manage inventory, pricing, GST and variants'],
  stock: ['Add Stock', 'Receive new stock and keep audit history'],
  billing: ['Billing', 'Create a clean GST invoice'],
  invoices: ['Invoices', 'Browse saved transactions'],
  customers: ['Customers', 'Manage customer records'],
  reports: ['Reports', 'Sales summary for accounts'],
  settings: ['Business Setup', 'Profile and inventory defaults'],
};

const $ = (id) => document.getElementById(id);
const money = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

function toast(message) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  $('toast-root').appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

function setBusy(isBusy) {
  // content-loader only exists inside #app, guard against it being hidden/absent
  const el = $('content-loader');
  if (el) el.classList.toggle('hidden', !isBusy);
}

function show(view) {
  ['auth-view', 'app'].forEach((id) => {
    const el = $(id);
    if (el) el.classList.add('hidden');
  });
  const target = $(view);
  if (target) target.classList.remove('hidden');
}

async function waitForSupabase(retries = 40, delayMs = 100) {
  for (let i = 0; i < retries; i++) {
    if (window.supabase) return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

function makeClient() {
  if (state.client) return; // already created
  state.client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
}

// ── Boot sequence ────────────────────────────────────────────────────────────
// Order matters:
//   1. Wire auth-screen events only (Login button is visible immediately)
//   2. Wait for Supabase CDN script
//   3. Create client
//   4. Check existing session
//   5. If logged in → wire ALL app events → enter app
//   6. If not logged in → show login screen (app events wired after login)

async function boot() {
  const bootLoader = $('boot-loader');
  try {
    // Date fields that are always in DOM
    if ($('stock-date')) $('stock-date').value = today();
    if ($('bill-date')) $('bill-date').value = today();

    // Wire only the login screen events first
    wireAuthEvents();

    // Wait for the Supabase CDN bundle
    const ready = await waitForSupabase();
    if (!ready) throw new Error('Supabase library failed to load — check your internet connection.');

    makeClient();

    const { data, error } = await state.client.auth.getSession();
    if (error) throw error;
    state.session = data.session || null;

    if (bootLoader) bootLoader.classList.add('hidden');

    if (!state.session) {
      show('auth-view');
      return;
    }

    // Already logged in — wire app and go
    wireAppEvents();
    await detectRole();
    await enterApp();

  } catch (err) {
    if (bootLoader) bootLoader.classList.add('hidden');
    show('auth-view');
    toast(err.message || 'App failed to start');
  }
}

// ── Auth-screen events (Login / Create account) ──────────────────────────────
function wireAuthEvents() {
  document.querySelectorAll('[data-auth-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.authMode = btn.dataset.authMode;
      $('login-tab')?.classList.toggle('active', state.authMode === 'login');
      $('signup-tab')?.classList.toggle('active', state.authMode === 'signup');
      $('auth-submit-btn').textContent = state.authMode === 'login' ? 'Login' : 'Create account';
    });
  });

  $('auth-submit-btn').addEventListener('click', handleAuth);
}

// ── App events (wired only after client exists and user is logged in) ─────────
function wireAppEvents() {
  $('logout-btn').addEventListener('click', async () => {
    await state.client.auth.signOut();
    state.session = null;
    show('auth-view');
  });

  $('nav').addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-page]');
    if (btn) navigate(btn.dataset.page);
  });

  document.querySelectorAll('[data-page-link]').forEach((el) => {
    el.addEventListener('click', () => navigate(el.dataset.pageLink));
  });

  $('bill-customer').addEventListener('change', onCustomerChange);
  $('refresh-btn').addEventListener('click', refresh);
  $('quick-bill-btn').addEventListener('click', () => navigate('billing'));
  $('add-product-btn').addEventListener('click', openProductDialog);
  $('import-products-btn').addEventListener('click', openImportDialog);
  $('save-product-btn').addEventListener('click', saveProduct);
  $('add-variant-btn').addEventListener('click', () => addVariantRow());
  $('product-search').addEventListener('input', renderProducts);
  $('invoice-search').addEventListener('input', renderInvoices);
  $('stock-product').addEventListener('change', populateStockVariants);
  $('bill-product').addEventListener('change', populateBillVariants);
  $('save-stock-btn').addEventListener('click', receiveStock);
  $('add-line-btn').addEventListener('click', addBillLine);
  $('bill-type').addEventListener('change', renderBillLines);
  $('save-invoice-btn').addEventListener('click', saveInvoice);
  $('save-customer-btn').addEventListener('click', saveCustomer);
  $('save-business-btn').addEventListener('click', saveBusiness);
  $('save-settings-btn').addEventListener('click', saveSettings);
  $('apply-report-btn').addEventListener('click', renderReport);
  $('print-report-btn').addEventListener('click', () => window.print());

  // Owner-only: add employee link
  $('add-employee-btn')?.addEventListener('click', addEmployeeLink);

  // If we already have a session (e.g., hot reload), make role UI correct
  applyRoleUI();

  // Import dialog (defined in import.js)
  if (typeof wireImportEvents === 'function') wireImportEvents();
  wireQrUpload();
}

async function addEmployeeLink() {
  try {
    if (state.role !== 'owner') return toast('Access denied');
    const input = $('employee-user-id');
    if (!input) return;
    const employeeUserId = input.value.trim();
    if (!employeeUserId) return toast('Employee User ID is required');

    setBusy(true);
    const ownerUserId = state.session.user.id;

    // Insert mapping. Employees execute on behalf of the linked owner via RLS + RPC.
    const { error } = await state.client.from('employee_profiles').insert({
      owner_user_id: ownerUserId,
      employee_user_id: employeeUserId,
      role: 'employee',
    });
    if (error) throw error;

    input.value = '';
    toast('Employee linked');
  } catch (err) {
    toast(err.message || 'Could not link employee');
  } finally {
    setBusy(false);
  }
}

// ── Authentication ────────────────────────────────────────────────────────────
async function handleAuth() {
  // Ensure client exists (handles slow CDN edge case)
  if (!state.client) {
    const ready = await waitForSupabase();
    if (!ready) return toast('Supabase not loaded — please refresh the page');
    makeClient();
  }

  const email = $('auth-email').value.trim();
  const password = $('auth-password').value;
  if (!email || !password) return toast('Email and password are required');

  setBusy(true);
  try {
    const method = state.authMode === 'login' ? 'signInWithPassword' : 'signUp';
    const { data, error } = await state.client.auth[method]({ email, password });
    if (error) throw error;

    state.session = data.session;
    if (!state.session) {
      toast('Check your email to confirm your account, then login');
      return;
    }

    // Wire app events now that we have a client + session
    wireAppEvents();
    await detectRole();
    await enterApp();
  } catch (err) {
    toast(err.message || 'Authentication failed');
  } finally {
    setBusy(false);
  }
}

async function enterApp() {
  show('app');
  $('user-email').textContent = state.session.user.email;

  await refresh();
  applyRoleUI();

  // Default landing page
  navigate(state.role === 'employee' ? 'billing' : 'dashboard');
}

async function detectRole() {
  // Determine role by checking if user is mapped as an employee.
  // If mapped → employee, else → owner.
  async function detectRole() {
    try {
      const userId = state.session.user.id;
  
      const { data, error } = await state.client
        .from('employee_profiles')
        .select('*')
        .eq('employee_user_id', userId);
  
      console.log("Current User:", userId);
      console.log("Employee Record:", data);
      console.log("Error:", error);
  
      if (error) throw error;
  
      state.role = data.length ? 'employee' : 'owner';
      console.log("Detected Role:", state.role);
  
    } catch (e) {
      console.error(e);
      state.role = 'owner';
    }
  }
  try {
    const userId = state.session.user.id;
    const { data, error } = await state.client
      .from('employee_profiles')
      .select('id')
      .eq('employee_user_id', userId)
      .maybeSingle();

    if (error) throw error;
    state.role = data ? 'employee' : 'owner';
  } catch (e) {
    // Fallback: treat as owner if mapping check fails
    state.role = 'owner';
  }
}

function applyRoleUI() {
  // Employee allowed pages: dashboard, products, stock, billing, invoices
  // Hidden pages: customers, reports, settings
  const isEmp = state.role === 'employee';

  const allowed = new Set(['dashboard', 'products', 'stock', 'billing', 'invoices']);
  document.querySelectorAll('#nav button[data-page]').forEach((btn) => {
    const page = btn.dataset.page;
    btn.style.display = isEmp && !allowed.has(page) ? 'none' : '';
  });

  // Also hide/disable pages containers
  document.querySelectorAll('.page').forEach((section) => {
    const id = section.id || '';
    const page = id.replace('page-', '');
    if (isEmp && !allowed.has(page)) section.classList.remove('active');
  });
}



// ── Data refresh ──────────────────────────────────────────────────────────────
async function refresh() {
  if (!state.client || !state.session) return;
  setBusy(true);
  try {
    const [
      businessRes, settingsRes, productsRes, variantsRes,
      customersRes, invoicesRes, itemsRes, stockRes,
    ] = await Promise.all([
      state.client.from('business_profiles').select('*').maybeSingle(),
      state.client.from('business_settings').select('*').maybeSingle(),
      state.client.from('products').select('*').order('name', { ascending: true }),
      state.client.from('product_variants').select('*').order('created_at', { ascending: true }),
      state.client.from('customers').select('*').order('created_at', { ascending: false }),
      state.client.from('invoices').select('*').order('invoice_date', { ascending: false }).order('created_at', { ascending: false }),
      state.client.from('invoice_items').select('*').order('created_at', { ascending: true }),
      state.client.from('stock_movements').select('*').order('created_at', { ascending: false }).limit(40),
    ]);

    [businessRes, settingsRes, productsRes, variantsRes, customersRes, invoicesRes, itemsRes, stockRes].forEach((res) => {
      if (res.error && res.status !== 406) throw res.error;
    });

    state.business      = businessRes.data  || null;
    state.settings      = settingsRes.data  || state.settings;
    state.products      = productsRes.data  || [];
    state.variants      = variantsRes.data  || [];
    state.customers     = customersRes.data || [];
    state.invoices      = invoicesRes.data  || [];
    state.invoiceItems  = itemsRes.data     || [];
    state.stockMovements = stockRes.data    || [];

    hydrateSettings();
    renderAll();
  } catch (err) {
    toast(err.message || 'Could not load data. Check schema setup.');
  } finally {
    setBusy(false);
  }
}

// ── Navigation ────────────────────────────────────────────────────────────────
function navigate(page) {
  // Role guard (prevents opening hidden pages)
  if (state.role === 'employee') {
    const allowed = new Set(['dashboard', 'products', 'stock', 'billing', 'invoices']);
    if (!allowed.has(page)) return toast('Access denied');
  }

  state.page = page;
  document.querySelectorAll('.page').forEach((el) => el.classList.remove('active'));
  $(`page-${page}`).classList.add('active');
  document.querySelectorAll('#nav button').forEach((btn) => btn.classList.toggle('active', btn.dataset.page === page));
  $('page-title').textContent = pages[page][0];
  $('page-subtitle').textContent = pages[page][1];
  renderAll();
}


function renderAll() {
  renderDashboard();
  renderProducts();
  renderStock();
  renderBilling();
  renderInvoices();
  renderCustomers();
  renderReport();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function variantsFor(productId) {
  return state.variants.filter((v) => v.product_id === productId);
}

function currentStock(product) {
  const vars = variantsFor(product.id);
  return vars.length
    ? vars.reduce((sum, v) => sum + Number(v.stock_qty || 0), 0)
    : Number(product.stock_qty || 0);
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
function renderDashboard() {
  const revenue = state.invoices.reduce((sum, inv) => sum + Number(inv.total || 0), 0);
  const gst     = state.invoices.reduce((sum, inv) => sum + Number(inv.gst_total || 0), 0);
  const threshold = Number(state.settings.low_stock_threshold || 10);
  const low = state.products.filter((p) => currentStock(p) <= threshold);

  $('stats-grid').innerHTML = [
    ['Revenue',       `₹${money(revenue)}`],
    ['Invoices',      state.invoices.length],
    ['GST Collected', `₹${money(gst)}`],
    ['Low Stock',     low.length],
  ].map(([label, value]) => `<div class="stat"><span>${label}</span><strong>${value}</strong></div>`).join('');

  $('recent-invoices').innerHTML = listOrEmpty(state.invoices.slice(0, 6).map((inv) => {
    const customer = state.customers.find((c) => c.id === inv.customer_id);
    return `<div class="list-item"><div><strong>${esc(inv.invoice_no)}</strong><span>${esc(customer?.name || 'Walk-in')} · ${esc(inv.invoice_date)}</span></div><strong>₹${money(inv.total)}</strong></div>`;
  }));

  $('low-stock-label').textContent = `Threshold ${threshold}`;
  $('low-stock-list').innerHTML = listOrEmpty(low.slice(0, 8).map((p) =>
    `<div class="list-item"><div><strong>${esc(p.name)}</strong><span>${esc(p.category || 'General')}</span></div><span class="pill amber">${currentStock(p)} ${esc(p.unit || 'pcs')}</span></div>`
  ));
}

// ── Products ──────────────────────────────────────────────────────────────────
function renderProducts() {
  const q = $('product-search').value.toLowerCase();
  const rows = state.products
    .filter((p) => !q || [p.name, p.sku, p.category, p.size].join(' ').toLowerCase().includes(q))
    .map((p) => {
      const vars = variantsFor(p.id);
      const variantText = vars.length ? `<div class="muted">${vars.length} variant${vars.length === 1 ? '' : 's'}</div>` : '';
      const stockClass = currentStock(p) <= Number(state.settings.low_stock_threshold || 10) ? 'amber' : 'green';
      return `<tr>
        <td><strong>${esc(p.name)}</strong>${variantText}</td>
        <td>${esc(p.sku || '—')}</td>
        <td>${esc(p.size || '—')}</td>
        <td>${esc(p.category || 'General')}</td>
        <td><span class="pill ${stockClass}">${currentStock(p)} ${esc(p.unit || 'pcs')}</span></td>
        <td>₹${money(p.selling_price)}</td>
        <td>${Number(p.gst_rate || 0)}%</td>
<td>
  <button class="text-btn" onclick="editProduct('${p.id}')">Edit</button>
  <button class="text-btn delete-btn" onclick="deleteProduct('${p.id}')">
    Delete
  </button>
</td>      </tr>`;
    });
  $('products-table').innerHTML = rows.join('') || emptyRow(8, 'No products yet. Add one or import from CSV.');
  populateProductSelects();
}

function populateProductSelects() {
  const options = '<option value="">Select product</option>' +
    state.products.map((p) => {
      const label = p.size
        ? `${esc(p.name)} (${esc(p.size)}) · Stock ${currentStock(p)}`
        : `${esc(p.name)} · Stock ${currentStock(p)}`;
      return `<option value="${p.id}">${label}</option>`;
    }).join('');

  ['stock-product', 'bill-product'].forEach((id) => {
    const el = $(id);
    if (!el) return;
    const prev = el.value;
    el.innerHTML = options;
    if (prev) el.value = prev;
  });
  populateStockVariants();
  populateBillVariants();
}

function populateVariantSelect(selectId, productId, includeBase = true) {
  const el = $(selectId);
  if (!el) return;
  const vars = variantsFor(productId);
  const base = includeBase ? '<option value="">Base product</option>' : '<option value="">Select variant</option>';
  el.innerHTML = base + vars.map((v) => `<option value="${v.id}">${esc(v.name)} · Stock ${Number(v.stock_qty || 0)}</option>`).join('');
}

function populateStockVariants() { populateVariantSelect('stock-variant', $('stock-product')?.value, true); }
function populateBillVariants()  { populateVariantSelect('bill-variant',  $('bill-product')?.value,  true); }

function openProductDialog() {
  $('product-dialog-title').textContent = 'Add Product';
  $('product-id').value = '';
  ['p-name','p-sku','p-size','p-category','p-price','p-purchase','p-mrp','p-hsn','p-expiry'].forEach((id) => $(id).value = '');
  $('p-unit').value = state.settings.default_unit || 'pcs';
  $('p-gst').value  = state.settings.default_gst  || 12;
  $('variant-editor').innerHTML = '';
  $('product-dialog').showModal();
}

window.editProduct = function (id) {
  const p = state.products.find((item) => item.id === id);
  if (!p) return;
  $('product-dialog-title').textContent = 'Edit Product';
  $('product-id').value   = p.id;
  $('p-name').value       = p.name || '';
  $('p-sku').value        = p.sku || '';
  $('p-size').value       = p.size || '';
  $('p-category').value   = p.category || '';
  $('p-unit').value       = p.unit || 'pcs';
  $('p-price').value      = p.selling_price || 0;
  $('p-purchase').value   = p.purchase_price || 0;
  $('p-mrp').value        = p.mrp || 0;
  $('p-gst').value        = p.gst_rate || 0;
  $('p-hsn').value        = p.hsn || '';
  $('p-expiry').value     = p.expiry_date || '';
  $('variant-editor').innerHTML = '';
  variantsFor(id).forEach((v) => addVariantRow(v));
  $('product-dialog').showModal();
};

function addVariantRow(v = {}) {
  const row = document.createElement('div');
  row.className = 'variant-row';
  row.innerHTML = `
    <input class="var-name"  placeholder="Variant name" value="${esc(v.name || '')}">
    <input class="var-stock" type="number" min="0" placeholder="Stock" value="${Number(v.stock_qty || 0)}">
    <input class="var-price" type="number" min="0" step="0.01" placeholder="Price" value="${Number(v.selling_price || 0)}">
    <button class="icon-btn" type="button">✕</button>
    <input class="var-id" type="hidden" value="${esc(v.id || '')}">
  `;
  row.querySelector('button').addEventListener('click', () => row.remove());
  $('variant-editor').appendChild(row);
}

async function saveProduct() {

  const name  = $('p-name').value.trim();
  const price = Number($('p-price').value || 0);
  if (!name)    return toast('Product name is required');
  if (price < 0) return toast('Selling price cannot be negative');
  setBusy(true);
  try {
    const id = $('product-id').value || undefined;
    const payload = {
      name,
      sku:           $('p-sku').value.trim()      || null,
      size:          $('p-size').value.trim()     || null,
      category:      $('p-category').value.trim() || 'General',
      unit:          $('p-unit').value.trim()     || 'pcs',
      selling_price: price,
      purchase_price: Number($('p-purchase').value || 0),
      mrp:           Number($('p-mrp').value      || price),
      gst_rate:      Number($('p-gst').value      || 0),
      hsn:           $('p-hsn').value.trim()      || null,
      expiry_date:   $('p-expiry').value          || null,
    };

    const { data, error } = id
      ? await state.client.from('products').update(payload).eq('id', id).select('id').single()
      : await state.client.from('products').insert(payload).select('id').single();
    if (error) throw error;
    const productId = data.id;

    const variantRows = [...document.querySelectorAll('.variant-row')].map((row) => ({
      id:            row.querySelector('.var-id').value    || undefined,
      product_id:    productId,
      name:          row.querySelector('.var-name').value.trim(),
      stock_qty:     Number(row.querySelector('.var-stock').value || 0),
      selling_price: Number(row.querySelector('.var-price').value || price),
    })).filter((v) => v.name);

    if (id) {
      const existingIds = variantsFor(id).map((v) => v.id);
      const keptIds     = variantRows.filter((v) => v.id).map((v) => v.id);
      const removeIds   = existingIds.filter((eid) => !keptIds.includes(eid));
      if (removeIds.length) {
        const { error } = await state.client.from('product_variants').delete().in('id', removeIds);
        if (error) throw error;
      }
    }

    if (variantRows.length) {
      const { error } = await state.client.from('product_variants').upsert(variantRows);
      if (error) throw error;
      const totalStock = variantRows.reduce((s, v) => s + Number(v.stock_qty || 0), 0);
      const { error: se } = await state.client.from('products').update({ stock_qty: totalStock }).eq('id', productId);
      if (se) throw se;
    } else if (id && variantsFor(id).length) {
      const { error: se } = await state.client.from('products').update({ stock_qty: 0 }).eq('id', productId);
      if (se) throw se;
    }

    $('product-dialog').close();
    await refresh();
    toast('Product saved');
  } catch (err) {
    toast(err.message || 'Could not save product');
  } finally {
    setBusy(false);
  }
}

// ── Stock ─────────────────────────────────────────────────────────────────────
async function receiveStock() {
  const productId = $('stock-product').value;
  const variantId = $('stock-variant').value || null;
  const quantity  = Number($('stock-qty').value || 0);
  if (!productId || quantity <= 0) return toast('Select product and enter quantity');
  setBusy(true);
  try {
    const { error } = await state.client.rpc('receive_stock', {
      p_product_id:   productId,
      p_variant_id:   variantId,
      p_quantity:     quantity,
      p_source:       $('stock-source').value.trim(),
      p_notes:        $('stock-notes').value.trim(),
      p_received_date: $('stock-date').value || today(),
    });
    if (error) throw error;
    $('stock-qty').value    = 1;
    $('stock-source').value = '';
    $('stock-notes').value  = '';
    await refresh();
    toast('Stock received');
  } catch (err) {
    toast(err.message || err?.details || 'Could not add stock');
  } finally {
    setBusy(false);
  }
}

function stockItemLabel(product, variant) {
  // Build a clear label: "Product Name · Size M · Variant Blue"
  const parts = [product?.name || 'Product'];
  if (product?.size) parts.push('Size ' + product.size);
  if (variant?.name) parts.push(variant.name);
  return parts.join(' · ');
}

function renderStock() {
  $('stock-history').innerHTML = listOrEmpty(state.stockMovements.map((m) => {
    const product = state.products.find((p) => p.id === m.product_id);
    const variant = state.variants.find((v) => v.id === m.variant_id);
    const label   = stockItemLabel(product, variant);
    const pillClass = m.movement_type === 'sale' ? 'amber' : 'green';
    const pillSign  = m.movement_type === 'sale' ? '−' : '+';
    return `<div class="list-item">
      <div>
        <strong>${esc(label)}</strong>
        <span>${esc(m.received_date)}${m.source ? ' · ' + esc(m.source) : ''}${m.movement_type === 'sale' ? ' · Sale' : ''}</span>
        ${m.notes ? `<span style="font-size:0.82em;color:#64748b">${esc(m.notes)}</span>` : ''}
      </div>
      <div style="display:flex;align-items:center;gap:0.5rem">
        <span class="pill ${pillClass}">${pillSign}${Number(m.quantity || 0)}</span>
        ${m.movement_type !== 'sale' ? `<button class="text-btn" style="font-size:0.82em" onclick="editStockDialog('${m.id}')">Edit</button>` : ''}
      </div>
    </div>`;
  }));
}

// ── Stock edit dialog ─────────────────────────────────────────────────────────
window.editStockDialog = function(movementId) {
  const m = state.stockMovements.find((s) => s.id === movementId);
  if (!m) return;
  const product = state.products.find((p) => p.id === m.product_id);
  const variant = state.variants.find((v) => v.id === m.variant_id);
  $('edit-stock-id').value          = movementId;
  $('edit-stock-item').textContent  = stockItemLabel(product, variant);
  $('edit-stock-qty').value         = m.quantity || 1;
  $('edit-stock-source').value      = m.source || '';
  $('edit-stock-date').value        = m.received_date || today();
  $('edit-stock-notes').value       = m.notes || '';
  $('stock-edit-dialog').showModal();
};

window.saveStockEdits = async function() {
  const id  = $('edit-stock-id').value;
  const qty = Number($('edit-stock-qty').value || 0);
  if (!id || qty <= 0) return toast('Quantity must be greater than zero');
  setBusy(true);
  try {
    const { error } = await state.client.from('stock_movements').update({
      quantity:      qty,
      source:        $('edit-stock-source').value.trim() || null,
      received_date: $('edit-stock-date').value || today(),
      notes:         $('edit-stock-notes').value.trim() || null,
    }).eq('id', id);
    if (error) throw error;
    $('stock-edit-dialog').close();
    await refresh();
    toast('Stock record updated');
  } catch (err) {
    toast(err.message || 'Could not update stock record');
  } finally {
    setBusy(false);
  }
};

window.deleteStockMovement = async function() {
  const id = $('edit-stock-id').value;
  if (!id) return;
  if (!confirm('Delete this stock entry? The actual stock count will not change automatically.')) return;
  setBusy(true);
  try {
    const { error } = await state.client.from('stock_movements').delete().eq('id', id);
    if (error) throw error;
    $('stock-edit-dialog').close();
    await refresh();
    toast('Stock record deleted');
  } catch (err) {
    toast(err.message || 'Could not delete stock record');
  } finally {
    setBusy(false);
  }
};

// ── Billing ───────────────────────────────────────────────────────────────────
function renderBilling() {
  populateProductSelects();
  $('bill-customer').innerHTML = '<option value="">Walk-in / manual entry</option>' +
    state.customers.map((c) => `<option value="${c.id}">${esc(c.name)} · ${esc(c.phone || '')}</option>`).join('');
  $('invoice-number').textContent = 'Next invoice will be assigned on save';
  onCustomerChange(); // set initial state of manual fields
  renderBillLines();
}

// Show/hide manual customer fields and auto-fill from saved customer
function onCustomerChange() {
  const customerId = $('bill-customer').value;
  const manualBox  = $('manual-customer-box');
  if (!customerId) {
    // Walk-in — show manual entry fields, clear them
    manualBox.style.display = 'grid';
    // only clear if switching TO walk-in (not on first render if already typed)
  } else {
    // Saved customer selected — hide manual box, show their info in preview
    manualBox.style.display = 'none';
    const c = state.customers.find((cu) => cu.id === customerId);
    if (c) {
      $('manual-cust-name').value    = c.name    || '';
      $('manual-cust-phone').value   = c.phone   || '';
      $('manual-cust-address').value = c.address || '';
      $('manual-cust-gstin').value   = c.gstin   || '';
    }
  }
  renderBillLines(); // refresh preview with customer info
}

function addBillLine() {
  const product = state.products.find((p) => p.id === $('bill-product').value);
  if (!product) return toast('Select a product');
  const variant   = state.variants.find((v) => v.id === $('bill-variant').value);
  const qty       = Number($('bill-qty').value || 0);
  if (qty <= 0) return toast('Enter quantity');
  const available = variant ? Number(variant.stock_qty || 0) : Number(product.stock_qty || 0);
  if (qty > available) return toast(`Only ${available} in stock`);
  const price = Number(variant?.selling_price || product.selling_price || 0);
  const existing = state.billLines.find((line) =>
    line.product_id === product.id && (line.variant_id || '') === (variant?.id || '')
  );
  if (existing) {
    existing.quantity += qty;
  } else {
    state.billLines.push({
      product_id: product.id,
      variant_id: variant?.id || null,
      name:       variant ? `${product.name} - ${variant.name}` : product.name,
      quantity:   qty,
      unit_price: price,
      gst_rate:   Number(product.gst_rate || 0),
      hsn:        product.hsn || '',
    });
  }
  $('bill-qty').value = 1;
  renderBillLines();
}

function renderBillLines() {
  let subtotal = 0, gst = 0;
  const isChallan = $('bill-type').value === 'challan';
  $('bill-lines').innerHTML = state.billLines.map((line, idx) => {
    const base = line.quantity * line.unit_price;
    const tax  = isChallan ? 0 : base * line.gst_rate / 100;
    subtotal += base; gst += tax;
    return `<tr>
      <td>${esc(line.name)}</td>
      <td>
        <input type="number" min="1" value="${line.quantity}"
          style="width:56px;padding:0.2rem 0.4rem;border:1px solid #e2e8f0;border-radius:4px;text-align:center"
          onchange="updateBillQty(${idx}, this.value)"
          title="Quantity">
      </td>
      <td>
        <div style="display:flex;align-items:center;gap:2px">
          <span style="color:#64748b;font-size:0.85em">₹</span>
          <input type="number" min="0" step="0.01" value="${line.unit_price}"
            style="width:80px;padding:0.2rem 0.4rem;border:1px solid #e2e8f0;border-radius:4px"
            onchange="updateBillPrice(${idx}, this.value)"
            title="Unit price">
        </div>
      </td>
      <td>
        <div style="display:flex;align-items:center;gap:2px">
          <input type="number" min="0" max="28" step="0.01" value="${line.gst_rate}"
            style="width:52px;padding:0.2rem 0.4rem;border:1px solid #e2e8f0;border-radius:4px;text-align:center"
            onchange="updateBillGst(${idx}, this.value)"
            title="GST %">
          <span style="color:#64748b;font-size:0.85em">%</span>
        </div>
      </td>
      <td style="text-align:right;font-weight:500">₹${money(base + tax)}</td>
      <td><button class="text-btn" style="color:#ef4444" onclick="removeBillLine(${idx})">✕</button></td>
    </tr>`;
  }).join('') || emptyRow(6, 'No items added');
  renderInvoicePreview(subtotal, gst);
}

window.updateBillQty = function(idx, val) {
  const qty = Math.max(1, Number(val) || 1);
  const line = state.billLines[idx];
  // Check stock availability
  const product = state.products.find((p) => p.id === line.product_id);
  const variant = state.variants.find((v) => v.id === line.variant_id);
  const available = variant ? Number(variant.stock_qty || 0) : Number(product?.stock_qty || 0);
  if (qty > available) {
    toast(`Only ${available} in stock — quantity reset`);
    renderBillLines(); // reset the input visually
    return;
  }
  state.billLines[idx].quantity = qty;
  renderBillLines();
};

window.updateBillPrice = function(idx, val) {
  state.billLines[idx].unit_price = Math.max(0, Number(val) || 0);
  renderBillLines();
};

window.updateBillGst = function(idx, val) {
  const rate = Math.min(28, Math.max(0, Number(val) || 0));
  state.billLines[idx].gst_rate = rate;
  renderBillLines();
};

window.removeBillLine = function (index) {
  state.billLines.splice(index, 1);
  renderBillLines();
};

async function saveInvoice() {
  if (!state.billLines.length) return toast('Add at least one item');
  setBusy(true);
  try {
    const { error } = await state.client.rpc('create_invoice', {
      p_customer_id:  $('bill-customer').value || null,
      p_invoice_date: $('bill-date').value || today(),
      p_invoice_type: $('bill-type').value,
      p_payment_mode: $('bill-payment').value,
      p_items: state.billLines.map((line) => ({
        product_id: line.product_id,
        variant_id: line.variant_id,
        quantity:   line.quantity,
        unit_price: line.unit_price,
      })),
    });
    if (error) throw error;
    // Grab preview HTML before clearing billLines
    const printableHTML = $('printable-invoice')?.innerHTML || '';
    state.billLines = [];
    await refresh();
    navigate('invoices');
    toast('Invoice saved');
    // Offer print after a short delay so toast is visible
    if (printableHTML) {
      setTimeout(() => {
        if (confirm('Invoice saved! Print it now?')) {
          const biz = state.business || {};
          const win = window.open('', '_blank', 'width=800,height=700');
          win.document.write(`<!DOCTYPE html><html><head>
            <title>Invoice</title>
            <style>
              body { font-family: Arial, sans-serif; font-size: 13px; padding: 2rem; color: #111; }
              h2 { margin: 0 0 0.25rem; } p { margin: 0.15rem 0; }
              table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
              th, td { padding: 0.5rem 0.6rem; border: 1px solid #ddd; text-align: left; }
              th { background: #f5f5f5; font-weight: 600; }
              .money { text-align: right; }
              .invoice-head { display: flex; justify-content: space-between; border-bottom: 2px solid #333; padding-bottom: 1rem; margin-bottom: 1rem; }
              .customer-block { background: #f9f9f9; border: 1px solid #ddd; border-radius: 4px; padding: 0.75rem 1rem; margin-bottom: 1rem; }
              .customer-block h4 { margin: 0 0 0.4rem; font-size: 0.85em; color: #666; text-transform: uppercase; letter-spacing: 0.05em; }
              .invoice-total { text-align: right; margin-top: 0.5rem; }
              .invoice-total p, .invoice-total strong { display: flex; justify-content: flex-end; gap: 2rem; margin: 0.2rem 0; }
              .invoice-total strong { font-size: 1.1em; border-top: 1px solid #333; padding-top: 0.4rem; margin-top: 0.4rem; }
              .preview-toolbar { display: none; }
            </style>
          </head><body>${printableHTML}</body></html>`);
          win.document.close();
          win.focus();
          setTimeout(() => win.print(), 400);
        }
      }, 500);
    }
  } catch (err) {
    toast(err.message || err?.details || 'Could not save invoice');
  } finally {
    setBusy(false);
  }
}

function getCustomerInfo() {
  // Returns customer details from either the saved record or manual entry fields
  const customerId = $('bill-customer').value;
  if (customerId) {
    return state.customers.find((c) => c.id === customerId) || {};
  }
  // Walk-in / manual
  const name    = $('manual-cust-name').value.trim();
  const phone   = $('manual-cust-phone').value.trim();
  const address = $('manual-cust-address').value.trim();
  const gstin   = $('manual-cust-gstin').value.trim();
  return { name, phone, address, gstin };
}

function printInvoicePreview() {
  const previewEl = $('invoice-preview');
  const win = window.open('', '_blank', 'width=800,height=700');
  win.document.write(`<!DOCTYPE html><html><head>
    <title>Invoice</title>
    <style>
      body { font-family: Arial, sans-serif; font-size: 13px; padding: 2rem; color: #111; }
      h2 { margin: 0 0 0.25rem; }
      p  { margin: 0.15rem 0; }
      table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
      th, td { padding: 0.5rem 0.6rem; border: 1px solid #ddd; text-align: left; }
      th { background: #f5f5f5; font-weight: 600; }
      .money { text-align: right; }
      .invoice-head { display: flex; justify-content: space-between; border-bottom: 2px solid #333; padding-bottom: 1rem; margin-bottom: 1rem; }
      .customer-block { background: #f9f9f9; border: 1px solid #ddd; border-radius: 4px; padding: 0.75rem 1rem; margin-bottom: 1rem; }
      .customer-block h4 { margin: 0 0 0.4rem; font-size: 0.85em; color: #666; text-transform: uppercase; letter-spacing: 0.05em; }
      .invoice-total { text-align: right; margin-top: 0.5rem; }
      .invoice-total p, .invoice-total strong { display: flex; justify-content: flex-end; gap: 2rem; margin: 0.2rem 0; }
      .invoice-total strong { font-size: 1.1em; border-top: 1px solid #333; padding-top: 0.4rem; margin-top: 0.4rem; }
      @media print { body { padding: 0; } }
    </style>
  </head><body>${previewEl.innerHTML}</body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => { win.print(); }, 400);
}

function buildQrHTML(qrUrl) {
  if (!qrUrl) return '';
  return `
    <div class="qr-block">
      <img src="${esc(qrUrl)}" alt="Payment QR" class="qr-img">
      <p class="qr-label">Scan to Pay</p>
    </div>`;
}

function renderInvoicePreview(subtotal = 0, gst = 0) {
  const business  = state.business || {};
  const total     = subtotal + gst;
  const isChallan = $('bill-type').value === 'challan';
  const customer  = getCustomerInfo();
  const qrUrl     = business.payment_qr_url || null;

  // QR shown in the business header block (top-right, below invoice meta)
  const qrHTML = buildQrHTML(qrUrl);

  // Customer block (only if we have at least a name)
  const custHTML = customer.name ? `
    <div class="customer-block">
      <h4>Bill To</h4>
      <strong>${esc(customer.name)}</strong>
      ${customer.phone   ? `<p>${esc(customer.phone)}</p>`   : ''}
      ${customer.address ? `<p>${esc(customer.address)}</p>` : ''}
      ${customer.gstin   ? `<p>GSTIN: ${esc(customer.gstin)}</p>` : ''}
    </div>` : '';

  $('invoice-preview').innerHTML = `
    <div class="preview-toolbar">
      <span class="preview-label">Live Preview</span>
      <button class="btn ghost small" onclick="printInvoicePreview()">🖨 Print Preview</button>
    </div>
    <div id="printable-invoice">
      <div class="invoice-head">
        <div>
          <h2>${esc(business.name || 'Your Business')}</h2>
          <p>${esc(business.address || '')}</p>
          <p>${esc(business.phone || '')}${business.email ? ' | ' + esc(business.email) : ''}</p>
          <p>${business.gstin ? 'GSTIN: ' + esc(business.gstin) : ''}</p>
          ${qrHTML}
        </div>
        <div style="text-align:right">
          <h2>${$('bill-type').selectedOptions[0]?.textContent || 'Invoice'}</h2>
          <p>Date: ${esc($('bill-date').value || today())}</p>
          <p>Payment: ${esc($('bill-payment').value)}</p>
        </div>
      </div>
      ${custHTML}
      <table>
        <thead><tr><th>Item</th><th>Qty</th><th>Rate</th><th>GST</th><th class="money">Amount</th></tr></thead>
        <tbody>${state.billLines.map((line) => {
          const base = line.quantity * line.unit_price;
          const tax  = isChallan ? 0 : base * line.gst_rate / 100;
          return `<tr><td>${esc(line.name)}</td><td>${line.quantity}</td><td>₹${money(line.unit_price)}</td><td>${isChallan ? '—' : line.gst_rate + '%'}</td><td class="money">₹${money(base + tax)}</td></tr>`;
        }).join('') || emptyRow(5, 'Add items to see the invoice preview')}</tbody>
      </table>
      <div class="invoice-total"><div>
        <p><span>Subtotal</span><span>₹${money(subtotal)}</span></p>
        ${!isChallan ? `<p><span>GST</span><span>₹${money(gst)}</span></p>` : ''}
        <strong><span>Total</span><span>₹${money(total)}</span></strong>
      </div></div>
    </div>`;
}

// ── Invoices ──────────────────────────────────────────────────────────────────
function renderInvoices() {
  const q = $('invoice-search').value.toLowerCase();
  const rows = state.invoices
    .filter((inv) => {
      const customer = state.customers.find((c) => c.id === inv.customer_id);
      return !q || [inv.invoice_no, customer?.name].join(' ').toLowerCase().includes(q);
    })
    .map((inv) => {
      const customer = state.customers.find((c) => c.id === inv.customer_id);
      const count    = state.invoiceItems.filter((i) => i.invoice_id === inv.id).length;
      return `<tr>
        <td><strong>${esc(inv.invoice_no)}</strong></td>
        <td>${esc(customer?.name || 'Walk-in')}</td>
        <td>${esc(inv.invoice_date)}</td>
        <td>${count}</td>
        <td>₹${money(inv.gst_total)}</td>
        <td><strong>₹${money(inv.total)}</strong></td>
        <td style="white-space:nowrap">
          <button class="text-btn" onclick="viewInvoice('${inv.id}')">View</button>
          <button class="text-btn" style="margin-left:0.4rem" onclick="editInvoiceDialog('${inv.id}')">Edit</button>
        </td>
      </tr>`;
    });
  $('invoices-table').innerHTML = rows.join('') || emptyRow(7, 'No invoices yet');
}

// ── Invoice view (print-ready modal) ─────────────────────────────────────────
window.viewInvoice = function(invoiceId) {
  const inv      = state.invoices.find((i) => i.id === invoiceId);
  if (!inv) return;
  const items    = state.invoiceItems.filter((i) => i.invoice_id === invoiceId);
  const customer = state.customers.find((c) => c.id === inv.customer_id);
  const business = state.business || {};
  const isChallan = inv.invoice_type === 'challan';
  const qrUrl    = state.business?.payment_qr_url || null;
  const qrHTML   = buildQrHTML(qrUrl);

  const custHTML = customer ? `
    <div class="customer-block">
      <h4>Bill To</h4>
      <strong>${esc(customer.name)}</strong>
      ${customer.phone   ? `<p>${esc(customer.phone)}</p>`   : ''}
      ${customer.address ? `<p>${esc(customer.address)}</p>` : ''}
      ${customer.gstin   ? `<p>GSTIN: ${esc(customer.gstin)}</p>` : ''}
    </div>` : '';

  let subtotal = 0, gstTotal = 0;
  const itemRows = items.map((item) => {
    // Use the names saved at sale time (product_name, variant_name stored in invoice_items)
    // Fall back to live product state if missing (older records)
    const product    = state.products.find((p) => p.id === item.product_id);
    const savedName  = item.product_name || product?.name || 'Item';
    const savedVar   = item.variant_name || null;
    const size       = product?.size ? ' (Size ' + product.size + ')' : '';
    const displayName = savedVar ? `${savedName}${size} — ${savedVar}` : `${savedName}${size}`;
    const gstRate    = Number(item.gst_rate ?? product?.gst_rate ?? 0);
    const base       = Number(item.quantity) * Number(item.unit_price);
    const tax        = isChallan ? 0 : base * gstRate / 100;
    subtotal  += base;
    gstTotal  += tax;
    return `<tr>
      <td>${esc(displayName)}</td>
      <td style="text-align:center">${item.quantity}</td>
      <td class="money">₹${money(item.unit_price)}</td>
      <td style="text-align:center">${isChallan ? '—' : gstRate + '%'}</td>
      <td class="money">₹${money(base + tax)}</td>
    </tr>`;
  }).join('');
  const total = subtotal + gstTotal;

  // qrHTML built by buildQrHTML() called above

  const html = `
    <div class="invoice-head">
      <div>
        <h2>${esc(business.name || 'Your Business')}</h2>
        ${business.address ? `<p>${esc(business.address)}</p>` : ''}
        ${business.phone   ? `<p>${esc(business.phone)}${business.email ? ' | ' + esc(business.email) : ''}</p>` : ''}
        ${business.gstin   ? `<p>GSTIN: ${esc(business.gstin)}</p>` : ''}
      </div>
      <div style="text-align:right">
        <h2>${esc(inv.invoice_type?.replace('_', ' ').toUpperCase() || 'INVOICE')}</h2>
        <p><strong>${esc(inv.invoice_no)}</strong></p>
        <p>Date: ${esc(inv.invoice_date)}</p>
        <p>Payment: ${esc(inv.payment_mode || '')}</p>
      </div>
    </div>
    ${custHTML}
    <table>
      <thead><tr><th>Item</th><th style="text-align:center">Qty</th><th class="money">Rate</th><th style="text-align:center">GST</th><th class="money">Amount</th></tr></thead>
      <tbody>${itemRows || '<tr><td colspan="5" style="color:#999">No items</td></tr>'}</tbody>
    </table>
    <div class="invoice-total"><div>
      <p><span>Subtotal</span><span>₹${money(subtotal)}</span></p>
      ${!isChallan ? `<p><span>GST</span><span>₹${money(gstTotal)}</span></p>` : ''}
      <strong><span>Total</span><span>₹${money(total)}</span></strong>
    </div></div>
    ${qrHTML}`;

  $('inv-modal-body').innerHTML = html;
  $('inv-modal-invoice-id').value = invoiceId;
  $('invoice-view-dialog').showModal();
};

// Print from view modal
window.printViewedInvoice = function() {
  const body     = $('inv-modal-body').innerHTML;
  const business = state.business || {};
  const win = window.open('', '_blank', 'width=820,height=750');
  win.document.write(buildPrintHTML(body));
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 400);
};

function buildPrintHTML(bodyHTML) {
  return `<!DOCTYPE html><html><head><title>Invoice</title><style>
    body{font-family:Arial,sans-serif;font-size:13px;padding:2rem;color:#111}
    h2{margin:0 0 .25rem}p{margin:.15rem 0}
    table{width:100%;border-collapse:collapse;margin:1rem 0}
    th,td{padding:.5rem .6rem;border:1px solid #ddd;text-align:left}
    th{background:#f5f5f5;font-weight:600}
    .money{text-align:right}
    .invoice-head{display:flex;justify-content:space-between;border-bottom:2px solid #333;padding-bottom:1rem;margin-bottom:1rem}
    .customer-block{background:#f9f9f9;border:1px solid #ddd;border-radius:4px;padding:.75rem 1rem;margin-bottom:1rem}
    .customer-block h4{margin:0 0 .4rem;font-size:.85em;color:#666;text-transform:uppercase;letter-spacing:.05em}
    .invoice-total{text-align:right;margin-top:.5rem}
    .invoice-total p,.invoice-total strong{display:flex;justify-content:flex-end;gap:2rem;margin:.2rem 0}
    .invoice-total strong{font-size:1.1em;border-top:1px solid #333;padding-top:.4rem;margin-top:.4rem}
    .qr-block{display:inline-flex;flex-direction:column;align-items:flex-start;margin-top:.75rem;gap:.25rem}
    .qr-img{width:70px;height:70px;object-fit:contain;border:1px solid #e5e7eb;border-radius:6px;padding:3px;background:#fff}
    .qr-label{font-size:.72em;color:#6b7280;margin:0;text-align:center;width:70px}
    .preview-toolbar{display:none}
    @page{size:A5;margin:14mm}
    @media print{body{padding:0}}
  </style></head><body>${bodyHTML}</body></html>`;
}


// ── Invoice edit dialog — full editor ────────────────────────────────────────
// editLines holds the mutable copy of invoice items while editing
let editLines = [];

window.editInvoiceDialog = function(invoiceId) {
  const inv   = state.invoices.find((i) => i.id === invoiceId);
  if (!inv) return;

  // Deep-copy the saved items so edits don't mutate state
  editLines = state.invoiceItems
    .filter((i) => i.invoice_id === invoiceId)
    .map((i) => {
      const product = state.products.find((p) => p.id === i.product_id);
      const size    = product?.size ? ' (Size ' + product.size + ')' : '';
      const label   = i.variant_name
        ? `${i.product_name}${size} — ${i.variant_name}`
        : `${i.product_name}${size}`;
      return {
        id:          i.id,           // existing DB row
        product_id:  i.product_id,
        variant_id:  i.variant_id,
        name:        label,
        quantity:    Number(i.quantity),
        unit_price:  Number(i.unit_price),
        gst_rate:    Number(i.gst_rate),
        line_subtotal: Number(i.line_subtotal),
        line_gst:    Number(i.line_gst),
        line_total:  Number(i.line_total),
      };
    });

  $('edit-inv-id').value      = invoiceId;
  $('edit-inv-date').value    = inv.invoice_date || today();
  $('edit-inv-payment').value = inv.payment_mode || 'Cash';
  $('edit-inv-type').value    = inv.invoice_type || 'tax_invoice';
  $('edit-inv-notes').value   = inv.notes || '';

  // Populate add-item dropdowns
  const opts = '<option value="">— Select product —</option>' +
    state.products.map((p) => {
      const sz = p.size ? ` (Size ${p.size})` : '';
      return `<option value="${p.id}">${esc(p.name)}${sz} · Stock ${p.stock_qty}</option>`;
    }).join('');
  $('edit-inv-product').innerHTML = opts;
  $('edit-inv-variant').innerHTML = '<option value="">Base product</option>';

  renderEditLines();
  $('invoice-edit-dialog').showModal();
};

function renderEditLines() {
  const isChallan = $('edit-inv-type').value === 'challan';
  let subtotal = 0, gst = 0;
  $('edit-inv-lines').innerHTML = editLines.map((line, idx) => {
    const base = line.quantity * line.unit_price;
    const tax  = isChallan ? 0 : base * line.gst_rate / 100;
    subtotal += base; gst += tax;
    return `<tr>
      <td>${esc(line.name)}</td>
      <td><input type="number" min="1" value="${line.quantity}" style="width:60px;padding:0.2rem 0.4rem"
           onchange="updateEditLineQty(${idx}, this.value)"></td>
      <td><input type="number" min="0" step="0.01" value="${line.unit_price}" style="width:80px;padding:0.2rem 0.4rem"
           onchange="updateEditLinePrice(${idx}, this.value)"></td>
      <td style="text-align:center">${isChallan ? '—' : line.gst_rate + '%'}</td>
      <td class="money">₹${money(base + tax)}</td>
      <td><button class="text-btn" style="color:#ef4444" onclick="removeEditLine(${idx})">✕</button></td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" style="color:#999;text-align:center">No items</td></tr>';

  $('edit-inv-subtotal').textContent = '₹' + money(subtotal);
  $('edit-inv-gst').textContent      = isChallan ? '—' : '₹' + money(gst);
  $('edit-inv-total').textContent    = '₹' + money(subtotal + gst);
}

window.updateEditLineQty = function(idx, val) {
  editLines[idx].quantity = Math.max(1, Number(val) || 1);
  renderEditLines();
};
window.updateEditLinePrice = function(idx, val) {
  editLines[idx].unit_price = Math.max(0, Number(val) || 0);
  renderEditLines();
};
window.removeEditLine = function(idx) {
  editLines.splice(idx, 1);
  renderEditLines();
};

// When product changes in the add-item row of the edit dialog
window.onEditInvProductChange = function() {
  const productId = $('edit-inv-product').value;
  const vars = state.variants.filter((v) => v.product_id === productId);
  $('edit-inv-variant').innerHTML = '<option value="">Base product</option>' +
    vars.map((v) => `<option value="${v.id}">${esc(v.name)} · Stock ${v.stock_qty}</option>`).join('');
};

window.addEditInvLine = function() {
  const product = state.products.find((p) => p.id === $('edit-inv-product').value);
  if (!product) return toast('Select a product to add');
  const variant = state.variants.find((v) => v.id === $('edit-inv-variant').value);
  const qty     = Math.max(1, Number($('edit-inv-qty').value) || 1);
  const price   = Number(variant?.selling_price || product.selling_price || 0);
  const size    = product.size ? ` (Size ${product.size})` : '';
  const label   = variant
    ? `${product.name}${size} — ${variant.name}`
    : `${product.name}${size}`;

  // Merge if same product+variant already in list
  const existing = editLines.find((l) =>
    l.product_id === product.id && (l.variant_id || '') === (variant?.id || '')
  );
  if (existing) {
    existing.quantity += qty;
  } else {
    editLines.push({
      id: null,  // new line, no DB row yet
      product_id: product.id,
      variant_id: variant?.id || null,
      name:       label,
      quantity:   qty,
      unit_price: price,
      gst_rate:   Number(product.gst_rate || 0),
    });
  }
  $('edit-inv-qty').value = 1;
  renderEditLines();
};

window.saveInvoiceEdits = async function() {
  const id = $('edit-inv-id').value;
  if (!id || !editLines.length) return toast('Invoice must have at least one item');
  setBusy(true);
  try {
    const isChallan = $('edit-inv-type').value === 'challan';
    let subtotal = 0, gstTotal = 0;

    const newItems = editLines.map((line) => {
      const base = line.quantity * line.unit_price;
      const tax  = isChallan ? 0 : Math.round(base * line.gst_rate) / 100;
      subtotal  += base;
      gstTotal  += tax;
      const product = state.products.find((p) => p.id === line.product_id);
      const variant = state.variants.find((v) => v.id === line.variant_id);
      return {
        user_id:       state.session.user.id,
        invoice_id:    id,
        product_id:    line.product_id,
        variant_id:    line.variant_id || null,
        product_name:  product?.name || line.name,
        variant_name:  variant?.name || null,
        hsn:           product?.hsn || null,
        quantity:      line.quantity,
        unit_price:    line.unit_price,
        gst_rate:      line.gst_rate,
        line_subtotal: parseFloat(base.toFixed(2)),
        line_gst:      parseFloat(tax.toFixed(2)),
        line_total:    parseFloat((base + tax).toFixed(2)),
      };
    });
    const total = subtotal + gstTotal;

    // Delete old items and re-insert (simpler than diffing)
    const { error: delErr } = await state.client
      .from('invoice_items').delete().eq('invoice_id', id);
    if (delErr) throw delErr;

    const { error: insErr } = await state.client
      .from('invoice_items').insert(newItems);
    if (insErr) throw insErr;

    // Update invoice header
    const { error: updErr } = await state.client.from('invoices').update({
      invoice_date: $('edit-inv-date').value,
      payment_mode: $('edit-inv-payment').value,
      invoice_type: $('edit-inv-type').value,
      notes:        $('edit-inv-notes').value.trim() || null,
      subtotal:     parseFloat(subtotal.toFixed(2)),
      gst_total:    parseFloat(gstTotal.toFixed(2)),
      total:        parseFloat(total.toFixed(2)),
    }).eq('id', id);
    if (updErr) throw updErr;

    $('invoice-edit-dialog').close();
    await refresh();
    toast('Invoice updated');
  } catch (err) {
    toast(err.message || 'Could not update invoice');
  } finally {
    setBusy(false);
  }
};


// ── Products: delete ─────────────────────────────────────────────────────

window.deleteProduct = async function(productId) {
  if (!productId) return;
  if (!confirm('Delete this product? This will remove the product (and its variants).')) return;
  setBusy(true);
  try {
    const { error } = await state.client.from('products').delete().eq('id', productId);
    if (error) throw error;
    await refresh();
    toast('Product deleted');
  } catch (err) {
    toast(err.message || 'Could not delete product');
  } finally {
    setBusy(false);
  }
};

// ── Invoices: delete (with stock restore) ────────────────────────────────
window.deleteInvoice = async function() {
  const id = $('edit-inv-id').value;
  if (!id) return;
  if (!confirm('Delete this invoice? Stock will be restored. This cannot be undone.')) return;
  setBusy(true);
  try {
    const { error } = await state.client.rpc('delete_invoice_and_restore_stock', { p_invoice_id: id });
    if (error) throw error;
    $('invoice-edit-dialog').close();
    await refresh();
    toast('Invoice deleted (stock restored)');
  } catch (err) {
    toast(err.message || 'Could not delete invoice');
  } finally {
    setBusy(false);
  }
};

// ── Customers ─────────────────────────────────────────────────────────────────
async function saveCustomer() {
  const name = $('customer-name').value.trim();
  if (!name) return toast('Customer name is required');
  setBusy(true);
  try {
    const { error } = await state.client.from('customers').insert({
      name,
      phone:   $('customer-phone').value.trim()  || null,
      email:   $('customer-email').value.trim()  || null,
      gstin:   $('customer-gstin').value.trim()  || null,
      address: $('customer-address').value.trim()|| null,
    });
    if (error) throw error;
    ['customer-name','customer-phone','customer-email','customer-gstin','customer-address'].forEach((id) => $(id).value = '');
    await refresh();
    toast('Customer saved');
  } catch (err) {
    toast(err.message || 'Could not save customer');
  } finally {
    setBusy(false);
  }
}

function renderCustomers() {
  $('customers-list').innerHTML = listOrEmpty(state.customers.map((c) =>
    `<div class="list-item"><div><strong>${esc(c.name)}</strong><span>${esc(c.phone || 'No phone')}${c.gstin ? ' · GSTIN ' + esc(c.gstin) : ''}</span></div></div>`
  ));
}

// ── Settings ──────────────────────────────────────────────────────────────────
function hydrateSettings() {
  $('biz-name').value    = state.business?.name    || '';
  $('biz-gstin').value   = state.business?.gstin   || '';
  $('biz-phone').value   = state.business?.phone   || '';
  $('biz-email').value   = state.business?.email   || '';
  $('biz-address').value = state.business?.address || '';
  $('set-low-stock').value = state.settings.low_stock_threshold || 10;
  $('set-gst').value       = state.settings.default_gst  || 12;
  $('set-unit').value      = state.settings.default_unit || 'pcs';
  // QR preview
  const qrUrl = state.business?.payment_qr_url || null;
  const qrPreview = $('qr-preview');
  const qrEmpty   = $('qr-empty');
  if (qrUrl) {
    qrPreview.src = qrUrl;
    qrPreview.style.display = 'block';
    if (qrEmpty) qrEmpty.style.display = 'none';
  } else {
    qrPreview.style.display = 'none';
    if (qrEmpty) qrEmpty.style.display = 'flex';
  }
}

async function saveBusiness() {
  setBusy(true);
  try {
    const payload = {
      user_id: state.session.user.id,
      name:    $('biz-name').value.trim()    || 'My Business',
      gstin:   $('biz-gstin').value.trim()   || null,
      phone:   $('biz-phone').value.trim()   || null,
      email:   $('biz-email').value.trim()   || null,
      address: $('biz-address').value.trim() || null,
      // QR code stored as base64 data URL; only update if changed
      payment_qr_url: state._pendingQrUrl !== undefined
        ? state._pendingQrUrl
        : (state.business?.payment_qr_url || null),
    };
    const { error } = await state.client.from('business_profiles').upsert(payload, { onConflict: 'user_id' });
    if (!error) state._pendingQrUrl = undefined; // clear pending
    if (error) throw error;
    await refresh();
    toast('Business profile saved');
  } catch (err) {
    toast(err.message || 'Could not save business profile');
  } finally {
    setBusy(false);
  }
}

async function saveSettings() {
  setBusy(true);
  try {
    const { error } = await state.client.from('business_settings').upsert({
      user_id:             state.session.user.id,
      low_stock_threshold: Number($('set-low-stock').value || 10),
      default_gst:         Number($('set-gst').value || 12),
      default_unit:        $('set-unit').value.trim() || 'pcs',
    }, { onConflict: 'user_id' });
    if (error) throw error;
    await refresh();
    toast('Defaults saved');
  } catch (err) {
    toast(err.message || 'Could not save settings');
  } finally {
    setBusy(false);
  }
}

// ── Reports ───────────────────────────────────────────────────────────────────
function renderReport() {
  const from = $('report-from').value;
  const to   = $('report-to').value;
  const invoices = state.invoices.filter((inv) =>
    (!from || inv.invoice_date >= from) && (!to || inv.invoice_date <= to)
  );
  const revenue = invoices.reduce((s, inv) => s + Number(inv.total     || 0), 0);
  const gst     = invoices.reduce((s, inv) => s + Number(inv.gst_total || 0), 0);
  $('report-preview').innerHTML = `
    <div class="stats-grid">
      <div class="stat"><span>Total sales</span><strong>₹${money(revenue)}</strong></div>
      <div class="stat"><span>GST</span><strong>₹${money(gst)}</strong></div>
      <div class="stat"><span>Invoices</span><strong>${invoices.length}</strong></div>
      <div class="stat"><span>Average bill</span><strong>₹${money(invoices.length ? revenue / invoices.length : 0)}</strong></div>
    </div>
    <table>
      <thead><tr><th>Invoice</th><th>Date</th><th>Type</th><th class="money">GST</th><th class="money">Total</th></tr></thead>
      <tbody>${invoices.map((inv) =>
        `<tr><td>${esc(inv.invoice_no)}</td><td>${esc(inv.invoice_date)}</td><td>${esc(inv.invoice_type)}</td><td class="money">₹${money(inv.gst_total)}</td><td class="money">₹${money(inv.total)}</td></tr>`
      ).join('') || emptyRow(5, 'No invoices in this period')}</tbody>
    </table>`;
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function listOrEmpty(items) {
  return items.length
    ? `<div class="list">${items.join('')}</div>`
    : '<p class="muted">Nothing to show yet.</p>';
}

function emptyRow(colspan, text) {
  return `<tr><td colspan="${colspan}" class="muted">${text}</td></tr>`;
}

// ── QR code upload ───────────────────────────────────────────────────────────
function wireQrUpload() {
  const input   = $('qr-file-input');
  const preview = $('qr-preview');
  const empty   = $('qr-empty');
  const removeBtn = $('qr-remove-btn');

  if (!input) return;

  // Click on the zone triggers file picker
  $('qr-upload-zone')?.addEventListener('click', () => input.click());

  input.addEventListener('change', () => {
    const file = input.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) return toast('QR image must be under 2MB');
    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target.result;
      state._pendingQrUrl = dataUrl;
      preview.src = dataUrl;
      preview.style.display = 'block';
      if (empty) empty.style.display = 'none';
      toast('QR loaded — click Save Profile to apply');
    };
    reader.readAsDataURL(file);
    input.value = ''; // reset so same file can be re-selected
  });

  removeBtn?.addEventListener('click', () => {
    state._pendingQrUrl = null;
    preview.src = '';
    preview.style.display = 'none';
    if (empty) empty.style.display = 'flex';
    toast('QR removed — click Save Profile to apply');
  });
}

boot();