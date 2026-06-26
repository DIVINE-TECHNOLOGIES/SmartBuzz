const CONFIG_KEY = 'smartbuzz_supabase_config';

const state = {
  client: null,
  session: null,
  authMode: 'login',
  page: 'dashboard',
  business: null,
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
  $('content-loader').classList.toggle('hidden', !isBusy);
}

function show(view) {
  ['config-view', 'auth-view', 'app'].forEach((id) => $(id).classList.add('hidden'));
  $(view).classList.remove('hidden');
}

function getConfig() {
  try {
    return JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null');
  } catch {
    return null;
  }
}

function saveConfig(config) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

function makeClient(config) {
  if (!window.supabase) throw new Error('Supabase library failed to load');
  state.client = window.supabase.createClient(config.url, config.key);
}

async function boot() {
  try {
    const bootLoader = $('boot-loader');
    const cfgView = $('config-view');
    const authView = $('auth-view');

    // Guard against missing DOM nodes
    if ($('stock-date')) $('stock-date').value = today();
    if ($('bill-date')) $('bill-date').value = today();
    wireEvents();

    const config = getConfig();
    if (!config?.url || !config?.key) {
      if (bootLoader) bootLoader.classList.add('hidden');
      if (cfgView) show('config-view');
      return;
    }

    try {
      makeClient(config);
      const { data } = await state.client.auth.getSession();
      state.session = data.session || null;
      if (bootLoader) bootLoader.classList.add('hidden');
      if (!state.session) {
        if (authView) show('auth-view');
        return;
      }
      await enterApp();
    } catch (error) {
      if (bootLoader) bootLoader.classList.add('hidden');
      if (cfgView) show('config-view');
      toast(error.message || 'Could not connect to Supabase');
    }
  } catch (error) {
    // Last-resort: ensure we never stay stuck on loader
    const bootLoader = $('boot-loader');
    if (bootLoader) bootLoader.classList.add('hidden');
    if ($('config-view')) show('config-view');
    toast(error.message || 'App failed to start');
  }
}


function wireEvents() {
  $('save-config-btn').addEventListener('click', () => {
    const url = $('cfg-url').value.trim();
    const key = $('cfg-key').value.trim();
    if (!/^https:\/\/.+\.supabase\.co$/i.test(url) || key.length < 40) return toast('Enter a valid Supabase URL and anon key');
    saveConfig({ url, key });
    makeClient({ url, key });
    show('auth-view');
    toast('Supabase connection saved');
  });

  $('change-config-btn').addEventListener('click', () => {
    const config = getConfig();
    $('cfg-url').value = config?.url || '';
    $('cfg-key').value = config?.key || '';
    show('config-view');
  });

  document.querySelectorAll('[data-auth-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.authMode = btn.dataset.authMode;
      $('login-tab').classList.toggle('active', state.authMode === 'login');
      $('signup-tab').classList.toggle('active', state.authMode === 'signup');
      $('auth-submit-btn').textContent = state.authMode === 'login' ? 'Login' : 'Create account';
    });
  });

  $('auth-submit-btn').addEventListener('click', handleAuth);
  $('logout-btn').addEventListener('click', async () => {
    await state.client.auth.signOut();
    state.session = null;
    show('auth-view');
  });

  $('nav').addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-page]');
    if (btn) navigate(btn.dataset.page);
  });
  document.querySelectorAll('[data-page-link]').forEach((el) => el.addEventListener('click', () => navigate(el.dataset.pageLink)));

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

  // Import events wired here — single place, always runs
  wireImportEvents();
}

async function handleAuth() {
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
    await enterApp();
  } catch (error) {
    toast(error.message || 'Authentication failed');
  } finally {
    setBusy(false);
  }
}

async function enterApp() {
  show('app');
  $('user-email').textContent = state.session.user.email;
  await refresh();
  navigate('dashboard');
}

