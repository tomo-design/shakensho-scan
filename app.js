"use strict";
/* =========================================================
   車検証スキャン 整備サポート v1.0
   - QR読取(jsQR) + 国交省二次元コード仕様パーサ
   - 車両ノウハウDB(db/vehicles.json + localStorageカスタム)
   - スキャン履歴 / DB編集 / OCRフォールバック
   ========================================================= */

const APP_VER = "1.0.0";
const LS = { hist: "ss_history", custom: "ss_customdb", gemini: "ss_geminikey" };

const $ = id => document.getElementById(id);
const toggle = (id, show) => $(id).classList.toggle("hidden", !show);
const setText = (id, t) => { $(id).textContent = t; };

/* ================= メーカーリコールリンク(2026-06検証済) ================= */
const MAKER_RECALL = {
  isuzu:  { label: "いすゞ自動車 リコール検索",   url: "https://www.isuzu.co.jp/recall/input" },
  hino:   { label: "日野自動車 リコール情報",     url: "https://www.hino.co.jp/recall/" },
  fuso:   { label: "三菱ふそう リコール情報",     url: "https://www.mitsubishi-fuso.com/ja/news-recall/recall-information/" },
  ud:     { label: "UDトラックス リコール関連情報", url: "https://www.udtrucks.com/japan/recall-info" },
  nissan: { label: "日産自動車 リコール検索",     url: "https://www.nissan.co.jp/RECALL/" },
  toyota: { label: "トヨタ リコール検索",         url: "https://toyota.jp/recall/" },
  honda:  { label: "ホンダ リコール検索",         url: "https://www.honda.co.jp/recall/" },
  mazda:  { label: "マツダ リコール情報",         url: "https://www2.mazda.co.jp/service/recall/" },
  suzuki: { label: "スズキ リコール情報",         url: "https://www.suzuki.co.jp/recall/" },
  daihatsu:{ label: "ダイハツ リコール情報",      url: "https://www.daihatsu.co.jp/info/recall/" },
  subaru: { label: "スバル リコール検索",         url: "https://www.subaru.co.jp/recall/" },
};
const MLIT_RECALL = "https://renrakuda.mlit.go.jp/renrakuda/recall-search.html";

/* ================= 車両DB ================= */
let BUILTIN_DB = [];
let CUSTOM_DB = [];   // {id,name,match,maker,faults[],checks[],notes}

function loadCustomDB() {
  try { CUSTOM_DB = JSON.parse(localStorage.getItem(LS.custom)) || []; }
  catch (e) { CUSTOM_DB = []; }
}
function saveCustomDB() { localStorage.setItem(LS.custom, JSON.stringify(CUSTOM_DB)); }

async function loadBuiltinDB() {
  try {
    const res = await fetch("db/vehicles.json");
    BUILTIN_DB = (await res.json()).vehicles || [];
  } catch (e) { BUILTIN_DB = []; }
}
/* カスタム(同名は内蔵を上書き)→内蔵 の順で検索対象を構成 */
function mergedDB() {
  const customNames = new Set(CUSTOM_DB.map(v => v.name));
  return [...CUSTOM_DB, ...BUILTIN_DB.filter(v => !customNames.has(v.name))];
}
function findVehicle(typeCode) {
  for (const v of mergedDB()) {
    try { if (new RegExp(v.match, "i").test(typeCode)) return v; } catch (e) {}
  }
  return null;
}

/* =========================================================
   QRパーサ — 国交省「二次元コード項目定義」(2023.1版)準拠
   区切り: "/"。二次元コード2(=2分割), 3(=3分割)。
   [二次元コード2] 1:バージョン 2:登録番号(全角) 3:標板コード
                   4:車台番号 5:原動機型式 6:帳票種別
   [二次元コード3] 1:バージョン 2:打刻位置 3:型式指定番号類別区分番号
                   4:有効期間満了日(YYMMDD/999999) 5:初度登録年月(YYMM/9999)
                   6:型式 7-10:軸重 11:騒音規制 12:近接排気騒音
                   13:駆動方式 14:オパシ 15:NOxPMモード 16:NOx 17:PM
                   18:保安基準適用年月日 19:燃料コード
   物理QRは分割印字のため、読取順に連結して再構成する。
   ========================================================= */

