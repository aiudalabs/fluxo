// Zoom/pan para los diagramas mermaid del docs-site (sin dependencias). astro-mermaid inyecta el SVG
// dentro de <pre class="mermaid">; acá: click en el diagrama → overlay a pantalla completa, rueda para
// zoom, arrastrar para pan, ESC o click en el fondo para cerrar. Delegación de eventos → funciona aunque
// los diagramas se rendericen async y en navegaciones SPA de Starlight.
(function () {
  if (window.__mermaidZoom) return;
  window.__mermaidZoom = true;

  let overlay, stage, svgEl, scale = 1, tx = 0, ty = 0, dragging = false, sx = 0, sy = 0;

  function apply() { if (svgEl) svgEl.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`; }

  function open(sourceSvg) {
    overlay = document.createElement('div');
    overlay.className = 'mmz-overlay';
    stage = document.createElement('div');
    stage.className = 'mmz-stage';
    svgEl = sourceSvg.cloneNode(true);
    svgEl.removeAttribute('style');
    svgEl.style.maxWidth = 'none';
    svgEl.style.width = 'min(1600px, 92vw)';
    svgEl.style.height = 'auto';
    svgEl.style.transformOrigin = '0 0';
    scale = 1; tx = 0; ty = 0;
    const hint = document.createElement('div');
    hint.className = 'mmz-hint';
    hint.textContent = 'rueda: zoom · arrastrar: mover · esc: cerrar';
    const close = document.createElement('button');
    close.className = 'mmz-close'; close.setAttribute('aria-label', 'Cerrar'); close.textContent = '✕';
    close.addEventListener('click', destroy);
    stage.appendChild(svgEl);
    overlay.append(stage, hint, close);
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(apply);

    overlay.addEventListener('wheel', onWheel, { passive: false });
    overlay.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) destroy(); });
    document.addEventListener('keydown', onKey);
  }

  function onWheel(e) {
    e.preventDefault();
    const rect = stage.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const ns = Math.min(8, Math.max(0.3, scale * factor));
    // zoom hacia el cursor
    tx = mx - ((mx - tx) * ns) / scale;
    ty = my - ((my - ty) * ns) / scale;
    scale = ns; apply();
  }
  function onDown(e) { if (e.button !== 0) return; dragging = true; sx = e.clientX - tx; sy = e.clientY - ty; e.preventDefault(); }
  function onMove(e) { if (!dragging) return; tx = e.clientX - sx; ty = e.clientY - sy; apply(); }
  function onUp() { dragging = false; }
  function onKey(e) { if (e.key === 'Escape') destroy(); }

  function destroy() {
    if (!overlay) return;
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    document.removeEventListener('keydown', onKey);
    overlay.remove(); overlay = null; svgEl = null;
    document.body.style.overflow = '';
  }

  document.addEventListener('click', function (e) {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const pre = target.closest('pre.mermaid[data-processed]');
    if (!pre) return;
    const svg = pre.querySelector('svg');
    if (svg && !overlay) open(svg);
  });
})();
