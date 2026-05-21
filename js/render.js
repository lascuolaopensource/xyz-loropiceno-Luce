/* render.js — SVG poster builder */

function buildSVG(state) {
  const { canvasW: W, canvasH: H, margins, bgColor, bgGradient,
          userBgDataURL } = state;

  const letterOverlays = state.letterOverlays || [];
  const imageOverlays  = state.imageOverlays  || [];
  const imageFilters   = state.imageFilters   || {};
  const customTexts    = state.customTexts    || [];
  const shapes         = state.shapes         || [];
  const logos          = state.logos          || [];
  const patternBg      = state.patternBg      || null;

  const contentW = W - margins.left - margins.right;
  const contentH = H - margins.top - margins.bottom;
  const CX = Math.round(W / 2); // canvas center X

  // ── Text state ──
  const cnt     = state.content   || {};
  const tc      = state.textColors || {};
  const tcTitle = tc.title  || CONFIG.text.defaultColor;
  const tcDate  = tc.date   || CONFIG.text.defaultColor;
  const tcTesto = tc.testo  || CONFIG.text.defaultColor;
  const sr      = state.sizeRatio  || {};
  const tiFont = state.fontWeight === 'black' ? 'QSci Black' : 'QSci';

  // ── Font sizes ──
  const fsDataLuogo = Math.round(W * (sr.dataLuogo || CONFIG.typography.dataLuogoSizeRatio));
  const fsTitolo    = Math.round(W * (sr.titolo || CONFIG.typography.titoloSizeRatio) * (state.fontWeight === 'black' ? 1.18 : 1));
  const fsTesto     = Math.min(
    Math.round(W * (sr.testo  || CONFIG.typography.testoSizeRatio)),
    Math.round(fsTitolo * 0.55)
  );

  // Line-heights
  const titoloLH = (state.titoloLH || 'normal') === 'modified'
    ? fsTitolo * CONFIG.typography.titoloLHModified
    : fsTitolo * CONFIG.typography.titoloLHNormal;
  const testoLine  = Math.round(fsTesto * CONFIG.typography.testoLineHeight);
  const dataLuogoGap = Math.round(W * CONFIG.typography.dataTitoloGap);

  // ── Build Data + Luogo text ──
  const rawData  = (cnt.data  || '').trim();
  const rawLuogo = (cnt.luogo || '').trim();
  const swapped  = state.dataLuogoSwap;
  const dlFlex   = state.dataLuogoFlex;

  let dlBlockH = 0;
  let dlLines = [];         // joined mode (non-flex)
  let dlAnchor = 'start', dlBX = margins.left;

  // Flex mode: data and luogo as separate text elements at opposite corners
  let flexDataLines = [], flexLuogoLines = [];

  if (dlFlex) {
    // Which goes left, which goes right? (swap flips)
    const leftLabel  = swapped ? rawLuogo : rawData;
    const rightLabel = swapped ? rawData  : rawLuogo;
    const halfW = Math.floor(contentW / 2) - 40; // split width with gap
    flexDataLines  = leftLabel  ? wrapWithHardBreaks(leftLabel.toUpperCase(), halfW, 'Ronzino', fsDataLuogo, '400', null) : [];
    flexLuogoLines = rightLabel ? wrapWithHardBreaks(rightLabel.toUpperCase(), halfW, 'Ronzino', fsDataLuogo, '400', null) : [];
    dlBlockH = Math.max(flexDataLines.length, flexLuogoLines.length) * Math.round(fsDataLuogo * 1.1);
  } else {
    // Joined mode: original behavior
    const dlPairs = [];
    if (swapped) {
      if (rawLuogo) dlPairs.push(rawLuogo.toUpperCase());
      if (rawData)  dlPairs.push(rawData.toUpperCase());
    } else {
      if (rawData)  dlPairs.push(rawData.toUpperCase());
      if (rawLuogo) dlPairs.push(rawLuogo.toUpperCase());
    }
    const dlText = dlPairs.join(' · ');
    dlLines = dlText
      ? wrapWithHardBreaks(dlText, contentW, 'Ronzino', fsDataLuogo, '400', null)
      : [];
    dlBlockH = dlLines.length ? dlLines.length * Math.round(fsDataLuogo * 1.1) : 0;

    // Horizontal position for non-flex mode
    const dlPlacement = state.dataLuogoPlacement || 'top-left';
    if (dlPlacement === 'top-left')       { dlAnchor = 'start';  dlBX = margins.left; }
    else if (dlPlacement === 'top-right') { dlAnchor = 'end';    dlBX = W - margins.right; }
    else                                   { dlAnchor = 'middle'; dlBX = CX; }
  }
  const titoloLines = (cnt.titolo || '')
    ? wrapWithHardBreaks(cnt.titolo.toUpperCase(), contentW, tiFont, fsTitolo, '400', null)
    : [];
  const titoloBlockH = titoloLines.length ? titoloLines.length * titoloLH : 0;

  const testoLines = (cnt.testo || '')
    ? wrapWithHardBreaks(cnt.testo, contentW, 'Ronzino', fsTesto, '400', null)
    : [];
  const testoBlockH = testoLines.length ? testoLines.length * testoLine : 0;

  // Vertical positions
  let titoloTop, testoTop;

  if (state.titoloPos === 'under-data') {
    // Titolo sits right below Data+Luogo row at the top
    titoloTop = margins.top + dlBlockH + (dlBlockH ? dataLuogoGap : 0);
  } else {
    // Titolo vertically centered (mid)
    const aboveTi = dlBlockH + (dlBlockH ? dataLuogoGap : 0);
    const belowTi = testoBlockH + (testoBlockH ? dataLuogoGap : 0);
    const avail   = contentH - aboveTi - belowTi;
    titoloTop = margins.top + aboveTi + Math.max(0, (avail - titoloBlockH) / 2);
  }

  // Testo always below Titolo
  const gapAfterTi = state.testoFlex
    ? Math.max(dataLuogoGap, contentH - (titoloTop + titoloBlockH - margins.top) - testoBlockH)
    : dataLuogoGap;
  testoTop = titoloTop + titoloBlockH + (testoBlockH ? gapAfterTi : 0);

  // ── Begin SVG ──
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);

  // Gradient defs (bg + shapes)
  let gradDefs = '';
  let gradIdx = 0;

  if (bgGradient) {
    const a = ((bgGradient.angle ?? 90) * Math.PI) / 180;
    const x1 = (50 - 50 * Math.sin(a)).toFixed(1);
    const y1 = (50 + 50 * Math.cos(a)).toFixed(1);
    const x2 = (50 + 50 * Math.sin(a)).toFixed(1);
    const y2 = (50 - 50 * Math.cos(a)).toFixed(1);
    const balance = bgGradient.balance ?? 50;
    gradDefs += `
  <linearGradient id="bgGrad" x1="${x1}%" y1="${y1}%" x2="${x2}%" y2="${y2}%">
    <stop offset="0%" stop-color="${bgGradient.from}"/>
    <stop offset="${balance}%" stop-color="${bgGradient.from}"/>
    <stop offset="100%" stop-color="${bgGradient.to}"/>
  </linearGradient>`;
  }

  const shapeGradIds = new Map();
  for (let si = 0; si < shapes.length; si++) {
    const s = shapes[si];
    if (s.gradient) {
      const gid = `sGrad${gradIdx}`;
      shapeGradIds.set(si, gid);
      gradIdx++;
      const offset = s.gradient.offset || '85%';
      gradDefs += `
  <linearGradient id="${gid}" x1="0%" y1="0%" x2="100%" y2="0%">
    <stop offset="0%" stop-color="${s.gradient.from}"/>
    <stop offset="${offset}" stop-color="${s.gradient.from}"/>
    <stop offset="100%" stop-color="${s.gradient.to}"/>
  </linearGradient>`;
    }
  }

  // Image filter defs
  const imageFilterDefs = [];
  const imgFilterMap = new Map();
  for (let i = 0; i < imageOverlays.length; i++) {
    const ov = imageOverlays[i];
    const f = imageFilters[ov.id];
    if (f && (f.brightness !== 1 || f.contrast !== 1 || f.saturation !== 1 || f.blur > 0 || f.grayscale)) {
      const fid = `imgFilt${i}`;
      imgFilterMap.set(i, fid);
      const br = f.brightness ?? 1;
      const ct = f.contrast   ?? 1;
      const st = f.saturation  ?? 1;
      const bl = f.blur || 0;
      const gr = f.grayscale ? 1 : 0;
      const lr = 0.213, lg = 0.715, lb = 0.072;
      const m11 = (st * (1 - gr) + lr * gr) * ct * br;
      const m12 = lg * gr * ct * br;
      const m13 = lb * gr * ct * br;
      const m21 = lr * gr * ct * br;
      const m22 = (st * (1 - gr) + lg * gr) * ct * br;
      const m23 = lb * gr * ct * br;
      const m31 = lr * gr * ct * br;
      const m32 = lg * gr * ct * br;
      const m33 = (st * (1 - gr) + lb * gr) * ct * br;
      imageFilterDefs.push(`  <filter id="${fid}" x="-20%" y="-20%" width="140%" height="140%">
    ${bl > 0 ? `<feGaussianBlur stdDeviation="${bl}" result="blur"/>` : ''}
    <feColorMatrix type="matrix" values="${m11.toFixed(4)} ${m12.toFixed(4)} ${m13.toFixed(4)} 0 0  ${m21.toFixed(4)} ${m22.toFixed(4)} ${m23.toFixed(4)} 0 0  ${m31.toFixed(4)} ${m32.toFixed(4)} ${m33.toFixed(4)} 0 0  0 0 0 1 0"/>
  </filter>`);
    }
  }

  const fontCSS = getFontFaceCSS();
  parts.push(`<style><![CDATA[\n${fontCSS}\n]]></style>`);

  parts.push(`<defs>
  <clipPath id="cc">
    <rect x="${margins.left}" y="${margins.top}" width="${contentW}" height="${contentH}"/>
  </clipPath>${gradDefs}${imageFilterDefs.length ? '\n' + imageFilterDefs.join('\n') : ''}
</defs>`);

  // Background
  const bgFill = bgGradient ? 'url(#bgGrad)' : bgColor;
  parts.push(`<rect width="100%" height="100%" fill="${bgFill}"/>`);
  if (userBgDataURL) {
    parts.push(`<image href="${userBgDataURL}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/>`);
  }

  // Pattern background — grid of icon glyphs (behind all other content)
  if (patternBg && patternBg.glyphs && patternBg.glyphs.length) {
    const gx = patternBg.gridX || 8;
    const gy = patternBg.gridY || 10;
    const pColor = patternBg.color || CONFIG.palette[6].hex;
    const cellW = W / gx;
    const cellH = H / gy;

    for (let i = 0; i < patternBg.glyphs.length; i++) {
      const icon = patternBg.glyphs[i];
      if (!icon || !icon.trim()) continue;
      const row = Math.floor(i / gx);
      const col = i % gx;
      if (row >= gy) break;
      const cx = Math.round(col * cellW + cellW / 2);
      const cy = Math.round(row * cellH + cellH / 2);
      const sz = Math.round(Math.min(cellW, cellH) * 0.75);

      parts.push(`<text font-family="'QSciIcon'" font-size="${sz}" fill="${pColor}" fill-opacity="1" text-anchor="middle" dominant-baseline="central" x="${cx}" y="${cy}">${escapeXML(icon)}</text>`);
    }
  }

  // Shapes
  for (let si = 0; si < shapes.length; si++) {
    const s = shapes[si];
    if (s.visible === false) continue;
    const sx = Math.round(s.x), sy = Math.round(s.y);
    const gradId = shapeGradIds.get(si);
    const fill = gradId ? `url(#${gradId})` : (s.color || '#302d2e');
    const opacity = s.opacity ?? 1;
    const rotation = s.rotation || 0;
    const blend = (s.blend && s.blend !== 'normal') ? ` style="mix-blend-mode:${s.blend}"` : '';

    let shapeTag = '';
    if (s.type === 'circle') {
      const r = Math.round((s.size || 100) / 2);
      shapeTag = `<circle cx="${sx}" cy="${sy}" r="${r}" fill="${fill}" fill-opacity="${opacity}"${blend}${rotation ? ` transform="rotate(${rotation} ${sx} ${sy})"` : ''}/>`;
    } else if (s.type === 'square') {
      const sz = s.size || 100;
      const ox = sx - Math.round(sz / 2), oy = sy - Math.round(sz / 2);
      shapeTag = `<rect x="${ox}" y="${oy}" width="${sz}" height="${sz}" fill="${fill}" fill-opacity="${opacity}"${blend}${rotation ? ` transform="rotate(${rotation} ${sx} ${sy})"` : ''}/>`;
    } else if (s.type === 'rectangle') {
      const rw = s.size || 180, rh = Math.round(rw / (s.aspectRatio || 1.5));
      const ox = sx - Math.round(rw / 2), oy = sy - Math.round(rh / 2);
      shapeTag = `<rect x="${ox}" y="${oy}" width="${rw}" height="${rh}" fill="${fill}" fill-opacity="${opacity}"${blend}${rotation ? ` transform="rotate(${rotation} ${sx} ${sy})"` : ''}/>`;
    }
    if (shapeTag) parts.push(shapeTag);
  }

  // Image overlays
  for (let i = 0; i < imageOverlays.length; i++) {
    const ov = imageOverlays[i];
    if (ov.visible === false) continue;
    const iw = Math.round((ov.sizeRatio || 0.3) * W);
    const ih = Math.round(iw * (ov.aspectRatio || 1));
    const ix = Math.round(ov.x - iw / 2);
    const iy = Math.round(ov.y - ih / 2);
    const fid = imgFilterMap.get(i);
    const filterAttr = fid ? ` filter="url(#${fid})"` : '';
    parts.push(`<image href="${ov.dataURL}" x="${ix}" y="${iy}" width="${iw}" height="${ih}" opacity="${ov.opacity ?? 1}" preserveAspectRatio="xMidYMid meet"${filterAttr}/>`);
  }

  // Logos — auto-placed along bottom edge
  {
    const visibleLogos = logos.filter(l => l.dataURL && l.visible !== false);
    const margin = Math.round(W * 0.03);
    const availableW = W - margin * 2;

    // Per-logo height (each logo can have its own sizeRatio relative to min(W,H))
    const logoHeights = visibleLogos.map(l =>
      Math.round(Math.min(W, H) * (l.sizeRatio || CONFIG.typography.logoHeightRatio || 0.072))
    );
    const logoWidths = visibleLogos.map((l, i) => Math.round(logoHeights[i] / (l.aspectRatio || 1)));

    for (let i = 0; i < visibleLogos.length; i++) {
      const logo = visibleLogos[i];
      const lh = logoHeights[i];
      const lw = logoWidths[i];
      let lx;
      if (logo.align === 'left') {
        lx = margin;
      } else if (logo.align === 'center') {
        lx = Math.round((W - lw) / 2);
      } else if (logo.align === 'right') {
        lx = W - lw - margin;
      } else {
        // Auto-distribute (legacy behavior)
        if (visibleLogos.length === 1) {
          lx = margin;
        } else if (i === 0) {
          lx = margin;
        } else if (i === visibleLogos.length - 1) {
          lx = W - lw - margin;
        } else {
          lx = Math.round(margin + (availableW - lw) * i / (visibleLogos.length - 1));
        }
      }
      // Bottom-align each logo so different sizes share the same baseline
      const ly = H - lh - margin;
      // Apply SVG recolor if color is set
      let src = logo.dataURL;
      if (logo.color && src && src.startsWith('data:image/svg')) {
        src = recolorSVG(src, logo.color);
      }
      parts.push(`<image href="${src}" x="${lx}" y="${ly}" width="${lw}" height="${lh}" opacity="${logo.opacity ?? 1}" preserveAspectRatio="xMidYMid meet"/>`);
    }
  }

  // QR code — placement adapts to testoFlex so it never falls off the page
  {
    const qr = state.qrParams;
    if (qr && qr.url && typeof generateQRCode === 'function') {
      try {
        const qrSize = Math.round(W * (qr.sizeRatio || 0.1));
        const qrColor = qr.qrColor || '#000000';
        const qrDataURL = generateQRCode(qr.url, qrSize, qrColor);
        if (qrDataURL && qrDataURL.startsWith('data:')) {
          let qx, qy;
          // Horizontal
          if (qr.hAlign === 'left') qx = margins.left;
          else if (qr.hAlign === 'right') qx = W - margins.right - qrSize;
          else qx = Math.round((W - qrSize) / 2);

          const gap = Math.round(W * 0.02);
          const visibleLogosForQR = logos.filter(l => l.dataURL && l.visible !== false);
          const maxLogoRatio = visibleLogosForQR.length
            ? Math.max(...visibleLogosForQR.map(l => l.sizeRatio || CONFIG.typography.logoHeightRatio || 0.072))
            : 0;
          const logoAreaH = visibleLogosForQR.length
            ? Math.round(Math.min(W, H) * maxLogoRatio) + Math.round(W * 0.03)
            : 0;
          const bottomY = H - qrSize - margins.bottom - logoAreaH;
          const belowTesto = testoTop + testoBlockH + gap;

          if (state.testoFlex && testoBlockH > 0) {
            // Testo is pinned to the bottom — placing QR below it would push it off
            // the page, so put it ABOVE the testo block instead.
            const aboveTesto = testoTop - qrSize - gap;
            qy = Math.max(margins.top, aboveTesto);
          } else if (belowTesto + qrSize > H - margins.bottom) {
            // Even without flex, if testo + QR wouldn't fit below, place above.
            qy = Math.max(margins.top, testoTop - qrSize - gap);
          } else {
            qy = Math.max(belowTesto, bottomY);
          }
          parts.push(`<image href="${qrDataURL}" x="${qx}" y="${qy}" width="${qrSize}" height="${qrSize}" preserveAspectRatio="xMidYMid meet"/>`);
        }
      } catch (e) { console.warn('[QR] render error:', e); }
    }
  }

  // Letter overlays — behind text, NOT clipped.
  // NOTE: the selection outline is intentionally NOT drawn here. It is rendered
  // as a DOM overlay above the canvas so it never appears in PNG/PDF exports
  // and so dragging stays smooth (no SVG rebuild needed for the outline alone).
  for (const ov of letterOverlays) {
    if (ov.visible === false) continue;
    const sz = ov.fontSize || Math.round((ov.sizeRatio || 0.4) * W);
    const ovFont = ov.font === 'QSciIcon' ? 'QSciIcon' : 'QSci';
    parts.push(`<text font-family="'${ovFont}'" font-size="${sz}" fill="${ov.color || '#302d2e'}" fill-opacity="${ov.opacity ?? 1}" text-anchor="middle" dominant-baseline="central" x="${Math.round(ov.x)}" y="${Math.round(ov.y)}">${escapeXML(ov.letter)}</text>`);
  }

  // Custom texts — rendered above main text
  for (const ct of customTexts) {
    if (ct.visible === false) continue;
    if (!ct.content || !ct.content.trim()) continue;
    const ctFs = Math.round(W * (ct.sizeRatio || CONFIG.typography.testoSizeRatio));
    const ctLh = Math.round(ctFs * 1.1);
    const ctFont = ct.font || 'Ronzino';
    const isRonzino = ctFont === 'Ronzino';
    const fw = isRonzino ? (ct.fontWeight || '400') : null;
    const fi = isRonzino ? (ct.italic ? 'italic' : null) : null;
    const upper = ct.uppercase !== false;
    const lines = wrapWithHardBreaks(
      upper ? ct.content.toUpperCase() : ct.content,
      contentW, ctFont, ctFs, fw, fi
    );
    if (!lines.length) continue;
    const pl = ct.placement || { v: 'mid', h: 'center' };
    const hAlign = pl.h || 'center';
    let bx, anchor;
    if (hAlign === 'left')       { bx = margins.left;      anchor = 'start';  }
    else if (hAlign === 'right') { bx = W - margins.right;  anchor = 'end';    }
    else                          { bx = CX;                 anchor = 'middle'; }
    const blockH = lines.length * ctLh;
    const vAlign = pl.v || 'mid';
    let topY;
    if (vAlign === 'top')       topY = margins.top;
    else if (vAlign === 'bottom') topY = H - margins.bottom - blockH;
    else                          topY = margins.top + (contentH - blockH) / 2;
    const fwAttr = fw ? ` font-weight="${fw}"` : '';
    const fsAttr = fi ? ` font-style="${fi}"`   : '';
    parts.push(`<text font-family="'${ctFont}', sans-serif"${fwAttr}${fsAttr} font-size="${ctFs}" fill="${ct.color || tcDate}" text-anchor="${anchor}">`);
    for (let i = 0; i < lines.length; i++) {
      const y = Math.round(topY + (i + 0.5) * ctLh + ctFs * 0.35);
      parts.push(`  <tspan x="${bx}" y="${y}">${escapeXML(lines[i] || '&#160;')}</tspan>`);
    }
    parts.push('</text>');
  }

  // ── Main text block (Data+Luogo, Titolo, Testo) ──

  // Data + Luogo row
  if (dlFlex) {
    // Flex mode: data (left) + luogo (right) as separate elements
    if (flexDataLines.length || flexLuogoLines.length) {
      const dlTop = margins.top;
      // Data — left-aligned
      if (flexDataLines.length) {
        parts.push(`<text font-family="'Ronzino', sans-serif" font-size="${fsDataLuogo}" fill="${tcDate}" text-anchor="start">`);
        for (let i = 0; i < flexDataLines.length; i++) {
          const y = Math.round(dlTop + (i + 0.5) * Math.round(fsDataLuogo * 1.1) + fsDataLuogo * 0.35);
          parts.push(`  <tspan x="${margins.left}" y="${y}">${escapeXML(flexDataLines[i])}</tspan>`);
        }
        parts.push('</text>');
      }
      // Luogo — right-aligned
      if (flexLuogoLines.length) {
        parts.push(`<text font-family="'Ronzino', sans-serif" font-size="${fsDataLuogo}" fill="${tcDate}" text-anchor="end">`);
        for (let i = 0; i < flexLuogoLines.length; i++) {
          const y = Math.round(dlTop + (i + 0.5) * Math.round(fsDataLuogo * 1.1) + fsDataLuogo * 0.35);
          parts.push(`  <tspan x="${W - margins.right}" y="${y}">${escapeXML(flexLuogoLines[i])}</tspan>`);
        }
        parts.push('</text>');
      }
    }
  } else if (dlLines.length) {
    const dlTop = margins.top;
    parts.push(`<text font-family="'Ronzino', sans-serif" font-size="${fsDataLuogo}" fill="${tcDate}" text-anchor="${dlAnchor}">`);
    for (let i = 0; i < dlLines.length; i++) {
      const y = Math.round(dlTop + (i + 0.5) * Math.round(fsDataLuogo * 1.1) + fsDataLuogo * 0.35);
      parts.push(`  <tspan x="${dlBX}" y="${y}">${escapeXML(dlLines[i])}</tspan>`);
    }
    parts.push('</text>');
  }

  // Titolo
  if (titoloLines.length) {
    parts.push(`<text font-family="'${tiFont}', sans-serif" font-size="${fsTitolo}" fill="${tcTitle}" text-anchor="middle">`);
    for (let i = 0; i < titoloLines.length; i++) {
      const y = Math.round(titoloTop + (i + 0.5) * titoloLH + fsTitolo * 0.35);
      parts.push(`  <tspan x="${CX}" y="${y}">${escapeXML(titoloLines[i])}</tspan>`);
    }
    parts.push('</text>');
  }

  // Testo
  if (testoLines.length) {
    parts.push(`<text font-family="'Ronzino', sans-serif" font-size="${fsTesto}" fill="${tcTesto}" text-anchor="middle">`);
    for (let i = 0; i < testoLines.length; i++) {
      const y = Math.round(testoTop + (i + 0.5) * testoLine + fsTesto * 0.35);
      parts.push(`  <tspan x="${CX}" y="${y}">${escapeXML(testoLines[i])}</tspan>`);
    }
    parts.push('</text>');
  }

  parts.push('</svg>');
  return parts.join('\n');
}
