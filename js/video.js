/**
 * Cleo Herramientas - Compresor de Video
 * ---------------------------------------------------------------------------
 * Reduce el peso de los videos re-codificándolos con la API WebCodecs (a
 * través de Mediabunny) directamente en el navegador, con un ajuste de
 * calidad "visualmente sin pérdida" por defecto.
 *
 * Nada se sube a ningún servidor: el archivo original y el resultado viven
 * únicamente en la memoria del equipo.
 */
(function () {
  'use strict';

  /* =======================================================================
     1. MOTOR DE COMPRESIÓN
     ======================================================================= */

  /**
   * Mediabunny se carga de forma diferida mediante `import()` dinámico: sólo
   * se descarga (~177 KB comprimido) la primera vez que el usuario abre la
   * pestaña de video, por lo que el arranque de la app no se penaliza.
   */
  const ENGINE_URL = 'https://cdn.jsdelivr.net/npm/mediabunny@1.61.3/dist/bundles/mediabunny.min.mjs';

  let enginePromise = null;
  /** Conversión en curso, para poder cancelarla desde la interfaz. */
  let activeConversion = null;

  function loadEngine() {
    if (!enginePromise) {
      enginePromise = import(ENGINE_URL).catch((err) => {
        enginePromise = null;
        throw err;
      });
    }
    return enginePromise;
  }

  /** ¿El navegador puede codificar/decodificar video de forma nativa? */
  function hasWebCodecs() {
    return typeof window.VideoEncoder === 'function' &&
           typeof window.VideoDecoder === 'function';
  }

  const VIDEO_EXT_RE = /\.(mp4|m4v|mov|webm|mkv|avi|wmv|flv|3gp|3g2|ts|mts|m2ts|ogv|mpg|mpeg)$/i;

  function isVideoFile(file) {
    if (!file) return false;
    return (file.type || '').startsWith('video/') || VIDEO_EXT_RE.test(file.name || '');
  }

  function formatBytes(bytes) {
    if (!bytes || bytes < 0 || !isFinite(bytes)) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / Math.pow(1024, i);
    const decimals = i === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
    return `${value.toFixed(decimals)} ${units[i]}`;
  }

  function formatDuration(seconds) {
    if (!isFinite(seconds) || seconds <= 0) return '0:00';
    const total = Math.round(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
    return `${h > 0 ? h + ':' : ''}${mm}:${String(s).padStart(2, '0')}`;
  }

  /**
   * Niveles de calidad. `very-high` es el ajuste por defecto: re-codifica con
   * un presupuesto de bits tan alto que la diferencia es imperceptible a ojo,
   * que es justo lo que se busca con "comprimir sin perder calidad".
   */
  const QUALITY_PRESETS = [
    { level: 'very-low', label: 'Máxima compresión', hint: 'El archivo más pequeño posible. La calidad baja de forma visible.' },
    { level: 'low', label: 'Compacta', hint: 'Prioriza el ahorro de espacio sobre la fidelidad.' },
    { level: 'medium', label: 'Equilibrada', hint: 'Ahorro notable conservando buena nitidez.' },
    { level: 'high', label: 'Alta', hint: 'Ahorro moderado, calidad muy cercana al original.' },
    { level: 'very-high', label: 'Sin pérdida visible', hint: 'Fidelidad máxima: a simple vista no se distingue del original.' }
  ];
  const DEFAULT_QUALITY_INDEX = QUALITY_PRESETS.length - 1;

  /** Orden de preferencia de códecs WebM. VP9 es el mejor equilibrio velocidad/tamaño. */
  const CODEC_PREFERENCE = {
    auto: ['vp9', 'av1', 'vp8'],
    vp9: ['vp9'],
    av1: ['av1'],
    vp8: ['vp8']
  };

  const PLAYABLE_EXT_RE = /\.(mp4|m4v|mov|webm|ogv)$/i;

  function engineError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
  }

  async function canvasToBlob(canvas) {
    if (!canvas) return null;
    if (typeof canvas.convertToBlob === 'function') {
      return canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
    }
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.8));
  }

  /**
   * Lee metadatos y genera una miniatura, sin re-codificar el video.
   * @returns {Promise<{meta: object, thumbBlob: Blob|null}>}
   */
  async function probeVideo(file) {
    const { Input, ALL_FORMATS, BlobSource, CanvasSink } = await loadEngine();
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });

    try {
      const videoTrack = await input.getPrimaryVideoTrack();
      const audioTrack = await input.getPrimaryAudioTrack();
      const duration = await input.computeDuration().catch(() => 0);

      const meta = {
        width: videoTrack ? await videoTrack.getDisplayWidth().catch(() => 0) : 0,
        height: videoTrack ? await videoTrack.getDisplayHeight().catch(() => 0) : 0,
        duration: isFinite(duration) ? duration : 0,
        fps: 0,
        hasAudio: !!audioTrack,
        decodable: videoTrack ? await videoTrack.canDecode().catch(() => false) : false
      };

      if (videoTrack) {
        const metrics = await videoTrack.computeFrameRateMetrics().catch(() => null);
        if (metrics && metrics.bestGuessFrameRate) {
          meta.fps = Math.round(metrics.bestGuessFrameRate);
        }
      }

      let thumbBlob = null;
      if (videoTrack && meta.decodable) {
        const sink = new CanvasSink(videoTrack, { width: 160 });
        const at = Math.min(1, meta.duration / 3);
        const wrapped = await sink.getCanvas(at).catch(() => null);
        if (wrapped) thumbBlob = await canvasToBlob(wrapped.canvas);
        if (typeof sink.dispose === 'function') sink.dispose();
      }

      return { meta, thumbBlob };
    } finally {
      try { input.dispose(); } catch (_) { /* ya liberado */ }
    }
  }

  /**
   * Comprime (re-codifica) un video a WebM.
   *
   * @param {File} file
   * @param {{codec: string, qualityIndex: number, maxHeight: number, audio: string}} options
   * @param {(progress: number) => void} [onProgress]
   * @param {() => boolean} [shouldCancel]
   * @returns {Promise<{blob: Blob, codec: string}>}
   */
  async function compressVideo(file, options, onProgress, shouldCancel) {
    const {
      Input, Output, Conversion, BlobSource, ALL_FORMATS,
      WebMOutputFormat, BufferTarget, Quality,
      getFirstEncodableVideoCodec, ConversionCanceledError
    } = await loadEngine();

    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });

    try {
      const videoTrack = await input.getPrimaryVideoTrack();
      if (!videoTrack) {
        throw engineError('NO_VIDEO_TRACK', 'El archivo no contiene ninguna pista de video.');
      }
      if (!(await videoTrack.canDecode().catch(() => false))) {
        throw engineError('DECODE_FAIL', 'Tu navegador no sabe decodificar el códec de este video.');
      }

      const srcWidth = await videoTrack.getDisplayWidth();
      const srcHeight = await videoTrack.getDisplayHeight();

      const preset = QUALITY_PRESETS[options.qualityIndex] || QUALITY_PRESETS[DEFAULT_QUALITY_INDEX];
      const quality = new Quality(preset.level);

      const preference = CODEC_PREFERENCE[options.codec] || CODEC_PREFERENCE.auto;
      const codec = await getFirstEncodableVideoCodec(preference, {
        width: srcWidth,
        height: srcHeight,
        quality
      });
      if (!codec) {
        throw engineError('NO_ENCODER', `Tu navegador no puede codificar en ${preference.join(' / ').toUpperCase()}.`);
      }

      const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });

      const videoOptions = { codec, quality };
      // Sólo reducimos resolución, nunca ampliamos. Mediabunny deduce el ancho
      // a partir del alto para no deformar la imagen.
      if (options.maxHeight && srcHeight > options.maxHeight) {
        videoOptions.height = options.maxHeight;
      }

      const conversionOptions = { input, output, video: videoOptions };

      if (options.audio === 'drop') {
        conversionOptions.audio = { discard: true };
      } else if (options.audio && options.audio !== 'keep') {
        conversionOptions.audio = {
          codec: 'opus',
          quality: new Quality({ bitrate: Number(options.audio) * 1000 })
        };
      }
      // audio === 'keep': no forzamos nada, así Mediabunny copia el audio tal
      // cual cuando el contenedor lo permite (cero pérdida añadida).

      const conversion = await Conversion.init(conversionOptions);
      if (!conversion.isValid) {
        const reasons = (conversion.discardedTracks || [])
          .map((t) => t.reason)
          .filter(Boolean)
          .join(', ');
        throw engineError('INVALID', `No se pudo preparar la conversión${reasons ? ` (${reasons})` : ''}.`);
      }

      conversion.onProgress = (value) => {
        if (typeof onProgress === 'function') {
          onProgress(Math.max(0, Math.min(1, value)));
        }
      };

      activeConversion = conversion;
      try {
        await conversion.execute();
      } catch (err) {
        const canceled = (typeof shouldCancel === 'function' && shouldCancel()) ||
          (typeof ConversionCanceledError === 'function' && err instanceof ConversionCanceledError) ||
          err && err.name === 'ConversionCanceledError';
        if (canceled) throw engineError('CANCELED', 'Compresión cancelada.');
        throw err;
      } finally {
        activeConversion = null;
      }

      const buffer = output.target.buffer;
      if (!buffer) throw engineError('EMPTY_OUTPUT', 'La conversión no produjo ningún archivo.');

      return { blob: new Blob([buffer], { type: 'video/webm' }), codec };
    } finally {
      try { input.dispose(); } catch (_) { /* ya liberado */ }
    }
  }

  /* =======================================================================
     2. INTERFAZ DE USUARIO
     ======================================================================= */

  document.addEventListener('DOMContentLoaded', () => {
    const $ = (id) => document.getElementById(id);

    const videoDropZone = $('videoDropZone');
    const videoDropEmpty = $('videoDropEmpty');
    const videoDropStrip = $('videoDropStrip');
    const videoInput = $('videoInput');
    const videoFolderInput = $('videoFolderInput');
    const btnBrowseVideos = $('btnBrowseVideos');
    const btnBrowseVideoFolder = $('btnBrowseVideoFolder');
    const btnVideoCompactAdd = $('btnVideoCompactAdd');
    const btnVideoCompactFolder = $('btnVideoCompactFolder');

    const videoCodecGroup = $('videoCodecGroup');
    const videoQualitySlider = $('videoQualitySlider');
    const videoQualityBadge = $('videoQualityBadge');
    const videoResolution = $('videoResolution');
    const videoAudio = $('videoAudio');

    const videoStatCount = $('videoStatCount');
    const videoStatOriginalSize = $('videoStatOriginalSize');
    const videoStatOptimizedSize = $('videoStatOptimizedSize');
    const videoStatSaving = $('videoStatSaving');
    const btnCompressVideos = $('btnCompressVideos');
    const btnClearVideos = $('btnClearVideos');

    const videoTableBody = $('videoTableBody');
    const videoEmptyState = $('videoEmptyState');
    const videoProgressContainer = $('videoProgressContainer');
    const videoProgressText = $('videoProgressText');
    const videoProgressPercent = $('videoProgressPercent');
    const videoProgressFill = $('videoProgressFill');
    const btnCancelVideo = $('btnCancelVideo');

    const videoEngineBadge = $('videoEngineBadge');
    const videoUnsupported = $('videoUnsupported');
    const videoNoGainHint = $('videoNoGainHint');
    const btnLowerVideoQuality = $('btnLowerVideoQuality');

    const videoCompareModal = $('videoCompareModal');
    const btnVideoCompareClose = $('btnVideoCompareClose');
    const videoCompareOrigSize = $('videoCompareOrigSize');
    const videoCompareOptSize = $('videoCompareOptSize');
    const videoCompareSaving = $('videoCompareSaving');
    const videoCompareOrig = $('videoCompareOrig');
    const videoCompareOpt = $('videoCompareOpt');
    const btnVideoCompareDownload = $('btnVideoCompareDownload');

    if (!videoDropZone || !videoTableBody) return; // la sección no está en el DOM

    const state = {
      items: [],
      isProcessing: false,
      engineReady: false,
      engineUnavailable: false,
      settings: {
        codec: 'auto',
        qualityIndex: DEFAULT_QUALITY_INDEX,
        maxHeight: 0,
        audio: 'keep'
      }
    };

    let sequence = 0;
    let cancelRequested = false;
    let compareItem = null;
    let compareOrigUrl = '';
    let compareOptUrl = '';
    let dragCounter = 0;
    let progressHideTimer = null;

    /* ------------------------------------------------------------------ *
     * Utilidades
     * ------------------------------------------------------------------ */

    function escapeHtml(value) {
      return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[c]));
    }

    function buildOutputName(name) {
      const base = (name || 'video').replace(/\.[^.]+$/, '');
      return `${base}_comprimido.webm`;
    }

    function canPreviewOriginal(item) {
      return PLAYABLE_EXT_RE.test(item.name || '') ||
        /^video\/(mp4|webm|quicktime|ogg)$/.test(item.file.type || '');
    }

    function isEditable(item) {
      return item.status === 'pending' || item.status === 'error' || item.status === 'canceled';
    }

    function triggerDownload(blob, filename) {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    function savingPercent(item) {
      if (item.status !== 'done' || !item.size || !item.resultSize) return 0;
      const saved = (1 - item.resultSize / item.size) * 100;
      return isFinite(saved) ? saved : 0;
    }

    /* ------------------------------------------------------------------ *
     * Motor: soporte y carga
     * ------------------------------------------------------------------ */

    function setEngineBadge(text, tone) {
      if (!videoEngineBadge) return;
      videoEngineBadge.textContent = text;
      videoEngineBadge.className = `video-engine-badge${tone ? ` is-${tone}` : ''}`;
    }

    function isVideoToolActive() {
      const active = document.querySelector('.tool-tab.active');
      return !!active && active.getAttribute('data-tool') === 'video';
    }

    /**
     * El aviso de incompatibilidad es una excepción dentro del panel de video:
     * el resto de paneles se ocultan según su pestaña, pero éste sólo debe verse
     * cuando el motor no está disponible Y estamos en la pestaña de video.
     */
    function syncNotice() {
      if (videoUnsupported) {
        videoUnsupported.hidden = !isVideoToolActive() || !state.engineUnavailable;
      }
    }

    function showUnsupported(message) {
      state.engineUnavailable = true;
      const detail = videoUnsupported && videoUnsupported.querySelector('span');
      if (detail && message) detail.textContent = message;
      syncNotice();
      state.engineReady = false;
      setEngineBadge('No disponible', 'error');
      updateUI();
    }

    function clearUnsupported() {
      state.engineUnavailable = false;
      syncNotice();
    }

    async function ensureEngine() {
      if (state.engineReady) {
        clearUnsupported();
        return true;
      }
      if (!hasWebCodecs()) {
        showUnsupported('Esta herramienta usa la API WebCodecs. Abre la app en Chrome, Edge u Opera actualizados (versión 94 o superior) para activarla.');
        return false;
      }
      setEngineBadge('Cargando motor…', 'loading');
      try {
        await loadEngine();
        state.engineReady = true;
        clearUnsupported();
        setEngineBadge('Motor WebCodecs listo', 'ok');
        updateUI();
        return true;
      } catch (err) {
        showUnsupported('No se pudo descargar el motor de compresión. Comprueba tu conexión a internet e inténtalo de nuevo.');
        console.warn('[Cleo Video] Error cargando Mediabunny:', err);
        return false;
      }
    }

    /* ------------------------------------------------------------------ *
     * Pestañas Fotos / Video
     * ------------------------------------------------------------------ */

    function switchTool(tool, updateHash = true) {
      if (!tool) return;
      document.querySelectorAll('[data-tool-panel]').forEach((el) => {
        el.hidden = el.getAttribute('data-tool-panel') !== tool;
      });
      document.querySelectorAll('.tool-tab').forEach((tab) => {
        const isActive = tab.getAttribute('data-tool') === tool;
        tab.classList.toggle('active', isActive);
        tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });
      document.body.classList.toggle('tool-video', tool === 'video');
      document.body.classList.toggle('tool-scraper', tool === 'scraper');
      if (updateHash && typeof history !== 'undefined' && history.replaceState) {
        history.replaceState(null, '', '#' + tool);
      }
      syncNotice();
      if (tool === 'video') ensureEngine();
    }

    document.querySelectorAll('.tool-tab').forEach((tab) => {
      tab.addEventListener('click', () => switchTool(tab.getAttribute('data-tool')));
    });

    function syncHashTool() {
      const hash = (location.hash || '').replace(/^#/, '').toLowerCase();
      if (hash === 'video' || hash === 'scraper' || hash === 'photos') {
        switchTool(hash, false);
      }
    }
    window.addEventListener('hashchange', syncHashTool);
    syncHashTool();
    window.CleoSwitchTool = switchTool;

    /* ------------------------------------------------------------------ *
     * Alta de archivos y lectura de metadatos
     * ------------------------------------------------------------------ */

    const probeQueue = [];
    let probing = false;

    function queueProbe(items) {
      probeQueue.push(...items);
      runProbeQueue();
    }

    async function runProbeQueue() {
      if (probing) return;
      probing = true;
      while (probeQueue.length) {
        const item = probeQueue.shift();
        if (!state.items.includes(item)) continue;
        try {
          const { meta, thumbBlob } = await probeVideo(item.file);
          item.meta = meta;
          if (thumbBlob) item.thumbUrl = URL.createObjectURL(thumbBlob);
          if (!meta.decodable) {
            item.status = 'unsupported';
            item.error = 'El navegador no puede decodificar el códec de este video.';
          }
        } catch (err) {
          item.status = 'error';
          item.error = err.message || 'No se pudieron leer los datos del video.';
          console.warn('[Cleo Video] Error leyendo metadatos:', err);
        }
        renderList();
        updateUI();
      }
      probing = false;
    }

    async function addFiles(fileList) {
      const incoming = Array.from(fileList || []).filter(isVideoFile);
      if (!incoming.length) return;

      const added = incoming.map((file) => ({
        id: `v${sequence++}`,
        file,
        name: file.name || `video_${sequence}.webm`,
        size: file.size,
        meta: null,
        status: 'pending',
        progress: 0,
        resultBlob: null,
        resultSize: 0,
        outputName: '',
        codec: '',
        noGain: false,
        thumbUrl: '',
        error: ''
      }));

      state.items.push(...added);
      renderList();
      updateUI();

      if (await ensureEngine()) queueProbe(added);
    }

    /* ------------------------------------------------------------------ *
     * Render
     * ------------------------------------------------------------------ */

    function metaLine(item) {
      if (!item.meta) {
        return item.status === 'unsupported' || item.status === 'error'
          ? 'Sin datos'
          : 'Analizando…';
      }
      const parts = [];
      if (item.meta.width && item.meta.height) parts.push(`${item.meta.width}×${item.meta.height}`);
      if (item.meta.duration) parts.push(formatDuration(item.meta.duration));
      if (item.meta.fps) parts.push(`${item.meta.fps} fps`);
      parts.push(item.meta.hasAudio ? 'con audio' : 'sin audio');
      return parts.join(' · ');
    }

    function statusCell(item) {
      switch (item.status) {
        case 'processing': {
          const pct = Math.round((item.progress || 0) * 100);
          return `<div class="video-row-progress">
            <div class="video-row-progress-track"><div class="video-row-progress-fill" data-vid-bar="${item.id}" style="width:${pct}%"></div></div>
            <span class="video-row-progress-text" data-vid-pct="${item.id}">${pct}%</span>
          </div>`;
        }
        case 'done':
          return '<span class="status-capsule status-done">✓ Listo</span>';
        case 'unsupported':
          return '<span class="status-capsule status-error">No soportado</span>';
        case 'canceled':
          return '<span class="status-capsule status-canceled">Cancelado</span>';
        case 'error':
          return `<span class="status-capsule status-error" title="${escapeHtml(item.error)}">Error</span>`;
        default:
          return item.meta ? '<span class="status-capsule status-pending">En cola</span>'
            : '<span class="status-capsule status-processing"><span class="spinner-ring"></span> Analizando</span>';
      }
    }

    function actionButtons(item) {
      const buttons = [];
      if (item.status === 'done') {
        buttons.push(`<button class="btn-icon-action" data-vid-action="download" data-vid-id="${item.id}" title="Descargar video comprimido">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        </button>`);
        if (canPreviewOriginal(item)) {
          buttons.push(`<button class="btn-icon-action" data-vid-action="compare" data-vid-id="${item.id}" title="Comparar calidad antes / después">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12h20"/><rect x="2" y="4" width="8" height="16" rx="1"/><rect x="14" y="4" width="8" height="16" rx="1"/></svg>
          </button>`);
        }
      }
      buttons.push(`<button class="btn-icon-action btn-del-action" data-vid-action="delete" data-vid-id="${item.id}" title="Quitar de la lista">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>`);
      return `<div class="actions-cluster">${buttons.join('')}</div>`;
    }

    function renderList() {
      const items = state.items;

      if (!items.length) {
        videoTableBody.innerHTML = '';
        if (videoEmptyState) videoEmptyState.style.display = 'flex';
        if (videoDropEmpty) videoDropEmpty.style.display = 'flex';
        if (videoDropStrip) videoDropStrip.style.display = 'none';
        if (videoDropZone) videoDropZone.classList.remove('has-items');
        return;
      }

      if (videoEmptyState) videoEmptyState.style.display = 'none';
      if (videoDropEmpty) videoDropEmpty.style.display = 'none';
      if (videoDropStrip) videoDropStrip.style.display = 'flex';
      if (videoDropZone) videoDropZone.classList.add('has-items');

      videoTableBody.innerHTML = items.map((item, index) => {
        const thumb = item.thumbUrl
          ? `<img class="table-preview-img" src="${item.thumbUrl}" alt="">`
          : '<div class="video-thumb-placeholder">🎬</div>';

        let optimized = '<span class="text-muted">—</span>';
        let saving = '<span class="text-muted">—</span>';

        if (item.status === 'done') {
          optimized = `<span class="size-bold text-cyan">${formatBytes(item.resultSize)}</span>`;
          const pct = savingPercent(item);
          if (item.noGain) {
            saving = `<span class="saving-tag low" title="El original ya estaba muy optimizado; con este ajuste no se reduce más.">${pct > 0 ? '−' + pct.toFixed(0) + '%' : 'Sin mejora'}</span>`;
          } else {
            const tone = pct >= 50 ? 'high' : pct >= 20 ? 'medium' : 'low';
            saving = `<span class="saving-tag ${tone}">−${pct.toFixed(0)}%</span>`;
          }
        }

        return `<tr data-vid-row="${item.id}">
          <td class="th-num">${index + 1}</td>
          <td class="th-thumb">${thumb}</td>
          <td class="th-name">
            <div class="file-meta-stack">
              <div class="file-name-line" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
              <div class="file-dims-line">${escapeHtml(metaLine(item))}</div>
            </div>
          </td>
          <td class="th-orig"><span class="size-bold">${formatBytes(item.size)}</span></td>
          <td class="th-opt">${optimized}</td>
          <td class="th-saving">${saving}</td>
          <td class="th-status">${statusCell(item)}</td>
          <td class="th-actions">${actionButtons(item)}</td>
        </tr>`;
      }).join('');
    }

    function updateRowProgress(item) {
      const pct = Math.round((item.progress || 0) * 100);
      const bar = videoTableBody.querySelector(`[data-vid-bar="${item.id}"]`);
      const text = videoTableBody.querySelector(`[data-vid-pct="${item.id}"]`);
      if (bar) bar.style.width = `${pct}%`;
      if (text) text.textContent = `${pct}%`;
    }

    function updateUI() {
      const items = state.items;
      const count = items.length;
      const totalOriginal = items.reduce((sum, item) => sum + (item.size || 0), 0);
      const doneItems = items.filter((item) => item.status === 'done');
      const totalOptimized = doneItems.reduce((sum, item) => sum + (item.resultSize || 0), 0);
      // El ahorro se calcula solo sobre lo ya comprimido, para no mostrar un
      // falso −100% mientras la cola sigue pendiente.
      const doneOriginal = doneItems.reduce((sum, item) => sum + (item.size || 0), 0);

      if (videoStatCount) videoStatCount.textContent = `${count} video${count === 1 ? '' : 's'}`;
      if (videoStatOriginalSize) videoStatOriginalSize.textContent = formatBytes(totalOriginal);
      if (videoStatOptimizedSize) videoStatOptimizedSize.textContent = formatBytes(totalOptimized);
      if (videoStatSaving) {
        const pct = doneOriginal > 0 ? Math.max(0, (1 - totalOptimized / doneOriginal) * 100) : 0;
        videoStatSaving.textContent = pct > 0 ? `−${pct.toFixed(0)}%` : '0%';
      }

      const pending = items.filter(isEditable).length;
      if (btnCompressVideos) {
        btnCompressVideos.disabled = !state.engineReady || state.isProcessing || pending === 0;
        btnCompressVideos.querySelector('span').textContent = doneItems.length && pending
          ? 'Comprimir restantes'
          : 'Comprimir Videos';
      }
      if (btnClearVideos) btnClearVideos.disabled = state.isProcessing || count === 0;
      if (btnCancelVideo) btnCancelVideo.hidden = !state.isProcessing;

      // Si algún video ya comprimido no bajó de peso, ofrecemos bajar la calidad.
      if (videoNoGainHint) {
        videoNoGainHint.hidden = !doneItems.some((item) => item.noGain);
      }
    }

    function showProgress(visible) {
      if (!videoProgressContainer) return;
      clearTimeout(progressHideTimer);
      if (visible) {
        videoProgressContainer.style.display = 'block';
      } else {
        progressHideTimer = setTimeout(() => { videoProgressContainer.style.display = 'none'; }, 1200);
      }
    }

    function updateBatchProgress(percent, label) {
      const pct = Math.max(0, Math.min(100, percent));
      if (videoProgressFill) videoProgressFill.style.width = `${pct}%`;
      if (videoProgressPercent) videoProgressPercent.textContent = `${Math.round(pct)}%`;
      if (videoProgressText && label) videoProgressText.textContent = label;
    }

    /* ------------------------------------------------------------------ *
     * Compresión
     * ------------------------------------------------------------------ */

    function markResultsStale() {
      let changed = false;
      state.items.forEach((item) => {
        if (item.status === 'done' || item.status === 'canceled') {
          item.status = item.meta && !item.meta.decodable ? 'unsupported' : 'pending';
          item.resultBlob = null;
          item.resultSize = 0;
          item.progress = 0;
          item.noGain = false;
          changed = true;
        }
      });
      if (changed) {
        renderList();
        updateUI();
      }
    }

    async function startCompression() {
      if (state.isProcessing) return;
      if (!(await ensureEngine())) return;

      const queue = state.items.filter(isEditable);
      if (!queue.length) return;

      state.isProcessing = true;
      cancelRequested = false;
      showProgress(true);
      updateUI();

      const settings = { ...state.settings };
      let completed = 0;

      for (let i = 0; i < queue.length; i++) {
        const item = queue[i];
        if (cancelRequested) break;

        item.status = 'processing';
        item.progress = 0;
        item.error = '';
        renderList();
        updateBatchProgress((i / queue.length) * 100, `Comprimiendo ${i + 1} de ${queue.length}: ${item.name}`);

        try {
          const { blob, codec } = await compressVideo(
            item.file,
            settings,
            (progress) => {
              item.progress = progress;
              updateRowProgress(item);
              const perItem = ((i + progress) / queue.length) * 100;
              updateBatchProgress(perItem, `Comprimiendo ${i + 1} de ${queue.length}: ${item.name}`);
            },
            () => cancelRequested
          );

          // Si el usuario canceló mientras terminaba la codificación, el
          // resultado se descarta: cancelar nunca debe acabar en "listo".
          if (cancelRequested) throw engineError('CANCELED', 'Compresión cancelada.');

          item.resultBlob = blob;
          item.resultSize = blob.size;
          item.outputName = buildOutputName(item.name);
          item.codec = codec;
          item.noGain = blob.size >= item.size * 0.98;
          item.status = 'done';
          completed++;
        } catch (err) {
          const wasCanceled = err.code === 'CANCELED';
          item.status = wasCanceled ? 'canceled' : 'error';
          item.error = err.message || 'Error desconocido al comprimir.';
          if (!wasCanceled) console.warn('[Cleo Video] Fallo comprimiendo', item.name, err);
        }

        renderList();
        updateUI();
      }

      state.isProcessing = false;
      activeConversion = null;
      updateBatchProgress(100, cancelRequested
        ? `Cancelado · ${completed} video${completed === 1 ? '' : 's'} listo${completed === 1 ? '' : 's'}`
        : `Completado · ${completed} de ${queue.length} video${queue.length === 1 ? '' : 's'}`);
      updateUI();
      showProgress(false);
    }

    function cancelCompression() {
      if (!state.isProcessing) return;
      cancelRequested = true;
      if (activeConversion) {
        try { activeConversion.cancel(); } catch (_) { /* se ignora */ }
      }
      if (btnCancelVideo) btnCancelVideo.disabled = true;
    }

    /* ------------------------------------------------------------------ *
     * Acciones de la lista
     * ------------------------------------------------------------------ */

    function downloadItem(item) {
      if (!item.resultBlob) return;
      triggerDownload(item.resultBlob, item.outputName || buildOutputName(item.name));
    }

    function deleteItem(item) {
      if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
      item.resultBlob = null;
      state.items = state.items.filter((it) => it !== item);
      renderList();
      updateUI();
    }

    function clearAll() {
      if (state.isProcessing) return;
      state.items.forEach((item) => { if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl); });
      state.items = [];
      renderList();
      updateUI();
    }

    /* ------------------------------------------------------------------ *
     * Modal de comparación
     * ------------------------------------------------------------------ */

    function openCompare(item) {
      if (!item.resultBlob || !videoCompareModal) return;
      compareItem = item;
      if (compareOrigUrl) URL.revokeObjectURL(compareOrigUrl);
      if (compareOptUrl) URL.revokeObjectURL(compareOptUrl);
      compareOrigUrl = URL.createObjectURL(item.file);
      compareOptUrl = URL.createObjectURL(item.resultBlob);

      videoCompareOrig.src = compareOrigUrl;
      videoCompareOpt.src = compareOptUrl;
      if (videoCompareOrigSize) videoCompareOrigSize.textContent = formatBytes(item.size);
      if (videoCompareOptSize) videoCompareOptSize.textContent = formatBytes(item.resultSize);
      if (videoCompareSaving) {
        const pct = savingPercent(item);
        videoCompareSaving.textContent = item.noGain ? 'Sin mejora' : `−${pct.toFixed(0)}%`;
      }
      videoCompareModal.style.display = 'flex';
    }

    function closeCompare() {
      if (!videoCompareModal) return;
      videoCompareModal.style.display = 'none';
      if (videoCompareOrig) { videoCompareOrig.pause(); videoCompareOrig.removeAttribute('src'); videoCompareOrig.load(); }
      if (videoCompareOpt) { videoCompareOpt.pause(); videoCompareOpt.removeAttribute('src'); videoCompareOpt.load(); }
      if (compareOrigUrl) { URL.revokeObjectURL(compareOrigUrl); compareOrigUrl = ''; }
      if (compareOptUrl) { URL.revokeObjectURL(compareOptUrl); compareOptUrl = ''; }
      compareItem = null;
    }

    /* ------------------------------------------------------------------ *
     * Eventos
     * ------------------------------------------------------------------ */

    videoTableBody.addEventListener('click', (event) => {
      const button = event.target.closest('[data-vid-action]');
      if (!button) return;
      const item = state.items.find((it) => it.id === button.getAttribute('data-vid-id'));
      if (!item) return;
      const action = button.getAttribute('data-vid-action');
      if (action === 'download') downloadItem(item);
      else if (action === 'compare') openCompare(item);
      else if (action === 'delete') deleteItem(item);
    });

    if (btnBrowseVideos) btnBrowseVideos.addEventListener('click', () => videoInput.click());
    if (btnBrowseVideoFolder) btnBrowseVideoFolder.addEventListener('click', () => videoFolderInput.click());
    if (btnVideoCompactAdd) btnVideoCompactAdd.addEventListener('click', () => videoInput.click());
    if (btnVideoCompactFolder) btnVideoCompactFolder.addEventListener('click', () => videoFolderInput.click());

    if (videoInput) {
      videoInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files.length) addFiles(e.target.files);
        videoInput.value = '';
      });
    }

    if (videoFolderInput) {
      videoFolderInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files.length) addFiles(e.target.files);
        videoFolderInput.value = '';
      });
    }

    if (videoCodecGroup) {
      videoCodecGroup.addEventListener('click', (event) => {
        const pill = event.target.closest('.pill-btn');
        if (!pill) return;
        state.settings.codec = pill.getAttribute('data-codec');
        videoCodecGroup.querySelectorAll('.pill-btn').forEach((btn) => btn.classList.toggle('active', btn === pill));
        markResultsStale();
      });
    }

    if (videoQualitySlider) {
      const syncQuality = () => {
        const index = Math.max(0, Math.min(QUALITY_PRESETS.length - 1, Number(videoQualitySlider.value)));
        state.settings.qualityIndex = index;
        const preset = QUALITY_PRESETS[index];
        if (videoQualityBadge) {
          videoQualityBadge.textContent = preset.label;
          videoQualityBadge.title = preset.hint;
        }
        markResultsStale();
      };
      videoQualitySlider.addEventListener('input', syncQuality);
      syncQuality();
    }

    if (videoResolution) {
      videoResolution.addEventListener('change', (e) => {
        const value = e.target.value;
        state.settings.maxHeight = value === 'original' ? 0 : Number(value);
        markResultsStale();
      });
    }

    if (videoAudio) {
      videoAudio.addEventListener('change', (e) => {
        state.settings.audio = e.target.value;
        markResultsStale();
      });
    }

    if (btnLowerVideoQuality) {
      btnLowerVideoQuality.addEventListener('click', () => {
        if (!videoQualitySlider) return;
        const target = QUALITY_PRESETS.findIndex((preset) => preset.level === 'high');
        videoQualitySlider.value = String(target < 0 ? 0 : target);
        // `input` dispara el refresco del badge y marca los resultados como obsoletos.
        videoQualitySlider.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }

    if (btnCompressVideos) btnCompressVideos.addEventListener('click', startCompression);
    if (btnClearVideos) btnClearVideos.addEventListener('click', clearAll);
    if (btnCancelVideo) btnCancelVideo.addEventListener('click', cancelCompression);

    if (btnVideoCompareClose) btnVideoCompareClose.addEventListener('click', closeCompare);
    if (btnVideoCompareDownload) {
      btnVideoCompareDownload.addEventListener('click', () => {
        if (compareItem) downloadItem(compareItem);
      });
    }
    if (videoCompareModal) {
      videoCompareModal.addEventListener('click', (event) => {
        if (event.target === videoCompareModal) closeCompare();
      });
    }

    // Arrastrar y soltar sobre la tarjeta de video
    videoDropZone.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragCounter++;
      videoDropZone.classList.add('drag-over');
    });
    videoDropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      videoDropZone.classList.add('drag-over');
    });
    videoDropZone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        videoDropZone.classList.remove('drag-over');
      }
    });
    videoDropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dragCounter = 0;
      videoDropZone.classList.remove('drag-over');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        addFiles(e.dataTransfer.files);
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && videoCompareModal && videoCompareModal.style.display === 'flex') {
        closeCompare();
      }
    });

    renderList();
    updateUI();
    // El aviso de incompatibilidad sólo se muestra al abrir la pestaña de video.
    if (!hasWebCodecs()) setEngineBadge('No disponible', 'error');

    /* ------------------------------------------------------------------ *
     * Superficie de depuración / pruebas
     * ------------------------------------------------------------------ */

    window.CleoVideo = {
      isSupported: hasWebCodecs,
      loadEngine,
      addFiles,
      startCompression,
      cancelCompression,
      getState: () => state,
      getItems: () => state.items
    };
  });
})();