function reconstructCodes(payloadList) {
  // 各payloadが "数字/" で始まれば新コードの先頭、そうでなければ直前の続き
  const codes = [];
  for (const p of payloadList) {
    if (/^\d\//.test(p) || codes.length === 0) codes.push(p);
    else codes[codes.length - 1] += p;
  }
  // 連結順が逆だった場合の救済: フィールド数が合わなければ結合順を変えた候補も返す
  return codes;
}

const zen2han = s => s.replace(/[Ａ-Ｚａ-ｚ０-９]/g,
  c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/　/g, " ");

function parseYYMMDD(s) {
  if (!s || !/^\d{6}$/.test(s) || s === "999999") return null;
  const yy = +s.slice(0, 2), mm = +s.slice(2, 4), dd = +s.slice(4, 6);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const year = 2000 + yy; // 電子車検証制度上、有効期限が19xxはあり得ない
  return new Date(year, mm - 1, dd);
}
function parseYYMM(s) {
  if (!s || !/^\d{4}$/.test(s) || s === "9999") return null;
  const yy = +s.slice(0, 2), mm = +s.slice(2, 4);
  if (mm < 1 || mm > 12) return null;
  const now = new Date();
  // 下2桁の世紀補完: 今年+1より先なら19xx (旧車対応)
  const year = (2000 + yy <= now.getFullYear() + 1) ? 2000 + yy : 1900 + yy;
  return { year, month: mm };
}
const fmtDate = d => d ? `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,"0")}/${String(d.getDate()).padStart(2,"0")}` : null;

function parseStructured(codes) {
  const out = {};
  for (const code of codes) {
    const f = code.split("/").map(s => s.trim());
    if (f.length < 2 || !/^\d$/.test(f[0])) continue;

    // 二次元コード3 (19フィールド): 型式・満了日・初度登録
    if (f.length >= 17) {
      const kata = f[2] && /^\d{5,10}$/.test(f[2]) ? f[2] : null;
      if (kata) out.kataShitei = kata;
      const exp = parseYYMMDD(f[3]);
      if (exp) out.expiry = exp;
      const first = parseYYMM(f[4]);
      if (first) out.firstReg = first;
      const type = zen2han(f[5] || "").toUpperCase();
      if (type && !type.startsWith("*")) out.type = type;
      const fuel = f[18] || f[f.length - 1];
      if (/^\d{2}$/.test(fuel)) out.fuelCode = fuel;
      out.structured = true;
    }
    // 二次元コード2 (6フィールド): 登録番号・車台番号
    else if (f.length >= 5 && f.length <= 7) {
      const plateRaw = f[1] || "";
      if (/[぀-ヿ㐀-鿿Ａ-Ｚ０-９]/.test(plateRaw)) out.plate = plateRaw.replace(/[　 ]+/g, " ").trim();
      const vin = zen2han(f[3] || "").toUpperCase();
      if (/^[A-Z0-9\[\]\-]{4,23}$/.test(vin)) out.vin = vin;
      out.structured = true;
    }
  }
  return out;
}

/* ---- 従来ヒューリスティック(維持・フォールバック) ---- */
function parseHeuristic(fields) {
  let type = null, vin = null, plate = null;
  for (const f of fields) {
    const u = zen2han(f).toUpperCase();
    if (!vin && /^[A-Z0-9]{2,8}-[0-9]{5,8}$/.test(u)) { vin = u; continue; }
    if (!type && /^[0-9A-Z]{2,4}-[A-Z][A-Z0-9]{2,8}$/.test(u) && !/^[0-9]+$/.test(u.split("-")[1])) { type = u; continue; }
    if (!type && /^[A-Z]{1,4}[0-9]{1,3}[A-Z0-9]{0,4}$/.test(u) && u.length <= 9) { type = u; continue; }
    if (!plate && /[぀-ヿ㐀-鿿]/.test(f) && f.length <= 12) plate = f;
  }
  return { type, vin, plate };
}

function parsePayloads(payloadSet) {
  const list = [...payloadSet];
  const codes = reconstructCodes(list);
  const s = parseStructured(codes);

  const rawFields = [];
  list.forEach(p => p.split("/").forEach(f => { f = f.trim(); if (f) rawFields.push(f); }));
  const uniq = [...new Set(rawFields)];
  const h = parseHeuristic(uniq);

  return {
    type:     s.type   || h.type   || null,
    vin:      s.vin    || h.vin    || null,
    plate:    s.plate  || h.plate  || null,
    expiry:   s.expiry || null,
    firstReg: s.firstReg || null,
    kataShitei: s.kataShitei || null,
    structured: !!s.structured,
    raw: uniq,
  };
}

/* ================= スキャン(ライブ/写真) ================= */
let stream = null, scanning = false, raf = null;
const payloads = new Set();
const video = $("video");
const cv = document.createElement("canvas"), ctx = cv.getContext("2d", { willReadFrequently: true });

$("btnStart").addEventListener("click", startScan);
$("btnStop").addEventListener("click", stopAndParse);

async function startScan() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } } });
  } catch (e) {
    setPlaceholder("この環境ではライブカメラを使えません。下の「📸 写真で読み取り」を使ってください。");
    return;
  }
  payloads.clear();
  video.srcObject = stream; await video.play();
  toggle("camPlaceholder", false); toggle("video", true); toggle("scanOverlay", true); toggle("scanStatus", true);
  toggle("btnStart", false); toggle("btnStop", true);
  scanning = true; tick();
}
function tick() {
  if (!scanning) return;
  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    cv.width = video.videoWidth; cv.height = video.videoHeight;
    ctx.drawImage(video, 0, 0);
    const img = ctx.getImageData(0, 0, cv.width, cv.height);
    const code = jsQR(img.data, cv.width, cv.height, { inversionAttempts: "dontInvert" });
    if (code && code.data && !payloads.has(code.data)) {
      payloads.add(code.data);
      setText("qrCount", payloads.size + " 件読取");
      if (navigator.vibrate) navigator.vibrate(60);
      document.querySelector("#scanStatus span").textContent = "✓ 読取OK。別のQRも続けて読めます";
    }
  }
  raf = requestAnimationFrame(tick);
}
function stopAndParse() {
  scanning = false; cancelAnimationFrame(raf);
  if (stream) stream.getTracks().forEach(t => t.stop());
  toggle("video", false); toggle("scanOverlay", false); toggle("scanStatus", false);
  toggle("btnStart", true); toggle("btnStop", false);
  toggle("camPlaceholder", true);
  setPlaceholder(payloads.size ? "解析しました。下に結果を表示しています。" : "QRが読み取れませんでした。明るさ・ピントを調整して再試行してください。");
  if (payloads.size) showResult(parsePayloads(payloads), { fromScan: true });
}
function setPlaceholder(t) { toggle("camPlaceholder", true); setText("camPlaceholder", t); }

/* ---- 手動入力 ---- */
$("btnManual").addEventListener("click", () => {
  const v = $("manualType").value.trim().toUpperCase();
  if (v) showResult({ type: v, vin: null, plate: null, raw: [] }, { fromScan: true });
});

/* =========================================================
   OCRフォールバック (Tesseract.js / Google Vision)
   ========================================================= */
const ocrIn = $("ocrIn");
$("btnOcr").addEventListener("click", () => ocrIn.click());
ocrIn.addEventListener("change", async e => {
  const file = e.target.files[0]; if (!file) return;
  ocrIn.value = "";
  toggle("ocrBox", true);
  $("ocrPreview").src = URL.createObjectURL(file);
  $("ocrStatus").innerHTML = "Tesseract OCR を準備中…(初回はモデル取得に少し時間がかかります)";
  try {
    const text = await ocrTesseract(file);
    const d = extractFromOcrText(text);
    if (d.type || d.vin) {
      $("ocrStatus").innerHTML = "✓ OCR完了。<b>" + (d.type || "型式未検出") + "</b> / " + (d.vin || "車台番号未検出") + " — 誤りがあればRAWチップから修正してください。";
      showResult({ ...d, raw: d.rawCandidates }, { fromScan: true });
    } else {
      $("ocrStatus").innerHTML = "型式・車台番号を特定できませんでした。下のRAW候補チップから手動割り当てするか、より大きく鮮明に撮影してください。";
      if (d.rawCandidates.length) showResult({ type: null, vin: null, plate: null, raw: d.rawCandidates }, { fromScan: false });
    }
  } catch (err) {
    $("ocrStatus").textContent = "OCRエラー: " + (err.message || err);
  }
});

