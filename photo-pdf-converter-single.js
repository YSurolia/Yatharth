let jsPdfLoader;

const PAGE_LABELS = {
  a4: "A4",
  letter: "Letter",
  a5: "A5",
};

const IMAGE_FILE_NAME_PATTERN = /\.(avif|bmp|gif|heic|heif|jfif|jpeg|jpg|png|webp)$/i;

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

function isImageLikeFile(file) {
  if (!file) {
    return false;
  }

  if (typeof file.type === "string" && file.type.startsWith("image/")) {
    return true;
  }

  return IMAGE_FILE_NAME_PATTERN.test(file.name || "");
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
    this.stopCameraStream();
    if (this._onCameraKeydown) {
      document.removeEventListener("keydown", this._onCameraKeydown);
    }
    if (this._cameraTrayUrls) {
      for (const url of this._cameraTrayUrls) {
        URL.revokeObjectURL(url);
      }
      this._cameraTrayUrls = [];
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
          --accent: ${this.getAttribute("accent") || "#1583ff"};
          --accent-deep: #0b5bc8;
          --text: #132948;
          --muted: #627792;
          --panel-edge: rgba(176, 197, 226, 0.6);
          --line: rgba(175, 198, 227, 0.62);
          --line-strong: rgba(84, 130, 200, 0.46);
          --soft-blue: rgba(21, 131, 255, 0.1);
          --shadow: 0 32px 80px rgba(15, 38, 71, 0.2);
          display: block;
          color: var(--text);
          font-family: "Plus Jakarta Sans", "Segoe UI", sans-serif;
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

        :focus-visible {
          outline: 3px solid rgba(21, 131, 255, 0.22);
          outline-offset: 2px;
        }

        .shell {
          position: relative;
          overflow: hidden;
          border-radius: 36px;
          border: 1px solid rgba(176, 197, 226, 0.35);
          background:
            radial-gradient(900px 360px at -10% -20%, rgba(21, 131, 255, 0.1), transparent 60%),
            radial-gradient(700px 320px at 110% -10%, rgba(129, 227, 255, 0.12), transparent 60%),
            linear-gradient(180deg, #f3f7fc 0%, #e8eef7 100%);
          box-shadow: var(--shadow);
          padding: 28px;
        }

        .shell::before {
          content: "";
          position: absolute;
          inset: 0;
          background:
            linear-gradient(rgba(21, 131, 255, 0.04) 1px, transparent 1px),
            linear-gradient(90deg, rgba(21, 131, 255, 0.04) 1px, transparent 1px);
          background-size: 100% 92px, 92px 100%;
          mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0.5), transparent 70%);
          pointer-events: none;
        }

        .hero {
          position: relative;
          z-index: 1;
          display: grid;
          grid-template-columns: minmax(0, 1.2fr) minmax(260px, 0.9fr);
          gap: 18px;
          margin-bottom: 22px;
          animation: rise 420ms ease both;
        }

        .hero-copy,
        .hero-metrics,
        .panel {
          position: relative;
          z-index: 1;
          border-radius: 30px;
        }

        .hero-copy,
        .hero-metrics {
          color: #f5f9ff;
          border: 1px solid rgba(255, 255, 255, 0.08);
          background:
            radial-gradient(circle at top left, rgba(73, 154, 255, 0.32), transparent 55%),
            radial-gradient(circle at bottom right, rgba(129, 227, 255, 0.18), transparent 60%),
            linear-gradient(180deg, #0e2240 0%, #081628 100%);
          box-shadow: 0 24px 50px rgba(8, 22, 40, 0.35);
        }

        .hero-copy {
          padding: 28px;
        }

        .hero-metrics {
          display: grid;
          gap: 12px;
          padding: 20px;
          align-content: start;
        }

        .panel {
          border: 1px solid var(--panel-edge);
          background: linear-gradient(180deg, rgba(255, 255, 255, 0.88), rgba(247, 250, 255, 0.96));
          box-shadow: 0 20px 42px rgba(18, 48, 86, 0.1);
          padding: 20px;
          animation: rise 520ms ease both;
        }

        .eyebrow,
        .panel-label,
        .mini-badge {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 8px 13px;
          border-radius: 999px;
          font-size: 0.8rem;
          font-weight: 800;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }

        .eyebrow {
          background: rgba(130, 201, 255, 0.18);
          color: #e8f4ff;
        }

        .panel-label {
          background: rgba(21, 131, 255, 0.1);
          border: 1px solid rgba(21, 131, 255, 0.12);
          color: var(--accent-deep);
        }

        .mini-badge {
          background: rgba(255, 255, 255, 0.12);
          color: #f5f9ff;
          border: 1px solid rgba(255, 255, 255, 0.12);
        }

        .hero-copy h2 {
          margin: 18px 0 12px;
          font-family: "Sora", "Plus Jakarta Sans", sans-serif;
          font-size: clamp(2.2rem, 3vw, 3.35rem);
          line-height: 0.98;
          letter-spacing: -0.06em;
          max-width: 12ch;
        }

        .hero-copy p {
          margin: 0;
          max-width: 52ch;
          color: rgba(230, 239, 255, 0.8);
          line-height: 1.7;
          font-size: 0.98rem;
        }

        .hero-points {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          margin-top: 22px;
        }

        .hero-points span {
          display: inline-flex;
          align-items: center;
          padding: 10px 14px;
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.12);
          background: rgba(255, 255, 255, 0.08);
          color: #f7fbff;
          font-size: 0.82rem;
        }

        .metric {
          padding: 16px 18px;
          border-radius: 22px;
          background: rgba(255, 255, 255, 0.08);
          border: 1px solid rgba(255, 255, 255, 0.12);
        }

        .metric-label {
          display: block;
          color: rgba(230, 239, 255, 0.72);
          font-size: 0.88rem;
          margin-bottom: 6px;
        }

        .metric strong {
          display: block;
          color: #f7fbff;
          font-size: 1.95rem;
          line-height: 1;
        }

        .metric small {
          display: block;
          margin-top: 8px;
          color: rgba(230, 239, 255, 0.72);
          line-height: 1.5;
        }

        .workspace {
          position: relative;
          z-index: 1;
          display: grid;
          grid-template-columns: minmax(280px, 0.96fr) minmax(340px, 1.14fr) minmax(270px, 0.9fr);
          gap: 18px;
          align-items: start;
        }

        .controls-panel {
          position: sticky;
          top: 18px;
        }

        .panel-header {
          display: flex;
          justify-content: space-between;
          gap: 14px;
          align-items: flex-start;
          margin-bottom: 14px;
        }

        .panel-header h3 {
          margin: 0;
          font-size: 1.06rem;
          line-height: 1.15;
        }

        .panel-header p {
          margin: 8px 0 0;
          color: var(--muted);
          line-height: 1.55;
          font-size: 0.9rem;
        }

        .note {
          color: var(--muted);
          font-size: 0.88rem;
          line-height: 1.55;
          text-align: right;
          max-width: 21ch;
        }

        .dropzone {
          position: relative;
          display: grid;
          justify-items: center;
          text-align: center;
          gap: 12px;
          padding: 28px 18px;
          border-radius: 26px;
          border: 1.5px dashed var(--line-strong);
          background: linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(238, 245, 255, 0.98));
          cursor: pointer;
          transition:
            transform 160ms ease,
            border-color 160ms ease,
            box-shadow 160ms ease,
            background 160ms ease;
        }

        .dropzone > * {
          position: relative;
          z-index: 1;
        }

        .dropzone::before {
          content: "";
          position: absolute;
          inset: 10px;
          border-radius: 20px;
          background: radial-gradient(circle at top, rgba(21, 131, 255, 0.08), transparent 54%);
          pointer-events: none;
        }

        .dropzone.active {
          transform: translateY(-3px);
          border-color: var(--accent);
          box-shadow: 0 22px 40px rgba(21, 131, 255, 0.18);
          background: linear-gradient(180deg, rgba(255, 255, 255, 1), rgba(232, 244, 255, 1));
        }

        .dropzone:hover {
          border-color: var(--accent);
        }

        .drop-art {
          position: relative;
          width: 126px;
          height: 92px;
          margin-bottom: 6px;
        }

        .drop-art span {
          position: absolute;
          inset: 0;
          border-radius: 24px;
          border: 1px solid rgba(166, 194, 226, 0.82);
          background: linear-gradient(180deg, #ffffff, #eaf3ff);
          box-shadow: 0 18px 34px rgba(39, 92, 158, 0.08);
        }

        .drop-art span:nth-child(1) {
          transform: rotate(-8deg) translate(-14px, 8px);
          opacity: 0.78;
        }

        .drop-art span:nth-child(2) {
          transform: rotate(8deg) translate(14px, 8px);
          opacity: 0.82;
        }

        .drop-art span:nth-child(3) {
          display: grid;
          place-items: center;
          color: var(--accent);
          font-size: 2.1rem;
          font-weight: 800;
        }

        .dropzone strong {
          font-size: 1.14rem;
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
        .thumb-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
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

        .file-trigger {
          position: relative;
          overflow: hidden;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          text-align: center;
        }

        .file-trigger input[type="file"] {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          opacity: 0;
          cursor: pointer;
        }

        .file-trigger.disabled {
          opacity: 0.55;
          cursor: not-allowed;
          transform: none;
          box-shadow: none;
          pointer-events: none;
        }

        .primary-button {
          padding: 14px 22px;
          color: #ffffff;
          background: linear-gradient(180deg, #2397ff, #0c66e6);
          border: 1px solid rgba(255, 255, 255, 0.16);
          box-shadow: 0 20px 34px rgba(21, 131, 255, 0.26);
        }

        .primary-button.wide {
          width: 100%;
        }

        .ghost-button,
        .utility-button {
          padding: 12px 16px;
          color: var(--text);
          background: rgba(255, 255, 255, 0.92);
          border: 1px solid var(--line);
          box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.8);
        }

        .utility-button {
          padding: 8px 12px;
          border-radius: 14px;
          font-size: 0.84rem;
          font-weight: 600;
        }

        .status {
          margin-top: 12px;
          padding: 13px 15px;
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
          min-height: 360px;
          border-radius: 26px;
          overflow: hidden;
          border: 1px solid var(--line);
          background: linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(232, 241, 252, 0.96));
          display: grid;
          place-items: center;
          margin-bottom: 16px;
          box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.9);
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
          width: 94px;
          height: 94px;
          border-radius: 30px;
          background: linear-gradient(180deg, #f7fbff, #dfeefe);
          border: 1px solid var(--line);
          box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.8);
          position: relative;
        }

        .empty-spot::before,
        .empty-spot::after {
          content: "";
          position: absolute;
          background: rgba(21, 131, 255, 0.2);
        }

        .empty-spot::before {
          width: 30px;
          height: 4px;
          border-radius: 999px;
          top: 45px;
          left: 32px;
        }

        .empty-spot::after {
          width: 4px;
          height: 30px;
          border-radius: 999px;
          top: 32px;
          left: 45px;
        }

        .preview-image {
          width: 100%;
          max-height: 560px;
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
          background: linear-gradient(180deg, rgba(7, 18, 33, 0.84), rgba(9, 25, 44, 0.76));
          color: #f4f8ff;
          backdrop-filter: blur(10px);
          border: 1px solid rgba(255, 255, 255, 0.08);
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
          max-height: 446px;
          overflow: auto;
          padding-right: 2px;
        }

        .thumb-grid::-webkit-scrollbar {
          width: 8px;
        }

        .thumb-grid::-webkit-scrollbar-thumb {
          border-radius: 999px;
          background: rgba(141, 166, 199, 0.72);
        }

        .thumb-card {
          display: grid;
          grid-template-columns: 96px minmax(0, 1fr);
          gap: 12px;
          padding: 12px;
          border-radius: 22px;
          border: 1px solid var(--line);
          background: rgba(255, 255, 255, 0.94);
          transition:
            transform 150ms ease,
            border-color 150ms ease,
            box-shadow 150ms ease;
        }

        .thumb-card.active {
          border-color: rgba(21, 131, 255, 0.48);
          box-shadow: 0 16px 28px rgba(21, 131, 255, 0.14);
        }

        .thumb-card.drag-target {
          border-color: var(--accent);
          box-shadow: 0 16px 28px rgba(21, 131, 255, 0.18);
        }

        .thumb-card:hover {
          transform: translateY(-2px);
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
          min-width: 36px;
          justify-content: center;
          padding: 7px 10px;
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
          gap: 14px;
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
          background: rgba(255, 255, 255, 0.96);
          color: var(--text);
          outline: none;
          box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.8);
          transition:
            border-color 150ms ease,
            box-shadow 150ms ease;
        }

        .field input[type="text"]:focus,
        .field select:focus {
          border-color: rgba(21, 131, 255, 0.48);
          box-shadow: 0 0 0 4px rgba(21, 131, 255, 0.12);
        }

        .field input[type="range"] {
          width: 100%;
          accent-color: var(--accent);
        }

        .summary-card {
          padding: 18px;
          border-radius: 24px;
          border: 1px solid rgba(84, 130, 200, 0.18);
          background: linear-gradient(180deg, rgba(10, 43, 82, 0.98), rgba(18, 74, 138, 0.92));
          box-shadow: 0 20px 34px rgba(12, 46, 88, 0.18);
          color: rgba(236, 244, 255, 0.78);
        }

        .summary-card h4 {
          margin: 0 0 12px;
          color: #ffffff;
          font-size: 0.96rem;
        }

        .summary-row {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          align-items: center;
          padding: 8px 0;
          color: rgba(236, 244, 255, 0.72);
          border-top: 1px solid rgba(255, 255, 255, 0.12);
        }

        .summary-row:first-of-type {
          padding-top: 0;
          border-top: none;
        }

        .summary-row strong {
          color: #ffffff;
          text-align: right;
        }

        .footnote {
          margin-top: 12px;
          font-size: 0.9rem;
          color: var(--muted);
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
          .hero {
            grid-template-columns: 1fr;
          }

          .workspace {
            grid-template-columns: 1fr 1fr;
          }

          .controls-panel {
            position: static;
            grid-column: 1 / -1;
          }
        }

        @media (max-width: 860px) {
          .shell {
            padding: 16px;
            border-radius: 28px;
            background:
              radial-gradient(circle at top left, rgba(73, 154, 255, 0.22), transparent 28%),
              radial-gradient(circle at top right, rgba(129, 227, 255, 0.14), transparent 26%),
              linear-gradient(180deg, #09182c 0 318px, #eef3fa 318px 100%);
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

          .controls-panel {
            grid-column: auto;
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

          .hero-copy h2 {
            max-width: none;
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
            max-width: none;
          }
        }

        .camera-modal {
          position: fixed;
          inset: 0;
          z-index: 9999;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 16px;
          background: rgba(8, 18, 35, 0.78);
          backdrop-filter: blur(8px);
          animation: fade-in 180ms ease both;
        }

        @keyframes fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        .camera-dialog {
          width: min(720px, 100%);
          max-height: calc(100vh - 32px);
          display: flex;
          flex-direction: column;
          border-radius: 24px;
          overflow: hidden;
          background: #0b1525;
          color: #f5f9ff;
          box-shadow: 0 40px 80px rgba(0, 0, 0, 0.45);
          border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .camera-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 14px 18px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(255, 255, 255, 0.03);
        }

        .camera-header strong {
          font-family: "Sora", "Plus Jakarta Sans", sans-serif;
          font-size: 1rem;
          letter-spacing: -0.02em;
        }

        .camera-header .camera-count {
          font-size: 0.85rem;
          color: rgba(231, 240, 255, 0.7);
        }

        .camera-close {
          background: rgba(255, 255, 255, 0.08);
          color: #f5f9ff;
          border-radius: 999px;
          width: 34px;
          height: 34px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          font-size: 1.1rem;
          line-height: 1;
        }

        .camera-close:hover {
          background: rgba(255, 255, 255, 0.16);
        }

        .camera-stage {
          position: relative;
          background: #000;
          aspect-ratio: 4 / 3;
          width: 100%;
          overflow: hidden;
        }

        .camera-stage video {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
        }

        .camera-flash {
          position: absolute;
          inset: 0;
          background: #fff;
          opacity: 0;
          pointer-events: none;
        }

        .camera-flash.fire {
          animation: flash 320ms ease;
        }

        @keyframes flash {
          0% { opacity: 0.85; }
          100% { opacity: 0; }
        }

        .camera-error {
          padding: 22px;
          text-align: center;
          color: #ffd1d1;
          font-size: 0.95rem;
          line-height: 1.55;
          background: rgba(255, 80, 80, 0.08);
        }

        .camera-tray {
          display: flex;
          gap: 8px;
          overflow-x: auto;
          padding: 12px 16px;
          background: rgba(255, 255, 255, 0.03);
          border-top: 1px solid rgba(255, 255, 255, 0.06);
          min-height: 78px;
        }

        .camera-tray:empty::before {
          content: "Captured photos will appear here.";
          color: rgba(231, 240, 255, 0.45);
          font-size: 0.85rem;
          align-self: center;
          padding: 0 4px;
        }

        .camera-tray img {
          width: 56px;
          height: 56px;
          object-fit: cover;
          border-radius: 12px;
          border: 1px solid rgba(255, 255, 255, 0.18);
          flex: 0 0 auto;
          animation: pop-in 240ms ease both;
        }

        @keyframes pop-in {
          from { transform: scale(0.6); opacity: 0; }
          to { transform: scale(1); opacity: 1; }
        }

        .camera-controls {
          display: grid;
          grid-template-columns: 1fr auto 1fr;
          gap: 12px;
          align-items: center;
          padding: 16px 18px 22px;
          background: rgba(255, 255, 255, 0.02);
        }

        .camera-controls .left {
          justify-self: start;
        }

        .camera-controls .right {
          justify-self: end;
        }

        .camera-shutter {
          width: 72px;
          height: 72px;
          border-radius: 999px;
          background: #fff;
          border: 5px solid rgba(255, 255, 255, 0.35);
          cursor: pointer;
          box-shadow: 0 0 0 4px rgba(255, 255, 255, 0.08);
          transition: transform 120ms ease;
        }

        .camera-shutter:hover {
          transform: scale(1.04);
        }

        .camera-shutter:active {
          transform: scale(0.94);
        }

        .camera-shutter:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .camera-text-button {
          background: rgba(255, 255, 255, 0.08);
          color: #f5f9ff;
          padding: 10px 16px;
          border-radius: 14px;
          cursor: pointer;
          font-weight: 600;
          font-size: 0.92rem;
          border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .camera-text-button:hover {
          background: rgba(255, 255, 255, 0.14);
        }

        .camera-text-button.primary {
          background: linear-gradient(180deg, #2397ff, #0c66e6);
          border-color: rgba(255, 255, 255, 0.18);
        }

        .camera-text-button.primary:hover {
          filter: brightness(1.08);
        }

        @media (max-width: 560px) {
          .camera-dialog {
            border-radius: 18px;
          }

          .camera-shutter {
            width: 64px;
            height: 64px;
          }

          .camera-text-button {
            padding: 9px 12px;
            font-size: 0.86rem;
          }
        }
      </style>

      <section class="shell">
        <div class="hero">
          <article class="hero-copy">
            <span class="eyebrow">Private browser workflow</span>
            <h2 id="heading"></h2>
            <p id="subheading"></p>
            <div class="hero-points" aria-hidden="true">
              <span>Drag photos in</span>
              <span>Reorder page flow</span>
              <span>Download instantly</span>
            </div>
          </article>

          <aside class="hero-metrics">
            <div class="metric">
              <span class="metric-label">Pages queued</span>
              <strong id="metricCount">0</strong>
              <small>Each image becomes one well-spaced PDF page in the final export.</small>
            </div>

            <div class="metric">
              <span class="metric-label">Current paper size</span>
              <strong id="metricPage">A4</strong>
              <small id="metricLayout">Auto orientation with balanced spacing.</small>
            </div>

            <div class="metric">
              <span class="metric-label">Processing mode</span>
              <strong>Browser only</strong>
              <small>Your photos stay in the browser while the PDF is being prepared.</small>
            </div>
          </aside>
        </div>

        <div class="workspace">
          <section class="panel upload-panel">
            <div class="panel-header">
              <div>
                <span class="panel-label">Upload</span>
                <h3>Start your stack</h3>
                <p>Drop photos, browse from your device, or use camera capture on supported mobile browsers.</p>
              </div>
            </div>

            <div class="dropzone" id="dropzone">
              <input id="fileInput" type="file" accept="image/*" multiple hidden />
              <div class="drop-art" aria-hidden="true">
                <span></span>
                <span></span>
                <span>+</span>
              </div>
              <strong>Add your photos</strong>
              <p>Drop files anywhere here or tap a button below.</p>
              <div class="button-row">
                <button id="pickButton" class="primary-button" type="button">Add photos</button>
                <button id="cameraButton" class="ghost-button" type="button">
                  <span>Take photo</span>
                </button>
                <input id="cameraInput" type="file" accept="image/*" capture="environment" hidden />
                <button id="clearButton" class="ghost-button" type="button">Clear</button>
              </div>
              <p class="micro-copy" id="uploadSummary">No images added.</p>
            </div>

            <div id="status" class="status info" role="status" aria-live="polite"></div>
            <p class="footnote">Tip: after uploading, drag cards in the queue to change page order before export.</p>
          </section>

          <section class="panel preview-panel">
            <div class="panel-header">
              <div>
                <span class="panel-label">Queue</span>
                <h3>Preview and arrange</h3>
                <p>Select a photo to inspect it, then move it into the right reading order.</p>
              </div>
              <div class="note">The first thumbnail becomes page one in the exported PDF.</div>
            </div>

            <div class="preview-stage">
              <div id="emptyPreview" class="empty-preview">
                <div class="empty-spot" aria-hidden="true"></div>
                <strong>Preview ready</strong>
                <p>Add or select a photo to see the current page.</p>
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
                <h3>Fine-tune the PDF</h3>
                <p>Adjust layout and quality, then download a clean PDF in one click.</p>
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
                  <strong id="summaryLayout">A4 / Auto</strong>
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

            <p class="footnote">The PDF engine loads only when you need it, keeping the page lightweight until export.</p>
          </section>
        </div>
      </section>

      <div id="cameraModal" class="camera-modal" hidden role="dialog" aria-modal="true" aria-label="Take photo">
        <div class="camera-dialog">
          <div class="camera-header">
            <strong>Camera</strong>
            <span class="camera-count" id="cameraCount">0 captured</span>
            <button type="button" class="camera-close" id="cameraCloseButton" aria-label="Close camera">&times;</button>
          </div>
          <div class="camera-stage" id="cameraStage">
            <video id="cameraVideo" autoplay playsinline muted></video>
            <div id="cameraFlash" class="camera-flash"></div>
          </div>
          <div id="cameraError" class="camera-error" hidden></div>
          <div id="cameraTray" class="camera-tray"></div>
          <div class="camera-controls">
            <div class="left"></div>
            <button type="button" id="cameraShutter" class="camera-shutter" aria-label="Capture photo"></button>
            <div class="right">
              <button type="button" id="cameraDoneButton" class="camera-text-button primary">Done</button>
            </div>
          </div>
        </div>
      </div>
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
      cameraModal: this.shadowRoot.getElementById("cameraModal"),
      cameraVideo: this.shadowRoot.getElementById("cameraVideo"),
      cameraStage: this.shadowRoot.getElementById("cameraStage"),
      cameraFlash: this.shadowRoot.getElementById("cameraFlash"),
      cameraError: this.shadowRoot.getElementById("cameraError"),
      cameraTray: this.shadowRoot.getElementById("cameraTray"),
      cameraCount: this.shadowRoot.getElementById("cameraCount"),
      cameraShutter: this.shadowRoot.getElementById("cameraShutter"),
      cameraDoneButton: this.shadowRoot.getElementById("cameraDoneButton"),
      cameraCloseButton: this.shadowRoot.getElementById("cameraCloseButton"),
    };
  }

  bindEvents() {
    this.refs.pickButton.addEventListener("click", () => this.refs.fileInput.click());
    this.refs.dropzone.addEventListener("click", (event) => {
      if (event.target.closest("button, .file-trigger")) {
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

    this.refs.cameraButton.addEventListener("click", () => this.openCamera());
    this.refs.cameraShutter.addEventListener("click", () => this.captureFrame());
    this.refs.cameraDoneButton.addEventListener("click", () => this.closeCamera());
    this.refs.cameraCloseButton.addEventListener("click", () => this.closeCamera());
    this.refs.cameraModal.addEventListener("click", (event) => {
      if (event.target === this.refs.cameraModal) {
        this.closeCamera();
      }
    });
    this._onCameraKeydown = (event) => {
      if (event.key === "Escape" && !this.refs.cameraModal.hidden) {
        this.closeCamera();
      }
    };
    document.addEventListener("keydown", this._onCameraKeydown);

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

    this.style.setProperty("--accent", accent || "#1583ff");
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

    const imageFiles = files.filter((file) => isImageLikeFile(file));
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
    if (loadedItems.length) {
      this.state.activeId = loadedItems[loadedItems.length - 1].id;
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
    this.refs.cameraInput.disabled = this.state.busy;
    this.refs.cameraButton.disabled = this.state.busy;
    this.refs.pickButton.textContent = this.state.items.length ? "Add more" : "Add photos";
    const cameraLabel = this.refs.cameraButton.querySelector("span");
    if (cameraLabel) {
      cameraLabel.textContent = "Take photo";
    }
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

  async openCamera() {
    if (this._cameraStream) {
      return;
    }

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
      this.refs.cameraInput.click();
      return;
    }

    this._cameraTrayUrls = this._cameraTrayUrls || [];
    this._cameraCaptureCount = 0;
    this.refs.cameraTray.innerHTML = "";
    this.refs.cameraCount.textContent = "0 captured";
    this.refs.cameraError.hidden = true;
    this.refs.cameraError.textContent = "";
    this.refs.cameraStage.hidden = false;
    this.refs.cameraShutter.disabled = false;
    this.refs.cameraModal.hidden = false;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      this._cameraStream = stream;
      this.refs.cameraVideo.srcObject = stream;
      try {
        await this.refs.cameraVideo.play();
      } catch (_) {
        /* play() may reject if autoplay is blocked; controls still work */
      }
    } catch (error) {
      console.error(error);
      this.refs.cameraStage.hidden = true;
      this.refs.cameraShutter.disabled = true;
      this.refs.cameraError.hidden = false;
      const name = error && error.name;
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        this.refs.cameraError.textContent = "Camera permission was denied. Allow camera access in your browser, or use \"Add photos\" to upload from your device.";
      } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        this.refs.cameraError.textContent = "No camera was detected on this device.";
      } else if (location.protocol === "file:") {
        this.refs.cameraError.textContent = "Browsers block camera access on file:// pages. Open this app from a local web server (e.g., http://localhost) or hosted URL to use the camera.";
      } else {
        this.refs.cameraError.textContent = "Could not start the camera. " + (error?.message || "Try a different browser or device.");
      }
    }
  }

  async captureFrame() {
    const video = this.refs.cameraVideo;
    if (!this._cameraStream || !video || !video.videoWidth || !video.videoHeight) {
      return;
    }

    if (this.refs.cameraShutter.disabled) {
      return;
    }
    this.refs.cameraShutter.disabled = true;

    this.refs.cameraFlash.classList.remove("fire");
    void this.refs.cameraFlash.offsetWidth;
    this.refs.cameraFlash.classList.add("fire");

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (!blob) {
      this.refs.cameraShutter.disabled = false;
      return;
    }

    this._cameraCaptureCount = (this._cameraCaptureCount || 0) + 1;
    const fileName = `camera-${Date.now()}-${this._cameraCaptureCount}.jpg`;
    const file = new File([blob], fileName, { type: "image/jpeg", lastModified: Date.now() });

    const trayUrl = URL.createObjectURL(blob);
    this._cameraTrayUrls = this._cameraTrayUrls || [];
    this._cameraTrayUrls.push(trayUrl);
    const thumb = document.createElement("img");
    thumb.src = trayUrl;
    thumb.alt = `Capture ${this._cameraCaptureCount}`;
    this.refs.cameraTray.appendChild(thumb);
    thumb.scrollIntoView({ behavior: "smooth", inline: "end", block: "nearest" });
    this.refs.cameraCount.textContent = `${this._cameraCaptureCount} captured`;

    this.handleFiles([file]).finally(() => {
      this.refs.cameraShutter.disabled = !this._cameraStream;
    });
  }

  stopCameraStream() {
    if (this._cameraStream) {
      for (const track of this._cameraStream.getTracks()) {
        try { track.stop(); } catch (_) {}
      }
      this._cameraStream = null;
    }
    if (this.refs && this.refs.cameraVideo) {
      this.refs.cameraVideo.srcObject = null;
    }
  }

  closeCamera() {
    this.stopCameraStream();
    if (this.refs && this.refs.cameraModal) {
      this.refs.cameraModal.hidden = true;
    }
    if (this._cameraTrayUrls) {
      for (const url of this._cameraTrayUrls) {
        URL.revokeObjectURL(url);
      }
      this._cameraTrayUrls = [];
    }
    if (this.refs && this.refs.cameraTray) {
      this.refs.cameraTray.innerHTML = "";
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


