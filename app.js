/* ============================================================
   MailCheck — The Dead Letter Office
   app.js — Frontend logic: input, chunking, rendering, filters
   ============================================================ */

// --- Constants ---
const MAX_ADDRESSES = 1000;
const CHUNK_SIZE = 50;
const ANIMATE_FIRST_N = 30;
const STAGGER_MS = 15;
const API_URL = '/api/verify';
const CLIENT_TIMEOUT_MS = 15000;

const STATUS_LABELS = {
  likely_deliverable: { primary: 'LIKELY DELIVERABLE', secondary: 'CLEARED FOR DELIVERY', glyph: '✓', cssClass: 'stamp-likely_deliverable' },
  likely_bounce:      { primary: 'LIKELY BOUNCE',      secondary: 'RETURN TO SENDER',      glyph: '✕ ↩', cssClass: 'stamp-likely_bounce' },
  unknown:            { primary: 'UNKNOWN',            secondary: 'DEAD LETTER — NOT CONFIRMED', glyph: '?', cssClass: 'stamp-unknown' },
};

const POSTMARK_ABBR = { syntax: 'SYN', mx: 'MX', recipient: 'RCPT' };

const POSTMARK_DISPLAY = {
  syntax: { pass: 'PASS', fail: 'FAIL', error: 'ERROR', not_checked: 'NOT CHECKED' },
  mx: { found: 'FOUND', none: 'NONE', domain_not_found: 'DOMAIN NOT FOUND', error: 'ERROR', not_checked: 'NOT CHECKED' },
  recipient: { not_checked: 'NOT CHECKED', accepted: 'ACCEPTED', rejected: 'REJECTED', inconclusive: 'INCONCLUSIVE' },
};

// Design Document §15 sample addresses
const SAMPLE_ADDRESSES = [
  'alice@gmail.com',
  'bob@company.com',
  'wrong-email',
  'someone@nonexistent-domain-xyz.com',
];

// --- State ---
let allResults = [];          // Array of { email, status, reason, checks, count }
let activeFilter = 'all';
let sortColumn = null;
let sortDirection = 'none';
let isVerifying = false;
let currentSessionId = 0;
let activeAbortController = null;
let lastFailedChunks = [];
let lastCounts = new Map();

// --- DOM References ---
const $textarea = document.getElementById('email-input');
const $counter = document.getElementById('address-counter');
const $validationNote = document.getElementById('validation-note');
const $verifyBtn = document.getElementById('verify-btn');
const $cancelBtn = document.getElementById('cancel-btn');
const $cancelBtnCollapsed = document.getElementById('cancel-btn-collapsed');
const $clearBtn = document.getElementById('clear-btn');
const $sampleBtn = document.getElementById('sample-btn');
const $intakeSlip = document.getElementById('intake-slip');
const $intakeCollapsed = document.getElementById('intake-collapsed');
const $intakeSummary = document.getElementById('intake-summary-text');
const $editListBtn = document.getElementById('edit-list-btn');
const $pigeonholes = document.getElementById('pigeonholes');
const $progressStrip = document.getElementById('progress-strip');
const $errorBanner = document.getElementById('error-banner');
const $errorMessage = document.getElementById('error-message');
const $retryBtn = document.getElementById('retry-btn');
const $exportButtons = document.getElementById('export-buttons');
const $csvBtn = document.getElementById('csv-btn');
const $copyBtn = document.getElementById('copy-btn');
const $ledgerWrap = document.getElementById('ledger-wrap');
const $ledgerBody = document.getElementById('ledger-body');
const $plainViewBtn = document.getElementById('plain-view-btn');
const $resultsDivider = document.getElementById('results-divider');

// --- Init ---
function init() {
  setPostmarkDate();
  bindEvents();
  updateCounter();
}

function setPostmarkDate() {
  const now = new Date();
  const dayEl = document.getElementById('postmark-day');
  const monthYearEl = document.getElementById('postmark-month-year');
  if (dayEl) dayEl.textContent = now.getDate();
  if (monthYearEl) {
    const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    monthYearEl.textContent = `${months[now.getMonth()]} ${now.getFullYear()}`;
  }
}