let tesseractReady = null;
function loadTesseract() {
  if (tesseractReady) return tesseractReady;
  tesseractReady = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.1/tesseract.min.js";
    s.onload = res; s.onerror = () => rej(new Error("Tesseract.jsの読み込みに失敗(要ネット接続)"));
    document.head.appendChild(s);
  });
  return tesseractReady;
}
async function ocrTesseract(file, statusId = "ocrStatus") {
  await loadTesseract();
  const worker = await Tesseract.createWorker("jpn", 1, {
    logger: m => {
      if (m.status === "recognizing text")
        $(statusId).textContent = "文字認識中… " + Math.round(m.progress * 100) + "%";
    }
  });
  const { data } = await worker.recognize(file);
  await worker.terminate();
  return data.text || "";
}
function extractFromOcrText(text) {
  const norm = zen2han(text).toUpperCase();
  const lines = norm.split(/\n+/).map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  let type = null, vin = null;
  const rawCandidates = [];
  // ラベル付き行を最優先 (「型式 2PG-FW74HZ」「車台番号 FW74HZ-510123」)
  for (const l of lines) {
    let m;
    if (!vin && (m = l.match(/車台番号\s*[:：]?\s*([A-Z0-9\-\[\]]{5,23})/))) vin = m[1];
    if (!type && (m = l.match(/(?<!原動機の?)型式\s*[:：]?\s*([0-9A-Z]{2,4}-[A-Z][A-Z0-9]{2,8}|[A-Z]{1,4}[0-9]{1,3}[A-Z0-9]{0,4})/))) type = m[1];
  }
  // パターン抽出 (フォールバック + RAW候補)
  const tokens = norm.match(/[A-Z0-9\-\[\]]{4,23}/g) || [];
  for (const t of [...new Set(tokens)]) {
    if (/^[A-Z0-9]{2,8}-[0-9]{5,8}$/.test(t)) { if (!vin) vin = t; rawCandidates.push(t); }
    else if (/^[0-9A-Z]{2,4}-[A-Z][A-Z0-9]{2,8}$/.test(t) && !/^[0-9]+$/.test(t.split("-")[1])) { if (!type) type = t; rawCandidates.push(t); }
    else if (/^[A-Z]{2,4}[0-9]{2,3}[A-Z0-9]{0,4}$/.test(t) && t.length <= 9) rawCandidates.push(t);
  }
  if (type) rawCandidates.unshift(type);
  if (vin) rawCandidates.unshift(vin);
  return { type, vin, plate: null, rawCandidates: [...new Set(rawCandidates)].slice(0, 24) };
}

/* =========================================================
   結果表示
   ========================================================= */
let current = { type: null, vin: null, plate: null, raw: [] };

function showResult(d, opt = {}) {
  current = d;
  switchView("scan");
  toggle("result", true);
  setText("rType", d.type || "未検出（下のRAWから割り当て可）");
  setText("rVin", d.vin || "未検出");
  setText("rPlate", d.plate || "—");
  setText("rFirstReg", d.firstReg ? `${d.firstReg.year}年${d.firstReg.month}月` : "—");
  setText("rKata", d.kataShitei ? d.kataShitei.slice(0, 5) + "-" + d.kataShitei.slice(5) : "—");

  // 有効期限 + 90日警告バッジ
  const rExp = $("rExpiry");
  rExp.textContent = "";
  if (d.expiry) {
    rExp.append(fmtDate(d.expiry));
    const days = Math.floor((d.expiry - new Date()) / 86400000);
    const b = document.createElement("span");
    if (days < 0) { b.className = "badge warn"; b.textContent = "期限切れ"; }
    else if (days <= 90) { b.className = "badge warn"; b.textContent = "残" + days + "日"; }
    else { b.className = "badge ok"; b.textContent = "残" + days + "日"; }
    rExp.appendChild(b);
  } else rExp.textContent = "—";

  // DB照合: 型式のハイフン以降(無ければ全体)
  let hit = null;
  if (d.type) {
    const code = (d.type.includes("-") ? d.type.split("-")[1] : d.type).toUpperCase();
    hit = findVehicle(code);
  }
  const m = $("rMatch");
  if (hit) {
    m.textContent = "⚙ 車種DB一致: " + hit.name;
    fillList("faultList", hit.faults || [], false); toggle("secFault", (hit.faults || []).length > 0);
    renderSpecs(hit.specs || []);
    if (hit.notes) { setText("notesBody", hit.notes); toggle("secNotes", true); } else toggle("secNotes", false);
  } else {
    m.textContent = d.type ? "車種DBに未登録の型式です（DB編集タブで追加できます）" : "型式を特定するとノウハウDBと照合します";
    toggle("secFault", false); toggle("secNotes", false);
    renderSpecs([]);
  }

  // リコールリンク
  $("lnkMlit").href = MLIT_RECALL;
  const mk = hit ? MAKER_RECALL[hit.maker] : null;
  const lm = $("lnkMaker");
  if (mk) { lm.classList.remove("hidden"); lm.firstChild.textContent = mk.label; lm.href = mk.url; }
  else lm.classList.add("hidden");
  $("lnkGoogle").href = "https://www.google.com/search?q=" + encodeURIComponent((d.type || "") + " リコール 改善対策");

  // RAWチップ
  const wrap = $("rawChips"); wrap.innerHTML = "";
  if (d.raw && d.raw.length) {
    d.raw.forEach(f => {
      const c = document.createElement("div"); c.className = "chip"; c.textContent = f;
      c.addEventListener("click", () => showAssign(f)); wrap.appendChild(c);
    });
    toggle("secRaw", true);
  } else toggle("secRaw", false);

  if (opt.fromScan && (d.type || d.vin)) addHistory(d);
  $("result").scrollIntoView({ behavior: "smooth" });
}

/* 割り当てバー */
let pendingVal = null;
function showAssign(v) { pendingVal = v; setText("abVal", v); toggle("assignBar", true); }
function hideAssign() { toggle("assignBar", false); pendingVal = null; }
document.querySelectorAll("#assignBar [data-assign]").forEach(b =>
  b.addEventListener("click", () => {
    if (!pendingVal) return;
    if (b.dataset.assign === "type") current.type = zen2han(pendingVal).toUpperCase();
    if (b.dataset.assign === "vin") current.vin = zen2han(pendingVal).toUpperCase();
    hideAssign(); showResult(current, { fromScan: false });
  }));
