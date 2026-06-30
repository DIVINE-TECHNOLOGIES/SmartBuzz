// ===========================
// import.js — CSV / Excel product import
// Depends on: state, $, esc, toast, setBusy, refresh (from app.js)
//             XLSX (SheetJS CDN)
// ===========================

const importState = {
  file: null,
  parsedRows: [],
  validRows: [],
};

// ── Open / close ──────────────────────────────────────────────

function openImportDialog() {
  importState.file = null;
  importState.parsedRows = [];
  importState.validRows = [];

  showImportStep('upload');
  $('import-file-info').classList.add('hidden');
  $('import-file-input').value = null;
  $('import-preview-btn').disabled = true;

  $('import-dialog').showModal();
}

function closeImportDialog() {
  $('import-dialog').close();
}

function showImportStep(step) {
  ['upload', 'preview', 'progress', 'results'].forEach((s) => {
    const el = $(`import-step-${s}`);
    el.classList.remove('active');
    el.classList.add('hidden');
  });
  const active = $(`import-step-${step}`);
  active.classList.remove('hidden');
  active.classList.add('active');
}

// ── Wire events (called from app.js wireEvents) ───────────────

function wireImportEvents() {
  const fileInput = $('import-file-input');
  const fileZone  = $('import-file-zone');

  $('import-file-browse').addEventListener('click', () => fileInput.click());

  fileZone.addEventListener('click', (e) => {
    if (e.target.id !== 'import-file-browse') fileInput.click();
  });

  fileZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    fileZone.classList.add('dragover');
  });
  fileZone.addEventListener('dragleave', () => fileZone.classList.remove('dragover'));
  fileZone.addEventListener('drop', (e) => {
    e.preventDefault();
    fileZone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) handleImportFile(file);
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleImportFile(fileInput.files[0]);
  });

  $('import-file-change').addEventListener('click', () => {
    importState.file = null;
    $('import-file-info').classList.add('hidden');
    fileInput.value = null;
    $('import-preview-btn').disabled = true;
  });

  $('import-preview-btn').addEventListener('click', runImportValidation);
  $('import-back-btn').addEventListener('click', () => showImportStep('upload'));
  $('import-confirm-btn').addEventListener('click', runImportConfirm);
  $('import-cancel-btn').addEventListener('click', closeImportDialog);
  $('import-close-x-btn').addEventListener('click', closeImportDialog);
  $('import-done-btn').addEventListener('click', closeImportDialog);
}

// ── File handling ─────────────────────────────────────────────

function handleImportFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['csv', 'xlsx', 'xls'].includes(ext)) {
    return toast('Unsupported file type. Use CSV or Excel (.xlsx / .xls).');
  }
  if (file.size > 5 * 1024 * 1024) {
    return toast('File too large. Maximum size is 5 MB.');
  }
  importState.file = file;
  $('import-file-name').textContent = file.name;
  $('import-file-size').textContent = (file.size / 1024).toFixed(1) + ' KB';
  $('import-file-info').classList.remove('hidden');
  $('import-preview-btn').disabled = false;
}

function parseImportFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        // raw:false preserves text-formatted values (e.g. "30X40" sizes)
        // instead of letting Excel/SheetJS coerce them to numbers/dates.
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: false });
        resolve(rows);
      } catch (err) {
        reject(new Error('Could not parse file: ' + err.message));
      }
    };
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsArrayBuffer(file);
  });
}

// ── Column alias mapping ──────────────────────────────────────

function normKey(k) {
  return String(k).toLowerCase().trim().replace(/[\s_\-]+/g, '_');
}

const FIELD_ALIASES = {
  name:           ['name', 'product_name', 'item_name', 'item', 'product'],
  selling_price:  ['selling_price', 'price', 'sale_price', 'sp', 'rate', 'sell_price', 'sellprice'],
  sku:            ['sku', 'barcode', 'code', 'product_code', 'item_code'],
  size:           ['size', 'size_name', 'variant_size'],
  category:       ['category', 'cat', 'group', 'department'],
  unit:           ['unit', 'uom', 'unit_of_measure'],
  purchase_price: ['purchase_price', 'cost', 'cost_price', 'pp', 'buy_price', 'purchaseprice'],
  mrp:            ['mrp', 'maximum_retail_price', 'max_price'],
  gst_rate:       ['gst_rate', 'gst', 'gst_%', 'tax', 'tax_rate', 'gstrate'],
  hsn:            ['hsn', 'hsn_code', 'hsn_sac'],
  stock_qty:      ['stock_qty', 'stock', 'quantity', 'opening_stock', 'qty'],
  expiry_date:    ['expiry_date', 'expiry', 'exp_date', 'best_before'],
};

