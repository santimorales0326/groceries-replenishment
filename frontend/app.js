/**
 * PantryPulse - Frontend Application Logic
 */

// Global State
let currentTab = 'scanner';
let receiptFiles = [];
let savedReceipts = [];
let categoriesList = [];
let currentReviewData = null;
let currentImageZoom = 1.0;
let reportsData = null;
let consumptionData = [];
let consumptionFilter = 'all';

// Chart instances
let chartProviders = null;
let chartCategories = null;

// Initialize app on DOM ready (or immediately if DOM is already parsed)
function startApp() {
  initApp();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startApp);
} else {
  startApp();
}

async function initApp() {
  // Initialize parallel components independently so one failure cannot block the rest
  await Promise.allSettled([
    loadCategories(),
    loadReceiptFiles(),
    checkEngineStatus()
  ]);
}

// Tab Switching
function switchTab(tabName) {
  currentTab = tabName;
  document.querySelectorAll('.tab-view').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));

  const targetView = document.getElementById(`view-${tabName}`);
  const targetNav = document.getElementById(`nav-${tabName}`);
  if (targetView) targetView.classList.add('active');
  if (targetNav) targetNav.classList.add('active');

  const titleMap = {
    scanner: { title: 'Receipt Scanner & Ingestion', subtitle: 'Scan and convert physical grocery receipts from /receipts into actionable records.' },
    receipts: { title: 'Saved Grocery Receipts', subtitle: 'Browse, review, and manage previously confirmed receipts.' },
    reports: { title: 'Spending Reports & Analytics', subtitle: 'Track grocery expenses across providers, categories, and item volumes.' },
    replenish: { title: 'Consumption & Replenishment Estimator', subtitle: 'Predict burn rates and restock deadlines based on past purchase frequency.' },
    stock: { title: 'Pantry Stock & Inventory Audits', subtitle: 'Periodically record, inspect, and track current pantry inventory counts grouped by category.' },
    settings: { title: 'System & Vision AI Settings', subtitle: 'Configure primary Copencode/OpenAI-compatible endpoint and local Ollama fallback.' }
  };

  if (titleMap[tabName]) {
    document.getElementById('page-title').innerText = titleMap[tabName].title;
    document.getElementById('page-subtitle').innerText = titleMap[tabName].subtitle;
  }

  if (tabName === 'receipts') loadSavedReceipts();
  if (tabName === 'reports') loadReports();
  if (tabName === 'replenish') loadConsumption();
  if (tabName === 'stock') loadStockAuditView();
  if (tabName === 'settings') loadSettings();
}

// -------------------------------------------------------------
// CATEGORIES & PROVIDERS
// -------------------------------------------------------------
async function loadCategories() {
  try {
    const res = await fetch('/api/categories');
    const data = await res.json();
    categoriesList = data.categories || [];
    populateCategoryDropdowns();
  } catch (err) {
    console.error('Failed to load categories:', err);
  }
}

function populateCategoryDropdowns() {
  const catFilter = document.getElementById('filter-category');
  if (catFilter) {
    catFilter.innerHTML = '<option value="">All Categories</option>';
    categoriesList.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.name;
      opt.textContent = `${c.icon || '📦'} ${c.name}`;
      catFilter.appendChild(opt);
    });
  }
}

async function loadProvidersFilter() {
  try {
    const res = await fetch('/api/providers');
    const data = await res.json();
    const provFilter = document.getElementById('filter-provider');
    if (provFilter) {
      provFilter.innerHTML = '<option value="">All Providers</option>';
      (data.providers || []).forEach(p => {
        const opt = document.createElement('option');
        opt.value = p;
        opt.textContent = p;
        provFilter.appendChild(opt);
      });
    }
  } catch (err) {
    console.error('Failed to load providers:', err);
  }
}

// -------------------------------------------------------------
// ENGINE STATUS CHECK
// -------------------------------------------------------------
async function checkEngineStatus() {
  const indicator = document.getElementById('engine-status-indicator');
  const label = document.getElementById('engine-status-text');
  try {
    const res = await fetch('/api/settings');
    const s = await res.json();
    if (s.primary_api_key && s.primary_api_base_url) {
      label.textContent = `Primary API: ${s.primary_vision_model}`;
      indicator.querySelector('.status-dot').className = 'status-dot online';
    } else {
      label.textContent = `Ollama: ${s.ollama_model}`;
      indicator.querySelector('.status-dot').className = 'status-dot online';
    }
  } catch (err) {
    label.textContent = 'Engine Offline';
    indicator.querySelector('.status-dot').className = 'status-dot warning';
  }
}

// -------------------------------------------------------------
// SCANNER & INGESTION
// -------------------------------------------------------------
async function loadReceiptFiles() {
  const grid = document.getElementById('receipt-files-grid');
  if (!grid) return;
  grid.innerHTML = '<div class="loading-state">Scanning /receipts folder...</div>';

  try {
    const res = await fetch('/api/receipts/files');
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.detail || `Server error (${res.status})`);
    }
    const data = await res.json();
    receiptFiles = data.files || [];

    // Update Ribbon Stats
    const total = receiptFiles.length;
    const saved = receiptFiles.filter(f => f.status === 'saved').length;
    const pending = total - saved;

    document.getElementById('stat-total-files').textContent = total;
    document.getElementById('stat-saved-files').textContent = saved;
    document.getElementById('stat-pending-files').textContent = pending;

    const badge = document.getElementById('badge-unprocessed');
    if (pending > 0) {
      badge.textContent = pending;
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }

    if (total === 0) {
      grid.innerHTML = '<div class="empty-state">No receipt image files found in <code>/receipts</code> folder. Drop phone photos (.jpg, .png) there and click Scan!</div>';
      return;
    }

    grid.innerHTML = '';
    receiptFiles.forEach(file => {
      const card = document.createElement('div');
      card.className = 'file-card';

      const isSaved = file.status === 'saved';
      const sizeKB = Math.round(file.size_bytes / 1024);

      card.innerHTML = `
        <div class="file-info">
          <div class="file-icon">🧾</div>
          <div class="file-details">
            <h4>${escapeHtml(file.filename)}</h4>
            <div class="file-meta">
              <span>${sizeKB} KB</span> • 
              <span>${escapeHtml(file.modified_at || '')}</span>
            </div>
            ${isSaved ? `
              <div class="file-saved-meta">
                <div class="file-saved-line">
                  <strong>${escapeHtml(file.provider || 'Saved Store')}</strong> • €${(file.total_amount || 0).toFixed(2)} (${file.item_count} items)
                </div>
                ${file.invoice_id ? `
                  <div class="file-invoice-line">
                    <span class="file-invoice-label">Invoice:</span>
                    <code class="invoice-pill">${escapeHtml(file.invoice_id)}</code>
                  </div>
                ` : ''}
              </div>
            ` : ''}
          </div>
        </div>
        <div class="file-actions">
          <span class="badge ${isSaved ? 'badge-success' : 'badge-warning'}">
            ${isSaved ? '✓ Saved Record' : '● Needs Ingestion'}
          </span>
          <div style="display:flex; gap:6px;">
            ${isSaved ? `
              <button class="btn btn-secondary btn-sm" onclick="viewExistingReceipt(${file.receipt_id}, '${escapeHtml(file.filename)}')">View</button>
            ` : ''}
            <button class="btn btn-primary btn-sm" onclick="parseReceiptFile('${escapeHtml(file.filename)}')">
              ${isSaved ? 'Re-Parse' : '⚡ Parse Receipt'}
            </button>
          </div>
        </div>
      `;
      grid.appendChild(card);
    });
  } catch (err) {
    grid.innerHTML = `
      <div class="error-state" style="padding: 24px; text-align: center;">
        <p style="color: var(--accent-rose); margin-bottom: 12px;">Failed to scan receipts directory: ${escapeHtml(err.message)}</p>
        <button class="btn btn-secondary btn-sm" onclick="loadReceiptFiles()">🔄 Retry Scan</button>
      </div>
    `;
  }
}