$("abClose").addEventListener("click", hideAssign);

/* メンテナンス諸元 [{k,v}] を表形式で表示 */
function renderSpecs(specs) {
  const dl = $("specList"); dl.innerHTML = "";
  if (!specs.length) { toggle("secSpec", false); return; }
  specs.forEach(s => {
    const dt = document.createElement("dt"); dt.textContent = s.k;
    const dd = document.createElement("dd"); dd.textContent = s.v;
    dl.append(dt, dd);
  });
  toggle("secSpec", true);
}

function fillList(id, arr, chk) {
  const ul = $(id); ul.innerHTML = "";
  arr.forEach(t => { const li = document.createElement("li"); if (chk) li.className = "chk"; li.textContent = t; ul.appendChild(li); });
}

/* =========================================================
   スキャン履歴 (型式/車台番号/日時のみ。所有者情報は保存しない)
   ========================================================= */
function getHistory() {
  try { return JSON.parse(localStorage.getItem(LS.hist)) || []; } catch (e) { return []; }
}
function addHistory(d) {
  const hist = getHistory();
  const last = hist[0];
  if (last && last.type === d.type && last.vin === d.vin) return; // 直前と同一なら追加しない
  hist.unshift({
    id: Date.now(), type: d.type || null, vin: d.vin || null,
    expiry: d.expiry ? d.expiry.getTime() : null,
    firstReg: d.firstReg || null, kataShitei: d.kataShitei || null,
    at: new Date().toISOString(),
  });
  localStorage.setItem(LS.hist, JSON.stringify(hist.slice(0, 200)));
  renderHistory();
}
function renderHistory() {
  const hist = getHistory();
  const box = $("histList"); box.innerHTML = "";
  if (!hist.length) { box.innerHTML = '<div class="empty">履歴はまだありません。<br>車検証をスキャンするとここに記録されます。</div>'; return; }
  hist.forEach(h => {
    const div = document.createElement("div"); div.className = "histItem";
    const main = document.createElement("div"); main.className = "hMain";
    const dt = new Date(h.at);
    main.innerHTML = '<div class="hType">' + esc(h.type || "型式不明") + '</div>' +
      '<div class="hSub">' + esc(h.vin || "車台番号なし") + " ・ " +
      dt.getFullYear() + "/" + String(dt.getMonth()+1).padStart(2,"0") + "/" + String(dt.getDate()).padStart(2,"0") +
      " " + String(dt.getHours()).padStart(2,"0") + ":" + String(dt.getMinutes()).padStart(2,"0") + "</div>";
    main.addEventListener("click", () => {
      showResult({
        type: h.type, vin: h.vin, plate: null,
        expiry: h.expiry ? new Date(h.expiry) : null,
        firstReg: h.firstReg || null, kataShitei: h.kataShitei || null,
        raw: [h.type, h.vin].filter(Boolean),
      }, { fromScan: false });
    });
    const del = document.createElement("button"); del.className = "hDel"; del.textContent = "削除";
    del.addEventListener("click", () => {
      localStorage.setItem(LS.hist, JSON.stringify(getHistory().filter(x => x.id !== h.id)));
      renderHistory();
    });
    div.append(main, del); box.appendChild(div);
  });
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* =========================================================
   DB編集
   ========================================================= */
let editingId = null; // null=新規, string=カスタムid, "builtin:<name>"=内蔵を複製編集

function renderDBList() {
  const box = $("dbList"); box.innerHTML = "";
  const customNames = new Set(CUSTOM_DB.map(v => v.name));
  const rows = [
    ...CUSTOM_DB.map(v => ({ v, custom: true })),
    ...BUILTIN_DB.filter(v => !customNames.has(v.name)).map(v => ({ v, custom: false })),
  ];
  if (!rows.length) { box.innerHTML = '<div class="empty">車種が登録されていません。</div>'; return; }
  rows.forEach(({ v, custom }) => {
    const div = document.createElement("div"); div.className = "dbItem";
    div.innerHTML = '<div class="dRow"><div class="dName">' + esc(v.name) +
      '<small>' + esc(v.match) + '</small></div>' +
      '<span class="dTag ' + (custom ? 'custom">カスタム' : 'builtin">内蔵') + '</span></div>';
    const btns = document.createElement("div"); btns.className = "dBtns";
    const be = document.createElement("button"); be.className = "btn btn-ghost btn-sm"; be.textContent = custom ? "編集" : "複製して編集";
    be.addEventListener("click", () => openDBForm(v, custom));
    btns.appendChild(be);
    if (custom) {
      const bd = document.createElement("button"); bd.className = "btn btn-alert btn-sm"; bd.textContent = "削除";
      bd.addEventListener("click", () => {
        if (!confirm("「" + v.name + "」を削除しますか？")) return;
        CUSTOM_DB = CUSTOM_DB.filter(x => x.id !== v.id); saveCustomDB(); renderDBList();
      });
      btns.appendChild(bd);
    }
    div.appendChild(btns); box.appendChild(div);
  });
}
function openDBForm(v, isCustom) {
  editingId = v ? (isCustom ? v.id : null) : null;
  toggle("dbOcrStatus", false); toggle("dbOcrResult", false); $("dbOcrText").value = "";
  setText("dbFormTitle", v ? (isCustom ? "車種を編集" : "内蔵車種を複製編集") : "車種を追加");
  $("dbfName").value = v ? v.name : "";
  $("dbfMatch").value = v ? v.match : "";
  $("dbfMaker").value = v ? (v.maker || "other") : "isuzu";
  $("dbfFaults").value = v ? (v.faults || []).join("\n") : "";
  $("dbfSpecs").value = v ? (v.specs || []).map(s => s.k + ": " + s.v).join("\n") : "";
  $("dbfNotes").value = v ? (v.notes || "") : "";
  toggle("dbFormSec", true);
  $("dbFormSec").scrollIntoView({ behavior: "smooth" });
}
$("btnDbAdd").addEventListener("click", () => openDBForm(null, false));
$("btnDbCancel").addEventListener("click", () => toggle("dbFormSec", false));

/* ---- DBフォーム: 写真OCR読み取り (整備書・諸元表・コーションプレート) ---- */
const dbOcrIn = $("dbOcrIn");
$("btnDbOcr").addEventListener("click", () => dbOcrIn.click());
dbOcrIn.addEventListener("change", e => {
  const f = e.target.files[0]; dbOcrIn.value = "";
  if (f) dbFormOcr(f);
});
document.addEventListener("paste", e => {
  if (!document.getElementById("view-db").classList.contains("active")) return;
  if ($("dbFormSec").classList.contains("hidden")) return;
  const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith("image/"));
  if (item) { e.preventDefault(); dbFormOcr(item.getAsFile()); }
});
async function dbFormOcr(file) {
  toggle("dbOcrStatus", true); toggle("dbOcrResult", false);
  $("dbOcrStatus").textContent = "Tesseract OCR で解析中…(初回は少し時間がかかります)";
  try {
    const text = await ocrTesseract(file, "dbOcrStatus");
    const lines = cleanupOcrLines(text);
    if (!lines.length) { $("dbOcrStatus").textContent = "文字を読み取れませんでした。明るい場所で、文字部分が大きく写るように撮影してください。"; return; }
    $("dbOcrText").value = lines.join("\n");
    toggle("dbOcrResult", true);
    $("dbOcrStatus").textContent = "✓ " + lines.length + "行を読み取りました。不要な行を消して「→ 諸元に追記」等で反映してください。";
  } catch (err) {
    $("dbOcrStatus").textContent = "OCRエラー: " + (err.message || err);
  }
}
/* OCR結果の整形: ノイズ行を除去し、諸元らしい行は「項目: 値」に寄せる */
function cleanupOcrLines(text) {
  return zen2han(text).split(/\n+/)
    .map(l => l.replace(/\s+/g, " ").trim())
    .filter(l => l.length >= 2 && /[぀-ヿ㐀-鿿A-Za-z0-9]/.test(l))
    .map(l => {
      if (/[:：]/.test(l)) return l;
      // 「エンジンオイル 13L」のような行 → 数値・単位の手前にコロン挿入
      const m = l.match(/^(.{2,14}?)\s+([0-9.,〜~\-]+\s*(?:L|ML|KG|N・?M|NM|KM|V|A|W|MM|CC|度|本|個)\b.*)$/i);
      return m ? m[1] + ": " + m[2] : l;
    });
}
function appendLines(fieldId, textareaVal) {
  const cur = $(fieldId).value.trim();
  $(fieldId).value = (cur ? cur + "\n" : "") + textareaVal.trim();
}
$("btnDbOcrToSpecs").addEventListener("click", () => { if ($("dbOcrText").value.trim()) appendLines("dbfSpecs", $("dbOcrText").value); });
$("btnDbOcrToFaults").addEventListener("click", () => { if ($("dbOcrText").value.trim()) appendLines("dbfFaults", $("dbOcrText").value); });
$("btnDbOcrToNotes").addEventListener("click", () => { if ($("dbOcrText").value.trim()) appendLines("dbfNotes", $("dbOcrText").value); });
$("btnDbSave").addEventListener("click", () => {
  const name = $("dbfName").value.trim();
  const match = $("dbfMatch").value.trim();
  if (!name || !match) { alert("車種名と型式マッチ正規表現は必須です。"); return; }
  try { new RegExp(match); } catch (e) { alert("正規表現が不正です: " + e.message); return; }
  const lines = id => $(id).value.split("\n").map(s => s.trim()).filter(Boolean);
  const rec = {
    id: editingId || ("c" + Date.now()),
    name, match, maker: $("dbfMaker").value,
    faults: lines("dbfFaults"),
    specs: lines("dbfSpecs").map(l => {
      const i = l.search(/[:：]/);
      return i > 0 ? { k: l.slice(0, i).trim(), v: l.slice(i + 1).trim() } : { k: l, v: "" };
    }).filter(s => s.k),
    notes: $("dbfNotes").value.trim(),
  };
  const i = CUSTOM_DB.findIndex(x => x.id === rec.id);
  if (i >= 0) CUSTOM_DB[i] = rec; else CUSTOM_DB.unshift(rec);
  saveCustomDB(); toggle("dbFormSec", false); renderDBList();
});

