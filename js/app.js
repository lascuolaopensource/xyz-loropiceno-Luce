/* app.js — poster editor main */

/* ── localStorage helpers (safe in private mode / quota errors) ── */
function _lsGet(key) {
  try { return localStorage.getItem(key); }
  catch (e) { console.warn('[localStorage] get failed:', e); return null; }
}
function _lsSet(key, value) {
  try { localStorage.setItem(key, value); }
  catch (e) { console.warn('[localStorage] set failed:', e); }
}
function _lsRemove(key) {
  try { localStorage.removeItem(key); }
  catch (e) { console.warn('[localStorage] remove failed:', e); }
}

/* ── State ─────────────────────────────────────────────── */
const state = {
  sizeId:  'a4',
  wMM:     210,
  hMM:     297,
  canvasW: 2480,
  canvasH: 3508,
  margins: { top: 240, right: 200, bottom: 240, left: 200 },

  bgColor:       CONFIG.background.defaultColor,
  bgGradient:    null,
  userBgDataURL: null,

  // Text content — 4 fields
  content: { data: '', luogo: '', titolo: '', testo: '' },

  // Data+Luogo placement (top row)
  dataLuogoPlacement: 'top-left',   // 'top-left' | 'top-center' | 'top-right'
  dataLuogoSwap:      false,        // swap data↔luogo order
  dataLuogoFlex:      false,        // separate corners (left↔right)

  // Titolo options
  titoloPos:  'mid',               // 'mid' | 'under-data'
  testoFlex:  false,               // extra flexible gap below titolo
  titoloLH:   'normal',            // 'normal' | 'modified'
  fontWeight: 'regular',           // 'regular' | 'black'

  // Text colors — 3 independent pickers
  textColors: { title: CONFIG.text.defaultColor, date: CONFIG.text.defaultColor, testo: CONFIG.text.defaultColor },

  // Text sizes
  sizeRatio: {
    titolo:    CONFIG.typography.titoloSizeRatio,
    testo:     CONFIG.typography.testoSizeRatio,
    dataLuogo: CONFIG.typography.dataLuogoSizeRatio,
  },

  // ── Objects ──
  letterOverlays:    [],
  selectedOverlayId: null,
  imageOverlays:     [],
  selectedImageId:   null,
  imageFilters:      {},

  logos:           [],
  selectedLogoId:  null,
  logosSizeLinked: false,        // when true, resizing one logo resizes them all
  patternBg:      null,
  qrParams:       { enabled: false, url: '', sizeRatio: 0.1, vAlign: 'bottom', hAlign: 'center', gapRatio: 0.02, qrColor: '#000000' },

  customTexts:      [],
  shapes:           [],
  selectedShapeId:  null,
};

/* ── Canvas + zoom ─────────────────────────────────────── */
const canvas     = document.getElementById('canvas');
const artboard   = document.getElementById('artboard');
const canvasArea = document.getElementById('canvas-area');

let zoomFactor = 1;
let panX = 0, panY = 0;