// Run Vision Extraction
async function parseReceiptFile(filename) {
  showLoading(`Analyzing ${filename}...`, 'Running multimodal vision model to detect items, prices, and categories. This may take a moment...');
  try {
    const res = await fetch(`/api/receipts/parse/${encodeURIComponent(filename)}`, { method: 'POST' });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || 'Extraction failed');
    }
    const result = await res.json();
    hideLoading();
    openReviewModal(result.data, result.engine, result.duplicate_of);
  } catch (err) {
    hideLoading();
    alert(`Receipt parsing error: ${err.message}`);
  }
}

// -------------------------------------------------------------
// SPLIT REVIEW & VERIFICATION MODAL
// -------------------------------------------------------------
function openReviewModal(data, engine = 'AI Engine', duplicateOf = null) {
  currentReviewData = JSON.parse(JSON.stringify(data));
  document.getElementById('review-modal-title').innerText = `Review: ${data.filename}`;
  document.getElementById('review-engine-badge').innerText = `Engine: ${engine}`;
  document.getElementById('review-image-filename').innerText = data.filename;

  // Set image source
  const imgEl = document.getElementById('review-receipt-img');
  imgEl.src = `/api/receipt-image/${encodeURIComponent(data.filename)}`;
  resetImageZoom();

  // Handle duplicate warning banner
  const warnBanner = document.getElementById('duplicate-warning-banner');
  const warnText = document.getElementById('duplicate-warning-text');
  if (duplicateOf && warnBanner && warnText) {
    warnText.innerHTML = `Receipt with Invoice ID <strong>${escapeHtml(duplicateOf.invoice_id || '')}</strong> was already saved from file <code>${escapeHtml(duplicateOf.filename)}</code> on ${duplicateOf.receipt_date} (€${Number(duplicateOf.total_amount).toFixed(2)}). Saving will update the existing entry to prevent duplicate records.`;
    warnBanner.style.display = 'block';
  } else if (warnBanner) {
    warnBanner.style.display = 'none';
  }

  // Populate Meta fields
  document.getElementById('input-meta-provider').value = data.provider || '';
  const invInput = document.getElementById('input-meta-invoice');
  if (invInput) invInput.value = data.invoice_id || '';
  document.getElementById('input-meta-date').value = (data.receipt_date || '').substring(0, 10);
  document.getElementById('input-meta-total').value = (data.total_amount || 0).toFixed(2);
  document.getElementById('input-meta-currency').value = data.currency || 'EUR';

  renderReviewItemsTable();
  updateValidationSum();
  document.getElementById('modal-review').style.display = 'flex';
}

function closeReviewModal() {
  document.getElementById('modal-review').style.display = 'none';
  currentReviewData = null;
}

