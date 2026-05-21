/* export.js — PNG, PDF, JSON export + JSON import */

const ExportManager = (() => {

  function init() {
    const dropBtn = document.getElementById('btn-export');
    const menu    = document.getElementById('export-menu');

    dropBtn.addEventListener('click', e => {
      e.stopPropagation();
      menu.classList.toggle('open');
    });
    document.addEventListener('click', () => menu.classList.remove('open'));

    menu.querySelectorAll('button[data-format]').forEach(btn => {
      btn.addEventListener('click', () => {
        menu.classList.remove('open');
        exportAs(btn.dataset.format);
      });
    });

    document.getElementById('import-json-input').addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        try {
          importState(JSON.parse(ev.target.result));
        } catch {
          alert('File JSON non valido.');
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    });
  }

  function app() { return window.__posterApp; }

  function exportAs(format) {
    if (format === 'json') exportJson();
    if (format === 'png')  exportPng();
    if (format === 'pdf')  exportPdf();
  }

  /* Build the importable poster snapshot. Shared by JSON export and the
     dashboard log payload so both can be re-imported via importState(). */
  function collectState() {
    const s = app().getState();
    return {
      version:             1,
      sizeId:              s.sizeId,
      wMM:                 s.wMM,
      hMM:                 s.hMM,
      canvasW:             s.canvasW,
      canvasH:             s.canvasH,
      margins:             { ...s.margins },
      bgColor:             s.bgColor,
      bgGradient:          s.bgGradient,
      content:             { ...s.content },
      dataLuogoPlacement:  s.dataLuogoPlacement,
      dataLuogoSwap:       s.dataLuogoSwap,
      dataLuogoFlex:       s.dataLuogoFlex,
      titoloPos:           s.titoloPos,
      testoFlex:           s.testoFlex,
      titoloLH:            s.titoloLH,
      fontWeight:          s.fontWeight,
      textColors:          { ...(s.textColors || {}) },
      sizeRatio:           { ...s.sizeRatio },
      customTexts:         (s.customTexts || []).map(ct => ({ ...ct, placement: { ...ct.placement } })),
      shapes:              (s.shapes || []).map(sh => ({ ...sh, gradient: sh.gradient ? { ...sh.gradient } : null })),
      logos:               (s.logos || []).map(l => ({ ...l })),
      logosSizeLinked:     !!s.logosSizeLinked,
      letterOverlays:      (s.letterOverlays || []).map(o => ({ ...o })),
      imageOverlays:       (s.imageOverlays || []).map(o => ({ ...o })),
      patternBg:           s.patternBg ? { ...s.patternBg } : null,
      userBgDataURL:       s.userBgDataURL || null,
      imageFilters:        { ...(s.imageFilters || {}) },
    };
  }

  /* ── JSON ──────────────────────────────────────────── */
  function exportJson() {
    const data = collectState();
    downloadBlob(
      new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      buildExportFilename('json')
    );
    logExport('json');
  }

  function importState(data) {
    if (!data || data.version !== 1) {
      alert('Formato JSON non supportato.');
      return;
    }
    app().applyImportedState({
      sizeId:              data.sizeId         || 'a4',
      wMM:                 data.wMM            || 210,
      hMM:                 data.hMM            || 297,
      canvasW:             data.canvasW        || 2480,
      canvasH:             data.canvasH        || 3508,
      margins:             data.margins        || { top: 240, right: 200, bottom: 240, left: 200 },
      bgColor:             data.bgColor        || '#f6f5ee',
      bgGradient:          data.bgGradient     || null,
      content:             { data: '', luogo: '', titolo: '', testo: '', ...data.content },
      dataLuogoPlacement:  data.dataLuogoPlacement || 'top-left',
      dataLuogoSwap:       data.dataLuogoSwap      || false,
      dataLuogoFlex:       data.dataLuogoFlex      || false,
      titoloPos:           data.titoloPos          || 'mid',
      testoFlex:           data.testoFlex          || false,
      titoloLH:            data.titoloLH           || 'normal',
      fontWeight:          data.fontWeight         || 'regular',
      textColors:          data.textColors || { title: '#302d2e', date: '#302d2e', testo: '#302d2e' },
      sizeRatio:           {
        titolo:    CONFIG.typography.titoloSizeRatio,
        testo:     CONFIG.typography.testoSizeRatio,
        dataLuogo: CONFIG.typography.dataLuogoSizeRatio,
        ...data.sizeRatio,
      },
      customTexts:         data.customTexts    || [],
      shapes:              data.shapes         || [],
      logos:               data.logos          || [],
      logosSizeLinked:     !!data.logosSizeLinked,
      letterOverlays:      data.letterOverlays || [],
      imageOverlays:       data.imageOverlays  || [],
      patternBg:           data.patternBg      || null,
      userBgDataURL:       data.userBgDataURL  || null,
      imageFilters:        data.imageFilters   || {},
    });
  }

  /* ── PNG ───────────────────────────────────────────── */
  function exportPng() {
    const canvas = app().getCanvas();
    canvas.toBlob(blob => downloadBlob(blob, buildExportFilename('png')), 'image/png');
    logExport('png');
  }

  /* ── PDF ───────────────────────────────────────────── */
  function exportPdf() {
    const canvas = app().getCanvas();
    const s      = app().getState();
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({
      orientation: s.wMM >= s.hMM ? 'landscape' : 'portrait',
      unit:        'mm',
      format:      [s.wMM, s.hMM],
    });
    doc.addImage(canvas.toDataURL('image/jpeg', 0.95), 'JPEG', 0, 0, s.wMM, s.hMM);
    doc.save(buildExportFilename('pdf'));
    logExport('pdf');
  }

  /* ── Util ──────────────────────────────────────────── */
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // Build a title+timestamp filename for exports. Sanitizes the title for use
  // as a filename (Windows-friendly) and falls back to "poster" if empty.
  function buildExportFilename(ext) {
    const s = app().getState();
    const raw = (s.content.titolo || s.content.frase || s.content.testo || 'poster');
    const safe = String(raw).replace(/[/\\?%*:|"<>]/g, '-').trim().slice(0, 64) || 'poster';
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    return `${safe}_${stamp}.${ext}`;
  }

  return { init, collectState, buildExportFilename };
})();

// Expose so logExport (in app.js) can grab the same state-collection helper
// that the JSON export uses.
window.ExportManager = ExportManager;

document.addEventListener('DOMContentLoaded', () => {
  // Wait for app module to expose __posterApp, then init
  const tryInit = () => {
    if (window.__posterApp) { ExportManager.init(); }
    else setTimeout(tryInit, 50);
  };
  tryInit();
});
