// Dashboard State
const state = {
  stats: null,
  logs: [],
  backends: [],
  tokenStats: null,
  selectedLog: null,
  refreshInterval: 30,
  countdown: 30,
  autoRefresh: true,
  charts: {
    tokensByBackend: null,
    tokensOverTime: null
  }
};

// API Base URL (relative to current host)
const API_BASE = '';

// DOM Elements
const elements = {
  // Overview
  totalRequests: document.getElementById('total-requests'),
  successRate: document.getElementById('success-rate'),
  avgLatency: document.getElementById('avg-latency'),
  requestsHour: document.getElementById('requests-hour'),

  // Badges
  smartRoutingBadge: document.getElementById('smart-routing-badge'),
  backendBadge: document.getElementById('backend-badge'),
  lastUpdated: document.getElementById('last-updated'),

  // Backends
  backendsList: document.getElementById('backends-list'),

  // Controls
  backendSelect: document.getElementById('backend-select'),
  switchBackendBtn: document.getElementById('switch-backend-btn'),
  toggleSmartBtn: document.getElementById('toggle-smart-btn'),
  clearLogsBtn: document.getElementById('clear-logs-btn'),

  // Filters
  filterBackend: document.getElementById('filter-backend'),
  filterStatus: document.getElementById('filter-status'),
  searchInput: document.getElementById('search-input'),
  refreshBtn: document.getElementById('refresh-btn'),

  // Conversations
  conversationsList: document.getElementById('conversations-list'),

  // Modal
  detailsModal: document.getElementById('details-modal'),
  detailRequest: document.getElementById('detail-request'),
  detailResponse: document.getElementById('detail-response'),
  detailTiming: document.getElementById('detail-timing'),
  detailRouting: document.getElementById('detail-routing'),

  // Category
  categoryChart: document.getElementById('category-chart'),

  // Performance
  performanceTbody: document.getElementById('performance-tbody'),

  // Tokens
  totalInputTokens: document.getElementById('total-input-tokens'),
  totalOutputTokens: document.getElementById('total-output-tokens'),
  totalTokens: document.getElementById('total-tokens'),
  tokensByBackendChart: document.getElementById('tokensByBackendChart'),
  tokensOverTimeChart: document.getElementById('tokensOverTimeChart'),

  // Footer
  refreshCountdown: document.getElementById('refresh-countdown')
};

// Fetch API data
async function fetchStats() {
  try {
    const response = await fetch(`${API_BASE}/debug/stats`);
    if (!response.ok) throw new Error('Failed to fetch stats');
    return await response.json();
  } catch (error) {
    console.error('Error fetching stats:', error);
    return null;
  }
}

async function fetchLogs(limit = 50) {
  try {
    const response = await fetch(`${API_BASE}/debug/logs?limit=${limit}`);
    if (!response.ok) throw new Error('Failed to fetch logs');
    const data = await response.json();
    return data.logs || [];
  } catch (error) {
    console.error('Error fetching logs:', error);
    return [];
  }
}

async function fetchBackends() {
  try {
    const response = await fetch(`${API_BASE}/debug/models`);
    if (!response.ok) throw new Error('Failed to fetch backends');
    return await response.json();
  } catch (error) {
    console.error('Error fetching backends:', error);
    return null;
  }
}