function mapRowKeys(raw) {
  const mapped = {};
  const rawKeys = Object.keys(raw);
  for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const rawKey of rawKeys) {
      if (aliases.includes(normKey(rawKey))) {
        mapped[canonical] = raw[rawKey];
        break;
      }
    }
  }
  return mapped;
}

// ── Validation ────────────────────────────────────────────────

function validateRow(mapped) {
  const errors = [];
  const warnings = [];

  const name = String(mapped.name || '').trim();
  if (!name) errors.push('Missing product name');

  const priceRaw = mapped.selling_price;
  if (priceRaw === undefined || priceRaw === null || String(priceRaw).trim() === '') {
    warnings.push('No selling price — will default to 0');
  } else {
    const price = Number(priceRaw);
    if (isNaN(price) || price < 0) errors.push('Invalid selling price');
  }

  if (mapped.gst_rate !== undefined && mapped.gst_rate !== null && String(mapped.gst_rate).trim() !== '') {
    const gst = Number(mapped.gst_rate);
    if (isNaN(gst) || gst < 0 || gst > 100) warnings.push('GST rate looks unusual');
  }

  if (mapped.stock_qty !== undefined && mapped.stock_qty !== null && String(mapped.stock_qty).trim() !== '') {
    const qty = Number(mapped.stock_qty);
    if (isNaN(qty) || qty < 0) warnings.push('Invalid stock quantity — will default to 0');
  }

  return { errors, warnings };
}

// ── Step 2: Validate & preview ────────────────────────────────

async function runImportValidation() {
  if (!importState.file) return toast('Select a file first');
  setBusy(true);
  try {
    const rows = await parseImportFile(importState.file);
    if (!rows.length) return toast('File is empty or has no data rows');
    importState.parsedRows = rows;

    let successCount = 0, errorCount = 0, warnCount = 0;
    importState.validRows = [];

    // Track sku+size combos seen so far in THIS file so we can warn about
    // duplicate rows within the same upload (these will be merged on import
    // via upsert, but it's worth surfacing to the user).
    const seenKeys = new Set();

    const tbodyRows = rows.map((raw, i) => {
      const mapped = mapRowKeys(raw);
      const { errors, warnings } = validateRow(mapped);

      const skuKey  = String(mapped.sku || '').trim().toLowerCase();
      const sizeKey = String(mapped.size || '').trim().toLowerCase();
      const dupeKey = skuKey ? `${skuKey}::${sizeKey}` : null;
      if (dupeKey) {
        if (seenKeys.has(dupeKey)) {
          warnings.push('Duplicate SKU+Size in this file — later row will overwrite earlier one');
        }
        seenKeys.add(dupeKey);
      }

      const hasError = errors.length > 0;

      if (hasError) {
        errorCount++;
      } else {
        successCount++;
        importState.validRows.push(mapped);
      }
      if (warnings.length) warnCount++;

      const statusClass = hasError ? 'error' : warnings.length ? 'warning' : 'success';
      const statusText  = hasError ? 'Error'  : warnings.length ? 'Warning' : 'Valid';
      const messages    = [...errors, ...warnings].join('; ') || '—';
      const productName = esc(String(mapped.name || raw[Object.keys(raw)[0]] || `Row ${i + 2}`).slice(0, 50));

      return `<tr>
        <td>${i + 2}</td>
        <td>${productName}</td>
        <td><span class="status-badge ${statusClass}">${statusText}</span></td>
        <td style="font-size:0.85em;color:#6b7280;">${esc(messages)}</td>
      </tr>`;
    });

    $('preview-count').textContent =
      `${rows.length} row${rows.length !== 1 ? 's' : ''} found — ${importState.validRows.length} will be imported`;
    $('preview-success').textContent  = successCount;
    $('preview-error').textContent    = errorCount;
    $('preview-warnings').textContent = warnCount;
    $('import-validation-list').innerHTML = tbodyRows.join('');

    const canImport = importState.validRows.length > 0;
    $('import-confirm-btn').disabled    = !canImport;
    $('import-confirm-btn').textContent =
      `Import ${importState.validRows.length} Product${importState.validRows.length !== 1 ? 's' : ''}`;

    showImportStep('preview');
  } catch (err) {
    toast(err.message || 'Could not parse file');
  } finally {
    setBusy(false);
  }
}

