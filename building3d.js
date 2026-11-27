/* =====================================================================
 * building3d.js — engine dựng dự án căn hộ 3D từ dữ liệu JSON.
 * Dùng chung cho viewer.html (trang xem) và admin.html (xem trước).
 *
 * Cách dùng:
 *   const v = Project3D.create(THREE, { OrbitControls, CSS2DRenderer, CSS2DObject }, containerEl, { compact: false });
 *   v.load(projectJson);
 *
 * Định dạng dữ liệu (đơn vị mét, gốc tọa độ = góc trên-trái ảnh mặt bằng, trục y hướng xuống):
 * {
 *   "project": "Tên dự án",
 *   "ground": { "image": "url hoặc dataURL", "widthMeters": 260, "heightMeters": 180 },
 *   "status": { "S6.01-2501": "sold", ... }          // tùy chọn; không có → trạng thái giả lập
 *   "towers": [{
 *     "code": "S6.01", "color": "#0d9488", "roofColor": "#7dd3c0",
 *     "floors": 25, "floorHeight": 3.2, "floorHeightOverrides": { "1": 4.5 },
 *     "unitsPerFloor": 14, "nonSaleFloors": "1-3",
 *     "plans": [ { "floorFrom": 1, "floorTo": 3, "polygon": [[x,y], ...] }, ... ]
 *   }]
 * }
 * Tòa được dựng bằng cách lấy mỗi lát cắt (polygon) kéo lên thành khối cho từng tầng trong khoảng floorFrom→floorTo.
 * ===================================================================== */
