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

// Initialize app on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  initApp();
});

async function initApp() {
  await loadCategories();
  await loadReceiptFiles();
  await checkEngineStatus();
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
    settings: { title: 'System & Vision AI Settings', subtitle: 'Configure primary Copencode/OpenAI-compatible endpoint and local Ollama fallback.' }
  };

  if (titleMap[tabName]) {
    document.getElementById('page-title').innerText = titleMap[tabName].title;
    document.getElementById('page-subtitle').innerText = titleMap[tabName].subtitle;
  }

  if (tabName === 'receipts') loadSavedReceipts();
  if (tabName === 'reports') loadReports();
  if (tabName === 'replenish') loadConsumption();
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
  grid.innerHTML = '<div class="loading-state">Scanning /receipts folder...</div>';

  try {
    const res = await fetch('/api/receipts/files');
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
            <h4>${file.filename}</h4>
            <div class="file-meta">
              <span>${sizeKB} KB</span> • 
              <span>${file.modified_at}</span>
            </div>
            ${isSaved ? `
              <div style="margin-top:6px; font-size:12px; color:#10B981;">
                <strong>${file.provider || 'Saved Store'}</strong> • €${(file.total_amount || 0).toFixed(2)} (${file.item_count} items)
                ${file.invoice_id ? ` • <span style="color:#64748B;">ID: ${escapeHtml(file.invoice_id)}</span>` : ''}
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
              <button class="btn btn-secondary btn-sm" onclick="viewExistingReceipt(${file.receipt_id}, '${file.filename}')">View</button>
            ` : ''}
            <button class="btn btn-primary btn-sm" onclick="parseReceiptFile('${file.filename}')">
              ${isSaved ? 'Re-Parse' : '⚡ Parse Receipt'}
            </button>
          </div>
        </div>
      `;
      grid.appendChild(card);
    });
  } catch (err) {
    grid.innerHTML = `<div class="error-state">Failed to scan receipts directory: ${err.message}</div>`;
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
    const q = currentReviewData.items[index].quantity || 1.0;
    const p = currentReviewData.items[index].unit_price || 0.0;
    currentReviewData.items[index].total_price = Math.round(q * p * 100) / 100;
    renderReviewItemsTable();
    recalculateReceiptTotal();
  }
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
}

function removeReviewItem(index) {
  currentReviewData.items.splice(index, 1);
  renderReviewItemsTable();
  recalculateReceiptTotal();
}

function recalculateReceiptTotal() {
  const sum = (currentReviewData.items || []).reduce((acc, curr) => acc + (parseFloat(curr.total_price) || 0), 0);
  document.getElementById('input-meta-total').value = sum.toFixed(2);
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
    tbody.innerHTML = `<tr><td colspan="6" class="text-center" style="color:var(--accent-rose);">Failed to load receipts: ${err.message}</td></tr>`;
  }
}

function renderSavedReceiptsTable() {
  const tbody = document.getElementById('tbody-saved-receipts');
  const search = (document.getElementById('receipts-search')?.value || '').toLowerCase().trim();

  const filtered = savedReceipts.filter(r => {
    return (r.provider || '').toLowerCase().includes(search) ||
           (r.receipt_date || '').toLowerCase().includes(search);
  });

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">No saved receipts found.</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  filtered.forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${r.receipt_date}</strong></td>
      <td><span class="badge badge-info">${escapeHtml(r.provider)}</span></td>
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
      <td>${item.estimated_stock_remaining} ${item.unit}</td>
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