function bindEvents() {
  $textarea.addEventListener('input', updateCounter);
  $verifyBtn.addEventListener('click', () => handleVerify(false));
  if ($cancelBtn) $cancelBtn.addEventListener('click', handleCancel);
  if ($cancelBtnCollapsed) $cancelBtnCollapsed.addEventListener('click', handleCancel);
  $clearBtn.addEventListener('click', handleClear);
  $sampleBtn.addEventListener('click', handleLoadSample);
  $editListBtn.addEventListener('click', handleEditList);
  $retryBtn.addEventListener('click', handleRetry);
  $csvBtn.addEventListener('click', handleExportCSV);
  $copyBtn.addEventListener('click', handleCopyResults);
  $plainViewBtn.addEventListener('click', handlePlainViewToggle);

  // Pigeonhole filter clicks (native buttons trigger on click/enter/space)
  document.querySelectorAll('.pigeonhole').forEach(btn => {
    btn.addEventListener('click', () => {
      setActiveFilter(btn.dataset.filter);
    });
  });

  // Sortable column headers
  document.querySelectorAll('.ledger thead th.sortable').forEach(th => {
    th.addEventListener('click', () => handleSort(th));
    th.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleSort(th);
      }
    });
  });
}

// --- Helpers ---
function getLines() {
  return $textarea.value.split('\n').map(l => l.trim()).filter(l => l.length > 0);
}

function updateCounter() {
  const lines = getLines();
  const count = lines.length;
  $counter.textContent = `${count.toLocaleString()} address${count !== 1 ? 'es' : ''} · max 1,000`;

  if (count > MAX_ADDRESSES) {
    $counter.classList.add('over-limit');
    $validationNote.hidden = false;
    $validationNote.classList.add('visible');
    $verifyBtn.disabled = true;
  } else {
    $counter.classList.remove('over-limit');
    $validationNote.hidden = true;
    $validationNote.classList.remove('visible');
    $verifyBtn.disabled = false;
  }
}

/**
 * Deterministic hash for stamp rotation.
 * Returns a rotation in degrees between -4 and +4.
 */