/* エクスポート / インポート */
$("btnDbExport").addEventListener("click", () => {
  const data = { version: 1, exportedAt: new Date().toISOString(), vehicles: mergedDB() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "vehicles-" + new Date().toISOString().slice(0, 10) + ".json";
  a.click(); URL.revokeObjectURL(a.href);
});
$("btnDbImport").addEventListener("click", () => $("dbImportIn").click());
$("dbImportIn").addEventListener("change", async e => {
  const file = e.target.files[0]; if (!file) return;
  e.target.value = "";
  try {
    const j = JSON.parse(await file.text());
    const list = j.vehicles || (Array.isArray(j) ? j : null);
    if (!list) throw new Error("vehicles配列が見つかりません");
    let n = 0;
    for (const v of list) {
      if (!v.name || !v.match) continue;
      try { new RegExp(v.match); } catch (err) { continue; }
      const rec = { id: v.id || ("c" + Date.now() + "_" + n), name: v.name, match: v.match,
        maker: v.maker || "other", faults: v.faults || [],
        specs: Array.isArray(v.specs) ? v.specs.filter(s => s && s.k) : [], notes: v.notes || "" };
      const i = CUSTOM_DB.findIndex(x => x.name === rec.name);
      if (i >= 0) CUSTOM_DB[i] = { ...rec, id: CUSTOM_DB[i].id }; else CUSTOM_DB.push(rec);
      n++;
    }
    saveCustomDB(); renderDBList();
    alert(n + " 件の車種をインポートしました（カスタムDBに保存）。");
  } catch (err) { alert("インポート失敗: " + err.message); }
});

/* =========================================================
   設定
   ========================================================= */
$("btnClearHist").addEventListener("click", () => {
  if (confirm("スキャン履歴をすべて削除しますか？")) { localStorage.removeItem(LS.hist); renderHistory(); }
});
$("btnClearCustom").addEventListener("click", () => {
  if (confirm("カスタム車種DBをすべて削除しますか？（内蔵DBは残ります）")) { CUSTOM_DB = []; saveCustomDB(); renderDBList(); }
});

/* =========================================================
   故障診断 (ダイアグコード検索 + 問診キーワード解析)
   ========================================================= */
let DTC_DB = { codes: [], fallback: [] };
let SYMPTOM_DB = [];
let GUIDE_DB = [];

async function loadDiagDB() {
  try { DTC_DB = await (await fetch("db/dtc.json")).json(); } catch (e) {}
  try { SYMPTOM_DB = (await (await fetch("db/symptoms.json")).json()).symptoms || []; } catch (e) {}
  try { GUIDE_DB = (await (await fetch("db/guides.json")).json()).guides || []; } catch (e) {}
}

/* DTCコード/症状に対応する点検手引書を探す */
function findGuidesForCode(code) {
  return GUIDE_DB.filter(g => (g.codes || []).some(p => code.startsWith(p)));
}
function findGuidesForSymptom(s) {
  const hay = s.name + " " + (s.kw || []).join(" ");
  return GUIDE_DB.filter(g => (g.kw || []).some(k => hay.includes(k)));
}

/* 手引書を折りたたみ(details)で生成 */
function guideDetails(g) {
  const det = document.createElement("details"); det.className = "guide";
  const sum = document.createElement("summary");
  sum.textContent = "📖 点検手引書: " + g.title;
  det.appendChild(sum);
  const body = document.createElement("div"); body.className = "guide-body";

  const addPart = (label, el) => {
    const h = document.createElement("div"); h.className = "guide-h"; h.textContent = label;
    body.append(h, el);
  };
  if ((g.tools || []).length) {
    const p = document.createElement("div"); p.className = "guide-tools"; p.textContent = g.tools.join(" / ");
    addPart("準備する物", p);
  }
  if ((g.steps || []).length) {
    const ol = document.createElement("ol"); ol.className = "guide-steps";
    g.steps.forEach(s => { const li = document.createElement("li"); li.textContent = s; ol.appendChild(li); });
    addPart("点検手順（この順序で）", ol);
  }
  if ((g.judge || []).length) addPart("判定の目安", ulFlat(g.judge, true));
  if ((g.cautions || []).length) {
    const ul = ulFlat(g.cautions, false); ul.classList.add("guide-caution");
    addPart("⚠ 注意", ul);
  }
  det.appendChild(body);
  return det;
}

/* テキストからDTCコードを抽出 (P0401, P0401-00, ｐ０４０１ 等に対応) */
function extractDTCs(text) {
  const norm = zen2han(text).toUpperCase()
    .replace(/[PCBU]\s*([0-9A-FO]{4})/g, (m, d) => m[0] + d) // "P 0401"対策
    .replace(/([PCBU])([O])/g, "$10"); // OCRのO→0誤読(先頭桁)
  const found = norm.match(/\b[PCBU][0-9][0-9A-F]{3}\b/g) || [];
  return [...new Set(found)];
}

function lookupDTC(code) {
  const hit = DTC_DB.codes.find(c => c.code.split(",").map(s => s.trim()).includes(code) || c.code === code);
  if (hit) return { ...hit, code, exact: true };
  // 基幹コード参照 (P0301-P0312 → P0300 / P0202-08 → P0201 / C0205等 → C0200)
  const base = DTC_DB.codes.find(c =>
    (code >= "P0301" && code <= "P0312" && c.code === "P0300") ||
    (code >= "P0202" && code <= "P0208" && c.code === "P0201") ||
    (/^C02(05|10|15)$/.test(code) && c.code === "C0200"));
  if (base) return { ...base, code, exact: true, baseNote: "（" + base.code.split(" ")[0].split(",")[0] + " 系列）" };
  // 系統フォールバック
  const fb = (DTC_DB.fallback || []).filter(f => code.startsWith(f.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
  return { code, exact: false, name: fb ? "系統: " + fb.sys : "不明なコード", causes: [], checks: ["車種別資料・FAINESで正式定義を確認", "下の検索リンクで事例を調査"] };
}

/* 問診テキストを症状辞書と照合 */
function matchSymptoms(text) {
  const results = [];
  for (const s of SYMPTOM_DB) {
    const hits = s.kw.filter(k => text.includes(k));
    if (hits.length) results.push({ ...s, hits, score: hits.length });
  }
  return results.sort((a, b) => b.score - a.score);
}

/* スキャン済み車両の持病と問診の突き合わせ */
function matchVehicleFaults(text, dtcs) {
  if (!current.type) return null;
  const code = current.type.includes("-") ? current.type.split("-")[1] : current.type;
  const v = findVehicle(code);
  if (!v) return null;
  const tokens = text.split(/[\s、。,．・\n]+/).filter(t => t.length >= 2);
  const matched = (v.faults || []).filter(f => tokens.some(t => f.includes(t)));
  return { vehicle: v, matched, all: v.faults || [] };
}

function runDiag() {
  const text = $("diagText").value.trim();
  if (!text) { $("diagResults").innerHTML = '<div class="empty">コードまたは症状を入力してください。</div>'; return; }
  const dtcs = extractDTCs(text);
  const symptoms = matchSymptoms(text);
  const vf = matchVehicleFaults(text, dtcs);
  renderDiagResults(dtcs, symptoms, vf, text);
}
function updateDiagVehicleHint() {
  $("diagVehicleHint").textContent = current.type
    ? "🚚 スキャン済み車両: " + current.type + " — 検索リンクと持病照合に反映されます"
    : "車検証をスキャンしておくと、車種固有の持病との照合・型式付き事例検索ができます";
}
$("btnDiagRun").addEventListener("click", runDiag);
$("btnDiagClear").addEventListener("click", () => { $("diagText").value = ""; $("diagResults").innerHTML = ""; toggle("diagOcrStatus", false); });

function diagSection(tagClass, tagText, title) {
  const sec = document.createElement("section");
  const h2 = document.createElement("h2");
  const tag = document.createElement("span"); tag.className = "tag" + (tagClass ? " " + tagClass : ""); tag.textContent = tagText;
  h2.append(tag, title);
  const body = document.createElement("div"); body.className = "sec-body";
  sec.append(h2, body);
  return { sec, body };
}
function ulFlat(items, chk) {
  const ul = document.createElement("ul"); ul.className = "flat";
  items.forEach(t => { const li = document.createElement("li"); if (chk) li.className = "chk"; li.textContent = t; ul.appendChild(li); });
  return ul;
}
function searchLink(q, label) {
  const a = document.createElement("a"); a.className = "linkbtn";
  a.href = "https://www.google.com/search?q=" + encodeURIComponent(q);
  a.target = "_blank"; a.rel = "noopener";
  a.append(label);
  const arr = document.createElement("span"); arr.className = "arr"; arr.textContent = "↗";
  a.appendChild(arr);
  return a;
}

function renderDiagResults(dtcs, symptoms, vf, text) {
  const box = $("diagResults"); box.innerHTML = "";
  const typeQ = current.type ? current.type + " " : "";

  if (!dtcs.length && !symptoms.length) {
    box.innerHTML = '<div class="empty">該当するコード・症状が見つかりませんでした。<br>症状は「白煙」「異音」「始動不良」のような言葉を含めると拾いやすくなります。</div>';
    return;
  }

  // DTC結果
  for (const code of dtcs) {
    const d = lookupDTC(code);
    const { sec, body } = diagSection("al", code, d.name + (d.baseNote || ""));
    if (d.causes && d.causes.length) {
      const h = document.createElement("div"); h.className = "hint"; h.textContent = "考えられる原因:";
      body.append(h, ulFlat(d.causes, false));
    }
    if (d.checks && d.checks.length) {
      const h = document.createElement("div"); h.className = "hint"; h.style.marginTop = "10px"; h.textContent = "確認手順:";
      body.append(h, ulFlat(d.checks, true));
    }
    findGuidesForCode(code).forEach(g => body.appendChild(guideDetails(g)));
    sec.appendChild(searchLink(typeQ + code + " 原因 修理", "「" + (typeQ ? current.type + "＋" : "") + code + "」で事例検索"));
    box.appendChild(sec);
  }

  // 問診マッチ結果
  for (const s of symptoms.slice(0, 5)) {
    const { sec, body } = diagSection("cy", "症状", s.name + "（キーワード: " + s.hits.join("・") + "）");
    if (s.causes.length) {
      const h = document.createElement("div"); h.className = "hint"; h.textContent = "考えられる原因:";
      body.append(h, ulFlat(s.causes, false));
    }
    if (s.checks.length) {
      const h = document.createElement("div"); h.className = "hint"; h.style.marginTop = "10px"; h.textContent = "切り分け・確認:";
      body.append(h, ulFlat(s.checks, true));
    }
    findGuidesForSymptom(s).forEach(g => body.appendChild(guideDetails(g)));
    if (current.type) sec.appendChild(searchLink(current.type + " " + s.hits[0] + " 原因", "「" + current.type + "＋" + s.hits[0] + "」で事例検索"));
    box.appendChild(sec);
  }

  // 車種固有の持病との突き合わせ
  if (vf && vf.all.length) {
    const { sec, body } = diagSection("", "車種", vf.vehicle.name + " の持病と照合");
    if (vf.matched.length) {
      const h = document.createElement("div"); h.className = "hint"; h.textContent = "⚠ 問診内容と一致する持病:";
      body.append(h, ulFlat(vf.matched, false));
    } else {
      const h = document.createElement("div"); h.className = "hint"; h.textContent = "直接一致なし。参考: この車種の定番故障:";
      body.append(h, ulFlat(vf.all, false));
    }
    box.appendChild(sec);
  }
  box.scrollIntoView({ behavior: "smooth" });
}

/* =========================================================
   AI相談 (Gemini API 無料枠 / 任意設定)
   ========================================================= */
const GEMINI_MODELS = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"];

function renderGeminiStat() {
  const has = !!localStorage.getItem(LS.gemini);
  $("geminiStat").textContent = has
    ? "✓ 設定済み — 診断タブで「🤖 AIに相談」が使えます。空欄で保存すると解除。"
    : "未設定 — キーはこの端末のみに保存され、Google以外には送信されません。";
}
$("btnGeminiSave").addEventListener("click", () => {
  const v = $("geminiKey").value.trim();
  if (v) localStorage.setItem(LS.gemini, v); else localStorage.removeItem(LS.gemini);
  $("geminiKey").value = "";
  renderGeminiStat();
});

async function geminiAsk(prompt) {
  const key = localStorage.getItem(LS.gemini);
  let lastErr = null;
  for (const model of GEMINI_MODELS) {
    try {
      const genCfg = { temperature: 0.3, maxOutputTokens: 8192 };
      // 2.5系は内部思考が出力トークンを消費して本文が途切れるため思考を抑制
      if (model.startsWith("gemini-2.5")) genCfg.thinkingConfig = { thinkingBudget: 0 };
      const res = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + encodeURIComponent(key),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: genCfg
          })
        });
      if (res.status === 404) { lastErr = new Error(model + " は利用不可"); continue; }
      if (res.status === 429) throw new Error("無料枠の利用上限に達しました。少し待ってから再試行してください。");
      if (res.status === 400 || res.status === 403) throw new Error("APIキーが無効です。設定タブでキーを確認してください。");
      if (!res.ok) throw new Error("AI応答エラー (" + res.status + ")");
      const j = await res.json();
      const cand = j.candidates?.[0];
      const text = cand?.content?.parts?.map(p => p.text || "").join("") || "";
      if (!text) throw new Error("AIから回答が得られませんでした");
      return { text, truncated: cand?.finishReason === "MAX_TOKENS" };
    } catch (e) {
      if (e.message && (e.message.includes("上限") || e.message.includes("キーが無効"))) throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error("AIに接続できませんでした(要ネット接続)");
}

function buildDiagPrompt(text) {
  const lines = [
    "あなたは日本の自動車整備士を支援するベテラン診断アドバイザーです。",
    "以下の情報から原因を診断してください。前置き・免責・挨拶は一切不要。Markdown記号(**、#、表)は使わず、必ず次の出力形式に従うこと:",
    "",
    "■原因候補（可能性が高い順）",
    "1. 原因名（一言で）",
    "切り分け: 確認方法。使用工具と測定値の目安を含める。1〜2文で簡潔に。",
    "2. （同様に最大5つまで）",
    "",
    "■最初の1手",
    "現場で最初にやるべきことを1〜2文で。",
    ""
  ];
  if (current.type) {
    const code = current.type.includes("-") ? current.type.split("-")[1] : current.type;
    const v = findVehicle(code);
    lines.push("\n■車両: 型式 " + current.type + (v ? "（" + v.name + "）" : ""));
    if (v && (v.faults || []).length) lines.push("この車種の既知の持病: " + v.faults.join(" / "));
  }
  const dtcs = extractDTCs(text);
  if (dtcs.length) {
    const named = dtcs.map(c => { const d = lookupDTC(c); return c + (d.exact ? "（" + d.name + "）" : ""); });
    lines.push("■診断機のDTC: " + named.join(", "));
  }
  lines.push("■症状・問診内容: " + text);
  return lines.join("\n");
}

/* AI回答テキストを構造化して見やすく描画 */
function renderAiAnswer(container, text) {
  container.innerHTML = "";
  // Markdown記号の残骸を除去
  const clean = text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/^#+\s*/gm, "").replace(/^\s*[\*\-]\s+/gm, "・");
  const lines = clean.split(/\n/).map(l => l.trim()).filter(Boolean);
  let list = null;
  const flushList = () => { list = null; };
  for (const line of lines) {
    // 見出し (■〜 / 【〜】)
    const h = line.match(/^[■【]\s*(.+?)[】]?$/);
    if (h) {
      flushList();
      const el = document.createElement("div");
      el.className = "ai-h"; el.textContent = h[1];
      container.appendChild(el);
      continue;
    }
    // 番号付き項目 → バッジ付きリスト
    const n = line.match(/^(\d+)[.)、]\s*(.+)$/);
    if (n) {
      if (!list) { list = document.createElement("ol"); list.className = "guide-steps ai-list"; container.appendChild(list); }
      const li = document.createElement("li");
      const div = document.createElement("div");
      const t = document.createElement("div"); t.className = "ai-cause"; t.textContent = n[2];
      div.appendChild(t);
      li.appendChild(div);
      list.appendChild(li);
      continue;
    }
    // 「切り分け:」行 → 直前の項目にぶら下げてハイライト
    const k = line.match(/^[・]?\s*(切り分け|確認|点検方法)\s*[:：]\s*(.+)$/);
    if (k && list && list.lastElementChild) {
      const d = document.createElement("div");
      d.className = "ai-check";
      const label = document.createElement("span"); label.className = "ai-check-label"; label.textContent = "切り分け ";
      d.append(label, k[2]);
      list.lastElementChild.firstElementChild.appendChild(d);
      continue;
    }
    // 箇条書き・通常文
    flushList();
    const p = document.createElement("div");
    p.className = "ai-p"; p.textContent = line;
    container.appendChild(p);
  }
}