// ── Step 3: Confirm & import ──────────────────────────────────

async function runImportConfirm() {
  const rows = importState.validRows;
  if (!rows.length) return toast('Nothing valid to import');

  showImportStep('progress');
  $('import-total').textContent   = rows.length;
  $('import-current').textContent = 0;
  $('import-progress').value      = 0;
  $('import-progress-text').textContent = '0%';

  const results = [];
  const defaultGst  = Number(state.settings.default_gst  || 12);
  const defaultUnit = state.settings.default_unit || 'pcs';

  for (let i = 0; i < rows.length; i++) {
    const row  = rows[i];
    const name = String(row.name || '').trim();
    $('import-current-item').textContent = `Importing: ${name}`;

    try {
      const sellingPriceRaw = row.selling_price;
      const sellingPrice = (sellingPriceRaw === undefined || sellingPriceRaw === null || String(sellingPriceRaw).trim() === '')
        ? 0
        : Number(sellingPriceRaw) || 0;

      const mrpRaw = row.mrp;
      const mrp = (mrpRaw === undefined || mrpRaw === null || String(mrpRaw).trim() === '')
        ? sellingPrice
        : (Number(mrpRaw) || sellingPrice);

      const payload = {
        name,
        sku:            String(row.sku || '').trim() || null,
        size:           String(row.size || '').trim() || null,
        category:       String(row.category || '').trim() || 'General',
        unit:           String(row.unit || defaultUnit).trim() || 'pcs',
        selling_price:  sellingPrice,
        purchase_price: (row.purchase_price === undefined || row.purchase_price === null || String(row.purchase_price).trim() === '')
                          ? 0 : (Number(row.purchase_price) || 0),
        mrp,
        gst_rate:       (row.gst_rate !== undefined && row.gst_rate !== null && String(row.gst_rate).trim() !== '')
                          ? Number(row.gst_rate) : defaultGst,
        hsn:            String(row.hsn || '').trim() || null,
        stock_qty:      Math.max(0, Math.floor(
                          (row.stock_qty === undefined || row.stock_qty === null || String(row.stock_qty).trim() === '')
                            ? 0 : (Number(row.stock_qty) || 0)
                        )),
        expiry_date:    parseImportDate(row.expiry_date),
      };

      // Use upsert instead of insert so rows that collide on the
      // (user_id, sku, size) unique constraint update the existing
      // product instead of failing the whole row. This also means
      // re-running an import with corrected data is safe to repeat.
      let query = state.client.from('products');
      const { error } = payload.sku
        ? await query.upsert(payload, { onConflict: 'user_id,sku,size' })
        : await query.insert(payload); // no SKU -> can't dedupe, just insert

      if (error) throw error;
      results.push({ name, status: 'success', detail: 'Imported' });
    } catch (err) {
      results.push({ name, status: 'error', detail: err.message || 'Failed' });
    }

    const pct = Math.round(((i + 1) / rows.length) * 100);
    $('import-progress').value            = pct;
    $('import-progress-text').textContent = pct + '%';
    $('import-current').textContent       = i + 1;
  }

  const successCount = results.filter((r) => r.status === 'success').length;
  const failCount    = results.filter((r) => r.status === 'error').length;

  $('result-summary').textContent = `Import complete: ${successCount} succeeded, ${failCount} failed.`;
  $('result-success').textContent = successCount;
  $('result-failed').textContent  = failCount;

  if (failCount > 0) {
    $('import-results-list').classList.remove('hidden');
    $('import-results-rows').innerHTML = results
      .filter((r) => r.status === 'error')
      .map((r) => `<tr>
        <td>${esc(r.name)}</td>
        <td><span class="status-badge error">Failed</span></td>
        <td style="font-size:0.85em;">${esc(r.detail)}</td>
      </tr>`).join('');
  } else {
    $('import-results-list').classList.add('hidden');
  }

  showImportStep('results');
  await refresh();
}

// ── Date helper ───────────────────────────────────────────────

function parseImportDate(val) {
  if (!val) return null;
  if (typeof val === 'number') {
    const d = XLSX.SSF.parse_date_code(val);
    if (d) return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  const s = String(val).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const parts = s.split(/[\/\-\.]/);
  if (parts.length === 3 && parts[0].length <= 2) {
    return `${parts[2].padStart(4, '0')}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
  }
  return null;
}