function emailHash(email) {
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = ((hash << 5) - hash + email.charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * Return a CSS class name for stamp rotation based on email hash.
 * Maps to one of 17 classes: stamp-rot-n40, stamp-rot-n35, ..., stamp-rot-0, ..., stamp-rot-p40.
 */
function stampRotationClass(email) {
  const h = emailHash(email);
  // Map to 0–16 (17 steps: -4, -3.5, ..., 0, ..., +4 in 0.5deg steps)
  const idx = ((h % 17) + 17) % 17;
  const steps = ['n40','n35','n30','n25','n20','n15','n10','n05','0','p05','p10','p15','p20','p25','p30','p35','p40'];
  return `stamp-rot-${steps[idx]}`;
}

/**
 * Normalize an email address: trim, preserve local-part case, lowercase domain only.
 */
function normalizeEmailAddress(raw) {
  if (typeof raw !== 'string') return String(raw);
  const trimmed = raw.trim();
  const atIdx = trimmed.lastIndexOf('@');
  if (atIdx === -1) return trimmed;
  const localPart = trimmed.slice(0, atIdx);
  const domainPart = trimmed.slice(atIdx + 1).toLowerCase();
  return `${localPart}@${domainPart}`;
}

/**
 * Deduplicate addresses. Uses normalizeEmailAddress for case-insensitive domain,
 * preserving original local-part case. Two addresses with same normalized form are duplicates.
 */
function deduplicateAddresses(lines) {
  const counts = new Map();
  const unique = [];
  for (const line of lines) {
    const normalized = normalizeEmailAddress(line);
    const lower = normalized.toLowerCase();
    if (counts.has(lower)) {
      counts.set(lower, counts.get(lower) + 1);
    } else {
      counts.set(lower, 1);
      unique.push(normalized);
    }
  }
  return { unique, counts };
}

// --- Cancel & Session Guards ---
function handleCancel() {
  if (!isVerifying) return;
  if (activeAbortController) {
    activeAbortController.abort();
    activeAbortController = null;
  }
  currentSessionId++;
  isVerifying = false;
  setVerifyingUI(false);
  $progressStrip.textContent = 'Sorting cancelled';
}

function setVerifyingUI(verifying) {
  if (verifying) {
    $verifyBtn.textContent = 'Sorting…';
    $verifyBtn.disabled = true;
    if ($cancelBtn) $cancelBtn.hidden = false;
    if ($cancelBtnCollapsed) $cancelBtnCollapsed.hidden = false;
  } else {
    $verifyBtn.textContent = 'Verify';
    $verifyBtn.disabled = false;
    if ($cancelBtn) $cancelBtn.hidden = true;
    if ($cancelBtnCollapsed) $cancelBtnCollapsed.hidden = true;
  }
}

// --- Client-Side Syntax Check for Fallback Rows ---
function checkClientSyntax(email) {
  if (typeof email !== 'string') return false;
  const trimmed = email.trim();
  if (!trimmed || trimmed.length > 254 || /\s/.test(trimmed)) return false;
  const parts = trimmed.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local || !domain || local.length > 64) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  for (const l of labels) {
    if (!l || l.startsWith('-') || l.endsWith('-')) return false;
  }
  return true;
}

function upsertChunkResults(results, counts) {
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const normalized = normalizeEmailAddress(result.email);
    const lowerEmail = normalized.toLowerCase();
    const count = counts.get(lowerEmail) || result.count || result.occurrences || 1;
    const fullResult = { ...result, email: normalized, count, occurrences: count };

    // Update or insert into allResults
    const existingIdx = allResults.findIndex(r => normalizeEmailAddress(r.email).toLowerCase() === lowerEmail);
    if (existingIdx !== -1) {
      allResults[existingIdx] = fullResult;
    } else {
      allResults.push(fullResult);
    }

    // Update or insert into DOM
    const existingRow = $ledgerBody.querySelector(`tr[data-email="${CSS.escape(normalized)}"]`);
    const newRow = createResultRow(fullResult, 1, count);

    // Stagger animation for initial items using CSS classes (no inline style)
    if (i < ANIMATE_FIRST_N) {
      const stamp = newRow.querySelector('.stamp');
      if (stamp) {
        stamp.classList.add('stamp-animate');
        stamp.classList.add(`stagger-${i}`);
      }
    }

    if (existingRow) {
      existingRow.replaceWith(newRow);
    } else {
      $ledgerBody.appendChild(newRow);
    }
  }

  applyFilter();
}