function applyTransform() {
  const offsetX = -canvas.width  * zoomFactor / 2 + panX;
  const offsetY = -canvas.height * zoomFactor / 2 + panY;
  artboard.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${zoomFactor})`;
  document.getElementById('zoom-label').textContent = Math.round(zoomFactor * 100) + '%';
}

function fitToScreen() {
  const aW = canvasArea.clientWidth  - 40;
  const aH = canvasArea.clientHeight - 40;
  zoomFactor = Math.min(aW / canvas.width, aH / canvas.height, 1);
  panX = 0; panY = 0;
  applyTransform();
}

function setZoom(z) {
  zoomFactor = Math.max(0.05, Math.min(3, Math.round(z * 100) / 100));
  applyTransform();
}

/* ── Draw ──────────────────────────────────────────────── */
let _drawRaf   = null;
let _drawImg   = null;
let _smoothRaf = null;

/* Selection outline (DOM overlay over the canvas — kept out of the SVG so
   it never leaks into PNG/PDF exports and so it can follow the cursor without
   waiting for an SVG rebuild). */
function updateOverlayOutline() {
  const el = document.getElementById('overlay-outline');
  if (!el) return;
  const id = state.selectedOverlayId;
  if (id == null) { el.classList.remove('visible'); return; }
  const ov = state.letterOverlays.find(o => o.id === id);
  if (!ov || ov.visible === false) { el.classList.remove('visible'); return; }
  const sz = ov.fontSize || Math.round((ov.sizeRatio || 0.4) * state.canvasW);
  const pad = Math.round(sz * 0.15) + 4;
  const rsz = sz + pad * 2;
  el.style.left   = (ov.x - rsz / 2) + 'px';
  el.style.top    = (ov.y - rsz / 2) + 'px';
  el.style.width  = rsz + 'px';
  el.style.height = rsz + 'px';
  el.classList.add('visible');
}

// rAF-throttled draw — single-frame coalescing for rapid state changes.
// The selection outline is updated synchronously here so it tracks the
// cursor instantly during drag (even before the SVG re-render lands).
function draw() {
  updateOverlayOutline();
  if (_drawRaf) cancelAnimationFrame(_drawRaf);
  _drawRaf = requestAnimationFrame(() => { _drawRaf = null; _draw(); });
}

// Frame-throttled draw for sliders — uses same coalescing path
function drawSmooth() { draw(); }

function _draw() {
  // Cancel any pending SVG→Image that hasn't resolved yet
  if (_drawImg) { _drawImg.onload = null; _drawImg = null; }
  const svg = buildSVG(state);
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  const img = new Image();
  _drawImg = img;
  img.onload = () => {
    if (img !== _drawImg) return; // newer draw superseded this one
    _drawImg = null;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  };
  img.onerror = () => { _drawImg = null; };
  img.src = url;
}

/* ── Undo / Redo ────────────────────────────────────────── */
const _history   = [];
const _redoStack = [];
let   _isUndoing = false;
const MAX_HISTORY = 50;

function _cloneState() {
  return {
    sizeId:  state.sizeId,
    wMM:     state.wMM,
    hMM:     state.hMM,
    canvasW: state.canvasW,
    canvasH: state.canvasH,
    margins:             { ...state.margins },
    bgColor:             state.bgColor,
    bgGradient:          state.bgGradient ? { ...state.bgGradient } : null,
    userBgDataURL:       state.userBgDataURL,
    content:             { ...state.content },
    dataLuogoPlacement:  state.dataLuogoPlacement,
    dataLuogoSwap:       state.dataLuogoSwap,
    dataLuogoFlex:       state.dataLuogoFlex,
    titoloPos:           state.titoloPos,
    testoFlex:           state.testoFlex,
    titoloLH:            state.titoloLH,
    fontWeight:          state.fontWeight,
    textColors:          { ...(state.textColors || {}) },
    sizeRatio:           { ...state.sizeRatio },
    letterOverlays:      state.letterOverlays.map(o => ({ ...o })),
    selectedOverlayId:   state.selectedOverlayId,
    imageOverlays:       state.imageOverlays.map(o => ({ ...o })),
    selectedImageId:     state.selectedImageId,
    imageFilters:        { ...(state.imageFilters || {}) },
    logos:               (state.logos || []).map(l => ({ ...l })),
    selectedLogoId:      state.selectedLogoId,
    logosSizeLinked:     !!state.logosSizeLinked,
    patternBg:           state.patternBg ? { ...state.patternBg } : null,
    customTexts:         (state.customTexts || []).map(t => ({ ...t })),
    shapes:              (state.shapes || []).map(s => ({ ...s, gradient: s.gradient ? { ...s.gradient } : null })),
    selectedShapeId:     state.selectedShapeId,
  };
}

function pushHistory() {
  if (_isUndoing) return;
  if (_history.length >= MAX_HISTORY) _history.shift();
  _history.push(_cloneState());
  _redoStack.length = 0;   // new action invalidates redo
}

function undo() {
  if (!_history.length) return;
  _isUndoing = true;
  _redoStack.push(_cloneState());
  const snap = _history.pop();
  _applySnapshot(snap);
  _isUndoing = false;
}

function redo() {
  if (!_redoStack.length) return;
  _isUndoing = true;
  _history.push(_cloneState());
  const snap = _redoStack.pop();
  _applySnapshot(snap);
  _isUndoing = false;
}

function _applySnapshot(snap) {
  Object.assign(state, snap);
  state.margins   = { ...snap.margins };
  state.content   = { ...snap.content };
  state.sizeRatio = { ...snap.sizeRatio };
  state.textColors = { ...(snap.textColors || {}) };
  state.letterOverlays = (snap.letterOverlays || []).map(o => ({ ...o }));
  state.imageOverlays  = (snap.imageOverlays  || []).map(o => ({ ...o }));
  state.customTexts    = (snap.customTexts || []).map(t => ({ ...t }));
  state.shapes         = (snap.shapes || []).map(s => ({ ...s, gradient: s.gradient ? { ...s.gradient } : null }));
  state.selectedShapeId = snap.selectedShapeId;
  state.imageFilters    = { ...(snap.imageFilters || {}) };
  state.logos           = (snap.logos || []).map(l => ({ ...l }));
  state.selectedLogoId  = snap.selectedLogoId;
  state.logosSizeLinked = !!snap.logosSizeLinked;
  state.patternBg       = snap.patternBg ? { ...snap.patternBg } : null;

  canvas.width  = state.canvasW;
  canvas.height = state.canvasH;
  artboard.style.width  = state.canvasW + 'px';
  artboard.style.height = state.canvasH + 'px';

  updateSizeLabel();
  updateSizeButtons();
  rebuildDynamic();
  fitToScreen();
  buildGradientPanel();
  buildBgSolidPicker();
  buildTextSection();
}

/* ── Page size ─────────────────────────────────────────── */
function MM_TO_PX(mm) { return Math.round(mm * CONFIG.MM_TO_PX); }

function setPageSize(sizeId, customW, customH) {
  const preset = CONFIG.pagePresets[sizeId];
  if (preset) {
    state.sizeId  = sizeId;
    state.wMM     = preset.wMM;
    state.hMM     = preset.hMM;
    state.canvasW = preset.width;
    state.canvasH = preset.height;
    state.margins = { ...preset.margins };
  } else {
    state.sizeId  = 'custom';
    state.wMM     = customW;
    state.hMM     = customH;
    state.canvasW = MM_TO_PX(customW);
    state.canvasH = MM_TO_PX(customH);
    const m = Math.round(Math.min(state.canvasW, state.canvasH) * 0.08);
    state.margins = { top: m, right: m, bottom: m, left: m };
  }
  canvas.width  = state.canvasW;
  canvas.height = state.canvasH;
  artboard.style.width  = state.canvasW + 'px';
  artboard.style.height = state.canvasH + 'px';
  updateSizeLabel();
  updateSizeButtons();
  fitToScreen();
  draw();
}

function updateSizeLabel() {
  const preset = CONFIG.pagePresets[state.sizeId];
  document.getElementById('poster-size-label').textContent =
    (preset && preset.displayLabel) ? preset.displayLabel : `${state.wMM} × ${state.hMM} mm`;
}

function updateSizeButtons() {
  document.querySelectorAll('.size-switch-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.id === state.sizeId);
  });
}

/* ── Swatches ──────────────────────────────────────────── */
function buildSwatchesInto(root, initial, onChange) {
  root.innerHTML = '';
  const norm = (initial || '').toLowerCase();
  CONFIG.palette.forEach(c => {
    const chip = document.createElement('div');
    chip.className = 'swatch-chip';
    if (c.hex.toLowerCase() === norm) chip.classList.add('selected');

    const box = document.createElement('span');
    box.className = 'swatch-box';
    box.style.backgroundColor = c.hex;

    const lbl = document.createElement('span');
    lbl.className = 'swatch-name';
    lbl.textContent = c.name;

    chip.append(box, lbl);
    chip.addEventListener('click', () => {
      root.querySelectorAll('.swatch-chip').forEach(el => el.classList.remove('selected'));
      chip.classList.add('selected');
      onChange(c.hex);
    });
    root.appendChild(chip);
  });
}

/* ── Background Solid Color Picker ─────────────────── */
function buildBgSolidPicker() {
  const root = document.getElementById('bg-solid-picker');
  if (!root) return;
  root.innerHTML = '';

  const cur = state.bgColor || CONFIG.background.defaultColor;
  const isGradient = !!state.bgGradient;

  // ── Main color button ──
  const btn = document.createElement('button');
  btn.style.cssText = `width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;background:${isGradient ? 'var(--bg-section)' : cur};cursor:pointer;display:flex;align-items:center;gap:10px;transition:border-color var(--transition)`;
  if (!isGradient) {
    btn.style.color = '#fff';
    btn.style.textShadow = '0 1px 3px rgba(0,0,0,0.5)';
  }
  btn.innerHTML =
    `<span style="flex:1;text-align:left;font-size:13px;font-weight:500">${isGradient ? 'Solido (gradiente attivo)' : cur}</span>` +
    `<span style="font-size:16px;opacity:0.7">▾</span>`;
  root.appendChild(btn);

  // ── Dropdown palette ──
  const panel = document.createElement('div');
  panel.className = 'gradient-panel';
  panel.style.cssText = 'display:none;margin-top:6px;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg-section);overflow:hidden';
  root.appendChild(panel);

  const grid = document.createElement('div');
  grid.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px';
  CONFIG.palette.forEach(c => {
    const chip = document.createElement('button');
    const active = c.hex.toLowerCase() === cur.toLowerCase() && !isGradient;
    chip.style.cssText = `width:28px;height:28px;border-radius:var(--radius-sm);border:2px solid ${active ? 'var(--text)' : 'transparent'};background:${c.hex};cursor:pointer;transition:transform 0.12s ease;box-shadow:0 1px 2px rgba(0,0,0,0.1);transform:scale(${active ? '1.15' : '1'})`;
    chip.title = c.name;
    chip.addEventListener('click', () => {
      pushHistory();
      state.bgColor    = c.hex;
      state.bgGradient = null;
      buildBgSolidPicker();
      buildGradientPanel();
      draw();
      togglePanel(false);
    });
    grid.appendChild(chip);
  });
  panel.appendChild(grid);

  function togglePanel(force) {
    const open = force !== undefined ? force : panel.style.display === 'none';
    panel.style.display = open ? 'block' : 'none';
    btn.querySelector('span:last-child').textContent = open ? '▴' : '▾';
  }

  btn.addEventListener('click', () => togglePanel());

  // Close on outside click
  const docHandler = e => { if (!root.contains(e.target)) togglePanel(false); };
  document.removeEventListener('click', root._gradDocHandler2);
  root._gradDocHandler2 = docHandler;
  setTimeout(() => document.addEventListener('click', docHandler), 0);
}

/* ── Reusable Solid Color Button+Dropdown ──────────── */
function buildColorButton(host, opts) {
  const cur = opts.currentHex || CONFIG.text.defaultColor;

  const row = document.createElement('div');
  row.style.cssText = 'margin-bottom:8px';

  // Label
  const lbl = document.createElement('div');
  lbl.className = 'field-label';
  lbl.style.cssText = 'font-size:11px;color:var(--text-muted);margin-bottom:3px';
  lbl.textContent = opts.label;
  row.appendChild(lbl);

  // Button
  const btn = document.createElement('button');
  btn.style.cssText = `width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:${cur};cursor:pointer;display:flex;align-items:center;gap:8px;transition:border-color var(--transition)`;
  btn.style.color = '#fff';
  btn.style.textShadow = '0 1px 3px rgba(0,0,0,0.5)';
  btn.innerHTML =
    `<span style="flex:1;text-align:left;font-size:12px;font-weight:500">${cur}</span>` +
    `<span style="font-size:14px;opacity:0.7">▾</span>`;
  row.appendChild(btn);

  // Dropdown panel
  const panel = document.createElement('div');
  panel.style.cssText = 'display:none;margin-top:4px;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg-section);overflow:hidden';
  const grid = document.createElement('div');
  grid.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px';
  CONFIG.palette.forEach(c => {
    const chip = document.createElement('button');
    const active = c.hex.toLowerCase() === cur.toLowerCase();
    chip.style.cssText = `width:28px;height:28px;border-radius:var(--radius-sm);border:2px solid ${active ? 'var(--text)' : 'transparent'};background:${c.hex};cursor:pointer;transition:transform 0.12s ease;box-shadow:0 1px 2px rgba(0,0,0,0.1);transform:scale(${active ? '1.15' : '1'})`;
    chip.title = c.name;
    chip.addEventListener('click', () => {
      opts.onChange(c.hex);
      // Update button visual
      btn.style.background = c.hex;
      btn.querySelector('span:first-child').textContent = c.hex;
      // Update active chip highlight
      grid.querySelectorAll('button').forEach(ch => {
        const isActive = ch.style.background.replace(/\s/g,'') === c.hex.replace(/\s/g,'');
        ch.style.borderColor = isActive ? 'var(--text)' : 'transparent';
        ch.style.transform = isActive ? 'scale(1.15)' : 'scale(1)';
      });
      panel.style.display = 'none';
      btn.querySelector('span:last-child').textContent = '▾';
    });
    grid.appendChild(chip);
  });
  panel.appendChild(grid);
  row.appendChild(panel);

  btn.addEventListener('click', () => {
    const open = panel.style.display === 'none';
    panel.style.display = open ? 'block' : 'none';
    btn.querySelector('span:last-child').textContent = open ? '▴' : '▾';
  });

  // Close on outside click
  const docHandler = e => {
    if (!row.contains(e.target)) {
      panel.style.display = 'none';
      btn.querySelector('span:last-child').textContent = '▾';
    }
  };
  document.removeEventListener('click', row._cbHandler);
  row._cbHandler = docHandler;
  setTimeout(() => document.addEventListener('click', docHandler), 0);

  host.appendChild(row);
}

/* ── Gradient Panel ────────────────────────────────── */
function buildGradientPanel() {
  const host = document.getElementById('gradient-panel-container');
  if (!host) return;
  host.innerHTML = '';

  const g = state.bgGradient || {};
  const hasGradient = !!state.bgGradient;
  const gFrom   = g.from || state.bgColor || CONFIG.background.defaultColor;
  const gTo     = g.to   || CONFIG.palette[6].hex;
  const gAngle   = g.angle ?? 90;
  const gBalance = g.balance ?? 50;

  // ── Live update helper ──
  function commitGrad(opts = {}) {
    if (!state.bgGradient) return;
    pushHistory();
    state.bgGradient.from    = opts.from    !== undefined ? opts.from    : state.bgGradient.from;
    state.bgGradient.to      = opts.to      !== undefined ? opts.to      : state.bgGradient.to;
    state.bgGradient.angle   = opts.angle   !== undefined ? opts.angle   : state.bgGradient.angle;
    state.bgGradient.balance = opts.balance !== undefined ? opts.balance : state.bgGradient.balance;
    draw();
  }

  function clearGradient() {
    pushHistory();
    state.bgGradient = null;
    buildGradientPanel();
    draw();
  }

  // ── Gradient preview bar ──
  const preview = document.createElement('div');
  preview.style.cssText = `height:32px;border-radius:6px;border:1px solid var(--border);background:linear-gradient(90deg,${gFrom},${gTo});margin-bottom:10px;position:relative`;
  if (!hasGradient) {
    preview.style.cssText += ';opacity:0.3';
    preview.title = 'Nessun gradiente attivo';
  }
  host.appendChild(preview);

  // ── Color 1 chips ──
  const c1Lbl = document.createElement('div');
  c1Lbl.className = 'field-label';
  c1Lbl.textContent = 'Colore 1';
  host.appendChild(c1Lbl);
  const c1Grid = document.createElement('div');
  c1Grid.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px';
  CONFIG.palette.forEach(c => {
    const chip = document.createElement('button');
    const sel1 = c.hex.toLowerCase() === gFrom.toLowerCase();
    chip.style.cssText = `width:24px;height:24px;border-radius:var(--radius-sm);border:2px solid ${sel1 ? 'var(--text)' : 'transparent'};background:${c.hex};cursor:pointer;transition:transform 0.12s ease,border-color 0.12s ease,box-shadow 0.12s ease;box-shadow:0 1px 2px rgba(0,0,0,0.1);transform:scale(${sel1 ? '1.15' : '1'})`;
    chip.title = c.name;
    chip.dataset.hex = c.hex;
    chip.dataset.slot = '1';
    chip.addEventListener('click', () => {
      g.from = c.hex;
      c1Grid.querySelectorAll('button').forEach(b => {
        b.style.borderColor = 'transparent';
        b.style.transform = 'scale(1)';
      });
      chip.style.borderColor = 'var(--text)';
      chip.style.transform = 'scale(1.15)';
      preview.style.background = `linear-gradient(90deg,${g.from},${g.to})`;
      if (hasGradient) commitGrad();
    });
    c1Grid.appendChild(chip);
  });
  host.appendChild(c1Grid);

  // ── Color 2 chips ──
  const c2Lbl = document.createElement('div');
  c2Lbl.className = 'field-label';
  c2Lbl.textContent = 'Colore 2';
  host.appendChild(c2Lbl);
  const c2Grid = document.createElement('div');
  c2Grid.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px';
  CONFIG.palette.forEach(c => {
    const chip = document.createElement('button');
    const sel2 = c.hex.toLowerCase() === gTo.toLowerCase();
    chip.style.cssText = `width:24px;height:24px;border-radius:var(--radius-sm);border:2px solid ${sel2 ? 'var(--text)' : 'transparent'};background:${c.hex};cursor:pointer;transition:transform 0.12s ease,border-color 0.12s ease,box-shadow 0.12s ease;box-shadow:0 1px 2px rgba(0,0,0,0.1);transform:scale(${sel2 ? '1.15' : '1'})`;
    chip.title = c.name;
    chip.dataset.hex = c.hex;
    chip.dataset.slot = '2';
    chip.addEventListener('click', () => {
      g.to = c.hex;
      c2Grid.querySelectorAll('button').forEach(b => {
        b.style.borderColor = 'transparent';
        b.style.transform = 'scale(1)';
      });
      chip.style.borderColor = 'var(--text)';
      chip.style.transform = 'scale(1.15)';
      preview.style.background = `linear-gradient(90deg,${g.from},${g.to})`;
      if (!hasGradient) {
        pushHistory();
        state.bgGradient = { from: g.from, to: g.to, angle: gAngle, balance: gBalance };
        buildBgSolidPicker();
        buildGradientPanel();
        draw();
      } else {
        commitGrad();
      }
    });
    c2Grid.appendChild(chip);
  });
  host.appendChild(c2Grid);

  // ── Direction toggle ──
  const dirRow = document.createElement('div');
  dirRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin:10px 0';
  const dirLbl = document.createElement('span');
  dirLbl.className = 'field-label'; dirLbl.textContent = 'Direzione'; dirLbl.style.margin = '0;min-width:60px';
  const dirBtns = document.createElement('div');
  dirBtns.style.cssText = 'display:flex;gap:2px;flex:1';
  [
    { label: '↕ Vert.',  value: 0  },
    { label: '↔ Orizz.', value: 90 },
  ].forEach(d => {
    const active = gAngle === d.value;
    const db = document.createElement('button');
    db.style.cssText = `flex:1;padding:5px 8px;font-size:11px;border:1px solid ${active ? 'var(--text)' : 'var(--border)'};border-radius:var(--radius-sm);background:${active ? 'var(--bg-section-hov)' : 'transparent'};cursor:pointer;color:var(--text);transition:border-color var(--transition)`;
    db.textContent = d.label;
    db.addEventListener('click', () => {
      if (hasGradient) {
        commitGrad({ angle: d.value });
        buildGradientPanel();
      }
    });
    dirBtns.appendChild(db);
  });
  dirRow.append(dirLbl, dirBtns);
  host.appendChild(dirRow);

  // ── Balance slider (smooth, live preview) ──
  const balRow = document.createElement('div');
  balRow.style.cssText = 'margin:10px 0';
  const balLbl = document.createElement('div');
  balLbl.className = 'field-label'; balLbl.textContent = 'Bilanciamento';
  const balSlider = document.createElement('input');
  balSlider.type = 'range'; balSlider.className = 'field-range';
  balSlider.min = '0'; balSlider.max = '100'; balSlider.step = '1';
  balSlider.value = String(gBalance);
  balSlider.style.width = '100%';
  const balVal = document.createElement('span');
  balVal.style.cssText = 'font-size:10px;color:var(--text-muted);float:right';
  balVal.textContent = gBalance + '%';
  let _balFirst = false;
  balSlider.addEventListener('mousedown', () => { _balFirst = true; });
  balSlider.addEventListener('input', () => {
    balVal.textContent = balSlider.value + '%';
    if (hasGradient) {
      if (_balFirst) { pushHistory(); _balFirst = false; }
      state.bgGradient.balance = Number(balSlider.value);
      drawSmooth();
    }
  });
  balSlider.addEventListener('change', () => {
    if (hasGradient) {
      state.bgGradient.balance = Number(balSlider.value);
      draw();
    }
  });
  balRow.append(balLbl, balSlider, balVal);
  host.appendChild(balRow);

  // ── Remove gradient button ──
  if (hasGradient) {
    const clearBtn = document.createElement('button');
    clearBtn.textContent = '✕ Rimuovi gradiente';
    clearBtn.style.cssText = 'margin-top:8px;width:100%;padding:6px;background:transparent;border:1px solid var(--danger);color:var(--danger);border-radius:4px;cursor:pointer;font-size:12px';
    clearBtn.addEventListener('click', clearGradient);
    host.appendChild(clearBtn);
  }
}

/* ── Layout e Testi — consolidated builder ───────────── */
function buildTextSection() {
  const host = document.getElementById('text-section-content');
  if (!host) return;
  host.innerHTML = '';

  // Helper: control group card with optional label
  const cg = (label) => {
    const d = document.createElement('div');
    d.className = 'ctrl-group';
    if (label) {
      const l = document.createElement('div');
      l.className = 'ctrl-group-label';
      l.textContent = label;
      d.appendChild(l);
    }
    return d;
  };
  // Helper: button option group
  const btnGroup = (parent, options, current, onChange) => {
    const row = document.createElement('div');
    row.className = 'ctrl-btn-group';
    options.forEach(opt => {
      const btn = document.createElement('button');
      btn.className = 'ctrl-btn';
      if (current === opt.id) btn.classList.add('active');
      btn.textContent = opt.label;
      btn.addEventListener('click', () => {
        pushHistory();
        onChange(opt.id);
        buildTextSection();
        draw();
      });
      row.appendChild(btn);
    });
    parent.appendChild(row);
  };
  // Helper: toggle switch row
  const toggleRow = (parent, label, checked, onChange) => {
    const row = document.createElement('div');
    row.className = 'ctrl-toggle-row';
    const lbl = document.createElement('label');
    lbl.className = 'toggle';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = checked;
    chk.addEventListener('change', () => {
      pushHistory();
      onChange(chk.checked);
      draw();
    });
    const trk = document.createElement('span');
    trk.className = 'toggle-track';
    const txt = document.createElement('span');
    txt.className = 'ctrl-toggle-label';
    txt.textContent = label;
    lbl.append(chk, trk, txt);
    row.appendChild(lbl);
    parent.appendChild(row);
  };

  // ── 1. CONTENUTI ──
  const g1 = cg('Contenuti');
  [
    { key: 'data',  placeholder: 'Data',  rows: 1 },
    { key: 'luogo', placeholder: 'Luogo', rows: 1 },
    { key: 'titolo', placeholder: 'Titolo', rows: 2 },
    { key: 'testo',  placeholder: 'Testo',  rows: 2 },
  ].forEach(f => {
    const ta = document.createElement('textarea');
    ta.className = 'poster-textarea';
    ta.rows = f.rows;
    ta.value = state.content[f.key] || '';
    ta.placeholder = f.placeholder;
    if (f.key === 'data') {
      ta.addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault(); });
    }
    ta.addEventListener('focus', () => { pushHistory(); });
    ta.addEventListener('input', e => { state.content[f.key] = e.target.value; draw(); });
    g1.appendChild(ta);
  });
  host.appendChild(g1);

  // ── 2. TIPOGRAFIA TITOLO ──
  const g2 = cg('Tipografia Titolo');
  btnGroup(g2,
    [{ id: 'regular', label: 'Regular' }, { id: 'black', label: 'Black' }],
    state.fontWeight,
    (id) => { state.fontWeight = id; }
  );
  host.appendChild(g2);

  // ── 3. POSIZIONE DATA + LUOGO ──
  const g3 = cg('Posizione Data + Luogo');
  btnGroup(g3,
    [{ id: 'top-left', label: 'Sinistra' }, { id: 'top-center', label: 'Centro' }, { id: 'top-right', label: 'Destra' }],
    state.dataLuogoPlacement,
    (id) => { state.dataLuogoPlacement = id; }
  );
  toggleRow(g3, 'Scambia Data \u2194 Luogo', state.dataLuogoSwap, (v) => { state.dataLuogoSwap = v; });
  toggleRow(g3, 'Dividi Data e Luogo', state.dataLuogoFlex, (v) => { state.dataLuogoFlex = v; });
  host.appendChild(g3);

  // ── 4. POSIZIONE TITOLO ──
  const g4 = cg('Posizione Titolo');
  btnGroup(g4,
    [{ id: 'mid', label: 'Centro' }, { id: 'under-data', label: 'Sotto Data' }],
    state.titoloPos,
    (id) => { state.titoloPos = id; }
  );
  btnGroup(g4,
    [{ id: 'normal', label: 'Interlinea Normale' }, { id: 'modified', label: 'Interlinea Ampia' }],
    state.titoloLH || 'normal',
    (id) => { state.titoloLH = id; }
  );
  toggleRow(g4, 'Spazio flessibile sotto Titolo', state.testoFlex, (v) => { state.testoFlex = v; });
  host.appendChild(g4);

  // ── 5. COLORI ──
  const g5 = cg('Colori');
  const tcs = state.textColors || {};
  [
    { key: 'title', label: 'Titolo' },
    { key: 'date',  label: 'Data & Luogo' },
    { key: 'testo', label: 'Testo' },
  ].forEach(c => {
    buildColorButton(g5, {
      label: c.label,
      currentHex: tcs[c.key] || CONFIG.text.defaultColor,
      onChange: hex => {
        pushHistory();
        state.textColors[c.key] = hex;
        draw();
      }
    });
  });
  host.appendChild(g5);

  // ── 6. DIMENSIONI ──
  const g6 = cg('Dimensioni');
  buildTextSizeSliders(g6);
  host.appendChild(g6);
}

/* ── Custom text boxes ─────────────────────────────── */
let _customTextIdCounter = 0;

function buildCustomTextSection() {
  const host = document.getElementById('custom-text-container');
  if (!host) return;
  host.innerHTML = '';

  state.customTexts.forEach((ct, idx) => {
    const wrap = document.createElement('div');
    wrap.className = 'custom-text-block';
    wrap.style.border = '1px solid var(--border)';
    wrap.style.borderRadius = 'var(--radius-sm)';
    wrap.style.padding = '8px';
    wrap.style.marginBottom = '6px';

    // Text input
    const ta = document.createElement('textarea');
    ta.className = 'poster-textarea';
    ta.rows = 1;
    ta.value = ct.content || '';
    ta.placeholder = 'Testo personalizzato';
    ta.addEventListener('focus', () => { pushHistory(); });
    ta.addEventListener('input', e => { ct.content = e.target.value; draw(); });
    wrap.appendChild(ta);

    // Font selector
    const fontRow = document.createElement('div');
    fontRow.style.display = 'flex'; fontRow.style.gap = '4px'; fontRow.style.marginTop = '4px';
    const fontSel = document.createElement('select');
    fontSel.className = 'field-input';
    fontSel.style.flex = '1';
    ['QSci', 'Ronzino'].forEach(f => {
      const o = document.createElement('option');
      o.value = f; o.textContent = f;
      if (ct.font === f) o.selected = true;
      fontSel.appendChild(o);
    });
    fontSel.addEventListener('change', () => { pushHistory(); ct.font = fontSel.value; draw(); });

    // Blend mode
    const blendSel = document.createElement('select');
    blendSel.className = 'field-input';
    blendSel.style.flex = '1';
    CONFIG.blendModes.forEach(bm => {
      const o = document.createElement('option');
      o.value = bm.value; o.textContent = bm.label;
      if (ct.blend === bm.value) o.selected = true;
      blendSel.appendChild(o);
    });
    blendSel.addEventListener('change', () => { pushHistory(); ct.blend = blendSel.value; draw(); });
    fontRow.append(fontSel, blendSel);
    wrap.appendChild(fontRow);

    // Uppercase toggle
    const upRow = document.createElement('div');
    upRow.style.marginTop = '4px';
    const upLabel = document.createElement('label');
    upLabel.className = 'toggle';
    const upCheck = document.createElement('input');
    upCheck.type = 'checkbox';
    upCheck.checked = ct.uppercase !== false;
    upCheck.addEventListener('change', () => { pushHistory(); ct.uppercase = upCheck.checked; draw(); });
    const upTrack = document.createElement('span');
    upTrack.className = 'toggle-track';
    const upText = document.createElement('span');
    upText.className = 'field-label'; upText.style.marginLeft = '6px'; upText.textContent = 'MAIUSCOLO';
    upLabel.append(upCheck, upTrack, upText);
    upRow.appendChild(upLabel);
    wrap.appendChild(upRow);

    // Color picker
    const swatchGrp = document.createElement('div');
    swatchGrp.className = 'swatch-group';
    swatchGrp.style.marginTop = '4px';
    buildSwatchesInto(swatchGrp, ct.color || CONFIG.text.defaultColor, hex => {
      pushHistory(); ct.color = hex; draw();
    });
    wrap.appendChild(swatchGrp);

    // Position grid
    const posGrid = buildPosGrid9Custom(idx, ct);
    wrap.appendChild(posGrid);

    // Remove button
    const delBtn = document.createElement('button');
    delBtn.textContent = '✕ Rimuovi';
    delBtn.style.cssText = 'width:100%;margin-top:4px;padding:4px;border:1px solid var(--danger);color:var(--danger);border-radius:var(--radius-sm);font-size:11px;background:transparent;cursor:pointer;';
    delBtn.addEventListener('click', () => {
      pushHistory();
      state.customTexts.splice(idx, 1);
      buildCustomTextSection();
      draw();
    });
    wrap.appendChild(delBtn);
    host.appendChild(wrap);
  });

  // Add button
  const addBtn = document.createElement('button');
  addBtn.className = 'upload-btn';
  addBtn.style.cssText = 'width:100%;text-align:center;margin-top:8px';
  addBtn.textContent = '+ Aggiungi testo';
  addBtn.addEventListener('click', () => {
    pushHistory();
    state.customTexts.push({
      id: ++_customTextIdCounter,
      content: '',
      font: 'QSci',
      uppercase: true,
      color: CONFIG.text.defaultColor,
      placement: { v: 'mid', h: 'center' },
      blend: 'normal',
    });
    buildCustomTextSection();
    draw();
  });
  host.appendChild(addBtn);
}

function buildPosGrid9Custom(idx, ct) {
  const grid = document.createElement('div');
  grid.className = 'pos-grid';
  _posDefs.forEach(pos => {
    const btn = document.createElement('button');
    btn.className = 'pos-btn';
    btn.textContent = pos.icon;
    const cur = ct.placement || { v: 'mid', h: 'center' };
    if (cur.v === pos.v && cur.h === pos.h) btn.classList.add('active');
    btn.addEventListener('click', () => {
      pushHistory();
      ct.placement = { v: pos.v, h: pos.h };
      grid.querySelectorAll('.pos-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      draw();
    });
    grid.appendChild(btn);
  });
  return grid;
}

/* ── Library Tabs ────────────────────────────────────── */
let _shapeIdCounter = 0;
let _overlayIdCounter = 0;

function buildLibraryTabs() {
  const host = document.getElementById('library-tabs-container');
  if (!host) return;

  const fontOpts = [
    { id: 'QSciIcon', label: 'Icone' },
    { id: 'QSci',     label: 'Testo'  },
  ];
  const activeFont = host.dataset.iconFont || 'QSciIcon';

  // Font selector
  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:4px;margin-bottom:4px;padding:0 2px';
  fontOpts.forEach(f => {
    const active = f.id === activeFont;
    const btn = document.createElement('button');
    btn.textContent = f.label;
    btn.style.cssText =
      `flex:1;padding:5px;font-size:11px;border:1px solid ${active ? 'var(--accent)' : 'var(--border)'};` +
      `border-radius:var(--radius-sm);background:${active ? 'rgba(79,142,247,0.1)' : 'transparent'};` +
      `color:${active ? 'var(--accent)' : 'var(--text-muted)'};cursor:pointer;font-weight:${active ? '600' : '400'}`;
    btn.addEventListener('click', () => {
      host.dataset.iconFont = f.id;
      buildLibraryTabs();
    });
    btnRow.appendChild(btn);
  });

  // Glyph grid — static curated lists (no async detection)
  const iconGlyphs = '!"$%\'()+,./123456789?ABCDEFGHIJKLMNOPQRSTUVWXYZ^abcdefghijklmnopqrstuvwxyz'.split('');
  const textGlyphs = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const glyphs = activeFont === 'QSciIcon' ? iconGlyphs : textGlyphs;

  const ig = document.createElement('div');
  ig.className = 'shape-grid';
  for (const g of glyphs) {
    const chip = document.createElement('button');
    chip.className = 'shape-chip';
    chip.style.fontFamily = `'${activeFont}'`;
    chip.textContent = g;
    chip.title = `${activeFont} - ${g}`;
    chip.addEventListener('click', () => {
      pushHistory();
      const id = ++_overlayIdCounter;
      const W = state.canvasW, H = state.canvasH;
      state.letterOverlays.push({
        id, letter: g,
        x: Math.round(W / 2), y: Math.round(H / 2),
        sizeRatio: 0.15,
        color:  state.textColors?.title || CONFIG.text.defaultColor,
        blend:  'normal',
        opacity: 1,
        rotation: 0,
        font: activeFont,
      });
      state.selectedOverlayId = id;
      state.selectedImageId   = null;
      buildLetterControls();
      draw();
    });
    ig.appendChild(chip);
  }

  host.innerHTML = '';
  host.appendChild(btnRow);
  host.appendChild(ig);
}



/* ── Shapes ──────────────────────────────────────────── */
function addShape(type) {
  pushHistory();
  const id = ++_shapeIdCounter;
  const W = state.canvasW;
  const H = state.canvasH;
  const sz = Math.round(Math.min(W, H) * 0.25);
  state.shapes.push({
    id, type,
    x:          Math.round(W / 2),
    y:          Math.round(H / 2),
    size:       sz,
    color:      CONFIG.palette[6].hex, // Nero
    gradient:   null,
    opacity:    1,
    blend:      'normal',
    rotation:   0,
    aspectRatio: type === 'rectangle' ? 1.5 : undefined,
  });
  state.selectedShapeId = id;
  buildLibraryTabs();
  buildShapeControlsInto(document.getElementById('overlay-controls'));
  draw();
}

function buildShapeControlsInto(host) {
  if (!host) return;
  host.innerHTML = '';

  const sel = state.shapes.find(s => s.id === state.selectedShapeId);
  if (!sel) {
    if (state.shapes.length) {
      const hint = document.createElement('p');
      hint.className = 'overlay-hint';
      hint.textContent = 'Clicca su una forma nel canvas per modificarla.';
      host.appendChild(hint);
    }
    return;
  }

  const hdr = document.createElement('div');
  hdr.className = 'overlay-hdr';
  hdr.textContent = `Forma: ${CONFIG.shapes.find(sh => sh.type === sel.type)?.label || sel.type}`;
  host.appendChild(hdr);

  // Color button (dropdown palette, same pattern as bg/text colors)
  buildColorButton(host, {
    id: 'shape-color',
    label: 'Colore forma',
    currentHex: sel.color,
    onChange: hex => { pushHistory(); sel.color = hex; sel.gradient = null; draw(); },
  });

  // Gradient variations
  const gradSub = document.createElement('div');
  gradSub.className = 'section-subheader';
  gradSub.textContent = 'Sfumature';
  host.appendChild(gradSub);
  const gradGrp = document.createElement('div');
  gradGrp.style.display = 'flex'; gradGrp.style.flexWrap = 'wrap'; gradGrp.style.gap = '3px';
  // Find matching gradient variations for this shape's current color
  const baseKey = Object.keys(CONFIG.gradVariations || {}).find(k =>
    CONFIG.palette.some(p => p.hex.toLowerCase() === sel.color.toLowerCase() && p.name === k)
  ) || CONFIG.palette.find(p => p.hex.toLowerCase() === sel.color.toLowerCase())?.name;
  if (baseKey && CONFIG.gradVariations[baseKey]) {
    const vars = CONFIG.gradVariations[baseKey];
    vars.forEach(v => {
      const chip = document.createElement('div');
      chip.style.cssText = `width:20px;height:20px;border-radius:var(--radius-sm);background:linear-gradient(90deg,${v.from},${v.to});border:1px solid var(--border);cursor:pointer;`;
      chip.title = v.label;
      const active = sel.gradient && sel.gradient.from === v.from && sel.gradient.to === v.to;
      if (active) chip.style.boxShadow = '0 0 0 2px var(--text)';
      chip.addEventListener('click', () => {
        pushHistory();
        sel.gradient = { from: v.from, to: v.to, angle: 90 };
        draw();
      });
      gradGrp.appendChild(chip);
    });
  }
  host.appendChild(gradGrp);

  // Clear gradient button
  const clrGrad = document.createElement('button');
  clrGrad.textContent = 'Nessuna sfumatura';
  clrGrad.style.cssText = 'width:100%;margin-top:4px;padding:3px;font-size:11px;border:1px solid var(--border);border-radius:var(--radius-sm);background:transparent;color:var(--text-muted);cursor:pointer;';
  clrGrad.addEventListener('click', () => { pushHistory(); sel.gradient = null; draw(); });
  host.appendChild(clrGrad);

  // Blend mode dropdown
  const blendRow = document.createElement('div');
  blendRow.style.marginTop = '6px';
  blendRow.style.display = 'flex'; blendRow.style.gap = '6px'; blendRow.style.alignItems = 'center';
  const blendLbl = document.createElement('span');
  blendLbl.className = 'field-label'; blendLbl.textContent = 'Blend';
  const blendSel = document.createElement('select');
  blendSel.className = 'field-input'; blendSel.style.flex = '1';
  CONFIG.blendModes.forEach(bm => {
    const o = document.createElement('option');
    o.value = bm.value; o.textContent = bm.label;
    if (sel.blend === bm.value) o.selected = true;
    blendSel.appendChild(o);
  });
  blendSel.addEventListener('change', () => { pushHistory(); sel.blend = blendSel.value; draw(); });
  blendRow.append(blendLbl, blendSel);
  host.appendChild(blendRow);

  // Size slider
  const sizeRow = document.createElement('div');
  sizeRow.className = 'slider-row'; sizeRow.style.marginTop = '6px';
  const sizeLbl = document.createElement('label');
  sizeLbl.className = 'field-label'; sizeLbl.textContent = 'Dimensione';
  const sizeSlider = document.createElement('input');
  sizeSlider.type = 'range'; sizeSlider.className = 'field-range';
  sizeSlider.min = '10'; sizeSlider.max = String(Math.round(Math.max(state.canvasW, state.canvasH) * 0.6));
  sizeSlider.step = '1'; sizeSlider.value = String(sel.size);
  let _sszFirst = false;
  sizeSlider.addEventListener('mousedown', () => { _sszFirst = true; });
  sizeSlider.addEventListener('input', () => {
    if (_sszFirst) { pushHistory(); _sszFirst = false; }
    sel.size = Number(sizeSlider.value);
    drawSmooth();
  });
  sizeRow.append(sizeLbl, sizeSlider);
  host.appendChild(sizeRow);

  // Opacity slider
  const opRow = document.createElement('div');
  opRow.className = 'slider-row';
  const opLbl = document.createElement('label');
  opLbl.className = 'field-label'; opLbl.textContent = 'Opacità';
  const opSlider = document.createElement('input');
  opSlider.type = 'range'; opSlider.className = 'field-range';
  opSlider.min = '0'; opSlider.max = '1'; opSlider.step = '0.01';
  opSlider.value = String(sel.opacity ?? 1);
  let _sopFirst = false;
  opSlider.addEventListener('mousedown', () => { _sopFirst = true; });
  opSlider.addEventListener('input', () => {
    if (_sopFirst) { pushHistory(); _sopFirst = false; }
    sel.opacity = Number(opSlider.value);
    drawSmooth();
  });
  opRow.append(opLbl, opSlider);
  host.appendChild(opRow);

  // Delete button
  const delBtn = document.createElement('button');
  delBtn.textContent = 'Rimuovi forma';
  delBtn.className = 'overlay-del-btn';
  delBtn.addEventListener('click', () => {
    pushHistory();
    state.shapes = state.shapes.filter(s => s.id !== state.selectedShapeId);
    state.selectedShapeId = null;
    buildLibraryTabs();
    buildShapeControlsInto(document.getElementById('overlay-controls'));
    draw();
  });
  host.appendChild(delBtn);
}

/* ── Logo Import & Controls ──────────────────────────── */
let _logoIdCounter = 0;

window.recolorSVG = function recolorSVG(svgString, newColor) {
  if (!newColor || !svgString || !svgString.startsWith('data:image/svg')) return svgString;
  try {
    const base64 = svgString.split(',')[1];
    const decoded = atob(base64);
    // Handle fill attributes: fill="#xxx" → fill="newColor"
    let recolored = decoded.replace(/fill="(?!none|transparent)([^"]*)"/gi, `fill="${newColor}"`);
    // Handle CSS/inline fill:  fill:#xxx or fill: #xxx → fill: newColor
    recolored = recolored.replace(/fill:\s*#[0-9a-fA-F]{3,8}/gi, `fill: ${newColor}`);
    return 'data:image/svg+xml;base64,' + btoa(recolored);
  } catch { return svgString; }
};

function buildLogoControls() {
  const host = document.getElementById('logo-controls');
  if (!host) return;
  host.innerHTML = '';

  if (!state.logos.length) return;

  // Track per-logo size slider DOM refs so the "linked" mode can sync them
  const _logoSizeSliders = [];

  // ── Linked-size toggle (top of section) ──
  {
    const linkRow = document.createElement('div');
    linkRow.className = 'ctrl-toggle-row';
    linkRow.style.cssText = 'margin-bottom:8px';
    const lblWrap = document.createElement('label');
    lblWrap.className = 'toggle';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = !!state.logosSizeLinked;
    chk.addEventListener('change', () => {
      pushHistory();
      state.logosSizeLinked = chk.checked;
      // When turning ON, snap all logos to the size of the first one so
      // the toggle has a visible, predictable effect immediately.
      if (state.logosSizeLinked && state.logos.length) {
        const ref = state.logos[0].sizeRatio || CONFIG.typography.logoHeightRatio || 0.072;
        state.logos.forEach(l => { l.sizeRatio = ref; });
      }
      buildLogoControls();
      draw();
    });
    const trk = document.createElement('span');
    trk.className = 'toggle-track';
    const txt = document.createElement('span');
    txt.className = 'ctrl-toggle-label';
    txt.textContent = 'Dimensioni collegate';
    lblWrap.append(chk, trk, txt);
    linkRow.appendChild(lblWrap);
    host.appendChild(linkRow);
  }

  // Helper: button option group
  const btnGroup = (parent, options, current, onChange) => {
    const row = document.createElement('div');
    row.className = 'ctrl-btn-group';
    options.forEach(opt => {
      const btn = document.createElement('button');
      btn.className = 'ctrl-btn';
      if (current === opt.id) btn.classList.add('active');
      btn.textContent = opt.label;
      btn.addEventListener('click', () => { pushHistory(); onChange(opt.id); buildLogoControls(); draw(); });
      row.appendChild(btn);
    });
    parent.appendChild(row);
  };

  // Helper: toggle switch row
  const toggleRow = (parent, label, checked, onChange) => {
    const row = document.createElement('div');
    row.className = 'ctrl-toggle-row';
    const lbl = document.createElement('label');
    lbl.className = 'toggle';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = checked;
    chk.addEventListener('change', () => { pushHistory(); onChange(chk.checked); buildLogoControls(); draw(); });
    const trk = document.createElement('span');
    trk.className = 'toggle-track';
    const txt = document.createElement('span');
    txt.className = 'ctrl-toggle-label';
    txt.textContent = label;
    lbl.append(chk, trk, txt);
    row.appendChild(lbl);
    parent.appendChild(row);
  };

  for (let i = 0; i < state.logos.length; i++) {
    const logo = state.logos[i];
    const card = document.createElement('div');
    card.className = 'ctrl-group';
    card.style.cssText = 'position:relative';

    // Header row: thumbnail + filename
    const hdr = document.createElement('div');
    hdr.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px';
    const thumb = document.createElement('img');
    thumb.style.cssText = 'width:48px;height:36px;border-radius:4px;object-fit:contain;background:var(--bg-section);border:1px solid var(--border);flex-shrink:0';
    thumb.src = logo.dataURL;
    thumb.title = logo.name || ('Logo ' + (i + 1));
    hdr.appendChild(thumb);
    const nameSpan = document.createElement('span');
    nameSpan.style.cssText = 'font-size:12px;font-weight:500;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    nameSpan.textContent = logo.isDefault ? 'Logo — default' : (logo.name || 'Logo ' + (i + 1));
    hdr.appendChild(nameSpan);
    // Delete button in header
    if (!logo.isDefault) {
      const delBtn = document.createElement('button');
      delBtn.textContent = '✕';
      delBtn.style.cssText = 'margin-left:auto;border:1px solid var(--danger);color:var(--danger);border-radius:var(--radius-sm);background:transparent;cursor:pointer;padding:2px 6px;font-size:11px;flex-shrink:0';
      delBtn.addEventListener('click', () => {
        pushHistory();
        state.logos.splice(i, 1);
        if (state.selectedLogoId === logo.id) state.selectedLogoId = null;
        buildLogoControls();
        draw();
      });
      hdr.appendChild(delBtn);
    }
    card.appendChild(hdr);

    // Toggle visibility
    toggleRow(card, 'Visibile', logo.visible !== false, (v) => { logo.visible = v; });

    // Alignment
    const alignLabel = document.createElement('div');
    alignLabel.className = 'ctrl-group-label';
    alignLabel.textContent = 'Posizione';
    card.appendChild(alignLabel);
    btnGroup(card,
      [{ id: 'left', label: 'Sinistra' }, { id: 'center', label: 'Centro' }, { id: 'right', label: 'Destra' }],
      logo.align || '',
      (id) => { logo.align = (logo.align === id ? undefined : id); }
    );

    // Size slider (per logo)
    {
      const szRow = document.createElement('div');
      szRow.className = 'ctrl-slider-row';
      const szLbl = document.createElement('span');
      szLbl.className = 'ctrl-slider-label';
      szLbl.textContent = 'Dimensione';
      const szRange = document.createElement('input');
      szRange.type = 'range';
      szRange.className = 'field-range';
      szRange.style.flex = '1';
      szRange.min = '0.02';
      szRange.max = '0.30';
      szRange.step = '0.005';
      const currentRatio = logo.sizeRatio || CONFIG.typography.logoHeightRatio || 0.072;
      szRange.value = String(currentRatio);
      const szVal = document.createElement('span');
      szVal.className = 'ctrl-slider-val';
      const pctFmt = (v) => Math.round(v * 100) + '%';
      szVal.textContent = pctFmt(currentRatio);
      let _szFirst = false;
      szRange.addEventListener('mousedown', () => { _szFirst = true; });
      szRange.addEventListener('input', () => {
        if (_szFirst) { pushHistory(); _szFirst = false; }
        const v = Number(szRange.value);
        logo.sizeRatio = v;
        szVal.textContent = pctFmt(v);
        // Linked mode: keep every other logo in sync with this slider
        if (state.logosSizeLinked) {
          state.logos.forEach((l, j) => {
            if (l === logo) return;
            l.sizeRatio = v;
            const ref = _logoSizeSliders[j];
            if (ref) {
              ref.range.value = String(v);
              ref.val.textContent = pctFmt(v);
            }
          });
        }
        drawSmooth();
      });
      szRow.append(szLbl, szRange, szVal);
      card.appendChild(szRow);
      _logoSizeSliders[i] = { range: szRange, val: szVal };
    }

    // Color picker for SVG logos
    if (logo.dataURL && logo.dataURL.startsWith('data:image/svg')) {
      buildColorButton(card, {
        label: 'Colore logo',
        currentHex: logo.color || '#302d2e',
        onChange: function(hex) {
          pushHistory();
          logo.color = hex;
          buildLogoControls();
          draw();
        }
      });
    }

    host.appendChild(card);
  }
}

/* ── Pattern Editor ─────────────────────────────────────── */
const _PG = {}; // pattern-editor globals

function openPatternEditor() {
  const pb = state.patternBg;
  const gridX = pb ? pb.gridX : 8;
  const gridY = pb ? pb.gridY : 10;
  const color = pb ? pb.color : CONFIG.palette[6].hex; // Nero
  const oldGlyphs = pb && pb.glyphs ? pb.glyphs : [];
  const totalCells = gridX * gridY;
  const glyphs = new Array(totalCells).fill(' ');
  for (let i = 0; i < Math.min(oldGlyphs.length, totalCells); i++) {
    if (oldGlyphs[i] && oldGlyphs[i].trim()) glyphs[i] = oldGlyphs[i];
  }

  _PG.gridX = gridX;
  _PG.gridY = gridY;
  _PG.color = color;
  _PG.glyphs = glyphs;
  _PG.selectedGlyph = 'A';
  _PG.zoom = (pb && pb._zoom) || 100;

  const old = document.getElementById('pattern-editor-overlay');
  if (old) old.remove();

  const overlay = document.createElement('div');
  overlay.id = 'pattern-editor-overlay';
  overlay.className = 'pattern-editor-overlay';
  overlay.innerHTML = _buildPatternModalHTML();
  document.body.appendChild(overlay);

  // Generate preview of current poster content behind the grid
  // Use inline SVG (not <img>) so page fonts (QSci, Ronzino, etc.) render correctly
  // Strip explicit width/height so the SVG scales to 100% of the preview container
  const previewDiv = overlay.querySelector('#pg-preview');
  if (previewDiv) {
    const svg = buildSVG(state);
    previewDiv.innerHTML = svg.replace(/<svg([^>]*)>/, '<svg$1 preserveAspectRatio="xMidYMid slice">').replace(/\bwidth="\d+"/, '').replace(/\bheight="\d+"/, '');
  }

  _bindPatternEvents(overlay);
  // Tutorial — first-time user guide
  if (!_lsGet('pattern_tutorial_done')) {
    _showPatternTutorial(overlay);
  }
  requestAnimationFrame(() => {
    _updatePatternGrid();
    _patternZoomFit();
  });
}

function closePatternEditor() {
  const overlay = document.getElementById('pattern-editor-overlay');
  if (overlay) overlay.remove();
}

/* ── Pattern Editor Tutorial ────────────────────────── */
var _PATTERN_TUTORIAL_STEPS = [
  { target: '.pg-palette', title: '1/4 \u00b7 Scegli un\'icona', text: 'Seleziona un\'icona dalla palette a sinistra. Clicca su quella che preferisci, poi dipingi le celle della griglia.', placement: 'right' },
  { target: '.pg-grid', title: '2/4 \u00b7 Dipingi la griglia', text: 'Clicca o trascina sulle celle della griglia per dipingere con l\'icona selezionata. Ogni cella viene riempita con l\'icona scelta.', placement: 'left' },
  { target: '.pg-glyph--eraser', title: '3/4 \u00b7 Gomma', text: 'Usa la gomma (\u2715) per cancellare il contenuto di una cella. Seleziona la gomma e clicca sulla cella da cancellare.', placement: 'bottom' },
  { target: '#pg-apply', title: '4/4 \u00b7 Applica', text: 'Clicca "Applica" per salvare il pattern sul poster. Puoi sempre riaprire l\'editor per modificarlo.', placement: 'top' },
];
function _showPatternTutorial(overlay) {
  var tutorialDiv = document.createElement('div');
  tutorialDiv.className = 'pattern-tutorial';
  tutorialDiv.innerHTML = '<div class="pt-backdrop"></div><div class="pt-tooltip" id="pt-tooltip"><div class="pt-header"></div><div class="pt-body"></div><div class="pt-footer"><button class="pt-btn pt-btn--secondary" id="pt-close">Chiudi</button><div class="pt-footer-right"><button class="pt-btn pt-btn--secondary" id="pt-prev" disabled>Indietro</button><button class="pt-btn pt-btn--primary" id="pt-next">Avanti</button></div></div></div>';
  overlay.appendChild(tutorialDiv);
  var step = 0;
  var tooltip = tutorialDiv.querySelector('#pt-tooltip');
  var header = tutorialDiv.querySelector('.pt-header');
  var body = tutorialDiv.querySelector('.pt-body');
  var prevBtn = tutorialDiv.querySelector('#pt-prev');
  var nextBtn = tutorialDiv.querySelector('#pt-next');
  var closeBtn = tutorialDiv.querySelector('#pt-close');
  function clearHighlights() {
    // Highlighted elements live in `overlay`, not inside tutorialDiv.
    var highlights = overlay.querySelectorAll('.pt-highlight');
    for (var h = 0; h < highlights.length; h++) { highlights[h].classList.remove('pt-highlight'); }
  }
  function applyStep(idx) {
    var s = _PATTERN_TUTORIAL_STEPS[idx];
    clearHighlights();
    header.textContent = s.title;
    body.textContent = s.text;
    prevBtn.disabled = idx === 0;
    nextBtn.textContent = (idx === _PATTERN_TUTORIAL_STEPS.length - 1) ? 'Fine' : 'Avanti';
    var targetEl = overlay.querySelector(s.target);
    if (targetEl) {
      targetEl.classList.add('pt-highlight');
      setTimeout(function() {
        var tr = targetEl.getBoundingClientRect();
        var tir = tooltip.getBoundingClientRect();
        var top = 0, left = 0;
        if (s.placement === 'right') { top = tr.top + tr.height/2 - tir.height/2; left = tr.right + 16; }
        else if (s.placement === 'left') { top = tr.top + tr.height/2 - tir.height/2; left = tr.left - tir.width - 16; }
        else if (s.placement === 'top') { top = tr.top - tir.height - 16; left = tr.left + tr.width/2 - tir.width/2; }
        else { top = tr.bottom + 16; left = tr.left + tr.width/2 - tir.width/2; }
        top = Math.max(8, Math.min(window.innerHeight - tir.height - 8, top));
        left = Math.max(8, Math.min(window.innerWidth - tir.width - 8, left));
        tooltip.style.top = top + 'px';
        tooltip.style.left = left + 'px';
        tooltip.style.opacity = '1';
        tooltip.style.transform = 'translateY(0)';
      }, 50);
    }
  }
  nextBtn.addEventListener('click', function() {
    if (step < 3) { step++; applyStep(step); }
    else { _lsSet('pattern_tutorial_done', '1'); clearHighlights(); tutorialDiv.remove(); }
  });
  prevBtn.addEventListener('click', function() {
    if (step > 0) { step--; applyStep(step); }
  });
  closeBtn.addEventListener('click', function() {
    _lsSet('pattern_tutorial_done', '1'); clearHighlights(); tutorialDiv.remove();
  });
  requestAnimationFrame(function() { applyStep(0); });
}

function _buildPatternModalHTML() {
  const iconChars = '!"$%\'()+,./123456789?ABCDEFGHIJKLMNOPQRSTUVWXYZ^abcdefghijklmnopqrstuvwxyz';
  let paletteHTML = '';
  paletteHTML += `<div class="pg-glyph pg-glyph--eraser" data-g=" " title="Gomma (vuoto)"><svg width="100%" height="100%" viewBox="0 0 24 24"><line x1="7" y1="7" x2="17" y2="17" stroke="#f44" stroke-width="2.5" stroke-linecap="round"/><line x1="17" y1="7" x2="7" y2="17" stroke="#f44" stroke-width="2.5" stroke-linecap="round"/></svg></div>`;
  iconChars.split('').forEach(ch => {
    const sel = _PG.selectedGlyph === ch ? ' pg-glyph--sel' : '';
    paletteHTML += `<div class="pg-glyph${sel}" data-g="${ch.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}" title="Icona ${ch.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}"><svg width="100%" height="100%" viewBox="0 0 24 24"><text x="12" y="21" text-anchor="middle" font-family="'QSciIcon'" font-size="20" fill="currentColor">${ch.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</text></svg></div>`;
  });

  return `
    <div class="pg-modal">
      <div class="pg-hdr">
        <span class="pg-title">Editor Pattern</span>
        <button class="help-btn pg-help-btn" id="pg-help" data-tip="Seleziona un'icona dalla palette e clicca sulle celle per dipingere. Usa la gomma (✕) per cancellare. Le opzioni di griglia e zoom sono nella colonna di sinistra." title="Aiuto">?</button>
        <button class="pg-close" id="pg-close">&times;</button>
      </div>
      <div class="pg-body">
        <div class="pg-sidebar">
          <div class="field-label" style="margin-bottom:4px">Griglia</div>
          <div class="pg-dims-sidebar">
            <label>Colonne <input type="number" id="pg-gridx" class="pg-num" value="${_PG.gridX}" min="2" max="50"></label>
            <label>Righe <input type="number" id="pg-gridy" class="pg-num" value="${_PG.gridY}" min="2" max="50"></label>
          </div>
          <div class="field-label" style="margin-top:12px;margin-bottom:4px">Zoom</div>
          <div class="pg-zoom-sidebar">
            <input type="range" id="pg-zoom" min="10" max="200" value="${_PG.zoom}">
            <span id="pg-zoom-label">${_PG.zoom}%</span>
            <button id="pg-fit" title="Adatta">Adatta</button>
          </div>
          <div class="field-label" style="margin-top:12px;margin-bottom:4px">Icone</div>
          <div class="pg-palette" id="pg-palette">${paletteHTML}</div>
          <div class="field-label" style="margin-top:12px;margin-bottom:4px">Colore</div>
          <div class="pg-color-picker" id="pg-color-picker"></div>
        </div>
        <div class="pg-main">
          <div class="pg-desk" id="pg-desk">
            <div class="pg-artboard" id="pg-artboard">
              <div class="pg-preview" id="pg-preview"></div>
              <div class="pg-grid" id="pg-grid"></div>
            </div>
          </div>
        </div>
      </div>
      <div class="pg-footer">
        <button class="upload-btn" id="pg-clear">Pulisci tutto</button>
        <button class="upload-btn" id="pg-random">Riempimento casuale</button>
        <button class="topbar-btn topbar-btn--accent" id="pg-apply">Applica</button>
      </div>
    </div>`;
}

function _bindPatternEvents(overlay) {
  overlay.querySelector('#pg-close').addEventListener('click', closePatternEditor);
  overlay.addEventListener('click', e => { if (e.target === overlay) closePatternEditor(); });

  overlay.querySelectorAll('.pg-glyph').forEach(el => {
    el.addEventListener('click', () => {
      _PG.selectedGlyph = el.dataset.g;
      overlay.querySelectorAll('.pg-glyph').forEach(g => g.classList.remove('pg-glyph--sel'));
      el.classList.add('pg-glyph--sel');
    });
  });

  // Color picker — use buildColorButton pattern
  const colorHost = overlay.querySelector('#pg-color-picker');
  if (colorHost) {
    buildColorButton(colorHost, {
      currentHex: _PG.color,
      label: 'Colore pattern',
      onChange: function(hex) {
        _PG.color = hex;
        _updatePatternGrid();
      }
    });
  }

  const rebuild = () => _rebuildPatternGrid(overlay);
  overlay.querySelector('#pg-gridx').addEventListener('change', rebuild);
  overlay.querySelector('#pg-gridy').addEventListener('change', rebuild);

  const zoomSlider = overlay.querySelector('#pg-zoom');
  const zoomLabel = overlay.querySelector('#pg-zoom-label');
  zoomSlider.addEventListener('input', () => {
    _PG.zoom = Number(zoomSlider.value);
    zoomLabel.textContent = _PG.zoom + '%';
    _applyPatternZoom();
  });
  overlay.querySelector('#pg-fit').addEventListener('click', () => _patternZoomFit());

  overlay.querySelector('#pg-clear').addEventListener('click', () => {
    _PG.glyphs = new Array(_PG.gridX * _PG.gridY).fill(' ');
    _updatePatternGrid();
  });

  overlay.querySelector('#pg-random').addEventListener('click', () => {
    const validChars = '!"$%\'()+,./123456789?ABCDEFGHIJKLMNOPQRSTUVWXYZ^abcdefghijklmnopqrstuvwxyz'.split('');
    for (let i = 0; i < _PG.glyphs.length; i++) {
      _PG.glyphs[i] = validChars[Math.floor(Math.random() * validChars.length)];
    }
    _updatePatternGrid();
  });

  overlay.querySelector('#pg-apply').addEventListener('click', () => {
    pushHistory();
    state.patternBg = {
      gridX: _PG.gridX,
      gridY: _PG.gridY,
      color: _PG.color,
      glyphs: [..._PG.glyphs],
      _zoom: _PG.zoom,
    };
    closePatternEditor();
    draw();
  });

  // Help ? button
  const helpBtn = overlay.querySelector('#pg-help');
  if (helpBtn) {
    helpBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!_lsGet('pattern_tutorial_done')) {
        _showPatternTutorial(overlay);
      } else {
        // Clear flag and show tutorial again
        _lsRemove('pattern_tutorial_done');
        _showPatternTutorial(overlay);
      }
    });
  }
}

function _rebuildPatternGrid(overlay) {
  const nx = Number(overlay.querySelector('#pg-gridx').value) || 8;
  const ny = Number(overlay.querySelector('#pg-gridy').value) || 10;
  const total = nx * ny;
  const newGlyphs = new Array(total).fill(' ');
  const oldTotal = _PG.gridX * _PG.gridY;
  for (let i = 0; i < Math.min(oldTotal, total); i++) {
    const or = Math.floor(i / _PG.gridX);
    const oc = i % _PG.gridX;
    if (oc < nx && or < ny) {
      const ni = or * nx + oc;
      newGlyphs[ni] = _PG.glyphs[i] || ' ';
    }
  }
  _PG.gridX = nx;
  _PG.gridY = ny;
  _PG.glyphs = newGlyphs;
  _updatePatternGrid();
  _patternZoomFit();
}

function _updatePatternGrid() {
  const grid = document.getElementById('pg-grid');
  if (!grid) return;
  const gx = _PG.gridX, gy = _PG.gridY;
  const W = state.canvasW, H = state.canvasH;
  const cellW = W / gx;
  const cellH = H / gy;
  const color = _PG.color;

  grid.style.gridTemplateColumns = `repeat(${gx}, 1fr)`;
  grid.style.gridTemplateRows = `repeat(${gy}, 1fr)`;
  grid.style.width = W + 'px';
  grid.style.height = H + 'px';
  grid.style.color = color;
  grid.innerHTML = '';

  const fragment = document.createDocumentFragment();
  for (let i = 0; i < gx * gy; i++) {
    const g = _PG.glyphs[i] || ' ';
    const cell = document.createElement('div');
    cell.className = 'pg-cell';
    cell.dataset.idx = String(i);

    if (g === ' ' || !g.trim()) {
      cell.innerHTML = `<svg width="100%" height="100%" viewBox="0 0 ${cellW} ${cellH}"></svg>`;
    } else {
      cell.innerHTML = `<svg width="100%" height="100%" viewBox="0 0 ${cellW} ${cellH}"><text x="${cellW/2}" y="${cellH / 2}" text-anchor="middle" dominant-baseline="central" font-family="'QSciIcon'" font-size="${Math.min(cellW, cellH) * 0.75}" fill="currentColor">${g.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</text></svg>`;
    }

    const paint = () => {
      _PG.glyphs[i] = _PG.selectedGlyph;
      const svg = cell.querySelector('svg');
      if (_PG.selectedGlyph === ' ' || !_PG.selectedGlyph.trim()) {
        svg.innerHTML = '';
      } else {
        svg.innerHTML = `<text x="${cellW/2}" y="${cellH / 2}" text-anchor="middle" dominant-baseline="central" font-family="'QSciIcon'" font-size="${Math.min(cellW, cellH) * 0.75}" fill="currentColor">${_PG.selectedGlyph.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</text>`;
      }
    };

    cell.addEventListener('mousedown', e => { e.preventDefault(); paint(); });
    cell.addEventListener('mouseenter', e => {
      if (e.buttons === 1) { e.preventDefault(); paint(); }
    });
    fragment.appendChild(cell);
  }
  grid.appendChild(fragment);
}

function _applyPatternZoom() {
  const grid = document.getElementById('pg-grid');
  const artboard = document.getElementById('pg-artboard');
  if (!grid || !artboard) return;
  const scale = _PG.zoom / 100;
  const W = state.canvasW, H = state.canvasH;
  artboard.style.width = (W * scale) + 'px';
  artboard.style.height = (H * scale) + 'px';
  grid.style.transform = `scale(${scale})`;
}

function _patternZoomFit() {
  const desk = document.getElementById('pg-desk');
  if (!desk) return;
  const dw = desk.clientWidth - 80;
  const dh = desk.clientHeight - 80;
  if (dw <= 0 || dh <= 0) return;
  const sw = dw / state.canvasW;
  const sh = dh / state.canvasH;
  let fit = Math.min(sw, sh);
  if (fit > 1) fit = 1;
  _PG.zoom = Math.floor(fit * 100);
  const slider = document.getElementById('pg-zoom');
  const label = document.getElementById('pg-zoom-label');
  if (slider) slider.value = String(_PG.zoom);
  if (label) label.textContent = _PG.zoom + '%';
  _applyPatternZoom();
}

function clearPatternBackground() {
  pushHistory();
  state.patternBg = null;
  draw();
}

/* ── QR Code Controls ──────────────────────────────────── */
function buildQRControls() {
  const host = document.getElementById('qr-controls');
  if (!host) return;
  host.innerHTML = '';
  const qr = state.qrParams;
  if (!qr) return;

  // Helper: button option group
  const btnGroup = (parent, options, current, onChange) => {
    const row = document.createElement('div');
    row.className = 'ctrl-btn-group';
    options.forEach(opt => {
      const btn = document.createElement('button');
      btn.className = 'ctrl-btn';
      if (current === opt.id) btn.classList.add('active');
      btn.textContent = opt.label;
      btn.addEventListener('click', () => { onChange(opt.id); });
      row.appendChild(btn);
    });
    parent.appendChild(row);
  };

  // Helper: control group card with optional label
  const cg = (label) => {
    const d = document.createElement('div');
    d.className = 'ctrl-group';
    if (label) {
      const l = document.createElement('div');
      l.className = 'ctrl-group-label';
      l.textContent = label;
      d.appendChild(l);
    }
    return d;
  };

  // URL input
  const gUrl = cg('URL');
  const urlInp = document.createElement('input');
  urlInp.className = 'poster-textarea';
  urlInp.type = 'url';
  urlInp.placeholder = 'https://…';
  urlInp.value = qr.url || '';
  urlInp.rows = 1;
  urlInp.addEventListener('input', () => { qr.url = urlInp.value; draw(); });
  gUrl.appendChild(urlInp);
  host.appendChild(gUrl);

  // Posizione
  const gPos = cg('Posizione');
  btnGroup(gPos,
    [{ id: 'left', label: 'Sinistra' }, { id: 'center', label: 'Centro' }, { id: 'right', label: 'Destra' }],
    qr.hAlign,
    (id) => { qr.hAlign = id; buildQRControls(); draw(); }
  );
  host.appendChild(gPos);

  // Colore QR
  buildColorButton(host, {
    label: 'Colore QR',
    currentHex: qr.qrColor || '#000000',
    onChange: hex => { qr.qrColor = hex; draw(); }
  });

  // Dimensione slider
  const gSz = cg('Dimensione');
  const szRow = document.createElement('div');
  szRow.className = 'ctrl-slider-row';
  const szLbl = document.createElement('span');
  szLbl.className = 'ctrl-slider-label';
  const szSlider = document.createElement('input');
  szSlider.type = 'range'; szSlider.className = 'field-range'; szSlider.style.flex = '1';
  szSlider.min = '5'; szSlider.max = '10'; szSlider.step = '1';
  szSlider.value = String(Math.round((qr.sizeRatio || 0.1) * 100));
  const szVal = document.createElement('span');
  szVal.className = 'ctrl-slider-val';
  szVal.textContent = szSlider.value + '%';
  let _qrSzFirst = false;
  szSlider.addEventListener('mousedown', () => { _qrSzFirst = true; });
  szSlider.addEventListener('input', () => {
    if (_qrSzFirst) { _qrSzFirst = false; }
    qr.sizeRatio = parseInt(szSlider.value, 10) / 100;
    szVal.textContent = szSlider.value + '%';
    draw();
  });
  szRow.append(szLbl, szSlider, szVal);
  gSz.appendChild(szRow);
  host.appendChild(gSz);
}

function buildPatternControls() {
  const host = document.getElementById('pattern-bg-controls');
  if (!host) return;
  host.innerHTML = '';

  const openBtn = document.createElement('button');
  openBtn.textContent = 'Apri editor pattern';
  openBtn.className = 'upload-btn';
  openBtn.style.cssText = 'width:100%;text-align:center;margin-bottom:8px';
  openBtn.addEventListener('click', openPatternEditor);
  host.appendChild(openBtn);

  if (state.patternBg && state.patternBg.glyphs && state.patternBg.glyphs.length) {
    const filled = state.patternBg.glyphs.filter(g => g && g.trim()).length;
    const total = state.patternBg.gridX * state.patternBg.gridY;
    const info = document.createElement('div');
    info.style.cssText = 'font-size:11px;color:var(--text-muted);text-align:center;margin-bottom:8px';
    info.textContent = `${filled}/${total} celle (${state.patternBg.gridX}×${state.patternBg.gridY})`;
    host.appendChild(info);

    const clearBtn = document.createElement('button');
    clearBtn.textContent = 'Rimuovi pattern';
    clearBtn.style.cssText = 'margin-top:4px;width:100%;padding:6px;background:transparent;border:1px solid var(--danger);color:var(--danger);border-radius:4px;cursor:pointer;font-size:12px';
    clearBtn.addEventListener('click', clearPatternBackground);
    host.appendChild(clearBtn);
  }
}

/* ── Text size sliders (Titolo + Testo) ─────────────── */
function buildTextSizeSliders(host) {
  const sliderHost = host || document.getElementById('size-sliders');
  if (!sliderHost) return;

  const titoloRatio = state.sizeRatio.titolo || CONFIG.typography.titoloSizeRatio;
  [
    { key: 'titolo',    label: 'Titolo',        min: CONFIG.typography.sizeSliderMin, max: CONFIG.typography.sizeSliderMax },
    { key: 'testo',     label: 'Testo',         min: CONFIG.typography.sizeSliderMin, max: Math.min(CONFIG.typography.sizeSliderMax, titoloRatio) },
    { key: 'dataLuogo', label: 'Data e Luogo',  min: 1 / 80,                          max: 1 / 14 },
  ].forEach(({ key, label, min, max }) => {
    const row = document.createElement('div');
    row.className = 'ctrl-slider-row';
    const lbl = document.createElement('span');
    lbl.className = 'ctrl-slider-label';
    lbl.textContent = label;
    const range = document.createElement('input');
    range.type = 'range'; range.className = 'field-range';
    range.style.flex = '1';
    range.min = String(min);
    range.max = String(max);
    range.step = '0.0005';
    range.value = String(state.sizeRatio[key]);
    const val = document.createElement('span');
    val.className = 'ctrl-slider-val';
    const pct = (v) => Math.round(v * 100) + '%';
    val.textContent = pct(Number(range.value));
    let _first = false;
    range.addEventListener('mousedown', () => { _first = true; });
    range.addEventListener('input', () => {
      if (_first) { pushHistory(); _first = false; }
      state.sizeRatio[key] = Number(range.value);
      val.textContent = pct(state.sizeRatio[key]);
      drawSmooth();
    });
    row.append(lbl, range, val);
    sliderHost.appendChild(row);
  });
}

/* ── Rebuild all dynamic UI ────────────────────────────── */
function rebuildDynamic() {
  buildTextSection();
  buildCustomTextSection();
  buildLibraryTabs();
  buildShapeControlsInto(document.getElementById('overlay-controls'));
  buildLogoControls();
  buildPatternControls();
  buildQRControls();
  draw();
}

/* ── Accordion ─────────────────────────────────────────── */
function initAccordions() {
  document.querySelectorAll('.section-header').forEach(header => {
    const body = document.getElementById(header.dataset.target);
    if (!body) return;
    if (body.classList.contains('collapsed')) header.classList.add('collapsed-hd');
    header.addEventListener('click', e => {
      if (e.target.closest('.help-btn')) return;
      // Sfondo Pattern — single click opens editor directly
      if (header.dataset.target === 'section-patternbg-body') {
        openPatternEditor();
        return;
      }
      body.classList.toggle('collapsed');
      header.classList.toggle('collapsed-hd');
    });
  });
}

/* ── Help popover ──────────────────────────────────────── */
let _helpPop = null;
function initHelpButtons() {
  document.querySelectorAll('.help-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (_helpPop && _helpPop._src === btn) { dismissHelp(); return; }
      dismissHelp();
      const pop = document.createElement('div');
      pop.className   = 'help-popover';
      pop.textContent = btn.dataset.tip;
      pop._src = btn;
      document.body.appendChild(pop);
      _helpPop = pop;
      const r = btn.getBoundingClientRect();
      pop.style.top       = (r.top + r.height / 2) + 'px';
      pop.style.left      = (r.right + 10) + 'px';
      pop.style.transform = 'translateY(-50%)';
      requestAnimationFrame(() => {
        const pr = pop.getBoundingClientRect();
        if (pr.right > window.innerWidth - 8)
          pop.style.left = (r.left - pr.width - 10) + 'px';
      });
    });
  });
  document.addEventListener('click', dismissHelp);
}
function dismissHelp() { if (_helpPop) { _helpPop.remove(); _helpPop = null; } }

/* ── Panning ───────────────────────────────────────────── */
function initPan() {
  let dragging = false, sx, sy, ipx, ipy;
  canvasArea.addEventListener('mousedown', e => {
    if (e.target.closest('#left-panel') || e.target.closest('.topbar')) return;
    dragging = true; sx = e.clientX; sy = e.clientY; ipx = panX; ipy = panY;
    e.preventDefault();
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    panX = ipx + (e.clientX - sx);
    panY = ipy + (e.clientY - sy);
    applyTransform();
  });
  window.addEventListener('mouseup', () => { dragging = false; });
}

/* ── Export API (used by export.js) ────────────────────── */
function getCanvas() { return canvas; }
function getState()  { return state; }
function applyImportedState(data) {
  pushHistory();
  Object.assign(state, data);
  state.margins   = { ...data.margins };
  state.content   = { ...data.content };
  state.sizeRatio = { ...data.sizeRatio };
  state.textColors = { ...(data.textColors || {}) };
  state.logos     = (data.logos || []).map(l => ({ ...l }));
  state.letterOverlays = (data.letterOverlays || []).map(o => ({ ...o }));
  state.imageOverlays  = (data.imageOverlays  || []).map(o => ({ ...o }));
  state.patternBg = data.patternBg ? { ...data.patternBg } : null;
  state.imageFilters = { ...(data.imageFilters || {}) };
  canvas.width  = state.canvasW;
  canvas.height = state.canvasH;
  artboard.style.width  = state.canvasW + 'px';
  artboard.style.height = state.canvasH + 'px';
  updateSizeLabel();
  updateSizeButtons();
  rebuildDynamic();
  fitToScreen();
  buildGradientPanel();
  buildBgSolidPicker();
  buildTextSection();
}

/* ── Position grid ─────────────────────────────────────── */
const _posDefs = [
  { v: 'top',    h: 'left',   icon: '↖' },
  { v: 'top',    h: 'center', icon: '↑' },
  { v: 'top',    h: 'right',  icon: '↗' },
  { v: 'mid',    h: 'left',   icon: '←' },
  { v: 'mid',    h: 'center', icon: '◉' },
  { v: 'mid',    h: 'right',  icon: '→' },
  { v: 'bottom', h: 'left',   icon: '↙' },
  { v: 'bottom', h: 'center', icon: '↓' },
  { v: 'bottom', h: 'right',  icon: '↘' },
];

/* ── Letter Library ─────────────────────────────────────── */
function buildLetterGridInto(host) {
  if (!host) return;
  host.innerHTML = '';
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    const btn = document.createElement('button');
    btn.className = 'letter-btn';
    btn.style.fontFamily = "'QSciIcon'";
    btn.textContent = letter;
    btn.addEventListener('click', () => addLetterOverlay(letter));
    host.appendChild(btn);
  }
}

function buildLetterGrid() { buildLetterGridInto(document.getElementById('letter-grid')); }

function addLetterOverlay(letter) {
  pushHistory();
  const id = ++_overlayIdCounter;
  state.letterOverlays.push({
    id, letter,
    x:         Math.round(state.canvasW / 2),
    y:         Math.round(state.canvasH / 2),
    sizeRatio: 0.4,
    color:     CONFIG.palette[6].hex, // Nero
    opacity:   1,
    font:      'QSciIcon',
  });
  state.selectedOverlayId = id;
  buildLetterControls();
  draw();
}

function buildLetterControls() {
  const host = document.getElementById('overlay-controls');
  if (!host) return;

  const ov = state.letterOverlays.find(o => o.id === state.selectedOverlayId);
  if (!ov) {
    host.innerHTML = state.letterOverlays.length
      ? '<p class="overlay-hint">Clicca su una lettera nel canvas per modificarla.</p>'
      : '';
    return;
  }

  host.innerHTML = '';

  const hdr = document.createElement('div');
  hdr.className = 'overlay-hdr';
  hdr.textContent = `Lettera: ${ov.letter}`;
  host.appendChild(hdr);

  // Color — dropdown button (same pattern as bg/text colors)
  buildColorButton(host, {
    id: 'letter-color',
    label: 'Colore',
    currentHex: ov.color,
    onChange: hex => { pushHistory(); ov.color = hex; draw(); },
  });

  // Size slider
  const sizeRow = document.createElement('div');
  sizeRow.className = 'slider-row';
  const sizeLbl = document.createElement('label');
  sizeLbl.className = 'field-label';
  sizeLbl.textContent = 'Dimensione';
  const sizeSlider = document.createElement('input');
  sizeSlider.type = 'range';
  sizeSlider.className = 'field-range';
  sizeSlider.min = '0.02'; sizeSlider.max = '2'; sizeSlider.step = '0.01';
  sizeSlider.value = String(ov.sizeRatio);
  let _szFirst = false;
  sizeSlider.addEventListener('mousedown', () => { _szFirst = true; });
  sizeSlider.addEventListener('input', () => {
    if (_szFirst) { pushHistory(); _szFirst = false; }
    ov.sizeRatio = Number(sizeSlider.value);
    drawSmooth();
  });
  sizeRow.append(sizeLbl, sizeSlider);
  host.appendChild(sizeRow);

  // Delete button
  const delBtn = document.createElement('button');
  delBtn.textContent = 'Rimuovi lettera';
  delBtn.className = 'overlay-del-btn';
  delBtn.addEventListener('click', () => {
    pushHistory();
    state.letterOverlays = state.letterOverlays.filter(o => o.id !== state.selectedOverlayId);
    state.selectedOverlayId = null;
    buildLetterControls();
    draw();
  });
  host.appendChild(delBtn);
}

/* ── Canvas ↔ client coordinate conversion ─────────────── */
// Optional `rect` lets callers (drag handlers) snapshot the canvas bounding
// rect once at drag start and reuse it for every mousemove — that way layout
// shifts mid-drag (sidebar reflow, font load, etc.) can't make the icon jump.
function clientToCanvas(clientX, clientY, rect) {
  const r = rect || canvas.getBoundingClientRect();
  // Guard against zero-sized rect (canvas not yet laid out)
  if (!r.width || !r.height) return { x: 0, y: 0 };
  return {
    x: (clientX - r.left) * (canvas.width  / r.width),
    y: (clientY - r.top)  * (canvas.height / r.height),
  };
}

/* ── Overlay drag (letters + images) ───────────────────── */
function initOverlayDrag() {
  let dragging = false, dragOv = null;
  let startPt, startOvX, startOvY;
  let dragRect = null;  // canvas bounding rect snapshot, frozen for the drag
  let _rafId = null;

  canvas.addEventListener('mousedown', e => {
    // Capture the rect once, BEFORE any DOM mutation (buildLetterControls
    // below) that could trigger a reflow and shift the canvas.
    const rect = canvas.getBoundingClientRect();
    const pt = clientToCanvas(e.clientX, e.clientY, rect);

    // Letters first — highest z-order
    for (let i = state.letterOverlays.length - 1; i >= 0; i--) {
      const ov = state.letterOverlays[i];
      const half = Math.round((ov.sizeRatio || 0.4) * state.canvasW) / 2;
      if (Math.abs(pt.x - ov.x) < half && Math.abs(pt.y - ov.y) < half) {
        pushHistory();
        state.selectedOverlayId = ov.id;
        dragging = true; dragOv = ov;
        startPt = pt; startOvX = ov.x; startOvY = ov.y;
        dragRect = rect;
        // Build controls AFTER capturing the rect/startPt so any reflow this
        // causes can't desync the drag math.
        buildLetterControls();
        updateOverlayOutline();
        e.stopPropagation(); e.preventDefault();
        return;
      }
    }

    // No hit — deselect letter
    if (state.selectedOverlayId !== null) {
      state.selectedOverlayId = null;
      buildLetterControls();
      updateOverlayOutline();
    }
  });

  window.addEventListener('mousemove', e => {
    if (!dragging || !dragOv) return;
    const pt = clientToCanvas(e.clientX, e.clientY, dragRect);
    dragOv.x = startOvX + (pt.x - startPt.x);
    dragOv.y = startOvY + (pt.y - startPt.y);
    // Move the DOM outline synchronously for instant feedback — the canvas
    // SVG redraw is rAF-throttled below.
    updateOverlayOutline();
    if (_rafId) cancelAnimationFrame(_rafId);
    _rafId = requestAnimationFrame(() => { _rafId = null; _draw(); });
  });

  window.addEventListener('mouseup', () => {
    if (dragging && _rafId) {
      cancelAnimationFrame(_rafId);
      _rafId = null;
      _draw(); // ensure final position is committed to the canvas
    }
    dragging = false; dragOv = null; dragRect = null;
  });
}

/* ── Sidebar resize ───────────────────────────────────── */
function initSidebarResize() {
  const handle = document.getElementById('sidebar-resize-handle');
  const panel = document.getElementById('left-panel');
  if (!handle || !panel) return;
  let dragging = false, startX, startW;
  handle.addEventListener('mousedown', e => {
    dragging = true; startX = e.clientX;
    startW = panel.offsetWidth;
    e.preventDefault();
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    const newW = Math.max(200, Math.min(500, startW + (e.clientX - startX)));
    panel.style.width = newW + 'px';
    _lsSet('sidebar_width', String(newW));
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
  // Restore saved width
  const saved = _lsGet('sidebar_width');
  if (saved) {
    const w = parseInt(saved, 10);
    if (!isNaN(w) && w > 0) panel.style.width = w + 'px';
  }
}

/* ── Boot ──────────────────────────────────────────────── */
(async () => {
  const overlay = document.getElementById('loading-overlay');

  try {
    await preloadFont();
  } catch (e) {
    console.warn('[Font] preload error:', e);
  }

  // Default logo
  try {
    const defaultLogo = await preloadDefaultLogo();
    if (defaultLogo) {
      state.logos.push({ id: ++_logoIdCounter, dataURL: defaultLogo.dataURL, aspectRatio: defaultLogo.aspectRatio, opacity: 1, isDefault: true, align: undefined, color: '#302d2e', visible: false });
    }
  } catch (e) {
    console.warn('[Logo] preload error:', e);
  }

  setPageSize('a4');

  buildGradientPanel();
  buildBgSolidPicker();
  buildTextSection();

  rebuildDynamic();

  // Seed the undo stack with the initial clean state
  pushHistory();

  // Format buttons
  document.querySelectorAll('.size-switch-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      if (id === 'custom') {
        document.getElementById('custom-size-row').classList.toggle('visible');
        return;
      }
      if (id) {
        document.getElementById('custom-size-row').classList.remove('visible');
        pushHistory();
        setPageSize(id);
      }
    });
  });

  document.getElementById('btn-apply-custom').addEventListener('click', () => {
    const w = parseInt(document.getElementById('custom-w').value, 10);
    const h = parseInt(document.getElementById('custom-h').value, 10);
    if (!w || !h || w < 10 || h < 10 || w > 2000 || h > 2000) {
      alert('Dimensioni non valide (10–2000 mm).');
      return;
    }
    document.getElementById('custom-size-row').classList.remove('visible');
    pushHistory();
    setPageSize('custom', w, h);
  });

  // Zoom
  document.getElementById('zoom-in').addEventListener('click',  () => setZoom(zoomFactor + 0.1));
  document.getElementById('zoom-out').addEventListener('click', () => setZoom(zoomFactor - 0.1));
  document.getElementById('zoom-fit').addEventListener('click', fitToScreen);
  window.addEventListener('resize', fitToScreen);

  // Undo / Redo buttons + keyboard shortcuts
  const undoBtn = document.getElementById('btn-undo');
  if (undoBtn) undoBtn.addEventListener('click', undo);
  const redoBtn = document.getElementById('btn-redo');
  if (redoBtn) redoBtn.addEventListener('click', redo);

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') {
      e.preventDefault();
      undo();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
      e.preventDefault();
      redo();
    }
    // Backspace / Delete — remove selected item when not in an input
    if ((e.key === 'Backspace' || e.key === 'Delete') && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA' && !e.target.isContentEditable) {
      if (state.selectedOverlayId != null) {
        e.preventDefault(); pushHistory();
        state.letterOverlays = state.letterOverlays.filter(o => o.id !== state.selectedOverlayId);
        state.selectedOverlayId = null;
        buildLetterControls(); draw();
      } else if (state.selectedShapeId != null) {
        e.preventDefault(); pushHistory();
        state.shapes = state.shapes.filter(s => s.id !== state.selectedShapeId);
        state.selectedShapeId = null;
        buildLibraryTabs(); buildShapeControlsInto(document.getElementById('overlay-controls')); draw();
      } else if (state.selectedLogoId != null) {
        e.preventDefault(); pushHistory();
        state.logos = state.logos.filter(l => l.id !== state.selectedLogoId);
        state.selectedLogoId = null;
        buildLogoControls(); draw();
      }
    }
  });

  // Logo import — file input
  const addLogoInput = document.getElementById('add-logo-input');
  if (addLogoInput) {
    addLogoInput.addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const url = await blobToDataURL(file);
        const aspectRatio = await new Promise((resolve, reject) => {
          const img = new Image();
          img.onload  = () => resolve(img.naturalHeight / img.naturalWidth);
          img.onerror = reject;
          img.src = url;
        });
        pushHistory();
        const id = ++_logoIdCounter;
        state.logos.push({
          id,           dataURL: url,
          aspectRatio,
          opacity: 1,
          name: file.name,
          align: undefined,
          color: url.startsWith('data:image/svg') ? '#302d2e' : undefined,
        });
        state.selectedLogoId = id;
        buildLogoControls();
        draw();
      } catch { alert('Logo non valido.'); }
      e.target.value = '';
    });
  }

  // Pattern background generate button — build controls dynamically
  buildPatternControls();

  // Pattern clear button

  initOverlayDrag();
  initAccordions();
  initHelpButtons();
  initPan();
  initSidebarResize();

  if (overlay) overlay.remove();

  /* ── Export Logging ──────────────────────────────────── */
  // localStorage cap: state can be large (image overlays, custom backgrounds).
  // Aggressive limit so we don't bump the per-origin quota.
  const LOGS_LIMIT = 30;

  window.logExport = function logExport(format) {
    // ExportManager exposes the same snapshot used by JSON export, so dashboard
    // entries can be re-imported with full fidelity.
    const fullState = (window.ExportManager && typeof window.ExportManager.collectState === 'function')
      ? window.ExportManager.collectState()
      : null;

    const entry = {
      id: Date.now() + '-' + Math.floor(Math.random() * 1000),
      timestamp: new Date().toISOString(),
      format: format,
      title: (state.content.titolo || state.content.frase || 'Senza Titolo'),
      sizeId: state.sizeId,
      state: fullState,
    };

    // localStorage — primary store. Survives without a backend (works on GitHub Pages).
    try {
      const raw = _lsGet('poster_logs');
      const logs = raw ? JSON.parse(raw) : [];
      const safeLogs = Array.isArray(logs) ? logs : [];
      safeLogs.unshift(entry);
      _lsSet('poster_logs', JSON.stringify(safeLogs.slice(0, LOGS_LIMIT)));
    } catch (e) {
      // Quota exceeded? Drop state and retry with metadata only.
      try {
        const slim = { ...entry, state: null };
        const raw = _lsGet('poster_logs');
        const logs = raw ? JSON.parse(raw) : [];
        const safeLogs = Array.isArray(logs) ? logs : [];
        safeLogs.unshift(slim);
        _lsSet('poster_logs', JSON.stringify(safeLogs.slice(0, LOGS_LIMIT)));
      } catch (e2) { console.warn('[logExport] localStorage write failed:', e2); }
    }

    // Server (fire-and-forget). save_log.php now accepts the optional state field.
    try {
      fetch('save_log.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry)
      }).catch(() => {});
    } catch (e) { /* server not available */ }

    // GitHub archive (fire-and-forget). Only runs if a token is configured in
    // localStorage via /setup.html. The token never leaves this browser; it is
    // sent only to api.github.com. No-op for other visitors.
    try { commitEntryToGitHub(entry); } catch (e) { /* ignore */ }
  };

  function _utf8ToBase64(str) {
    // btoa() can't handle non-Latin1 chars; encode as UTF-8 first.
    return btoa(unescape(encodeURIComponent(str)));
  }
  function _slugForFile(s) {
    return String(s || 'untitled')
      .normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'untitled';
  }
  async function commitEntryToGitHub(entry) {
    const token = _lsGet('gh_token');
    if (!token) return; // no token → silent no-op
    const owner  = 'LucaTommy';
    const repo   = 'Luce';
    const branch = 'master';
    const ts     = (entry.timestamp || new Date().toISOString()).replace(/[:.]/g, '-');
    const slug   = _slugForFile(entry.title);
    const fmt    = (entry.format || 'json').toLowerCase();
    const path   = `files/${ts}__${fmt}__${slug}.json`;
    const body   = {
      message: `archive: ${entry.title || 'Senza Titolo'} (${fmt})`,
      content: _utf8ToBase64(JSON.stringify(entry, null, 2)),
      branch,
    };
    try {
      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`,
        {
          method:  'PUT',
          headers: {
            'Authorization': `token ${token}`,
            'Accept':        'application/vnd.github+json',
            'Content-Type':  'application/json',
          },
          body: JSON.stringify(body),
        }
      );
      if (!res.ok) {
        const txt = await res.text();
        console.warn('[archive-gh] failed', res.status, txt);
      }
    } catch (e) {
      console.warn('[archive-gh] error:', e);
    }
  }

  window.__posterApp = { getCanvas, getState, applyImportedState };
})();
