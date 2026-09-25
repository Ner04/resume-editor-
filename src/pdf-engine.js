/* ResumeFit PDF engine: keeps the original layout and swaps only edited lines. */
const RFPDF = (() => {
  "use strict";
  const BULLET_ONLY = /^[•●▪◦‣■□➢➤►▸◆◇❖✓✔∙·*\-–—]$/;
  const BULLET_LEAD = /^([•●▪◦‣■□➢➤►▸◆◇❖✓✔∙]\s*|[-–]\s+)/;
  const mul = (m, n) => [
    m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]
  ];
  const I = [1, 0, 0, 1, 0, 0];
  const normName = s => String(s || "").replace(/^\/?/, "").replace(/[,_]/g, "-").toLowerCase();
  const stripSubset = s => s.replace(/^[a-z]{6}\+/i, "");

  function fontInfo(page, tc, fontName) {
    let name = "", fam = (tc.styles[fontName] && tc.styles[fontName].fontFamily) || "";
    let bold = false, italic = false;
    try {
      const f = page.commonObjs.get(fontName);
      if (f) { name = f.name || ""; bold = !!(f.bold || f.black); italic = !!f.italic; }
    } catch (e) {}
    const n = (name + " " + fam).toLowerCase();
    if (/bold|black|heavy|semibold|demi/.test(n)) bold = true;
    if (/italic|oblique/.test(n)) italic = true;
    let family = "sans";
    if (/mono|courier|consol/.test(n)) family = "mono";
    else if (/(times|georgia|garamond|cambria|book ?antiqua|palatino|minion|baskerville|serif|merriweather|lora|charter|caslon|didot|bodoni|cmr|lmroman|nimbusrom)/.test(n) && !/sans/.test(n)) family = "serif";
    return { family, bold, italic, name };
  }

  function sampleColors(ctx, sc, pageH, vx0, vy0, row) {
    try {
      const x = Math.max(0, Math.floor((row.x - vx0) * sc) - 2);
      const top = Math.max(0, Math.floor((pageH - (row.y - vy0) - row.size * 0.95) * sc));
      const w = Math.max(4, Math.ceil((row.xEnd - row.x) * sc) + 4);
      const h = Math.max(4, Math.ceil(row.size * 1.25 * sc));
      const d = ctx.getImageData(x, top, Math.min(w, ctx.canvas.width - x), Math.min(h, ctx.canvas.height - top)).data;
      const key = i => ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
      const counts = new Map();
      for (let i = 0; i < d.length; i += 4) { const k = key(i); counts.set(k, (counts.get(k) || 0) + 1); }
      let bk = 0, bc = -1;
      counts.forEach((c, k) => { if (c > bc) { bc = c; bk = k; } });
      let br = 0, bg = 0, bb = 0, bn = 0;
      for (let i = 0; i < d.length; i += 4) if (key(i) === bk) { br += d[i]; bg += d[i + 1]; bb += d[i + 2]; bn++; }
      const bgc = [br / bn, bg / bn, bb / bn];
      const px = [];
      for (let i = 0; i < d.length; i += 4) {
        const dist = Math.abs(d[i] - bgc[0]) + Math.abs(d[i + 1] - bgc[1]) + Math.abs(d[i + 2] - bgc[2]);
        if (dist > 90) px.push([dist, d[i], d[i + 1], d[i + 2]]);
      }
      let fg;
      if (px.length) {
        px.sort((a, b) => b[0] - a[0]);
        const t = px.slice(0, Math.max(1, Math.ceil(px.length * 0.25)));
        fg = [0, 1, 2].map(j => t.reduce((a, p) => a + p[j + 1], 0) / t.length);
      } else fg = (bgc[0] + bgc[1] + bgc[2]) / 3 > 128 ? [0, 0, 0] : [255, 255, 255];
      return { bg: bgc.map(Math.round), color: fg.map(Math.round) };
    } catch (e) { return { bg: [255, 255, 255], color: [0, 0, 0] }; }
  }

  function makeRow(seg, page) {
    let bullet = false, bulletChar = "", textX = seg[0].x, parts = seg.slice(), leadCut = false;
    const first = seg[0].str.trim();
    if (BULLET_ONLY.test(first) && seg.length > 1) { bullet = true; bulletChar = first; parts = seg.slice(1); textX = parts[0].x; }
    else {
      const m = seg[0].str.match(BULLET_LEAD);
      if (m && seg[0].str.length > m[0].length) {
        bullet = true; bulletChar = m[1].trim(); leadCut = true;
        textX = seg[0].x + seg[0].w * (m[0].length / seg[0].str.length);
      }
    }
    const chars = []; let end = null;
    parts.forEach((it, k) => {
      let s = it.str;
      if (k === 0 && leadCut) s = s.replace(BULLET_LEAD, "");
      if (end !== null && it.x - end > it.size * 0.12 && chars.length && chars[chars.length - 1].c !== " " && !/^\s/.test(s)) chars.push({ c: " ", f: it.font });
      for (const c of s) chars.push({ c: /\s/.test(c) ? " " : c, f: it.font });
      end = it.x + it.w;
    });
    const out = [];
    for (const ch of chars) { if (ch.c === " " && (!out.length || out[out.length - 1].c === " ")) continue; out.push(ch); }
    while (out.length && out[out.length - 1].c === " ") out.pop();
    // the line's main style is the one most of its characters use
    const cnt = new Map(); parts.forEach(p => cnt.set(p, p.str.replace(/\s/g, "").length));
    const main = parts.slice().sort((a, b) => cnt.get(b) - cnt.get(a))[0] || parts[0];
    const last = seg[seg.length - 1];
    return {
      page, x: seg[0].x, textX, xEnd: last.x + last.w, y: main.y, size: main.size,
      font: main.font, bullet, bulletChar, bulletSize: seg[0].size, bulletFont: seg[0].font,
      text: out.map(x => x.c).join(""), fonts: out.map(x => x.f)
    };
  }

  /* Read the PDF into editable lines with their exact geometry. */
  async function extract(pdfjs, bytes, opts = {}) {
    const doc = await pdfjs.getDocument(Object.assign({ data: bytes.slice(), isEvalSupported: false }, opts.docOpts || {})).promise;
    const pages = [], rows = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const [vx0, vy0, vx1, vy1] = page.view;
      const pw = vx1 - vx0, ph = vy1 - vy0;
      let ctx = null; const sc = 2;
      if (opts.makeCanvas) {
        const v = page.getViewport({ scale: sc });
        const cv = opts.makeCanvas(Math.ceil(v.width), Math.ceil(v.height));
        ctx = cv.getContext("2d", { willReadFrequently: true });
        await page.render({ canvasContext: ctx, viewport: v }).promise;
      } else await page.getOperatorList();
      const tc = await page.getTextContent();
      const fcache = {}, items = [];
      for (const it of tc.items) {
        if (!it.str || !it.str.trim()) continue;
        const t = it.transform;
        if (Math.abs(t[1]) > 0.01 || Math.abs(t[2]) > 0.01 || t[0] <= 0 || t[3] <= 0) continue; // rotated text is left alone
        const size = Math.abs(t[3]) || 10;
        const f = fcache[it.fontName] || (fcache[it.fontName] = fontInfo(page, tc, it.fontName));
        items.push({ str: it.str, x: t[4], y: t[5], w: it.width || 0, size, font: f });
      }
      const prow = [];
      items.sort((a, b) => b.y - a.y || a.x - b.x);
      for (const it of items) {
        let r = prow.find(r => Math.abs(r.y - it.y) < Math.max(1.2, Math.min(r.size, it.size) * 0.3));
        if (!r) { r = { y: it.y, size: it.size, items: [] }; prow.push(r); }
        r.items.push(it);
      }
      for (const r of prow) {
        r.items.sort((a, b) => a.x - b.x);
        let seg = [], end = null;
        const flush = () => { if (seg.length) rows.push(makeRow(seg, p - 1)); seg = []; };
        for (const it of r.items) {
          if (end !== null && it.x - end > Math.max(it.size * 3, 24)) { flush(); end = null; }
          seg.push(it); end = Math.max(end === null ? -1e9 : end, it.x + it.w);
        }
        flush();
      }
      const pageRows = rows.filter(r => r.page === p - 1);
      if (ctx) pageRows.forEach(r => Object.assign(r, sampleColors(ctx, sc, ph, vx0, vy0, r)));
      const minX = pageRows.length ? Math.min(...pageRows.map(r => r.x)) : vx0 + 36;
      const maxX = pageRows.length ? Math.max(...pageRows.map(r => r.xEnd)) : vx1 - 36;
      pages.push({ w: pw, h: ph, x0: vx0, y0: vy0, minX, maxX });
    }
    for (const r of rows) {
      const pg = pages[r.page];
      const same = rows.filter(o => o.page === r.page && o !== r);
      const peers = same.filter(o => Math.abs(o.x - r.x) < 30 || Math.abs(o.textX - r.textX) < 30);
      r.colRight = peers.length ? Math.max(r.xEnd, ...peers.map(o => o.xEnd)) : Math.max(r.xEnd, pg.maxX);
      const mid = pg.x0 + pg.w / 2, c = (r.x + r.xEnd) / 2;
      const alignedPeer = same.some(o => Math.abs(o.x - r.x) < 1 && Math.abs((o.x + o.xEnd) / 2 - c) > 10);
      r.centered = Math.abs(c - mid) < pg.w * 0.08 && r.x - pg.minX > 20 && (r.xEnd - r.x) < 0.8 * (pg.maxX - pg.minX) && !alignedPeer;
      r.center = c;
      if (!r.bg) { r.bg = [255, 255, 255]; r.color = [0, 0, 0]; }
    }
    rows.sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
    const lines = [];
    let prev = null;
    for (const r of rows) {
      if (prev && (prev.page !== r.page || prev.y - r.y > Math.max(prev.size, r.size) * 1.9)) lines.push({ text: "", orig: "", rows: [] });
      // look back a few lines for the line this row continues (handles two-column layouts)
      let target = null;
      for (let k = lines.length - 1, seen = 0; k >= 0 && seen < 4; k--) {
        const L = lines[k]; if (!L.rows.length) continue; seen++;
        const lr = L.rows[L.rows.length - 1];
        if (lr.page !== r.page) break;
        const gap = lr.y - r.y;
        if (!(gap > 0 && gap <= Math.max(lr.size, r.size) * 1.7 && Math.abs(lr.size - r.size) < 0.6)) continue;
        const contBullet = L.bullet && !r.bullet && Math.abs(r.x - L.rows[0].textX) < 3;
        const contPara = !L.bullet && !r.bullet && !r.centered && !lr.centered && Math.abs(r.x - lr.x) < 2 &&
          lr.xEnd > lr.colRight - lr.size * 4 && lr.font.bold === r.font.bold && /[a-z0-9,;]$/i.test(lr.text) && /^[a-z0-9(]/.test(r.text);
        if (contBullet || contPara) { target = L; break; }
        if (Math.abs(r.x - lr.x) < 30) break; // same column but not a continuation
      }
      if (target) {
        target.rows.push(r);
        if (!/-$/.test(target.body)) { target.body += " "; target.fonts.push(target.fonts[target.fonts.length - 1] || r.font); }
        target.body += r.text; target.fonts.push(...r.fonts);
      } else lines.push({ rows: [r], bullet: r.bullet, bulletChar: r.bulletChar, body: r.text, fonts: r.fonts.slice() });
      prev = r;
    }
    for (const l of lines) {
      if (!l.rows.length) continue;
      l.text = l.orig = (l.bullet ? "- " : "") + l.body;
      delete l.body;
    }
    return { pages, lines, numPages: doc.numPages };
  }

  /* ---------- content stream editing ---------- */
  const WS = new Set([0, 9, 10, 12, 13, 32]);
  const DELIM = new Set("()<>[]{}/%".split("").map(c => c.charCodeAt(0)));
  function tokenize(s) {
    const ops = [];
    let i = 0, args = [], opStart = -1, depth = 0;
    const n = s.length, isWS = c => WS.has(c), isDel = c => DELIM.has(c);
    while (i < n) {
      const c = s.charCodeAt(i);
      if (isWS(c)) { i++; continue; }
      if (c === 37) { while (i < n && s[i] !== "\n" && s[i] !== "\r") i++; continue; }
      if (opStart < 0) opStart = i;
      if (c === 40) {
        let j = i + 1, d = 1;
        while (j < n && d > 0) { const ch = s[j]; if (ch === "\\") j += 2; else { if (ch === "(") d++; else if (ch === ")") d--; j++; } }
        args.push({ t: "str" }); i = j; continue;
      }
      if (c === 60) {
        if (s[i + 1] === "<") { args.push({ t: "<<" }); depth++; i += 2; continue; }
        const j = s.indexOf(">", i); args.push({ t: "hex" }); i = (j < 0 ? n : j + 1); continue;
      }
      if (c === 62) { if (s[i + 1] === ">") { args.push({ t: ">>" }); depth = Math.max(0, depth - 1); i += 2; continue; } i++; continue; }
      if (c === 91 || c === 93 || c === 123 || c === 125) { args.push({ t: s[i] }); i++; continue; }
      if (c === 47) { let j = i + 1; while (j < n && !isWS(s.charCodeAt(j)) && !isDel(s.charCodeAt(j))) j++; args.push({ t: "name" }); i = j; continue; }
      let j = i; while (j < n && !isWS(s.charCodeAt(j)) && !isDel(s.charCodeAt(j))) j++;
      if (j === i) { i++; continue; }
      const word = s.slice(i, j);
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) { args.push({ t: "num", v: parseFloat(word) }); i = j; continue; }
      if (word === "true" || word === "false" || word === "null" || depth > 0) { args.push({ t: "kw" }); i = j; continue; }
      if (word === "BI") {
        const id = s.indexOf("ID", j); let k = id + 3, ei = -1;
        while (id >= 0 && k < n) { const p = s.indexOf("EI", k); if (p < 0) break; if (isWS(s.charCodeAt(p - 1)) && (p + 2 >= n || isWS(s.charCodeAt(p + 2)))) { ei = p; break; } k = p + 2; }
        const end = ei < 0 ? n : ei + 2;
        ops.push({ op: "BI", args: [], start: opStart, end }); args = []; opStart = -1; i = end; continue;
      }
      ops.push({ op: word, args, start: opStart, end: j });
      args = []; opStart = -1; i = j;
    }
    return ops;
  }

  function filterContent(s, rects) {
    const ops = tokenize(s);
    let ctm = I.slice(), tm = I.slice(), tlm = I.slice(), TL = 0, positioned = true, lastHit = -1;
    const stack = [], hit = new Set(), cut = [];
    const inside = () => {
      const m = mul(tm, ctm), px = m[4], py = m[5];
      for (let k = 0; k < rects.length; k++) { const r = rects[k]; if (px >= r[0] && px <= r[2] && py >= r[1] && py <= r[3]) return k; }
      return -1;
    };
    const td = (x, y) => { tlm = mul([1, 0, 0, 1, x, y], tlm); tm = tlm.slice(); positioned = true; };
    for (const o of ops) {
      const a = o.args.filter(x => x.t === "num").map(x => x.v);
      switch (o.op) {
        case "q": stack.push(ctm.slice()); break;
        case "Q": ctm = stack.pop() || I.slice(); break;
        case "cm": if (a.length === 6) ctm = mul(a, ctm); break;
        case "BT": tm = I.slice(); tlm = I.slice(); positioned = true; break;
        case "Tm": if (a.length === 6) { tm = a.slice(); tlm = a.slice(); positioned = true; } break;
        case "Td": if (a.length === 2) td(a[0], a[1]); break;
        case "TD": if (a.length === 2) { TL = -a[1]; td(a[0], a[1]); } break;
        case "TL": if (a.length) TL = a[0]; break;
        case "T*": td(0, -TL); break;
        case "Tj": case "TJ": case "'": case '"': {
          if (o.op === "'" || o.op === '"') td(0, -TL);
          const k = positioned ? inside() : lastHit;
          lastHit = k; positioned = false;
          if (k >= 0) {
            hit.add(k);
            let rep = " ";
            if (o.op === "'") rep = " T* ";
            if (o.op === '"') rep = ` ${a[0] || 0} Tw ${a[1] || 0} Tc T* `;
            cut.push([o.start, o.end, rep]);
          }
          break;
        }
      }
    }
    if (!cut.length) return { out: null, hit };
    let out = "", pos = 0;
    for (const [st, en, rep] of cut) { out += s.slice(pos, st) + rep; pos = en; }
    return { out: out + s.slice(pos), hit };
  }

  /* ---------- the resume's own embedded fonts ---------- */
  function streamText(PDFLib, st) {
    const bytes = st instanceof PDFLib.PDFRawStream ? PDFLib.decodePDFRawStream(st).decode() : st.getContents();
    let s = ""; for (let k = 0; k < bytes.length; k += 8192) s += String.fromCharCode.apply(null, bytes.subarray(k, k + 8192));
    return s;
  }
  function utf16(hex) {
    let s = ""; for (let i = 0; i + 3 < hex.length; i += 4) s += String.fromCharCode(parseInt(hex.substr(i, 4), 16));
    if (hex.length === 2) s = String.fromCharCode(parseInt(hex, 16));
    return s;
  }
  function parseToUnicode(txt) {
    const map = new Map(); let codeLen = 0; // code(int) -> unicode string
    const blocks = txt.split(/begin(bfchar|bfrange)/);
    for (let b = 1; b < blocks.length; b += 2) {
      const kind = blocks[b], body = blocks[b + 1].split(/end(bfchar|bfrange)/)[0];
      if (kind === "bfchar") {
        const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g; let m;
        while ((m = re.exec(body))) { codeLen = Math.max(codeLen, m[1].length / 2); map.set(parseInt(m[1], 16), utf16(m[2])); }
      } else {
        const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]+)>|\[([^\]]*)\])/g; let m;
        while ((m = re.exec(body))) {
          codeLen = Math.max(codeLen, m[1].length / 2);
          const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16);
          if (hi - lo > 5000) continue;
          if (m[4] !== undefined) {
            const base = m[4], last = parseInt(base.slice(-4), 16);
            for (let c = lo; c <= hi; c++) map.set(c, utf16(base.slice(0, -4) + (last + c - lo).toString(16).padStart(4, "0")));
          } else {
            const arr = (m[5].match(/<([0-9a-fA-F]*)>/g) || []).map(x => x.slice(1, -1));
            arr.forEach((h, k) => map.set(lo + k, utf16(h)));
          }
        }
      }
    }
    return { map, codeLen };
  }
  const WINANSI_EXTRA = { "€": 128, "‚": 130, "ƒ": 131, "„": 132, "…": 133, "†": 134, "‡": 135, "ˆ": 136, "‰": 137, "Š": 138, "‹": 139, "Œ": 140, "Ž": 142, "‘": 145, "’": 146, "“": 147, "”": 148, "•": 149, "–": 150, "—": 151, "˜": 152, "™": 153, "š": 154, "›": 155, "œ": 156, "ž": 158, "Ÿ": 159 };

  function buildNative(PDFLib, doc, resName, fdict) {
    const N = n => PDFLib.PDFName.of(n);
    const sub = fdict.lookup(N("Subtype"));
    const subtype = sub ? sub.decodeText() : "";
    if (subtype === "Type3") return null;
    const uni2code = new Map();
    let codeLen = subtype === "Type0" ? 2 : 1;
    const tu = fdict.lookup(N("ToUnicode"));
    if (tu && (tu instanceof PDFLib.PDFRawStream || tu.getContents)) {
      try {
        const { map, codeLen: cl } = parseToUnicode(streamText(PDFLib, tu));
        if (cl) codeLen = cl;
        map.forEach((u, code) => { if (u.length === 1 && !uni2code.has(u)) uni2code.set(u, code); });
      } catch (e) {}
    }
    let widthOf;
    if (subtype === "Type0") {
      const desc = fdict.lookup(N("DescendantFonts"));
      const cid = desc && desc.lookup ? desc.lookup(0) : null;
      if (!cid) return null;
      const dwObj = cid.lookup(N("DW")); const DW = dwObj ? dwObj.asNumber() : 1000;
      const W = cid.lookup(N("W")); const wm = new Map();
      if (W && W.size) {
        const arr = []; for (let k = 0; k < W.size(); k++) arr.push(W.lookup(k));
        for (let k = 0; k < arr.length;) {
          const c1 = arr[k].asNumber(), nx = arr[k + 1];
          if (nx && nx.size) { for (let j = 0; j < nx.size(); j++) wm.set(c1 + j, nx.lookup(j).asNumber()); k += 2; }
          else { const c2 = nx.asNumber(), w = arr[k + 2].asNumber(); for (let c = c1; c <= c2 && c - c1 < 5000; c++) wm.set(c, w); k += 3; }
        }
      }
      widthOf = code => (wm.has(code) ? wm.get(code) : DW);
      if (!uni2code.size) return null; // cannot map characters to glyphs
    } else {
      const fcObj = fdict.lookup(N("FirstChar")), wObj = fdict.lookup(N("Widths"));
      if (!fcObj || !wObj) return null;
      const fc = fcObj.asNumber(), ws = []; for (let k = 0; k < wObj.size(); k++) ws.push(wObj.lookup(k).asNumber());
      widthOf = code => ws[code - fc] || 0;
      if (!uni2code.size) {
        const enc = fdict.lookup(N("Encoding"));
        const encName = enc && enc.decodeText ? enc.decodeText() : (enc && enc.lookup && enc.lookup(N("BaseEncoding")) && !enc.lookup(N("Differences")) ? enc.lookup(N("BaseEncoding")).decodeText() : "");
        if (!/WinAnsiEncoding/.test(encName)) return null;
        for (let c = 32; c < 127; c++) uni2code.set(String.fromCharCode(c), c);
        for (const ch in WINANSI_EXTRA) uni2code.set(ch, WINANSI_EXTRA[ch]);
      }
      codeLen = 1;
      // only glyphs that actually exist in the subset
      for (const [u, c] of [...uni2code]) if (!(widthOf(c) > 0) && u !== " ") uni2code.delete(u);
    }
    const spaceCode = uni2code.get(" ");
    const spaceW = spaceCode !== undefined && widthOf(spaceCode) > 0 ? widthOf(spaceCode) : 260;
    const has = ch => ch === " " || uni2code.has(ch);
    const wordW = w => { let t = 0; for (const ch of w) t += widthOf(uni2code.get(ch)); return t; };
    return {
      native: true, res: resName, spaceW,
      has, canEncode: text => [...text].every(has),
      widthOfTextAtSize(text, size) {
        let t = 0; const words = text.split(" ");
        words.forEach((w, k) => { t += wordW(w); if (k < words.length - 1) t += spaceW; });
        return t * size / 1000;
      },
      hex: w => [...w].map(ch => uni2code.get(ch).toString(16).padStart(codeLen * 2, "0")).join(""),
      wordW
    };
  }

  function nativeFinder(PDFLib, doc) {
    const pages = doc.getPages(), cache = new Map();
    return (pageIdx, fontName) => {
      if (!fontName) return null;
      const key = pageIdx + "|" + fontName;
      if (cache.has(key)) return cache.get(key);
      let found = null;
      try {
        const res = pages[pageIdx].node.Resources();
        const fonts = res && res.lookup(PDFLib.PDFName.of("Font"));
        if (fonts && fonts.entries) {
          const want = normName(fontName), wantBase = stripSubset(want);
          const cands = [];
          for (const [nm, v] of fonts.entries()) {
            const fd = doc.context.lookup(v);
            if (!fd || !fd.lookup) continue;
            const bf = fd.lookup(PDFLib.PDFName.of("BaseFont"));
            const b = normName(bf ? bf.decodeText() : "");
            if (b === want) cands.unshift([nm.decodeText(), fd]);
            else if (stripSubset(b) === wantBase) cands.push([nm.decodeText(), fd]);
          }
          const encs = cands.map(([nm, fd]) => { try { return buildNative(PDFLib, doc, nm, fd); } catch (e) { return null; } }).filter(Boolean);
          if (encs.length) {
            found = encs[0];
            if (encs.length > 1) found = { multi: encs };
          }
        }
      } catch (e) { found = null; }
      cache.set(key, found);
      return found;
    };
  }

  /* ---------- fitting ---------- */
  const STD_KEYS = ["Helvetica", "HelveticaBold", "HelveticaOblique", "HelveticaBoldOblique", "TimesRoman", "TimesRomanBold", "TimesRomanItalic", "TimesRomanBoldItalic", "Courier", "CourierBold", "CourierOblique", "CourierBoldOblique"];
  function fontKey(f) {
    const b = f.bold, i = f.italic;
    if (f.family === "serif") return b && i ? "TimesRomanBoldItalic" : b ? "TimesRomanBold" : i ? "TimesRomanItalic" : "TimesRoman";
    if (f.family === "mono") return b && i ? "CourierBoldOblique" : b ? "CourierBold" : i ? "CourierOblique" : "Courier";
    return b && i ? "HelveticaBoldOblique" : b ? "HelveticaBold" : i ? "HelveticaOblique" : "Helvetica";
  }
  const SUBS = { "₹": "Rs.", "→": "->", "←": "<-", "≥": ">=", "≤": "<=", "✓": "", "✔": "", " ": " ", "​": "", "\t": " " };
  const normalizeBody = text => [...text.replace(/^\s*-\s+/, "")].map(ch => SUBS[ch] !== undefined ? SUBS[ch] : ch).join("").replace(/\s+/g, " ").trim();
  const canStd = (f, ch) => { try { f.widthOfTextAtSize(ch, 10); return true; } catch (e) { return false; } };
  const fid = f => f ? (f.name || "") + "|" + f.family + "|" + (f.bold ? 1 : 0) + (f.italic ? 1 : 0) : "";

  // The resume's own font; characters its subset lacks borrow a close standard font.
  function mixedFont(enc, std, kind) {
    const chW = (ch, size) => ch === " " ? enc.spaceW * size / 1000 : enc.has(ch) ? enc.wordW(ch) * size / 1000 : std.widthOfTextAtSize(ch, size);
    return {
      kind, enc, std,
      ok: ch => ch === " " || enc.has(ch) || canStd(std, ch),
      width(text, size) { let t = 0; for (const ch of text) t += chW(ch, size); return t; },
      draw(PDFLib, page, text, x, y, size, color) {
        const groups = [];
        for (const ch of text) {
          const k = ch === " " ? " " : enc.has(ch) ? "n" : "s";
          const g = groups[groups.length - 1];
          if (g && g.k === k) g.s += ch; else groups.push({ k, s: ch });
        }
        const ops = [PDFLib.pushGraphicsState(), PDFLib.beginText(), ...nativeOps(PDFLib, enc, size, color)];
        const stdRuns = []; let cx = x;
        for (const g of groups) {
          if (g.k === "n") ops.push(PDFLib.setTextMatrix(1, 0, 0, 1, cx, y), PDFLib.showText(PDFLib.PDFHexString.of(enc.hex(g.s))));
          else if (g.k === "s") stdRuns.push([g.s, cx]);
          cx += this.width(g.s, size);
        }
        ops.push(PDFLib.endText(), PDFLib.popGraphicsState());
        page.pushOperators(...ops);
        const rgb = PDFLib.rgb(color[0] / 255, color[1] / 255, color[2] / 255);
        stdRuns.forEach(([s, sx]) => page.drawText(s, { x: sx, y, size, font: std, color: rgb }));
      }
    };
  }
  function stdAdapter(std) {
    return {
      kind: "standard", std,
      ok: ch => ch === " " || canStd(std, ch),
      width: (text, size) => std.widthOfTextAtSize(text, size),
      draw(PDFLib, page, text, x, y, size, color) { page.drawText(text, { x, y, size, font: std, color: PDFLib.rgb(color[0] / 255, color[1] / 255, color[2] / 255) }); }
    };
  }
  const missingIn = (enc, text) => [...text].filter(ch => ch !== " " && !enc.has(ch)).length;
  function adapterFor(finder, std, page, f, sample) {
    const sf = std[fontKey(f)];
    let nat = finder ? finder(page, f.name) : null;
    if (nat && nat.multi) nat = nat.multi.slice().sort((a, b) => missingIn(b, sample) - missingIn(a, sample)).pop();
    if (nat) {
      const miss = missingIn(nat, sample), total = sample.replace(/ /g, "").length || 1;
      if (miss / total <= 0.25) return mixedFont(nat, sf, miss ? "mixed" : "native");
    }
    return stdAdapter(sf);
  }

  // Give each character of the new text a style: unchanged start and end keep their original
  // styles (a bold "Languages:" label stays bold); the edited middle takes the style where the edit begins.
  function styleText(line, body) {
    const old = line.orig.replace(/^- /, ""), F = line.fonts || [];
    const dom = line.rows[0].font;
    if (F.length !== old.length) return [...body].map(() => dom);
    let p = 0; while (p < old.length && p < body.length && old[p] === body[p]) p++;
    let s = 0; while (s < old.length - p && s < body.length - p && old[old.length - 1 - s] === body[body.length - 1 - s]) s++;
    let mid = p < old.length ? F[p] : (p > 0 ? F[p - 1] : dom);
    if (p === 0 && s === 0) mid = dom;
    return [...body].map((_, i) => i < p ? F[i] : i >= body.length - s ? F[old.length - (body.length - i)] : mid);
  }

  // Prepare a styled, measurable version of a line's new text.
  function prepare(finder, std, line, text) {
    const r0 = line.rows[0];
    let body = normalizeBody(text);
    let fonts = styleText(line, body);
    const byFont = new Map();
    [...body].forEach((ch, i) => { const k = fid(fonts[i]); if (!byFont.has(k)) byFont.set(k, { f: fonts[i], s: "" }); byFont.get(k).s += ch; });
    const ads = new Map();
    byFont.forEach((v, k) => ads.set(k, adapterFor(finder, std, r0.page, v.f, v.s)));
    // drop characters no font can draw
    const keep = [...body].map((ch, i) => ads.get(fid(fonts[i])).ok(ch));
    body = [...body].filter((_, i) => keep[i]).join("");
    fonts = fonts.filter((_, i) => keep[i]);
    // words made of same-style runs
    const words = []; let cur = null;
    [...body].forEach((ch, i) => {
      const ad = ads.get(fid(fonts[i]));
      if (ch === " ") { if (cur) { cur.spaceAd = ad; words.push(cur); cur = null; } return; }
      if (!cur) cur = { segs: [], spaceAd: ad };
      const sg = cur.segs[cur.segs.length - 1];
      if (sg && sg.ad === ad) sg.s += ch; else cur.segs.push({ s: ch, ad });
    });
    if (cur) words.push(cur);
    const kinds = [...ads.values()].map(a => a.kind);
    const kind = kinds.includes("standard") ? "standard" : kinds.includes("mixed") ? "mixed" : "native";
    return { words, kind, body };
  }
  const wordW = (w, size) => w.segs.reduce((a, g) => a + g.ad.width(g.s, size), 0);
  const spW = (w, size) => w.spaceAd.width(" ", size);

  function layout(line, prep, pages) {
    const rows = line.rows, r0 = rows[0], pg = pages[r0.page];
    const avail = r => r.centered ? Math.min(pg.w * 0.9, 2 * Math.min(r.center - pg.x0 - 36, pg.x0 + pg.w - 36 - r.center)) : (r.colRight - r.textX + r.size * 0.3);
    const s0 = r0.size;
    const lineW = (ws, size) => ws.reduce((a, w, k) => a + wordW(w, size) + (k < ws.length - 1 ? spW(w, size) : 0), 0);
    for (let size = s0; size >= s0 * 0.85 - 1e-6; size -= Math.max(0.1, s0 * 0.025)) {
      const parts = []; let rowI = 0, cur = [], ok = true;
      for (const w of prep.words) {
        if (lineW(cur.concat([w]), size) <= avail(rows[rowI])) { cur.push(w); continue; }
        if (!cur.length) { ok = false; break; }
        parts.push(cur); rowI++; cur = [w];
        if (rowI >= rows.length || lineW(cur, size) > avail(rows[rowI])) { ok = false; break; }
      }
      if (ok) { if (cur.length) parts.push(cur); return { ok: true, size, parts, scale: size / s0, native: prep.kind, width: ws => lineW(ws, size) }; }
    }
    const size = s0 * 0.85, cap = rows.reduce((a, r) => a + avail(r), 0);
    const total = lineW(prep.words, size), per = total / Math.max(1, prep.body.length);
    return { ok: false, over: Math.max(1, Math.ceil((total - cap * 0.97) / (per || size * 0.5))), native: prep.kind };
  }

  async function stdFonts(PDFLib, doc) {
    const out = {};
    for (const k of STD_KEYS) out[k] = await doc.embedFont(PDFLib.StandardFonts[k]);
    return out;
  }

  /* Fit checker for the UI: sync after one async setup. */
  async function measurer(PDFLib, origBytes, model) {
    const doc = await PDFLib.PDFDocument.load(origBytes, { ignoreEncryption: true, updateMetadata: false });
    const finder = nativeFinder(PDFLib, doc);
    const std = await stdFonts(PDFLib, await PDFLib.PDFDocument.create());
    const fn = (line, text) => {
      if (!line || !line.rows.length) return { ok: false, over: 0, noLine: true };
      return layout(line, prepare(finder, std, line, text), model.pages);
    };
    // glyph widths of the resume's own fonts, for placing highlights precisely
    fn.enc = (pageIdx, name) => { let n = null; try { n = finder(pageIdx, name); } catch (e) {} return n && n.multi ? n.multi[0] : n; };
    return fn;
  }

  function nativeOps(PDFLib, enc, size, color) {
    return [PDFLib.setFontAndSize(enc.res, size), PDFLib.setFillingRgbColor(color[0] / 255, color[1] / 255, color[2] / 255),
      PDFLib.setCharacterSpacing(0), PDFLib.setWordSpacing(0), PDFLib.setCharacterSqueeze(100), PDFLib.setTextRise(0),
      PDFLib.setTextRenderingMode(PDFLib.TextRenderingMode.Fill)];
  }
  function drawNative(PDFLib, page, enc, text, x, y, size, color) {
    page.pushOperators(PDFLib.pushGraphicsState(), PDFLib.beginText(), ...nativeOps(PDFLib, enc, size, color),
      PDFLib.setTextMatrix(1, 0, 0, 1, x, y), PDFLib.showText(PDFLib.PDFHexString.of(enc.hex(text))), PDFLib.endText(), PDFLib.popGraphicsState());
  }

  /* Build the edited PDF. Returns {bytes, report:[{line, removed, native, skipped}]} */
  async function build(PDFLib, origBytes, model) {
    const doc = await PDFLib.PDFDocument.load(origBytes, { ignoreEncryption: true, updateMetadata: false });
    const finder = nativeFinder(PDFLib, doc);
    const std = {};
    const pdfPages = doc.getPages();
    const changed = model.lines.map((l, i) => ({ l, i })).filter(({ l }) => l.rows.length && l.text !== l.orig);
    const needKeys = new Set(["Helvetica"]);
    changed.forEach(({ l }) => { needKeys.add(fontKey(l.rows[0].font)); (l.fonts || []).forEach(f => f && needKeys.add(fontKey(f))); });
    for (const k of needKeys) std[k] = await doc.embedFont(PDFLib.StandardFonts[k]);
    const report = [], byPage = new Map();
    for (const c of changed) {
      const fit = layout(c.l, prepare(finder, std, c.l, c.l.text), model.pages);
      if (!fit.ok) { report.push({ line: c.i, skipped: true }); continue; }
      c.fit = fit;
      c.l.rows.forEach((r, ri) => { if (!byPage.has(r.page)) byPage.set(r.page, []); byPage.get(r.page).push({ c, r, ri }); });
    }
    for (const [pi, entries] of byPage) {
      const page = pdfPages[pi];
      const rects = entries.map(({ r }) => [r.x - 2, r.y - r.size * 0.35, r.xEnd + 2, r.y + r.size * 0.6]);
      let hit = new Set();
      try {
        const contents = page.node.Contents();
        const streams = [];
        if (contents instanceof PDFLib.PDFArray) { for (let k = 0; k < contents.size(); k++) streams.push(contents.lookup(k)); }
        else if (contents) streams.push(contents);
        let src = "";
        for (const st of streams) src += streamText(PDFLib, st) + "\n";
        const res = filterContent(src, rects);
        hit = res.hit;
        if (res.out) {
          const out = new Uint8Array(res.out.length);
          for (let k = 0; k < res.out.length; k++) out[k] = res.out.charCodeAt(k) & 255;
          const ctx = doc.context;
          const ref = ctx.register(ctx.flateStream(out));
          page.node.set(PDFLib.PDFName.of("Contents"), ctx.obj([ctx.getPushGraphicsStateContentStream(), ref, ctx.getPopGraphicsStateContentStream()]));
        }
      } catch (e) { hit = new Set(); }
      entries.forEach(({ c, r, ri }, k) => {
        const removed = hit.has(k);
        const rgb = a => PDFLib.rgb(a[0] / 255, a[1] / 255, a[2] / 255);
        const part = c.fit.parts[ri], size = c.fit.size;
        const tw = part ? c.fit.width(part) : 0;
        if (!removed) page.drawRectangle({ x: r.x - 1.5, y: r.y - r.size * 0.28, width: Math.max(r.xEnd - r.x, r.textX - r.x + tw) + 3, height: r.size * 1.2, color: rgb(r.bg) });
        if (r.bullet && c.fit.parts.length) {
          let bn = finder(r.page, r.bulletFont && r.bulletFont.name);
          if (bn && bn.multi) bn = bn.multi.find(e => e.has(r.bulletChar)) || null;
          if (bn && r.bulletChar && bn.has(r.bulletChar) && r.bulletChar !== " ") drawNative(PDFLib, page, bn, r.bulletChar, r.x, r.y, r.bulletSize || r.size, r.color);
          else page.drawText("•", { x: r.x, y: r.y, size: r.bulletSize || r.size, font: std.Helvetica, color: rgb(r.color) });
        }
        if (part) {
          let x = r.centered ? r.center - tw / 2 : r.textX;
          part.forEach((w, wi) => {
            w.segs.forEach(g => { g.ad.draw(PDFLib, page, g.s, x, r.y, size, r.color); x += g.ad.width(g.s, size); });
            if (wi < part.length - 1) x += spW(w, size);
          });
        }
        if (ri === 0) report.push({ line: c.i, removed, native: c.fit.native });
      });
    }
    const bytes = await doc.save({ useObjectStreams: false });
    return { bytes, report };
  }

  return { extract, build, measurer, filterContent, tokenize };
})();