// --- Verify Flow ---
async function handleVerify(isRetry = false) {
  if (isVerifying) return;

  const lines = getLines();
  if (lines.length === 0) return;
  if (lines.length > MAX_ADDRESSES) return;

  const sessionId = ++currentSessionId;
  isVerifying = true;
  setVerifyingUI(true);

  if (!isRetry) {
    allResults = [];
    lastFailedChunks = [];
    activeFilter = 'all';

    // Collapse intake slip and move keyboard focus to Edit list
    $intakeSlip.classList.add('hidden-slip');
    $intakeCollapsed.classList.add('visible');
    $intakeSummary.textContent = `${lines.length.toLocaleString()} address${lines.length !== 1 ? 'es' : ''} submitted`;
    $editListBtn.focus();

    // Show results area
    $resultsDivider.hidden = false;
    $resultsDivider.classList.add('visible');
    $pigeonholes.classList.add('visible');
    $ledgerWrap.classList.add('visible');
    $progressStrip.hidden = false;
    $progressStrip.classList.add('visible');
    $errorBanner.hidden = true;
    $errorBanner.classList.remove('visible');
    $exportButtons.classList.remove('visible');

    // Reset pigeonhole buttons
    document.querySelectorAll('.pigeonhole').forEach(btn => {
      btn.setAttribute('aria-pressed', btn.dataset.filter === 'all' ? 'true' : 'false');
    });

    // Reset sort
    sortColumn = null;
    sortDirection = 'none';
    document.querySelectorAll('.ledger thead th.sortable').forEach(th => {
      th.setAttribute('aria-sort', 'none');
    });

    // Clear ledger
    $ledgerBody.innerHTML = '';
  } else {
    $errorBanner.hidden = true;
    $errorBanner.classList.remove('visible');
  }

  // Deduplicate
  const { unique, counts } = deduplicateAddresses(lines);
  lastCounts = counts;
  updatePigeonholeCounts(counts);

  // Determine chunks to process
  let chunksToProcess = [];
  if (isRetry && lastFailedChunks.length > 0) {
    chunksToProcess = [...lastFailedChunks];
    lastFailedChunks = [];
  } else {
    for (let i = 0; i < unique.length; i += CHUNK_SIZE) {
      chunksToProcess.push(unique.slice(i, i + CHUNK_SIZE));
    }
  }

  const totalAddresses = lines.length;
  let hasFailure = false;
  let failureReason = '';

  try {
    for (let ci = 0; ci < chunksToProcess.length; ci++) {
      if (sessionId !== currentSessionId) return;

      const chunk = chunksToProcess[ci];
      const processedCount = allResults.reduce((sum, r) => sum + (r.count || 1), 0);
      $progressStrip.textContent = `Sorted ${processedCount.toLocaleString()} of ${totalAddresses.toLocaleString()}`;

      const controller = new AbortController();
      activeAbortController = controller;
      const timeoutId = setTimeout(() => controller.abort(new Error('timeout')), CLIENT_TIMEOUT_MS);

      try {
        const response = await fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ emails: chunk }),
          signal: controller.signal,
        });

        if (sessionId !== currentSessionId) return;

        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          throw new Error(errData.error || `Server error (${response.status})`);
        }

        const data = await response.json();
        if (sessionId !== currentSessionId) return;

        upsertChunkResults(data.results, counts);

      } catch (err) {
        if (sessionId !== currentSessionId) return;

        hasFailure = true;
        failureReason = err.name === 'AbortError' ? 'The request timed out.' : (err.message || 'Network error');
        lastFailedChunks.push(chunk);

        // Render placeholder rows marked as unknown with client-side syntax check
        const failResults = chunk.map(email => ({
          email,
          status: 'unknown',
          reason: 'This batch could not be checked. Try again.',
          checks: {
            syntax: checkClientSyntax(email) ? 'pass' : 'fail',
            mx: 'not_checked',
            recipient: 'not_checked',
          },
        }));

        upsertChunkResults(failResults, counts);
      } finally {
        clearTimeout(timeoutId);
        activeAbortController = null;
      }

      updatePigeonholeCounts(counts);
      const updatedProcessed = allResults.reduce((sum, r) => sum + (r.count || 1), 0);
      $progressStrip.textContent = `Sorted ${updatedProcessed.toLocaleString()} of ${totalAddresses.toLocaleString()}`;
    }
  } finally {
    if (sessionId === currentSessionId) {
      isVerifying = false;
      setVerifyingUI(false);
      updatePigeonholeCounts(counts);

      if (lastFailedChunks.length === chunksToProcess.length && chunksToProcess.length > 0) {
        // Complete failure
        $errorBanner.hidden = false;
        $errorBanner.classList.add('visible');
        $errorMessage.textContent = `The request failed. Nothing was sent to any address. (${failureReason})`;
        $progressStrip.textContent = 'Sorting failed — see error notice above';
      } else if (lastFailedChunks.length > 0) {
        // Partial failure
        $errorBanner.hidden = false;
        $errorBanner.classList.add('visible');
        $errorMessage.textContent = `Some batches could not be checked. Completed results are shown below — use Try again to retry failed addresses. (${failureReason})`;
        $progressStrip.textContent = 'Sorting partially complete — some batches failed';
      } else {
        // Full success
        $errorBanner.hidden = true;
        $errorBanner.classList.remove('visible');
        $progressStrip.textContent = 'Sorting complete';
      }

      if (allResults.length > 0) {
        $exportButtons.classList.add('visible');
      }
    }
  }
}