(function () {
  'use strict';

  const STATUS = {
    available: { label: 'Còn hàng', color: '#22c55e' },
    locking: { label: 'Đang khóa', color: '#f59e0b' },
    deposited: { label: 'Đã cọc', color: '#8b5cf6' },
    sold: { label: 'Đã bán', color: '#9ca3af' },
  };
  const pad = n => String(n).padStart(2, '0');

  // ---------------------------------------------------------------- tiện ích hình học
  function parseRanges(v) {
    if (Array.isArray(v)) return new Set(v.map(Number));
    const s = new Set();
    String(v || '').split(',').forEach(part => {
      const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
      if (!m) return;
      const a = +m[1], b = +(m[2] || m[1]);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) s.add(i);
    });
    return s;
  }
  function parseOverrides(v) {
    if (v && typeof v === 'object') return v;
    const o = {};
    String(v || '').split(',').forEach(part => {
      const m = part.trim().match(/^(\d+)\s*:\s*([\d.]+)$/);
      if (m) o[m[1]] = +m[2];
    });
    return o;
  }
  function polyArea(p) {
    let a = 0;
    for (let i = 0; i < p.length; i++) {
      const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length];
      a += x1 * y2 - x2 * y1;
    }
    return a / 2;
  }
  function polyCentroid(p) {
    let a = 0, cx = 0, cy = 0;
    for (let i = 0; i < p.length; i++) {
      const [x1, y1] = p[i], [x2, y2] = p[(i + 1) % p.length];
      const f = x1 * y2 - x2 * y1;
      a += f; cx += (x1 + x2) * f; cy += (y1 + y2) * f;
    }
    if (Math.abs(a) < 1e-6) {
      const s = p.reduce((r, q) => [r[0] + q[0], r[1] + q[1]], [0, 0]);
      return [s[0] / p.length, s[1] / p.length];
    }
    return [cx / (3 * a), cy / (3 * a)];
  }
  function bbox(p) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of p) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return [x0, y0, x1, y1];
  }
  // Cắt đa giác bằng hình chữ nhật (Sutherland–Hodgman)
  function clipRect(poly, x0, y0, x1, y1) {
    const ix = (a, b, x) => [x, a[1] + (x - a[0]) / (b[0] - a[0]) * (b[1] - a[1])];
    const iy = (a, b, y) => [a[0] + (y - a[1]) / (b[1] - a[1]) * (b[0] - a[0]), y];
    const edges = [
      [p => p[0] >= x0, (a, b) => ix(a, b, x0)],
      [p => p[0] <= x1, (a, b) => ix(a, b, x1)],
      [p => p[1] >= y0, (a, b) => iy(a, b, y0)],
      [p => p[1] <= y1, (a, b) => iy(a, b, y1)],
    ];
    let out = poly;
    for (const [inside, inter] of edges) {
      const input = out; out = [];
      for (let i = 0; i < input.length; i++) {
        const cur = input[i], prev = input[(i + input.length - 1) % input.length];
        if (inside(cur)) { if (!inside(prev)) out.push(inter(prev, cur)); out.push(cur); }
        else if (inside(prev)) out.push(inter(prev, cur));
      }
      if (!out.length) break;
    }
    return out;
  }
  // Chia mặt bằng tầng thành n căn: 1–2 dãy dọc theo cạnh dài, hành lang ở giữa
  function unitCells(poly, n) {
    if (n <= 0) return [];
    const [x0, y0, x1, y1] = bbox(poly);
    const horiz = x1 - x0 >= y1 - y0;
    const L = horiz ? x1 - x0 : y1 - y0, S = horiz ? y1 - y0 : x1 - x0;
    const rows = S > 14 && n >= 2 ? 2 : 1;
    const cols = Math.ceil(n / rows);
    const corridor = rows === 2 ? 2 : 0;
    const rowS = (S - corridor) / rows, colL = L / cols;
    const cells = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cc = r === 1 ? cols - 1 - c : c;   // đánh số vòng quanh hành lang
        const a0 = (horiz ? x0 : y0) + cc * colL, a1 = a0 + colL;
        const b0 = (horiz ? y0 : x0) + r * (rowS + corridor), b1 = b0 + rowS;
        const clipped = horiz ? clipRect(poly, a0, b0, a1, b1) : clipRect(poly, b0, a0, b1, a1);
        if (clipped.length >= 3 && Math.abs(polyArea(clipped)) > .3 * colL * rowS) cells.push(clipped);
      }
    }
    return cells.slice(0, n);
  }
  // Phần "mặt tiền" của một căn: các đoạn cạnh căn nằm trùng (gần trùng) với viền ngoài của lát cắt.
  // Trả về [{a:[x,y], b:[x,y], n:[nx,ny]}] — n là pháp tuyến hướng ra ngoài.
  function facadeSegments(outline, unitPoly, tol = .6) {
    const segs = [];
    const area = polyArea(outline);
    for (let i = 0; i < outline.length; i++) {
      const A = outline[i], B = outline[(i + 1) % outline.length];
      const dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy);
      if (L < .01) continue;
      const ux = dx / L, uy = dy / L;
      // pháp tuyến ra ngoài: phụ thuộc chiều vẽ đa giác (y hướng xuống)
      const n = area > 0 ? [uy, -ux] : [-uy, ux];
      const ranges = [];
      for (let j = 0; j < unitPoly.length; j++) {
        const p = unitPoly[j], q = unitPoly[(j + 1) % unitPoly.length];
        const dp = (p[0] - A[0]) * -uy + (p[1] - A[1]) * ux;   // khoảng cách tới đường thẳng AB
        const dq = (q[0] - A[0]) * -uy + (q[1] - A[1]) * ux;
        if (Math.abs(dp) > tol || Math.abs(dq) > tol) continue;
        let t0 = (p[0] - A[0]) * ux + (p[1] - A[1]) * uy;
        let t1 = (q[0] - A[0]) * ux + (q[1] - A[1]) * uy;
        if (t0 > t1) [t0, t1] = [t1, t0];
        t0 = Math.max(0, t0); t1 = Math.min(L, t1);
        if (t1 - t0 > .3) ranges.push([t0, t1]);
      }
      ranges.sort((r, s) => r[0] - s[0]);
      const merged = [];
      for (const r of ranges) {
        const last = merged[merged.length - 1];
        if (last && r[0] <= last[1] + .05) last[1] = Math.max(last[1], r[1]); else merged.push(r.slice());
      }
      for (const [t0, t1] of merged) segs.push({ a: [A[0] + ux * t0, A[1] + uy * t0], b: [A[0] + ux * t1, A[1] + uy * t1], n });
    }
    return segs;
  }
  // Hướng căn hộ từ pháp tuyến mặt tiền dài nhất. Mặt bằng: y hướng xuống; northDeg = góc lệch của hướng Bắc so với phía trên ảnh (theo chiều kim đồng hồ).
  const DIRS = ['Bắc', 'Đông Bắc', 'Đông', 'Đông Nam', 'Nam', 'Tây Nam', 'Tây', 'Tây Bắc'];
  function facadeDirection(facade, northDeg = 0) {
    if (!facade || !facade.length) return '';
    const s = facade.reduce((a, b) => (Math.hypot(b.b[0] - b.a[0], b.b[1] - b.a[1]) > Math.hypot(a.b[0] - a.a[0], a.b[1] - a.a[1]) ? b : a));
    const bearing = (Math.atan2(s.n[0], -s.n[1]) * 180 / Math.PI - northDeg + 720) % 360;
    return DIRS[Math.round(bearing / 45) % 8];
  }
  function fmtPrice(v) {
    if (!(v > 0)) return '';
    if (v >= 1e9) return (v / 1e9).toLocaleString('vi-VN', { maximumFractionDigits: 2 }) + ' tỷ';
    return Math.round(v / 1e6).toLocaleString('vi-VN') + ' triệu';
  }
  const escHtml = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function shrink(poly, k) {
    const [cx, cy] = polyCentroid(poly);
    return poly.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k]);
  }
  function hash01(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0) % 10007) / 10007;
  }

  // ---------------------------------------------------------------- chuẩn hóa dữ liệu
  function normalize(raw) {
    const d = JSON.parse(JSON.stringify(raw || {}));
    d.ground = Object.assign({ widthMeters: 300 }, d.ground);
    if (!d.ground.heightMeters) d.ground.heightMeters = d.ground.widthMeters * .7;
    d.towers = (d.towers || []).map((t, i) => {
      const floors = Math.max(1, Math.round(+t.floors || 1));
      const fh = +t.floorHeight || 3.2;
      const ov = parseOverrides(t.floorHeightOverrides);
      const elev = [0];
      for (let f = 1; f <= floors; f++) elev[f] = elev[f - 1] + (+ov[f] || fh);
      const plans = (t.plans || [])
        .filter(p => Array.isArray(p.polygon) && p.polygon.length >= 3)
        .map(p => ({
          floorFrom: Math.max(1, Math.round(+p.floorFrom || 1)),
          floorTo: Math.min(floors, Math.round(+p.floorTo || floors)),
          // chỉ áp cho các tầng này (tầng rời nhau, vd [28, 30, 32]); không có = cả khoảng floorFrom–floorTo
          only: Array.isArray(p.only) ? new Set(p.only.map(Number)) : null,   // [] = mẫu chưa ghép vào tầng nào
          polygon: p.polygon.map(([x, y]) => [+x, +y]),
          // căn hộ vẽ tay trên lát cắt (tùy chọn): [{ no: "01", polygon: [[x,y],...] }]
          units: (p.units || []).filter(u => Array.isArray(u.polygon) && u.polygon.length >= 3)
            // giữ các thông tin thêm của căn: type, bedrooms, bathrooms, area, direction, view, price...
            .map((u, k) => Object.assign({}, u, { no: String(u.no ?? pad(k + 1)), polygon: u.polygon.map(([x, y]) => [+x, +y]) })),
          // ảnh layout tầng (admin "📐 Từ layout"): { image, cx, cy, w, h, rot, walls: [x0,y0,x1,y1,...] }
          layout: p.layout && p.layout.image && +p.layout.w > 0 && +p.layout.h > 0 ? Object.assign({}, p.layout) : null,
        }));
      return Object.assign({}, t, {
        code: t.code || `T${i + 1}`,
        color: t.color || '#2563eb',
        roofColor: t.roofColor || '#8fd3c1',
        floors, floorHeight: fh, elev, plans,
        unitsPerFloor: Math.max(0, Math.round(t.unitsPerFloor ?? 8)),
        nonSale: parseRanges(t.nonSaleFloors),
      });
    });
    return d;
  }

  // ---------------------------------------------------------------- CSS của overlay
  const CSS = `
  .p3d{position:relative;overflow:hidden;background:#dfe8f1;font-family:system-ui,"Segoe UI",sans-serif;color:#1e293b}
  .p3d canvas{display:block}
  .p3d-panel{position:absolute;background:rgba(255,255,255,.95);border-radius:12px;box-shadow:0 4px 18px rgba(15,23,42,.15);padding:12px 14px;font-size:13px}
  .p3d-info{top:12px;left:12px;max-width:310px}
  .p3d-info h1{font-size:15px;margin:0 0 4px}
  .p3d-info p{margin:0;color:#64748b;line-height:1.45}
  .p3d-back{margin-top:10px;display:none;border:0;background:#2563eb;color:#fff;border-radius:8px;padding:7px 12px;cursor:pointer;font-size:13px}
  .p3d-legend{bottom:12px;left:12px;display:flex;gap:12px;flex-wrap:wrap;align-items:center;max-width:calc(100% - 24px)}
  .p3d-legend span{display:inline-flex;align-items:center;gap:6px}
  .p3d-legend i{width:12px;height:12px;border-radius:3px;display:inline-block}
  .p3d-legend em{font-style:normal;color:#94a3b8;font-size:11px}
  .p3d-floors{top:12px;right:12px;display:none;max-height:calc(100% - 24px);overflow-y:auto;width:126px}
  .p3d-floors b{display:block;margin-bottom:6px}
  .p3d-floors button{display:flex;justify-content:space-between;width:100%;border:0;background:#f1f5f9;margin:3px 0;padding:5px 8px;border-radius:6px;cursor:pointer;font-size:12px;color:#1e293b}
  .p3d-floors button.on{background:#2563eb;color:#fff}
  .p3d-floors button em{font-style:normal;color:#16a34a;font-weight:600}
  .p3d-floors button.on em{color:#bbf7d0}
  .p3d-floors button.ns em{color:#94a3b8;font-weight:400}
  .p3d-floors label{display:flex;gap:6px;align-items:flex-start;font-size:11px;color:#475569;margin:2px 0 8px;cursor:pointer;line-height:1.3}
  .p3d-floors label input{margin:1px 0 0}
  .p3d-card{right:12px;bottom:12px;display:none;min-width:200px}
  .p3d-card b{font-size:14px}
  .p3d-card .x{position:absolute;top:6px;right:8px;border:0;background:none;cursor:pointer;font-size:16px;color:#64748b}
  .p3d-tip{position:absolute;pointer-events:none;display:none;background:#0f172a;color:#fff;padding:9px 12px;border-radius:10px;font-size:12px;line-height:1.5;white-space:nowrap;z-index:5;box-shadow:0 8px 24px rgba(0,0,0,.3)}
  .p3d-u h3{margin:0 0 2px;font-size:14px;display:flex;align-items:center;gap:8px;justify-content:space-between}
  .p3d-u .st{font-size:11px;font-weight:600;padding:1px 8px;border-radius:999px;color:#fff}
  .p3d-u .sub{color:#94a3b8;font-size:11px;margin-bottom:6px}
  .p3d-u table{border-collapse:collapse;width:100%}
  .p3d-u td{padding:1px 0;vertical-align:top}
  .p3d-u td:first-child{color:#94a3b8;padding-right:14px}
  .p3d-u td:last-child{font-weight:600;text-align:right}
  .p3d-u .price td:last-child{color:#fbbf24;font-size:14px}
  .p3d-card .p3d-u .sub,.p3d-card .p3d-u td:first-child{color:#64748b}
  .p3d-card .p3d-u .price td:last-child{color:#dc2626}
  .p3d-u small{display:block;color:#64748b;font-size:10px;margin-top:4px;white-space:normal;max-width:230px}
  .p3d-tag{background:#fff;border:2px solid;border-radius:999px;padding:3px 11px;font-weight:700;font-size:13px;color:#0f172a;box-shadow:0 2px 8px rgba(0,0,0,.2);cursor:pointer;pointer-events:auto;text-align:center;white-space:nowrap}
  .p3d-tag small{display:block;font-weight:500;font-size:11px;color:#16a34a}
  .p3d-tag.dim{opacity:.55}
  .p3d-mark{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:#fff;pointer-events:none;transform:translateX(50%)}
  .p3d-mark i{width:7px;height:7px;border-radius:50%;background:#334155;box-shadow:0 0 0 2px #fff}
  .p3d-mark span{background:rgba(15,23,42,.82);padding:2px 8px;border-radius:6px}
  .p3d-unit{font-size:10px;font-weight:700;color:#0f172a;background:rgba(255,255,255,.85);padding:1px 4px;border-radius:4px;pointer-events:none}
  .p3d.p3d-compact .p3d-info p,.p3d.p3d-compact .p3d-floors,.p3d.p3d-compact .p3d-legend{display:none!important}
  .p3d.p3d-compact .p3d-info{padding:6px 10px}
  .p3d.p3d-compact .p3d-info h1{font-size:12px;margin:0}
  .p3d.p3d-compact .p3d-back{margin-top:6px;padding:4px 8px;font-size:12px}
  @media (max-width:600px){.p3d-info{right:12px;max-width:none}.p3d-floors{top:auto;bottom:64px;max-height:40%}}
  `;
  function injectCSS() {
    if (document.getElementById('p3d-css')) return;
    const s = document.createElement('style');
    s.id = 'p3d-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // ---------------------------------------------------------------- texture mặt tiền (vẽ bằng canvas)
  // Đá ốp mặt ngoài: màu nền + màu ron
  const STONES = {
    mint: { base: '#a6dcc9', dark: '#7fbea8' }, orange: { base: '#f0a43c', dark: '#cf8526' },
    red: { base: '#c95a43', dark: '#a6432f' }, sand: { base: '#e8d3a9', dark: '#c9b386' }, grey: { base: '#c9ced4', dark: '#a7aeb6' },
  };
  function seeded(n) { let x = n || 1; return () => (x = (x * 16807) % 2147483647) / 2147483647; }
  function shade(hex, k) {   // k > 0 sáng hơn, < 0 tối hơn
    const v = parseInt(hex.slice(1), 16), f = c => Math.max(0, Math.min(255, Math.round(k > 0 ? c + (255 - c) * k : c * (1 + k))));
    return `rgb(${f(v >> 16)},${f((v >> 8) & 255)},${f(v & 255)})`;
  }
  // mặt đá có vân trong khung (x, y, w, h)
  function paintStone(g, x, y, w, h, st, rnd) {
    g.fillStyle = st.base; g.fillRect(x, y, w, h);
    for (let i = 0; i < w * h / 60; i++) {   // hạt lấm tấm
      g.fillStyle = shade(st.base, (rnd() - .5) * .22); g.globalAlpha = .55;
      g.fillRect(x + rnd() * w, y + rnd() * h, 1 + rnd() * 3, 1 + rnd() * 2);
    }
    g.globalAlpha = .18; g.strokeStyle = shade(st.base, -.35); g.lineWidth = 1;
    for (let i = 0; i < 3; i++) {   // vân đá
      g.beginPath(); let px = x + rnd() * w, py = y; g.moveTo(px, py);
      while (py < y + h) { px += (rnd() - .5) * 18; py += 8 + rnd() * 10; g.lineTo(px, py); }
      g.stroke();
    }
    g.globalAlpha = 1;
  }
  // ô cửa kính trên 1 ô mặt tiền 256×256 px (= 3.2 m ngang × 1 tầng)
  const WIN_RECT = { tower: [34, 38, 222, 206], podium: [10, 28, 246, 230] };
  function paintWindow(g, kind) {
    const [x0, y0, x1, y1] = WIN_RECT[kind], w = x1 - x0, h = y1 - y0, mid = (x0 + x1) / 2;
    g.fillStyle = 'rgba(0,0,0,.22)'; g.fillRect(x0 - 2, y0 - 2, w + 8, h + 8);            // bóng đổ quanh ô cửa
    g.fillStyle = '#eef1f4'; g.fillRect(x0 - 5, y0 - 5, w + 10, h + 10);                  // khung nhôm sáng
    const gr = g.createLinearGradient(0, y0, 0, y1);                                       // kính xanh xám đậm
    gr.addColorStop(0, '#a9c3d8'); gr.addColorStop(.4, '#7392ad'); gr.addColorStop(1, '#4d6680');
    g.fillStyle = gr; g.fillRect(x0, y0, w, h);
    const sh = g.createLinearGradient(0, y0, 0, y0 + 14);                                  // bóng khung trên → kính lõm vào
    sh.addColorStop(0, 'rgba(0,0,0,.45)'); sh.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = sh; g.fillRect(x0, y0, w, 14);
    const sl = g.createLinearGradient(x0, 0, x0 + 10, 0);
    sl.addColorStop(0, 'rgba(0,0,0,.35)'); sl.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = sl; g.fillRect(x0, y0, 10, h);
    g.fillStyle = 'rgba(255,255,255,.13)';                                                 // vệt phản chiếu chéo
    g.beginPath(); g.moveTo(x0 + w * .08, y1); g.lineTo(x0 + w * .38, y0); g.lineTo(x0 + w * .52, y0); g.lineTo(x0 + w * .22, y1); g.closePath(); g.fill();
    g.fillStyle = 'rgba(255,255,255,.07)';
    g.beginPath(); g.moveTo(x0 + w * .58, y1); g.lineTo(x0 + w * .82, y0); g.lineTo(x0 + w * .88, y0); g.lineTo(x0 + w * .64, y1); g.closePath(); g.fill();
    g.fillStyle = '#dfe4e9';                                                               // đố kính
    const cols = kind === 'podium' ? [x0 + w / 4, mid, x0 + w * 3 / 4] : [mid];
    cols.forEach(x => g.fillRect(x - 2, y0, 4, h));
    if (kind === 'tower') g.fillRect(x0, y0 + h * .68, w, 3);
    g.fillStyle = '#ffffff'; g.fillRect(x0 - 9, y1 + 5, w + 18, 7);                       // bậu cửa trắng
    g.fillStyle = 'rgba(0,0,0,.18)'; g.fillRect(x0 - 9, y1 + 12, w + 18, 4);
  }
  // bản đồ độ bóng / kim loại: kính bóng & phản chiếu, tường nhám (G = độ nhám, B = kim loại)
  function drawGlassMask(kind) {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const g = c.getContext('2d'), [x0, y0, x1, y1] = WIN_RECT[kind];
    g.fillStyle = 'rgb(0,255,0)'; g.fillRect(0, 0, 256, 256);
    g.fillStyle = 'rgb(0,150,60)'; g.fillRect(x0 - 5, y0 - 5, x1 - x0 + 10, y1 - y0 + 10);
    g.fillStyle = 'rgb(0,22,215)'; g.fillRect(x0, y0, x1 - x0, y1 - y0);
    return c;
  }
  function drawStoneFacade(kind, st) {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const g = c.getContext('2d'), rnd = seeded(kind === 'podium' ? 7 : 3);
    paintStone(g, 0, 0, 256, 256, st, rnd);
    g.fillStyle = st.dark;   // ron chia tấm đá 1.6 m × nửa tầng
    g.fillRect(0, 0, 256, 2); g.fillRect(0, 127, 256, 2); g.fillRect(0, 0, 2, 256); g.fillRect(127, 0, 2, 256);
    paintWindow(g, kind);
    return c;
  }
  function drawStoneRoof(st) {   // mái / sân thượng lát đá 4×4 tấm
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const g = c.getContext('2d'), rnd = seeded(11);
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
      const tone = { base: shade(st.base, (rnd() - .5) * .12), dark: st.dark };
      paintStone(g, i * 64, j * 64, 64, 64, tone, rnd);
    }
    g.fillStyle = st.dark;
    for (let k = 0; k <= 4; k++) { g.fillRect(k * 64 - 1, 0, 2, 256); g.fillRect(0, k * 64 - 1, 256, 2); }
    return c;
  }

  function drawFacade(kind) {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d'), rnd = seeded(kind === 'podium' ? 5 : 9);
    paintStone(g, 0, 0, 256, 256, kind === 'podium' ? { base: '#c9d0d7', dark: '#aab3bc' } : { base: '#e4e9ee', dark: '#c3cbd3' }, rnd);
    g.fillStyle = kind === 'podium' ? '#9aa6b2' : '#cfd6dd'; g.fillRect(0, 0, 256, 12);   // gờ sàn mỗi tầng
    g.fillStyle = 'rgba(0,0,0,.08)'; g.fillRect(0, 12, 256, 3);
    paintWindow(g, kind);
    return c;
  }

  // =====================================================================
  function create(THREE, addons, container, opts = {}) {
    const { OrbitControls, CSS2DRenderer, CSS2DObject } = addons;
    injectCSS();
    container.classList.add('p3d');
    if (opts.compact) container.classList.add('p3d-compact');

    // ---- renderer, scene, camera
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    const labelRenderer = new CSS2DRenderer();
    Object.assign(labelRenderer.domElement.style, { position: 'absolute', top: 0, left: 0, pointerEvents: 'none' });
    container.appendChild(labelRenderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#dfe8f1');
    scene.fog = new THREE.Fog('#dfe8f1', 400, 1200);
    const camera = new THREE.PerspectiveCamera(45, 1, 1, 4000);
    camera.position.set(200, 160, 260);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI / 2.08;
    controls.minDistance = 15;
    controls.maxDistance = 1200;

    scene.add(new THREE.HemisphereLight('#ffffff', '#aebba8', 1.15));
    // bầu trời giả để kính có cái phản chiếu (chỉ gắn cho vật liệu mặt tiền)
    const glassEnv = (() => {
      const env = new THREE.Scene(), geo = new THREE.SphereGeometry(100, 32, 16), pos = geo.attributes.position, col = [];
      const top = new THREE.Color('#6fa6dc'), hor = new THREE.Color('#f2f6fb'), gnd = new THREE.Color('#7d8a80');
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i) / 100, c = y > 0 ? hor.clone().lerp(top, Math.pow(y, .55)) : hor.clone().lerp(gnd, Math.min(1, -y * 4));
        col.push(c.r, c.g, c.b);
      }
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      env.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
      const sunBall = new THREE.Mesh(new THREE.SphereGeometry(6, 16, 8), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
      sunBall.position.set(50, 60, 40); env.add(sunBall);
      const pm = new THREE.PMREMGenerator(renderer), tex = pm.fromScene(env, .02).texture;
      pm.dispose(); geo.dispose();
      return tex;
    })();
    const sun = new THREE.DirectionalLight('#ffffff', 1.7);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0005;
    scene.add(sun, sun.target);

    const world = new THREE.Group();
    scene.add(world);

    const texCache = new Map();
    const facadeCanvas = { tower: drawFacade('tower'), podium: drawFacade('podium') };
    const canvasFor = (kind, style) => {
      const k = kind + ':' + style;
      if (!facadeCanvas[k]) facadeCanvas[k] = STONES[style] ? drawStoneFacade(kind, STONES[style]) : facadeCanvas[kind];
      return facadeCanvas[k];
    };
    function roofTex(style, color) {
      const key = 'roof:' + (style || color);
      if (!texCache.has(key)) {
        const st = STONES[style] || { base: color, dark: shade(color, -.2) };
        const t = new THREE.CanvasTexture(drawStoneRoof(st));
        t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = renderer.capabilities.getMaxAnisotropy();
        t.repeat.set(1 / 4.8, 1 / 4.8);   // 1 tấm đá ≈ 1.2 m
        texCache.set(key, t);
      }
      return texCache.get(key);
    }
    function glassMaskTex(kind, h) {
      const key = 'mask:' + kind + h.toFixed(2);
      if (!texCache.has(key)) {
        const t = new THREE.CanvasTexture(drawGlassMask(kind));
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(1 / (kind === 'podium' ? 6 : 3.2), 1 / h);
        texCache.set(key, t);
      }
      return texCache.get(key);
    }
    function facadeTex(kind, h, style = '') {
      const key = kind + h.toFixed(2) + style;
      if (!texCache.has(key)) {
        const t = new THREE.CanvasTexture(canvasFor(kind, style));
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = renderer.capabilities.getMaxAnisotropy();
        t.repeat.set(1 / (kind === 'podium' ? 6 : 3.2), 1 / h);   // 1 ô cửa ≈ 3.2m ngang, 1 tầng dọc
        texCache.set(key, t);
      }
      return texCache.get(key);
    }

    // ---- UI overlay
    const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; container.appendChild(e); return e; };
    const ui = {};
    ui.info = el('div', 'p3d-panel p3d-info', '<h1></h1><p></p><button class="p3d-back">← Quay lại</button>');
    ui.title = ui.info.querySelector('h1');
    ui.hint = ui.info.querySelector('p');
    ui.back = ui.info.querySelector('.p3d-back');
    ui.floors = el('div', 'p3d-panel p3d-floors', '<b>Chọn tầng</b><label><input type="checkbox">Tô màu mọi trạng thái (mặc định chỉ hiện căn còn hàng)</label><div></div>');
    ui.floorList = ui.floors.querySelector('div');
    ui.facadeToggle = ui.floors.querySelector('input');
    ui.facadeToggle.checked = !!opts.facadeStatus;
    ui.facadeToggle.onchange = () => { if (selected) paintFacade(selected); };
    ui.legend = el('div', 'p3d-panel p3d-legend');
    ui.card = el('div', 'p3d-panel p3d-card');
    ui.tip = el('div', 'p3d-tip');
    ui.back.onclick = () => back();
    ui.floorList.onclick = e => { const b = e.target.closest('button'); if (b) selectFloor(+b.dataset.f); };
    ui.card.onclick = e => {
      if (e.target.dataset.floor) { selectFloor(+e.target.dataset.floor); return; }
      if (!e.target.classList.contains('x')) return;
      ui.card.style.display = 'none';
      if (selected?.facadeSel) { const m = selected.facadeSel; selected.facadeSel = null; paintFacadeMesh(m); }
    };

    // ---- state
    let data = null, towers = [], pickables = [], selected = null, selectedFloor = null, groundTex = null, overviewView = null;

    function extrude(poly, height, baseY) {
      const shape = new THREE.Shape(poly.map(([x, y]) => new THREE.Vector2(x, y)));
      const geo = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
      geo.rotateX(Math.PI / 2);              // (x, y) của mặt bằng → (x, z) trong 3D
      geo.translate(0, baseY + height, 0);
      return geo;
    }

    function statusOf(code) {
      if (data.status) return data.status[code] || 'available';
      const r = hash01(code);
      return r < .45 ? 'available' : r < .55 ? 'locking' : r < .7 ? 'deposited' : 'sold';
    }
    const availableCount = fl => fl.units.filter(u => u.status === 'available').length;

    function disposeTree(root) {
      root.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
        if (o.element) o.element.remove();
      });
    }
    function clearWorld() {
      unitHL = null; unitHLKey = null;   // world.clear() bên dưới đã gỡ
      layoutTex.forEach(e => e.tex && e.tex.dispose()); layoutTex.clear();
      disposeTree(world);
      world.clear();
      if (groundTex) { groundTex.dispose(); groundTex = null; }
      towers = []; pickables = []; selected = null; selectedFloor = null;
    }

    // ---- mặt cắt tầng theo ảnh layout: sàn dán ảnh + tường 3D dựng từ nét tường
    const layoutTex = new Map();
    function getLayoutTex(src, cb) {
      let e = layoutTex.get(src);
      if (!e) {
        e = { tex: null, cbs: [] };
        layoutTex.set(src, e);
        new THREE.TextureLoader().load(src, tex => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
          e.tex = tex; e.cbs.forEach(f => f(tex)); e.cbs = [];
        });
      }
      if (e.tex) cb(e.tex); else e.cbs.push(cb);
    }
    function buildLayoutFloor(group, p, fl, yTop) {
      const L = p.layout, a = (+L.rot || 0) * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
      const y0 = yTop ?? fl.base + .31;
      // sàn: hình viền lát cắt, toạ độ ảnh tính ngược từ khung layout
      const geo = new THREE.ShapeGeometry(new THREE.Shape(p.polygon.map(([x, y]) => new THREE.Vector2(x, y))));
      const pos = geo.attributes.position, uv = geo.attributes.uv;
      for (let i = 0; i < pos.count; i++) {
        const dx = pos.getX(i) - L.cx, dy = pos.getY(i) - L.cy;
        uv.setXY(i, (dx * ca + dy * sa) / L.w + .5, .5 - (-dx * sa + dy * ca) / L.h);
      }
      geo.rotateX(Math.PI / 2);
      geo.translate(0, y0, 0);
      // giữ đúng màu ảnh layout: không chịu ánh sáng / bóng / tone mapping
      const mat = new THREE.MeshBasicMaterial({ color: '#ffffff', side: THREE.DoubleSide, toneMapped: false });
      getLayoutTex(L.image, tex => { mat.map = tex; mat.needsUpdate = true; });
      group.add(new THREE.Mesh(geo, mat));
    }

    // ---- mặt đất
    function buildGround() {
      const W = data.ground.widthMeters, H = data.ground.heightMeters;
      const R = Math.max(W, H) * 2.5 + 400;
      const outer = new THREE.Mesh(new THREE.CircleGeometry(R, 64).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#cdd5c8', roughness: 1 }));
      outer.position.set(W / 2, -0.05, H / 2);
      outer.receiveShadow = true;
      world.add(outer);

      const siteMat = new THREE.MeshStandardMaterial({ color: '#e8eef2', roughness: 1 });
      const site = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), siteMat);
      site.scale.set(W, 1, H);
      site.position.set(W / 2, 0, H / 2);
      site.receiveShadow = true;
      world.add(site);

      if (data.ground.image) {
        new THREE.TextureLoader().load(data.ground.image, tex => {
          if (!site.parent) { tex.dispose(); return; }
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
          groundTex = tex;
          siteMat.map = tex; siteMat.color.set('#ffffff'); siteMat.needsUpdate = true;
        });
      } else {
        // không có ảnh → rải cây xanh cho có không khí
        const boxes = data.towers.flatMap(t => t.plans.map(p => bbox(p.polygon)));
        const treeGeo = new THREE.SphereGeometry(2.4, 10, 8), trunkGeo = new THREE.CylinderGeometry(.3, .4, 3);
        const treeMat = new THREE.MeshStandardMaterial({ color: '#4f9a5e' }), trunkMat = new THREE.MeshStandardMaterial({ color: '#5c4028' });
        let s = 11;
        const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
        const count = Math.min(220, Math.round(W * H / 220));
        for (let i = 0, tries = 0; i < count && tries < count * 6; tries++) {
          const x = -30 + rnd() * (W + 60), y = -30 + rnd() * (H + 60);
          if (boxes.some(([a, b, c, d]) => x > a - 6 && x < c + 6 && y > b - 6 && y < d + 6)) continue;
          const g = new THREE.Group();
          const top = new THREE.Mesh(treeGeo, treeMat); top.position.y = 4; top.castShadow = true;
          const trunk = new THREE.Mesh(trunkGeo, trunkMat); trunk.position.y = 1.5;
          g.add(top, trunk);
          g.position.set(x, 0, y);
          g.scale.setScalar(.7 + rnd() * .6);
          world.add(g);
          i++;
        }
      }
    }

    // ---- dựng 1 tòa
    function buildTower(t) {
      const T = { t, group: new THREE.Group(), floors: [], extras: [], mats: [], marks: null, unitGroup: null };
      world.add(T.group);
      const style = STONES[t.facade] ? t.facade : '';   // '' = kính xám (mặc định)
      // mái / sân thượng luôn lát đá: màu theo kiểu đá, hoặc theo "Màu mái" của tòa
      const roofHex = /^#[0-9a-f]{6}$/i.test(t.roofColor) ? t.roofColor : '#8fd3c1';
      const capMat = new THREE.MeshStandardMaterial({ map: roofTex(style, roofHex), color: '#ffffff', roughness: .7 });
      const parapetMat = new THREE.MeshStandardMaterial({ color: '#d7dde2', roughness: .75 });
      T.mats.push(capMat, parapetMat);
      const cellCache = new Map();

      for (let f = 1; f <= t.floors; f++) {
        const active = t.plans.map((p, i) => [p, i]).filter(([p]) => f >= p.floorFrom && f <= p.floorTo && (!p.only || p.only.has(f)));
        const h = t.elev[f] - t.elev[f - 1], base = t.elev[f - 1];
        const nonSale = t.nonSale.has(f);
        const kind = nonSale ? 'podium' : 'tower', mask = glassMaskTex(kind, h);
        const sideMat = new THREE.MeshStandardMaterial({ map: facadeTex(kind, h, style), roughnessMap: mask, metalnessMap: mask, roughness: 1, metalness: 1, envMap: glassEnv, envMapIntensity: 1.5 });
        T.mats.push(sideMat);
        const fg = new THREE.Group();
        T.group.add(fg);
        const fl = { f, group: fg, sideMat, units: [], h, base, nonSale, plans: active.map(([p]) => p) };
        for (const [p] of active) {
          const m = new THREE.Mesh(extrude(p.polygon, h, base), [capMat, sideMat]);
          m.castShadow = m.receiveShadow = true;
          m.userData = { kind: 'floor', T, fl };
          fg.add(m);
          pickables.push(m);
        }
        if (!nonSale && active.length) {
          const areas = active.map(([p]) => Math.abs(polyArea(p.polygon)));
          const total = areas.reduce((a, b) => a + b, 0) || 1;
          let num = 1;
          active.forEach(([p, i], k) => {
            let list;
            if (p.units.length) list = p.units;                       // căn vẽ tay theo lát cắt thật
            else if (t.unitsPerFloor > 0) {                          // không có → tự chia đều
              const n = Math.max(1, Math.round(t.unitsPerFloor * areas[k] / total));
              const key = i + ':' + n;
              if (!cellCache.has(key)) cellCache.set(key, unitCells(p.polygon, n).map(poly => ({ poly })));
              list = cellCache.get(key).map(c => ({ no: pad(num++), polygon: c.poly }));
            } else list = [];
            for (const u of list) {
              const code = `${t.code}-${pad(f)}${u.no}`;
              const fkey = i + '/' + u.no;
              if (!cellCache.has(fkey)) cellCache.set(fkey, facadeSegments(p.polygon, u.polygon));
              const facade = cellCache.get(fkey);
              // thông tin căn: từ lát cắt (áp mọi tầng) + ghi đè theo mã căn trong data.units (giá, trạng thái... từ hệ thống bán hàng)
              const extra = Object.assign({}, u, (data.units && data.units[code]) || {});
              const area = +extra.area || Math.round(Math.abs(polyArea(u.polygon)));
              const ppm = +extra.pricePerM2 || +t.pricePerM2 || +data.pricePerM2 || 0;
              fl.units.push({
                code, no: u.no, poly: u.polygon, floor: f, facade,
                area, areaExact: !!extra.area,
                status: extra.status || statusOf(code),
                type: extra.type || '', bedrooms: extra.bedrooms, bathrooms: extra.bathrooms, view: extra.view || '',
                direction: extra.direction || facadeDirection(facade, +data.ground.northDeg || 0),
                price: +extra.price || (ppm ? area * ppm : 0), priceEstimated: !extra.price,
              });
            }
          });
        }
        T.floors[f] = fl;
      }

      // gờ lan can quanh mép mái lộ ra: nóc tòa và tầng ngay dưới chỗ đổi hình (giật cấp)
      const PH = 1.1, PT = .28;   // cao, dày (m)
      T.floors.forEach(fl => {
        if (!fl || !fl.plans.length) return;
        const nx = T.floors[fl.f + 1];
        const same = nx && nx.plans.length === fl.plans.length && nx.plans.every(q => fl.plans.includes(q) || fl.plans.some(p => p.polygon === q.polygon));
        if (same) return;
        const P = [], y0 = fl.base + fl.h, y1 = y0 + PH;
        const quad = (A, B, C, D) => P.push(...A, ...B, ...C, ...A, ...C, ...D);
        for (const p of fl.plans) {
          const poly = p.polygon, sgn = polyArea(poly) > 0 ? 1 : -1;
          poly.forEach((a, i) => {
            const b = poly[(i + 1) % poly.length], dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
            if (L < .05) return;
            const nx2 = -dz / L * sgn * PT, nz2 = dx / L * sgn * PT;   // hướng vào trong
            const a2 = [a[0] + nx2, a[1] + nz2], b2 = [b[0] + nx2, b[1] + nz2];
            const v = (q, y) => [q[0], y, q[1]];
            quad(v(a, y0), v(b, y0), v(b, y1), v(a, y1));        // mặt ngoài
            quad(v(a2, y0), v(b2, y0), v(b2, y1), v(a2, y1));    // mặt trong
            quad(v(a, y1), v(b, y1), v(b2, y1), v(a2, y1));      // mặt trên
          });
        }
        if (!P.length) return;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
        geo.computeVertexNormals();
        const m = new THREE.Mesh(geo, parapetMat);
        parapetMat.side = THREE.DoubleSide;
        m.castShadow = m.receiveShadow = true;
        fl.group.add(m);
      });

      // nhãn tên tòa đặt trên lát cắt cao nhất
      const top = t.plans.reduce((a, p) => (!a || p.floorTo > a.floorTo ? p : a), null);
      if (top) {
        const topY = t.elev[top.floorTo];
        const [cx, cy] = polyCentroid(top.polygon);
        // nhãn tên tòa
        const tag = document.createElement('div');
        tag.className = 'p3d-tag';
        tag.style.borderColor = t.color;
        const avail = T.floors.reduce((n, fl) => n + (fl ? availableCount(fl) : 0), 0);
        tag.innerHTML = `${t.code}<small>${avail ? avail + ' căn trống' : 'Hết hàng'}</small>`;
        tag.addEventListener('pointerdown', e => e.stopPropagation());
        tag.addEventListener('click', () => select(T));
        T.label = new CSS2DObject(tag);
        T.label.position.set(cx, topY + 10, cy);
        T.group.add(T.label);
      }
      buildAvailOverlay(T);
      T.box = new THREE.Box3().setFromObject(T.group);
      towers.push(T);
    }

    // ---- tải dữ liệu
    function load(raw, { keepCamera = false } = {}) {
      clearWorld();
      data = normalize(raw);
      buildGround();
      data.towers.forEach(buildTower);

      const W = data.ground.widthMeters, H = data.ground.heightMeters;
      const box = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(W, 1, H));
      towers.forEach(T => box.union(T.box));
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const span = Math.max(size.x, size.z, size.y * 1.5);
      center.y = Math.min(size.y * .3, 25);
      overviewView = { target: center.clone(), dist: span * 1.15 + 40 };

      sun.position.set(center.x + span * .5, span * 1.2 + 80, center.z + span * .35);
      sun.target.position.copy(center);
      Object.assign(sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 1, far: span * 4 + 300 });
      sun.shadow.camera.updateProjectionMatrix();
      scene.fog.near = span * 2; scene.fog.far = span * 6 + 400;
      controls.maxDistance = span * 4 + 200;

      ui.legend.innerHTML = `<span><i style="background:#ff2600"></i><b>Mặt tiền đỏ = căn còn hàng</b></span>` + Object.values(STATUS).map(s => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join('') +
        (data.status ? '' : '<em>(trạng thái đang là dữ liệu giả lập)</em>');
      showOverviewUI();
      if (!keepCamera) {
        controls.target.copy(overviewView.target);
        camera.position.copy(overviewView.target).add(new THREE.Vector3(.55, .55, .65).normalize().multiplyScalar(overviewView.dist));
      }
    }

    function showOverviewUI() {
      ui.title.textContent = data.project || 'Dự án';
      ui.hint.textContent = data.towers.length
        ? 'Bấm vào một tòa để xem tầng. Kéo chuột để xoay, cuộn để zoom, chuột phải để di chuyển.'
        : 'Chưa có tòa nào. Hãy vẽ tòa trong trang admin.';
      ui.back.style.display = 'none';
      ui.floors.style.display = 'none';
      ui.card.style.display = 'none';
    }

    // ---- chọn tòa / tầng
    function setDim(T, on) {
      T.mats.forEach(m => { m.transparent = on; m.opacity = on ? .25 : 1; m.depthWrite = !on; m.needsUpdate = true; });
      if (T.label) T.label.element.classList.toggle('dim', on);
    }
    function colorFloors(T) {
      const max = Math.max(1, ...T.floors.filter(Boolean).map(fl => fl.units.length));
      const lo = new THREE.Color('#e3f9e9'), hi = new THREE.Color('#16a34a');
      T.floors.forEach(fl => {
        if (!fl) return;
        if (fl.nonSale || !fl.units.length) fl.sideMat.color.set('#e2e8f0');
        else {
          const n = availableCount(fl);
          if (n === 0) fl.sideMat.color.set('#94a3b8');
          else fl.sideMat.color.copy(lo).lerp(hi, n / max);
        }
      });
    }
    function resetColors(T) { T.floors.forEach(fl => fl && fl.sideMat.color.set('#ffffff')); }

    function showFloorMarks(T) {
      removeFloorMarks(T);
      const g = new THREE.Group();
      const b = T.box;
      for (let f = 1; f <= T.t.floors; f++) {
        if (f % 5 !== 0 && f !== T.t.floors) continue;
        const fl = T.floors[f];
        if (!fl || !fl.plans.length) continue;
        const e = document.createElement('div');
        e.className = 'p3d-mark';
        e.innerHTML = `<i></i><span>Tầng ${pad(f)}</span>`;
        const o = new CSS2DObject(e);
        o.position.set(b.max.x + 1, fl.base + fl.h / 2, (b.min.z + b.max.z) / 2);
        g.add(o);
      }
      T.group.add(g);
      T.marks = g;
    }
    function removeFloorMarks(T) {
      if (!T.marks) return;
      T.marks.traverse(o => o.element && o.element.remove());
      T.group.remove(T.marks);
      T.marks = null;
    }

    // ---- mặt tiền từng căn: tấm mỏng phủ đúng phần tường ngoài của căn, dùng để rê chuột / bấm
    const FACADE_AVAIL = '#ff2600';   // căn còn hàng: đỏ
    const FACADE_HOVER = '#ffb020';   // đang rê chuột / đang chọn
    // các tam giác của tấm mặt tiền của một căn trên một tầng
    function facadeQuads(u, fl, pos = []) {
      const off = .12, insH = .1, insV = .12;
      const y0 = fl.base + insV, y1 = fl.base + fl.h - insV;
      for (const { a, b, n } of u.facade) {
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (L < insH * 3) continue;
        const ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
        const x0 = a[0] + ux * insH + n[0] * off, z0 = a[1] + uy * insH + n[1] * off;
        const x1 = b[0] - ux * insH + n[0] * off, z1 = b[1] - uy * insH + n[1] * off;
        pos.push(x0, y0, z0, x1, y0, z1, x1, y1, z1, x0, y0, z0, x1, y1, z1, x0, y1, z0);
      }
      return pos;
    }
    // Lớp đỏ gộp 1 mesh cho màn tổng quan: tất cả căn còn hàng của tòa (không bấm được, nhẹ)
    function buildAvailOverlay(T) {
      const pos = [];
      T.floors.forEach(fl => fl && fl.units.forEach(u => { if (u.status === 'available') facadeQuads(u, fl, pos); }));
      if (!pos.length) return;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: FACADE_AVAIL, transparent: true, opacity: .85, side: THREE.DoubleSide, depthWrite: false }));
      m.renderOrder = 2;
      T.group.add(m);
      T.availOverlay = m;
    }
    function buildFacade(T) {
      removeFacade(T);
      const g = new THREE.Group();
      T.floors.forEach(fl => {
        if (!fl) return;
        for (const u of fl.units) {
          if (!u.facade.length) continue;
          const pos = facadeQuads(u, fl);
          if (!pos.length) continue;
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
          const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: FACADE_AVAIL, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
          m.renderOrder = 2;
          m.userData = { kind: 'facade', unit: u, T, fl };
          g.add(m);
          pickables.push(m);
        }
      });
      T.group.add(g);
      T.facade = g;
      T.facadeSel = null;
      paintFacade(T);
    }
    function paintFacadeMesh(m) {
      const { unit, T } = m.userData;
      const mat = m.material;
      const avail = unit.status === 'available';
      if (m === hovered || m === T.facadeSel) {
        // căn còn hàng sáng vàng cam; căn hết hàng chỉ hiện mờ để biết đang trỏ vào căn nào
        mat.color.set(avail ? FACADE_HOVER : '#e2e8f0'); mat.opacity = avail ? .95 : .55;
      }
      else if (ui.facadeToggle.checked) { mat.color.set(STATUS[unit.status]?.color || '#cbd5e1'); mat.opacity = .62; }
      else if (avail) { mat.color.set(FACADE_AVAIL); mat.opacity = .85; }
      else mat.opacity = 0;
    }
    function paintFacade(T) { if (T.facade) T.facade.children.forEach(paintFacadeMesh); }
    function removeFacade(T) {
      if (!T.facade) return;
      pickables = pickables.filter(m => m.parent !== T.facade);
      disposeTree(T.facade);
      T.group.remove(T.facade);
      T.facade = null;
      T.facadeSel = null;
    }

    function select(T, { fly = true } = {}) {
      if (typeof T === 'string') T = towers.find(x => x.t.code === T);
      if (!T) return;
      clearFloor();
      if (selected && selected !== T) { removeFloorMarks(selected); removeFacade(selected); }
      selected = T;
      towers.forEach(o => { setDim(o, o !== T); resetColors(o); if (o.availOverlay) o.availOverlay.visible = false; });
      if (!T.facade) buildFacade(T);
      showFloorMarks(T);
      const t = T.t;
      ui.title.textContent = `Tòa ${t.code} — ${t.floors} tầng`;
      ui.hint.textContent = 'Mảng đỏ trên mặt ngoài = căn còn hàng. Rê chuột lên tầng để xem số căn trống, bấm vào tầng để xem mặt bằng — trong mặt bằng rê lên từng căn để xem thông tin.';
      ui.back.style.display = 'inline-block';
      ui.floorList.innerHTML = T.floors.filter(fl => fl && fl.plans.length).reverse().map(fl =>
        `<button data-f="${fl.f}" class="${fl.nonSale ? 'ns' : ''}">Tầng ${pad(fl.f)}<em>${fl.nonSale ? 'TM' : availableCount(fl)}</em></button>`).join('');
      ui.floors.style.display = 'block';
      ui.card.style.display = 'none';
      if (fly) {
        const c = T.box.getCenter(new THREE.Vector3()), s = T.box.getSize(new THREE.Vector3());
        c.y = s.y * .45;
        flyTo(c, Math.max(s.x, s.z, s.y) * 1.5 + 30);
      }
    }

    function selectFloor(f) {
      if (!selected) return;
      const T = selected, t = T.t, fl = T.floors[f];
      if (!fl) return;
      clearFloor();
      selectedFloor = f;
      // có layout → giữ khối của tầng đang xem, đặt layout lên mặt trên khối đó; không có → cắt bỏ tầng đó như cũ
      const flat = fl.plans.some(p => p.layout);
      T.floors.forEach(o => { if (o) o.group.visible = o.f < f || (flat && o.f === f); });
      T.extras.forEach(o => o.visible = false);
      if (T.label) T.label.visible = false;
      if (T.marks) T.marks.visible = false;
      if (T.facade) T.facade.visible = false;

      const ug = new THREE.Group();
      const slabMat = new THREE.MeshStandardMaterial({ color: '#94a3b8' });
      const top = fl.base + fl.h;   // mặt trên khối tầng đang xem
      fl.plans.forEach(p => {
        if (p.layout) buildLayoutFloor(ug, p, fl, top + .03);
        else { const s = new THREE.Mesh(extrude(p.polygon, .3, fl.base), slabMat); s.receiveShadow = true; ug.add(s); }
      });
      // có layout → căn là lớp vô hình phủ trên bản vẽ (chỉ hiện màu nhẹ khi rê chuột); không có → khối đặc như cũ
      for (const u of fl.units) {
        const col = STATUS[u.status]?.color || '#cbd5e1';
        const m = flat
          ? new THREE.Mesh(extrude(shrink(u.poly, .985), .05, top + .05),
            new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0, depthWrite: false, toneMapped: false }))
          : new THREE.Mesh(extrude(shrink(u.poly, .93), fl.h * .82, fl.base + .3),
            new THREE.MeshStandardMaterial({ color: col, roughness: .5 }));
        m.castShadow = m.receiveShadow = !flat;
        m.userData = { kind: 'unit', unit: u, T, flat };
        ug.add(m);
        pickables.push(m);
        const e = document.createElement('div');
        e.className = 'p3d-unit';
        e.textContent = u.code.slice(-2);
        const lb = new CSS2DObject(e);
        const [cx, cy] = polyCentroid(u.poly);
        lb.position.set(cx, flat ? top + .6 : fl.base + fl.h, cy);
        ug.add(lb);
      }
      world.add(ug);
      T.unitGroup = ug;

      ui.floorList.querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.f === f));
      ui.title.textContent = `Tòa ${t.code} — Tầng ${pad(f)}`;
      ui.hint.textContent = fl.nonSale ? 'Tầng thương mại / không bán.'
        : `${availableCount(fl)}/${fl.units.length} căn còn trống. Rê chuột lên căn để xem, bấm để xem chi tiết.`;
      const c = T.box.getCenter(new THREE.Vector3()), s = T.box.getSize(new THREE.Vector3());
      c.y = flat ? fl.base + fl.h : fl.base;
      flyTo(c, Math.max(s.x, s.z) * 1.25 + 25, .85);
    }

    function clearFloor() {
      clearUnitHL();
      if (!selected) return;
      const T = selected;
      T.floors.forEach(o => { if (o) o.group.visible = true; });
      T.extras.forEach(o => o.visible = true);
      if (T.label) T.label.visible = true;
      if (T.marks) T.marks.visible = true;
      if (T.facade) T.facade.visible = true;
      if (T.unitGroup) {
        pickables = pickables.filter(m => m.parent !== T.unitGroup);
        disposeTree(T.unitGroup);
        world.remove(T.unitGroup);
        T.unitGroup = null;
      }
      selectedFloor = null;
      ui.card.style.display = 'none';
      if (T.facadeSel) { const m = T.facadeSel; T.facadeSel = null; paintFacadeMesh(m); }
    }

    function back() {
      if (!selected) return;
      if (selectedFloor !== null) { select(selected); return; }
      clearFloor();
      removeFloorMarks(selected);
      removeFacade(selected);
      selected = null;
      towers.forEach(o => { setDim(o, false); resetColors(o); if (o.availOverlay) o.availOverlay.visible = true; });
      showOverviewUI();
      flyTo(overviewView.target, overviewView.dist);
    }

    // ---- camera bay mượt
    let flight = null;
    function flyTo(target, distance, maxPolar = 1.05) {
      const sph = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target));
      sph.phi = Math.min(Math.max(sph.phi, .35), maxPolar);
      sph.radius = distance;
      flight = {
        t0: performance.now(), dur: 900,
        fromPos: camera.position.clone(), fromTarget: controls.target.clone(),
        toPos: target.clone().add(new THREE.Vector3().setFromSpherical(sph)), toTarget: target.clone(),
      };
    }

    // ---- hover / click
    const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
    let hovered = null, downAt = null, lastHit = null;
    function pick(e) {
      const r = renderer.domElement.getBoundingClientRect();
      mouse.set((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(mouse, camera);
      const vis = pickables.filter(m => m.visible && m.parent.visible);
      lastHit = ray.intersectObjects(vis, false)[0] || null;
      return lastHit?.object || null;
    }
    function setHover(m) {
      if (hovered === m) return;
      const prev = hovered;
      hovered = m;
      for (const o of [prev, m]) {
        if (!o) continue;
        if (o.userData.kind === 'facade') { paintFacadeMesh(o); continue; }
        const mat = Array.isArray(o.material) ? o.material[1] : o.material;
        if (o.userData.flat) { mat.opacity = o === hovered ? .35 : 0; continue; }
        mat.emissive.set(o === hovered ? '#3b4a5e' : 0);
      }
    }
    // Nội dung thông tin căn (dùng cho cả thẻ rê chuột và thẻ khi bấm)
    function unitInfoHTML(u, T) {
      const s = STATUS[u.status] || { label: u.status, color: '#64748b' };
      const rows = [
        ['Loại căn', escHtml(u.type)],
        ['Phòng ngủ', u.bedrooms != null ? `${escHtml(u.bedrooms)} PN${u.bathrooms != null ? ` · ${escHtml(u.bathrooms)} WC` : ''}` : ''],
        ['Diện tích', `${u.areaExact ? '' : '≈ '}${u.area} m²`],
        ['Hướng', escHtml(u.direction)],
        ['View', escHtml(u.view)],
      ].filter(r => r[1]);
      const price = u.status === 'available' && u.price
        ? `<tr class="price"><td>${u.priceEstimated ? 'Giá tham khảo' : 'Giá'}</td><td>${fmtPrice(u.price)}</td></tr>` : '';
      return `<div class="p3d-u"><h3>Căn ${escHtml(u.code)}<span class="st" style="background:${s.color}">${s.label}</span></h3>` +
        `<div class="sub">Tòa ${escHtml(T.t.code)} · Tầng ${pad(u.floor)} · Căn số ${escHtml(u.no)}</div>` +
        `<table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}${price}</table>` +
        (price && u.priceEstimated ? '<small>Giá ước tính = diện tích × đơn giá, chỉ để tham khảo.</small>' : '') + '</div>';
    }
    function unitCard(u, T) {
      ui.card.innerHTML = `<button class="x">×</button>` + unitInfoHTML(u, T) +
        (selectedFloor === null ? `<button class="p3d-back" style="display:inline-block" data-floor="${u.floor}">Xem mặt bằng tầng ${pad(u.floor)}</button>` : '');
      ui.card.style.display = 'block';
    }
    // ---- tô nguyên khối căn (đúng hình đã vẽ) khi rê chuột từ bên ngoài tòa
    function pointInPoly([x, y], poly) {
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i], [xj, yj] = poly[j];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    }
    // điểm chuột chạm mặt ngoài tầng → lùi vào trong một chút → thuộc căn nào
    function unitAtHit(fl, hit) {
      if (!fl || !hit || !fl.units.length) return null;
      const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3();
      for (const k of [.35, .8, 1.5]) {
        const q = [hit.point.x - n.x * k, hit.point.z - n.z * k];
        const u = fl.units.find(u => pointInPoly(q, u.poly));
        if (u) return u;
      }
      return null;
    }
    let unitHL = null, unitHLKey = null;
    function showUnitHL(u, fl) {
      const key = u ? u.code : null;
      if (key === unitHLKey) return;
      clearUnitHL();
      if (!u) return;
      unitHLKey = key;
      const col = u.status === 'available' ? '#ff2600' : '#64748b';
      const geo = extrude(u.poly, Math.max(.5, fl.h - .16), fl.base + .08);
      const fill = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: .62, depthTest: false, depthWrite: false }));
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: '#ffffff', depthTest: false }));
      fill.renderOrder = 10; edges.renderOrder = 11;
      unitHL = new THREE.Group();
      unitHL.add(fill, edges);
      world.add(unitHL);
    }
    function clearUnitHL() {
      if (unitHL) { disposeTree(unitHL); world.remove(unitHL); unitHL = null; }
      unitHLKey = null;
    }
    // căn đang trỏ: từ tấm mặt tiền, hoặc từ mặt ngoài tầng của tòa đang chọn
    function hoverTarget(m) {
      if (!m) return null;
      const d = m.userData;
      if (d.kind === 'facade') return { unit: d.unit, fl: d.fl, T: d.T };
      if (d.kind === 'floor' && selected === d.T && selectedFloor === null) {
        const u = unitAtHit(d.fl, lastHit);
        if (u) return { unit: u, fl: d.fl, T: d.T };
      }
      return null;
    }

    const dom = renderer.domElement;
    dom.addEventListener('pointermove', e => {
      if (e.buttons) { ui.tip.style.display = 'none'; return; }
      let m = pick(e);
      // đang xem cả tòa: rê lên mặt tiền căn cũng tính là rê lên cả tầng (thông tin căn chỉ hiện khi đã vào mặt cắt)
      const towerView = !!selected && selectedFloor === null;
      if (towerView && m?.userData.kind === 'facade') m = m.userData.fl.group.children.find(c => c.userData.kind === 'floor') || m;
      setHover(m);
      const ht = towerView ? null : hoverTarget(m);
      // (bỏ khối tô nổi khi rê chuột — chỉ hiện thẻ thông tin căn)
      if (!m) { ui.tip.style.display = 'none'; dom.style.cursor = ''; return; }
      dom.style.cursor = 'pointer';
      const d = m.userData;
      if (ht) {
        ui.tip.innerHTML = unitInfoHTML(ht.unit, ht.T);
      } else if (d.kind === 'unit' || d.kind === 'facade') {
        ui.tip.innerHTML = unitInfoHTML(d.unit, d.T);
      } else {
        const fl = d.fl;
        ui.tip.innerHTML = `<b>Tòa ${escHtml(d.T.t.code)} · Tầng ${pad(fl.f)}</b><br>` +
          (fl.nonSale ? 'Tầng thương mại / không bán' : `${availableCount(fl)}/${fl.units.length} căn còn trống`) +
          (towerView && d.T === selected ? '<br><span style="color:#93c5fd">Bấm để xem mặt bằng tầng</span>' : '');
      }
      // đặt thẻ cạnh con trỏ, lật sang trái / lên trên nếu sát mép
      const r = container.getBoundingClientRect();
      ui.tip.style.display = 'block';
      const x = e.clientX - r.left, y = e.clientY - r.top, w = ui.tip.offsetWidth, h = ui.tip.offsetHeight;
      ui.tip.style.left = (x + 16 + w > r.width ? Math.max(4, x - 16 - w) : x + 16) + 'px';
      ui.tip.style.top = (y + 16 + h > r.height ? Math.max(4, y - 16 - h) : y + 16) + 'px';
    });
    dom.addEventListener('pointerleave', () => { setHover(null); clearUnitHL(); ui.tip.style.display = 'none'; });
    dom.addEventListener('pointerdown', e => { downAt = [e.clientX, e.clientY]; });
    dom.addEventListener('pointerup', e => {
      if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
      const m = pick(e);
      if (!m) return;
      const d = m.userData;
      if (selected && selectedFloor === null && d.T === selected && (d.kind === 'floor' || d.kind === 'facade')) { selectFloor(d.fl.f); return; }
      const ht = d.kind === 'floor' ? hoverTarget(m) : null;
      if (ht) {   // bấm mặt ngoài tầng đúng chỗ một căn → xem căn đó
        if (opts.onUnitClick) return opts.onUnitClick(ht.unit);
        unitCard(ht.unit, ht.T);
      } else if (d.kind === 'facade') {
        const prev = d.T.facadeSel;
        d.T.facadeSel = m;
        if (prev) paintFacadeMesh(prev);
        paintFacadeMesh(m);
        if (opts.onUnitClick) return opts.onUnitClick(d.unit);
        unitCard(d.unit, d.T);
      } else if (d.kind === 'unit') {
        if (opts.onUnitClick) return opts.onUnitClick(d.unit);
        unitCard(d.unit, d.T);
      } else if (selected !== d.T) select(d.T);
      else selectFloor(d.fl.f);
    });
    const onKey = e => { if (e.key === 'Escape' && container.isConnected && !opts.compact) back(); };
    window.addEventListener('keydown', onKey);

    // ---- resize + render loop
    function resize() {
      const w = container.clientWidth || 1, h = container.clientHeight || 1;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      labelRenderer.setSize(w, h);
    }
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    resize();

    const ease = x => 1 - Math.pow(1 - x, 3);
    renderer.setAnimationLoop(() => {
      if (flight) {
        const k = ease(Math.min(1, (performance.now() - flight.t0) / flight.dur));
        camera.position.lerpVectors(flight.fromPos, flight.toPos, k);
        controls.target.lerpVectors(flight.fromTarget, flight.toTarget, k);
        if (k >= 1) flight = null;
      }
      controls.update();
      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);
    });

    function dispose() {
      renderer.setAnimationLoop(null);
      ro.disconnect();
      window.removeEventListener('keydown', onKey);
      clearWorld();
      texCache.forEach(t => t.dispose());
      renderer.dispose();
      container.innerHTML = '';
    }

    return { load, select, selectFloor, back, dispose, get data() { return data; } };
  }

  window.Project3D = { create, normalize, STATUS, util: { polyArea, polyCentroid, bbox, parseRanges, parseOverrides, unitCells, facadeSegments, facadeDirection } };
})();