$("btnDiagAI").addEventListener("click", async () => {
  const text = $("diagText").value.trim();
  if (!text) { alert("コードまたは症状を入力してから「AIに相談」を押してください。"); return; }
  if (!localStorage.getItem(LS.gemini)) {
    alert("AI相談には無料のGemini APIキーの設定が必要です。\n\n設定タブ →「AI相談機能」の手順でキーを取得・保存してください(クレジットカード不要)。");
    switchView("settings");
    return;
  }
  const box = $("diagResults");
  const { sec, body } = diagSection("", "AI", "AIの見解");
  const p = document.createElement("div");
  p.className = "ai-answer"; p.textContent = "🤖 AIが考えています…";
  body.appendChild(p);
  box.prepend(sec);
  const btn = $("btnDiagAI"); btn.disabled = true;
  try {
    const r = await geminiAsk(buildDiagPrompt(text));
    renderAiAnswer(p, r.text);
    const note = document.createElement("div");
    note.className = "hint"; note.style.marginTop = "10px";
    note.textContent = (r.truncated ? "⚠ 回答が長すぎて一部省略されました。症状を絞って再度相談してください。 " : "")
      + "※ AIの回答は参考情報です。必ず実測・実点検で裏取りしてください。";
    body.appendChild(note);
  } catch (e) {
    p.textContent = "⚠ " + (e.message || "AIへの接続に失敗しました");
  } finally {
    btn.disabled = false;
  }
});