function handleRetry() {
  handleVerify(lastFailedChunks.length > 0);
}


function createResultRow(result, rowNum, count) {
  const tr = document.createElement('tr');
  tr.dataset.status = result.status;
  tr.dataset.email = result.email;

  // # column
  const tdNum = document.createElement('td');
  tdNum.className = 'col-num';
  tdNum.setAttribute('data-label', '#');
  tdNum.textContent = rowNum;
  tr.appendChild(tdNum);

  // Address column
  const tdAddr = document.createElement('td');
  tdAddr.className = 'col-address';
  tdAddr.setAttribute('data-label', 'Address');
  const addrSpan = document.createElement('span');
  addrSpan.textContent = result.email;
  tdAddr.appendChild(addrSpan);

  if (count > 1) {
    const badge = document.createElement('span');
    badge.className = 'duplicate-badge';
    badge.textContent = `× ${count}`;
    badge.setAttribute('title', `${count} occurrences submitted`);
    tdAddr.appendChild(badge);
  }
  tr.appendChild(tdAddr);

  // Status column (stamp)
  const tdStatus = document.createElement('td');
  tdStatus.className = 'col-status';
  tdStatus.setAttribute('data-label', 'Status');
  tdStatus.appendChild(createStamp(result.status, result.email));
  tr.appendChild(tdStatus);

  // Reason column
  const tdReason = document.createElement('td');
  tdReason.className = 'col-reason';
  tdReason.setAttribute('data-label', 'Reason');
  tdReason.textContent = result.reason;
  tr.appendChild(tdReason);

  // Postmarks column
  const tdPostmarks = document.createElement('td');
  tdPostmarks.className = 'col-postmarks';
  tdPostmarks.setAttribute('data-label', 'Postmarks');
  tdPostmarks.appendChild(createPostmarks(result.checks));
  tr.appendChild(tdPostmarks);

  return tr;
}

function createStamp(status, email) {
  const info = STATUS_LABELS[status] || STATUS_LABELS.unknown;
  const rotClass = stampRotationClass(email);

  const stamp = document.createElement('div');
  stamp.className = `stamp ${info.cssClass} ${rotClass}`;

  const primary = document.createElement('span');
  primary.className = 'stamp-primary';
  primary.textContent = info.primary;
  stamp.appendChild(primary);

  const secondary = document.createElement('span');
  secondary.className = 'stamp-secondary';
  secondary.textContent = info.secondary;
  stamp.appendChild(secondary);

  const glyph = document.createElement('span');
  glyph.className = 'stamp-glyph';
  glyph.textContent = info.glyph;
  stamp.appendChild(glyph);

  return stamp;
}

function createPostmarks(checks) {
  const container = document.createElement('div');
  container.className = 'postmarks';

  for (const [checkName, value] of Object.entries(checks)) {
    const abbr = POSTMARK_ABBR[checkName] || checkName.toUpperCase();
    const displayMap = POSTMARK_DISPLAY[checkName] || {};
    const displayLabel = displayMap[value] || value.toUpperCase().replace(/_/g, ' ');

    const mark = document.createElement('div');
    mark.className = `postmark postmark-${value}`;
    mark.setAttribute('title', `${checkName.charAt(0).toUpperCase() + checkName.slice(1)} check: ${displayLabel.toLowerCase()}`);

    const abbrSpan = document.createElement('span');
    abbrSpan.className = 'postmark-abbr';
    abbrSpan.textContent = abbr;
    mark.appendChild(abbrSpan);

    const stateSpan = document.createElement('span');
    stateSpan.className = 'postmark-state';
    stateSpan.textContent = displayLabel;
    mark.appendChild(stateSpan);

    const srSpan = document.createElement('span');
    srSpan.className = 'sr-only';
    srSpan.textContent = `${checkName.charAt(0).toUpperCase() + checkName.slice(1)} check: ${displayLabel.toLowerCase()}`;
    mark.appendChild(srSpan);

    container.appendChild(mark);
  }

  return container;
}

