// ===========================
// Excel / CSV Product Import
// ===========================

const importState = {
  file: null,
  parsedRows: [],
  validRows: [],
};

function openImportDialog() {
  // Reset state
  importState.file = null;
  importState.parsedRows = [];
  importState.validRows = [];

  // Reset UI steps
  showImportStep('upload');
  $('import-file-info').classList.add('hidden');
  $('import-file-input').value = '';
  $('import-preview-btn').disabled = true;

  $('import-dialog').showModal();
}

function showImportStep(step) {
  ['upload', 'preview', 'progress', 'results'].forEach((s) => {
    $(`import-step-${s}`).classList.remove('active');
    $(`import-step-${s}`).classList.add('hidden');
  });
  $(`import-step-${step}`).classList.remove('hidden');
  $(`import-step-${step}`).classList.add('active');
}

function wireImportEvents() {
  const fileInput = $('import-file-input');
  const fileZone = $('import-file-zone');

  // Browse button
  $('import-file-browse').addEventListener('click', () => fileInput.click());

  // File zone click
  fileZone.addEventListener('click', (e) => {
    if (e.target !== $('import-file-browse')) fileInput.click();
  });

  // Drag & drop
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

  // File input change
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) handleImportFile(fileInput.files[0]);
  });

  // Change file button
  $('import-file-change').addEventListener('click', () => {
    importState.file = null;
    $('import-file-info').classList.add('hidden');
    $('import-file-browse').closest('.file-zone-content') && fileInput.click();
    fileInput.value = '';
    $('import-preview-btn').disabled = true;
  });

  // Preview & Validate button
  $('import-preview-btn').addEventListener('click', runImportValidation);

  // Back button
  $('import-back-btn').addEventListener('click', () => showImportStep('upload'));

  // Confirm import button
  $('import-confirm-btn').addEventListener('click', runImportConfirm);

  // Close results
  $('import-close-btn').addEventListener('click', () => {
    $('import-dialog').close();
  });
}

function handleImportFile(file) {
  const allowed = ['text/csv', 'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/plain'];
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['csv', 'xlsx', 'xls', 'txt'].includes(ext)) {
    return toast('Unsupported file type. Use CSV or Excel.');
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
        const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
        resolve(rows);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsArrayBuffer(file);
  });
}

// Normalise a header key: lowercase, trim, remove spaces/underscores
function normKey(k) {
  return String(k).toLowerCase().trim().replace(/[\s_-]+/g, '_');
}