async function switchBackend(backend) {
  try {
    const response = await fetch(`${API_BASE}/debug/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backend })
    });
    if (!response.ok) throw new Error('Failed to switch backend');
    return await response.json();
  } catch (error) {
    console.error('Error switching backend:', error);
    return null;
  }
}

async function toggleSmartRouting() {
  try {
    const isEnabled = state.stats?.config?.smartRoutingEnabled;
    const action = isEnabled ? 'disable' : 'enable';
    const response = await fetch(`${API_BASE}/debug/router`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action })
    });
    if (!response.ok) throw new Error('Failed to toggle smart routing');
    return await response.json();
  } catch (error) {
    console.error('Error toggling smart routing:', error);
    return null;
  }
}

async function clearRouterHistory() {
  try {
    const response = await fetch(`${API_BASE}/debug/router`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'clearHistory' })
    });
    if (!response.ok) throw new Error('Failed to clear history');
    return await response.json();
  } catch (error) {
    console.error('Error clearing history:', error);
    return null;
  }
}

async function fetchTokenStats() {
  try {
    const response = await fetch(`${API_BASE}/debug/tokens`);
    if (!response.ok) throw new Error('Failed to fetch token stats');
    return await response.json();
  } catch (error) {
    console.error('Error fetching token stats:', error);
    return null;
  }
}

// Update UI functions
function updateOverview(stats) {
  if (!stats) return;

  const { overview, config } = stats;

  elements.totalRequests.textContent = overview.totalRequests;
  elements.successRate.textContent = `${overview.successRate}%`;
  elements.avgLatency.textContent = `${overview.avgLatency}ms`;
  elements.requestsHour.textContent = overview.requestsLastHour;

  // Update badges
  elements.smartRoutingBadge.textContent = `Smart Routing: ${config.smartRoutingEnabled ? 'ON' : 'OFF'}`;
  elements.smartRoutingBadge.className = `badge ${config.smartRoutingEnabled ? 'badge-success' : ''}`;

  elements.backendBadge.textContent = `Backend: ${config.defaultBackend}`;

  // Update select
  elements.backendSelect.value = config.defaultBackend;

  // Update timestamp
  elements.lastUpdated.textContent = `Updated: ${new Date().toLocaleTimeString()}`;
}

function updateBackendsList(backendsData) {
  if (!backendsData) return;

  const { models, defaultBackend } = backendsData;
  elements.backendsList.innerHTML = '';

  for (const backend of models) {
    const isDefault = backend.backend === defaultBackend;
    const statusClass = backend.status === 'running' || backend.status === 'available' ? 'online' :
                       backend.status === 'offline' || backend.status === 'error' ? 'offline' : 'unknown';

    const modelName = backend.models.length > 0 ?
      backend.models[0].replace(/\.gguf$/, '').replace(/-Q\d.*$/, '') :
      (backend.capabilities?.name || backend.backend);

    const item = document.createElement('div');
    item.className = `backend-item${isDefault ? ' default' : ''}`;
    item.innerHTML = `
      <div class="backend-info">
        <span class="backend-status ${statusClass}"></span>
        <span class="backend-name">${backend.backend}</span>
        <span class="backend-model">${modelName}</span>
      </div>
      <span class="badge">${backend.status}</span>
    `;
    item.onclick = () => {
      elements.backendSelect.value = backend.backend;
    };
    elements.backendsList.appendChild(item);
  }
}

function updateConversationsList(logs) {
  const filterBackend = elements.filterBackend.value;
  const filterStatus = elements.filterStatus.value;
  const searchTerm = elements.searchInput.value.toLowerCase();

  // Filter logs
  let filteredLogs = logs;

  if (filterBackend) {
    filteredLogs = filteredLogs.filter(log => log.destination === filterBackend);
  }

  if (filterStatus === 'success') {
    filteredLogs = filteredLogs.filter(log => log.response?.status && log.response.status < 400);
  } else if (filterStatus === 'error') {
    filteredLogs = filteredLogs.filter(log => !log.response?.status || log.response.status >= 400 || log.error);
  }

  if (searchTerm) {
    filteredLogs = filteredLogs.filter(log => {
      const body = log.request?.body || '';
      const response = log.response?.body || '';
      return body.toLowerCase().includes(searchTerm) || response.toLowerCase().includes(searchTerm);
    });
  }

  elements.conversationsList.innerHTML = '';

  for (const log of filteredLogs.slice(0, 50)) {
    const time = new Date(log.timestamp).toLocaleTimeString();
    const isSuccess = log.response?.status && log.response.status < 400;
    const latency = log.timing?.totalMs ? `${log.timing.totalMs}ms` : '-';

    // Get preview from request body
    let preview = '';
    try {
      const body = JSON.parse(log.request?.body || '{}');
      const messages = body.messages || [];
      const lastUser = messages.filter(m => m.role === 'user').pop();
      if (lastUser) {
        preview = (typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content))
          .substring(0, 80);
        if (preview.length >= 80) preview += '...';
      }
    } catch (e) {
      preview = log.request?.body?.substring(0, 80) || '';
    }

    const item = document.createElement('div');
    item.className = 'conversation-item';
    item.innerHTML = `
      <span class="conversation-time">${time}</span>
      <span class="conversation-backend">${log.destination || 'unknown'}</span>
      <span class="conversation-preview">${escapeHtml(preview)}</span>
      <span class="conversation-latency">${latency}</span>
      <span class="conversation-status">
        <span class="status-icon ${isSuccess ? 'success' : 'error'}">${isSuccess ? '✓' : '✗'}</span>
      </span>
    `;
    item.onclick = () => showLogDetails(log);
    elements.conversationsList.appendChild(item);
  }

  if (filteredLogs.length === 0) {
    elements.conversationsList.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--text-secondary)">No requests found</div>';
  }
}

function updateCategoryChart(stats) {
  if (!stats?.byCategory) return;

  const categories = stats.byCategory;
  const total = Object.values(categories).reduce((sum, count) => sum + count, 0);

  elements.categoryChart.innerHTML = '';

  const sortedCategories = Object.entries(categories).sort((a, b) => b[1] - a[1]);

  for (const [category, count] of sortedCategories) {
    const percentage = total > 0 ? Math.round((count / total) * 100) : 0;

    const bar = document.createElement('div');
    bar.className = 'category-bar';
    bar.innerHTML = `
      <span class="category-label">${category}</span>
      <div class="category-progress">
        <div class="category-fill" style="width: ${percentage}%"></div>
      </div>
      <span class="category-count">${count}</span>
    `;
    elements.categoryChart.appendChild(bar);
  }
}

function updatePerformanceTable(stats) {
  if (!stats?.byBackend) return;

  elements.performanceTbody.innerHTML = '';

  for (const [backend, data] of Object.entries(stats.byBackend)) {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td><strong>${backend}</strong></td>
      <td>${data.requests}</td>
      <td>${data.successRate}%</td>
      <td>${data.avgLatency}ms</td>
      <td style="color: ${data.errors > 0 ? 'var(--error)' : 'var(--text-secondary)'}">${data.errors}</td>
    `;
    elements.performanceTbody.appendChild(row);
  }
}

// Format large numbers with K/M suffix
function formatNumber(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
}

// Update token displays
function updateTokenDisplay(tokenStats) {
  if (!tokenStats) return;

  elements.totalInputTokens.textContent = formatNumber(tokenStats.total.input);
  elements.totalOutputTokens.textContent = formatNumber(tokenStats.total.output);
  elements.totalTokens.textContent = formatNumber(tokenStats.total.combined);
}

// Chart color palette
const chartColors = {
  primary: 'rgba(99, 102, 241, 0.8)',
  primaryBg: 'rgba(99, 102, 241, 0.2)',
  secondary: 'rgba(139, 92, 246, 0.8)',
  secondaryBg: 'rgba(139, 92, 246, 0.2)',
  success: 'rgba(16, 185, 129, 0.8)',
  successBg: 'rgba(16, 185, 129, 0.2)',
  warning: 'rgba(245, 158, 11, 0.8)',
  warningBg: 'rgba(245, 158, 11, 0.2)',
  error: 'rgba(239, 68, 68, 0.8)',
  errorBg: 'rgba(239, 68, 68, 0.2)',
  backendColors: [
    'rgba(99, 102, 241, 0.8)',   // indigo
    'rgba(16, 185, 129, 0.8)',   // green
    'rgba(245, 158, 11, 0.8)',   // amber
    'rgba(236, 72, 153, 0.8)',   // pink
    'rgba(59, 130, 246, 0.8)',   // blue
  ]
};

// Render tokens by backend bar chart
function renderTokensByBackend(tokenStats) {
  if (!tokenStats?.byBackend) return;

  const ctx = elements.tokensByBackendChart;
  if (!ctx) return;

  // Destroy existing chart if it exists
  if (state.charts.tokensByBackend) {
    state.charts.tokensByBackend.destroy();
  }

  const backends = Object.keys(tokenStats.byBackend);
  const inputData = backends.map(b => tokenStats.byBackend[b].input);
  const outputData = backends.map(b => tokenStats.byBackend[b].output);

  state.charts.tokensByBackend = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: backends,
      datasets: [
        {
          label: 'Input Tokens',
          data: inputData,
          backgroundColor: chartColors.primary,
          borderColor: chartColors.primary,
          borderWidth: 1
        },
        {
          label: 'Output Tokens',
          data: outputData,
          backgroundColor: chartColors.success,
          borderColor: chartColors.success,
          borderWidth: 1
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'top',
          labels: {
            color: '#8888a0',
            font: { size: 11 }
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: { color: '#8888a0' }
        },
        y: {
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: {
            color: '#8888a0',
            callback: (value) => formatNumber(value)
          }
        }
      }
    }
  });
}

