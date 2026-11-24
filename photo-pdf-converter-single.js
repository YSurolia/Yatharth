/*!
 * Photo PDF Studio: a drop-in photo-to-PDF tool in one file, with no dependencies.
 * Everything runs in the visitor's browser. Nothing is uploaded.
 *
 * HOW TO ADD IT TO YOUR WEBSITE
 *
 *   Easiest: paste this whole file inside a <script> tag at the spot on your page
 *   where the tool should appear:
 *
 *       <script>
 *         ...paste everything from this file here...
 *       </script>
 *
 *   Or upload this file to your site and add these two lines where it should appear:
 *
 *       <photo-pdf-studio></photo-pdf-studio>
 *       <script src="/photo-pdf-converter-single.js"></script>
 *
 *   Options:
 *     <photo-pdf-studio app-only></photo-pdf-studio>
 *         Show only the converter (no header, About section or footer).
 *     <script data-manual ...>
 *         Don't insert the tool automatically (use this if your site adds the
 *         <photo-pdf-studio> tag later with JavaScript, e.g. React or Vue).
 *
 *   The camera needs the page to be served over https (or localhost).
 */
(() => {
  'use strict';

  if (!window.customElements || customElements.get('photo-pdf-studio')) return;

  const SCRIPT_TAG = document.currentScript;

  // ===================================================================
  // Constants
  // ===================================================================

  const PAGE_SIZES = {
    a4: { label: 'A4', w: 595.28, h: 841.89 },
    letter: { label: 'Letter', w: 612, h: 792 },
    a5: { label: 'A5', w: 419.53, h: 595.28 },
  };
  const ORIENTATION_LABELS = { auto: 'Auto', portrait: 'Portrait', landscape: 'Landscape' };
  const MAX_EDGE = 2560; // longest side in px for embedded images
  const THUMB_EDGE = 360; // longest side in px for queue thumbnails
  const QUALITY_DEBOUNCE_MS = 300;
  const IMAGE_EXT = /\.(avif|bmp|gif|heic|heif|jfif|jpe?g|png|webp)$/i;
  const HEIC_EXT = /\.(heic|heif)$/i;
  const FONT_URL = 'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Sora:wght@600;700;800&display=swap';

  // ===================================================================
  // Image encoding (shared by Web Workers and the main-thread fallback)
  // ===================================================================

  function fitWithin(w, h, maxEdge) {
    const scale = Math.min(1, maxEdge / Math.max(w, h));
    return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
  }

  async function renderJpeg(source, srcW, srcH, maxEdge, quality, makeCanvas, toBlob) {
    const size = fitWithin(srcW, srcH, maxEdge);
    const canvas = makeCanvas(size.w, size.h);
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff'; // transparent PNGs get a white page, not black
    ctx.fillRect(0, 0, size.w, size.h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, size.w, size.h);
    const blob = await toBlob(canvas, quality);
    return { blob, w: size.w, h: size.h };
  }

  // Runs inside each worker. Serialized together with fitWithin/renderJpeg into a Blob URL.
  function workerMain() {
    const makeCanvas = (w, h) => new OffscreenCanvas(w, h);
    const toBlob = (canvas, quality) => canvas.convertToBlob({ type: 'image/jpeg', quality });

    self.onmessage = async (event) => {
      const { jobId, file, quality, maxEdge, thumbEdge, wantThumb } = event.data;
      let bitmap = null;
      try {
        bitmap = await createImageBitmap(file); // applies EXIF rotation
        const srcW = bitmap.width;
        const srcH = bitmap.height;
        if (wantThumb) {
          const thumb = await renderJpeg(bitmap, srcW, srcH, thumbEdge, 0.8, makeCanvas, toBlob);
          self.postMessage({ jobId, kind: 'thumb', thumb: thumb.blob, srcW, srcH });
        }
        const out = await renderJpeg(bitmap, srcW, srcH, maxEdge, quality, makeCanvas, toBlob);
        const buffer = await out.blob.arrayBuffer();
        self.postMessage({ jobId, kind: 'done', buffer, w: out.w, h: out.h, srcW, srcH }, [buffer]);
      } catch (error) {
        self.postMessage({ jobId, kind: 'error', message: (error && error.message) || String(error) });
      } finally {
        if (bitmap) bitmap.close();
      }
    };
  }

  const WORKER_SOURCE = `${fitWithin}\n${renderJpeg}\n(${workerMain})();`;

  class WorkerPool {
    constructor(size, onBroken) {
      const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
      this.onBroken = onBroken;
      this.idle = [];
      this.queue = [];
      this.active = new Map();
      this.seq = 0;
      for (let i = 0; i < size; i += 1) {
        const worker = new Worker(url);
        worker.onmessage = (event) => this.handleMessage(worker, event.data);
        worker.onerror = (event) => this.handleCrash(worker, event);
        this.idle.push(worker);
      }
    }

    run(payload, hooks) {
      return new Promise((resolve, reject) => {
        this.seq += 1;
        this.queue.push({ id: this.seq, payload, hooks, resolve, reject, worker: null });
        this.pump();
      });
    }

    pump() {
      while (this.idle.length && this.queue.length) {
        const job = this.queue.shift();
        if (job.hooks.isStale()) {
          job.resolve(null); // superseded before it started: skip the work entirely
          continue;
        }
        const worker = this.idle.pop();
        job.worker = worker;
        this.active.set(job.id, job);
        worker.postMessage({ jobId: job.id, ...job.payload });
      }
    }

    handleMessage(worker, message) {
      const job = this.active.get(message.jobId);
      if (!job) return;
      if (message.kind === 'thumb') {
        job.hooks.onThumb(message);
        return;
      }
      this.active.delete(message.jobId);
      this.idle.push(worker);
      if (message.kind === 'done') job.resolve(message);
      else job.reject(new Error(message.message || 'Could not read image'));
      this.pump();
    }

    handleCrash(worker, event) {
      if (event && event.preventDefault) event.preventDefault();
      this.onBroken();
      for (const [id, job] of this.active) {
        if (job.worker === worker) {
          this.active.delete(id);
          job.reject(new Error('Worker failed'));
        }
      }
      // Hand anything still queued back so it can run on the main thread.
      for (const job of this.queue.splice(0)) job.reject(new Error('Worker failed'));
    }
  }

  const workersSupported =
    typeof Worker === 'function' &&
    typeof OffscreenCanvas === 'function' &&
    typeof OffscreenCanvas.prototype.convertToBlob === 'function' &&
    typeof createImageBitmap === 'function';

  let pool = null;
  let poolBroken = !workersSupported;

  function getPool() {
    if (pool || poolBroken) return pool;
    try {
      const cores = navigator.hardwareConcurrency || 4;
      const lowMemory = typeof navigator.deviceMemory === 'number' && navigator.deviceMemory <= 4;
      const size = Math.max(1, Math.min(lowMemory ? 2 : 4, cores - 1));
      pool = new WorkerPool(size, () => { poolBroken = true; });
    } catch (_) {
      poolBroken = true; // e.g. a Content-Security-Policy that blocks blob: workers
      pool = null;
    }
    return pool;
  }

  const mainMakeCanvas = (w, h) => {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    return canvas;
  };

  const mainToBlob = (canvas, quality) => new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Encoding failed'))), 'image/jpeg', quality);
  });

  async function decodeOnMain(file) {
    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(file);
        return { source: bitmap, w: bitmap.width, h: bitmap.height, release: () => bitmap.close() };
      } catch (_) { /* fall back to <img> decoding */ }
    }
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      return { source: img, w: img.naturalWidth, h: img.naturalHeight, release: () => {} };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function encodeOnMain(payload, hooks) {
    const decoded = await decodeOnMain(payload.file);
    try {
      if (!decoded.w || !decoded.h) throw new Error('Image has no size');
      if (payload.wantThumb) {
        const thumb = await renderJpeg(decoded.source, decoded.w, decoded.h, payload.thumbEdge, 0.8, mainMakeCanvas, mainToBlob);
        hooks.onThumb({ thumb: thumb.blob, srcW: decoded.w, srcH: decoded.h });
      }
      const out = await renderJpeg(decoded.source, decoded.w, decoded.h, payload.maxEdge, payload.quality, mainMakeCanvas, mainToBlob);
      return { buffer: await out.blob.arrayBuffer(), w: out.w, h: out.h, srcW: decoded.w, srcH: decoded.h };
    } finally {
      decoded.release();
    }
  }

  let mainChain = Promise.resolve();
  function runOnMain(payload, hooks) {
    // One at a time, so the page stays responsive.
    const task = mainChain.then(() => (hooks.isStale() ? null : encodeOnMain(payload, hooks)));
    mainChain = task.catch(() => {});
    return task;
  }

  async function encodeImage(payload, hooks) {
    const workerPool = getPool();
    if (workerPool && !poolBroken) {
      try {
        return await workerPool.run(payload, hooks);
      } catch (_) {
        // Worker could not decode this file (or workers broke): try the main thread once.
      }
    }
    return runOnMain(payload, hooks);
  }

  // ===================================================================
  // JPEG header + PDF writer
  // ===================================================================

  function readJpegInfo(bytes) {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) { i += 1; continue; }
      const marker = bytes[i + 1];
      if (marker === 0xff) { i += 1; continue; }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { i += 2; continue; }
      const length = (bytes[i + 2] << 8) | bytes[i + 3];
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        return {
          height: (bytes[i + 5] << 8) | bytes[i + 6],
          width: (bytes[i + 7] << 8) | bytes[i + 8],
          components: bytes[i + 9],
        };
      }
      i += 2 + length;
    }
    return null;
  }

  function pageGeometry(imgW, imgH, sizeKey, orientation, margin) {
    const base = PAGE_SIZES[sizeKey] || PAGE_SIZES.a4;
    const landscape = orientation === 'landscape' || (orientation === 'auto' && imgW > imgH);
    const pw = landscape ? base.h : base.w;
    const ph = landscape ? base.w : base.h;
    const m = Math.max(0, Math.min(margin, pw / 2 - 10, ph / 2 - 10));
    const scale = Math.min((pw - 2 * m) / imgW, (ph - 2 * m) / imgH);
    const dw = imgW * scale;
    const dh = imgH * scale;
    return { pw, ph, dw, dh, dx: (pw - dw) / 2, dy: (ph - dh) / 2 };
  }

  const pdfNum = (value) => String(Number(value.toFixed(2)));

  function pdfText(text) {
    let hex = '<FEFF';
    for (let i = 0; i < text.length; i += 1) hex += text.charCodeAt(i).toString(16).padStart(4, '0');
    return `${hex}>`;
  }

  function pdfDate(date) {
    const p = (n) => String(n).padStart(2, '0');
    return `D:${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
  }

  // Embeds the already-encoded JPEG bytes directly (DCTDecode): no re-encoding, no base64.
  function buildPdf(images, options, title) {
    const encoder = new TextEncoder();
    const chunks = [];
    const offsets = [0];
    let size = 0;
    const write = (data) => {
      const bytes = typeof data === 'string' ? encoder.encode(data) : data;
      chunks.push(bytes);
      size += bytes.length;
    };
    const startObject = (num) => {
      offsets[num] = size;
      write(`${num} 0 obj\n`);
    };

    const count = images.length;
    const pageObject = (i) => 3 + i * 3;
    const infoObject = 3 + count * 3;

    write('%PDF-1.4\n');
    write(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // binary-file marker

    startObject(1);
    write('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

    startObject(2);
    write(`<< /Type /Pages /Kids [${images.map((_, i) => `${pageObject(i)} 0 R`).join(' ')}] /Count ${count} >>\nendobj\n`);

    images.forEach((img, i) => {
      const g = pageGeometry(img.w, img.h, options.pageSize, options.orientation, options.margin);
      const pageNum = pageObject(i);
      const imageNum = pageNum + 1;
      const contentNum = pageNum + 2;
      const colorSpace = img.components === 1 ? '/DeviceGray' : img.components === 4 ? '/DeviceCMYK' : '/DeviceRGB';

      startObject(pageNum);
      write(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pdfNum(g.pw)} ${pdfNum(g.ph)}] /Resources << /XObject << /Im${i} ${imageNum} 0 R >> >> /Contents ${contentNum} 0 R >>\nendobj\n`);

      startObject(imageNum);
      write(`<< /Type /XObject /Subtype /Image /Width ${img.w} /Height ${img.h} /ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.length} >>\nstream\n`);
      write(img.bytes);
      write('\nendstream\nendobj\n');

      const content = `q ${pdfNum(g.dw)} 0 0 ${pdfNum(g.dh)} ${pdfNum(g.dx)} ${pdfNum(g.dy)} cm /Im${i} Do Q\n`;
      startObject(contentNum);
      write(`<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);
    });

    startObject(infoObject);
    write(`<< /Title ${pdfText(title)} /Producer (Photo PDF Studio) /CreationDate (${pdfDate(new Date())}) >>\nendobj\n`);

    const xrefOffset = size;
    let xref = `xref\n0 ${infoObject + 1}\n0000000000 65535 f \n`;
    for (let n = 1; n <= infoObject; n += 1) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
    write(xref);
    write(`trailer\n<< /Size ${infoObject + 1} /Root 1 0 R /Info ${infoObject} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

    return new Blob(chunks, { type: 'application/pdf' });
  }

  // ===================================================================
  // Small helpers
  // ===================================================================

  function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function cleanFileName(value) {
    const name = String(value || '')
      .replace(/\.pdf$/i, '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+/, '')
      .slice(0, 120);
    return name || 'photo-stack';
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  function isImageFile(file) {
    return !!file && ((file.type && file.type.startsWith('image/')) || IMAGE_EXT.test(file.name || ''));
  }

  function hasFiles(event) {
    const types = event.dataTransfer && event.dataTransfer.types;
    return !!types && Array.from(types).includes('Files');
  }

  function saveBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.rel = 'noopener';
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function ensureFonts() {
    if (document.querySelector('link[data-photo-pdf-fonts]')) return;
    const head = document.head || document.documentElement;
    [['https://fonts.googleapis.com', false], ['https://fonts.gstatic.com', true]].forEach(([href, cross]) => {
      const link = document.createElement('link');
      link.rel = 'preconnect';
      link.href = href;
      if (cross) link.crossOrigin = '';
      head.appendChild(link);
    });
    const fonts = document.createElement('link');
    fonts.rel = 'stylesheet';
    fonts.href = FONT_URL;
    fonts.setAttribute('data-photo-pdf-fonts', '');
    head.appendChild(fonts);
  }

  const prefersReducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ===================================================================
  // Styles (scoped inside the Shadow DOM, so they never clash with your site)
  // ===================================================================

  const STYLES = `
:host {
  --navy-950: #07142a;
  --ink: #0f1d33;
  --ink-2: #33435b;
  --muted: #66768d;
  --line: #d9e2ee;
  --line-soft: #e6ecf4;
  --page: #e8edf4;
  --blue: #2f7cf6;
  --blue-soft: #e4edfd;
  --blue-line: #cddcf7;
  --blue-text: #2559c4;
  --radius-lg: 24px;
  --shadow-card: 0 1px 2px rgba(15, 29, 51, 0.04), 0 12px 30px -14px rgba(15, 29, 51, 0.14);
  --navy-panel:
    radial-gradient(120% 140% at 8% 0%, rgba(52, 92, 156, 0.75) 0%, rgba(52, 92, 156, 0) 55%),
    linear-gradient(135deg, #1a3561 0%, #11264a 55%, #0c1c38 100%);
  --font-display: "Sora", "Plus Jakarta Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-body: "Plus Jakarta Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;

  display: block;
  font-family: var(--font-body);
  font-size: 16px;
  font-weight: 400;
  font-style: normal;
  line-height: 1.5;
  letter-spacing: normal;
  word-spacing: normal;
  text-align: left;
  text-transform: none;
  color: var(--ink);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
img { max-width: 100%; }
button, input, select { font: inherit; color: inherit; letter-spacing: inherit; }
svg { display: block; }
h1, h2, h3, h4, p { text-transform: none; }

.pps { container: pps / inline-size; }

.backdrop {
  --band: 220px;
  background: linear-gradient(180deg, var(--navy-950) 0, #0b1b36 var(--band), var(--page) var(--band));
}

.page { max-width: 1200px; margin: 0 auto; padding: 0 16px; }

:host([app-only]) .backdrop { background: none; }
:host([app-only]) .page { max-width: none; padding: 0; }
:host([app-only]) .masthead,
:host([app-only]) .about-area,
:host([app-only]) .page-footer { display: none; }

/* ---------- Header ---------- */

.masthead { display: flex; align-items: center; gap: 28px; padding: 18px 2px 20px; color: #fff; }
.brand { display: flex; align-items: center; gap: 14px; min-width: 0; color: inherit; text-decoration: none; }
.brand-mark {
  flex: none; display: grid; place-items: center; width: 46px; height: 46px; border-radius: 14px;
  background: linear-gradient(180deg, #4b93ff 0%, #2368ee 100%);
  box-shadow: 0 10px 24px -8px rgba(47, 124, 246, 0.8), inset 0 1px 0 rgba(255, 255, 255, 0.25);
}
.brand-mark svg { width: 24px; height: 24px; fill: none; stroke: #fff; stroke-width: 2.8; stroke-linecap: round; }
.brand-text { display: grid; gap: 2px; min-width: 0; }
.brand-text strong { font-family: var(--font-display); font-weight: 700; font-size: 17px; letter-spacing: -0.02em; }
.brand-text small { font-size: 14px; color: #b7c3d6; }
.nav-links { display: flex; gap: 32px; margin-left: auto; }
.nav-links a { color: #e2e9f4; text-decoration: none; font-weight: 600; font-size: 15.5px; transition: color 0.15s ease; }
.nav-links a:hover { color: #fff; }
.local-pill {
  display: inline-flex; align-items: center; gap: 9px; padding: 9px 16px; border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.16); background: rgba(255, 255, 255, 0.07);
  color: #edf2f9; font-size: 15px; font-weight: 600; white-space: nowrap;
}
.local-pill .dot {
  width: 9px; height: 9px; border-radius: 50%; background: #3ddc84;
  box-shadow: 0 0 0 3px rgba(61, 220, 132, 0.18), 0 0 10px rgba(61, 220, 132, 0.7);
}

/* ---------- App frame ---------- */

.app-frame {
  padding: 18px; border-radius: 36px;
  background: linear-gradient(180deg, #aab3bf 0%, #cfd6df 26%, #e2e7ee 100%);
  box-shadow: 0 34px 60px -34px rgba(7, 20, 42, 0.55);
}
.app-shell {
  display: grid; gap: 18px; padding: 24px; border-radius: 28px;
  background: linear-gradient(180deg, #f8fafd 0%, #eef2f7 100%);
  box-shadow: inset 0 1px 0 #fff, 0 10px 26px -16px rgba(7, 20, 42, 0.35);
}
.intro-grid { display: grid; gap: 18px; }
.hero-card, .stats-card {
  position: relative; overflow: hidden; border-radius: 26px; color: #fff;
  background: var(--navy-panel); box-shadow: 0 26px 44px -26px rgba(7, 20, 42, 0.75);
}
.hero-card { padding: 30px 28px; }
.eyebrow {
  display: inline-flex; padding: 8px 13px; border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.14); background: rgba(255, 255, 255, 0.12);
  color: #e8eef8; font-size: 12.5px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase;
}
.hero-title {
  margin: 20px 0 14px; max-width: 300px; color: #fff;
  font-family: var(--font-display); font-weight: 800; font-size: 36px; line-height: 1.06; letter-spacing: -0.045em;
}
.hero-card p { margin: 0; max-width: 560px; color: #c7d2e4; font-size: 16.5px; line-height: 1.65; }
.chips { display: flex; flex-wrap: wrap; gap: 10px; margin: 22px 0 0; padding: 0; list-style: none; }
.chips li {
  padding: 9px 15px; border-radius: 999px; border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.06); color: #eef3fa; font-size: 14px; font-weight: 500;
}
.stats-card { display: grid; gap: 12px; padding: 18px; }
.stat {
  display: grid; gap: 2px; padding: 16px 18px; border-radius: 18px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.09), rgba(255, 255, 255, 0.03));
}
.stat-label { color: #c8d3e3; font-size: 14.5px; font-weight: 500; }
.stat-value { font-size: 29px; font-weight: 800; line-height: 1.2; letter-spacing: -0.02em; }
.stat-note { color: #b5c2d6; font-size: 13.5px; }

/* ---------- Cards ---------- */

.work-grid { display: grid; gap: 18px; }
.card {
  min-width: 0; padding: 20px; border-radius: var(--radius-lg); border: 1px solid var(--line);
  background: linear-gradient(180deg, #fbfcfe 0%, #f4f7fb 100%); box-shadow: var(--shadow-card);
}
.tag {
  display: inline-flex; padding: 6px 12px; border-radius: 999px; border: 1px solid var(--blue-line);
  background: var(--blue-soft); color: var(--blue-text);
  font-size: 12.5px; font-weight: 800; letter-spacing: 0.09em; text-transform: uppercase;
}
.card h3 { margin: 10px 0 6px; color: var(--ink); font-size: 17.5px; font-weight: 800; letter-spacing: -0.01em; }
.muted { margin: 0; color: var(--muted); font-size: 14.5px; line-height: 1.6; }

/* ---------- Upload ---------- */

.dropzone {
  margin-top: 16px; padding: 26px 18px 18px; border: 1.5px dashed #c6d2e3; border-radius: 20px;
  text-align: center; cursor: pointer;
  background: radial-gradient(80% 70% at 50% 0%, #e7eefb 0%, rgba(231, 238, 251, 0) 70%), #fbfcfe;
  transition: border-color 0.2s ease, background-color 0.2s ease;
}
.dropzone:hover, .dropzone.is-over { border-color: #8fb4f2; background-color: #f2f6fe; }
.drop-art { position: relative; width: 132px; height: 100px; margin: 0 auto 14px; }
.sheet { position: absolute; inset: 8px 4px; border-radius: 18px; border: 1px solid #d3ddeb; background: #fff; }
.sheet-back { transform: rotate(-9deg) translate(-8px, 6px); background: #f4f7fc; }
.sheet-mid { transform: rotate(7deg) translate(8px, 6px); background: #f7f9fd; }
.sheet-front {
  display: grid; place-items: center; inset: 0 8px 10px;
  box-shadow: 0 14px 26px -14px rgba(15, 29, 51, 0.35); transition: transform 0.25s ease;
}
.sheet-front svg { width: 26px; height: 26px; fill: none; stroke: var(--blue); stroke-width: 2.6; stroke-linecap: round; }
.dropzone:hover .sheet-front, .dropzone.is-over .sheet-front { transform: translateY(-4px); }
.drop-title { display: block; font-size: 18px; font-weight: 800; letter-spacing: -0.01em; }
.drop-hint { margin: 6px auto 0; max-width: 320px; color: var(--muted); font-size: 14.5px; }
.btn-row { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin: 16px 0 12px; }

.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 10px;
  padding: 12px 18px; border-radius: 16px; border: 1px solid var(--line); background: #fff; color: var(--ink);
  font-size: 15.5px; font-weight: 700; line-height: 1.2; white-space: nowrap; cursor: pointer;
  transition: transform 0.12s ease, box-shadow 0.2s ease, background 0.2s ease, border-color 0.2s ease, opacity 0.2s ease;
}
.btn:hover:not(:disabled) { border-color: #b9c9e0; }
.btn:active:not(:disabled) { transform: translateY(1px); }
.btn:disabled { cursor: not-allowed; }
.btn:focus-visible, .chip-btn:focus-visible, .camera-close:focus-visible, .shutter:focus-visible,
.nav-links a:focus-visible, .brand:focus-visible {
  outline: 3px solid rgba(47, 124, 246, 0.45); outline-offset: 2px;
}
.btn-primary {
  border-color: transparent; background: linear-gradient(180deg, #4b93ff 0%, #1f6ef0 100%); color: #fff;
  box-shadow: 0 12px 22px -12px rgba(31, 110, 240, 0.9), inset 0 1px 0 rgba(255, 255, 255, 0.25);
}
.btn-primary:hover:not(:disabled) { border-color: transparent; background: linear-gradient(180deg, #5a9cff 0%, #2a76f2 100%); }
.btn-clear:disabled { color: #9aa6b8; background: #f9fbfd; }
.file-meta { margin: 0; color: var(--muted); font-size: 14px; }

.status {
  margin-top: 14px; padding: 12px 14px; border-radius: 14px; border: 1px solid var(--line);
  background: #f3f6fa; color: var(--ink-2); font-size: 14px; line-height: 1.5;
}
.status.is-success { border-color: #cbead4; background: #edf9f0; color: #1f6b3a; }
.status.is-error { border-color: #f1cccc; background: #fdf1f1; color: #a12a2a; }
.status.is-working { border-color: #cfdefa; background: #eef4ff; color: #1f4fb0; }
.tip { margin: 12px 2px 0; color: var(--muted); font-size: 13.5px; line-height: 1.55; }

/* ---------- Queue ---------- */

.queue-head { display: flex; justify-content: space-between; gap: 16px; }
.queue-aside { flex: none; max-width: 175px; margin: 0; color: var(--muted); font-size: 13.5px; line-height: 1.55; text-align: right; }
.preview {
  position: relative; height: 380px; margin-top: 16px; overflow: hidden; border-radius: 20px;
  border: 1px solid var(--line); background: linear-gradient(180deg, #ffffff 0%, #e7eefa 100%);
}
.preview-empty {
  position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 4px; padding: 24px; text-align: center;
}
.preview-empty.has-caption { padding-bottom: 96px; }
.preview-plus {
  display: grid; place-items: center; width: 74px; height: 74px; margin-bottom: 12px; border-radius: 22px;
  border: 1px solid #cddbf2; background: linear-gradient(180deg, #f5f8fe 0%, #dde8fa 100%);
  box-shadow: 0 14px 26px -18px rgba(31, 110, 240, 0.6);
}
.preview-plus svg { width: 30px; height: 30px; fill: none; stroke: #8fb3ec; stroke-width: 1.8; stroke-linecap: round; }
.preview-empty strong { color: #4b5b73; font-size: 16px; font-weight: 800; }
.preview-empty p { margin: 4px 0 0; max-width: 260px; color: var(--muted); font-size: 14.5px; }
.paper {
  position: absolute; overflow: hidden; border-radius: 3px; background: #fff;
  box-shadow: 0 1px 2px rgba(15, 29, 51, 0.1), 0 20px 36px -18px rgba(15, 29, 51, 0.4);
  transition: width 0.2s ease, height 0.2s ease, left 0.2s ease, top 0.2s ease;
}
.paper img { position: absolute; display: block; max-width: none; object-fit: contain; transition: inherit; }
.preview-caption {
  position: absolute; left: 12px; right: 12px; bottom: 12px; display: flex; align-items: center;
  justify-content: space-between; gap: 12px; padding: 11px 14px; border-radius: 16px;
  background: rgba(12, 24, 46, 0.9); color: #fff; box-shadow: 0 14px 28px -16px rgba(7, 20, 42, 0.8);
}
.caption-text { display: grid; min-width: 0; }
.caption-text strong { overflow: hidden; font-size: 15px; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
.caption-text span { color: #b9c6da; font-size: 13px; }
.caption-badge {
  flex: none; padding: 6px 11px; border-radius: 999px; border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.12); font-size: 12px; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase;
}

.queue-list { display: grid; gap: 10px; margin: 14px 0 0; padding: 0; list-style: none; }
.queue-item {
  position: relative; display: grid; grid-template-columns: 76px 1fr; gap: 14px; padding: 10px;
  border-radius: 18px; border: 1px solid var(--line); background: #fff; cursor: grab;
  transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease, opacity 0.15s ease;
}
.queue-item:hover { border-color: #c4d3e8; }
.queue-item.is-selected { border-color: #9cc0f7; background: #f5f9ff; box-shadow: 0 0 0 3px rgba(47, 124, 246, 0.12); }
.queue-item.is-dragging { opacity: 0.45; }
.queue-item.drop-before::before, .queue-item.drop-after::after {
  content: ""; position: absolute; left: 8px; right: 8px; height: 3px; border-radius: 3px; background: var(--blue);
}
.queue-item.drop-before::before { top: -7px; }
.queue-item.drop-after::after { bottom: -7px; }
.qi-thumb { position: relative; width: 76px; height: 100px; overflow: hidden; border-radius: 12px; background: #e9eef5; }
.qi-thumb img { width: 100%; height: 100%; object-fit: cover; -webkit-user-drag: none; user-select: none; }
.qi-thumb.is-loading::after {
  content: ""; position: absolute; inset: 0;
  background: linear-gradient(100deg, rgba(255, 255, 255, 0) 20%, rgba(255, 255, 255, 0.7) 50%, rgba(255, 255, 255, 0) 80%);
  background-size: 200% 100%; animation: pps-shimmer 1.1s linear infinite;
}
.queue-item.is-error .qi-thumb { background: #fbeaea; }
@keyframes pps-shimmer { from { background-position: 150% 0; } to { background-position: -50% 0; } }
.qi-body { min-width: 0; align-self: center; }
.qi-title { display: flex; align-items: center; gap: 10px; min-width: 0; }
.qi-num {
  flex: none; padding: 4px 9px; border-radius: 999px; border: 1px solid var(--blue-line);
  background: var(--blue-soft); color: var(--blue-text); font-size: 12px; font-weight: 800;
}
.qi-name { overflow: hidden; font-size: 15.5px; font-weight: 700; text-overflow: ellipsis; white-space: nowrap; }
.qi-meta { margin: 5px 0 9px; color: var(--muted); font-size: 13.5px; }
.queue-item.is-error .qi-meta { color: #b03434; }
.qi-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.chip-btn {
  padding: 6px 13px; border-radius: 999px; border: 1px solid var(--line); background: #fff; color: var(--ink);
  font-size: 13.5px; font-weight: 600; cursor: pointer; transition: border-color 0.15s ease, background 0.15s ease;
}
.chip-btn:hover:not(:disabled) { border-color: #b9c9e0; background: #f7faff; }
.chip-btn:disabled { color: #aeb8c6; background: #fafbfd; cursor: not-allowed; }

/* ---------- Export ---------- */

.fields { display: grid; gap: 14px; margin-top: 16px; }
.field { display: grid; gap: 8px; min-width: 0; }
.field label { display: flex; align-items: baseline; gap: 8px; color: var(--ink); font-size: 15px; font-weight: 700; }
.label-value { color: var(--muted); font-weight: 500; }
.field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.field input[type="text"], .field select {
  width: 100%; margin: 0; padding: 12px 14px; border-radius: 14px; border: 1px solid var(--line);
  background-color: #fff; color: var(--ink); font-size: 15.5px; line-height: 1.4; box-shadow: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.field select {
  appearance: none; -webkit-appearance: none; padding-right: 40px; cursor: pointer;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%230f1d33' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 14px center; background-size: 16px;
}
.field input[type="text"]:focus, .field select:focus {
  outline: none; border-color: #8fb4f2; box-shadow: 0 0 0 4px rgba(47, 124, 246, 0.14);
}
input[type="range"] {
  --fill: 50%; width: 100%; height: 22px; margin: 0; padding: 0; border: 0;
  background: transparent; cursor: pointer; -webkit-appearance: none; appearance: none;
}
input[type="range"]:focus { outline: none; }
input[type="range"]::-webkit-slider-runnable-track {
  height: 7px; border-radius: 999px; border: 1px solid #d3dbe6;
  background: linear-gradient(90deg, var(--blue) 0 var(--fill), #e4e9f0 var(--fill) 100%);
}
input[type="range"]::-moz-range-track {
  height: 7px; border-radius: 999px; border: 1px solid #d3dbe6;
  background: linear-gradient(90deg, var(--blue) 0 var(--fill), #e4e9f0 var(--fill) 100%);
}
input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none; width: 18px; height: 18px; margin-top: -6.5px; border-radius: 50%;
  border: 3px solid #fff; background: var(--blue); box-shadow: 0 2px 6px rgba(15, 29, 51, 0.35);
}
input[type="range"]::-moz-range-thumb {
  width: 13px; height: 13px; border-radius: 50%; border: 3px solid #fff; background: var(--blue);
  box-shadow: 0 2px 6px rgba(15, 29, 51, 0.35);
}
input[type="range"]:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 5px rgba(47, 124, 246, 0.25); }
input[type="range"]:focus-visible::-moz-range-thumb { box-shadow: 0 0 0 5px rgba(47, 124, 246, 0.25); }

.summary {
  margin: 18px 0 14px; padding: 16px 18px 8px; border-radius: 18px; color: #fff;
  background: linear-gradient(180deg, #142c55 0%, #2c5b9c 100%); box-shadow: 0 18px 30px -20px rgba(20, 44, 85, 0.9);
}
.summary h4 { margin: 0 0 4px; color: #fff; font-size: 15.5px; font-weight: 800; }
.summary dl { margin: 0; }
.summary dl div { display: flex; justify-content: space-between; gap: 12px; padding: 9px 0; }
.summary dl div + div { border-top: 1px solid rgba(255, 255, 255, 0.13); }
.summary dt { color: #c3d0e4; font-size: 15px; }
.summary dd { margin: 0; font-size: 15px; font-weight: 800; }

.btn-download {
  width: 100%; padding: 15px 18px; border-color: transparent; color: #fff; font-size: 16.5px; font-weight: 800;
  background: linear-gradient(180deg, #4b93ff 0%, #1f6ef0 100%);
  box-shadow: 0 14px 26px -14px rgba(31, 110, 240, 0.95), inset 0 1px 0 rgba(255, 255, 255, 0.25);
}
.btn-download:hover:not(:disabled) { border-color: transparent; background: linear-gradient(180deg, #5a9cff 0%, #2a76f2 100%); }
.btn-download:disabled { background: linear-gradient(180deg, #b3cff8 0%, #a1c2f5 100%); color: rgba(255, 255, 255, 0.95); box-shadow: none; }
.btn-download.is-busy:disabled { background: linear-gradient(180deg, #4b93ff 0%, #1f6ef0 100%); cursor: progress; }
.spinner {
  display: none; width: 16px; height: 16px; border-radius: 50%;
  border: 2.5px solid rgba(255, 255, 255, 0.4); border-top-color: #fff; animation: pps-spin 0.7s linear infinite;
}
.btn-download.is-busy .spinner { display: inline-block; }
@keyframes pps-spin { to { transform: rotate(360deg); } }
.export-note { display: flex; align-items: center; gap: 8px; margin: 12px 2px 0; color: var(--muted); font-size: 14px; }
.export-note.is-ready { color: #1f6b3a; }
.export-note.is-working { color: #1f4fb0; }
.export-note.is-ready::before, .export-note.is-working::before {
  content: ""; flex: none; width: 8px; height: 8px; border-radius: 50%; background: currentColor;
}
.export-note.is-working::before { animation: pps-pulse 1s ease-in-out infinite; }
@keyframes pps-pulse { 50% { opacity: 0.3; } }

/* ---------- About ---------- */

.section-divider {
  display: flex; align-items: center; gap: 18px; margin: 56px 0 26px; color: #56657b;
  font-size: 13px; font-weight: 800; letter-spacing: 0.32em; text-transform: uppercase; scroll-margin-top: 20px;
}
.section-divider::before, .section-divider::after { content: ""; flex: 1; height: 1px; background: var(--line); }
.pitch { display: grid; gap: 18px; }
.pitch-card {
  position: relative; overflow: hidden; padding: 30px; border-radius: 26px; border: 1px solid var(--line);
  background:
    radial-gradient(38% 52% at 86% 86%, rgba(47, 124, 246, 0.2) 0%, rgba(47, 124, 246, 0) 70%),
    linear-gradient(135deg, #f9fbff 0%, #ebf2fc 100%);
  box-shadow: var(--shadow-card);
}
.pitch-card h2 {
  margin: 16px 0 14px; max-width: 440px; color: var(--ink);
  font-family: var(--font-display); font-weight: 800; font-size: 34px; line-height: 1.1; letter-spacing: -0.045em;
}
.pitch-card p { margin: 0; max-width: 520px; color: var(--ink-2); font-size: 16px; line-height: 1.7; }
.pills { display: flex; flex-wrap: wrap; gap: 10px; margin: 22px 0 0; padding: 0; list-style: none; }
.pills li {
  display: inline-flex; align-items: center; gap: 9px; padding: 9px 15px; border-radius: 999px;
  border: 1px solid var(--line); background: #fff; font-size: 14.5px; font-weight: 600;
}
.pills li::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--blue); }
.feature-card {
  padding: 26px; border-radius: 26px; border: 1px solid var(--line); background: #fff;
  box-shadow: var(--shadow-card); scroll-margin-top: 20px;
}
.feature-card h3 { margin: 0 0 4px; color: var(--ink); font-size: 18px; font-weight: 800; }
.feature-list { margin: 0; padding: 0; list-style: none; }
.feature-list li { display: grid; grid-template-columns: 22px 1fr; gap: 14px; padding: 16px 0; }
.feature-list li + li { border-top: 1px solid var(--line-soft); }
.check {
  display: grid; place-items: center; width: 22px; height: 22px; margin-top: 1px; border-radius: 7px;
  border: 1px solid #c4d6f6; background: var(--blue-soft);
}
.check svg { width: 14px; height: 14px; fill: none; stroke: var(--blue); stroke-width: 2.6; stroke-linecap: round; stroke-linejoin: round; }
.feature-list strong { font-size: 15.5px; font-weight: 800; }
.feature-list p { margin: 4px 0 0; color: var(--muted); font-size: 14px; line-height: 1.6; }
.footer-grid { display: grid; gap: 18px; margin-top: 18px; }
.mini-panel { padding: 22px; border-radius: 22px; border: 1px solid var(--line); background: #fff; box-shadow: var(--shadow-card); }
.mini-badge {
  display: inline-grid; place-items: center; min-width: 32px; height: 28px; padding: 0 8px; border-radius: 9px;
  border: 1px solid var(--blue-line); background: var(--blue-soft); color: var(--blue-text); font-size: 12.5px; font-weight: 800;
}
.mini-panel h3 { margin: 16px 0 8px; color: var(--ink); font-size: 16.5px; font-weight: 800; }
.mini-panel p { margin: 0; color: var(--muted); font-size: 14.5px; line-height: 1.65; }
.page-footer {
  display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px 24px; margin-top: 34px;
  padding: 22px 2px 36px; border-top: 1px solid var(--line); color: var(--muted); font-size: 13.5px;
}
.page-footer p { margin: 0; }
.page-footer strong { color: var(--ink-2); font-weight: 600; }

/* ---------- Drop overlay ---------- */

.drop-overlay {
  position: fixed; inset: 0; z-index: 2147483000; display: grid; place-items: center; padding: 24px;
  background: rgba(7, 20, 42, 0.55); pointer-events: none; animation: pps-fade 0.15s ease;
}
.drop-overlay-box {
  padding: 44px 60px; border-radius: 28px; border: 2px dashed rgba(255, 255, 255, 0.7);
  background: rgba(15, 35, 70, 0.6); color: #fff; text-align: center;
  font-family: var(--font-display); font-size: 22px; font-weight: 700; letter-spacing: -0.02em;
}
@keyframes pps-fade { from { opacity: 0; } }

/* ---------- Camera ---------- */

.camera-modal {
  position: fixed; inset: 0; z-index: 2147483001; display: grid; place-items: center; padding: 16px;
  background: rgba(5, 12, 26, 0.84); animation: pps-fade 0.15s ease;
}
.camera-sheet {
  display: grid; width: min(760px, 100%); max-height: 100%; overflow: hidden; border-radius: 26px;
  border: 1px solid rgba(255, 255, 255, 0.1); background: #0d1b33; color: #fff;
  box-shadow: 0 40px 80px -30px rgba(0, 0, 0, 0.8);
}
.camera-head { display: flex; align-items: center; gap: 12px; padding: 14px 14px 14px 20px; }
.camera-head strong { font-family: var(--font-display); font-size: 17px; font-weight: 700; }
.camera-count { padding: 5px 11px; border-radius: 999px; background: rgba(255, 255, 255, 0.1); color: #cbd6e6; font-size: 13px; font-weight: 600; }
.camera-close {
  display: grid; place-items: center; width: 38px; height: 38px; margin-left: auto; padding: 0; border: 0; border-radius: 50%;
  background: rgba(255, 255, 255, 0.1); color: #fff; font-size: 24px; line-height: 1; cursor: pointer;
}
.camera-close:hover { background: rgba(255, 255, 255, 0.18); }
.camera-view { position: relative; min-height: 0; aspect-ratio: 4 / 3; max-height: 68vh; background: #000; }
.camera-view video { width: 100%; height: 100%; object-fit: contain; }
.camera-flash { position: absolute; inset: 0; background: #fff; opacity: 0; pointer-events: none; }
.camera-flash.is-flashing { animation: pps-flash 0.28s ease-out; }
@keyframes pps-flash { from { opacity: 0.85; } to { opacity: 0; } }
.camera-error {
  position: absolute; inset: 0; display: grid; place-items: center; margin: 0; padding: 28px;
  color: #f6cfcf; font-size: 15px; line-height: 1.6; text-align: center;
}
.camera-actions { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 12px; padding: 16px 18px; }
.camera-fallback { justify-self: start; }
.camera-done { grid-column: 3; justify-self: end; }
.shutter {
  grid-column: 2; width: 70px; height: 70px; padding: 5px; border-radius: 50%;
  border: 4px solid rgba(255, 255, 255, 0.4); background: #fff content-box; cursor: pointer;
  transition: transform 0.12s ease, opacity 0.2s ease;
}
.shutter:active:not(:disabled) { transform: scale(0.93); }
.shutter:disabled { opacity: 0.35; cursor: not-allowed; }

/* ---------- Responsive (based on the space the tool gets on your page) ---------- */

@container pps (min-width: 760px) {
  .footer-grid { grid-template-columns: repeat(3, 1fr); }
}

@container pps (min-width: 860px) {
  .work-grid { grid-template-columns: 1fr 1fr; align-items: start; }
  .upload-card { position: sticky; top: 16px; }
  .queue-list { max-height: 560px; overflow: auto; padding: 4px 4px 4px 0; margin-right: -4px; }
  .pitch { grid-template-columns: 1.45fr 1fr; }
}

@container pps (min-width: 1100px) {
  .intro-grid { grid-template-columns: 1.35fr 1fr; }
  .hero-card { padding: 34px 32px; }
}

@container pps (max-width: 720px) {
  .backdrop { --band: 300px; }
  .masthead { flex-wrap: wrap; gap: 14px 24px; }
  .brand { flex: 1 0 100%; }
  .nav-links { margin-left: 0; gap: 24px; }
  .local-pill { max-width: 100%; }
}

@container pps (max-width: 560px) {
  .page { padding: 0 10px; }
  .app-frame { padding: 10px; border-radius: 26px; }
  .app-shell { padding: 12px; gap: 14px; border-radius: 20px; }
  .hero-card { padding: 22px 20px; }
  .hero-title { font-size: 31px; }
  .stats-card { padding: 12px; }
  .card { padding: 16px; }
  .queue-head { flex-direction: column; gap: 6px; }
  .queue-aside { max-width: none; text-align: left; }
  .preview { height: 340px; }
  .field-row { grid-template-columns: 1fr; }
  .btn-row .btn { flex: 1 1 40%; padding-inline: 12px; }
  .btn-row .btn-clear { flex-basis: 100%; }
  .pitch-card, .feature-card { padding: 22px; }
  .pitch-card h2 { font-size: 29px; }
}

@media (max-width: 560px) {
  .camera-modal { padding: 0; }
  .camera-sheet { height: 100%; border-radius: 0; grid-template-rows: auto 1fr auto; }
  .camera-view { aspect-ratio: auto; max-height: none; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
}
`;

  // ===================================================================
  // Markup
  // ===================================================================

  const ICON_PLUS = '<svg viewBox="0 0 24 24"><path d="M12 6v12M6 12h12"/></svg>';
  const ICON_CHECK = '<span class="check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.2 4.2L19 7"/></svg></span>';

  function markup(appOnly) {
    const H = appOnly ? 'h2' : 'h1';
    return `
<div class="pps">
  <div class="backdrop" id="top">
    <div class="page">
      <header class="masthead">
        <a class="brand" href="#top" data-scroll="top" aria-label="Photo PDF Studio home">
          <span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></span>
          <span class="brand-text">
            <strong>Photo PDF Studio</strong>
            <small>Clean exports from a fast browser workflow</small>
          </span>
        </a>
        <nav class="nav-links" aria-label="Photo PDF Studio">
          <a href="#about" data-scroll="about">About</a>
          <a href="#features" data-scroll="features">Features</a>
        </nav>
        <div class="local-pill"><span class="dot" aria-hidden="true"></span>100% local. Nothing uploaded.</div>
      </header>

      <div class="main">
        <section class="app-frame" aria-label="Photo to PDF converter">
          <div class="app-shell">
            <div class="intro-grid">
              <div class="hero-card">
                <span class="eyebrow">Private browser workflow</span>
                <${H} class="hero-title">Build a polished PDF from your photos</${H}>
                <p>Add photos, put them in order, choose your page settings and download the PDF straight away.</p>
                <ul class="chips" aria-label="Highlights">
                  <li>Drag photos in</li>
                  <li>Reorder page flow</li>
                  <li>Download instantly</li>
                </ul>
              </div>
              <div class="stats-card">
                <div class="stat">
                  <span class="stat-label">Pages queued</span>
                  <strong class="stat-value" id="statPages">0</strong>
                  <span class="stat-note">Every photo becomes its own neatly spaced PDF page.</span>
                </div>
                <div class="stat">
                  <span class="stat-label">Current paper size</span>
                  <strong class="stat-value" id="statPaper">A4</strong>
                  <span class="stat-note" id="statPaperNote">Auto orientation with 24 pt margins.</span>
                </div>
                <div class="stat">
                  <span class="stat-label">Processing mode</span>
                  <strong class="stat-value">Browser only</strong>
                  <span class="stat-note">Your photos never leave this browser tab.</span>
                </div>
              </div>
            </div>

            <div class="work-grid">
              <section class="card upload-card" aria-labelledby="uploadTitle">
                <span class="tag">Upload</span>
                <h3 id="uploadTitle">Start your stack</h3>
                <p class="muted">Drop photos, pick them from your device, or use the camera on supported browsers.</p>
                <div class="dropzone" id="dropzone">
                  <div class="drop-art" aria-hidden="true">
                    <span class="sheet sheet-back"></span>
                    <span class="sheet sheet-mid"></span>
                    <span class="sheet sheet-front">${ICON_PLUS}</span>
                  </div>
                  <strong class="drop-title">Add your photos</strong>
                  <p class="drop-hint">Drop or paste files anywhere on this page, or tap a button below.</p>
                  <div class="btn-row">
                    <button type="button" class="btn btn-primary" id="pickButton">Add photos</button>
                    <button type="button" class="btn" id="cameraButton">Take photo</button>
                    <button type="button" class="btn btn-clear" id="clearButton" disabled>Clear</button>
                  </div>
                  <p class="file-meta" id="fileMeta">No images added.</p>
                  <input type="file" id="fileInput" accept="image/*,.heic,.heif,.avif,.jfif" multiple hidden>
                  <input type="file" id="cameraInput" accept="image/*" capture="environment" hidden>
                </div>
                <div class="status" id="status" role="status" aria-live="polite">Add photos to start.</div>
                <p class="tip">Tip: drag cards in the queue, or use Up and Down, to set the page order before export.</p>
              </section>

              <section class="card queue-card" aria-labelledby="queueTitle">
                <div class="queue-head">
                  <div>
                    <span class="tag">Queue</span>
                    <h3 id="queueTitle">Preview and arrange</h3>
                    <p class="muted">Select a photo to see its page, then move it into reading order.</p>
                  </div>
                  <p class="queue-aside">The first card becomes page one of the exported PDF.</p>
                </div>
                <div class="preview" id="preview">
                  <div class="preview-empty" id="previewEmpty">
                    <span class="preview-plus" aria-hidden="true">${ICON_PLUS}</span>
                    <strong id="previewEmptyTitle">Preview ready</strong>
                    <p id="previewEmptyText">Add or select a photo to see its page.</p>
                  </div>
                  <div class="paper" id="paper" hidden><img id="previewImage" alt="" decoding="async"></div>
                  <div class="preview-caption" id="previewCaption" hidden>
                    <div class="caption-text"><strong id="captionName"></strong><span id="captionMeta"></span></div>
                    <span class="caption-badge" id="captionBadge"></span>
                  </div>
                </div>
                <ol class="queue-list" id="queueList" aria-label="Pages in order" hidden></ol>
              </section>
            </div>

            <section class="card export-card" aria-labelledby="exportTitle">
              <span class="tag">Export</span>
              <h3 id="exportTitle">Fine-tune the PDF</h3>
              <p class="muted">Set the layout and quality, then download your PDF in one click.</p>
              <div class="fields">
                <div class="field">
                  <label for="filenameInput">File name</label>
                  <input type="text" id="filenameInput" value="photo-stack" autocomplete="off" spellcheck="false">
                </div>
                <div class="field-row">
                  <div class="field">
                    <label for="pageSizeSelect">Page size</label>
                    <select id="pageSizeSelect">
                      <option value="a4" selected>A4</option>
                      <option value="letter">Letter</option>
                      <option value="a5">A5</option>
                    </select>
                  </div>
                  <div class="field">
                    <label for="orientationSelect">Orientation</label>
                    <select id="orientationSelect">
                      <option value="auto" selected>Auto</option>
                      <option value="portrait">Portrait</option>
                      <option value="landscape">Landscape</option>
                    </select>
                  </div>
                </div>
                <div class="field">
                  <label for="marginInput">Margin <span class="label-value" id="marginValue">24 pt</span></label>
                  <input type="range" id="marginInput" min="0" max="48" step="2" value="24">
                </div>
                <div class="field">
                  <label for="qualityInput">Image quality <span class="label-value" id="qualityValue">90%</span></label>
                  <input type="range" id="qualityInput" min="55" max="100" step="1" value="90">
                </div>
              </div>
              <div class="summary" aria-label="Export summary">
                <h4>Summary</h4>
                <dl>
                  <div><dt>Pages</dt><dd id="sumPages">0</dd></div>
                  <div><dt>Layout</dt><dd id="sumLayout">A4 / Auto</dd></div>
                  <div><dt>Margin</dt><dd id="sumMargin">24 pt</dd></div>
                  <div><dt>Quality</dt><dd id="sumQuality">90%</dd></div>
                </dl>
              </div>
              <button type="button" class="btn btn-download" id="generateButton" disabled>
                <span class="spinner" aria-hidden="true"></span>
                <span class="btn-label" id="generateLabel">Download PDF</span>
              </button>
              <p class="export-note" id="exportNote">Built-in PDF engine: nothing extra to download, so export starts instantly.</p>
            </section>
          </div>
        </section>

        <div class="about-area">
          <div class="section-divider" id="about"><span>About this tool</span></div>
          <section class="pitch">
            <article class="pitch-card">
              <span class="tag">Photo to PDF</span>
              <h2>Turn a stack of photos into one tidy PDF.</h2>
              <p>Drop in images, set the page order, adjust the layout and save a clean PDF in seconds. It works the same on a laptop or a phone.</p>
              <ul class="pills">
                <li>Drag and drop queue</li>
                <li>Live page preview</li>
                <li>Browser-only processing</li>
              </ul>
            </article>
            <aside class="feature-card" id="features">
              <h3>Why it's fast</h3>
              <ul class="feature-list">
                <li>${ICON_CHECK}<div><strong>Pages prepared as you add them</strong><p>Each photo is resized and compressed in the background, so the work is done before you click Download.</p></div></li>
                <li>${ICON_CHECK}<div><strong>Built-in PDF writer</strong><p>Nothing to fetch at export time. Pages are stitched together directly, in milliseconds.</p></div></li>
                <li>${ICON_CHECK}<div><strong>Uses every core</strong><p>Photos are processed in parallel on background threads, so the page stays smooth while you arrange.</p></div></li>
              </ul>
            </aside>
          </section>
          <section class="footer-grid">
            <article class="mini-panel"><span class="mini-badge">01</span><h3>Best for</h3><p>Receipts, handwritten notes, forms, study pages and quick document bundles.</p></article>
            <article class="mini-panel"><span class="mini-badge">02</span><h3>What stays local</h3><p>Your photos and the finished PDF stay on this device. Nothing is sent to a server.</p></article>
            <article class="mini-panel"><span class="mini-badge">03</span><h3>Camera capture</h3><p>Snap page after page with the in-browser camera. It stays open until you tap Done.</p></article>
          </section>
        </div>
      </div>

      <footer class="page-footer">
        <p><strong>Photo PDF Studio</strong> <span aria-hidden="true">·</span> Runs entirely in your browser.</p>
        <p>No accounts, no uploads, no tracking.</p>
      </footer>
    </div>
  </div>
</div>

<div class="drop-overlay" id="dropOverlay" hidden><div class="drop-overlay-box">Drop photos to add them</div></div>

<div class="camera-modal" id="cameraModal" role="dialog" aria-modal="true" aria-label="Take photo" hidden>
  <div class="camera-sheet">
    <div class="camera-head">
      <strong>Camera</strong>
      <span class="camera-count" id="cameraCount">0 captured</span>
      <button type="button" class="camera-close" id="cameraCloseButton" aria-label="Close camera">×</button>
    </div>
    <div class="camera-view">
      <video id="cameraVideo" playsinline muted autoplay></video>
      <div class="camera-flash" id="cameraFlash"></div>
      <p class="camera-error" id="cameraError" hidden></p>
    </div>
    <div class="camera-actions">
      <button type="button" class="btn camera-fallback" id="cameraFallbackButton" hidden>Use camera app</button>
      <button type="button" class="shutter" id="cameraShutter" aria-label="Capture photo" disabled></button>
      <button type="button" class="btn btn-primary camera-done" id="cameraDoneButton">Done</button>
    </div>
  </div>
</div>`;
  }

  // ===================================================================
  // One tool instance (runs inside the element's Shadow DOM)
  // ===================================================================

  const instances = [];

  function createStudio(root) {
    const $ = (id) => root.getElementById(id);
    const ui = {
      fileInput: $('fileInput'),
      cameraInput: $('cameraInput'),
      pickButton: $('pickButton'),
      cameraButton: $('cameraButton'),
      clearButton: $('clearButton'),
      dropzone: $('dropzone'),
      dropOverlay: $('dropOverlay'),
      fileMeta: $('fileMeta'),
      status: $('status'),
      preview: $('preview'),
      previewEmpty: $('previewEmpty'),
      previewEmptyTitle: $('previewEmptyTitle'),
      previewEmptyText: $('previewEmptyText'),
      paper: $('paper'),
      previewImage: $('previewImage'),
      previewCaption: $('previewCaption'),
      captionName: $('captionName'),
      captionMeta: $('captionMeta'),
      captionBadge: $('captionBadge'),
      queueList: $('queueList'),
      filenameInput: $('filenameInput'),
      pageSizeSelect: $('pageSizeSelect'),
      orientationSelect: $('orientationSelect'),
      marginInput: $('marginInput'),
      marginValue: $('marginValue'),
      qualityInput: $('qualityInput'),
      qualityValue: $('qualityValue'),
      sumPages: $('sumPages'),
      sumLayout: $('sumLayout'),
      sumMargin: $('sumMargin'),
      sumQuality: $('sumQuality'),
      generateButton: $('generateButton'),
      generateLabel: $('generateLabel'),
      exportNote: $('exportNote'),
      statPages: $('statPages'),
      statPaper: $('statPaper'),
      statPaperNote: $('statPaperNote'),
      cameraModal: $('cameraModal'),
      cameraVideo: $('cameraVideo'),
      cameraCount: $('cameraCount'),
      cameraError: $('cameraError'),
      cameraFlash: $('cameraFlash'),
      cameraShutter: $('cameraShutter'),
      cameraDoneButton: $('cameraDoneButton'),
      cameraCloseButton: $('cameraCloseButton'),
      cameraFallbackButton: $('cameraFallbackButton'),
    };

    const state = { items: [], selectedId: null, nextId: 1, busy: false };
    const api = {};

    const readSettings = () => ({
      pageSize: ui.pageSizeSelect.value,
      orientation: ui.orientationSelect.value,
      margin: Number(ui.marginInput.value),
      quality: Number(ui.qualityInput.value),
    });

    const dimensionsText = (item) => (item.width ? `${item.width} × ${item.height} px` : 'Reading…');

    function setStatus(message, tone = 'info') {
      ui.status.textContent = message;
      ui.status.className = `status${tone === 'info' ? '' : ` is-${tone}`}`;
    }

    function setRangeFill(input) {
      const min = Number(input.min);
      const max = Number(input.max);
      input.style.setProperty('--fill', `${((Number(input.value) - min) / (max - min)) * 100}%`);
    }

    const findItem = (id) => state.items.find((item) => item.id === id) || null;
    const selectedItem = () => findItem(state.selectedId);

    // ---------- Queue management ----------

    function addFiles(fileList, { fromCamera = false } = {}) {
      const all = Array.from(fileList || []);
      const files = all.filter(isImageFile);
      const skipped = all.length - files.length;

      if (!files.length) {
        if (all.length) setStatus(skipped === 1 ? "That file isn't an image." : "Those files aren't images.", 'error');
        return;
      }

      getPool();
      let firstNew = null;
      for (const file of files) {
        const item = {
          id: state.nextId,
          file,
          name: file.name || `Photo ${state.nextId}.jpg`,
          size: file.size,
          url: URL.createObjectURL(file),
          thumbUrl: null,
          previewFailed: false,
          width: 0,
          height: 0,
          status: 'pending',
          error: '',
          encoded: null,
          version: 0,
          removed: false,
          promise: Promise.resolve(),
        };
        state.nextId += 1;
        state.items.push(item);
        if (!firstNew) firstNew = item;
        processItem(item);
      }

      state.selectedId = firstNew.id;
      let message = fromCamera ? `Photo captured. ${plural(state.items.length, 'page')} in the queue.` : `${plural(files.length, 'photo')} added.`;
      if (skipped) message += ` Skipped ${plural(skipped, 'file')} that ${skipped === 1 ? "isn't an image" : "aren't images"}.`;
      setStatus(message, 'success');
      render();
    }

    function processItem(item) {
      item.version += 1;
      const version = item.version;
      const quality = Number(ui.qualityInput.value) / 100;
      const isStale = () => item.removed || item.version !== version;

      item.encoded = null;
      item.status = 'pending';

      item.promise = encodeImage(
        { file: item.file, quality, maxEdge: MAX_EDGE, thumbEdge: THUMB_EDGE, wantThumb: !item.thumbUrl },
        { isStale, onThumb: (message) => applyThumb(item, message) },
      ).then(
        (result) => {
          if (!result || isStale()) return;
          const bytes = new Uint8Array(result.buffer);
          const info = readJpegInfo(bytes);
          item.encoded = {
            bytes,
            w: info ? info.width : result.w,
            h: info ? info.height : result.h,
            components: info ? info.components : 3,
          };
          item.width = result.srcW;
          item.height = result.srcH;
          item.status = 'ready';
          scheduleRender();
        },
        () => {
          if (isStale()) return;
          item.status = 'error';
          item.error = HEIC_EXT.test(item.name)
            ? "This browser can't read HEIC photos. Convert to JPG first."
            : "Couldn't read this image.";
          setStatus(`${item.name}: ${item.error}`, 'error');
          scheduleRender();
        },
      );
    }

    function applyThumb(item, message) {
      if (item.removed || item.thumbUrl) return;
      item.thumbUrl = URL.createObjectURL(message.thumb);
      item.width = message.srcW;
      item.height = message.srcH;
      scheduleRender();
    }

    function reprocessAll() {
      for (const item of state.items) {
        if (item.status !== 'error') processItem(item);
      }
      render();
    }

    function releaseItem(item) {
      item.removed = true;
      item.encoded = null;
      URL.revokeObjectURL(item.url);
      if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
    }

    function removeItem(id) {
      const index = state.items.findIndex((item) => item.id === id);
      if (index < 0) return;
      const [item] = state.items.splice(index, 1);
      releaseItem(item);
      if (state.selectedId === id) {
        const neighbour = state.items[index] || state.items[index - 1];
        state.selectedId = neighbour ? neighbour.id : null;
      }
      setStatus(state.items.length ? `Removed ${item.name}.` : 'Queue is empty. Add photos to start.', 'info');
      render();
    }

    function moveItem(id, delta) {
      const index = state.items.findIndex((item) => item.id === id);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= state.items.length) return;
      const [item] = state.items.splice(index, 1);
      state.items.splice(target, 0, item);
      render();
    }

    function reorderItem(dragId, targetId, after) {
      const from = state.items.findIndex((item) => item.id === dragId);
      if (from < 0 || dragId === targetId) return;
      const [item] = state.items.splice(from, 1);
      let to = state.items.findIndex((entry) => entry.id === targetId);
      if (to < 0) {
        state.items.splice(from, 0, item);
        return;
      }
      if (after) to += 1;
      state.items.splice(to, 0, item);
      render();
    }

    function clearAll() {
      for (const item of state.items) releaseItem(item);
      state.items = [];
      state.selectedId = null;
      setStatus('Queue cleared. Add photos to start.', 'info');
      render();
    }

    function selectItem(id, reveal = false) {
      state.selectedId = id;
      render();
      if (reveal) {
        const rect = ui.preview.getBoundingClientRect();
        if (rect.top < 0 || rect.bottom > window.innerHeight) ui.preview.scrollIntoView({ block: 'center' });
      }
    }

    // ---------- Rendering ----------

    let renderQueued = false;
    function scheduleRender() {
      if (renderQueued) return;
      renderQueued = true;
      requestAnimationFrame(() => {
        renderQueued = false;
        render();
      });
    }

    function render() {
      renderQueue();
      renderPreview();
      renderSettings();
      renderControls();
    }

    const itemElements = new Map();

    function createItemElement(item) {
      const li = document.createElement('li');
      li.className = 'queue-item';
      li.draggable = true;
      li.dataset.id = String(item.id);
      li.innerHTML = `
        <div class="qi-thumb"><img alt="" draggable="false" decoding="async"></div>
        <div class="qi-body">
          <div class="qi-title"><span class="qi-num"></span><span class="qi-name"></span></div>
          <div class="qi-meta"></div>
          <div class="qi-actions">
            <button type="button" class="chip-btn" data-act="preview">Preview</button>
            <button type="button" class="chip-btn" data-act="up">Up</button>
            <button type="button" class="chip-btn" data-act="down">Down</button>
            <button type="button" class="chip-btn" data-act="remove">Remove</button>
          </div>
        </div>`;
      return li;
    }

    function updateItemElement(li, item, index, total) {
      const img = li.querySelector('img');
      const name = li.querySelector('.qi-name');
      li.classList.toggle('is-selected', item.id === state.selectedId);
      li.classList.toggle('is-error', item.status === 'error');
      li.setAttribute('aria-label', `Page ${index + 1}: ${item.name}`);
      if (item.thumbUrl && img.getAttribute('src') !== item.thumbUrl) img.src = item.thumbUrl;
      li.querySelector('.qi-thumb').classList.toggle('is-loading', !item.thumbUrl && item.status !== 'error');
      li.querySelector('.qi-num').textContent = String(index + 1).padStart(2, '0');
      name.textContent = item.name;
      name.title = item.name;
      li.querySelector('.qi-meta').textContent =
        item.status === 'error' ? item.error : `${dimensionsText(item)} / ${formatBytes(item.size)}`;
      li.querySelector('[data-act="preview"]').disabled = item.status === 'error';
      li.querySelector('[data-act="up"]').disabled = index === 0;
      li.querySelector('[data-act="down"]').disabled = index === total - 1;
    }

    function renderQueue() {
      const list = ui.queueList;
      const liveIds = new Set(state.items.map((item) => item.id));
      for (const [id, li] of itemElements) {
        if (!liveIds.has(id)) {
          li.remove();
          itemElements.delete(id);
        }
      }
      state.items.forEach((item, index) => {
        let li = itemElements.get(item.id);
        if (!li) {
          li = createItemElement(item);
          itemElements.set(item.id, li);
        }
        updateItemElement(li, item, index, state.items.length);
        if (list.children[index] !== li) list.insertBefore(li, list.children[index] || null);
      });
      list.hidden = state.items.length === 0;
    }

    function renderPreview() {
      const item = selectedItem();
      const src = item ? (item.previewFailed ? item.thumbUrl : item.url) : null;
      const viewable = !!item && item.status !== 'error' && !!src;

      ui.previewEmpty.hidden = viewable;
      ui.paper.hidden = !viewable;
      ui.previewCaption.hidden = !item;

      if (!viewable) {
        ui.previewImage.removeAttribute('src');
        ui.previewEmptyTitle.textContent = item ? "Can't preview this photo" : 'Preview ready';
        ui.previewEmptyText.textContent = item
          ? 'It will be left out of the PDF. Remove it or convert it to JPG.'
          : 'Add or select a photo to see its page.';
        ui.previewEmpty.classList.toggle('has-caption', !!item);
        if (!item) return;
      }

      if (viewable && ui.previewImage.getAttribute('src') !== src) {
        ui.previewImage.src = src;
        ui.previewImage.alt = `Preview of ${item.name}`;
      }
      ui.captionName.textContent = item.name;
      ui.captionMeta.textContent =
        item.status === 'error' ? item.error : `${dimensionsText(item)} / ${formatBytes(item.size)}`;
      ui.captionBadge.textContent = `Page ${state.items.indexOf(item) + 1}`;
      layoutPaper(item);
    }

    function layoutPaper(item) {
      if (!item || ui.paper.hidden) return;
      const settings = readSettings();
      const imgW = item.width || ui.previewImage.naturalWidth || 3;
      const imgH = item.height || ui.previewImage.naturalHeight || 4;
      const g = pageGeometry(imgW, imgH, settings.pageSize, settings.orientation, settings.margin);

      const boxW = ui.preview.clientWidth;
      const boxH = ui.preview.clientHeight;
      const pad = 20;
      const captionSpace = ui.previewCaption.offsetHeight + 24;
      const availW = Math.max(40, boxW - pad * 2);
      const availH = Math.max(40, boxH - pad - captionSpace);
      const scale = Math.min(availW / g.pw, availH / g.ph);
      const paperW = g.pw * scale;
      const paperH = g.ph * scale;

      Object.assign(ui.paper.style, {
        width: `${paperW}px`,
        height: `${paperH}px`,
        left: `${(boxW - paperW) / 2}px`,
        top: `${pad + (availH - paperH) / 2}px`,
      });
      Object.assign(ui.previewImage.style, {
        left: `${g.dx * scale}px`,
        top: `${(g.ph - g.dy - g.dh) * scale}px`,
        width: `${g.dw * scale}px`,
        height: `${g.dh * scale}px`,
      });
    }

    function orientationNote(settings) {
      const spacing = settings.margin === 0 ? 'no margins' : `${settings.margin} pt margins`;
      if (settings.orientation === 'auto') return `Auto orientation with ${spacing}.`;
      return `${ORIENTATION_LABELS[settings.orientation]} pages with ${spacing}.`;
    }

    function renderSettings() {
      const settings = readSettings();
      const usable = state.items.filter((item) => item.status !== 'error').length;
      const paperLabel = PAGE_SIZES[settings.pageSize].label;

      ui.statPages.textContent = String(usable);
      ui.sumPages.textContent = String(usable);
      ui.statPaper.textContent = paperLabel;
      ui.statPaperNote.textContent = orientationNote(settings);
      ui.sumLayout.textContent = `${paperLabel} / ${ORIENTATION_LABELS[settings.orientation]}`;
      ui.sumMargin.textContent = `${settings.margin} pt`;
      ui.sumQuality.textContent = `${settings.quality}%`;
      ui.marginValue.textContent = `${settings.margin} pt`;
      ui.qualityValue.textContent = `${settings.quality}%`;
      setRangeFill(ui.marginInput);
      setRangeFill(ui.qualityInput);
    }

    function renderControls() {
      const total = state.items.length;
      let ready = 0;
      let pending = 0;
      let bytes = 0;
      for (const item of state.items) {
        if (item.status === 'ready') ready += 1;
        else if (item.status === 'pending') pending += 1;
        bytes += item.size;
      }
      const usable = ready + pending;

      ui.pickButton.textContent = total ? 'Add more' : 'Add photos';
      ui.clearButton.disabled = total === 0 || state.busy;
      ui.generateButton.disabled = usable === 0 || state.busy;
      ui.fileMeta.textContent = total ? `${plural(total, 'image')} / ${formatBytes(bytes)}` : 'No images added.';

      if (state.busy) return;
      if (!total) {
        ui.exportNote.className = 'export-note';
        ui.exportNote.textContent = 'Built-in PDF engine: nothing extra to download, so export starts instantly.';
      } else if (pending) {
        ui.exportNote.className = 'export-note is-working';
        ui.exportNote.textContent = `Preparing pages in the background… ${ready}/${usable} ready.`;
      } else if (ready) {
        ui.exportNote.className = 'export-note is-ready';
        ui.exportNote.textContent = 'All pages are prepared. Your PDF builds instantly.';
      } else {
        ui.exportNote.className = 'export-note';
        ui.exportNote.textContent = 'None of these photos could be read.';
      }
    }

    // ---------- Export ----------

    async function waitForPages(onProgress) {
      for (;;) {
        const pending = state.items.filter((item) => item.status === 'pending');
        if (!pending.length) return;
        const usable = state.items.filter((item) => item.status !== 'error').length;
        onProgress(usable - pending.length, usable);
        await Promise.race(pending.map((item) => item.promise));
      }
    }

    async function generatePdf() {
      if (state.busy) return;
      state.busy = true;
      ui.generateButton.classList.add('is-busy');
      ui.generateLabel.textContent = 'Building PDF…';
      renderControls();

      try {
        await waitForPages((ready, total) => {
          setStatus(`Preparing pages… ${ready}/${total} ready.`, 'working');
          ui.generateLabel.textContent = `Preparing ${ready}/${total}…`;
        });

        const pages = state.items.filter((item) => item.status === 'ready' && item.encoded);
        if (!pages.length) throw new Error('None of the photos could be read.');

        const baseName = cleanFileName(ui.filenameInput.value);
        const fileName = `${baseName}.pdf`;
        const started = performance.now();
        const blob = buildPdf(pages.map((item) => item.encoded), readSettings(), baseName);
        const buildMs = performance.now() - started;
        saveBlob(blob, fileName);

        const failed = state.items.filter((item) => item.status === 'error').length;
        let message = `Saved ${fileName}: ${plural(pages.length, 'page')}, ${formatBytes(blob.size)}, built in ${buildMs < 1 ? '<1' : Math.round(buildMs)} ms.`;
        if (failed) message += ` Left out ${plural(failed, 'unreadable photo')}.`;
        setStatus(message, 'success');
      } catch (error) {
        setStatus((error && error.message) || 'Could not build the PDF.', 'error');
      } finally {
        state.busy = false;
        ui.generateButton.classList.remove('is-busy');
        ui.generateLabel.textContent = 'Download PDF';
        render();
      }
    }

    // ---------- Camera ----------

    let cameraStream = null;
    let cameraSessionCount = 0;
    let cameraSerial = 0;
    let focusBeforeCamera = null;
    let savedOverflow = '';

    const cameraAvailable = () =>
      !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && window.isSecureContext;

    function updateCameraCount() {
      ui.cameraCount.textContent = `${cameraSessionCount} captured`;
    }

    function stopCameraStream() {
      if (cameraStream) {
        cameraStream.getTracks().forEach((track) => track.stop());
        cameraStream = null;
      }
      ui.cameraVideo.srcObject = null;
    }

    function showCameraError(error) {
      const name = error && error.name;
      let message = 'Could not start the camera. Try your camera app instead.';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        message = 'Camera access was blocked. Allow it in your browser settings, or use your camera app instead.';
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
        message = 'No camera was found on this device.';
      } else if (name === 'NotReadableError') {
        message = 'The camera is busy in another app. Close it and try again.';
      }
      ui.cameraError.textContent = message;
      ui.cameraError.hidden = false;
      ui.cameraFallbackButton.hidden = false;
    }

    async function openCamera() {
      if (!cameraAvailable()) {
        ui.cameraInput.click(); // native camera capture on phones
        return;
      }
      getPool();
      focusBeforeCamera = root.activeElement;
      cameraSessionCount = 0;
      updateCameraCount();
      ui.cameraError.hidden = true;
      ui.cameraFallbackButton.hidden = true;
      ui.cameraShutter.disabled = true;
      ui.cameraModal.hidden = false;
      savedOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = 'hidden';
      ui.cameraDoneButton.focus();

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } },
          audio: false,
        });
        if (ui.cameraModal.hidden) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        cameraStream = stream;
        ui.cameraVideo.srcObject = stream;
        await ui.cameraVideo.play().catch(() => {});
        ui.cameraShutter.disabled = false;
        ui.cameraShutter.focus();
      } catch (error) {
        showCameraError(error);
      }
    }

    function closeCamera() {
      if (ui.cameraModal.hidden) return;
      stopCameraStream();
      ui.cameraModal.hidden = true;
      document.documentElement.style.overflow = savedOverflow;
      if (focusBeforeCamera && typeof focusBeforeCamera.focus === 'function') focusBeforeCamera.focus();
    }

    function capturePhoto() {
      const video = ui.cameraVideo;
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) return;
      const canvas = mainMakeCanvas(w, h);
      canvas.getContext('2d').drawImage(video, 0, 0, w, h);

      cameraSessionCount += 1;
      cameraSerial += 1;
      const serial = cameraSerial;
      updateCameraCount();

      ui.cameraFlash.classList.remove('is-flashing');
      void ui.cameraFlash.offsetWidth; // restart the animation
      ui.cameraFlash.classList.add('is-flashing');

      canvas.toBlob((blob) => {
        if (!blob) return;
        const file = new File([blob], `Camera ${String(serial).padStart(2, '0')}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
        addFiles([file], { fromCamera: true });
      }, 'image/jpeg', 0.92);
    }

    function trapCameraFocus(event) {
      const focusable = Array.from(ui.cameraModal.querySelectorAll('button')).filter((el) => !el.hidden && !el.disabled);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && root.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && root.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    // ---------- Events inside the tool ----------

    ui.pickButton.addEventListener('pointerdown', getPool, { passive: true });
    ui.pickButton.addEventListener('click', () => ui.fileInput.click());
    ui.fileInput.addEventListener('change', () => {
      addFiles(ui.fileInput.files);
      ui.fileInput.value = '';
    });
    ui.cameraButton.addEventListener('click', openCamera);
    ui.cameraInput.addEventListener('change', () => {
      addFiles(ui.cameraInput.files, { fromCamera: true });
      ui.cameraInput.value = '';
    });
    ui.clearButton.addEventListener('click', clearAll);
    ui.dropzone.addEventListener('click', (event) => {
      if (event.target.closest('button, input')) return;
      ui.fileInput.click();
    });

    // In-tool links (#about, #features, #top) live in the Shadow DOM, so scroll to them by hand.
    root.querySelectorAll('[data-scroll]').forEach((link) => {
      link.addEventListener('click', (event) => {
        const target = $(link.dataset.scroll);
        if (!target) return;
        event.preventDefault();
        target.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
      });
    });

    ui.queueList.addEventListener('click', (event) => {
      const li = event.target.closest('.queue-item');
      if (!li) return;
      const id = Number(li.dataset.id);
      const button = event.target.closest('button[data-act]');
      if (!button) {
        selectItem(id);
        return;
      }
      const action = button.dataset.act;
      if (action === 'preview') selectItem(id, true);
      else if (action === 'remove') removeItem(id);
      else {
        moveItem(id, action === 'up' ? -1 : 1);
        const moved = itemElements.get(id);
        const again = moved && moved.querySelector(`[data-act="${action}"]`);
        if (again && !again.disabled) again.focus();
        else if (moved) moved.querySelector(`[data-act="${action === 'up' ? 'down' : 'up'}"]`).focus();
      }
    });

    // Drag to reorder inside the queue
    let dragId = null;
    let dropTarget = null;
    const clearMarkers = () => {
      ui.queueList.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
    };
    const endDrag = () => {
      clearMarkers();
      ui.queueList.querySelectorAll('.is-dragging').forEach((el) => el.classList.remove('is-dragging'));
      dragId = null;
      dropTarget = null;
    };
    ui.queueList.addEventListener('dragstart', (event) => {
      const li = event.target.closest('.queue-item');
      if (!li) return;
      dragId = Number(li.dataset.id);
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', `page-${dragId}`);
      li.classList.add('is-dragging');
    });
    ui.queueList.addEventListener('dragover', (event) => {
      if (dragId === null) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const li = event.target.closest('.queue-item');
      clearMarkers();
      if (!li || Number(li.dataset.id) === dragId) {
        dropTarget = null;
        return;
      }
      const rect = li.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      li.classList.add(after ? 'drop-after' : 'drop-before');
      dropTarget = { id: Number(li.dataset.id), after };
    });
    ui.queueList.addEventListener('drop', (event) => {
      if (dragId === null) return;
      event.preventDefault();
      if (dropTarget) reorderItem(dragId, dropTarget.id, dropTarget.after);
      endDrag();
    });
    ui.queueList.addEventListener('dragend', endDrag);

    // Settings
    ui.pageSizeSelect.addEventListener('change', render);
    ui.orientationSelect.addEventListener('change', render);
    ui.marginInput.addEventListener('input', render);
    let qualityTimer = 0;
    ui.qualityInput.addEventListener('input', () => {
      renderSettings();
      clearTimeout(qualityTimer);
      qualityTimer = setTimeout(reprocessAll, QUALITY_DEBOUNCE_MS);
    });
    ui.filenameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !ui.generateButton.disabled) generatePdf();
    });
    ui.generateButton.addEventListener('click', generatePdf);

    // Preview image
    ui.previewImage.addEventListener('load', () => layoutPaper(selectedItem()));
    ui.previewImage.addEventListener('error', () => {
      const item = selectedItem();
      if (!item || item.previewFailed || !ui.previewImage.getAttribute('src')) return;
      item.previewFailed = true; // e.g. HEIC in Chrome: show the decoded thumbnail instead
      scheduleRender();
    });
    const resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => layoutPaper(selectedItem()))
      : null;
    if (resizeObserver) resizeObserver.observe(ui.preview);

    // Camera
    ui.cameraShutter.addEventListener('click', capturePhoto);
    ui.cameraDoneButton.addEventListener('click', closeCamera);
    ui.cameraCloseButton.addEventListener('click', closeCamera);
    ui.cameraFallbackButton.addEventListener('click', () => {
      closeCamera();
      ui.cameraInput.click();
    });
    ui.cameraModal.addEventListener('click', (event) => {
      if (event.target === ui.cameraModal) closeCamera();
    });

    // ---------- Page-level listeners (drop/paste anywhere), added while on the page ----------

    let dragDepth = 0;
    const isPrimary = () => instances[0] === api; // with several tools on one page, the first one takes drops
    const showOverlay = (show) => {
      ui.dropOverlay.hidden = !show;
      ui.dropzone.classList.toggle('is-over', show);
    };
    const pageListeners = [
      [window, 'dragenter', (event) => {
        if (!isPrimary() || !hasFiles(event)) return;
        event.preventDefault();
        getPool();
        dragDepth += 1;
        showOverlay(true);
      }],
      [window, 'dragover', (event) => {
        if (!isPrimary() || !hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }],
      [window, 'dragleave', (event) => {
        if (!isPrimary() || !hasFiles(event)) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (!dragDepth) showOverlay(false);
      }],
      [window, 'drop', (event) => {
        if (!isPrimary() || !hasFiles(event)) return;
        event.preventDefault();
        dragDepth = 0;
        showOverlay(false);
        addFiles(event.dataTransfer.files);
      }],
      [window, 'paste', (event) => {
        if (!isPrimary()) return;
        const files = event.clipboardData ? Array.from(event.clipboardData.files).filter(isImageFile) : [];
        if (!files.length) return;
        event.preventDefault();
        addFiles(files);
      }],
      [document, 'keydown', (event) => {
        if (ui.cameraModal.hidden) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          closeCamera();
        } else if (event.key === 'Tab') {
          trapCameraFocus(event);
        }
      }],
      [window, 'pagehide', () => closeCamera()],
    ];

    api.attach = () => {
      if (!instances.includes(api)) instances.push(api);
      pageListeners.forEach(([target, type, fn]) => target.addEventListener(type, fn));
      if (resizeObserver) resizeObserver.observe(ui.preview);
      render();
    };

    api.detach = () => {
      closeCamera();
      showOverlay(false);
      dragDepth = 0;
      pageListeners.forEach(([target, type, fn]) => target.removeEventListener(type, fn));
      if (resizeObserver) resizeObserver.disconnect();
      const index = instances.indexOf(api);
      if (index >= 0) instances.splice(index, 1);
    };

    render();
    return api;
  }

  // ===================================================================
  // The <photo-pdf-studio> element
  // ===================================================================

  class PhotoPdfStudioElement extends HTMLElement {
    connectedCallback() {
      if (!this.studio) {
        ensureFonts();
        const root = this.shadowRoot || this.attachShadow({ mode: 'open' });
        root.innerHTML = `<style>${STYLES}</style>${markup(this.hasAttribute('app-only'))}`;
        this.studio = createStudio(root);
      }
      this.studio.attach();
    }

    disconnectedCallback() {
      if (this.studio) this.studio.detach();
    }
  }

  customElements.define('photo-pdf-studio', PhotoPdfStudioElement);

  // Pasting just this script is enough: if the page has no <photo-pdf-studio> tag,
  // add one right where the script is (or at the end of <body> if the script is in <head>).
  function autoInsert() {
    if (SCRIPT_TAG && SCRIPT_TAG.hasAttribute('data-manual')) return;
    if (document.querySelector('photo-pdf-studio')) return;
    const element = document.createElement('photo-pdf-studio');
    const parent = SCRIPT_TAG && SCRIPT_TAG.parentNode;
    if (parent && parent !== document.head && document.contains(SCRIPT_TAG)) parent.insertBefore(element, SCRIPT_TAG.nextSibling);
    else document.body.appendChild(element);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoInsert);
  else autoInsert();
})();