// Map common column name aliases to canonical field names
const FIELD_ALIASES = {
  name: ['name', 'product_name', 'item_name', 'item', 'product'],
  selling_price: ['selling_price', 'price', 'sale_price', 'sp', 'rate', 'mrp_price'],
  sku: ['sku', 'barcode', 'code', 'product_code', 'item_code'],
  category: ['category', 'cat', 'group', 'department'],
  unit: ['unit', 'uom', 'unit_of_measure'],
  purchase_price: ['purchase_price', 'cost', 'cost_price', 'pp', 'buy_price'],
  mrp: ['mrp', 'maximum_retail_price', 'max_price'],
  gst_rate: ['gst_rate', 'gst', 'gst_%', 'tax', 'tax_rate'],
  hsn: ['hsn', 'hsn_code', 'hsn_sac'],
  stock_qty: ['stock_qty', 'stock', 'quantity', 'opening_stock', 'qty'],
  expiry_date: ['expiry_date', 'expiry', 'exp_date', 'best_before'],
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

function validateRow(mapped, rowIndex) {
  const errors = [];
  const warnings = [];

  const name = String(mapped.name || '').trim();
  if (!name) errors.push('Missing product name');

  const price = Number(mapped.selling_price);
  if (!mapped.selling_price && mapped.selling_price !== 0) {
    errors.push('Missing selling price');
  } else if (isNaN(price) || price < 0) {
    errors.push('Invalid selling price');
  }

  if (mapped.gst_rate !== undefined && mapped.gst_rate !== '') {
    const gst = Number(mapped.gst_rate);
    if (isNaN(gst) || gst < 0 || gst > 100) warnings.push('GST rate looks unusual');
  }

  if (mapped.stock_qty !== undefined && mapped.stock_qty !== '') {
    const qty = Number(mapped.stock_qty);
    if (isNaN(qty) || qty < 0) warnings.push('Invalid stock quantity, will default to 0');
  }

  return { errors, warnings };
}

async function runImportValidation() {
  if (!importState.file) return toast('Select a file first');
  setBusy(true);
  try {
    const rows = await parseImportFile(importState.file);
    if (!rows.length) return toast('File is empty or has no data rows');
    importState.parsedRows = rows;

    const skipErrors = $('import-skip-errors').checked;
    let successCount = 0, errorCount = 0, warnCount = 0;
    importState.validRows = [];

    const tbodyRows = rows.map((raw, i) => {
      const mapped = mapRowKeys(raw);
      const { errors, warnings } = validateRow(mapped, i + 2);
      const hasError = errors.length > 0;
      const hasWarn = warnings.length > 0;

      if (hasError) {
        errorCount++;
      } else {
        successCount++;
        importState.validRows.push(mapped);
      }
      if (hasWarn) warnCount++;

      const statusClass = hasError ? 'error' : hasWarn ? 'warning' : 'success';
      const statusText = hasError ? 'Error' : hasWarn ? 'Warning' : 'Valid';
      const messages = [...errors, ...warnings].join('; ') || '—';
      const productName = esc(String(mapped.name || raw[Object.keys(raw)[0]] || `Row ${i + 2}`).slice(0, 40));

      return `<tr>
        <td>${i + 2}</td>
        <td>${productName}</td>
        <td><span class="status-badge ${statusClass}">${statusText}</span></td>
        <td style="font-size:0.85em; color:#6b7280;">${esc(messages)}</td>
      </tr>`;
    });

    $('preview-count').textContent =
      `${rows.length} row${rows.length !== 1 ? 's' : ''} found · ${importState.validRows.length} will be imported`;
    $('preview-success').textContent = successCount;
    $('preview-error').textContent = errorCount;
    $('preview-warnings').textContent = warnCount;
    $('import-validation-list').innerHTML = tbodyRows.join('');
    $('import-confirm-btn').disabled = importState.validRows.length === 0;
    $('import-confirm-btn').textContent = `Import ${importState.validRows.length} Product${importState.validRows.length !== 1 ? 's' : ''}`;

    showImportStep('preview');
  } catch (err) {
    toast(err.message || 'Could not parse file');
  } finally {
    setBusy(false);
  }
}

async function runImportConfirm() {
  const rows = importState.validRows;
  if (!rows.length) return toast('Nothing valid to import');

  showImportStep('progress');
  $('import-total').textContent = rows.length;
  $('import-current').textContent = 0;
  $('import-progress').value = 0;
  $('import-progress-text').textContent = '0%';

  const results = [];
  const defaultGst = Number(state.settings.default_gst || 12);
  const defaultUnit = state.settings.default_unit || 'pcs';

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const name = String(row.name || '').trim();
    $('import-current-item').textContent = `Importing: ${name}`;

    try {
      const payload = {
        name,
        sku: String(row.sku || '').trim() || null,
        category: String(row.category || '').trim() || 'General',
        unit: String(row.unit || defaultUnit).trim() || 'pcs',
        selling_price: Number(row.selling_price) || 0,
        purchase_price: Number(row.purchase_price) || 0,
        mrp: Number(row.mrp) || Number(row.selling_price) || 0,
        gst_rate: row.gst_rate !== undefined && row.gst_rate !== '' ? Number(row.gst_rate) : defaultGst,
        hsn: String(row.hsn || '').trim() || null,
        stock_qty: Math.max(0, Math.floor(Number(row.stock_qty) || 0)),
        expiry_date: parseImportDate(row.expiry_date),
      };

      const { error } = await state.client.from('products').insert(payload);
      if (error) throw error;
      results.push({ name, status: 'success', detail: 'Imported' });
    } catch (err) {
      results.push({ name, status: 'error', detail: err.message || 'Failed' });
    }

    const pct = Math.round(((i + 1) / rows.length) * 100);
    $('import-progress').value = pct;
    $('import-progress-text').textContent = pct + '%';
    $('import-current').textContent = i + 1;
  }

  const successCount = results.filter((r) => r.status === 'success').length;
  const failCount = results.filter((r) => r.status === 'error').length;

  $('result-summary').textContent = `Import complete: ${successCount} succeeded, ${failCount} failed.`;
  $('result-success').textContent = successCount;
  $('result-failed').textContent = failCount;

  if (failCount > 0) {
    $('import-results-list').classList.remove('hidden');
    $('import-results-rows').innerHTML = results.map((r) => `
      <tr>
        <td>${esc(r.name)}</td>
        <td><span class="status-badge ${r.status}">${r.status === 'success' ? 'Imported' : 'Failed'}</span></td>
        <td style="font-size:0.85em;">${esc(r.detail)}</td>
      </tr>
    `).join('');
  } else {
    $('import-results-list').classList.add('hidden');
  }

  showImportStep('results');
  await refresh();
}

function parseImportDate(val) {
  if (!val) return null;
  // Excel serial date number
  if (typeof val === 'number') {
    const d = XLSX.SSF.parse_date_code(val);
    if (d) return `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;
  }
  const s = String(val).trim();
  if (!s) return null;
  // Try ISO: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // Try DD/MM/YYYY or DD-MM-YYYY
  const parts = s.split(/[\/\-\.]/);
  if (parts.length === 3 && parts[0].length <= 2) {
    return `${parts[2].padStart(4,'0')}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
  }
  return null;
}