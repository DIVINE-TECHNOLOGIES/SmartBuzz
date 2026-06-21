/**
 * SmartBuzz - Bulk Product Import from Excel
 * Handles parsing and importing products from Excel/CSV files
 */

const ExcelImportHandler = (() => {
  const REQUIRED_COLUMNS = ['name', 'selling_price'];
  const OPTIONAL_COLUMNS = ['sku', 'category', 'unit', 'purchase_price', 'mrp', 'gst_rate', 'hsn', 'expiry_date'];
  const ALL_COLUMNS = [...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS];

  /**
   * Parse CSV content from text
   */
  function parseCSV(text) {
    const lines = text.split('\n').filter(line => line.trim());
    if (lines.length < 2) {
      throw new Error('CSV must contain header row and at least one data row');
    }

    const headerLine = lines[0];
    const headers = headerLine.split(',').map(h => h.trim().toLowerCase());

    // Find column indices (case-insensitive)
    const colMap = {};
    ALL_COLUMNS.forEach(col => {
      const idx = headers.findIndex(h => h === col || h.replace(/[_\s]/g, '') === col.replace(/[_\s]/g, ''));
      if (idx >= 0) colMap[col] = idx;
    });

    // Validate required columns
    const missing = REQUIRED_COLUMNS.filter(col => !(col in colMap));
    if (missing.length) {
      throw new Error(`Missing required columns: ${missing.join(', ')}`);
    }

    // Parse rows
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cells = lines[i].split(',').map(c => c.trim());
      const row = {};
      ALL_COLUMNS.forEach(col => {
        if (col in colMap) {
          const val = cells[colMap[col]] || '';
          row[col] = val;
        }
      });
      if (row.name) rows.push(row);
    }

    return rows;
  }

  /**
   * Parse Excel file using FileReader and basic parsing
   */
  async function parseExcel(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const text = e.target.result;
          // Try CSV parsing first (works for .xlsx exported as CSV)
          const rows = parseCSV(text);
          resolve(rows);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsText(file);
    });
  }

  /**
   * Validate a single product row
   */
  function validateRow(row, rowIndex) {
    const errors = [];
    const warnings = [];

    // Validate required fields
    if (!row.name || !row.name.trim()) {
      errors.push('Product name is required');
    }
    if (!row.selling_price || isNaN(parseFloat(row.selling_price))) {
      errors.push('Valid selling price is required');
    } else if (parseFloat(row.selling_price) <= 0) {
      errors.push('Selling price must be greater than 0');
    }

    // Validate optional numeric fields
    ['purchase_price', 'mrp', 'gst_rate'].forEach(field => {
      if (row[field] && isNaN(parseFloat(row[field]))) {
        errors.push(`${field} must be a valid number`);
      }
    });

    if (row.gst_rate) {
      const gst = parseFloat(row.gst_rate);
      if (gst < 0 || gst > 28) {
        errors.push('GST rate must be between 0 and 28');
      }
    }

    if (row.expiry_date && isNaN(Date.parse(row.expiry_date))) {
      warnings.push('Expiry date format may be invalid');
    }

    return { errors, warnings };
  }

  /**
   * Prepare product objects for insertion
   */
  function prepareProducts(rows) {
    const products = [];
    const validation = [];
    const skuSet = new Set();

    rows.forEach((row, idx) => {
      const rowNum = idx + 2; // +1 for header, +1 for 1-based indexing
      const val = validateRow(row, idx);

      if (val.errors.length > 0) {
        validation.push({
          rowNum,
          status: 'error',
          messages: val.errors,
          product: row.name,
        });
        return;
      }

      const sku = row.sku ? row.sku.trim() : null;
      if (sku && skuSet.has(sku)) {
        validation.push({
          rowNum,
          status: 'error',
          messages: [`Duplicate SKU: ${sku}`],
          product: row.name,
        });
        return;
      }
      if (sku) skuSet.add(sku);

      const product = {
        name: row.name.trim(),
        sku: sku,
        category: (row.category || 'General').trim(),
        unit: (row.unit || 'pcs').trim(),
        selling_price: parseFloat(row.selling_price),
        purchase_price: row.purchase_price ? parseFloat(row.purchase_price) : 0,
        mrp: row.mrp ? parseFloat(row.mrp) : parseFloat(row.selling_price),
        gst_rate: row.gst_rate ? parseFloat(row.gst_rate) : 12,
        hsn: row.hsn ? row.hsn.trim() : null,
        expiry_date: row.expiry_date ? row.expiry_date.trim() : null,
      };

      products.push(product);
      validation.push({
        rowNum,
        status: 'success',
        messages: val.warnings.length ? val.warnings : ['Ready to import'],
        product: row.name,
      });
    });

    return { products, validation };
  }

  /**
   * Main import function
   */
  async function importProducts(file, supabaseClient, onProgress) {
    try {
      // Parse file
      const rows = await parseExcel(file);
      if (rows.length === 0) {
        throw new Error('No valid product rows found in file');
      }

      // Prepare and validate
      const { products, validation } = prepareProducts(rows);
      const successCount = validation.filter(v => v.status === 'success').length;
      const errorCount = validation.filter(v => v.status === 'error').length;

      if (successCount === 0) {
        throw new Error(`All rows contain errors. Please fix and try again.`);
      }

      onProgress?.({
        phase: 'validation',
        total: rows.length,
        success: successCount,
        errors: errorCount,
        validation,
      });

      // Insert products
      const results = [];
      for (let i = 0; i < products.length; i++) {
        try {
          const { data, error } = await supabaseClient
            .from('products')
            .insert(products[i])
            .select('id')
            .single();

          if (error) throw error;

          results.push({
            product: products[i].name,
            status: 'success',
            id: data.id,
          });

          onProgress?.({
            phase: 'importing',
            current: i + 1,
            total: products.length,
            results,
          });
        } catch (err) {
          results.push({
            product: products[i].name,
            status: 'error',
            error: err.message,
          });
        }
      }

      return {
        success: true,
        validation,
        results,
        summary: {
          total: rows.length,
          imported: results.filter(r => r.status === 'success').length,
          failed: results.filter(r => r.status === 'error').length,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
      };
    }
  }

  return {
    parseCSV,
    parseExcel,
    prepareProducts,
    importProducts,
  };
})();