// --- Pigeonhole Counts ---
function updatePigeonholeCounts(counts) {
  const totals = { all: 0, likely_deliverable: 0, likely_bounce: 0, unknown: 0 };

  for (const result of allResults) {
    const c = result.count || result.occurrences || 1;
    totals[result.status] = (totals[result.status] || 0) + c;
    totals.all += c;
  }

  document.getElementById('count-all').textContent = totals.all.toLocaleString();
  document.getElementById('count-likely_deliverable').textContent = totals.likely_deliverable.toLocaleString();
  document.getElementById('count-likely_bounce').textContent = totals.likely_bounce.toLocaleString();
  document.getElementById('count-unknown').textContent = totals.unknown.toLocaleString();
}

// --- Pigeonhole Filters ---
function setActiveFilter(filter) {
  activeFilter = filter;

  document.querySelectorAll('.pigeonhole').forEach(btn => {
    btn.setAttribute('aria-pressed', btn.dataset.filter === filter ? 'true' : 'false');
  });

  applyFilter();
}

function applyFilter() {
  const rows = $ledgerBody.querySelectorAll('tr:not(.ledger-empty-row)');
  let visibleCount = 0;

  rows.forEach(row => {
    if (activeFilter === 'all' || row.dataset.status === activeFilter) {
      row.classList.remove('row-hidden');
      visibleCount++;
    } else {
      row.classList.add('row-hidden');
    }
  });

  const existing = $ledgerBody.querySelector('.ledger-empty-row');
  if (existing) existing.remove();

  if (visibleCount === 0 && allResults.length > 0) {
    const emptyRow = document.createElement('tr');
    emptyRow.className = 'ledger-empty-row';
    const td = document.createElement('td');
    td.setAttribute('colspan', '5');
    td.textContent = 'No letters in this slot.';
    emptyRow.appendChild(td);
    $ledgerBody.appendChild(emptyRow);
  }

  let num = 0;
  rows.forEach(row => {
    if (!row.classList.contains('row-hidden')) {
      num++;
      const numCell = row.querySelector('.col-num');
      if (numCell) numCell.textContent = num;
    }
  });
}

// --- Sorting ---
function handleSort(th) {
  const col = th.dataset.sort;

  if (sortColumn === col) {
    sortDirection = sortDirection === 'ascending' ? 'descending' : 'ascending';
  } else {
    sortColumn = col;
    sortDirection = 'ascending';
  }

  document.querySelectorAll('.ledger thead th.sortable').forEach(header => {
    header.setAttribute('aria-sort', header.dataset.sort === col ? sortDirection : 'none');
  });

  const rows = Array.from($ledgerBody.querySelectorAll('tr:not(.ledger-empty-row)'));
  rows.sort((a, b) => {
    let aVal, bVal;
    if (col === 'address') {
      aVal = (a.dataset.email || '').toLowerCase();
      bVal = (b.dataset.email || '').toLowerCase();
    } else if (col === 'status') {
      aVal = a.dataset.status || '';
      bVal = b.dataset.status || '';
    }

    if (aVal < bVal) return sortDirection === 'ascending' ? -1 : 1;
    if (aVal > bVal) return sortDirection === 'ascending' ? 1 : -1;
    return 0;
  });

  rows.forEach(row => $ledgerBody.appendChild(row));
  applyFilter();
}

