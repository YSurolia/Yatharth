let jsPdfLoader;

const PAGE_LABELS = {
  a4: "A4",
  letter: "Letter",
  a5: "A5",
};

function ensureJsPdf() {
  if (window.jspdf && window.jspdf.jsPDF) {
    return Promise.resolve(window.jspdf.jsPDF);
  }

  if (!jsPdfLoader) {
    jsPdfLoader = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js";
      script.crossOrigin = "anonymous";
      script.onload = () => {
        if (window.jspdf && window.jspdf.jsPDF) {
          resolve(window.jspdf.jsPDF);
          return;
        }

        reject(new Error("The PDF engine loaded, but jsPDF was not found."));
      };
      script.onerror = () => {
        reject(new Error("Could not load the PDF engine."));
      };
      document.head.appendChild(script);
    });
  }

  return jsPdfLoader;
}

function makeId() {
  return `photo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function waitForPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 KB";
  }

  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function sanitizeFileName(value) {
  return String(value || "")
    .trim()
    .replace(/\.pdf$/i, "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("That image could not be opened."));
    image.src = url;
  });
}

class PhotoPdfConverter extends HTMLElement {
  static get observedAttributes() {
    return ["heading", "subheading", "filename", "accent"];
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.state = {
      items: [],
      activeId: null,
      busy: false,
      statusTone: "info",
      statusMessage: "Add photos to start.",
    };
    this.dragDepth = 0;
    this.draggedId = null;
    this.initialized = false;
    this.handleFilenameInput = () => {
      this.refs.filenameInput.dataset.autoManaged = "false";
    };
  }

  connectedCallback() {
    if (this.initialized) {
      return;
    }

    this.initialized = true;
    this.renderShell();
    this.cacheElements();
    this.bindEvents();
    this.applyAttributes();
    this.render();
    this.setStatus(this.state.statusMessage, this.state.statusTone);
  }

  disconnectedCallback() {
    for (const item of this.state.items) {
      URL.revokeObjectURL(item.objectUrl);
    }
  }

  attributeChangedCallback() {
    if (!this.initialized) {
      return;
    }

    this.applyAttributes();
  }

  renderShell() {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          --accent: ${this.getAttribute("accent") || "#1d75ea"};
          --accent-deep: #1457b8;
          --text: #13263d;
          --muted: #60718a;
          --panel: rgba(255, 255, 255, 0.84);
          --panel-edge: rgba(191, 210, 236, 0.9);
          --line: #d7e5f6;
          --line-strong: #bcd4ef;
          --soft-blue: #eef5ff;
          --surface: #f8fbff;
          --shadow: 0 28px 70px rgba(35, 86, 150, 0.14);
          display: block;
          color: var(--text);
          font-family: "Aptos", "Segoe UI", sans-serif;
        }

        * {
          box-sizing: border-box;
        }

        [hidden] {
          display: none !important;
        }

        button,
        input,
        select {
          font: inherit;
        }

        button {
          border: none;
        }

        .shell {
          position: relative;
          overflow: hidden;
          border-radius: 34px;
          border: 1px solid var(--panel-edge);
          background:
            radial-gradient(circle at 0% 0%, rgba(151, 204, 255, 0.28), transparent 24%),
            radial-gradient(circle at 100% 0%, rgba(29, 117, 234, 0.12), transparent 26%),
            linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(243, 248, 255, 0.92));
          box-shadow: var(--shadow);
          padding: 26px;
        }

        .ambient,
        .ambient::before,
        .ambient::after {
          position: absolute;
          pointer-events: none;
          border-radius: 999px;
          filter: blur(4px);
        }

        .ambient {
          inset: 0;
        }

        .ambient::before {
          content: "";
          width: 250px;
          height: 250px;
          top: -40px;
          right: -20px;
          background: radial-gradient(circle, rgba(29, 117, 234, 0.12), transparent 70%);
        }

        .ambient::after {
          content: "";
          width: 180px;
          height: 180px;
          left: -30px;
          bottom: -20px;
          background: radial-gradient(circle, rgba(145, 199, 255, 0.28), transparent 72%);
        }

        .hero {
          position: relative;
          display: grid;
          grid-template-columns: 1fr;
          gap: 20px;
          margin-bottom: 14px;
          animation: rise 420ms ease both;
        }

        .hero-copy,
        .hero-metrics,
        .panel {
          position: relative;
          z-index: 1;
        }

        .hero-copy,
        .hero-metrics,
        .panel {
          border-radius: 28px;
          border: 1px solid rgba(201, 217, 238, 0.88);
          background: var(--panel);
          backdrop-filter: blur(14px);
          box-shadow: 0 20px 40px rgba(40, 80, 135, 0.09);
        }

        .hero-copy {
          padding: 24px;
        }

        .eyebrow,
        .panel-label,
        .mini-badge {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 8px 13px;
          border-radius: 999px;
          background: rgba(29, 117, 234, 0.1);
          color: var(--accent-deep);
          font-size: 0.82rem;
          font-weight: 700;
          letter-spacing: 0.04em;
          text-transform: uppercase;
        }

        .hero-copy h2 {
          margin: 16px 0 10px;
          font-size: clamp(2rem, 3vw, 3rem);
          line-height: 1.04;
          letter-spacing: -0.04em;
        }

        .hero-copy p {
          margin: 0;
          color: var(--muted);
          line-height: 1.55;
          font-size: 0.96rem;
        }

        .ambient,
        .hero-metrics,
        .eyebrow,
        .panel-label,
        .note,
        .footnote {
          display: none;
        }

        .metric {
          padding: 18px;
          border-radius: 22px;
          background: rgba(255, 255, 255, 0.82);
          border: 1px solid rgba(208, 221, 240, 0.84);
        }

        .metric-label {
          display: block;
          color: var(--muted);
          font-size: 0.88rem;
          margin-bottom: 6px;
        }

        .metric strong {
          font-size: 1.8rem;
          line-height: 1;
        }

        .metric small {
          display: block;
          margin-top: 8px;
          color: var(--muted);
          line-height: 1.5;
        }

        .workspace {
          position: relative;
          z-index: 1;
          display: grid;
          grid-template-columns: 1.02fr 1.16fr 0.92fr;
          gap: 16px;
          align-items: start;
        }

        .panel {
          padding: 18px;
          animation: rise 520ms ease both;
        }

        .panel-header {
          display: flex;
          justify-content: space-between;
          gap: 14px;
          align-items: flex-start;
          margin-bottom: 12px;
        }

        .panel-header h3 {
          margin: 0;
          font-size: 1.06rem;
          line-height: 1.15;
        }

        .panel-header p {
          margin: 4px 0 0;
          color: var(--muted);
          line-height: 1.45;
          font-size: 0.9rem;
        }

        .note {
          color: var(--muted);
          font-size: 0.88rem;
          line-height: 1.5;
          text-align: right;
        }

        .dropzone {
          position: relative;
          display: grid;
          justify-items: center;
          text-align: center;
          gap: 10px;
          padding: 24px 16px;
          border-radius: 22px;
          border: 1.5px dashed var(--line-strong);
          background:
            linear-gradient(180deg, rgba(255, 255, 255, 0.94), rgba(240, 247, 255, 0.95));
          transition:
            transform 160ms ease,
            border-color 160ms ease,
            box-shadow 160ms ease,
            background 160ms ease;
        }

        .dropzone.active {
          transform: translateY(-2px);
          border-color: var(--accent);
          box-shadow: 0 18px 32px rgba(29, 117, 234, 0.14);
          background:
            linear-gradient(180deg, rgba(255, 255, 255, 1), rgba(232, 244, 255, 1));
        }

        .dropzone:hover {
          border-color: var(--accent);
        }

        .drop-art {
          position: relative;
          width: 120px;
          height: 82px;
          margin-bottom: 4px;
        }

        .drop-art span {
          position: absolute;
          inset: 0;
          border-radius: 20px;
          border: 1px solid rgba(166, 194, 226, 0.82);
          background: linear-gradient(180deg, #ffffff, #eaf3ff);
          box-shadow: 0 16px 28px rgba(39, 92, 158, 0.08);
        }

        .drop-art span:nth-child(1) {
          transform: rotate(-7deg) translate(-12px, 8px);
          opacity: 0.78;
        }

        .drop-art span:nth-child(2) {
          transform: rotate(8deg) translate(12px, 8px);
          opacity: 0.82;
        }

        .drop-art span:nth-child(3) {
          display: grid;
          place-items: center;
          color: var(--accent);
          font-size: 2rem;
          font-weight: 700;
        }

        .dropzone strong {
          font-size: 1.04rem;
        }

        .dropzone p,
        .micro-copy,
        .footnote {
          margin: 0;
          color: var(--muted);
          line-height: 1.55;
          font-size: 0.92rem;
        }

        .button-row,
        .thumb-actions,
        .camera-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
        }

        .camera-panel {
          margin-top: 12px;
          padding: 12px;
          border-radius: 20px;
          border: 1px solid var(--line);
          background: rgba(255, 255, 255, 0.76);
        }

        .camera-stage {
          position: relative;
          min-height: 220px;
          overflow: hidden;
          border-radius: 18px;
          border: 1px solid rgba(191, 210, 236, 0.9);
          background: linear-gradient(180deg, #f7fbff, #e8f1ff);
          display: grid;
          place-items: center;
          margin-bottom: 12px;
        }

        .camera-video {
          width: 100%;
          height: 100%;
          min-height: 220px;
          object-fit: cover;
          display: block;
          background: #dfe8f6;
        }

        .camera-placeholder {
          display: grid;
          gap: 6px;
          text-align: center;
          color: var(--muted);
          padding: 18px;
        }

        .camera-placeholder strong {
          color: var(--text);
          font-size: 1rem;
        }

        .primary-button,
        .ghost-button,
        .utility-button {
          border-radius: 18px;
          cursor: pointer;
          font-weight: 700;
          transition:
            transform 160ms ease,
            box-shadow 160ms ease,
            opacity 160ms ease,
            background-color 160ms ease,
            border-color 160ms ease;
        }

        .primary-button:hover,
        .ghost-button:hover,
        .utility-button:hover {
          transform: translateY(-1px);
        }

        .primary-button:disabled,
        .ghost-button:disabled,
        .utility-button:disabled {
          opacity: 0.55;
          cursor: not-allowed;
          transform: none;
          box-shadow: none;
        }

        .primary-button {
          padding: 14px 22px;
          color: #ffffff;
          background: linear-gradient(180deg, var(--accent), #0e63d8);
          box-shadow: 0 18px 28px rgba(29, 117, 234, 0.24);
        }

        .primary-button.wide {
          width: 100%;
        }

        .ghost-button,
        .utility-button {
          padding: 12px 16px;
          color: var(--text);
          background: linear-gradient(180deg, #ffffff, #edf5ff);
          border: 1px solid var(--line);
        }

        .utility-button {
          padding: 8px 12px;
          border-radius: 14px;
          font-size: 0.84rem;
          font-weight: 600;
        }

        .status {
          margin-top: 12px;
          padding: 12px 14px;
          border-radius: 16px;
          border: 1px solid transparent;
          font-size: 0.9rem;
          line-height: 1.5;
        }

        .status.info {
          background: #f3f8ff;
          border-color: #d7e6fa;
          color: #3d5b7d;
        }

        .status.success {
          background: #edf9f2;
          border-color: #c5ebd3;
          color: #1c6b3c;
        }

        .status.error {
          background: #fff2f2;
          border-color: #f3c8c8;
          color: #8f2f2f;
        }

        .status.working {
          background: #eff6ff;
          border-color: #c8dcfd;
          color: #2357a6;
        }

        .preview-stage {
          position: relative;
          min-height: 330px;
          border-radius: 26px;
          overflow: hidden;
          border: 1px solid var(--line);
          background:
            linear-gradient(180deg, rgba(255, 255, 255, 0.94), rgba(240, 247, 255, 0.92));
          display: grid;
          place-items: center;
          margin-bottom: 16px;
        }

        .empty-preview {
          display: grid;
          gap: 10px;
          justify-items: center;
          text-align: center;
          padding: 26px;
          color: var(--muted);
        }

        .empty-spot {
          width: 86px;
          height: 86px;
          border-radius: 28px;
          background: linear-gradient(180deg, #f7fbff, #dfeefe);
          border: 1px solid var(--line);
          box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.8);
          position: relative;
        }

        .empty-spot::before,
        .empty-spot::after {
          content: "";
          position: absolute;
          background: rgba(29, 117, 234, 0.2);
        }

        .empty-spot::before {
          width: 30px;
          height: 4px;
          border-radius: 999px;
          top: 41px;
          left: 28px;
        }

        .empty-spot::after {
          width: 4px;
          height: 30px;
          border-radius: 999px;
          top: 28px;
          left: 41px;
        }

        .preview-image {
          width: 100%;
          max-height: 540px;
          object-fit: contain;
          display: block;
        }

        .preview-meta {
          position: absolute;
          left: 16px;
          right: 16px;
          bottom: 16px;
          display: flex;
          justify-content: space-between;
          gap: 16px;
          align-items: flex-end;
          padding: 16px 18px;
          border-radius: 20px;
          background: rgba(9, 19, 33, 0.72);
          color: #f4f8ff;
          backdrop-filter: blur(10px);
        }

        .preview-meta strong {
          display: block;
          font-size: 1rem;
          margin-bottom: 4px;
        }

        .preview-meta span {
          color: rgba(231, 240, 255, 0.8);
          font-size: 0.9rem;
        }

        .thumb-grid {
          display: grid;
          gap: 12px;
          max-height: 440px;
          overflow: auto;
          padding-right: 2px;
        }

        .thumb-card {
          display: grid;
          grid-template-columns: 96px minmax(0, 1fr);
          gap: 12px;
          padding: 12px;
          border-radius: 22px;
          border: 1px solid var(--line);
          background: rgba(255, 255, 255, 0.86);
          transition:
            transform 150ms ease,
            border-color 150ms ease,
            box-shadow 150ms ease;
        }

        .thumb-card.active {
          border-color: rgba(29, 117, 234, 0.48);
          box-shadow: 0 14px 24px rgba(29, 117, 234, 0.12);
        }

        .thumb-card.drag-target {
          border-color: var(--accent);
          box-shadow: 0 14px 24px rgba(29, 117, 234, 0.18);
        }

        .thumb-card:hover {
          transform: translateY(-1px);
        }

        .thumb-image-button {
          appearance: none;
          width: 100%;
          min-height: 90px;
          padding: 0;
          border-radius: 18px;
          overflow: hidden;
          cursor: pointer;
          border: 1px solid rgba(191, 210, 236, 0.8);
          background: #edf4ff;
        }

        .thumb-image-button img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
        }

        .thumb-body {
          min-width: 0;
          display: grid;
          gap: 8px;
          align-content: start;
        }

        .thumb-title-row {
          display: flex;
          align-items: center;
          gap: 10px;
          min-width: 0;
        }

        .order-pill {
          display: inline-flex;
          min-width: 34px;
          justify-content: center;
          padding: 7px 9px;
          border-radius: 999px;
          background: var(--soft-blue);
          color: var(--accent-deep);
          font-size: 0.8rem;
          font-weight: 700;
        }

        .thumb-name {
          min-width: 0;
          font-weight: 700;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .thumb-details {
          color: var(--muted);
          font-size: 0.88rem;
        }

        .field-stack {
          display: grid;
          gap: 12px;
        }

        .field-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 12px;
        }

        .field {
          display: grid;
          gap: 8px;
          color: var(--text);
          font-weight: 600;
          font-size: 0.95rem;
        }

        .field span.inline-value {
          color: var(--muted);
          font-weight: 500;
          margin-left: 6px;
        }

        .field input[type="text"],
        .field select {
          width: 100%;
          padding: 14px 16px;
          border-radius: 18px;
          border: 1px solid var(--line);
          background: rgba(255, 255, 255, 0.9);
          color: var(--text);
          outline: none;
          transition:
            border-color 150ms ease,
            box-shadow 150ms ease;
        }

        .field input[type="text"]:focus,
        .field select:focus {
          border-color: rgba(29, 117, 234, 0.48);
          box-shadow: 0 0 0 4px rgba(29, 117, 234, 0.12);
        }

        .field input[type="range"] {
          width: 100%;
          accent-color: var(--accent);
        }

        .summary-card {
          padding: 16px;
          border-radius: 22px;
          border: 1px solid var(--line);
          background: linear-gradient(180deg, #ffffff, #edf5ff);
        }

        .summary-card h4 {
          margin: 0 0 12px;
          font-size: 0.96rem;
        }

        .summary-row {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          align-items: center;
          padding: 8px 0;
          color: var(--muted);
          border-top: 1px solid rgba(215, 229, 246, 0.85);
        }

        .summary-row:first-of-type {
          padding-top: 0;
          border-top: none;
        }

        .summary-row strong {
          color: var(--text);
          text-align: right;
        }

        .footnote {
          margin-top: 12px;
          font-size: 0.9rem;
        }

        @keyframes rise {
          from {
            opacity: 0;
            transform: translateY(12px);
          }

          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        @media (max-width: 1160px) {
          .workspace {
            grid-template-columns: 1fr 1fr;
          }

          .controls-panel {
            grid-column: 1 / -1;
          }
        }

        @media (max-width: 860px) {
          .shell {
            padding: 16px;
            border-radius: 26px;
          }

          .hero,
          .workspace {
            grid-template-columns: 1fr;
          }

          .hero-copy,
          .hero-metrics,
          .panel {
            border-radius: 24px;
          }

          .field-grid {
            grid-template-columns: 1fr;
          }
        }

        @media (max-width: 560px) {
          .panel,
          .hero-copy,
          .hero-metrics {
            padding: 16px;
          }

          .preview-stage {
            min-height: 260px;
          }

          .thumb-card {
            grid-template-columns: 1fr;
          }

          .thumb-image-button {
            min-height: 170px;
          }

          .preview-meta {
            position: static;
            margin: 12px;
            border-radius: 18px;
          }

          .panel-header {
            flex-direction: column;
          }

          .note {
            text-align: left;
          }
        }
      </style>

      <section class="shell">
        <div class="ambient" aria-hidden="true"></div>

        <div class="hero">
          <article class="hero-copy">
            <span class="eyebrow">Photo To PDF</span>
            <h2 id="heading"></h2>
            <p id="subheading"></p>
          </article>

          <aside class="hero-metrics">
            <div class="metric">
              <span class="metric-label">Pages queued</span>
              <strong id="metricCount">0</strong>
              <small>Each image becomes one neatly arranged PDF page.</small>
            </div>

            <div class="metric">
              <span class="metric-label">Current paper size</span>
              <strong id="metricPage">A4</strong>
              <small id="metricLayout">Auto orientation with balanced spacing.</small>
            </div>

            <div class="metric">
              <span class="metric-label">Processing mode</span>
              <strong>Browser only</strong>
              <small>Your images stay on the page while the PDF is generated.</small>
            </div>
          </aside>
        </div>

        <div class="workspace">
          <section class="panel upload-panel">
            <div class="panel-header">
              <div>
                <span class="panel-label">Upload</span>
                <h3>Upload</h3>
                <p>Drag and drop or click to browse.</p>
              </div>
            </div>

            <div class="dropzone" id="dropzone">
              <input id="fileInput" type="file" accept="image/*" multiple hidden />
              <input id="cameraInput" type="file" accept="image/*" capture="environment" hidden />
              <div class="drop-art" aria-hidden="true">
                <span></span>
                <span></span>
                <span>+</span>
              </div>
              <strong>Add photos</strong>
              <p>Drag and drop or click to browse.</p>
              <div class="button-row">
                <button id="pickButton" class="primary-button" type="button">Add photos</button>
                <button id="cameraButton" class="ghost-button" type="button">Take photo</button>
                <button id="clearButton" class="ghost-button" type="button">Clear</button>
              </div>
              <p class="micro-copy" id="uploadSummary">No images added.</p>
            </div>

            <div id="status" class="status info" role="status" aria-live="polite"></div>
          </section>

          <section class="panel preview-panel">
            <div class="panel-header">
              <div>
                <span class="panel-label">Queue</span>
                <h3>Pages</h3>
                <p>Select, drag, and reorder.</p>
              </div>
              <div class="note">The first card becomes page one in your PDF.</div>
            </div>

            <div class="preview-stage">
              <div id="emptyPreview" class="empty-preview">
                <div class="empty-spot" aria-hidden="true"></div>
                <strong>Preview</strong>
                <p>Add or select a photo.</p>
              </div>

              <img id="previewImage" class="preview-image" alt="Selected image preview" hidden />

              <div id="previewMeta" class="preview-meta" hidden>
                <div>
                  <strong id="previewName"></strong>
                  <span id="previewDetails"></span>
                </div>
                <span class="mini-badge" id="previewOrder"></span>
              </div>
            </div>

            <div id="thumbnailList" class="thumb-grid"></div>
          </section>

          <section class="panel controls-panel">
            <div class="panel-header">
              <div>
                <span class="panel-label">Export</span>
                <h3>Export</h3>
                <p>Adjust the settings and download.</p>
              </div>
            </div>

            <div class="field-stack">
              <label class="field">
                <span>File name</span>
                <input id="filenameInput" type="text" value="photo-stack" placeholder="photo-stack" />
              </label>

              <div class="field-grid">
                <label class="field">
                  <span>Page size</span>
                  <select id="pageSizeSelect">
                    <option value="a4">A4</option>
                    <option value="letter">Letter</option>
                    <option value="a5">A5</option>
                  </select>
                </label>

                <label class="field">
                  <span>Orientation</span>
                  <select id="orientationSelect">
                    <option value="auto">Auto</option>
                    <option value="portrait">Portrait</option>
                    <option value="landscape">Landscape</option>
                  </select>
                </label>
              </div>

              <label class="field">
                <span>Margin <span id="marginValue" class="inline-value">24 pt</span></span>
                <input id="marginInput" type="range" min="0" max="48" value="24" />
              </label>

              <label class="field">
                <span>Image quality <span id="qualityValue" class="inline-value">90%</span></span>
                <input id="qualityInput" type="range" min="55" max="100" value="90" />
              </label>

              <div class="summary-card">
                <h4>Summary</h4>
                <div class="summary-row">
                  <span>Pages</span>
                  <strong id="summaryPages">0</strong>
                </div>
                <div class="summary-row">
                  <span>Layout</span>
                  <strong id="summaryLayout">A4 • Auto</strong>
                </div>
                <div class="summary-row">
                  <span>Margin</span>
                  <strong id="summaryMargin">24 pt</strong>
                </div>
                <div class="summary-row">
                  <span>Quality</span>
                  <strong id="summaryQuality">90%</strong>
                </div>
              </div>

              <button id="generateButton" class="primary-button wide" type="button">Download PDF</button>
            </div>

            <p class="footnote">This single-file widget loads the PDF engine automatically when needed.</p>
          </section>
        </div>
      </section>
    `;
  }

  cacheElements() {
    this.refs = {
      heading: this.shadowRoot.getElementById("heading"),
      subheading: this.shadowRoot.getElementById("subheading"),
      fileInput: this.shadowRoot.getElementById("fileInput"),
      cameraInput: this.shadowRoot.getElementById("cameraInput"),
      dropzone: this.shadowRoot.getElementById("dropzone"),
      pickButton: this.shadowRoot.getElementById("pickButton"),
      cameraButton: this.shadowRoot.getElementById("cameraButton"),
      clearButton: this.shadowRoot.getElementById("clearButton"),
      uploadSummary: this.shadowRoot.getElementById("uploadSummary"),
      status: this.shadowRoot.getElementById("status"),
      previewImage: this.shadowRoot.getElementById("previewImage"),
      emptyPreview: this.shadowRoot.getElementById("emptyPreview"),
      previewMeta: this.shadowRoot.getElementById("previewMeta"),
      previewName: this.shadowRoot.getElementById("previewName"),
      previewDetails: this.shadowRoot.getElementById("previewDetails"),
      previewOrder: this.shadowRoot.getElementById("previewOrder"),
      thumbnailList: this.shadowRoot.getElementById("thumbnailList"),
      filenameInput: this.shadowRoot.getElementById("filenameInput"),
      pageSizeSelect: this.shadowRoot.getElementById("pageSizeSelect"),
      orientationSelect: this.shadowRoot.getElementById("orientationSelect"),
      marginInput: this.shadowRoot.getElementById("marginInput"),
      marginValue: this.shadowRoot.getElementById("marginValue"),
      qualityInput: this.shadowRoot.getElementById("qualityInput"),
      qualityValue: this.shadowRoot.getElementById("qualityValue"),
      summaryPages: this.shadowRoot.getElementById("summaryPages"),
      summaryLayout: this.shadowRoot.getElementById("summaryLayout"),
      summaryMargin: this.shadowRoot.getElementById("summaryMargin"),
      summaryQuality: this.shadowRoot.getElementById("summaryQuality"),
      metricCount: this.shadowRoot.getElementById("metricCount"),
      metricPage: this.shadowRoot.getElementById("metricPage"),
      metricLayout: this.shadowRoot.getElementById("metricLayout"),
      generateButton: this.shadowRoot.getElementById("generateButton"),
    };
  }

  bindEvents() {
    this.refs.pickButton.addEventListener("click", () => this.refs.fileInput.click());
    this.refs.cameraButton.addEventListener("click", () => this.refs.cameraInput.click());
    this.refs.dropzone.addEventListener("click", (event) => {
      if (event.target.closest("button")) {
        return;
      }

      this.refs.fileInput.click();
    });

    this.refs.fileInput.addEventListener("change", async (event) => {
      const files = Array.from(event.target.files || []);
      event.target.value = "";
      await this.handleFiles(files);
    });

    this.refs.cameraInput.addEventListener("change", async (event) => {
      const files = Array.from(event.target.files || []);
      event.target.value = "";
      await this.handleFiles(files);
    });

    this.refs.clearButton.addEventListener("click", () => this.clearAll());
    this.refs.generateButton.addEventListener("click", () => this.generatePdf());

    for (const eventName of ["dragenter", "dragover"]) {
      this.refs.dropzone.addEventListener(eventName, (event) => this.onDragEnter(event));
    }

    for (const eventName of ["dragleave", "dragend"]) {
      this.refs.dropzone.addEventListener(eventName, (event) => this.onDragLeave(event));
    }

    this.refs.dropzone.addEventListener("drop", async (event) => this.onDrop(event));

    this.refs.thumbnailList.addEventListener("click", (event) => {
      const trigger = event.target.closest("[data-action]");
      if (!trigger) {
        return;
      }

      const action = trigger.dataset.action;
      const itemId = trigger.dataset.id;
      if (!itemId) {
        return;
      }

      if (action === "select") {
        this.state.activeId = itemId;
      } else if (action === "remove") {
        this.removeItem(itemId);
      } else if (action === "up") {
        this.moveByOffset(itemId, -1);
      } else if (action === "down") {
        this.moveByOffset(itemId, 1);
      }

      this.render();
    });

    this.refs.thumbnailList.addEventListener("dragstart", (event) => {
      const card = event.target.closest(".thumb-card");
      if (!card) {
        return;
      }

      this.draggedId = card.dataset.id || null;
      if (event.dataTransfer && this.draggedId) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", this.draggedId);
      }
    });

    this.refs.thumbnailList.addEventListener("dragover", (event) => {
      if (!this.draggedId) {
        return;
      }

      event.preventDefault();
      const card = event.target.closest(".thumb-card");
      this.highlightDragTarget(card);
    });

    this.refs.thumbnailList.addEventListener("drop", (event) => {
      event.preventDefault();
      const card = event.target.closest(".thumb-card");
      const targetId = card?.dataset.id;
      if (!this.draggedId || !targetId || this.draggedId === targetId) {
        this.resetDragState();
        return;
      }

      this.moveBefore(this.draggedId, targetId);
      this.resetDragState();
      this.render();
    });

    this.refs.thumbnailList.addEventListener("dragend", () => {
      this.resetDragState();
    });

    for (const control of [
      this.refs.filenameInput,
      this.refs.pageSizeSelect,
      this.refs.orientationSelect,
      this.refs.marginInput,
      this.refs.qualityInput,
    ]) {
      control.addEventListener("input", () => this.renderSummaryOnly());
      control.addEventListener("change", () => this.renderSummaryOnly());
    }

    this.refs.filenameInput.addEventListener("input", this.handleFilenameInput);
  }

  applyAttributes() {
    const heading = this.getAttribute("heading") || "Photo to PDF";
    const subheading = this.getAttribute("subheading") || "Upload, reorder, and download.";
    const filename = this.getAttribute("filename") || "photo-stack";
    const accent = this.getAttribute("accent");

    this.refs.heading.textContent = heading;
    this.refs.subheading.textContent = subheading;

    if (!this.refs.filenameInput.value || this.refs.filenameInput.dataset.autoManaged !== "false") {
      this.refs.filenameInput.value = filename;
      this.refs.filenameInput.dataset.autoManaged = "true";
    }

    this.style.setProperty("--accent", accent || "#1d75ea");
  }

  onDragEnter(event) {
    if (!event.dataTransfer || !Array.from(event.dataTransfer.types || []).includes("Files")) {
      return;
    }

    event.preventDefault();
    this.dragDepth += 1;
    this.refs.dropzone.classList.add("active");
  }

  onDragLeave(event) {
    if (!event.dataTransfer || !Array.from(event.dataTransfer.types || []).includes("Files")) {
      return;
    }

    event.preventDefault();
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) {
      this.refs.dropzone.classList.remove("active");
    }
  }

  async onDrop(event) {
    event.preventDefault();
    this.dragDepth = 0;
    this.refs.dropzone.classList.remove("active");
    const files = Array.from(event.dataTransfer?.files || []);
    await this.handleFiles(files);
  }

  async handleFiles(files) {
    if (!files.length) {
      return;
    }

    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    const skipped = files.length - imageFiles.length;

    if (!imageFiles.length) {
      this.setStatus("Choose image files only.", "error");
      return;
    }

    this.state.busy = true;
    this.render();
    this.setStatus(`Loading ${imageFiles.length} image${imageFiles.length === 1 ? "" : "s"}...`, "working");
    await waitForPaint();

    const results = await Promise.allSettled(imageFiles.map((file) => this.createItem(file)));
    const loadedItems = [];
    let failedCount = 0;

    for (const result of results) {
      if (result.status === "fulfilled") {
        loadedItems.push(result.value);
      } else {
        failedCount += 1;
      }
    }

    this.state.items.push(...loadedItems);
    if (!this.state.activeId && loadedItems.length) {
      this.state.activeId = loadedItems[0].id;
    }

    this.state.busy = false;
    this.render();

    const parts = [];
    parts.push(`${loadedItems.length} photo${loadedItems.length === 1 ? "" : "s"} added.`);
    if (skipped > 0) {
      parts.push(`${skipped} skipped.`);
    }
    if (failedCount > 0) {
      parts.push(`${failedCount} failed.`);
    }

    this.setStatus(parts.join(" "), failedCount > 0 ? "info" : "success");
  }

  async createItem(file) {
    const objectUrl = URL.createObjectURL(file);

    try {
      const image = await loadImage(objectUrl);
      return {
        id: makeId(),
        file,
        name: file.name,
        size: file.size,
        width: image.naturalWidth,
        height: image.naturalHeight,
        objectUrl,
      };
    } catch (error) {
      URL.revokeObjectURL(objectUrl);
      throw error;
    }
  }

  clearAll() {
    for (const item of this.state.items) {
      URL.revokeObjectURL(item.objectUrl);
    }

    this.state.items = [];
    this.state.activeId = null;
    this.render();
    this.setStatus("All photos removed.", "info");
  }

  removeItem(itemId) {
    const index = this.state.items.findIndex((item) => item.id === itemId);
    if (index === -1) {
      return;
    }

    const [removed] = this.state.items.splice(index, 1);
    URL.revokeObjectURL(removed.objectUrl);

    if (this.state.activeId === itemId) {
      this.state.activeId = this.state.items[Math.max(0, index - 1)]?.id || this.state.items[0]?.id || null;
    }

    this.setStatus("Photo removed.", "info");
  }

  moveByOffset(itemId, offset) {
    const index = this.state.items.findIndex((item) => item.id === itemId);
    const targetIndex = index + offset;
    if (index === -1 || targetIndex < 0 || targetIndex >= this.state.items.length) {
      return;
    }

    const [item] = this.state.items.splice(index, 1);
    this.state.items.splice(targetIndex, 0, item);
  }

  moveBefore(sourceId, targetId) {
    const fromIndex = this.state.items.findIndex((item) => item.id === sourceId);
    const toIndex = this.state.items.findIndex((item) => item.id === targetId);

    if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) {
      return;
    }

    const [item] = this.state.items.splice(fromIndex, 1);
    const adjustedIndex = fromIndex < toIndex ? toIndex - 1 : toIndex;
    this.state.items.splice(adjustedIndex, 0, item);
  }

  highlightDragTarget(card) {
    const cards = this.refs.thumbnailList.querySelectorAll(".thumb-card");
    for (const item of cards) {
      item.classList.toggle("drag-target", item === card);
    }
  }

  resetDragState() {
    this.draggedId = null;
    this.highlightDragTarget(null);
  }

  getSettings() {
    return {
      filename: sanitizeFileName(this.refs.filenameInput.value) || "photo-stack",
      pageSize: this.refs.pageSizeSelect.value,
      orientation: this.refs.orientationSelect.value,
      margin: clamp(Number(this.refs.marginInput.value), 0, 48),
      quality: clamp(Number(this.refs.qualityInput.value) / 100, 0.55, 1),
    };
  }

  getActiveItem() {
    return this.state.items.find((item) => item.id === this.state.activeId) || this.state.items[0] || null;
  }

  setStatus(message, tone = "info") {
    this.state.statusMessage = message;
    this.state.statusTone = tone;
    this.refs.status.textContent = message;
    this.refs.status.className = `status ${tone}`;
  }

  render() {
    const active = this.getActiveItem();
    if (active && this.state.activeId !== active.id) {
      this.state.activeId = active.id;
    }

    this.refs.pickButton.disabled = this.state.busy;
    this.refs.clearButton.disabled = this.state.items.length === 0 || this.state.busy;
    this.refs.generateButton.disabled = this.state.items.length === 0 || this.state.busy;
    this.refs.cameraButton.disabled = this.state.busy;
    this.refs.pickButton.textContent = this.state.items.length ? "Add more" : "Add photos";
    this.refs.cameraButton.textContent = "Take photo";
    this.refs.generateButton.textContent = this.state.busy ? "Working..." : "Download PDF";

    this.renderPreview(active);
    this.renderThumbnailList();
    this.renderSummaryOnly();
    this.refs.status.textContent = this.state.statusMessage;
    this.refs.status.className = `status ${this.state.statusTone}`;

    const totalBytes = this.state.items.reduce((sum, item) => sum + item.size, 0);
    this.refs.uploadSummary.textContent = this.state.items.length
      ? `${this.state.items.length} image${this.state.items.length === 1 ? "" : "s"} / ${formatBytes(totalBytes)}`
      : "No images added.";
  }

  renderPreview(active) {
    if (!active) {
      this.refs.emptyPreview.hidden = false;
      this.refs.previewImage.hidden = true;
      this.refs.previewMeta.hidden = true;
      this.refs.previewImage.removeAttribute("src");
      return;
    }

    const pageNumber = this.state.items.findIndex((item) => item.id === active.id) + 1;
    this.refs.emptyPreview.hidden = true;
    this.refs.previewImage.hidden = false;
    this.refs.previewMeta.hidden = false;
    this.refs.previewImage.src = active.objectUrl;
    this.refs.previewName.textContent = active.name;
    this.refs.previewDetails.textContent = `${active.width} x ${active.height} px / ${formatBytes(active.size)}`;
    this.refs.previewOrder.textContent = `Page ${pageNumber}`;
  }

  renderThumbnailList() {
    if (!this.state.items.length) {
      this.refs.thumbnailList.innerHTML = "";
      return;
    }

    this.refs.thumbnailList.innerHTML = this.state.items
      .map((item, index) => {
        const isActive = item.id === this.state.activeId;
        return `
          <article class="thumb-card ${isActive ? "active" : ""}" data-id="${item.id}" draggable="true">
            <button class="thumb-image-button" type="button" data-action="select" data-id="${item.id}">
              <img src="${item.objectUrl}" alt="${escapeHtml(item.name)}" />
            </button>
            <div class="thumb-body">
              <div class="thumb-title-row">
                <span class="order-pill">${String(index + 1).padStart(2, "0")}</span>
                <div class="thumb-name">${escapeHtml(item.name)}</div>
              </div>
              <div class="thumb-details">${item.width} x ${item.height} px / ${formatBytes(item.size)}</div>
              <div class="thumb-actions">
                <button class="utility-button" type="button" data-action="select" data-id="${item.id}">Preview</button>
                <button class="utility-button" type="button" data-action="up" data-id="${item.id}" ${index === 0 ? "disabled" : ""}>Up</button>
                <button class="utility-button" type="button" data-action="down" data-id="${item.id}" ${index === this.state.items.length - 1 ? "disabled" : ""}>Down</button>
                <button class="utility-button" type="button" data-action="remove" data-id="${item.id}">Remove</button>
              </div>
            </div>
          </article>
        `;
      })
      .join("");
  }

  renderSummaryOnly() {
    const settings = this.getSettings();
    const pageLabel = PAGE_LABELS[settings.pageSize] || settings.pageSize.toUpperCase();
    const orientationLabel =
      settings.orientation === "auto"
        ? "Auto"
        : settings.orientation === "portrait"
          ? "Portrait"
          : "Landscape";

    this.refs.marginValue.textContent = `${settings.margin} pt`;
    this.refs.qualityValue.textContent = `${Math.round(settings.quality * 100)}%`;
    this.refs.summaryPages.textContent = String(this.state.items.length);
    this.refs.summaryLayout.textContent = `${pageLabel} / ${orientationLabel}`;
    this.refs.summaryMargin.textContent = `${settings.margin} pt`;
    this.refs.summaryQuality.textContent = `${Math.round(settings.quality * 100)}%`;
    this.refs.metricCount.textContent = String(this.state.items.length);
    this.refs.metricPage.textContent = pageLabel;
    this.refs.metricLayout.textContent =
      orientationLabel === "Auto"
        ? "Auto orientation with balanced spacing."
        : `${orientationLabel} pages with balanced spacing.`;
  }

  async prepareImageForPdf(item, quality) {
    const image = await loadImage(item.objectUrl);
    const maxDimension = 2400;
    const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);

    return {
      width,
      height,
      dataUrl: canvas.toDataURL("image/jpeg", quality),
    };
  }

  async generatePdf() {
    if (!this.state.items.length || this.state.busy) {
      return;
    }

    this.state.busy = true;
    this.render();
    this.setStatus("Loading PDF engine...", "working");
    await waitForPaint();

    try {
      const jsPDF = await ensureJsPdf();
      const settings = this.getSettings();
      let documentRef = null;

      for (let index = 0; index < this.state.items.length; index += 1) {
        const item = this.state.items[index];
        const orientation =
          settings.orientation === "auto"
            ? item.width >= item.height
              ? "landscape"
              : "portrait"
            : settings.orientation;

        this.setStatus(`Page ${index + 1} of ${this.state.items.length}...`, "working");
        await waitForPaint();

        if (!documentRef) {
          documentRef = new jsPDF({
            orientation,
            unit: "pt",
            format: settings.pageSize,
            compress: true,
          });
        } else {
          documentRef.addPage(settings.pageSize, orientation);
        }

        const prepared = await this.prepareImageForPdf(item, settings.quality);
        const pageWidth = documentRef.internal.pageSize.getWidth();
        const pageHeight = documentRef.internal.pageSize.getHeight();
        const margin = settings.margin;
        const boxWidth = pageWidth - margin * 2;
        const boxHeight = pageHeight - margin * 2;
        const scale = Math.min(boxWidth / prepared.width, boxHeight / prepared.height);
        const renderWidth = prepared.width * scale;
        const renderHeight = prepared.height * scale;
        const offsetX = (pageWidth - renderWidth) / 2;
        const offsetY = (pageHeight - renderHeight) / 2;

        documentRef.setFillColor(255, 255, 255);
        documentRef.rect(0, 0, pageWidth, pageHeight, "F");
        documentRef.addImage(prepared.dataUrl, "JPEG", offsetX, offsetY, renderWidth, renderHeight, undefined, "FAST");
      }

      const outputName = `${settings.filename}.pdf`;
      documentRef.save(outputName);
      this.setStatus(`PDF ready: ${outputName}`, "success");
    } catch (error) {
      console.error(error);
      this.setStatus(error?.message || "Could not create the PDF.", "error");
    } finally {
      this.state.busy = false;
      this.render();
    }
  }
}

function definePhotoPdfConverter() {
  if (!window.customElements.get("photo-pdf-converter")) {
    window.customElements.define("photo-pdf-converter", PhotoPdfConverter);
  }

  return "photo-pdf-converter";
}

function mountPhotoPdfConverter(target, options = {}) {
  definePhotoPdfConverter();

  const host = typeof target === "string" ? document.querySelector(target) : target;
  if (!host) {
    throw new Error("Could not find the target element for the photo PDF converter.");
  }

  const widget = document.createElement("photo-pdf-converter");
  const supportedAttributes = ["heading", "subheading", "filename", "accent"];

  for (const attributeName of supportedAttributes) {
    const value = options[attributeName];
    if (value !== undefined && value !== null && value !== "") {
      widget.setAttribute(attributeName, String(value));
    }
  }

  host.appendChild(widget);
  return widget;
}

definePhotoPdfConverter();

window.PhotoPdfConverterWidget = Object.freeze({
  tagName: "photo-pdf-converter",
  define: definePhotoPdfConverter,
  mount: mountPhotoPdfConverter,
});