/* ---- 診断機画面のOCR読み取り（撮影 / 画像ペースト） ---- */
const diagOcrIn = $("diagOcrIn");
$("btnDiagOcr").addEventListener("click", () => diagOcrIn.click());
diagOcrIn.addEventListener("change", e => {
  const f = e.target.files[0]; diagOcrIn.value = "";
  if (f) diagOcrImage(f);
});
document.addEventListener("paste", e => {
  if (!document.getElementById("view-diag").classList.contains("active")) return;
  const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith("image/"));
  if (item) { e.preventDefault(); diagOcrImage(item.getAsFile()); }
});
async function diagOcrImage(file) {
  toggle("diagOcrStatus", true);
  $("diagOcrStatus").textContent = "Tesseract OCR で解析中…(初回は少し時間がかかります)";
  try {
    const text = await ocrTesseractDiag(file);
    const codes = extractDTCs(text);
    if (codes.length) {
      const cur = $("diagText").value.trim();
      $("diagText").value = (cur ? cur + "\n" : "") + codes.join(" ");
      $("diagOcrStatus").textContent = "✓ " + codes.length + "件のコードを検出: " + codes.join(", ");
      runDiag();
    } else {
      $("diagOcrStatus").textContent = "コードを検出できませんでした。コード表示部分が大きく写るように撮影し直すか、コードを直接入力してください。";
    }
  } catch (err) {
    $("diagOcrStatus").textContent = "OCRエラー: " + (err.message || err);
  }
}
async function ocrTesseractDiag(file) {
  await loadTesseract();
  const worker = await Tesseract.createWorker("eng", 1, {  // DTCは英数字のためengが高精度
    logger: m => {
      if (m.status === "recognizing text")
        $("diagOcrStatus").textContent = "文字認識中… " + Math.round(m.progress * 100) + "%";
    }
  });
  const { data } = await worker.recognize(file);
  await worker.terminate();
  return data.text || "";
}

/* =========================================================
   タブ切替・初期化
   ========================================================= */
function switchView(name) {
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === "view-" + name));
  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("active", b.dataset.view === name));
  if (name === "diag") updateDiagVehicleHint();
}
document.querySelectorAll("#tabs button").forEach(b =>
  b.addEventListener("click", () => switchView(b.dataset.view)));

(async function init() {
  loadCustomDB();
  await Promise.all([loadBuiltinDB(), loadDiagDB()]);
  renderHistory();
  renderDBList();
  renderGeminiStat();
  setText("verNote", "車検証スキャン整備サポート v" + APP_VER + " ／ 内蔵DB " + BUILTIN_DB.length + "車種 ＋ カスタム " + CUSTOM_DB.length + "車種。データはすべてこの端末内に保存されます。");
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