// --- Clear ---
function handleClear() {
  if (isVerifying) {
    handleCancel();
  }

  $textarea.value = '';
  allResults = [];
  lastFailedChunks = [];
  activeFilter = 'all';
  sortColumn = null;
  sortDirection = 'none';

  updateCounter();

  $intakeSlip.classList.remove('hidden-slip');
  $intakeCollapsed.classList.remove('visible');
  $pigeonholes.classList.remove('visible');
  $progressStrip.hidden = true;
  $progressStrip.classList.remove('visible');
  $errorBanner.hidden = true;
  $errorBanner.classList.remove('visible');
  $exportButtons.classList.remove('visible');
  $ledgerWrap.classList.remove('visible');
  $resultsDivider.hidden = true;
  $resultsDivider.classList.remove('visible');
  $ledgerBody.innerHTML = '';

  document.querySelectorAll('.pigeonhole').forEach(btn => {
    btn.setAttribute('aria-pressed', btn.dataset.filter === 'all' ? 'true' : 'false');
  });

  document.querySelectorAll('.ledger thead th.sortable').forEach(th => {
    th.setAttribute('aria-sort', 'none');
  });

  $textarea.focus();
}

// --- Load Sample ---
function handleLoadSample() {
  $textarea.value = SAMPLE_ADDRESSES.join('\n');
  updateCounter();
  $textarea.focus();
}

// --- Edit List ---
function handleEditList() {
  if (isVerifying) {
    handleCancel();
  }

  $intakeSlip.classList.remove('hidden-slip');
  $intakeCollapsed.classList.remove('visible');
  $textarea.focus();
}

// --- Export CSV (with OWASP CSV formula injection sanitization) ---
function handleExportCSV() {
  if (allResults.length === 0) return;

  const header = 'email,status,reason,syntax,mx,recipient,occurrences';
  const rows = allResults.map(r => {
    return [
      csvSanitize(r.email),
      csvSanitize(r.status),
      csvSanitize(r.reason),
      csvSanitize(r.checks?.syntax || 'not_checked'),
      csvSanitize(r.checks?.mx || 'not_checked'),
      csvSanitize(r.checks?.recipient || 'not_checked'),
      csvSanitize(r.count || r.occurrences || 1),
    ].join(',');
  });

  const csv = [header, ...rows].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'mailcheck-results.csv';
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Sanitize cell values against OWASP CSV formula injection.
 * If value starts with =, +, -, @, tab, or carriage return, prefix with single quote.
 */
function csvSanitize(val) {
  let str = String(val ?? '');
  if (/^\s*[=+\-@\t\r]/.test(str)) {
    str = "'" + str;
  }
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// --- Copy Results ---
async function handleCopyResults() {
  if (allResults.length === 0) return;

  const text = allResults.map(r => {
    const occ = r.count || r.occurrences || 1;
    const occurrences = occ > 1 ? ` (×${occ})` : '';
    return `${r.email}${occurrences}\t${r.status}\t${r.reason}`;
  }).join('\n');

  try {
    await navigator.clipboard.writeText(text);
    const originalText = $copyBtn.textContent;
    $copyBtn.textContent = 'Copied!';
    setTimeout(() => { $copyBtn.textContent = originalText; }, 2000);
  } catch {
    // Fallback using textarea + execCommand
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.className = 'sr-only';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    document.body.removeChild(ta);

    if (ok) {
      const originalText = $copyBtn.textContent;
      $copyBtn.textContent = 'Copied!';
      setTimeout(() => { $copyBtn.textContent = originalText; }, 2000);
    } else {
      $copyBtn.textContent = 'Copy failed — use CSV export';
      setTimeout(() => { $copyBtn.textContent = 'Copy results'; }, 2500);
    }
  }
}

// --- Plain View Toggle ---
function handlePlainViewToggle() {
  const isActive = $plainViewBtn.getAttribute('aria-pressed') === 'true';
  const newState = !isActive;

  $plainViewBtn.setAttribute('aria-pressed', String(newState));

  if (newState) {
    document.body.setAttribute('data-texture', 'off');
  } else {
    document.body.removeAttribute('data-texture');
  }
}

// --- Run ---
init();