async function refresh() {
  if (!state.client || !state.session) return;
  setBusy(true);
  try {
    const [
      businessRes,
      settingsRes,
      productsRes,
      variantsRes,
      customersRes,
      invoicesRes,
      itemsRes,
      stockRes,
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

    state.business = businessRes.data || null;
    state.settings = settingsRes.data || state.settings;
    state.products = productsRes.data || [];
    state.variants = variantsRes.data || [];
    state.customers = customersRes.data || [];
    state.invoices = invoicesRes.data || [];
    state.invoiceItems = itemsRes.data || [];
    state.stockMovements = stockRes.data || [];

    hydrateSettings();
    renderAll();
  } catch (error) {
    toast(error.message || 'Could not load data. Check schema setup.');
  } finally {
    setBusy(false);
  }
}

function navigate(page) {
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

function variantsFor(productId) {
  return state.variants.filter((v) => v.product_id === productId);
}

function currentStock(product) {
  const vars = variantsFor(product.id);
  return vars.length ? vars.reduce((sum, v) => sum + Number(v.stock_qty || 0), 0) : Number(product.stock_qty || 0);
}

function renderDashboard() {
  const revenue = state.invoices.reduce((sum, inv) => sum + Number(inv.total || 0), 0);
  const gst = state.invoices.reduce((sum, inv) => sum + Number(inv.gst_total || 0), 0);
  const threshold = Number(state.settings.low_stock_threshold || 10);
  const low = state.products.filter((p) => currentStock(p) <= threshold);
  $('stats-grid').innerHTML = [
    ['Revenue', `₹${money(revenue)}`],
    ['Invoices', state.invoices.length],
    ['GST Collected', `₹${money(gst)}`],
    ['Low Stock', low.length],
  ].map(([label, value]) => `<div class="stat"><span>${label}</span><strong>${value}</strong></div>`).join('');

  $('recent-invoices').innerHTML = listOrEmpty(state.invoices.slice(0, 6).map((inv) => {
    const customer = state.customers.find((c) => c.id === inv.customer_id);
    return `<div class="list-item"><div><strong>${esc(inv.invoice_no)}</strong><span>${esc(customer?.name || 'Walk-in')} · ${esc(inv.invoice_date)}</span></div><strong>₹${money(inv.total)}</strong></div>`;
  }));

  $('low-stock-label').textContent = `Threshold ${threshold}`;
  $('low-stock-list').innerHTML = listOrEmpty(low.slice(0, 8).map((p) => (
    `<div class="list-item"><div><strong>${esc(p.name)}</strong><span>${esc(p.category || 'General')}</span></div><span class="pill amber">${currentStock(p)} ${esc(p.unit || 'pcs')}</span></div>`
  )));
}

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
        <td><button class="text-btn" onclick="editProduct('${p.id}')">Edit</button></td>
      </tr>`;
    });
  $('products-table').innerHTML = rows.join('') || emptyRow(8, 'No products yet. Add one or import from CSV.');
  populateProductSelects();
}

function populateProductSelects() {
  const options = '<option value="">Select product</option>' +
    state.products.map((p) => {
      const label = p.size ? `${esc(p.name)} (${esc(p.size)}) · Stock ${currentStock(p)}` : `${esc(p.name)} · Stock ${currentStock(p)}`;
      return `<option value="${p.id}">${label}</option>`;
    }).join('');
  ['stock-product', 'bill-product'].forEach((id) => {
    const el = $(id);
    const value = el.value;
    el.innerHTML = options;
    if (value) el.value = value;
  });
  populateStockVariants();
  populateBillVariants();
}

function populateVariantSelect(selectId, productId, includeBase = true) {
  const vars = variantsFor(productId);
  const base = includeBase ? '<option value="">Base product</option>' : '<option value="">Select variant</option>';
  $(selectId).innerHTML = base + vars.map((v) => `<option value="${v.id}">${esc(v.name)} · Stock ${Number(v.stock_qty || 0)}</option>`).join('');
}

function populateStockVariants() {
  populateVariantSelect('stock-variant', $('stock-product').value, true);
}

function populateBillVariants() {
  populateVariantSelect('bill-variant', $('bill-product').value, true);
}

function openProductDialog() {
  $('product-dialog-title').textContent = 'Add Product';
  $('product-id').value = '';
  ['p-name', 'p-sku', 'p-size', 'p-category', 'p-price', 'p-purchase', 'p-mrp', 'p-hsn', 'p-expiry'].forEach((id) => $(id).value = '');
  $('p-unit').value = state.settings.default_unit || 'pcs';
  $('p-gst').value = state.settings.default_gst || 12;
  $('variant-editor').innerHTML = '';
  $('product-dialog').showModal();
}

window.editProduct = function editProduct(id) {
  const p = state.products.find((item) => item.id === id);
  if (!p) return;
  $('product-dialog-title').textContent = 'Edit Product';
  $('product-id').value = p.id;
  $('p-name').value = p.name || '';
  $('p-sku').value = p.sku || '';
  $('p-size').value = p.size || '';
  $('p-category').value = p.category || '';
  $('p-unit').value = p.unit || 'pcs';
  $('p-price').value = p.selling_price || 0;
  $('p-purchase').value = p.purchase_price || 0;
  $('p-mrp').value = p.mrp || 0;
  $('p-gst').value = p.gst_rate || 0;
  $('p-hsn').value = p.hsn || '';
  $('p-expiry').value = p.expiry_date || '';
  $('variant-editor').innerHTML = '';
  variantsFor(id).forEach((v) => addVariantRow(v));
  $('product-dialog').showModal();
};

function addVariantRow(v = {}) {
  const row = document.createElement('div');
  row.className = 'variant-row';
  row.innerHTML = `
    <input class="var-name" placeholder="Variant name" value="${esc(v.name || '')}">
    <input class="var-stock" type="number" min="0" placeholder="Stock" value="${Number(v.stock_qty || 0)}">
    <input class="var-price" type="number" min="0" step="0.01" placeholder="Price" value="${Number(v.selling_price || 0)}">
    <button class="icon-btn" type="button">✕</button>
    <input class="var-id" type="hidden" value="${esc(v.id || '')}">
  `;
  row.querySelector('button').addEventListener('click', () => row.remove());
  $('variant-editor').appendChild(row);
}

async function saveProduct() {
  const name = $('p-name').value.trim();
  const price = Number($('p-price').value || 0);
  if (!name) return toast('Product name is required');
  if (price < 0) return toast('Selling price cannot be negative');
  setBusy(true);
  try {
    const id = $('product-id').value || undefined;
    const payload = {
      name,
      sku: $('p-sku').value.trim() || null,
      size: $('p-size').value.trim() || null,
      category: $('p-category').value.trim() || 'General',
      unit: $('p-unit').value.trim() || 'pcs',
      selling_price: price,
      purchase_price: Number($('p-purchase').value || 0),
      mrp: Number($('p-mrp').value || price),
      gst_rate: Number($('p-gst').value || 0),
      hsn: $('p-hsn').value.trim() || null,
      expiry_date: $('p-expiry').value || null,
    };
    const { data, error } = id
      ? await state.client.from('products').update(payload).eq('id', id).select('id').single()
      : await state.client.from('products').insert(payload).select('id').single();
    if (error) throw error;
    const productId = data.id;

    const variantRows = [...document.querySelectorAll('.variant-row')].map((row) => ({
      id: row.querySelector('.var-id').value || undefined,
      product_id: productId,
      name: row.querySelector('.var-name').value.trim(),
      stock_qty: Number(row.querySelector('.var-stock').value || 0),
      selling_price: Number(row.querySelector('.var-price').value || price),
    })).filter((v) => v.name);

    if (id) {
      const existingIds = variantsFor(id).map((v) => v.id);
      const keptIds = variantRows.filter((v) => v.id).map((v) => v.id);
      const removeIds = existingIds.filter((existingId) => !keptIds.includes(existingId));
      if (removeIds.length) {
        const { error } = await state.client.from('product_variants').delete().in('id', removeIds);
        if (error) throw error;
      }
    }
    if (variantRows.length) {
      const { error } = await state.client.from('product_variants').upsert(variantRows);
      if (error) throw error;
      const totalVariantStock = variantRows.reduce((sum, v) => sum + Number(v.stock_qty || 0), 0);
      const { error: stockError } = await state.client.from('products').update({ stock_qty: totalVariantStock }).eq('id', productId);
      if (stockError) throw stockError;
    } else if (id && variantsFor(id).length) {
      const { error: stockError } = await state.client.from('products').update({ stock_qty: 0 }).eq('id', productId);
      if (stockError) throw stockError;
    }
    $('product-dialog').close();
    await refresh();
    toast('Product saved');
  } catch (error) {
    toast(error.message || 'Could not save product');
  } finally {
    setBusy(false);
  }
}

async function receiveStock() {
  const productId = $('stock-product').value;
  const variantId = $('stock-variant').value || null;
  const quantity = Number($('stock-qty').value || 0);
  if (!productId || quantity <= 0) return toast('Select product and enter quantity');
  setBusy(true);
  try {
    const { error } = await state.client.rpc('receive_stock', {
      p_product_id: productId,
      p_variant_id: variantId,
      p_quantity: quantity,
      p_source: $('stock-source').value.trim(),
      p_notes: $('stock-notes').value.trim(),
      p_received_date: $('stock-date').value || today(),
    });
    if (error) throw error;
    $('stock-qty').value = 1;
    $('stock-source').value = '';
    $('stock-notes').value = '';
    await refresh();
    toast('Stock received');
  } catch (error) {
    toast(error.message || 'Could not add stock');
  } finally {
    setBusy(false);
  }
}

function renderStock() {
  $('stock-history').innerHTML = listOrEmpty(state.stockMovements.map((m) => {
    const product = state.products.find((p) => p.id === m.product_id);
    const variant = state.variants.find((v) => v.id === m.variant_id);
    return `<div class="list-item"><div><strong>${esc(product?.name || 'Product')}</strong><span>${esc(variant?.name || 'Base product')} · ${esc(m.received_date)}</span></div><span class="pill green">+${Number(m.quantity || 0)}</span></div>`;
  }));
}

function renderBilling() {
  populateProductSelects();
  $('bill-customer').innerHTML = '<option value="">Walk-in customer</option>' +
    state.customers.map((c) => `<option value="${c.id}">${esc(c.name)} · ${esc(c.phone || '')}</option>`).join('');
  $('invoice-number').textContent = 'Next invoice will be assigned on save';
  renderBillLines();
}

function addBillLine() {
  const product = state.products.find((p) => p.id === $('bill-product').value);
  if (!product) return toast('Select a product');
  const variant = state.variants.find((v) => v.id === $('bill-variant').value);
  const qty = Number($('bill-qty').value || 0);
  if (qty <= 0) return toast('Enter quantity');
  const available = variant ? Number(variant.stock_qty || 0) : Number(product.stock_qty || 0);
  if (qty > available) return toast(`Only ${available} in stock`);
  const price = Number(variant?.selling_price || product.selling_price || 0);
  const existing = state.billLines.find((line) => line.product_id === product.id && (line.variant_id || '') === (variant?.id || ''));
  if (existing) {
    existing.quantity += qty;
  } else {
    state.billLines.push({
      product_id: product.id,
      variant_id: variant?.id || null,
      name: variant ? `${product.name} - ${variant.name}` : product.name,
      quantity: qty,
      unit_price: price,
      gst_rate: Number(product.gst_rate || 0),
      hsn: product.hsn || '',
    });
  }
  $('bill-qty').value = 1;
  renderBillLines();
}

function renderBillLines() {
  let subtotal = 0;
  let gst = 0;
  $('bill-lines').innerHTML = state.billLines.map((line, idx) => {
    const base = line.quantity * line.unit_price;
    const tax = $('bill-type').value === 'challan' ? 0 : base * line.gst_rate / 100;
    subtotal += base;
    gst += tax;
    return `<tr>
      <td>${esc(line.name)}</td>
      <td>${line.quantity}</td>
      <td>₹${money(line.unit_price)}</td>
      <td>${line.gst_rate}%</td>
      <td>₹${money(base + tax)}</td>
      <td><button class="text-btn" onclick="removeBillLine(${idx})">Remove</button></td>
    </tr>`;
  }).join('') || emptyRow(6, 'No items added');
  renderInvoicePreview(subtotal, gst);
}

window.removeBillLine = function removeBillLine(index) {
  state.billLines.splice(index, 1);
  renderBillLines();
};

async function saveInvoice() {
  if (!state.billLines.length) return toast('Add at least one item');
  setBusy(true);
  try {
    const { error } = await state.client.rpc('create_invoice', {
      p_customer_id: $('bill-customer').value || null,
      p_invoice_date: $('bill-date').value || today(),
      p_invoice_type: $('bill-type').value,
      p_payment_mode: $('bill-payment').value,
      p_items: state.billLines.map((line) => ({
        product_id: line.product_id,
        variant_id: line.variant_id,
        quantity: line.quantity,
        unit_price: line.unit_price,
      })),
    });
    if (error) throw error;
    state.billLines = [];
    await refresh();
    navigate('invoices');
    toast('Invoice saved');
  } catch (error) {
    toast(error.message || 'Could not save invoice');
  } finally {
    setBusy(false);
  }
}

function renderInvoicePreview(subtotal = 0, gst = 0) {
  const business = state.business || {};
  const total = subtotal + gst;
  $('invoice-preview').innerHTML = `
    <div class="invoice-head">
      <div>
        <h2>${esc(business.name || 'Your Business')}</h2>
        <p>${esc(business.address || '')}</p>
        <p>${esc(business.phone || '')} ${business.email ? ' | ' + esc(business.email) : ''}</p>
        <p>${business.gstin ? 'GSTIN: ' + esc(business.gstin) : ''}</p>
      </div>
      <div>
        <h2>${$('bill-type').selectedOptions[0]?.textContent || 'Invoice'}</h2>
        <p>Date: ${esc($('bill-date').value || today())}</p>
        <p>Payment: ${esc($('bill-payment').value)}</p>
      </div>
    </div>
    <table>
      <thead><tr><th>Item</th><th>Qty</th><th>Rate</th><th>GST</th><th class="money">Amount</th></tr></thead>
      <tbody>${state.billLines.map((line) => {
        const base = line.quantity * line.unit_price;
        const tax = $('bill-type').value === 'challan' ? 0 : base * line.gst_rate / 100;
        return `<tr><td>${esc(line.name)}</td><td>${line.quantity}</td><td>₹${money(line.unit_price)}</td><td>${line.gst_rate}%</td><td class="money">₹${money(base + tax)}</td></tr>`;
      }).join('') || emptyRow(5, 'Invoice preview')}</tbody>
    </table>
    <div class="invoice-total"><div>
      <p><span>Subtotal</span><span>₹${money(subtotal)}</span></p>
      <p><span>GST</span><span>₹${money(gst)}</span></p>
      <strong><span>Total</span><span>₹${money(total)}</span></strong>
    </div></div>
  `;
}

function renderInvoices() {
  const q = $('invoice-search').value.toLowerCase();
  const rows = state.invoices
    .filter((inv) => {
      const customer = state.customers.find((c) => c.id === inv.customer_id);
      return !q || [inv.invoice_no, customer?.name].join(' ').toLowerCase().includes(q);
    })
    .map((inv) => {
      const customer = state.customers.find((c) => c.id === inv.customer_id);
      const count = state.invoiceItems.filter((i) => i.invoice_id === inv.id).length;
      return `<tr>
        <td><strong>${esc(inv.invoice_no)}</strong></td>
        <td>${esc(customer?.name || 'Walk-in')}</td>
        <td>${esc(inv.invoice_date)}</td>
        <td>${count}</td>
        <td>₹${money(inv.gst_total)}</td>
        <td><strong>₹${money(inv.total)}</strong></td>
      </tr>`;
    });
  $('invoices-table').innerHTML = rows.join('') || emptyRow(6, 'No invoices yet');
}

async function saveCustomer() {
  const name = $('customer-name').value.trim();
  if (!name) return toast('Customer name is required');
  setBusy(true);
  try {
    const { error } = await state.client.from('customers').insert({
      name,
      phone: $('customer-phone').value.trim() || null,
      email: $('customer-email').value.trim() || null,
      gstin: $('customer-gstin').value.trim() || null,
      address: $('customer-address').value.trim() || null,
    });
    if (error) throw error;
    ['customer-name', 'customer-phone', 'customer-email', 'customer-gstin', 'customer-address'].forEach((id) => $(id).value = '');
    await refresh();
    toast('Customer saved');
  } catch (error) {
    toast(error.message || 'Could not save customer');
  } finally {
    setBusy(false);
  }
}

function renderCustomers() {
  $('customers-list').innerHTML = listOrEmpty(state.customers.map((c) => (
    `<div class="list-item"><div><strong>${esc(c.name)}</strong><span>${esc(c.phone || 'No phone')} ${c.gstin ? ' · GSTIN ' + esc(c.gstin) : ''}</span></div></div>`
  )));
}

function hydrateSettings() {
  $('biz-name').value = state.business?.name || '';
  $('biz-gstin').value = state.business?.gstin || '';
  $('biz-phone').value = state.business?.phone || '';
  $('biz-email').value = state.business?.email || '';
  $('biz-address').value = state.business?.address || '';
  $('set-low-stock').value = state.settings.low_stock_threshold || 10;
  $('set-gst').value = state.settings.default_gst || 12;
  $('set-unit').value = state.settings.default_unit || 'pcs';
}

async function saveBusiness() {
  setBusy(true);
  try {
    const payload = {
      user_id: state.session.user.id,
      name: $('biz-name').value.trim() || 'My Business',
      gstin: $('biz-gstin').value.trim() || null,
      phone: $('biz-phone').value.trim() || null,
      email: $('biz-email').value.trim() || null,
      address: $('biz-address').value.trim() || null,
    };
    const { error } = await state.client.from('business_profiles').upsert(payload, { onConflict: 'user_id' });
    if (error) throw error;
    await refresh();
    toast('Business profile saved');
  } catch (error) {
    toast(error.message || 'Could not save business profile');
  } finally {
    setBusy(false);
  }
}

async function saveSettings() {
  setBusy(true);
  try {
    const { error } = await state.client.from('business_settings').upsert({
      user_id: state.session.user.id,
      low_stock_threshold: Number($('set-low-stock').value || 10),
      default_gst: Number($('set-gst').value || 12),
      default_unit: $('set-unit').value.trim() || 'pcs',
    }, { onConflict: 'user_id' });
    if (error) throw error;
    await refresh();
    toast('Defaults saved');
  } catch (error) {
    toast(error.message || 'Could not save settings');
  } finally {
    setBusy(false);
  }
}

function renderReport() {
  const from = $('report-from').value;
  const to = $('report-to').value;
  const invoices = state.invoices.filter((inv) => (!from || inv.invoice_date >= from) && (!to || inv.invoice_date <= to));
  const revenue = invoices.reduce((sum, inv) => sum + Number(inv.total || 0), 0);
  const gst = invoices.reduce((sum, inv) => sum + Number(inv.gst_total || 0), 0);
  $('report-preview').innerHTML = `
    <div class="stats-grid">
      <div class="stat"><span>Total sales</span><strong>₹${money(revenue)}</strong></div>
      <div class="stat"><span>GST</span><strong>₹${money(gst)}</strong></div>
      <div class="stat"><span>Invoices</span><strong>${invoices.length}</strong></div>
      <div class="stat"><span>Average bill</span><strong>₹${money(invoices.length ? revenue / invoices.length : 0)}</strong></div>
    </div>
    <table>
      <thead><tr><th>Invoice</th><th>Date</th><th>Type</th><th class="money">GST</th><th class="money">Total</th></tr></thead>
      <tbody>${invoices.map((inv) => `<tr><td>${esc(inv.invoice_no)}</td><td>${esc(inv.invoice_date)}</td><td>${esc(inv.invoice_type)}</td><td class="money">₹${money(inv.gst_total)}</td><td class="money">₹${money(inv.total)}</td></tr>`).join('') || emptyRow(5, 'No invoices in this period')}</tbody>
    </table>
  `;
}

function listOrEmpty(items) {
  return items.length ? `<div class="list">${items.join('')}</div>` : '<p class="muted">Nothing to show yet.</p>';
}

function emptyRow(colspan, text) {
  return `<tr><td colspan="${colspan}" class="muted">${text}</td></tr>`;
}

boot();