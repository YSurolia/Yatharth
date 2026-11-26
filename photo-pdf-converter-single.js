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
  const LOOK_LABELS = { original: 'Original', enhanced: 'Enhanced', bw: 'B&W', mixed: 'Mixed' };
  const MAX_EDGE = 2560; // longest side in px for embedded images
  const THUMB_EDGE = 360; // longest side in px for queue thumbnails
  const QUALITY_DEBOUNCE_MS = 300;
  const CAMERA_JPEG_QUALITY = 0.95; // camera shots are saved crisp, then compressed with the PDF quality setting
  const FRAME_HOOKS = { isStale: () => false, onThumb: () => {} };
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
      if (event.data.frame) {
        // A camera frame (ImageBitmap): turn it into a JPEG off the main thread.
        const { jobId, frame, quality, maxEdge } = event.data;
        try {
          const out = await renderJpeg(frame, frame.width, frame.height, maxEdge, quality, makeCanvas, toBlob);
          self.postMessage({ jobId, kind: 'done', blob: out.blob, w: out.w, h: out.h });
        } catch (error) {
          self.postMessage({ jobId, kind: 'error', message: (error && error.message) || String(error) });
        } finally {
          frame.close();
        }
        return;
      }

      const { jobId, file, quality, maxEdge, thumbEdge, wantThumb, scan, corners, refine, manual, look } = event.data;
      let bitmap = null;
      try {
        bitmap = await createImageBitmap(file); // applies EXIF rotation
        const page = preparePage(bitmap, bitmap.width, bitmap.height, { scan, corners, refine, manual, look, maxEdge }, makeCanvas);
        if (wantThumb) {
          const thumb = await renderJpeg(page.source, page.w, page.h, thumbEdge, 0.8, makeCanvas, toBlob);
          self.postMessage({ jobId, kind: 'thumb', thumb: thumb.blob, srcW: page.w, srcH: page.h });
        }
        const out = page.final
          ? { blob: await toBlob(page.source, quality), w: page.w, h: page.h } // already at its final size
          : await renderJpeg(page.source, page.w, page.h, maxEdge, quality, makeCanvas, toBlob);
        const buffer = await out.blob.arrayBuffer();
        self.postMessage({
          jobId, kind: 'done', buffer, w: out.w, h: out.h, srcW: page.w, srcH: page.h,
          scanned: page.scanned, corners: page.corners, processed: page.processed,
        }, [buffer]);
      } catch (error) {
        self.postMessage({ jobId, kind: 'error', message: (error && error.message) || String(error) });
      } finally {
        if (bitmap) bitmap.close();
      }
    };
  }

  // ===================================================================
  // Auto scan: find the page, crop away the background, straighten it.
  // Plain functions with no outside state, so they also run inside the Web Workers.
  // ===================================================================

  // Grayscale min/max filter with a square window (done in two 1-D passes).
  // A max pass then a min pass ("closing") wipes out thin dark marks such as text,
  // leaving a plain page whose outline is easy to find.
  function scanMinMax(src, w, h, r, isMax) {
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y += 1) {
      const row = y * w;
      for (let x = 0; x < w; x += 1) {
        const x0 = x - r < 0 ? 0 : x - r;
        const x1 = x + r >= w ? w - 1 : x + r;
        let v = src[row + x0];
        if (isMax) { for (let k = x0 + 1; k <= x1; k += 1) if (src[row + k] > v) v = src[row + k]; }
        else { for (let k = x0 + 1; k <= x1; k += 1) if (src[row + k] < v) v = src[row + k]; }
        tmp[row + x] = v;
      }
    }
    for (let x = 0; x < w; x += 1) {
      for (let y = 0; y < h; y += 1) {
        const y0 = y - r < 0 ? 0 : y - r;
        const y1 = y + r >= h ? h - 1 : y + r;
        let v = tmp[y0 * w + x];
        if (isMax) { for (let k = y0 + 1; k <= y1; k += 1) if (tmp[k * w + x] > v) v = tmp[k * w + x]; }
        else { for (let k = y0 + 1; k <= y1; k += 1) if (tmp[k * w + x] < v) v = tmp[k * w + x]; }
        out[y * w + x] = v;
      }
    }
    return out;
  }

  // 5x5 Gaussian blur (1 4 6 4 1).
  function scanBlur(src, w, h) {
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y += 1) {
      const row = y * w;
      for (let x = 0; x < w; x += 1) {
        const a = src[row + (x > 1 ? x - 2 : 0)];
        const b = src[row + (x > 0 ? x - 1 : 0)];
        const d = src[row + (x < w - 1 ? x + 1 : w - 1)];
        const e = src[row + (x < w - 2 ? x + 2 : w - 1)];
        tmp[row + x] = (a + 4 * b + 6 * src[row + x] + 4 * d + e) / 16;
      }
    }
    for (let y = 0; y < h; y += 1) {
      const ra = (y > 1 ? y - 2 : 0) * w;
      const rb = (y > 0 ? y - 1 : 0) * w;
      const rc = y * w;
      const rd = (y < h - 1 ? y + 1 : h - 1) * w;
      const re = (y < h - 2 ? y + 2 : h - 1) * w;
      for (let x = 0; x < w; x += 1) {
        out[rc + x] = (tmp[ra + x] + 4 * tmp[rb + x] + 6 * tmp[rc + x] + 4 * tmp[rd + x] + tmp[re + x]) / 16;
      }
    }
    return out;
  }

  // Canny-style edges: Sobel gradients, thinned to 1px, then keep strong edges plus weak ones touching them.
  function scanEdges(img, w, h) {
    const n = w * h;
    const mag = new Float32Array(n);
    const dir = new Uint8Array(n);
    for (let y = 1; y < h - 1; y += 1) {
      for (let x = 1; x < w - 1; x += 1) {
        const i = y * w + x;
        const tl = img[i - w - 1]; const tc = img[i - w]; const tr = img[i - w + 1];
        const ml = img[i - 1]; const mr = img[i + 1];
        const bl = img[i + w - 1]; const bc = img[i + w]; const br = img[i + w + 1];
        const gx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
        const gy = (bl + 2 * bc + br) - (tl + 2 * tc + tr);
        const ax = gx < 0 ? -gx : gx;
        const ay = gy < 0 ? -gy : gy;
        mag[i] = ax + ay;
        if (ay <= ax * 0.4142) dir[i] = 0;
        else if (ay >= ax * 2.4142) dir[i] = 2;
        else dir[i] = (gx > 0) === (gy > 0) ? 1 : 3;
      }
    }
    const thin = new Float32Array(n);
    let maxMag = 0;
    for (let y = 1; y < h - 1; y += 1) {
      for (let x = 1; x < w - 1; x += 1) {
        const i = y * w + x;
        const m = mag[i];
        if (m === 0) continue;
        let a;
        let b;
        if (dir[i] === 0) { a = mag[i - 1]; b = mag[i + 1]; }
        else if (dir[i] === 2) { a = mag[i - w]; b = mag[i + w]; }
        else if (dir[i] === 1) { a = mag[i - w - 1]; b = mag[i + w + 1]; }
        else { a = mag[i - w + 1]; b = mag[i + w - 1]; }
        if (m >= a && m >= b) {
          thin[i] = m;
          if (m > maxMag) maxMag = m;
        }
      }
    }
    const edges = new Uint8Array(n);
    if (maxMag === 0) return edges;

    // Thresholds adapt to each photo: "strong" = the top 10% of edge pixels (never below a noise floor).
    const bins = 512;
    const hist = new Uint32Array(bins);
    let count = 0;
    for (let i = 0; i < n; i += 1) {
      if (thin[i] > 0) {
        hist[Math.min(bins - 1, ((thin[i] / maxMag) * (bins - 1)) | 0)] += 1;
        count += 1;
      }
    }
    let acc = 0;
    let cut = bins - 1;
    for (let b = 0; b < bins; b += 1) {
      acc += hist[b];
      if (acc >= count * 0.9) { cut = b; break; }
    }
    const high = Math.max(((cut + 1) / (bins - 1)) * maxMag, 24);
    const low = high * 0.45;

    const stack = new Int32Array(n);
    let sp = 0;
    for (let i = 0; i < n; i += 1) {
      if (thin[i] >= high) { edges[i] = 1; stack[sp++] = i; }
    }
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % w;
      for (let dy = -w; dy <= w; dy += w) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if ((dx === -1 && x === 0) || (dx === 1 && x === w - 1)) continue;
          const j = i + dy + dx;
          if (j < 0 || j >= n || edges[j] || thin[j] < low) continue;
          edges[j] = 1;
          stack[sp++] = j;
        }
      }
    }
    return edges;
  }

  // Thicken a 0/1 mask by one pixel in every direction.
  function scanDilate(src, w, h) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y += 1) {
      const y0 = y > 0 ? y - 1 : 0;
      const y1 = y < h - 1 ? y + 1 : h - 1;
      for (let x = 0; x < w; x += 1) {
        const x0 = x > 0 ? x - 1 : 0;
        const x1 = x < w - 1 ? x + 1 : w - 1;
        let on = 0;
        for (let yy = y0; yy <= y1 && !on; yy += 1) {
          for (let xx = x0; xx <= x1; xx += 1) {
            if (src[yy * w + xx]) { on = 1; break; }
          }
        }
        out[y * w + x] = on;
      }
    }
    return out;
  }

  // Connected areas where mask[i] === want (optionally only those containing the given seed pixels).
  // For each big area, returns the left- and rightmost pixel of every row: enough for a convex hull.
  function scanRegions(mask, w, h, want, eight, minBoxArea, seeds) {
    const n = w * h;
    const labels = new Int32Array(n);
    const stack = new Int32Array(n);
    const offX = eight ? [1, -1, 0, 0, 1, 1, -1, -1] : [1, -1, 0, 0];
    const offY = eight ? [0, 0, 1, -1, 1, -1, 1, -1] : [0, 0, 1, -1];
    const regions = [];
    const total = seeds ? seeds.length : n;
    let label = 0;
    for (let s = 0; s < total; s += 1) {
      const start = seeds ? seeds[s] : s;
      if (start < 0 || start >= n || mask[start] !== want || labels[start]) continue;
      label += 1;
      let sp = 0;
      stack[sp++] = start;
      labels[start] = label;
      let minX = w; let maxX = -1; let minY = h; let maxY = -1; let count = 0;
      while (sp > 0) {
        const i = stack[--sp];
        const y = (i / w) | 0;
        const x = i - y * w;
        count += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        for (let k = 0; k < offX.length; k += 1) {
          const xx = x + offX[k];
          const yy = y + offY[k];
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx;
          if (mask[j] === want && !labels[j]) {
            labels[j] = label;
            stack[sp++] = j;
          }
        }
      }
      if ((maxX - minX + 1) * (maxY - minY + 1) < minBoxArea) continue;
      const points = [];
      for (let y = minY; y <= maxY; y += 1) {
        const row = y * w;
        let lo = -1;
        let hi = -1;
        for (let x = minX; x <= maxX; x += 1) {
          if (labels[row + x] === label) { if (lo < 0) lo = x; hi = x; }
        }
        if (lo >= 0) {
          points.push([lo, y]);
          if (hi !== lo) points.push([hi, y]);
        }
      }
      regions.push({ points, count });
    }
    return regions;
  }

  // Convex hull (Andrew's monotone chain).
  function scanHull(points) {
    const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (pts.length < 3) return pts;
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i -= 1) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    upper.pop();
    lower.pop();
    return lower.concat(upper);
  }

  // Douglas–Peucker line simplification.
  function scanDP(pts, eps) {
    if (pts.length < 3) return pts.slice();
    const ax = pts[0][0]; const ay = pts[0][1];
    const bx = pts[pts.length - 1][0]; const by = pts[pts.length - 1][1];
    const dx = bx - ax; const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    let index = -1;
    let dmax = 0;
    for (let i = 1; i < pts.length - 1; i += 1) {
      const dist = Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / len;
      if (dist > dmax) { dmax = dist; index = i; }
    }
    if (dmax <= eps) return [pts[0], pts[pts.length - 1]];
    const left = scanDP(pts.slice(0, index + 1), eps);
    const right = scanDP(pts.slice(index), eps);
    return left.slice(0, -1).concat(right);
  }

  function scanSimplifyClosed(poly, eps) {
    if (poly.length <= 4) return poly.slice();
    let far = 0;
    let best = -1;
    for (let i = 1; i < poly.length; i += 1) {
      const d = (poly[i][0] - poly[0][0]) ** 2 + (poly[i][1] - poly[0][1]) ** 2;
      if (d > best) { best = d; far = i; }
    }
    const a = scanDP(poly.slice(0, far + 1), eps);
    const b = scanDP(poly.slice(far).concat([poly[0]]), eps);
    return a.slice(0, -1).concat(b.slice(0, -1));
  }

  function scanArea(poly) {
    let sum = 0;
    for (let i = 0; i < poly.length; i += 1) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      sum += p[0] * q[1] - q[0] * p[1];
    }
    return Math.abs(sum) / 2;
  }

  // The 4 hull corners that enclose the most area: the page's corners.
  function scanBestQuad(poly) {
    const n = poly.length;
    if (n < 4) return null;
    let best = null;
    let bestArea = 0;
    for (let a = 0; a < n - 3; a += 1) {
      for (let b = a + 1; b < n - 2; b += 1) {
        for (let c = b + 1; c < n - 1; c += 1) {
          for (let d = c + 1; d < n; d += 1) {
            const quad = [poly[a], poly[b], poly[c], poly[d]];
            const area = scanArea(quad);
            if (area > bestArea) { bestArea = area; best = quad; }
          }
        }
      }
    }
    return best;
  }

  // Order corners as top-left, top-right, bottom-right, bottom-left.
  function scanOrder(quad) {
    const cx = (quad[0][0] + quad[1][0] + quad[2][0] + quad[3][0]) / 4;
    const cy = (quad[0][1] + quad[1][1] + quad[2][1] + quad[3][1]) / 4;
    const sorted = quad.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
    let start = 0;
    for (let i = 1; i < 4; i += 1) {
      if (sorted[i][0] + sorted[i][1] < sorted[start][0] + sorted[start][1]) start = i;
    }
    return [0, 1, 2, 3].map((k) => sorted[(start + k) % 4]);
  }

  function scanQuadFromPoints(points) {
    if (points.length < 4) return null;
    const hull = scanHull(points);
    if (hull.length < 4) return null;
    let poly = hull;
    let eps = 1;
    while (poly.length > 24 && eps < 200) {
      poly = scanSimplifyClosed(hull, eps);
      eps *= 1.6;
    }
    if (poly.length < 4) return null;
    const quad = scanBestQuad(poly);
    return quad ? scanOrder(quad) : null;
  }

  // How believable is this quad as a page? 0 = reject. Needs a sensible shape and real edges along its sides.
  function scanScoreQuad(quad, support, w, h) {
    const imageArea = w * h;
    const area = scanArea(quad);
    if (area < imageArea * 0.15) return 0;
    let sign = 0;
    for (let i = 0; i < 4; i += 1) {
      const p = quad[i];
      const prev = quad[(i + 3) % 4];
      const next = quad[(i + 1) % 4];
      const ux = prev[0] - p[0]; const uy = prev[1] - p[1];
      const vx = next[0] - p[0]; const vy = next[1] - p[1];
      const lu = Math.hypot(ux, uy);
      const lv = Math.hypot(vx, vy);
      if (lu < 8 || lv < 8) return 0;
      const cos = (ux * vx + uy * vy) / (lu * lv);
      if (cos > 0.7072 || cos < -0.7072) return 0; // corner angle must be 45°–135°
      const cross = ux * vy - uy * vx;
      const s = cross > 0 ? 1 : -1;
      if (sign && s !== sign) return 0; // not convex
      sign = s;
    }
    // Every side must sit on a real edge (or run along the photo's border, where the page is cut off).
    // The weakest side counts most: on busy backgrounds, random clutter gives wrong lines partial support.
    let weakest = 1;
    let realSides = 0;
    for (let i = 0; i < 4; i += 1) {
      const p = quad[i];
      const q = quad[(i + 1) % 4];
      const steps = Math.max(8, Math.round(Math.hypot(q[0] - p[0], q[1] - p[1]) / 2));
      let onEdge = 0;
      let onBorder = 0;
      for (let s = 0; s < steps; s += 1) {
        const t = (s + 0.5) / steps;
        const x = Math.round(p[0] + (q[0] - p[0]) * t);
        const y = Math.round(p[1] + (q[1] - p[1]) * t);
        if (x >= 0 && y >= 0 && x < w && y < h && support[y * w + x] === 1) onEdge += 1;
        else if (x <= 3 || y <= 3 || x >= w - 4 || y >= h - 4) onBorder += 1;
      }
      const edgeRatio = onEdge / steps;
      const sideScore = edgeRatio + 0.75 * (onBorder / steps);
      if (sideScore < 0.6) return 0;
      if (edgeRatio >= 0.6) realSides += 1;
      if (sideScore < weakest) weakest = sideScore;
    }
    if (realSides < 2) return 0;
    return (area / imageArea) * weakest * weakest * weakest;
  }

  // Straight-line finder (Hough transform). Builds page candidates from 2 near-horizontal and
  // 2 near-vertical lines, so clutter touching the page edge can't bend the outline.
  function scanHoughQuads(edges, w, h) {
    const diag = Math.ceil(Math.hypot(w, h));
    const nTheta = 180;
    const nRho = diag * 2 + 1;
    const cos = new Float32Array(nTheta);
    const sin = new Float32Array(nTheta);
    for (let t = 0; t < nTheta; t += 1) {
      cos[t] = Math.cos((t * Math.PI) / 180);
      sin[t] = Math.sin((t * Math.PI) / 180);
    }
    const acc = new Int32Array(nTheta * nRho);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (!edges[y * w + x]) continue;
        for (let t = 0; t < nTheta; t += 1) acc[t * nRho + Math.round(x * cos[t] + y * sin[t]) + diag] += 1;
      }
    }
    const minVotes = Math.round(Math.min(w, h) * 0.12);
    const peaks = [];
    for (let t = 0; t < nTheta; t += 1) {
      for (let r = 1; r < nRho - 1; r += 1) {
        const v = acc[t * nRho + r];
        if (v < minVotes) continue;
        let isPeak = true;
        for (let dt = -1; dt <= 1 && isPeak; dt += 1) {
          const tt = (t + dt + nTheta) % nTheta;
          for (let dr = -1; dr <= 1; dr += 1) {
            if ((dt || dr) && acc[tt * nRho + r + dr] > v) { isPeak = false; break; }
          }
        }
        if (isPeak) peaks.push([v, t, r - diag]);
      }
    }
    peaks.sort((a, b) => b[0] - a[0]);
    const lines = [];
    for (const p of peaks) {
      if (lines.length >= 24) break;
      const near = lines.some((l) => {
        const dt = Math.abs(l[1] - p[1]);
        if (dt <= 4) return Math.abs(l[2] - p[2]) <= 10;
        if (180 - dt <= 4) return Math.abs(l[2] + p[2]) <= 10; // same line seen from the other side
        return false;
      });
      if (!near) lines.push(p);
    }
    const horizontal = lines.filter((l) => l[1] >= 45 && l[1] <= 135).slice(0, 10);
    const vertical = lines.filter((l) => l[1] < 45 || l[1] > 135).slice(0, 10);
    const meet = (a, b) => {
      const c1 = cos[a[1]]; const s1 = sin[a[1]];
      const c2 = cos[b[1]]; const s2 = sin[b[1]];
      const det = c1 * s2 - s1 * c2;
      if (Math.abs(det) < 1e-6) return null;
      return [(a[2] * s2 - b[2] * s1) / det, (c1 * b[2] - c2 * a[2]) / det];
    };
    const slackX = w * 0.03;
    const slackY = h * 0.03;
    const quads = [];
    for (let i = 0; i < horizontal.length; i += 1) {
      for (let j = i + 1; j < horizontal.length; j += 1) {
        for (let k = 0; k < vertical.length; k += 1) {
          for (let l = k + 1; l < vertical.length; l += 1) {
            const pts = [
              meet(horizontal[i], vertical[k]), meet(horizontal[i], vertical[l]),
              meet(horizontal[j], vertical[l]), meet(horizontal[j], vertical[k]),
            ];
            if (pts.some((p) => !p || p[0] < -slackX || p[1] < -slackY || p[0] > w - 1 + slackX || p[1] > h - 1 + slackY)) continue;
            quads.push(scanOrder(pts.map((p) => [Math.min(w - 1, Math.max(0, p[0])), Math.min(h - 1, Math.max(0, p[1]))])));
          }
        }
      }
    }
    return quads;
  }

  function scanOtsu(img) {
    const hist = new Float64Array(256);
    for (let i = 0; i < img.length; i += 1) {
      const v = img[i] | 0;
      hist[v < 0 ? 0 : v > 255 ? 255 : v] += 1;
    }
    let sum = 0;
    for (let t = 0; t < 256; t += 1) sum += t * hist[t];
    let sumB = 0;
    let weightB = 0;
    let best = 0;
    let threshold = 127;
    for (let t = 0; t < 256; t += 1) {
      weightB += hist[t];
      if (!weightB) continue;
      const weightF = img.length - weightB;
      if (!weightF) break;
      sumB += t * hist[t];
      const diff = sumB / weightB - (sum - sumB) / weightF;
      const between = weightB * weightF * diff * diff;
      if (between > best) { best = between; threshold = t; }
    }
    return threshold;
  }

  // Find the page in a small copy of the photo. Returns 4 corners as fractions (0..1) or null.
  function detectDocument(imageData) {
    const w = imageData.width;
    const h = imageData.height;
    if (w < 32 || h < 32) return null;
    const n = w * h;
    const data = imageData.data;
    const gray = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i += 1, j += 4) gray[i] = data[j] * 0.299 + data[j + 1] * 0.587 + data[j + 2] * 0.114;

    const r = Math.max(2, Math.round(Math.max(w, h) / 128));
    const clean = scanBlur(scanMinMax(scanMinMax(gray, w, h, r, true), w, h, r, false), w, h);
    const edges = scanEdges(clean, w, h);
    const walls = scanDilate(edges, w, h);
    const support = scanDilate(walls, w, h);
    const minBox = n * 0.15;
    const outlines = [];

    // 1. The area around the middle of the photo, fenced in by (thick) edges: usually the page itself.
    const seeds = [];
    for (let sy = -1; sy <= 1; sy += 1) {
      for (let sx = -1; sx <= 1; sx += 1) {
        seeds.push(Math.round(h / 2 + sy * h * 0.06) * w + Math.round(w / 2 + sx * w * 0.06));
      }
    }
    scanRegions(support, w, h, 0, false, minBox, seeds).forEach((region) => outlines.push(region.points));
    // 2. Large connected edge outlines.
    scanRegions(walls, w, h, 1, true, minBox, null).forEach((region) => outlines.push(region.points));
    // 3. Large bright areas (light paper on a darker surface).
    const threshold = scanOtsu(clean);
    const bright = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) bright[i] = clean[i] > threshold ? 1 : 0;
    scanRegions(bright, w, h, 1, false, minBox, null).forEach((region) => outlines.push(region.points));

    const quads = [];
    for (const points of outlines) {
      const quad = scanQuadFromPoints(points);
      if (quad) quads.push(quad);
    }
    // 4. Quads made from the strongest straight lines (handles busy backgrounds).
    scanHoughQuads(edges, w, h).forEach((quad) => quads.push(quad));

    let best = null;
    let bestScore = 0;
    for (const quad of quads) {
      const score = scanScoreQuad(quad, support, w, h);
      if (score > bestScore) { bestScore = score; best = quad; }
    }
    return best ? best.map((p) => [(p[0] + 0.5) / w, (p[1] + 0.5) / h]) : null;
  }

  // Homography (8 numbers) that maps 4 points `from` onto 4 points `to`.
  function solveHomography(from, to) {
    const m = [];
    for (let i = 0; i < 4; i += 1) {
      const x = from[i][0]; const y = from[i][1];
      const u = to[i][0]; const v = to[i][1];
      m.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
      m.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
    }
    for (let col = 0; col < 8; col += 1) {
      let pivot = col;
      for (let r = col + 1; r < 8; r += 1) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
      const swap = m[col]; m[col] = m[pivot]; m[pivot] = swap;
      const p = m[col][col];
      if (Math.abs(p) < 1e-12) return null;
      for (let c = col; c < 9; c += 1) m[col][c] /= p;
      for (let r = 0; r < 8; r += 1) {
        if (r === col) continue;
        const f = m[r][col];
        if (!f) continue;
        for (let c = col; c < 9; c += 1) m[r][c] -= f * m[col][c];
      }
    }
    return m.map((row) => row[8]);
  }

  // Straighten: fill `out` (ImageData) with the quad `corners` (TL, TR, BR, BL, in src pixels) of `src`.
  function warpPerspective(src, corners, out) {
    const sw = src.width; const sh = src.height; const sd = src.data;
    const ow = out.width; const oh = out.height; const od = out.data;
    const H = solveHomography([[0, 0], [ow, 0], [ow, oh], [0, oh]], corners);
    if (!H) return false;
    const a = H[0]; const b = H[1]; const c = H[2];
    const d = H[3]; const e = H[4]; const f = H[5];
    const g = H[6]; const k = H[7];
    const maxX = sw - 1.001;
    const maxY = sh - 1.001;
    const stride = sw * 4;
    let o = 0;
    for (let y = 0; y < oh; y += 1) {
      const yy = y + 0.5;
      let nx = a * 0.5 + b * yy + c;
      let ny = d * 0.5 + e * yy + f;
      let nz = g * 0.5 + k * yy + 1;
      for (let x = 0; x < ow; x += 1) {
        let sx = nx / nz - 0.5;
        let sy = ny / nz - 0.5;
        if (sx < 0) sx = 0; else if (sx > maxX) sx = maxX;
        if (sy < 0) sy = 0; else if (sy > maxY) sy = maxY;
        const x0 = sx | 0;
        const y0 = sy | 0;
        const fx = sx - x0;
        const fy = sy - y0;
        const i00 = y0 * stride + x0 * 4;
        const i10 = i00 + 4;
        const i01 = i00 + stride;
        const i11 = i01 + 4;
        const w00 = (1 - fx) * (1 - fy);
        const w10 = fx * (1 - fy);
        const w01 = (1 - fx) * fy;
        const w11 = fx * fy;
        od[o] = sd[i00] * w00 + sd[i10] * w10 + sd[i01] * w01 + sd[i11] * w11;
        od[o + 1] = sd[i00 + 1] * w00 + sd[i10 + 1] * w10 + sd[i01 + 1] * w01 + sd[i11 + 1] * w11;
        od[o + 2] = sd[i00 + 2] * w00 + sd[i10 + 2] * w10 + sd[i01 + 2] * w01 + sd[i11 + 2] * w11;
        od[o + 3] = 255;
        o += 4;
        nx += a;
        ny += d;
        nz += g;
      }
    }
    return true;
  }

  // Sharpen corners found on the small copy using the full-size pixels: for each side, look along
  // the side's normal for the strongest brightness step, then fit a line through the median offsets.
  function scanRefineCorners(img, pts) {
    const w = img.width;
    const h = img.height;
    const d = img.data;
    const lum = (x, y) => {
      const xi = x < 0 ? 0 : x >= w ? w - 1 : x | 0;
      const yi = y < 0 ? 0 : y >= h ? h - 1 : y | 0;
      const i = (yi * w + xi) * 4;
      return d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    };
    const median = (values) => {
      const sorted = values.slice().sort((x, y) => x - y);
      return sorted[sorted.length >> 1];
    };
    const cx = (pts[0][0] + pts[1][0] + pts[2][0] + pts[3][0]) / 4;
    const cy = (pts[0][1] + pts[1][1] + pts[2][1] + pts[3][1]) / 4;
    const reach = Math.max(6, Math.round(Math.max(w, h) * 0.012));
    const lines = [];
    for (let s = 0; s < 4; s += 1) {
      const a = pts[s];
      const b = pts[(s + 1) % 4];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const tx = (b[0] - a[0]) / len;
      const ty = (b[1] - a[1]) / len;
      let nx = -ty;
      let ny = tx;
      if (((a[0] + b[0]) / 2 - cx) * nx + ((a[1] + b[1]) / 2 - cy) * ny < 0) { nx = -nx; ny = -ny; } // point outward
      const samples = 32;
      const firstHalf = [];
      const secondHalf = [];
      let strength = 0;
      for (let k = 0; k < samples; k += 1) {
        const t = 0.12 + (0.76 * (k + 0.5)) / samples;
        const px = a[0] + (b[0] - a[0]) * t;
        const py = a[1] + (b[1] - a[1]) * t;
        let best = 0;
        let bestOffset = 0;
        for (let o = -reach; o <= reach; o += 1) {
          const qx = px + nx * o;
          const qy = py + ny * o;
          let inside = 0;
          let outside = 0;
          for (let j = -1; j <= 1; j += 1) {
            inside += lum(qx - nx * 1.5 + tx * j * 2, qy - ny * 1.5 + ty * j * 2);
            outside += lum(qx + nx * 1.5 + tx * j * 2, qy + ny * 1.5 + ty * j * 2);
          }
          const step = Math.abs(inside - outside) / 3;
          if (step > best) { best = step; bestOffset = o; }
        }
        strength += best;
        (t < 0.5 ? firstHalf : secondHalf).push(bestOffset);
      }
      if (strength / samples < 10) {
        lines.push([a, b]); // no clear edge here (e.g. the page runs off the photo): keep this side
        continue;
      }
      const o1 = median(firstHalf);
      const o2 = median(secondHalf);
      lines.push([
        [a[0] + (b[0] - a[0]) * 0.31 + nx * o1, a[1] + (b[1] - a[1]) * 0.31 + ny * o1],
        [a[0] + (b[0] - a[0]) * 0.69 + nx * o2, a[1] + (b[1] - a[1]) * 0.69 + ny * o2],
      ]);
    }
    const refined = [];
    for (let i = 0; i < 4; i += 1) {
      const l1 = lines[(i + 3) % 4];
      const l2 = lines[i];
      const x1 = l1[0][0]; const y1 = l1[0][1]; const x2 = l1[1][0]; const y2 = l1[1][1];
      const x3 = l2[0][0]; const y3 = l2[0][1]; const x4 = l2[1][0]; const y4 = l2[1][1];
      const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
      if (Math.abs(den) < 1e-9) { refined.push(pts[i]); continue; }
      const p1 = x1 * y2 - y1 * x2;
      const p2 = x3 * y4 - y3 * x4;
      const x = (p1 * (x3 - x4) - (x1 - x2) * p2) / den;
      const y = (p1 * (y3 - y4) - (y1 - y2) * p2) / den;
      refined.push(Math.hypot(x - pts[i][0], y - pts[i][1]) > reach * 2.5 ? pts[i] : [x, y]);
    }
    return refined;
  }

  // Find (or reuse) the page corners and return a straightened canvas, or null if no page was found.
  function scanImage(source, srcW, srcH, knownCorners, maxEdge, makeCanvas, refine, manual) {
    let corners = knownCorners;
    if (!corners) {
      const small = fitWithin(srcW, srcH, 512);
      const probe = makeCanvas(small.w, small.h);
      const probeCtx = probe.getContext('2d', { willReadFrequently: true });
      probeCtx.fillStyle = '#ffffff';
      probeCtx.fillRect(0, 0, small.w, small.h);
      probeCtx.drawImage(source, 0, 0, small.w, small.h);
      corners = detectDocument(probeCtx.getImageData(0, 0, small.w, small.h));
      if (!corners) return null;
    }

    const work = fitWithin(srcW, srcH, Math.round(maxEdge * 1.25));
    const workCanvas = makeCanvas(work.w, work.h);
    const workCtx = workCanvas.getContext('2d', { willReadFrequently: true });
    workCtx.fillStyle = '#ffffff';
    workCtx.fillRect(0, 0, work.w, work.h);
    workCtx.imageSmoothingQuality = 'high';
    workCtx.drawImage(source, 0, 0, work.w, work.h);
    const pixels = workCtx.getImageData(0, 0, work.w, work.h);

    let pts = corners.map((p) => [p[0] * work.w, p[1] * work.h]);
    if (!knownCorners || refine) {
      pts = scanRefineCorners(pixels, pts);
      corners = pts.map((p) => [p[0] / work.w, p[1] / work.h]); // cache the refined corners
    }
    const cx = (pts[0][0] + pts[1][0] + pts[2][0] + pts[3][0]) / 4;
    const cy = (pts[0][1] + pts[1][1] + pts[2][1] + pts[3][1]) / 4;
    // Trim a hair off detected corners so no background sliver is left; corners placed by hand are used exactly.
    const trim = manual ? 0 : 0.006;
    const inset = pts.map((p) => [p[0] + (cx - p[0]) * trim, p[1] + (cy - p[1]) * trim]);
    const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
    const size = fitWithin(
      Math.max(dist(inset[0], inset[1]), dist(inset[3], inset[2])),
      Math.max(dist(inset[0], inset[3]), dist(inset[1], inset[2])),
      maxEdge,
    );
    const outCanvas = makeCanvas(size.w, size.h);
    const outCtx = outCanvas.getContext('2d');
    const outData = outCtx.createImageData(size.w, size.h);
    if (!warpPerspective(pixels, inset, outData)) return null;
    outCtx.putImageData(outData, 0, 0);
    return { canvas: outCanvas, w: size.w, h: size.h, corners };
  }

  // Page looks. "enhanced": evens out the lighting, whitens the paper and darkens the text (keeps colour).
  // "bw": a crisp black-and-white scan. Both work by measuring the paper's brightness everywhere
  // (on a small copy with the text wiped out) and dividing it out, so shadows and dim corners disappear.
  function applyLook(canvas, w, h, look, makeCanvas) {
    if (look !== 'enhanced' && look !== 'bw') return;
    const small = fitWithin(w, h, 160);
    const probe = makeCanvas(small.w, small.h);
    const probeCtx = probe.getContext('2d', { willReadFrequently: true });
    probeCtx.drawImage(canvas, 0, 0, small.w, small.h);
    const sd = probeCtx.getImageData(0, 0, small.w, small.h).data;
    const sn = small.w * small.h;
    const lum = new Float32Array(sn);
    for (let i = 0, j = 0; i < sn; i += 1, j += 4) lum[i] = sd[j] * 0.299 + sd[j + 1] * 0.587 + sd[j + 2] * 0.114;
    const radius = Math.max(2, Math.round(Math.max(small.w, small.h) / 40));
    let paper = scanMinMax(lum, small.w, small.h, radius, true); // brightest nearby = the paper, text removed
    paper = scanBlur(scanBlur(paper, small.w, small.h), small.w, small.h);

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const image = ctx.getImageData(0, 0, w, h);
    const d = image.data;
    const stepX = (small.w - 1) / Math.max(1, w - 1);
    const stepY = (small.h - 1) / Math.max(1, h - 1);
    const bw = look === 'bw';
    for (let y = 0; y < h; y += 1) {
      const fy = y * stepY;
      const y0 = fy | 0;
      const y1 = y0 + 1 < small.h ? y0 + 1 : y0;
      const ty = fy - y0;
      const row0 = y0 * small.w;
      const row1 = y1 * small.w;
      let i = y * w * 4;
      for (let x = 0; x < w; x += 1) {
        const fx = x * stepX;
        const x0 = fx | 0;
        const x1 = x0 + 1 < small.w ? x0 + 1 : x0;
        const tx = fx - x0;
        const top = paper[row0 + x0] + (paper[row0 + x1] - paper[row0 + x0]) * tx;
        const bottom = paper[row1 + x0] + (paper[row1 + x1] - paper[row1 + x0]) * tx;
        const level = top + (bottom - top) * ty;
        const gain = 250 / (level < 60 ? 60 : level);
        if (bw) {
          // Soft threshold: below 150 → black, above 210 → white, smooth in between (no jagged letters).
          const v = ((d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) * gain - 150) * 4.25;
          d[i] = v; d[i + 1] = v; d[i + 2] = v; // Uint8ClampedArray clamps to 0..255
        } else {
          // Levels 40..233 → 0..255 after evening out the light.
          d[i] = (d[i] * gain - 40) * 1.32;
          d[i + 1] = (d[i + 1] * gain - 40) * 1.32;
          d[i + 2] = (d[i + 2] * gain - 40) * 1.32;
        }
        i += 4;
      }
    }
    ctx.putImageData(image, 0, 0);
  }

  // The image a PDF page is made from: the straightened page when scanning finds one (else the photo),
  // with the chosen look applied. `final` = already at its final size, ready to encode.
  function preparePage(source, srcW, srcH, opts, makeCanvas) {
    let page = { source, w: srcW, h: srcH, scanned: false, corners: null, final: false };
    if (opts.scan) {
      const result = scanImage(source, srcW, srcH, opts.corners || null, opts.maxEdge, makeCanvas, opts.refine, opts.manual);
      if (result) page = { source: result.canvas, w: result.w, h: result.h, scanned: true, corners: result.corners, final: true };
    }
    const styled = opts.look === 'enhanced' || opts.look === 'bw';
    if (styled) {
      if (!page.final) {
        const size = fitWithin(page.w, page.h, opts.maxEdge);
        const canvas = makeCanvas(size.w, size.h);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, size.w, size.h);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(page.source, 0, 0, size.w, size.h);
        page = { source: canvas, w: size.w, h: size.h, scanned: page.scanned, corners: page.corners, final: true };
      }
      applyLook(page.source, page.w, page.h, opts.look, makeCanvas);
    }
    page.processed = page.scanned || styled;
    return page;
  }

  const SCAN_FUNCTIONS = [
    scanMinMax, scanBlur, scanEdges, scanDilate, scanRegions, scanHull, scanDP, scanSimplifyClosed,
    scanArea, scanBestQuad, scanOrder, scanQuadFromPoints, scanScoreQuad, scanHoughQuads, scanOtsu, detectDocument,
    solveHomography, warpPerspective, scanRefineCorners, scanImage, applyLook, preparePage,
  ];

  const WORKER_SOURCE = `${[fitWithin, renderJpeg, ...SCAN_FUNCTIONS].join('\n')}\n(${workerMain})();`;

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

    run(payload, hooks, options = {}) {
      return new Promise((resolve, reject) => {
        this.seq += 1;
        const job = { id: this.seq, payload, hooks, transfer: options.transfer || [], resolve, reject, worker: null };
        if (options.priority) this.queue.unshift(job); // camera shots jump the queue
        else this.queue.push(job);
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
        worker.postMessage({ jobId: job.id, ...job.payload }, job.transfer);
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
  let poolSize = 1;

  // How many photos are prepared at the same time (used to predict waiting time).
  const parallelJobs = () => (pool && !poolBroken ? poolSize : 1);

  function getPool() {
    if (pool || poolBroken) return pool;
    try {
      const cores = navigator.hardwareConcurrency || 4;
      const lowMemory = typeof navigator.deviceMemory === 'number' && navigator.deviceMemory <= 4;
      const size = Math.max(1, Math.min(lowMemory ? 2 : 4, cores - 1));
      poolSize = size;
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
      const page = preparePage(decoded.source, decoded.w, decoded.h, {
        scan: payload.scan, corners: payload.corners, refine: payload.refine, manual: payload.manual, look: payload.look, maxEdge: payload.maxEdge,
      }, mainMakeCanvas);
      if (payload.wantThumb) {
        const thumb = await renderJpeg(page.source, page.w, page.h, payload.thumbEdge, 0.8, mainMakeCanvas, mainToBlob);
        hooks.onThumb({ thumb: thumb.blob, srcW: page.w, srcH: page.h });
      }
      const out = page.final
        ? { blob: await mainToBlob(page.source, payload.quality), w: page.w, h: page.h }
        : await renderJpeg(page.source, page.w, page.h, payload.maxEdge, payload.quality, mainMakeCanvas, mainToBlob);
      return {
        buffer: await out.blob.arrayBuffer(), w: out.w, h: out.h, srcW: page.w, srcH: page.h,
        scanned: page.scanned, corners: page.corners, processed: page.processed,
      };
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
.btn:focus-visible, .chip-btn:focus-visible,
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
.chip-btn.is-on { border-color: var(--blue-line); background: var(--blue-soft); color: var(--blue-text); }
.chip-btn.is-on:hover:not(:disabled) { border-color: #a9c3f2; background: #d9e7fd; }
.chip-scan.is-on::before { content: "✓ "; font-weight: 800; }
.qi-badge {
  position: absolute; left: 4px; right: 4px; bottom: 4px; padding: 3px 4px; border-radius: 7px;
  background: rgba(15, 29, 51, 0.78); color: #fff; font-size: 10.5px; font-weight: 800; line-height: 1.2;
  text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.qi-badge.is-scanned { background: rgba(30, 132, 73, 0.94); }
.qi-badge.is-missed { background: rgba(190, 112, 0, 0.94); }
.qi-badge.is-working { background: rgba(31, 79, 176, 0.88); }

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
.check-row {
  display: flex; align-items: flex-start; gap: 12px; padding: 14px 16px; border-radius: 16px;
  border: 1px solid var(--line); background: #fff; cursor: pointer; transition: border-color 0.15s ease, background 0.15s ease;
}
.check-row:hover { border-color: #b9c9e0; }
.check-row:has(input:checked) { border-color: var(--blue-line); background: #f5f9ff; }
.check-row input {
  appearance: none; -webkit-appearance: none; display: grid; place-items: center; flex: none;
  width: 21px; height: 21px; margin: 1px 0 0; border: 1.5px solid #b7c5d9; border-radius: 6px; background: #fff;
  cursor: pointer; transition: background 0.15s ease, border-color 0.15s ease;
}
.check-row input:checked, .check-row input:indeterminate { border-color: var(--blue); background: var(--blue); }
.check-row input:checked::after {
  content: ""; width: 6px; height: 11px; border: solid #fff; border-width: 0 2.5px 2.5px 0;
  transform: translateY(-1px) rotate(45deg);
}
.check-row input:indeterminate::after { content: ""; width: 10px; height: 2.5px; border-radius: 2px; background: #fff; }
.check-row input:focus-visible { outline: 3px solid rgba(47, 124, 246, 0.45); outline-offset: 2px; }
.check-text { display: grid; gap: 2px; }
.check-text strong { color: var(--ink); font-size: 15px; font-weight: 700; }
.check-text span { color: var(--muted); font-size: 13.5px; line-height: 1.45; }

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

/* ---------- Camera (full screen, many photos in a row) ---------- */

.camera-modal {
  position: fixed; inset: 0; z-index: 2147483001; width: 100%; height: 100vh; height: 100dvh;
  overflow: hidden; background: #000; color: #fff; animation: pps-fade 0.15s ease;
  -webkit-tap-highlight-color: transparent; -webkit-user-select: none; user-select: none;
}
.camera-modal:fullscreen { width: 100%; height: 100%; }
.camera-modal video {
  position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; background: #000;
}
.camera-modal.is-mirrored video { transform: scaleX(-1); }
.camera-flash { position: absolute; inset: 0; background: #fff; opacity: 0; pointer-events: none; }
.camera-flash.is-flashing { animation: pps-flash 0.16s ease-out; }
@keyframes pps-flash { from { opacity: 0.55; } to { opacity: 0; } }

.camera-top {
  position: absolute; top: 0; left: 0; right: 0; display: flex; align-items: center; gap: 10px;
  padding: calc(14px + env(safe-area-inset-top)) calc(16px + env(safe-area-inset-right)) 40px calc(18px + env(safe-area-inset-left));
  background: linear-gradient(180deg, rgba(0, 0, 0, 0.6) 0%, rgba(0, 0, 0, 0) 100%);
}
.camera-title { font-family: var(--font-display); font-size: 17px; font-weight: 700; }
.camera-count {
  padding: 5px 11px; border-radius: 999px; background: rgba(255, 255, 255, 0.16);
  color: #e6edf7; font-size: 13px; font-weight: 700;
}
.camera-top-actions { display: flex; gap: 10px; margin-left: auto; }
.camera-icon-btn {
  display: grid; place-items: center; width: 44px; height: 44px; padding: 0; border: 0; border-radius: 50%;
  background: rgba(0, 0, 0, 0.38); color: #fff; font-size: 28px; line-height: 1; cursor: pointer;
  touch-action: manipulation; transition: background 0.15s ease;
}
.camera-icon-btn:hover { background: rgba(255, 255, 255, 0.28); }
.camera-icon-btn svg {
  width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;
}

.camera-bottom {
  position: absolute; left: 0; right: 0; bottom: 0; display: grid; grid-template-columns: 1fr auto 1fr;
  align-items: center; gap: 16px;
  padding: 44px calc(22px + env(safe-area-inset-right)) calc(24px + env(safe-area-inset-bottom)) calc(22px + env(safe-area-inset-left));
  background: linear-gradient(0deg, rgba(0, 0, 0, 0.65) 0%, rgba(0, 0, 0, 0) 100%);
}
.camera-last {
  position: relative; justify-self: start; width: 60px; height: 60px; border-radius: 14px;
  border: 2px solid rgba(255, 255, 255, 0.92); background: rgba(255, 255, 255, 0.12);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
}
.camera-last canvas { display: block; width: 100%; height: 100%; border-radius: 12px; }
.camera-last.is-empty { visibility: hidden; }
.camera-last.is-pop { animation: pps-pop 0.32s ease-out; }
@keyframes pps-pop { 0% { transform: scale(0.7); } 60% { transform: scale(1.08); } 100% { transform: scale(1); } }
.camera-last-badge {
  position: absolute; top: -9px; right: -9px; display: grid; place-items: center; min-width: 25px; height: 25px;
  padding: 0 6px; border-radius: 999px; border: 2px solid #fff; background: var(--blue);
  color: #fff; font-size: 12.5px; font-weight: 800;
}
.shutter {
  grid-column: 2; width: 80px; height: 80px; padding: 5px; border-radius: 50%;
  border: 4px solid rgba(255, 255, 255, 0.88); background: #fff content-box; cursor: pointer;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35); touch-action: manipulation;
  transition: transform 0.08s ease, opacity 0.2s ease;
}
.shutter:active:not(:disabled), .shutter.is-pressed { transform: scale(0.9); }
.shutter:disabled { opacity: 0.35; cursor: not-allowed; }
.camera-done {
  grid-column: 3; justify-self: end; min-width: 116px; padding: 15px 28px; border: 0; border-radius: 999px;
  background: linear-gradient(180deg, #4b93ff 0%, #1f6ef0 100%); color: #fff;
  font-size: 17px; font-weight: 800; line-height: 1.2; cursor: pointer; touch-action: manipulation;
  box-shadow: 0 12px 26px -10px rgba(31, 110, 240, 0.95), inset 0 1px 0 rgba(255, 255, 255, 0.25);
}
.camera-done:hover { background: linear-gradient(180deg, #5a9cff 0%, #2a76f2 100%); }
.shutter:focus-visible, .camera-done:focus-visible, .camera-icon-btn:focus-visible {
  outline: 3px solid rgba(130, 178, 255, 0.95); outline-offset: 3px;
}
.camera-hint {
  position: absolute; left: 50%; bottom: calc(146px + env(safe-area-inset-bottom)); transform: translateX(-50%);
  max-width: calc(100% - 32px); margin: 0; padding: 9px 16px; border-radius: 999px;
  background: rgba(0, 0, 0, 0.55); color: #f1f5fb; font-size: 14px; font-weight: 600; text-align: center;
  white-space: nowrap; pointer-events: none; transition: opacity 0.3s ease;
}
.camera-hint.is-hidden { opacity: 0; }
.camera-error {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(440px, calc(100% - 40px));
  display: grid; justify-items: center; gap: 16px; padding: 24px; border-radius: 20px;
  background: rgba(18, 28, 48, 0.9); text-align: center;
}
.camera-error p { margin: 0; color: #f6d4d4; font-size: 15px; line-height: 1.6; }

@media (max-width: 480px) {
  .camera-done { min-width: 0; padding: 14px 22px; }
  .camera-hint { white-space: normal; border-radius: 16px; }
}

/* ---------- Corner editor (full screen) ---------- */

.caption-edit {
  flex: none; padding: 7px 12px; border-radius: 999px; border: 1px solid rgba(255, 255, 255, 0.28);
  background: rgba(255, 255, 255, 0.14); color: #fff; font-size: 13px; font-weight: 700; cursor: pointer;
  touch-action: manipulation; transition: background 0.15s ease;
}
.caption-edit:hover { background: rgba(255, 255, 255, 0.24); }
.caption-edit:focus-visible { outline: 3px solid rgba(130, 178, 255, 0.95); outline-offset: 2px; }

.editor-modal {
  position: fixed; inset: 0; z-index: 2147483001; display: grid; grid-template-rows: auto minmax(0, 1fr) auto auto;
  width: 100%; height: 100vh; height: 100dvh; background: #0a1220; color: #fff; animation: pps-fade 0.15s ease;
  -webkit-user-select: none; user-select: none; -webkit-tap-highlight-color: transparent;
}
.editor-top {
  display: flex; align-items: center; gap: 12px; min-width: 0;
  padding: calc(12px + env(safe-area-inset-top)) calc(14px + env(safe-area-inset-right)) 10px calc(18px + env(safe-area-inset-left));
}
.editor-title { flex: none; font-family: var(--font-display); font-size: 17px; font-weight: 700; }
.editor-name { min-width: 0; overflow: hidden; color: #9fb0c8; font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
.editor-close { margin-left: auto; flex: none; }
.editor-stage { position: relative; overflow: hidden; touch-action: none; }
.editor-stage img { position: absolute; display: block; max-width: none; pointer-events: none; transition: filter 0.2s ease; }
.editor-overlay { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
.editor-shade { fill: rgba(5, 10, 20, 0.58); fill-rule: evenodd; }
.editor-quad { fill: rgba(75, 147, 255, 0.08); stroke: #4b93ff; stroke-width: 2.5; stroke-linejoin: round; }
.editor-top-edge { stroke: #ffd166; stroke-width: 4; stroke-linecap: round; }
.editor-top-label { fill: #ffd166; font-family: var(--font-body); font-size: 12px; font-weight: 800; letter-spacing: 0.12em; }
.editor-modal.is-invalid .editor-quad { fill: rgba(255, 107, 107, 0.12); stroke: #ff6b6b; }
.editor-handle {
  position: absolute; left: 0; top: 0; width: 30px; height: 30px; margin: -15px 0 0 -15px; padding: 0;
  border: 3px solid #fff; border-radius: 50%; background: rgba(47, 124, 246, 0.9);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.55); cursor: grab; touch-action: none;
}
.editor-handle::before { content: ""; position: absolute; inset: -12px; border-radius: 50%; } /* bigger touch target */
.editor-handle.is-dragging { cursor: grabbing; background: #ffd166; box-shadow: 0 0 0 6px rgba(255, 209, 102, 0.3), 0 2px 10px rgba(0, 0, 0, 0.55); }
.editor-handle:focus-visible { outline: 3px solid rgba(130, 178, 255, 0.95); outline-offset: 4px; }
.editor-loupe {
  position: absolute; left: 0; top: 0; width: 124px; height: 124px; border-radius: 50%;
  border: 3px solid #fff; background: #000; box-shadow: 0 10px 28px rgba(0, 0, 0, 0.6); pointer-events: none;
}
.editor-hint { min-height: 1.6em; margin: 0; padding: 8px 18px 0; color: #c7d3e6; font-size: 14px; text-align: center; }
.editor-hint.is-error { color: #ff9b9b; }
.editor-bottom {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px 16px;
  padding: 12px calc(18px + env(safe-area-inset-right)) calc(16px + env(safe-area-inset-bottom)) calc(18px + env(safe-area-inset-left));
}
.editor-tools, .editor-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.editor-tool {
  display: inline-flex; align-items: center; gap: 6px; padding: 10px 15px; border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.2); background: rgba(255, 255, 255, 0.08); color: #fff;
  font-size: 14px; font-weight: 700; line-height: 1.2; cursor: pointer; touch-action: manipulation; transition: background 0.15s ease;
}
.editor-tool:hover { background: rgba(255, 255, 255, 0.17); }
.editor-tool svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
.editor-looks {
  display: flex; gap: 2px; padding: 4px; border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.16); background: rgba(255, 255, 255, 0.07);
}
.editor-look {
  padding: 8px 14px; border: 0; border-radius: 999px; background: transparent; color: #c7d3e6;
  font-size: 14px; font-weight: 700; cursor: pointer; touch-action: manipulation; transition: background 0.15s ease, color 0.15s ease;
}
.editor-look[aria-checked="true"] { background: #fff; color: #0f1d33; }
.editor-tool:focus-visible, .editor-look:focus-visible { outline: 3px solid rgba(130, 178, 255, 0.95); outline-offset: 2px; }
.editor-actions .camera-done { min-width: 110px; padding: 12px 24px; }
.editor-modal.is-invalid #editorApplyButton { opacity: 0.5; }

@media (max-width: 720px) {
  .editor-bottom { justify-content: center; }
  .editor-tools, .editor-looks { justify-content: center; }
  .editor-actions { width: 100%; }
  .editor-actions > * { flex: 1; }
}

/* Short screens (phone in landscape, small windows): keep the photo big, put every control in one scrolling row. */
@media (max-height: 560px) {
  .editor-top { padding-top: calc(6px + env(safe-area-inset-top)); padding-bottom: 4px; }
  .editor-title { font-size: 15px; }
  .editor-top .camera-icon-btn { width: 36px; height: 36px; font-size: 24px; }
  .editor-hint { display: none; }
  .editor-bottom {
    flex-wrap: nowrap; justify-content: flex-start; gap: 8px; overflow-x: auto; overscroll-behavior: contain;
    padding-top: 6px; padding-bottom: calc(8px + env(safe-area-inset-bottom)); scrollbar-width: none;
  }
  .editor-bottom::-webkit-scrollbar { display: none; }
  .editor-tools, .editor-looks, .editor-actions { flex: none; flex-wrap: nowrap; width: auto; }
  .editor-actions > * { flex: none; }
  .editor-tool, .editor-look { padding: 8px 12px; font-size: 13px; white-space: nowrap; }
  .editor-actions .camera-done { min-width: 0; padding: 9px 18px; font-size: 15px; }
  .editor-actions { margin-left: auto; }
}

/* ---------- Coffee break (loading screen while a big PDF is prepared) ---------- */

.brew-modal {
  position: fixed; inset: 0; z-index: 2147483002; display: grid; place-items: center; padding: 20px;
  background: rgba(7, 20, 42, 0.74); animation: pps-fade 0.2s ease;
}
.brew-card {
  width: min(420px, 100%); padding: 26px 26px 18px; border-radius: 30px; text-align: center; color: var(--ink);
  background: radial-gradient(120% 80% at 50% 0%, #fffaf3 0%, #f5ece1 100%);
  box-shadow: 0 40px 90px -30px rgba(0, 0, 0, 0.7), inset 0 1px 0 #fff;
  animation: brew-pop 0.4s cubic-bezier(0.2, 0.9, 0.3, 1.25);
}
@keyframes brew-pop { from { opacity: 0; transform: translateY(14px) scale(0.96); } }
.brew-cup { display: block; width: 168px; height: auto; margin: -4px auto 4px; overflow: visible; }
.brew-saucer { fill: #eadccc; stroke: #3b2a20; stroke-width: 5; }
.brew-handle { fill: none; stroke: #3b2a20; stroke-width: 8; stroke-linecap: round; }
.brew-body { fill: #ffffff; }
.brew-outline { fill: none; stroke: #3b2a20; stroke-width: 5; stroke-linejoin: round; }
.brew-rim { fill: none; stroke: #3b2a20; stroke-width: 3; opacity: 0.35; }
.brew-level { transform: translateY(160px); transition: transform 0.6s cubic-bezier(0.3, 0.8, 0.3, 1); }
.brew-wave { animation: brew-wave 1.6s linear infinite; }
@keyframes brew-wave { to { transform: translateX(-50px); } }
.brew-heart { fill: #f2e1cb; opacity: 0; transform: scale(0.4); transform-box: fill-box; transform-origin: center; transition: opacity 0.4s ease 0.2s, transform 0.5s cubic-bezier(0.2, 0.9, 0.3, 1.4) 0.2s; }
.brew-steam path {
  fill: none; stroke: #c4b2a2; stroke-width: 5; stroke-linecap: round; opacity: 0;
  animation: brew-steam 2.4s ease-in-out infinite;
}
.brew-steam path:nth-child(2) { animation-delay: 0.8s; }
.brew-steam path:nth-child(3) { animation-delay: 1.6s; }
@keyframes brew-steam {
  0% { opacity: 0; transform: translateY(12px); }
  35% { opacity: 0.9; }
  100% { opacity: 0; transform: translateY(-16px); }
}
.brew-title {
  margin: 4px 0 4px; font-family: var(--font-display); font-size: 25px; font-weight: 800; letter-spacing: -0.03em; color: #2b1d14;
}
.brew-sub { margin: 0; color: #7a6253; font-size: 14.5px; line-height: 1.5; }
.brew-bar { position: relative; height: 14px; margin: 18px 0 8px; overflow: hidden; border-radius: 999px; background: #e9dccd; box-shadow: inset 0 1px 2px rgba(59, 42, 32, 0.18); }
.brew-fill {
  position: relative; display: block; width: 0; height: 100%; overflow: hidden; border-radius: inherit;
  background: linear-gradient(90deg, #d9a06b 0%, #a8693f 60%, #7a4526 100%);
  transition: width 0.35s ease;
}
.brew-fill::after {
  content: ""; position: absolute; inset: 0;
  background: repeating-linear-gradient(-45deg, rgba(255, 255, 255, 0.22) 0 8px, rgba(255, 255, 255, 0) 8px 16px);
  background-size: 22.6px 22.6px; animation: brew-stripes 0.8s linear infinite;
}
@keyframes brew-stripes { to { background-position: 22.6px 0; } }
.brew-meta { display: flex; justify-content: space-between; gap: 12px; color: #6f5a4c; font-size: 13.5px; font-weight: 600; }
.brew-tip { min-height: 1.5em; margin: 14px 0 6px; color: #a06a43; font-size: 14px; font-style: italic; transition: opacity 0.25s ease; }
.brew-tip.is-fading { opacity: 0; }
.brew-cancel {
  margin-top: 4px; padding: 8px 16px; border: 0; border-radius: 999px; background: transparent;
  color: #7a6253; font-size: 14px; font-weight: 700; cursor: pointer;
}
.brew-cancel:hover { background: rgba(122, 98, 83, 0.1); }
.brew-cancel:focus-visible { outline: 3px solid rgba(168, 105, 63, 0.45); outline-offset: 2px; }
.brew-modal.is-done .brew-heart { opacity: 1; transform: scale(1); }
.brew-modal.is-done .brew-cup { animation: brew-cheers 0.6s cubic-bezier(0.3, 1.4, 0.5, 1); }
.brew-modal.is-done .brew-fill::after { animation: none; opacity: 0; }
.brew-modal.is-done .brew-cancel { visibility: hidden; }
@keyframes brew-cheers { 30% { transform: translateY(-8px) rotate(-4deg); } 60% { transform: translateY(0) rotate(3deg); } }
@media (prefers-reduced-motion: reduce) {
  .brew-steam path { animation: none !important; opacity: 0.6; }
  .brew-wave, .brew-fill::after, .brew-modal.is-done .brew-cup { animation: none !important; }
}

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

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
}
`;

  // ===================================================================
  // Markup
  // ===================================================================

  const ICON_PLUS = '<svg viewBox="0 0 24 24"><path d="M12 6v12M6 12h12"/></svg>';
  const ICON_CHECK = '<span class="check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.2 4.2L19 7"/></svg></span>';
  const ICON_ROTATE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.34 5.66"/><path d="M20 4v7h-7"/></svg>';
  const ICON_SWITCH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 0 1 13.66-5.66L20 8.7"/><path d="M20 4v4.7h-4.7"/><path d="M20 12a8 8 0 0 1-13.66 5.66L4 15.3"/><path d="M4 20v-4.7h4.7"/></svg>';

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
                    <button type="button" class="caption-edit" id="captionEditButton">Edit page</button>
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
                <label class="check-row" for="scanAllInput">
                  <input type="checkbox" id="scanAllInput">
                  <span class="check-text">
                    <strong>Scan all images</strong>
                    <span>Find the page, crop away the background and straighten it.</span>
                  </span>
                </label>
                <div class="field">
                  <label for="lookSelect">Page look</label>
                  <select id="lookSelect">
                    <option value="original" selected>Original colours</option>
                    <option value="enhanced">Enhanced (whiter paper, darker text)</option>
                    <option value="bw">Black &amp; white</option>
                    <option value="mixed" disabled hidden>Mixed (set per page)</option>
                  </select>
                </div>
              </div>
              <div class="summary" aria-label="Export summary">
                <h4>Summary</h4>
                <dl>
                  <div><dt>Pages</dt><dd id="sumPages">0</dd></div>
                  <div><dt>Layout</dt><dd id="sumLayout">A4 / Auto</dd></div>
                  <div><dt>Margin</dt><dd id="sumMargin">24 pt</dd></div>
                  <div><dt>Quality</dt><dd id="sumQuality">90%</dd></div>
                  <div><dt>Scan</dt><dd id="sumScan">Off</dd></div>
                  <div><dt>Look</dt><dd id="sumLook">Original</dd></div>
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

<div class="camera-modal" id="cameraModal" role="dialog" aria-modal="true" aria-label="Camera" hidden>
  <video id="cameraVideo" playsinline muted autoplay></video>
  <div class="camera-flash" id="cameraFlash"></div>
  <div class="camera-top">
    <span class="camera-title">Camera</span>
    <span class="camera-count" id="cameraCount" aria-live="polite">0 photos</span>
    <div class="camera-top-actions">
      <button type="button" class="camera-icon-btn" id="cameraSwitchButton" aria-label="Switch camera" hidden>${ICON_SWITCH}</button>
      <button type="button" class="camera-icon-btn" id="cameraCloseButton" aria-label="Close camera">×</button>
    </div>
  </div>
  <p class="camera-hint" id="cameraHint">Tap the round button for each page, then tap Done.</p>
  <div class="camera-error" id="cameraErrorBox" hidden>
    <p id="cameraError"></p>
    <button type="button" class="btn" id="cameraFallbackButton">Use camera app</button>
  </div>
  <div class="camera-bottom">
    <div class="camera-last is-empty" id="cameraLast" aria-hidden="true">
      <canvas id="cameraLastCanvas" width="120" height="120"></canvas>
      <span class="camera-last-badge" id="cameraLastBadge">0</span>
    </div>
    <button type="button" class="shutter" id="cameraShutter" aria-label="Take photo" disabled></button>
    <button type="button" class="camera-done" id="cameraDoneButton">Done</button>
  </div>
</div>

<div class="editor-modal" id="editorModal" role="dialog" aria-modal="true" aria-label="Adjust page" hidden>
  <div class="editor-top">
    <span class="editor-title">Adjust page</span>
    <span class="editor-name" id="editorName"></span>
    <button type="button" class="camera-icon-btn editor-close" id="editorCloseButton" aria-label="Cancel">×</button>
  </div>
  <div class="editor-stage" id="editorStage">
    <img id="editorImage" alt="" draggable="false">
    <svg class="editor-overlay" id="editorOverlay" aria-hidden="true">
      <path class="editor-shade" id="editorShade"></path>
      <polygon class="editor-quad" id="editorQuad"></polygon>
      <line class="editor-top-edge" id="editorTopEdge"></line>
      <text class="editor-top-label" id="editorTopLabel" text-anchor="middle">TOP</text>
    </svg>
    <button type="button" class="editor-handle" aria-label="Top-left corner (arrow keys move it)"></button>
    <button type="button" class="editor-handle" aria-label="Top-right corner (arrow keys move it)"></button>
    <button type="button" class="editor-handle" aria-label="Bottom-right corner (arrow keys move it)"></button>
    <button type="button" class="editor-handle" aria-label="Bottom-left corner (arrow keys move it)"></button>
    <canvas class="editor-loupe" id="editorLoupe" hidden></canvas>
  </div>
  <p class="editor-hint" id="editorHint" aria-live="polite"></p>
  <div class="editor-bottom">
    <div class="editor-tools">
      <button type="button" class="editor-tool" id="editorAutoButton">Auto detect</button>
      <button type="button" class="editor-tool" id="editorFullButton">Whole photo</button>
      <button type="button" class="editor-tool" id="editorRotateButton">${ICON_ROTATE}Rotate</button>
    </div>
    <div class="editor-looks" role="radiogroup" aria-label="Page look">
      <button type="button" class="editor-look" role="radio" data-look="original" aria-checked="true">Original</button>
      <button type="button" class="editor-look" role="radio" data-look="enhanced" aria-checked="false">Enhanced</button>
      <button type="button" class="editor-look" role="radio" data-look="bw" aria-checked="false">B&amp;W</button>
    </div>
    <div class="editor-actions">
      <button type="button" class="editor-tool editor-cancel" id="editorCancelButton">Cancel</button>
      <button type="button" class="camera-done" id="editorApplyButton">Apply</button>
    </div>
  </div>
</div>

<div class="brew-modal" id="brewModal" role="dialog" aria-modal="true" aria-labelledby="brewTitle" hidden>
  <div class="brew-card">
    <svg class="brew-cup" viewBox="0 0 200 190" aria-hidden="true">
      <defs>
        <clipPath id="ppsCupClip"><path d="M38 62 H152 L142 148 Q140 160 128 160 H62 Q50 160 48 148 Z"/></clipPath>
        <linearGradient id="ppsCoffee" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#c0814f"/>
          <stop offset="0.25" stop-color="#8a5532"/>
          <stop offset="1" stop-color="#4b2a16"/>
        </linearGradient>
      </defs>
      <g class="brew-steam">
        <path d="M72 50 q-9 -10 0 -20 q9 -10 0 -20"/>
        <path d="M95 46 q-9 -10 0 -20 q9 -10 0 -20"/>
        <path d="M118 50 q-9 -10 0 -20 q9 -10 0 -20"/>
      </g>
      <ellipse class="brew-saucer" cx="95" cy="166" rx="82" ry="11"/>
      <path class="brew-handle" d="M149 80 C178 80 180 122 144 128"/>
      <path class="brew-body" d="M38 62 H152 L142 148 Q140 160 128 160 H62 Q50 160 48 148 Z"/>
      <g clip-path="url(#ppsCupClip)">
        <g class="brew-level" id="brewLevel">
          <path class="brew-wave" fill="url(#ppsCoffee)"
            d="M-100 0 Q-87.5 -6 -75 0 T-50 0 T-25 0 T0 0 T25 0 T50 0 T75 0 T100 0 T125 0 T150 0 T175 0 T200 0 T225 0 V140 H-100 Z"/>
          <path class="brew-heart" d="M95 16 c-7 -8 -16 -2 -9 6 l9 8 l9 -8 c7 -8 -2 -14 -9 -6z"/>
        </g>
      </g>
      <path class="brew-outline" d="M38 62 H152 L142 148 Q140 160 128 160 H62 Q50 160 48 148 Z"/>
      <ellipse class="brew-rim" cx="95" cy="62" rx="57" ry="5"/>
    </svg>
    <h2 class="brew-title" id="brewTitle">Enjoy your coffee ☕</h2>
    <p class="brew-sub" id="brewSub">Your PDF is brewing. Sit back for a moment.</p>
    <div class="brew-bar" id="brewBar" role="progressbar" aria-label="PDF progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
      <span class="brew-fill" id="brewFill"></span>
    </div>
    <div class="brew-meta">
      <span id="brewCount">Getting started…</span>
      <span id="brewEta" aria-live="polite"></span>
    </div>
    <p class="brew-tip" id="brewTip">Grinding the beans…</p>
    <button type="button" class="brew-cancel" id="brewCancel">Cancel</button>
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
      scanAllInput: $('scanAllInput'),
      sumScan: $('sumScan'),
      lookSelect: $('lookSelect'),
      sumLook: $('sumLook'),
      captionEditButton: $('captionEditButton'),
      editorModal: $('editorModal'),
      editorName: $('editorName'),
      editorStage: $('editorStage'),
      editorImage: $('editorImage'),
      editorOverlay: $('editorOverlay'),
      editorShade: $('editorShade'),
      editorQuad: $('editorQuad'),
      editorTopEdge: $('editorTopEdge'),
      editorTopLabel: $('editorTopLabel'),
      editorHandles: Array.from(root.querySelectorAll('.editor-handle')),
      editorLoupe: $('editorLoupe'),
      editorHint: $('editorHint'),
      editorAutoButton: $('editorAutoButton'),
      editorFullButton: $('editorFullButton'),
      editorRotateButton: $('editorRotateButton'),
      editorLookButtons: Array.from(root.querySelectorAll('.editor-look')),
      editorCancelButton: $('editorCancelButton'),
      editorCloseButton: $('editorCloseButton'),
      editorApplyButton: $('editorApplyButton'),
      brewModal: $('brewModal'),
      brewTitle: $('brewTitle'),
      brewSub: $('brewSub'),
      brewBar: $('brewBar'),
      brewFill: $('brewFill'),
      brewCount: $('brewCount'),
      brewEta: $('brewEta'),
      brewTip: $('brewTip'),
      brewCancel: $('brewCancel'),
      brewLevel: $('brewLevel'),
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
      cameraHint: $('cameraHint'),
      cameraLast: $('cameraLast'),
      cameraLastCanvas: $('cameraLastCanvas'),
      cameraLastBadge: $('cameraLastBadge'),
      cameraSwitchButton: $('cameraSwitchButton'),
      cameraErrorBox: $('cameraErrorBox'),
      cameraError: $('cameraError'),
      cameraFlash: $('cameraFlash'),
      cameraShutter: $('cameraShutter'),
      cameraDoneButton: $('cameraDoneButton'),
      cameraCloseButton: $('cameraCloseButton'),
      cameraFallbackButton: $('cameraFallbackButton'),
    };

    const state = { items: [], selectedId: null, nextId: 1, busy: false, scanReport: false, defaultLook: 'original' };
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

    function addFiles(fileList, { fromCamera = false, quiet = false } = {}) {
      const all = Array.from(fileList || []);
      const files = all.filter(isImageFile);
      const skipped = all.length - files.length;

      if (!files.length) {
        if (all.length) setStatus(skipped === 1 ? "That file isn't an image." : "Those files aren't images.", 'error');
        return;
      }

      getPool();
      const scanNew = ui.scanAllInput.checked && !ui.scanAllInput.indeterminate;
      if (scanNew) state.scanReport = true;
      let firstNew = null;
      for (const file of files) {
        const item = {
          id: state.nextId,
          file,
          name: file.name || `Photo ${state.nextId}.jpg`,
          size: file.size,
          url: URL.createObjectURL(file),
          thumbUrl: null,
          thumbKey: '', // which scan/look/corners the current thumbnail shows
          previewUrl: null, // the processed page (scanned and/or with a look), when there is one
          previewFailed: false,
          width: 0,
          height: 0,
          status: 'pending',
          error: '',
          encoded: null,
          scan: scanNew,
          scanCorners: null,
          scanState: 'off', // 'off' | 'scanned' | 'not-found'
          cornersManual: false, // corners placed by hand in the editor
          cornersRefine: false, // corners from the editor's auto detect: sharpen them on the full image
          cornerStamp: 0,
          look: state.defaultLook, // 'original' | 'enhanced' | 'bw'
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
      if (!quiet) {
        let message = fromCamera ? `Photo captured. ${plural(state.items.length, 'page')} in the queue.` : `${plural(files.length, 'photo')} added.`;
        if (skipped) message += ` Skipped ${plural(skipped, 'file')} that ${skipped === 1 ? "isn't an image" : "aren't images"}.`;
        setStatus(message, 'success');
      }
      render();
    }

    function processItem(item) {
      item.version += 1;
      const version = item.version;
      const quality = Number(ui.qualityInput.value) / 100;
      const scan = item.scan;
      const look = item.look;
      const renderKey = `${scan ? 1 : 0}|${look}|${item.cornerStamp}`;
      const isStale = () => item.removed || item.version !== version;

      item.encoded = null;
      item.status = 'pending';
      if (!scan && look === 'original') setPreviewUrl(item, null); // back to the original photo straight away

      item.promise = encodeImage(
        {
          file: item.file,
          quality,
          maxEdge: MAX_EDGE,
          thumbEdge: THUMB_EDGE,
          wantThumb: !item.thumbUrl || item.thumbKey !== renderKey,
          scan,
          corners: scan ? item.scanCorners : null, // reuse found corners: a quality change won't re-detect
          refine: scan && item.cornersRefine,
          manual: scan && item.cornersManual,
          look,
        },
        { isStale, onThumb: (message) => { if (!isStale()) applyThumb(item, message, renderKey); } },
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
          item.scanState = !scan ? 'off' : result.scanned ? 'scanned' : 'not-found';
          if (result.scanned) {
            item.scanCorners = result.corners;
            item.cornersRefine = false;
          }
          // Processed pages (scanned or with a look) preview exactly what goes into the PDF.
          setPreviewUrl(item, result.processed ? URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' })) : null);
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

    function applyThumb(item, message, renderKey) {
      if (item.removed) return;
      if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
      item.thumbUrl = URL.createObjectURL(message.thumb);
      item.thumbKey = renderKey;
      item.width = message.srcW;
      item.height = message.srcH;
      scheduleRender();
    }

    function setPreviewUrl(item, url) {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      item.previewUrl = url;
    }

    // Turn scanning on/off for one photo. Returns true if it changed.
    function setItemScan(item, on) {
      if (item.scan === on || item.status === 'error') return false;
      item.scan = on;
      processItem(item);
      return true;
    }

    function toggleScan(id) {
      const item = findItem(id);
      if (!item || !setItemScan(item, !item.scan)) return;
      state.scanReport = true;
      render();
    }

    // Page look for every photo (and for photos added later).
    function setLookAll(look) {
      state.defaultLook = look;
      for (const item of state.items) {
        if (item.status !== 'error' && item.look !== look) {
          item.look = look;
          processItem(item);
        }
      }
      render();
    }

    // Save what the editor produced: corners (turns scanning on) and the look.
    function applyEdit(item, corners, look, { refine, manual }) {
      item.scan = true;
      item.scanCorners = corners;
      item.cornersManual = !!manual;
      item.cornersRefine = !!refine;
      item.cornerStamp += 1;
      item.look = look;
      processItem(item);
      state.selectedId = item.id;
      setStatus(`Updated ${item.name}.`, 'success');
      render();
    }

    function setScanAll(on) {
      let changed = 0;
      for (const item of state.items) if (setItemScan(item, on)) changed += 1;
      if (changed) state.scanReport = true;
      render();
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
      setPreviewUrl(item, null);
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
      // While the full-screen camera is open nothing behind it is visible, so skip the work
      // (keeps the live preview smooth). closeCamera() renders once when it closes.
      if (!ui.cameraModal.hidden) return;
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
        <div class="qi-thumb"><img alt="" draggable="false" decoding="async"><span class="qi-badge" hidden></span></div>
        <div class="qi-body">
          <div class="qi-title"><span class="qi-num"></span><span class="qi-name"></span></div>
          <div class="qi-meta"></div>
          <div class="qi-actions">
            <button type="button" class="chip-btn" data-act="preview">Preview</button>
            <button type="button" class="chip-btn chip-scan" data-act="scan" aria-pressed="false" title="Find the page, crop and straighten it">Scan</button>
            <button type="button" class="chip-btn" data-act="edit" title="Adjust corners, rotate or change the look">Edit</button>
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

      li.querySelector('[data-act="edit"]').disabled = item.status === 'error';
      const scanButton = li.querySelector('[data-act="scan"]');
      scanButton.disabled = item.status === 'error';
      scanButton.setAttribute('aria-pressed', String(item.scan));
      scanButton.classList.toggle('is-on', item.scan);
      const badge = li.querySelector('.qi-badge');
      const label = scanBadge(item);
      badge.hidden = !label;
      if (label) {
        badge.textContent = label.text;
        badge.className = `qi-badge ${label.tone}`;
      }
    }

    function scanBadge(item) {
      if (!item.scan || item.status === 'error') return null;
      if (item.status === 'pending') return { text: 'Scanning…', tone: 'is-working' };
      if (item.scanState === 'scanned') return { text: item.cornersManual ? 'Adjusted' : 'Scanned', tone: 'is-scanned' };
      if (item.scanState === 'not-found') return { text: 'No page found', tone: 'is-missed' };
      return null;
    }

    function describeItem(item) {
      if (item.status === 'error') return item.error;
      let text = `${dimensionsText(item)} / ${formatBytes(item.size)}`;
      if (item.scan && item.status === 'ready') {
        if (item.scanState === 'scanned') text += item.cornersManual ? ' · Adjusted' : ' · Scanned';
        else text += ' · No page found, used as-is';
      }
      if (item.look !== 'original') text += ` · ${LOOK_LABELS[item.look]}`;
      return text;
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
      const src = item ? (item.previewUrl || (item.previewFailed ? item.thumbUrl : item.url)) : null;
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
      ui.captionMeta.textContent = describeItem(item);
      ui.captionEditButton.hidden = item.status === 'error';
      ui.captionBadge.textContent = `Page ${state.items.indexOf(item) + 1}`;
      layoutPaper(item);
    }

    function layoutPaper(item) {
      if (!item || ui.paper.hidden) return;
      const settings = readSettings();
      // Use the size of the picture actually shown (it changes when a page gets straightened).
      const shown = ui.previewImage.complete && ui.previewImage.naturalWidth > 0;
      const imgW = (shown && ui.previewImage.naturalWidth) || item.width || 3;
      const imgH = (shown && ui.previewImage.naturalHeight) || item.height || 4;
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

      // Scan: the checkbox mirrors the photos (ticked = all, dash = some); the summary counts results.
      const readable = state.items.filter((item) => item.status !== 'error');
      const scanOn = readable.filter((item) => item.scan);
      if (readable.length) {
        ui.scanAllInput.checked = scanOn.length === readable.length;
        ui.scanAllInput.indeterminate = scanOn.length > 0 && scanOn.length < readable.length;
      }
      // Page look: the dropdown shows the shared look, or "Mixed" when pages differ.
      const looks = new Set(readable.map((item) => item.look));
      const look = !readable.length ? state.defaultLook : looks.size === 1 ? readable[0].look : 'mixed';
      if (ui.lookSelect.value !== look) ui.lookSelect.value = look;
      ui.sumLook.textContent = LOOK_LABELS[look];

      if (!scanOn.length) {
        ui.sumScan.textContent = readable.length || !ui.scanAllInput.checked ? 'Off' : 'On';
      } else if (scanOn.some((item) => item.status === 'pending')) {
        ui.sumScan.textContent = 'Scanning…';
      } else {
        const found = scanOn.filter((item) => item.scanState === 'scanned').length;
        ui.sumScan.textContent = `${found} of ${scanOn.length} scanned`;
      }
    }

    function reportScan() {
      const scanOn = state.items.filter((item) => item.scan && item.status !== 'error');
      if (!scanOn.length) {
        setStatus('Scan is off. Photos are used as they are.', 'info');
        return;
      }
      const found = scanOn.filter((item) => item.scanState === 'scanned').length;
      const missed = scanOn.length - found;
      let message = `Scanned ${found} of ${plural(scanOn.length, 'photo')}.`;
      if (missed === 1) message += " 1 page edge wasn't found, so that photo is used as-is.";
      else if (missed > 1) message += ` ${missed} page edges weren't found, so those photos are used as-is.`;
      setStatus(message, missed ? 'info' : 'success');
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
      if (state.scanReport && !pending) {
        state.scanReport = false;
        reportScan();
      }
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

    // ---------- Coffee break: a loading screen when the PDF will take a while ----------

    const slowDevice = () => (navigator.hardwareConcurrency || 4) <= 4
      || !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);

    // First guess (ms on one background helper) for preparing a photo, before anything is measured.
    function estimatePageMs(item) {
      const fromFileSize = item.size / 320000; // a phone JPEG is ~0.32 MB per megapixel
      const fromPixels = item.width && item.height ? (item.width * item.height) / 1e6 : 0; // once the size is known
      const megapixels = Math.min(48, Math.max(0.3, fromFileSize, fromPixels));
      let perMegapixel = 20; // decode, resize, encode
      if (item.scan) perMegapixel += 20; // find + straighten the page
      if (item.look !== 'original') perMegapixel += 12; // Enhanced / B&W
      return (40 + megapixels * perMegapixel) * (slowDevice() ? 2.5 : 1);
    }

    function brewTips(items) {
      const tips = ['Grinding the beans… reading your photos'];
      if (items.some((item) => item.scan)) tips.push('Straightening the pages…');
      if (items.some((item) => item.look === 'enhanced')) tips.push('Whitening the paper, darkening the text…');
      if (items.some((item) => item.look === 'bw')) tips.push('Inking your pages in black & white…');
      tips.push('Brewing your PDF…', 'Adding a little crema on top…', 'Almost time for that first sip…');
      return tips;
    }

    function formatWait(ms) {
      if (ms < 1500) return 'Almost ready…';
      const seconds = Math.ceil(ms / 1000);
      if (seconds < 60) return `About ${seconds} seconds left`;
      const minutes = Math.floor(seconds / 60);
      const rest = seconds % 60;
      return `About ${minutes} min${rest ? ` ${rest} s` : ''} left`;
    }

    function setBrewProgress(share) {
      const pct = Math.round(share * 100);
      ui.brewFill.style.width = `${pct}%`;
      ui.brewBar.setAttribute('aria-valuenow', String(pct));
      ui.brewLevel.style.transform = `translateY(${160 - 92 * share}px)`; // the cup fills up with the progress
    }

    let activeBrew = null;

    // Predicts how long the remaining pages need. Shows the coffee screen if that's more than ~1.5 s
    // (or if the wait turns out longer than 0.9 s anyway), so quick downloads never flash it.
    function createBrew() {
      const waiting = state.items.filter((item) => item.status === 'pending');
      const weights = new Map(waiting.map((item) => [item, estimatePageMs(item)]));
      let totalWeight = 0;
      weights.forEach((w) => { totalWeight += w; });
      const predictedMs = totalWeight / parallelJobs();
      const startedAt = performance.now();
      const tips = brewTips(waiting);
      let shown = false;
      let cancelled = false;
      let finished = false;
      let showTimer = 0;
      let ticker = 0;
      let tipTimer = 0;
      let closeTimer = 0;
      let progress = 0;
      let eta = null;
      let tipIndex = 0;
      let focusBefore = null;
      let savedOverflow = '';
      let resolveCancel = () => {};
      const cancelPromise = new Promise((resolve) => { resolveCancel = resolve; });

      const doneWeight = () => {
        let done = 0;
        weights.forEach((w, item) => { if (item.status !== 'pending' || item.removed) done += w; });
        return done;
      };

      function paint() {
        const elapsed = performance.now() - startedAt;
        const share = totalWeight ? doneWeight() / totalWeight : 1;
        // Once pages start finishing, trust the real speed; before that, use the prediction.
        let guess;
        if (share > 0 && share < 1) guess = (elapsed * (1 - share)) / share;
        else if (share >= 1) guess = 0;
        else guess = Math.max(predictedMs - elapsed, elapsed * 0.6); // slower than predicted: stretch, don't promise "almost"
        eta = eta === null ? guess : eta * 0.8 + guess * 0.2;
        const byTime = elapsed / (elapsed + Math.max(eta, 1));
        progress = Math.max(progress, Math.min(0.97, Math.max(share, byTime))); // never goes backwards
        setBrewProgress(progress);
        const usable = state.items.filter((item) => item.status !== 'error');
        const ready = usable.filter((item) => item.status === 'ready').length;
        ui.brewCount.textContent = `${ready} of ${plural(usable.length, 'page')} ready`;
        ui.brewEta.textContent = formatWait(eta);
      }

      function nextTip() {
        tipIndex = (tipIndex + 1) % tips.length;
        ui.brewTip.classList.add('is-fading');
        setTimeout(() => {
          ui.brewTip.textContent = tips[tipIndex];
          ui.brewTip.classList.remove('is-fading');
        }, 250);
      }

      function stopTimers() {
        clearTimeout(showTimer);
        clearInterval(ticker);
        clearInterval(tipTimer);
      }

      function show() {
        if (shown || cancelled || finished) return;
        shown = true;
        activeBrew = controller;
        focusBefore = root.activeElement;
        ui.brewModal.classList.remove('is-done');
        ui.brewTitle.textContent = 'Enjoy your coffee ☕';
        ui.brewSub.textContent = `Your PDF is brewing (${plural(waiting.length, 'page')} to prepare). Sit back for a moment.`;
        ui.brewTip.textContent = tips[0];
        setBrewProgress(0);
        ui.brewModal.hidden = false;
        savedOverflow = document.documentElement.style.overflow;
        document.documentElement.style.overflow = 'hidden';
        ui.brewCancel.focus();
        paint();
        ticker = setInterval(paint, 250);
        tipTimer = setInterval(nextTip, 2600);
      }

      function close() {
        stopTimers();
        clearTimeout(closeTimer);
        if (!shown) return;
        shown = false;
        ui.brewModal.hidden = true;
        ui.brewModal.classList.remove('is-done');
        document.documentElement.style.overflow = savedOverflow;
        if (focusBefore && typeof focusBefore.focus === 'function') focusBefore.focus();
        if (activeBrew === controller) activeBrew = null;
      }

      const controller = {
        predictedMs,
        cancelPromise,
        get cancelled() { return cancelled; },
        get done() { return finished; },
        update() { if (shown) paint(); },
        cancel() {
          if (finished) return;
          cancelled = true;
          resolveCancel();
          close();
        },
        finish(message) {
          finished = true;
          stopTimers();
          if (!shown) return;
          setBrewProgress(1);
          ui.brewModal.classList.add('is-done');
          ui.brewTitle.textContent = 'Your PDF is ready! ☕';
          ui.brewSub.textContent = message;
          ui.brewCount.textContent = 'All pages ready';
          ui.brewEta.textContent = 'Done';
          ui.brewTip.textContent = 'Enjoy your coffee, and your PDF.';
          closeTimer = setTimeout(close, 1800);
        },
        close,
      };

      if (waiting.length) {
        if (predictedMs > 1500) show();
        else showTimer = setTimeout(show, 900);
      }
      return controller;
    }

    // ---------- Export ----------

    // Waits until every page is prepared. Returns false if the coffee screen's Cancel was pressed.
    async function waitForPages(onProgress, brew) {
      for (;;) {
        if (brew && brew.cancelled) return false;
        const pending = state.items.filter((item) => item.status === 'pending');
        if (!pending.length) return true;
        const usable = state.items.filter((item) => item.status !== 'error').length;
        onProgress(usable - pending.length, usable);
        const waits = pending.map((item) => item.promise);
        if (brew) waits.push(brew.cancelPromise);
        await Promise.race(waits);
      }
    }

    async function generatePdf() {
      if (state.busy) return;
      state.busy = true;
      ui.generateButton.classList.add('is-busy');
      ui.generateLabel.textContent = 'Building PDF…';
      renderControls();
      const brew = createBrew();

      try {
        const complete = await waitForPages((ready, total) => {
          setStatus(`Preparing pages… ${ready}/${total} ready.`, 'working');
          ui.generateLabel.textContent = `Preparing ${ready}/${total}…`;
          brew.update();
        }, brew);
        if (!complete) {
          setStatus('Download cancelled. Your pages keep getting ready in the background, so the next try is quicker.', 'info');
          return;
        }

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
        state.scanReport = false; // the "Saved…" message matters more than a scan summary
        setStatus(message, 'success');
        brew.finish(`Saved ${fileName}: ${plural(pages.length, 'page')}, ${formatBytes(blob.size)}.`);
      } catch (error) {
        brew.close();
        setStatus((error && error.message) || 'Could not build the PDF.', 'error');
      } finally {
        state.busy = false;
        ui.generateButton.classList.remove('is-busy');
        ui.generateLabel.textContent = 'Download PDF';
        render();
      }
    }

    // ---------- Camera: full screen, take as many photos as you like, then Done ----------

    let cameraStream = null;
    let cameraDevices = [];
    let cameraDeviceId = null; // remembered, so the camera reopens on the one you used last
    let cameraStartToken = 0;
    let cameraSessionCount = 0;
    let cameraSerial = 0;
    let cameraAddChain = Promise.resolve(); // keeps photos in the order they were taken
    let cameraWasFullscreen = false;
    let focusBeforeCamera = null;
    let savedOverflow = '';

    const cameraAvailable = () =>
      !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && window.isSecureContext;
    const finePointer = () => !!(window.matchMedia && window.matchMedia('(pointer: fine)').matches);
    const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;

    function enterFullscreen(element) {
      const request = element.requestFullscreen || element.webkitRequestFullscreen;
      if (!request) return; // e.g. iPhone: the camera still fills the whole screen
      try {
        const result = request.call(element, { navigationUI: 'hide' });
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch (_) { /* not allowed here: stay as a full-window overlay */ }
    }

    function exitFullscreen() {
      if (!fullscreenElement()) return;
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      try {
        const result = exit.call(document);
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch (_) { /* ignore */ }
    }

    function updateCameraCount() {
      ui.cameraCount.textContent = plural(cameraSessionCount, 'photo');
      ui.cameraLastBadge.textContent = String(cameraSessionCount);
      ui.cameraLast.classList.toggle('is-empty', cameraSessionCount === 0);
      ui.cameraHint.classList.toggle('is-hidden', cameraSessionCount > 0);
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
      ui.cameraErrorBox.hidden = false;
      ui.cameraHint.classList.add('is-hidden');
      ui.cameraShutter.disabled = true;
      ui.cameraDoneButton.focus();
    }

    async function startStream(deviceId) {
      cameraStartToken += 1;
      const token = cameraStartToken;
      stopCameraStream();
      ui.cameraShutter.disabled = true;

      // 1080p at 30 fps: starts fast and keeps the preview smooth (4K makes many cameras slow and choppy).
      const size = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
      const video = deviceId ? { deviceId: { exact: deviceId }, ...size } : { facingMode: { ideal: 'environment' }, ...size };
      const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      if (token !== cameraStartToken || ui.cameraModal.hidden) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      cameraStream = stream;
      const track = stream.getVideoTracks()[0];
      const info = track && typeof track.getSettings === 'function' ? track.getSettings() : {};
      cameraDeviceId = info.deviceId || deviceId || null;
      ui.cameraModal.classList.toggle('is-mirrored', info.facingMode === 'user'); // selfie camera: mirror the preview only
      ui.cameraVideo.srcObject = stream;
      await ui.cameraVideo.play().catch(() => {});
      ui.cameraErrorBox.hidden = true;
      ui.cameraShutter.disabled = false;

      try {
        cameraDevices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'videoinput');
      } catch (_) {
        cameraDevices = [];
      }
      ui.cameraSwitchButton.hidden = cameraDevices.length < 2;
    }

    async function openCamera() {
      if (!cameraAvailable()) {
        ui.cameraInput.click(); // no camera access here (e.g. not https): use the phone's camera app
        return;
      }
      if (!ui.cameraModal.hidden) return;
      getPool();
      focusBeforeCamera = root.activeElement;
      cameraSessionCount = 0;
      updateCameraCount();
      ui.cameraHint.textContent = finePointer()
        ? 'Click the round button (or press Space) for each page, then click Done.'
        : 'Tap the round button for each page, then tap Done.';
      ui.cameraErrorBox.hidden = true;
      ui.cameraSwitchButton.hidden = true;
      ui.cameraModal.hidden = false;
      cameraWasFullscreen = false;
      enterFullscreen(ui.cameraModal); // must happen right inside the click
      savedOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = 'hidden';
      ui.cameraDoneButton.focus();

      try {
        try {
          await startStream(cameraDeviceId);
        } catch (error) {
          if (!cameraDeviceId) throw error;
          cameraDeviceId = null; // the remembered camera is gone: use the default one
          await startStream(null);
        }
        if (!ui.cameraModal.hidden && !ui.cameraShutter.disabled) ui.cameraShutter.focus();
      } catch (error) {
        if (!ui.cameraModal.hidden) showCameraError(error);
      }
    }

    async function switchCamera() {
      if (cameraDevices.length < 2) return;
      const index = cameraDevices.findIndex((device) => device.deviceId === cameraDeviceId);
      const next = cameraDevices[(index + 1) % cameraDevices.length];
      try {
        await startStream(next.deviceId);
        ui.cameraShutter.focus();
      } catch (error) {
        showCameraError(error);
      }
    }

    function closeCamera() {
      if (ui.cameraModal.hidden) return;
      cameraStartToken += 1; // cancel a camera that is still starting
      stopCameraStream();
      cameraWasFullscreen = false;
      exitFullscreen();
      ui.cameraModal.hidden = true;
      document.documentElement.style.overflow = savedOverflow;
      render(); // catch the page up on everything added while the camera was open
      const taken = cameraSessionCount;
      if (taken) {
        cameraAddChain.then(() => {
          setStatus(`Added ${plural(taken, 'photo')} from the camera. ${plural(state.items.length, 'page')} in the queue.`, 'success');
        });
      }
      if (focusBeforeCamera && typeof focusBeforeCamera.focus === 'function') focusBeforeCamera.focus();
    }

    function drawCameraThumb(video, w, h) {
      const canvas = ui.cameraLastCanvas;
      const scale = Math.max(canvas.width / w, canvas.height / h);
      const dw = w * scale;
      const dh = h * scale;
      canvas.getContext('2d').drawImage(video, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
    }

    // Snapshot the current frame right away; the JPEG encoding happens on a background thread.
    async function grabFrame(video) {
      const workerPool = getPool();
      if (workerPool && !poolBroken && typeof createImageBitmap === 'function') {
        let frame = null;
        try {
          frame = await createImageBitmap(video);
        } catch (_) {
          frame = null;
        }
        if (frame) {
          try {
            const result = await workerPool.run(
              { frame, quality: CAMERA_JPEG_QUALITY, maxEdge: MAX_EDGE },
              FRAME_HOOKS,
              { transfer: [frame], priority: true },
            );
            if (result && result.blob) return result.blob;
          } catch (_) { /* fall back to the main thread below */ }
        }
      }
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) throw new Error('No camera frame');
      const size = fitWithin(w, h, MAX_EDGE);
      const canvas = mainMakeCanvas(size.w, size.h);
      canvas.getContext('2d', { alpha: false }).drawImage(video, 0, 0, size.w, size.h);
      return mainToBlob(canvas, CAMERA_JPEG_QUALITY);
    }

    function capturePhoto() {
      if (ui.cameraModal.hidden || ui.cameraShutter.disabled) return;
      const video = ui.cameraVideo;
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) return;

      const framePromise = grabFrame(video); // takes the snapshot immediately
      drawCameraThumb(video, w, h); // instant feedback, no encoding needed

      cameraSessionCount += 1;
      cameraSerial += 1;
      const serial = cameraSerial;
      updateCameraCount();

      ui.cameraFlash.classList.remove('is-flashing');
      ui.cameraLast.classList.remove('is-pop');
      void ui.cameraFlash.offsetWidth; // restart the animations
      ui.cameraFlash.classList.add('is-flashing');
      ui.cameraLast.classList.add('is-pop');

      // Add to the queue in shooting order, even if a later shot finishes encoding first.
      cameraAddChain = cameraAddChain
        .then(() => framePromise)
        .then((blob) => {
          const file = new File([blob], `Camera ${String(serial).padStart(2, '0')}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
          addFiles([file], { fromCamera: true, quiet: true }); // starts preparing the PDF page right away
        })
        .catch(() => {});
    }

    function trapCameraFocus(event) {
      const focusable = Array.from(ui.cameraModal.querySelectorAll('button'))
        .filter((el) => !el.disabled && el.getClientRects().length > 0);
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

    // ---------- Corner editor: drag the 4 corners, rotate, pick a look ----------

    // Rough on-screen preview of each look (the real processing happens in the background on Apply).
    const LOOK_PREVIEW = {
      original: 'none',
      enhanced: 'brightness(1.08) contrast(1.35) saturate(1.05)',
      bw: 'grayscale(1) brightness(1.15) contrast(2.4)',
    };
    const FULL_PHOTO = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const EDITOR_PAD = 26; // room around the photo so corner handles stay grabbable
    const editor = {
      item: null, corners: null, look: 'original',
      fromAuto: false, // corners fresh from auto detect: sharpen them on the full image
      handPlaced: false, // corners dragged / whole photo: use them exactly (rotating doesn't count)
      rect: null, dragging: -1, grab: [0, 0], focusBefore: null, savedOverflow: '',
    };

    const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

    function setEditorHint(text, isError = false) {
      ui.editorHint.textContent = text;
      ui.editorHint.classList.toggle('is-error', isError);
    }

    function quadIsConvex(c) {
      let sign = 0;
      for (let i = 0; i < 4; i += 1) {
        const a = c[i]; const b = c[(i + 1) % 4]; const d = c[(i + 2) % 4];
        const cross = (b[0] - a[0]) * (d[1] - b[1]) - (b[1] - a[1]) * (d[0] - b[0]);
        if (Math.abs(cross) < 1e-9) return false;
        const s = cross > 0 ? 1 : -1;
        if (sign && s !== sign) return false;
        sign = s;
      }
      return true;
    }

    function detectInEditor() {
      const img = ui.editorImage;
      const small = fitWithin(img.naturalWidth, img.naturalHeight, 512);
      const canvas = mainMakeCanvas(small.w, small.h);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, small.w, small.h);
      ctx.drawImage(img, 0, 0, small.w, small.h);
      return detectDocument(ctx.getImageData(0, 0, small.w, small.h));
    }

    function layoutEditor() {
      const img = ui.editorImage;
      if (!editor.corners || !img.naturalWidth) return;
      const stageW = ui.editorStage.clientWidth;
      const stageH = ui.editorStage.clientHeight;
      if (stageW < EDITOR_PAD * 3 || stageH < EDITOR_PAD * 3) return; // no room yet (e.g. mid-resize)
      const scale = Math.min((stageW - EDITOR_PAD * 2) / img.naturalWidth, (stageH - EDITOR_PAD * 2) / img.naturalHeight);
      const w = img.naturalWidth * scale;
      const h = img.naturalHeight * scale;
      editor.rect = { x: (stageW - w) / 2, y: (stageH - h) / 2, w, h, stageW, stageH };
      Object.assign(img.style, { left: `${editor.rect.x}px`, top: `${editor.rect.y}px`, width: `${w}px`, height: `${h}px` });
      drawEditor();
    }

    function drawEditor() {
      const r = editor.rect;
      if (!r) return;
      const pts = editor.corners.map((p) => [r.x + p[0] * r.w, r.y + p[1] * r.h]);
      pts.forEach((p, i) => { ui.editorHandles[i].style.transform = `translate(${p[0]}px, ${p[1]}px)`; });
      const poly = pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
      ui.editorOverlay.setAttribute('viewBox', `0 0 ${r.stageW} ${r.stageH}`);
      ui.editorQuad.setAttribute('points', poly);
      ui.editorShade.setAttribute('d', `M0 0H${r.stageW}V${r.stageH}H0Z M${pts.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('L')}Z`);
      // The edge that will become the top of the page (moves when you press Rotate).
      ui.editorTopEdge.setAttribute('x1', pts[0][0]); ui.editorTopEdge.setAttribute('y1', pts[0][1]);
      ui.editorTopEdge.setAttribute('x2', pts[1][0]); ui.editorTopEdge.setAttribute('y2', pts[1][1]);
      const cx = (pts[0][0] + pts[1][0] + pts[2][0] + pts[3][0]) / 4;
      const cy = (pts[0][1] + pts[1][1] + pts[2][1] + pts[3][1]) / 4;
      const mx = (pts[0][0] + pts[1][0]) / 2;
      const my = (pts[0][1] + pts[1][1]) / 2;
      const len = Math.hypot(mx - cx, my - cy) || 1;
      ui.editorTopLabel.setAttribute('x', mx + ((mx - cx) / len) * 16);
      ui.editorTopLabel.setAttribute('y', my + ((my - cy) / len) * 16 + 4);
      const valid = quadIsConvex(editor.corners);
      ui.editorModal.classList.toggle('is-invalid', !valid);
      ui.editorApplyButton.disabled = !valid;
      if (!valid) setEditorHint('The corners cross over. Drag them back into a box shape.', true);
      else if (ui.editorHint.classList.contains('is-error')) setEditorHint('Drag the corners onto the page’s corners.');
    }

    function drawLoupe(i) {
      const img = ui.editorImage;
      const r = editor.rect;
      const loupe = ui.editorLoupe;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const size = 124;
      if (loupe.width !== size * dpr) { loupe.width = size * dpr; loupe.height = size * dpr; }
      const ctx = loupe.getContext('2d');
      const zoom = 3;
      const span = (size / zoom) * (img.naturalWidth / r.w); // source pixels shown across the loupe
      const [u, v] = editor.corners[i];
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, loupe.width, loupe.height);
      ctx.filter = LOOK_PREVIEW[editor.look] || 'none';
      ctx.drawImage(img, u * img.naturalWidth - span / 2, v * img.naturalHeight - span / 2, span, span, 0, 0, loupe.width, loupe.height);
      ctx.filter = 'none';
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath();
      ctx.moveTo(loupe.width / 2, loupe.height * 0.2); ctx.lineTo(loupe.width / 2, loupe.height * 0.8);
      ctx.moveTo(loupe.width * 0.2, loupe.height / 2); ctx.lineTo(loupe.width * 0.8, loupe.height / 2);
      ctx.stroke();
      // Keep the loupe away from the finger: above the corner, or below it near the top edge.
      const px = r.x + u * r.w;
      const py = r.y + v * r.h;
      let lx = px - size / 2;
      let ly = py - size - 46;
      if (ly < 6) ly = py + 46;
      lx = Math.max(6, Math.min(r.stageW - size - 6, lx));
      loupe.style.transform = `translate(${lx}px, ${ly}px)`;
      loupe.hidden = false;
    }

    function setEditorLook(look) {
      editor.look = look;
      ui.editorLookButtons.forEach((button) => button.setAttribute('aria-checked', String(button.dataset.look === look)));
      ui.editorImage.style.filter = LOOK_PREVIEW[look] || 'none';
    }

    function startEditorCorners(item) {
      if (item.scan && item.scanCorners) {
        editor.corners = item.scanCorners.map((p) => p.slice());
        editor.fromAuto = !!item.cornersRefine;
        editor.handPlaced = !!item.cornersManual;
        setEditorHint('Drag the corners onto the page’s corners.');
        return;
      }
      const found = detectInEditor();
      editor.corners = found || FULL_PHOTO.map((p) => [0.06 + p[0] * 0.88, 0.06 + p[1] * 0.88]);
      editor.fromAuto = !!found;
      editor.handPlaced = false;
      setEditorHint(found ? 'Page found. Fine-tune the corners if needed.' : "Couldn't find the page edges. Drag the corners onto the page's corners.");
    }

    function openEditor(id) {
      const item = findItem(id);
      if (!item || item.status === 'error' || !ui.editorModal.hidden) return;
      editor.item = item;
      editor.corners = null;
      editor.rect = null;
      editor.dragging = -1;
      editor.focusBefore = root.activeElement;
      ui.editorName.textContent = item.name;
      ui.editorLoupe.hidden = true;
      setEditorLook(item.look);
      setEditorHint('Loading…');
      ui.editorModal.hidden = false;
      editor.savedOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = 'hidden';
      ui.editorCancelButton.focus();

      const img = ui.editorImage;
      const ready = () => {
        if (ui.editorModal.hidden || editor.item !== item) return;
        startEditorCorners(item);
        layoutEditor();
        ui.editorHandles[0].focus();
      };
      img.onload = ready;
      img.onerror = () => setEditorHint("This photo can't be shown here.", true);
      if (img.getAttribute('src') === item.url && img.complete && img.naturalWidth) ready();
      else img.src = item.url; // the original photo, so you can see what was cropped away
    }

    function closeEditor() {
      if (ui.editorModal.hidden) return;
      ui.editorModal.hidden = true;
      ui.editorImage.onload = null;
      ui.editorLoupe.hidden = true;
      editor.item = null;
      editor.dragging = -1;
      document.documentElement.style.overflow = editor.savedOverflow;
      if (editor.focusBefore && typeof editor.focusBefore.focus === 'function') editor.focusBefore.focus();
    }

    function applyEditor() {
      const item = editor.item;
      if (!item || !editor.corners || !quadIsConvex(editor.corners)) return;
      if (item.removed) { closeEditor(); return; }
      const corners = editor.corners.map((p) => [clamp01(p[0]), clamp01(p[1])]);
      const { look, fromAuto, handPlaced } = editor;
      closeEditor();
      applyEdit(item, corners, look, { refine: fromAuto && !handPlaced, manual: handPlaced });
    }

    function moveCornerTo(i, clientX, clientY) {
      const r = editor.rect;
      const box = ui.editorStage.getBoundingClientRect();
      editor.corners[i] = [
        clamp01((clientX - box.left - editor.grab[0] - r.x) / r.w),
        clamp01((clientY - box.top - editor.grab[1] - r.y) / r.h),
      ];
      editor.fromAuto = false; // placed by hand now
      editor.handPlaced = true;
      drawEditor();
      drawLoupe(i);
    }

    ui.editorHandles.forEach((handle, i) => {
      handle.addEventListener('pointerdown', (event) => {
        if (!editor.rect || event.button > 0) return;
        event.preventDefault();
        try { handle.setPointerCapture(event.pointerId); } catch (_) { /* pointer already gone */ }
        const r = editor.rect;
        const box = ui.editorStage.getBoundingClientRect();
        // Remember where on the handle you grabbed it, so it doesn't jump under your finger.
        editor.grab = [
          event.clientX - box.left - (r.x + editor.corners[i][0] * r.w),
          event.clientY - box.top - (r.y + editor.corners[i][1] * r.h),
        ];
        editor.dragging = i;
        handle.classList.add('is-dragging');
        handle.focus({ preventScroll: true });
        drawLoupe(i);
      });
      handle.addEventListener('pointermove', (event) => {
        if (editor.dragging === i) moveCornerTo(i, event.clientX, event.clientY);
      });
      const endDrag = () => {
        if (editor.dragging !== i) return;
        editor.dragging = -1;
        handle.classList.remove('is-dragging');
        ui.editorLoupe.hidden = true;
      };
      handle.addEventListener('pointerup', endDrag);
      handle.addEventListener('pointercancel', endDrag);
      handle.addEventListener('keydown', (event) => {
        const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        const move = moves[event.key];
        if (!move || !editor.corners) return;
        event.preventDefault();
        const step = event.shiftKey ? 0.02 : 0.002;
        const c = editor.corners[i];
        editor.corners[i] = [clamp01(c[0] + move[0] * step), clamp01(c[1] + move[1] * step)];
        editor.fromAuto = false;
        editor.handPlaced = true;
        drawEditor();
      });
    });

    ui.editorAutoButton.addEventListener('click', () => {
      if (!ui.editorImage.naturalWidth) return;
      const found = detectInEditor();
      if (found) {
        editor.corners = found;
        editor.fromAuto = true;
        editor.handPlaced = false;
        setEditorHint('Page found. Fine-tune the corners if needed.');
      } else {
        setEditorHint("Couldn't find the page edges. Drag the corners onto the page's corners.", true);
      }
      drawEditor();
    });
    ui.editorFullButton.addEventListener('click', () => {
      editor.corners = FULL_PHOTO.map((p) => p.slice());
      editor.fromAuto = false;
      editor.handPlaced = true;
      setEditorHint('Using the whole photo. Rotate or pick a look, then Apply.');
      drawEditor();
    });
    ui.editorRotateButton.addEventListener('click', () => {
      if (!editor.corners) return;
      const c = editor.corners;
      editor.corners = [c[3], c[0], c[1], c[2]]; // the left side becomes the top: turns the page clockwise
      setEditorHint('Rotated. The yellow edge will be the top of the page.');
      drawEditor();
    });
    ui.editorLookButtons.forEach((button) => button.addEventListener('click', () => setEditorLook(button.dataset.look)));
    ui.editorApplyButton.addEventListener('click', applyEditor);
    ui.editorCancelButton.addEventListener('click', closeEditor);
    ui.editorCloseButton.addEventListener('click', closeEditor);
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => { if (!ui.editorModal.hidden) layoutEditor(); }).observe(ui.editorStage);
    }

    function trapEditorFocus(event) {
      const focusable = Array.from(ui.editorModal.querySelectorAll('button'))
        .filter((el) => !el.disabled && el.getClientRects().length > 0);
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
      else if (action === 'scan') {
        state.selectedId = id; // show the result in the preview
        toggleScan(id);
      } else if (action === 'edit') openEditor(id);
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
    ui.scanAllInput.addEventListener('change', () => {
      ui.scanAllInput.indeterminate = false;
      setScanAll(ui.scanAllInput.checked);
    });
    ui.lookSelect.addEventListener('change', () => {
      if (ui.lookSelect.value !== 'mixed') setLookAll(ui.lookSelect.value);
    });
    ui.captionEditButton.addEventListener('click', () => {
      if (state.selectedId !== null) openEditor(state.selectedId);
    });
    ui.filenameInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !ui.generateButton.disabled) generatePdf();
    });
    ui.generateButton.addEventListener('click', generatePdf);
    ui.brewCancel.addEventListener('click', () => { if (activeBrew) activeBrew.cancel(); });
    ui.brewModal.addEventListener('click', (event) => {
      // Once the PDF is ready, a tap anywhere closes the screen.
      if (activeBrew && activeBrew.done && event.target === ui.brewModal) activeBrew.close();
    });

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
    // Shoot the moment the finger/mouse goes down (no waiting for release).
    ui.cameraShutter.addEventListener('pointerdown', (event) => {
      if (event.button > 0) return; // ignore right/middle clicks
      event.preventDefault();
      ui.cameraShutter.classList.add('is-pressed');
      capturePhoto();
    });
    const releaseShutter = () => ui.cameraShutter.classList.remove('is-pressed');
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((type) => ui.cameraShutter.addEventListener(type, releaseShutter));
    ui.cameraShutter.addEventListener('click', (event) => {
      if (event.detail === 0) capturePhoto(); // keyboard (Enter/Space); pointer presses already shot
    });
    ui.cameraDoneButton.addEventListener('click', closeCamera);
    ui.cameraCloseButton.addEventListener('click', closeCamera);
    ui.cameraSwitchButton.addEventListener('click', switchCamera);
    ui.cameraFallbackButton.addEventListener('click', () => {
      closeCamera();
      ui.cameraInput.click();
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
        if (!ui.brewModal.hidden) {
          if (event.key === 'Escape') {
            event.preventDefault();
            if (activeBrew) {
              if (activeBrew.done) activeBrew.close();
              else activeBrew.cancel();
            }
          } else if (event.key === 'Tab') {
            event.preventDefault(); // Cancel is the only control here
            ui.brewCancel.focus();
          }
          return;
        }
        if (!ui.editorModal.hidden) {
          const onHandle = root.activeElement && root.activeElement.classList.contains('editor-handle');
          if (event.key === 'Escape') {
            event.preventDefault();
            closeEditor();
          } else if (event.key === 'Tab') {
            trapEditorFocus(event);
          } else if (event.key === 'Enter' && onHandle) {
            event.preventDefault();
            applyEditor();
          }
          return;
        }
        if (ui.cameraModal.hidden) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          closeCamera();
        } else if (event.key === 'Tab') {
          trapCameraFocus(event);
        } else if (event.key === ' ' && !event.repeat) {
          // Space takes a photo, unless a button has focus (then Space presses that button).
          const active = root.activeElement;
          if (active && active.tagName === 'BUTTON') return;
          event.preventDefault();
          capturePhoto();
        }
      }],
      // Leaving full screen (Esc, or the back gesture on Android) also closes the camera.
      ...['fullscreenchange', 'webkitfullscreenchange'].map((type) => [document, type, () => {
        if (ui.cameraModal.hidden) return;
        if (fullscreenElement()) cameraWasFullscreen = true;
        else if (cameraWasFullscreen) closeCamera();
      }]),
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
      closeEditor();
      if (activeBrew) activeBrew.close();
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