// Render tokens over time line chart
function renderTokensOverTime(tokenStats) {
  if (!tokenStats?.byHour) return;

  const ctx = elements.tokensOverTimeChart;
  if (!ctx) return;

  // Destroy existing chart if it exists
  if (state.charts.tokensOverTime) {
    state.charts.tokensOverTime.destroy();
  }

  // Format hour labels to be more readable
  const labels = tokenStats.byHour.map(h => {
    const date = new Date(h.hour);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  });

  const totalData = tokenStats.byHour.map(h => h.total);

  state.charts.tokensOverTime = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Total Tokens',
          data: totalData,
          borderColor: chartColors.primary,
          backgroundColor: chartColors.primaryBg,
          fill: true,
          tension: 0.4,
          pointRadius: 2,
          pointHoverRadius: 6
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          callbacks: {
            label: (context) => `Tokens: ${formatNumber(context.raw)}`
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: {
            color: '#8888a0',
            maxRotation: 45,
            minRotation: 45,
            maxTicksLimit: 12
          }
        },
        y: {
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: {
            color: '#8888a0',
            callback: (value) => formatNumber(value)
          },
          beginAtZero: true
        }
      }
    }
  });
}

function showLogDetails(log) {
  state.selectedLog = log;

  // Format request
  let requestBody = 'No request body';
  try {
    requestBody = JSON.stringify(JSON.parse(log.request?.body || '{}'), null, 2);
  } catch (e) {
    requestBody = log.request?.body || 'No request body';
  }
  elements.detailRequest.textContent = requestBody;

  // Format response
  let responseBody = 'No response';
  try {
    responseBody = JSON.stringify(JSON.parse(log.response?.body || '{}'), null, 2);
  } catch (e) {
    responseBody = log.response?.body || log.error || 'No response';
  }
  elements.detailResponse.textContent = responseBody;

  // Format timing
  const timing = log.timing || {};
  elements.detailTiming.textContent = JSON.stringify({
    totalMs: timing.totalMs,
    backendMs: timing.backendMs,
    timestamp: log.timestamp
  }, null, 2);

  // Format routing
  const routing = log.smartRouting || { note: 'No smart routing data' };
  elements.detailRouting.textContent = JSON.stringify(routing, null, 2);

  // Show modal
  elements.detailsModal.classList.remove('hidden');

  // Reset to first tab
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
  document.querySelector('.tab-btn').classList.add('active');
  document.getElementById('tab-request').classList.add('active');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Event Listeners
function setupEventListeners() {
  // Switch backend button
  elements.switchBackendBtn.onclick = async () => {
    const backend = elements.backendSelect.value;
    const result = await switchBackend(backend);
    if (result) {
      await refreshData();
    }
  };

  // Toggle smart routing button
  elements.toggleSmartBtn.onclick = async () => {
    const result = await toggleSmartRouting();
    if (result) {
      await refreshData();
    }
  };

  // Clear logs button
  elements.clearLogsBtn.onclick = async () => {
    if (confirm('Clear router history? This cannot be undone.')) {
      const result = await clearRouterHistory();
      if (result) {
        await refreshData();
      }
    }
  };

  // Refresh button
  elements.refreshBtn.onclick = refreshData;

  // Filters
  elements.filterBackend.onchange = () => updateConversationsList(state.logs);
  elements.filterStatus.onchange = () => updateConversationsList(state.logs);
  elements.searchInput.oninput = debounce(() => updateConversationsList(state.logs), 300);

  // Modal close
  document.querySelector('.modal-close').onclick = () => {
    elements.detailsModal.classList.add('hidden');
  };

  elements.detailsModal.onclick = (e) => {
    if (e.target === elements.detailsModal) {
      elements.detailsModal.classList.add('hidden');
    }
  };

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.onclick = () => {
      const tabName = btn.dataset.tab;

      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));

      btn.classList.add('active');
      document.getElementById(`tab-${tabName}`).classList.add('active');
    };
  });

  // Keyboard shortcuts
  document.onkeydown = (e) => {
    if (e.key === 'Escape') {
      elements.detailsModal.classList.add('hidden');
    }
    if (e.key === 'r' && !e.ctrlKey && !e.metaKey && document.activeElement.tagName !== 'INPUT') {
      refreshData();
    }
  };
}

// Utility functions
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// Refresh data
async function refreshData() {
  const [stats, logs, backends, tokenStats] = await Promise.all([
    fetchStats(),
    fetchLogs(50),
    fetchBackends(),
    fetchTokenStats()
  ]);

  state.stats = stats;
  state.logs = logs;
  state.backends = backends;
  state.tokenStats = tokenStats;

  updateOverview(stats);
  updateBackendsList(backends);
  updateConversationsList(logs);
  updateCategoryChart(stats);
  updatePerformanceTable(stats);

  // Update token displays and charts
  updateTokenDisplay(tokenStats);
  renderTokensByBackend(tokenStats);
  renderTokensOverTime(tokenStats);

  state.countdown = state.refreshInterval;
}

// Countdown timer
function startCountdown() {
  setInterval(() => {
    if (state.autoRefresh) {
      state.countdown--;
      elements.refreshCountdown.textContent = state.countdown;

      if (state.countdown <= 0) {
        refreshData();
      }
    }
  }, 1000);
}

// Initialize
async function init() {
  setupEventListeners();
  await refreshData();
  startCountdown();
}

// Start the dashboard
init();