function renderReviewItemsTable() {
  const tbody = document.getElementById('tbody-review-items');
  tbody.innerHTML = '';

  const items = currentReviewData.items || [];
  document.getElementById('review-items-count').innerText = items.length;

  items.forEach((item, idx) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="text" value="${escapeHtml(item.name || '')}" onchange="updateReviewItem(${idx}, 'name', this.value)"></td>
      <td><input type="text" value="${escapeHtml(item.clean_name || item.name || '')}" onchange="updateReviewItem(${idx}, 'clean_name', this.value)"></td>
      <td><input type="number" step="0.01" style="width:70px;" value="${item.quantity || 1}" onchange="updateReviewItem(${idx}, 'quantity', parseFloat(this.value)||1)"></td>
      <td><input type="text" style="width:60px;" value="${escapeHtml(item.unit || 'unit')}" onchange="updateReviewItem(${idx}, 'unit', this.value)"></td>
      <td><input type="number" step="0.01" style="width:75px;" value="${(item.unit_price || 0).toFixed(2)}" onchange="updateReviewItem(${idx}, 'unit_price', parseFloat(this.value)||0)"></td>
      <td><input type="number" step="0.01" style="width:75px;" value="${(item.total_price || 0).toFixed(2)}" onchange="updateReviewItem(${idx}, 'total_price', parseFloat(this.value)||0)"></td>
      <td>
        <select onchange="updateReviewItem(${idx}, 'category', this.value)">
          ${getCategoryOptions(item.category)}
        </select>
      </td>
      <td class="text-center">
        <button type="button" class="btn-delete-row" title="Delete Row" onclick="removeReviewItem(${idx})">🗑️</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function getCategoryOptions(selectedCategory) {
  const defaults = [
    "Produce & Fresh", "Dairy & Eggs", "Bakery & Bread", "Meat & Seafood",
    "Pantry & Dry Goods", "Beverages & Drinks", "Snacks & Sweets",
    "Frozen Foods", "Household & Cleaning", "Personal Care", "Other"
  ];
  return defaults.map(cat => {
    const isSel = (cat.toLowerCase() === (selectedCategory || '').toLowerCase()) ? 'selected' : '';
    return `<option value="${cat}" ${isSel}>${cat}</option>`;
  }).join('');
}

function updateReviewItem(index, field, value) {
  if (!currentReviewData.items[index]) return;
  currentReviewData.items[index][field] = value;

  // Auto calculate total if qty or unit price changes
  if (field === 'quantity' || field === 'unit_price') {
    const q = parseFloat(currentReviewData.items[index].quantity) || 1.0;
    const p = parseFloat(currentReviewData.items[index].unit_price) || 0.0;
    currentReviewData.items[index].total_price = Math.round(q * p * 100) / 100;
    renderReviewItemsTable();
  } else if (field === 'total_price') {
    currentReviewData.items[index].total_price = parseFloat(value) || 0.0;
  }
  updateValidationSum();
}

function addNewItemRow() {
  if (!currentReviewData.items) currentReviewData.items = [];
  currentReviewData.items.push({
    name: 'New Item',
    clean_name: 'New Item',
    quantity: 1.0,
    unit: 'unit',
    unit_price: 0.0,
    total_price: 0.0,
    category: 'Other'
  });
  renderReviewItemsTable();
  updateValidationSum();
}

function removeReviewItem(index) {
  currentReviewData.items.splice(index, 1);
  renderReviewItemsTable();
  updateValidationSum();
}

function calculateItemsSum() {
  if (!currentReviewData || !currentReviewData.items) return 0;
  return currentReviewData.items.reduce((sum, item) => sum + (parseFloat(item.total_price) || 0), 0);
}

function updateValidationSum() {
  if (!currentReviewData) return;
  const itemsSum = calculateItemsSum();
  const invoiceTotalInput = document.getElementById('input-meta-total');
  const invoiceTotal = parseFloat(invoiceTotalInput?.value) || 0;
  const diff = Math.round((invoiceTotal - itemsSum) * 100) / 100;
  const absDiff = Math.abs(diff);

  const currency = document.getElementById('input-meta-currency')?.value || 'EUR';
  const sym = currency === 'EUR' ? '€' : `${currency} `;

  const inlinePill = document.getElementById('recon-inline-pill');
  const inlineText = document.getElementById('recon-inline-text');
  const syncBtn = document.getElementById('btn-sync-total');
  const metaHelper = document.getElementById('meta-total-helper');
  const tfootTotalEl = document.getElementById('tfoot-items-total');
  const tfootDiffEl = document.getElementById('tfoot-discrepancy-cell');

  if (tfootTotalEl) tfootTotalEl.textContent = `${sym}${itemsSum.toFixed(2)}`;

  if (absDiff < 0.009) {
    if (inlinePill) inlinePill.className = 'recon-inline-pill match';
    if (inlineText) inlineText.textContent = `✓ Items match invoice (${sym}${itemsSum.toFixed(2)})`;
    if (syncBtn) syncBtn.style.display = 'none';

    if (metaHelper) {
      metaHelper.style.display = 'none';
      metaHelper.textContent = '';
    }

    if (tfootDiffEl) {
      tfootDiffEl.innerHTML = '<span class="badge badge-success">✓ Matches Invoice</span>';
    }
  } else {
    const sign = diff > 0 ? '+' : '-';
    const diffStr = `${sign}${sym}${absDiff.toFixed(2)}`;

    if (inlinePill) inlinePill.className = 'recon-inline-pill warning';
    if (inlineText) {
      inlineText.textContent = `⚠️ Items: ${sym}${itemsSum.toFixed(2)} vs Invoice: ${sym}${invoiceTotal.toFixed(2)} (Diff: ${diffStr})`;
    }

    if (syncBtn) {
      syncBtn.style.display = 'inline-flex';
      syncBtn.textContent = `⚡ Use ${sym}${itemsSum.toFixed(2)}`;
      syncBtn.title = `Set invoice total to items sum (${sym}${itemsSum.toFixed(2)})`;
    }

    if (metaHelper) {
      metaHelper.className = 'meta-helper-pill warning';
      metaHelper.style.display = 'inline-block';
      metaHelper.textContent = `Items: ${sym}${itemsSum.toFixed(2)} (${diffStr})`;
    }

    if (tfootDiffEl) {
      tfootDiffEl.innerHTML = `<span class="badge badge-warning" title="${diff > 0 ? 'Items sum is lower than ticket' : 'Items sum is higher than ticket'}">⚠️ Diff: ${diffStr}</span>`;
    }
  }
}

function syncInvoiceTotalWithItemsSum() {
  const sum = calculateItemsSum();
  const input = document.getElementById('input-meta-total');
  if (input) {
    input.value = sum.toFixed(2);
    updateValidationSum();
  }
}

// Confirm & Save
async function saveConfirmedReceipt() {
  const btn = document.getElementById('btn-save-confirmed');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  const invVal = (document.getElementById('input-meta-invoice')?.value || '').trim();
  const payload = {
    filename: currentReviewData.filename,
    invoice_id: invVal || null,
    provider: document.getElementById('input-meta-provider').value.trim() || 'Unknown Store',
    receipt_date: document.getElementById('input-meta-date').value || new Date().toISOString().substring(0, 10),
    total_amount: parseFloat(document.getElementById('input-meta-total').value) || 0.0,
    currency: document.getElementById('input-meta-currency').value.trim() || 'EUR',
    status: 'confirmed',
    items: currentReviewData.items || [],
    raw_json: currentReviewData
  };

  try {
    const res = await fetch('/api/receipts/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('Failed to save receipt record');

    closeReviewModal();
    await loadReceiptFiles();
    alert('Receipt successfully verified and saved into database!');
  } catch (err) {
    alert(`Error saving receipt: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '💾 Confirm & Save Record';
  }
}

// Zoom controls
function zoomImage(delta) {
  currentImageZoom = Math.max(0.4, Math.min(3.0, currentImageZoom + delta));
  const img = document.getElementById('review-receipt-img');
  if (img) img.style.transform = `scale(${currentImageZoom})`;
}

function resetImageZoom() {
  currentImageZoom = 1.0;
  const img = document.getElementById('review-receipt-img');
  if (img) img.style.transform = 'scale(1.0)';
}

// -------------------------------------------------------------
// SAVED RECEIPTS VIEW
// -------------------------------------------------------------
async function loadSavedReceipts() {
  const tbody = document.getElementById('tbody-saved-receipts');
  tbody.innerHTML = '<tr><td colspan="6" class="text-center">Loading receipts...</td></tr>';
  try {
    const res = await fetch('/api/receipts');
    const data = await res.json();
    savedReceipts = data.receipts || [];
    renderSavedReceiptsTable();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center" style="color:var(--accent-rose);">Failed to load receipts: ${err.message}</td></tr>`;
  }
}

function renderSavedReceiptsTable() {
  const tbody = document.getElementById('tbody-saved-receipts');
  const search = (document.getElementById('receipts-search')?.value || '').toLowerCase().trim();

  const filtered = savedReceipts.filter(r => {
    return (r.provider || '').toLowerCase().includes(search) ||
           (r.receipt_date || '').toLowerCase().includes(search) ||
           (r.invoice_id || '').toLowerCase().includes(search);
  });

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted">No saved receipts found.</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  filtered.forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${escapeHtml(r.receipt_date || '')}</strong></td>
      <td>${r.invoice_id ? `<code class="invoice-pill">${escapeHtml(r.invoice_id)}</code>` : '<span class="text-dim">—</span>'}</td>
      <td><span class="badge badge-info">${escapeHtml(r.provider || 'Unknown Store')}</span></td>
      <td>${r.item_count || 0} items</td>
      <td><strong>€${(r.total_amount || 0).toFixed(2)}</strong></td>
      <td><span class="badge badge-success">Confirmed</span></td>
      <td>
        <button class="btn btn-secondary btn-xs" onclick="viewExistingReceipt(${r.id}, '${r.filename}')">Inspect</button>
        <button class="btn btn-secondary btn-xs" style="color:var(--accent-rose);" onclick="deleteReceiptRecord(${r.id})">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function viewExistingReceipt(receiptId, filename) {
  try {
    const res = await fetch(`/api/receipts/${receiptId}`);
    const data = await res.json();
    const r = data.receipt;
    openReviewModal(r, 'Saved Record');
  } catch (err) {
    alert(`Could not load receipt: ${err.message}`);
  }
}

async function deleteReceiptRecord(receiptId) {
  if (!confirm('Are you sure you want to delete this receipt and all its recorded items?')) return;
  try {
    await fetch(`/api/receipts/${receiptId}`, { method: 'DELETE' });
    await loadSavedReceipts();
    await loadReceiptFiles();
  } catch (err) {
    alert(`Error deleting receipt: ${err.message}`);
  }
}

// -------------------------------------------------------------
// REPORTS & ANALYTICS
// -------------------------------------------------------------
async function loadReports() {
  await loadProvidersFilter();

  const provider = document.getElementById('filter-provider')?.value || '';
  const category = document.getElementById('filter-category')?.value || '';

  const params = new URLSearchParams();
  if (provider) params.append('provider', provider);
  if (category) params.append('category', category);

  try {
    const res = await fetch(`/api/reports?${params.toString()}`);
    reportsData = await res.json();
    renderReports();
  } catch (err) {
    console.error('Failed to load reports:', err);
  }
}

function renderReports() {
  if (!reportsData) return;

  const totals = reportsData.totals || {};
  document.getElementById('kpi-total-spend').innerText = `€${(totals.grand_total_spend || 0).toFixed(2)}`;
  document.getElementById('kpi-total-trips').innerText = totals.total_receipts || 0;
  document.getElementById('kpi-total-items').innerText = (reportsData.by_item || []).length;
  const avgTrip = totals.total_receipts > 0 ? (totals.grand_total_spend / totals.total_receipts) : 0;
  document.getElementById('kpi-avg-trip').innerText = `€${avgTrip.toFixed(2)}`;

  renderCharts();
  renderItemsTable();
}

function renderCharts() {
  const provCanvas = document.getElementById('chart-providers');
  const catCanvas = document.getElementById('chart-categories');

  if (chartProviders) chartProviders.destroy();
  if (chartCategories) chartCategories.destroy();

  // Spend by Provider Chart
  const provData = reportsData.by_provider || [];
  chartProviders = new Chart(provCanvas, {
    type: 'bar',
    data: {
      labels: provData.map(p => p.provider),
      datasets: [{
        label: 'Total Spend (€)',
        data: provData.map(p => p.total_spend),
        backgroundColor: '#6366F1',
        borderRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#9CA3AF' } },
        x: { grid: { display: false }, ticks: { color: '#9CA3AF' } }
      }
    }
  });

  // Spend by Category Chart
  const catData = reportsData.by_category || [];
  const palette = ['#10B981', '#F59E0B', '#EF4444', '#3B82F6', '#8B5CF6', '#EC4899', '#06B6D4', '#14B8A6', '#6366F1', '#64748B'];
  chartCategories = new Chart(catCanvas, {
    type: 'doughnut',
    data: {
      labels: catData.map(c => c.category),
      datasets: [{
        data: catData.map(c => c.total_spend),
        backgroundColor: palette.slice(0, catData.length),
        borderWidth: 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'right', labels: { color: '#D1D5DB', boxWidth: 12 } }
      }
    }
  });
}

function renderItemsTable() {
  const tbody = document.getElementById('tbody-items-report');
  const search = (document.getElementById('filter-search-item')?.value || '').toLowerCase().trim();
  const items = (reportsData.by_item || []).filter(i => (i.clean_name || '').toLowerCase().includes(search));

  if (items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted">No items found matching filter.</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  items.forEach(item => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${escapeHtml(item.clean_name)}</strong></td>
      <td><span class="badge badge-info">${escapeHtml(item.category || 'Other')}</span></td>
      <td>${item.total_quantity} ${item.unit || ''}</td>
      <td>€${(item.avg_unit_price || 0).toFixed(2)}</td>
      <td><strong>€${(item.total_cost || 0).toFixed(2)}</strong></td>
      <td>${item.purchase_count}</td>
      <td>${item.last_purchased || 'N/A'}</td>
    `;
    tbody.appendChild(tr);
  });
}

function filterItemsTable() {
  renderItemsTable();
}

function exportData(format) {
  const provider = document.getElementById('filter-provider')?.value || '';
  const category = document.getElementById('filter-category')?.value || '';
  const params = new URLSearchParams({ format });
  if (provider) params.append('provider', provider);
  if (category) params.append('category', category);
  window.open(`/api/reports/export?${params.toString()}`, '_blank');
}

// -------------------------------------------------------------
// CONSUMPTION & REPLENISHMENT ESTIMATOR
// -------------------------------------------------------------
async function loadConsumption() {
  const tbody = document.getElementById('tbody-consumption');
  tbody.innerHTML = '<tr><td colspan="7" class="text-center">Calculating consumption and burn rates...</td></tr>';

  try {
    const res = await fetch('/api/consumption');
    const data = await res.json();
    consumptionData = data.metrics || [];
    renderConsumptionView();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center" style="color:var(--accent-rose);">Error: ${err.message}</td></tr>`;
  }
}

function filterConsumption(status, btn) {
  consumptionFilter = status;
  document.querySelectorAll('.pill-filters .pill').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  renderConsumptionView();
}

function renderConsumptionView() {
  const tbody = document.getElementById('tbody-consumption');
  const overdueCount = consumptionData.filter(i => i.status === 'overdue').length;
  const lowCount = consumptionData.filter(i => i.status === 'low').length;
  const okCount = consumptionData.filter(i => i.status === 'ok').length;

  document.getElementById('count-all-c').innerText = consumptionData.length;
  document.getElementById('count-overdue-c').innerText = overdueCount;
  document.getElementById('count-low-c').innerText = lowCount;
  document.getElementById('count-ok-c').innerText = okCount;

  const restockBadge = document.getElementById('badge-restock');
  const alertTotal = overdueCount + lowCount;
  if (alertTotal > 0) {
    restockBadge.innerText = alertTotal;
    restockBadge.style.display = 'inline-block';
  } else {
    restockBadge.style.display = 'none';
  }

  // Update Alert Box
  const summaryBox = document.getElementById('replenish-alert-summary');
  if (overdueCount > 0) {
    const urgentNames = consumptionData.filter(i => i.status === 'overdue').slice(0, 3).map(i => i.clean_name).join(', ');
    summaryBox.innerHTML = `<strong style="color:var(--accent-rose);">⚠️ Action Required:</strong> <strong>${overdueCount} items</strong> need restock (${urgentNames}${overdueCount > 3 ? '...' : ''}).`;
  } else if (lowCount > 0) {
    summaryBox.innerHTML = `<strong style="color:var(--accent-amber);">⚡ Notice:</strong> ${lowCount} items are running low and will deplete within 3 days.`;
  } else {
    summaryBox.innerHTML = `✅ All grocery items are sufficiently stocked based on your purchase trends.`;
  }

  let filtered = consumptionData;
  if (consumptionFilter !== 'all') {
    filtered = consumptionData.filter(i => i.status === consumptionFilter);
  }

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted">No items in this replenishment category.</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  filtered.forEach(item => {
    const tr = document.createElement('tr');
    const badgeClass = item.status === 'overdue' ? 'badge-danger' : item.status === 'low' ? 'badge-warning' : 'badge-success';
    tr.innerHTML = `
      <td>
        <strong>${escapeHtml(item.clean_name)}</strong>
        <div style="font-size:11px; color:var(--text-dim);">${item.category} • Bought ${item.purchase_count}x</div>
      </td>
      <td><strong>${item.daily_consumption}</strong> ${item.unit}/day</td>
      <td>${item.weekly_consumption} ${item.unit}/wk</td>
      <td>${item.monthly_consumption} ${item.unit}/mo</td>
      <td>
        <strong>${item.estimated_stock_remaining}</strong> ${item.unit}
        ${item.stock_source === 'audit' ? `
          <div style="font-size:10px; color:#A5B4FC; margin-top:2px;" title="Grounded in Pantry Stock Audit on ${item.last_audit_date}">
            📦 Audited (${item.last_audit_date})
          </div>
        ` : `
          <div style="font-size:10px; color:var(--text-dim); margin-top:2px;">
            🛒 Projected
          </div>
        `}
      </td>
      <td><strong>${item.estimated_days_left <= 0 ? '0 days' : `${item.estimated_days_left} d`}</strong></td>
      <td><span class="badge ${badgeClass}">${item.status_text}</span></td>
    `;
    tbody.appendChild(tr);
  });
}

// -------------------------------------------------------------
// SETTINGS
// -------------------------------------------------------------
async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    const s = await res.json();
    document.getElementById('input-primary-base-url').value = s.primary_api_base_url || 'https://opencode.ai/inference/openai/v1/responses';
    document.getElementById('input-primary-key').value = s.primary_api_key || '';
    document.getElementById('input-primary-model').value = s.primary_vision_model || 'gpt-6-luna';
    document.getElementById('input-ollama-base-url').value = s.ollama_base_url || 'http://127.0.0.1:11434';
    document.getElementById('input-ollama-model').value = s.ollama_model || 'gemma4:e2b';
    document.getElementById('input-ollama-timeout').value = s.ollama_timeout_seconds || '180';
  } catch (err) {
    console.error('Failed to load settings:', err);
  }
}

async function saveSettings(e) {
  e.preventDefault();
  const statusEl = document.getElementById('settings-status');
  statusEl.className = 'status-msg';
  statusEl.innerText = 'Saving settings...';

  const payload = {
    primary_api_base_url: document.getElementById('input-primary-base-url').value.trim(),
    primary_api_key: document.getElementById('input-primary-key').value.trim(),
    primary_vision_model: document.getElementById('input-primary-model').value.trim(),
    ollama_base_url: document.getElementById('input-ollama-base-url').value.trim(),
    ollama_model: document.getElementById('input-ollama-model').value.trim(),
    ollama_timeout_seconds: document.getElementById('input-ollama-timeout').value.trim(),
  };

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('Failed to update settings');
    statusEl.className = 'status-msg success';
    statusEl.innerText = '✓ Settings successfully saved!';
    await checkEngineStatus();
  } catch (err) {
    statusEl.className = 'status-msg error';
    statusEl.innerText = `Error: ${err.message}`;
  }
}

async function testPrimaryApiConnection() {
  const statusEl = document.getElementById('settings-status');
  statusEl.className = 'status-msg';
  statusEl.innerText = '⏳ Testing Primary API connection...';

  const payload = {
    base_url: document.getElementById('input-primary-base-url').value.trim(),
    api_key: document.getElementById('input-primary-key').value.trim(),
    model: document.getElementById('input-primary-model').value.trim(),
  };

  try {
    const res = await fetch('/api/settings/test-primary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      statusEl.className = 'status-msg success';
      statusEl.innerText = `✓ ${data.message}`;
    } else {
      statusEl.className = 'status-msg error';
      statusEl.innerText = `✗ ${data.message}`;
    }
  } catch (err) {
    statusEl.className = 'status-msg error';
    statusEl.innerText = `✗ Failed to test Primary API: ${err.message}`;
  }
}

async function testOllamaConnection() {
  const statusEl = document.getElementById('settings-status');
  statusEl.className = 'status-msg';
  statusEl.innerText = '⏳ Testing Ollama connection...';

  const payload = {
    base_url: document.getElementById('input-ollama-base-url').value.trim(),
    model: document.getElementById('input-ollama-model').value.trim()
  };

  try {
    const res = await fetch('/api/settings/test-ollama', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      statusEl.className = 'status-msg success';
      statusEl.innerText = `✓ ${data.message}`;
    } else {
      statusEl.className = 'status-msg error';
      statusEl.innerText = `✗ ${data.message}`;
    }
  } catch (err) {
    statusEl.className = 'status-msg error';
    statusEl.innerText = `✗ Ollama check failed: ${err.message}`;
  }
}

// -------------------------------------------------------------
// PANTRY STOCK AUDITS & INVENTORY
// -------------------------------------------------------------
let stockChecklist = {};
let stockAuditsHistory = [];
let activeInspectedAudit = null;
let receiptCatalogItems = [];
let activeStockCategoryFilter = 'all';
let collapsedStockCategories = new Set();

const DEFAULT_CATEGORIES_LOCAL = [
  { name: "Produce & Fresh", icon: "🥦" },
  { name: "Dairy & Eggs", icon: "🧀" },
  { name: "Bakery & Bread", icon: "🥖" },
  { name: "Meat & Seafood", icon: "🥩" },
  { name: "Pantry & Dry Goods", icon: "🍚" },
  { name: "Beverages & Drinks", icon: "☕" },
  { name: "Snacks & Sweets", icon: "🍪" },
  { name: "Frozen Foods", icon: "🧊" },
  { name: "Household & Cleaning", icon: "🧼" },
  { name: "Personal Care", icon: "🧴" },
  { name: "Other", icon: "📦" }
];

function initEmptyStockChecklist() {
  stockChecklist = {};
  const cats = categoriesList.length > 0 ? categoriesList : DEFAULT_CATEGORIES_LOCAL;
  cats.forEach(c => {
    stockChecklist[c.name] = [];
  });
}

async function fetchReceiptItemsCatalog() {
  try {
    const res = await fetch('/api/receipt-items/catalog');
    const data = await res.json();
    receiptCatalogItems = data.items || [];

    const datalist = document.getElementById('datalist-parsed-items');
    if (datalist) {
      datalist.innerHTML = receiptCatalogItems.map(it => 
        `<option value="${escapeHtml(it.item_name)}">${escapeHtml(it.category)} (${escapeHtml(it.unit || 'unit')})</option>`
      ).join('');
    }
  } catch (err) {
    console.error('Failed to load receipt items catalog:', err);
  }
}

function populateChecklistFromReceiptCatalog(showNotice = false) {
  if (receiptCatalogItems.length === 0) {
    if (showNotice) alert('No items found from parsed receipts yet. Scan and confirm receipts first!');
    return;
  }

  initEmptyStockChecklist();
  let count = 0;
  receiptCatalogItems.forEach(it => {
    const cat = it.category || 'Other';
    if (!stockChecklist[cat]) stockChecklist[cat] = [];
    stockChecklist[cat].push({
      item_name: it.item_name,
      quantity: it.avg_quantity ? Math.round(it.avg_quantity * 10) / 10 : 1.0,
      unit: it.unit || 'unit',
      status: 'in_stock',
      notes: '',
      times_bought: it.times_bought,
      last_purchased: it.last_purchased
    });
    count++;
  });

  renderStockCategoryPills();
  renderStockChecklist();
  if (showNotice) {
    alert(`✓ Pre-filled checklist with ${count} items parsed from receipts across all categories!`);
  }
}

async function loadStockAuditView() {
  const dateInput = document.getElementById('input-audit-date');
  if (dateInput && !dateInput.value) {
    dateInput.value = new Date().toISOString().substring(0, 10);
  }

  await fetchReceiptItemsCatalog();

  const currentCount = Object.values(stockChecklist).reduce((acc, list) => acc + list.length, 0);
  if (currentCount === 0 && receiptCatalogItems.length > 0) {
    populateChecklistFromReceiptCatalog(false);
  } else if (Object.keys(stockChecklist).length === 0) {
    initEmptyStockChecklist();
  }

  renderStockCategoryPills();
  renderStockChecklist();
  await loadStockAuditsHistory();
}

function renderStockCategoryPills() {
  const pillsContainer = document.getElementById('stock-category-pills');
  if (!pillsContainer) return;

  const cats = categoriesList.length > 0 ? categoriesList : DEFAULT_CATEGORIES_LOCAL;
  const totalItems = Object.values(stockChecklist).reduce((acc, list) => acc + list.length, 0);

  let html = `<button type="button" class="pill ${activeStockCategoryFilter === 'all' ? 'active' : ''}" onclick="setStockCategoryFilter('all')">All Items (${totalItems})</button>`;

  cats.forEach(c => {
    const count = (stockChecklist[c.name] || []).length;
    if (count > 0 || receiptCatalogItems.some(it => it.category === c.name)) {
      html += `<button type="button" class="pill ${activeStockCategoryFilter === c.name ? 'active' : ''}" onclick="setStockCategoryFilter('${escapeHtml(c.name)}')">${c.icon || '📦'} ${escapeHtml(c.name)} (${count})</button>`;
    }
  });

  pillsContainer.innerHTML = html;
}

function setStockCategoryFilter(catName) {
  activeStockCategoryFilter = catName;
  renderStockCategoryPills();
  renderStockChecklist();
}

function markCategoryAllInStock(categoryName) {
  if (stockChecklist[categoryName]) {
    stockChecklist[categoryName].forEach(it => it.status = 'in_stock');
    renderStockChecklist();
  }
}

function toggleStockCategoryCollapse(categoryName) {
  if (collapsedStockCategories.has(categoryName)) {
    collapsedStockCategories.delete(categoryName);
  } else {
    collapsedStockCategories.add(categoryName);
  }
  renderStockChecklist();
}

function expandAllStockCategories() {
  collapsedStockCategories.clear();
  renderStockChecklist();
}

function collapseAllStockCategories() {
  const cats = categoriesList.length > 0 ? categoriesList : DEFAULT_CATEGORIES_LOCAL;
  cats.forEach(c => collapsedStockCategories.add(c.name));
  renderStockChecklist();
}

function renderStockChecklist() {
  const container = document.getElementById('stock-categories-checklist');
  if (!container) return;
  container.innerHTML = '';

  const cats = categoriesList.length > 0 ? categoriesList : DEFAULT_CATEGORIES_LOCAL;
  const filterQuery = (document.getElementById('stock-filter-items')?.value || '').toLowerCase().trim();

  let totalItemsCount = 0;
  let activeCategoriesCount = 0;
  let inStockCount = 0;
  let lowCount = 0;
  let outCount = 0;

  cats.forEach(cat => {
    const items = stockChecklist[cat.name] || [];

    // Count stats regardless of text search filter
    items.forEach(it => {
      totalItemsCount++;
      if (it.status === 'low') lowCount++;
      else if (it.status === 'out_of_stock') outCount++;
      else inStockCount++;
    });
    if (items.length > 0) activeCategoriesCount++;

    // Filter by active category pill
    if (activeStockCategoryFilter !== 'all' && cat.name !== activeStockCategoryFilter) {
      return;
    }

    // Filter items if text search active
    const filteredItems = items.filter(it =>
      !filterQuery ||
      (it.item_name || '').toLowerCase().includes(filterQuery) ||
      cat.name.toLowerCase().includes(filterQuery) ||
      (it.notes || '').toLowerCase().includes(filterQuery)
    );

    // If search active and no items match, skip category card
    if (filterQuery && filteredItems.length === 0 && !cat.name.toLowerCase().includes(filterQuery)) {
      return;
    }

    const isCollapsed = collapsedStockCategories.has(cat.name);
    const card = document.createElement('div');
    card.className = `stock-category-card ${isCollapsed ? 'is-collapsed' : ''}`;

    const hasItems = items.length > 0;
    const inStockCountForCat = items.filter(i => i.status === 'in_stock').length;
    const lowCountForCat = items.filter(i => i.status === 'low').length;
    const outCountForCat = items.filter(i => i.status === 'out_of_stock').length;

    card.innerHTML = `
      <div class="cat-card-header" onclick="toggleStockCategoryCollapse('${escapeHtml(cat.name)}')">
        <div class="cat-title-wrap">
          <span class="cat-chevron" title="${isCollapsed ? 'Click to expand' : 'Click to collapse'}">▼</span>
          <span style="font-size: 18px;">${cat.icon || '📦'}</span>
          <h4>${escapeHtml(cat.name)}</h4>
          <span class="cat-count-badge ${hasItems ? 'has-items' : ''}">
            ${items.length} ${items.length === 1 ? 'item' : 'items'}
          </span>
          ${isCollapsed && hasItems ? `
            <span class="cat-collapsed-summary">
              (🟢 ${inStockCountForCat} in stock${lowCountForCat > 0 ? ` • 🟡 ${lowCountForCat} low` : ''}${outCountForCat > 0 ? ` • 🔴 ${outCountForCat} out` : ''})
            </span>
          ` : ''}
        </div>
        <div class="stock-cat-actions">
          ${hasItems ? `
            <button type="button" class="btn btn-secondary btn-xs" onclick="event.stopPropagation(); markCategoryAllInStock('${escapeHtml(cat.name)}')" title="Set all items in this category to In Stock">
              ✓ All In Stock
            </button>
          ` : ''}
          <button type="button" class="btn btn-secondary btn-xs" onclick="event.stopPropagation(); addStockItem('${escapeHtml(cat.name)}')">
            ➕ Add Item
          </button>
        </div>
      </div>
      <div class="cat-card-body">
        ${items.length === 0 ? `
          <div class="stock-cat-empty">
            <span>No items recorded in ${escapeHtml(cat.name)}.</span>
            <button type="button" class="btn btn-secondary btn-xs" onclick="addStockItem('${escapeHtml(cat.name)}')">
              + Add Item
            </button>
          </div>
        ` : `
          <div class="table-responsive">
            <table class="stock-items-table">
              <thead>
                <tr>
                  <th style="width: 34%;">Item Name (Parsed from Receipts)</th>
                  <th style="width: 13%;">Qty</th>
                  <th style="width: 13%;">Unit</th>
                  <th style="width: 18%;">Stock Level</th>
                  <th style="width: 16%;">Notes</th>
                  <th style="width: 6%; text-align: center;"></th>
                </tr>
              </thead>
              <tbody>
                ${items.map((item, idx) => `
                  <tr>
                    <td>
                      <div class="stock-item-cell">
                        ${item.is_custom ? `
                          <input type="text" list="datalist-parsed-items" class="stock-input" placeholder="Select or type item name..." 
                                 value="${escapeHtml(item.item_name || '')}" 
                                 oninput="onStockItemNameInput('${escapeHtml(cat.name)}', ${idx}, this.value)">
                        ` : `
                          <span class="stock-item-title">${escapeHtml(item.item_name)}</span>
                          ${item.times_bought ? `
                            <span class="stock-item-meta">
                              Bought ${item.times_bought}x${item.last_purchased ? ` • Last: ${item.last_purchased}` : ''}
                            </span>
                          ` : ''}
                        `}
                      </div>
                    </td>
                    <td>
                      <input type="number" step="0.5" min="0" class="stock-input" placeholder="0" 
                             value="${item.quantity !== undefined ? item.quantity : 1}" 
                             onchange="updateStockItem('${escapeHtml(cat.name)}', ${idx}, 'quantity', parseFloat(this.value)||0)">
                    </td>
                    <td>
                      <input type="text" class="stock-input" placeholder="unit, kg..." 
                             value="${escapeHtml(item.unit || 'unit')}" 
                             onchange="updateStockItem('${escapeHtml(cat.name)}', ${idx}, 'unit', this.value)">
                    </td>
                    <td>
                      <select class="stock-level-select" onchange="updateStockItem('${escapeHtml(cat.name)}', ${idx}, 'status', this.value)">
                        <option value="in_stock" ${item.status === 'in_stock' ? 'selected' : ''}>🟢 In Stock</option>
                        <option value="low" ${item.status === 'low' ? 'selected' : ''}>🟡 Running Low</option>
                        <option value="out_of_stock" ${item.status === 'out_of_stock' ? 'selected' : ''}>🔴 Out of Stock</option>
                      </select>
                    </td>
                    <td>
                      <input type="text" class="stock-input" placeholder="optional notes..." 
                             value="${escapeHtml(item.notes || '')}" 
                             onchange="updateStockItem('${escapeHtml(cat.name)}', ${idx}, 'notes', this.value)">
                    </td>
                    <td style="text-align: center;">
                      <button type="button" class="btn-delete-row" title="Remove Item" onclick="deleteStockItem('${escapeHtml(cat.name)}', ${idx})">
                        🗑️
                      </button>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `}
      </div>
    `;
    container.appendChild(card);
  });

  // Update Stats Ribbon
  const statTotal = document.getElementById('stat-stock-total-items');
  const statCats = document.getElementById('stat-stock-categories');
  const statIn = document.getElementById('stat-stock-in-stock');
  const statLow = document.getElementById('stat-stock-low');
  const statOut = document.getElementById('stat-stock-out');

  if (statTotal) statTotal.textContent = totalItemsCount;
  if (statCats) statCats.textContent = activeCategoriesCount;
  if (statIn) statIn.textContent = inStockCount;
  if (statLow) statLow.textContent = lowCount;
  if (statOut) statOut.textContent = outCount;
}

function filterStockChecklistView() {
  renderStockChecklist();
}

function addStockItem(categoryName) {
  collapsedStockCategories.delete(categoryName);
  if (!stockChecklist[categoryName]) {
    stockChecklist[categoryName] = [];
  }
  stockChecklist[categoryName].push({
    item_name: '',
    quantity: 1.0,
    unit: 'unit',
    status: 'in_stock',
    notes: '',
    is_custom: true
  });
  renderStockCategoryPills();
  renderStockChecklist();
}

function onStockItemNameInput(catName, idx, val) {
  updateStockItem(catName, idx, 'item_name', val);
  const matched = receiptCatalogItems.find(i => (i.item_name || '').toLowerCase() === (val || '').toLowerCase().trim());
  if (matched && matched.unit) {
    updateStockItem(catName, idx, 'unit', matched.unit);
  }
}

function updateStockItem(categoryName, idx, field, value) {
  if (stockChecklist[categoryName] && stockChecklist[categoryName][idx]) {
    stockChecklist[categoryName][idx][field] = value;
    if (field === 'status') {
      renderStockChecklist();
    }
  }
}

function deleteStockItem(categoryName, idx) {
  if (stockChecklist[categoryName]) {
    stockChecklist[categoryName].splice(idx, 1);
    renderStockCategoryPills();
    renderStockChecklist();
  }
}

function clearStockChecklist() {
  if (confirm('Clear the entire checklist? This will reset and remove all item rows.')) {
    initEmptyStockChecklist();
    renderStockCategoryPills();
    renderStockChecklist();
  }
}

function clearAllStockQuantities() {
  const totalItems = Object.values(stockChecklist).reduce((acc, list) => acc + list.length, 0);
  if (totalItems === 0) {
    alert('No items currently loaded in the checklist.');
    return;
  }
  if (confirm(`Set quantities to 0 for all ${totalItems} loaded items?`)) {
    Object.keys(stockChecklist).forEach(cat => {
      (stockChecklist[cat] || []).forEach(it => {
        it.quantity = 0;
      });
    });
    renderStockChecklist();
  }
}

async function saveStockAuditReport() {
  const dateInput = document.getElementById('input-audit-date');
  const notesInput = document.getElementById('input-audit-notes');
  const btn = document.getElementById('btn-save-stock-audit');

  const auditDate = (dateInput?.value || '').trim();
  if (!auditDate) {
    alert('Please specify an Audit Date.');
    return;
  }

  // Flatten items
  const items = [];
  Object.keys(stockChecklist).forEach(cat => {
    (stockChecklist[cat] || []).forEach(it => {
      const name = (it.item_name || '').trim();
      if (name) {
        items.push({
          category: cat,
          item_name: name,
          quantity: parseFloat(it.quantity) || 0.0,
          unit: (it.unit || 'unit').trim(),
          status: it.status || 'in_stock',
          notes: (it.notes || '').trim()
        });
      }
    });
  });

  if (items.length === 0) {
    alert('Please enter at least one item before recording your stock audit report.');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Saving Report...';

  try {
    const res = await fetch('/api/stock-audits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audit_date: auditDate,
        notes: (notesInput?.value || '').trim(),
        items: items
      })
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || 'Server failed to save audit');
    }

    alert(`✓ Stock audit recorded successfully! (${items.length} items on ${auditDate})`);
    await loadStockAuditsHistory();
  } catch (err) {
    alert(`Failed to save stock audit: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '💾 Record Stock Report';
  }
}

async function loadPreviousAuditIntoChecklist() {
  try {
    const res = await fetch('/api/stock-audits/latest');
    const data = await res.json();
    if (!data.audit || !data.audit.items || data.audit.items.length === 0) {
      alert('No previous stock audit found to load. Start by adding items to the categories above!');
      return;
    }

    initEmptyStockChecklist();
    data.audit.items.forEach(it => {
      const cat = it.category || 'Other';
      if (!stockChecklist[cat]) stockChecklist[cat] = [];
      stockChecklist[cat].push({
        item_name: it.item_name,
        quantity: it.quantity,
        unit: it.unit || 'unit',
        status: it.status || 'in_stock',
        notes: it.notes || ''
      });
    });

    const notesInput = document.getElementById('input-audit-notes');
    if (notesInput) {
      notesInput.value = `Updated from previous audit on ${data.audit.audit_date}`;
    }

    renderStockCategoryPills();
    renderStockChecklist();
    alert(`✓ Loaded ${data.audit.items.length} items from previous audit (${data.audit.audit_date}). You can now adjust current counts!`);
  } catch (err) {
    alert(`Failed to load previous audit: ${err.message}`);
  }
}

async function loadStockAuditsHistory() {
  const tbody = document.getElementById('tbody-stock-history');
  if (!tbody) return;

  try {
    const res = await fetch('/api/stock-audits');
    const data = await res.json();
    stockAuditsHistory = data.audits || [];

    if (stockAuditsHistory.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted">No stock audits recorded yet. Complete your first audit above!</td></tr>';
      return;
    }

    tbody.innerHTML = '';
    stockAuditsHistory.forEach(a => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${escapeHtml(a.audit_date)}</strong></td>
        <td><span class="text-muted" style="font-size:12px;">${(a.created_at || '').substring(0, 16)}</span></td>
        <td><strong>${a.item_count || 0}</strong> items</td>
        <td><span class="badge badge-info">${a.category_count || 0} categories</span></td>
        <td>
          <span class="stock-badge in_stock" title="In Stock">🟢 ${a.in_stock_count || 0}</span>
          ${a.low_stock_count > 0 ? `<span class="stock-badge low" title="Running Low">🟡 ${a.low_stock_count}</span>` : ''}
          ${a.out_of_stock_count > 0 ? `<span class="stock-badge out_of_stock" title="Out of Stock">🔴 ${a.out_of_stock_count}</span>` : ''}
        </td>
        <td>${a.notes ? escapeHtml(a.notes) : '<span class="text-dim">—</span>'}</td>
        <td>
          <div style="display:flex; gap:6px;">
            <button class="btn btn-secondary btn-xs" onclick="openAuditDetailModal(${a.id})">Inspect</button>
            <button class="btn btn-secondary btn-xs" onclick="loadAuditIntoChecklistById(${a.id})" title="Load this audit into the form above">Load</button>
            <button class="btn-delete-row" title="Delete Audit" onclick="deleteStockAuditReport(${a.id})">🗑️</button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center" style="color:var(--accent-rose);">Failed to load history: ${err.message}</td></tr>`;
  }
}

async function openAuditDetailModal(auditId) {
  try {
    const res = await fetch(`/api/stock-audits/${auditId}`);
    const data = await res.json();
    if (!data.audit) throw new Error('Audit not found');

    activeInspectedAudit = data.audit;
    document.getElementById('audit-detail-title').innerText = `Stock Audit: ${data.audit.audit_date}`;
    document.getElementById('audit-detail-date-badge').innerText = `Snapshot #${data.audit.id} • ${data.audit.audit_date}`;
    document.getElementById('audit-detail-meta').innerHTML = `
      <strong>Recorded:</strong> ${data.audit.created_at || data.audit.audit_date} • 
      <strong>Total Items:</strong> ${data.audit.items.length}
      ${data.audit.notes ? ` • <strong>Notes:</strong> ${escapeHtml(data.audit.notes)}` : ''}
    `;

    // Group items by category
    const grouped = {};
    data.audit.items.forEach(it => {
      const c = it.category || 'Other';
      if (!grouped[c]) grouped[c] = [];
      grouped[c].push(it);
    });

    const content = document.getElementById('audit-detail-content');
    content.innerHTML = '';

    Object.keys(grouped).sort().forEach(catName => {
      const groupCard = document.createElement('div');
      groupCard.className = 'audit-detail-group-card';
      const itemsList = grouped[catName];

      groupCard.innerHTML = `
        <div class="audit-detail-group-header">
          <span>📦</span>
          <span>${escapeHtml(catName)} (${itemsList.length})</span>
        </div>
        <table class="stock-items-table" style="font-size:13px;">
          <thead>
            <tr>
              <th>Item Name</th>
              <th>Quantity</th>
              <th>Status</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            ${itemsList.map(it => `
              <tr>
                <td><strong>${escapeHtml(it.item_name)}</strong></td>
                <td>${it.quantity} ${escapeHtml(it.unit || 'unit')}</td>
                <td>
                  <span class="stock-badge ${it.status}">
                    ${it.status === 'in_stock' ? '🟢 In Stock' : it.status === 'low' ? '🟡 Running Low' : '🔴 Out of Stock'}
                  </span>
                </td>
                <td>${it.notes ? escapeHtml(it.notes) : '<span class="text-dim">—</span>'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
      content.appendChild(groupCard);
    });

    document.getElementById('modal-audit-detail').style.display = 'flex';
  } catch (err) {
    alert(`Failed to load audit snapshot: ${err.message}`);
  }
}

function closeAuditDetailModal() {
  document.getElementById('modal-audit-detail').style.display = 'none';
  activeInspectedAudit = null;
}

function loadAuditIntoChecklistFromDetail() {
  if (!activeInspectedAudit) return;
  loadAuditDataIntoChecklist(activeInspectedAudit);
  closeAuditDetailModal();
}

function loadAuditIntoChecklistById(auditId) {
  openAuditDetailModal(auditId).then(() => {
    loadAuditIntoChecklistFromDetail();
  });
}

function loadAuditDataIntoChecklist(audit) {
  initEmptyStockChecklist();
  (audit.items || []).forEach(it => {
    const cat = it.category || 'Other';
    if (!stockChecklist[cat]) stockChecklist[cat] = [];
    stockChecklist[cat].push({
      item_name: it.item_name,
      quantity: it.quantity,
      unit: it.unit || 'unit',
      status: it.status || 'in_stock',
      notes: it.notes || ''
    });
  });

  const notesInput = document.getElementById('input-audit-notes');
  if (notesInput) {
    notesInput.value = `Loaded from audit on ${audit.audit_date}`;
  }

  renderStockCategoryPills();
  renderStockChecklist();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function deleteStockAuditReport(auditId) {
  if (!confirm('Are you sure you want to delete this recorded stock audit?')) return;

  try {
    const res = await fetch(`/api/stock-audits/${auditId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Delete failed');
    await loadStockAuditsHistory();
  } catch (err) {
    alert(`Failed to delete audit: ${err.message}`);
  }
}

// -------------------------------------------------------------
// UTILITIES
// -------------------------------------------------------------
function showLoading(title, message) {
  document.getElementById('loading-message').innerText = title;
  document.getElementById('loading-sub').innerText = message;
  document.getElementById('loading-overlay').style.display = 'flex';
}

function hideLoading() {
  document.getElementById('loading-overlay').style.display = 'none';
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
