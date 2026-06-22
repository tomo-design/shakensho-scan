"use strict";
/* =========================================================
   車検証スキャン 整備サポート v1.0
   - QR読取(jsQR) + 国交省二次元コード仕様パーサ
   - 車両ノウハウDB(db/vehicles.json + localStorageカスタム)
   - スキャン履歴 / DB編集 / OCRフォールバック
   ========================================================= */

const APP_VER = "1.0.0";
const LS = { hist: "ss_history", custom: "ss_customdb", gemini: "ss_geminikey", aimode: "ss_aimode" };

const $ = id => document.getElementById(id);
const toggle = (id, show) => $(id).classList.toggle("hidden", !show);
const setText = (id, t) => { $(id).textContent = t; };
/* ボタンの処理中表示: メカ君アイコンを回しつつ「考え中…」に。完了でsetBtnLoading(btn,false) */
function setBtnLoading(btn, on, label) {
  if (!btn) return;
  if (on) {
    if (!btn.dataset.orig) btn.dataset.orig = btn.innerHTML;
    btn.disabled = true; btn.classList.add("btnLoading");
    btn.innerHTML = '<img src="img/thinking.png" class="btnMecha spin" alt="">' + (label || "メカ君が考え中…");
  } else {
    btn.disabled = false; btn.classList.remove("btnLoading");
    if (btn.dataset.orig) { btn.innerHTML = btn.dataset.orig; delete btn.dataset.orig; }
  }
}

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
  if (localStorage.getItem("ss_dbcleared") === "1") { BUILTIN_DB = []; return; }
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
/* 内蔵DBのみ検索(車種名の権威ソース。自動保存したカスタムレコードへの自己ヒットを避ける) */
function findBuiltinVehicle(typeCode) {
  for (const v of BUILTIN_DB) {
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
/* 指定・類別の表示整形: 現行=9桁(5-4)/旧=7桁(5-2)/大型・特装・輸入=記載なし(空) */
function formatKata(k) {
  if (!k) return null;
  const s = String(k).replace(/[^0-9]/g, "");
  if (!s) return null;
  if (s.length >= 8) return s.slice(0, s.length - 4) + "-" + s.slice(s.length - 4); // 型式指定番号-類別区分番号(4桁)
  if (s.length >= 6) return s.slice(0, s.length - 2) + "-" + s.slice(s.length - 2); // 旧車: 類別2桁
  return s;
}

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
    // 二次元コード2 (6フィールド): 登録番号・車台番号・原動機型式
    else if (f.length >= 5 && f.length <= 7) {
      const plateRaw = f[1] || "";
      if (/[぀-ヿ㐀-鿿Ａ-Ｚ０-９]/.test(plateRaw)) out.plate = plateRaw.replace(/[　 ]+/g, " ").trim();
      const vin = zen2han(f[3] || "").toUpperCase();
      if (/^[A-Z0-9\[\]\-]{4,23}$/.test(vin)) out.vin = vin;
      // f[4] = 原動機型式 (位置で確定。空欄/伏字/純数字の帳票種別は除外)
      const eng = zen2han(f[4] || "").toUpperCase().trim();
      if (eng && !eng.startsWith("*") && /^[A-Z0-9\-]{2,10}$/.test(eng) && !/^\d+$/.test(eng)) out.engine = eng;
      out.structured = true;
    }
  }
  return out;
}

/* ---- 従来ヒューリスティック(維持・フォールバック) ----
   exclude: 原動機型式など「型式候補にしてはいけない」値の集合 */
function parseHeuristic(fields, exclude = new Set()) {
  let type = null, vin = null, plate = null;
  for (const f of fields) {
    const u = zen2han(f).toUpperCase();
    if (!vin && /^[A-Z0-9]{2,8}-[0-9]{5,8}$/.test(u)) { vin = u; continue; }
    // ハイフン付き型式(排ガス記号-車種記号)はエンジン型式と紛れないので除外対象外
    if (!type && /^[0-9A-Z]{2,4}-[A-Z][A-Z0-9]{2,8}$/.test(u) && !/^[0-9]+$/.test(u.split("-")[1])) { type = u; continue; }
    if (!type && !exclude.has(u) && /^[A-Z]{1,4}[0-9]{1,3}[A-Z0-9]{0,4}$/.test(u) && u.length <= 9) { type = u; continue; }
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
  // 原動機型式は型式候補から除外(誤って型式欄に入るのを防ぐ)
  const exclude = new Set([s.engine, s.vin].filter(Boolean).map(x => zen2han(x).toUpperCase()));
  const h = parseHeuristic(uniq, exclude);

  return {
    type:     s.type   || h.type   || null,
    vin:      s.vin    || h.vin    || null,
    plate:    s.plate  || h.plate  || null,
    engine:   s.engine || null,
    expiry:   s.expiry || null,
    firstReg: s.firstReg || null,
    kataShitei: s.kataShitei || null,
    structured: !!s.structured,
    raw: uniq,
  };
}

/* ================= スキャン(ライブ/写真) ================= */
const payloads = new Set();
const video = $("video");
const cv = document.createElement("canvas"), ctx = cv.getContext("2d", { willReadFrequently: true });

/* QR解読: ZXing(ピンボケ・低コントラストに強い)優先 → jsQR フォールバック */
let zxReader = null, zxHints = null;
if (typeof ZXing !== "undefined") {
  try {
    zxHints = new Map(); zxHints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    zxReader = new ZXing.QRCodeReader();
  } catch (e) { zxReader = null; }
}
function decodeCanvas(canvas) {
  if (zxReader) {
    try {
      const lum = new ZXing.HTMLCanvasElementLuminanceSource(canvas);
      const bb = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(lum));
      const r = zxReader.decode(bb, zxHints);
      if (r && r.getText()) return r.getText();
    } catch (e) {}
  }
  try {
    const id = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(id.data, canvas.width, canvas.height, { inversionAttempts: "attemptBoth" });
    if (code && code.data) return code.data;
  } catch (e) {}
  return null;
}

/* ===== ライブ連続スキャン: QRと文字(OCR)を同時に自動認識して蓄積 ===== */
let scanComplete = false;   // 直前に車両を確定表示したか(次の開始で新規)
let liveStream = null, scanning = false, scanRaf = null, tickBusy = false, tickN = 0, lastHitAt = 0;

/* 統合アキュムレータ: QR・OCR・手動のどれからでも項目を埋めていく */
function freshAcc() { return { type: null, vin: null, engine: null, plate: null, expiry: null, firstReg: null, kataShitei: null, raw: [] }; }
let acc = freshAcc();
function mergeAcc(d) {
  for (const k of ["type", "vin", "engine", "plate", "expiry", "firstReg", "kataShitei"]) if (!acc[k] && d[k]) acc[k] = d[k];
  if (d.raw) { const s = new Set(acc.raw); d.raw.forEach(x => x && s.add(x)); acc.raw = [...s]; }
}
function accCode3() { return !!(acc.kataShitei || acc.type); } // コード3(指定・類別)を取得済みか
function accComplete() { return !!(acc.vin && acc.engine && acc.plate); } // 限定4項目(指定・類別は無い車もある)
function accResult() { return { ...acc, raw: acc.raw.length ? acc.raw : [acc.type, acc.engine, acc.vin, acc.plate].filter(Boolean), qrRaw: [...payloads] }; }
function resetScan() { payloads.clear(); acc = freshAcc(); scanComplete = false; }

$("btnStart").addEventListener("click", startLiveScan);
$("btnStop").addEventListener("click", () => stopLiveScan(true));
$("btnScanReset").addEventListener("click", () => {
  resetScan();
  updateScanProgress(acc);
  toggle("scanProgress", false); toggle("scanActions", false); toggle("qrPhotoStatus", false);
  if (!scanning) startLiveScan(); else setScanMsg("最初から: QR・型式部分を写してください");
});

let camList = [], camIdx = 0;

async function startLiveScan() {
  if (scanComplete) resetScan();
  const ok = await openCamera(null);
  if (!ok) {
    toggle("qrPhotoStatus", true);
    $("qrPhotoStatus").innerHTML = "カメラを起動できませんでした（権限・対応状況をご確認ください）。<br>下の「写真で1枚ずつ撮影」もお試しください。";
    return;
  }
  toggle("scanWrap", true); toggle("scanCtrls", true); toggle("btnStart", false); toggle("btnStop", true);
  toggle("scanActions", true);
  updateScanProgress(acc);
  setScanMsg("車検証のQR・型式部分にかざしてください（自動で読み取ります）");
  scanning = true; tickBusy = false; tickN = 0; lastOcrAt = 0; scanTick();
}

/* カメラを開く(deviceId指定可)。AF/ズーム/ライト/レンズ一覧を設定 */
async function openCamera(deviceId) {
  if (liveStream) { liveStream.getTracks().forEach(t => t.stop()); liveStream = null; }
  const base = deviceId
    ? { deviceId: { exact: deviceId } }
    : { facingMode: { ideal: "environment" } };
  try {
    liveStream = await navigator.mediaDevices.getUserMedia({ video: { ...base, width: { ideal: 2560 }, height: { ideal: 1440 } } });
  } catch (e) {
    try { liveStream = await navigator.mediaDevices.getUserMedia({ video: base }); }
    catch (e2) { return false; }
  }
  video.srcObject = liveStream; try { await video.play(); } catch (e) {}
  const track = liveStream.getVideoTracks()[0];
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  // 連続AF
  try { if (caps.focusMode && caps.focusMode.includes("continuous")) await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }); } catch (e) {}
  // ズームスライダー(対応端末のみ)
  const zw = $("zoomWrap"), zs = $("zoomSlider");
  if (caps.zoom && caps.zoom.max > (caps.zoom.min || 1)) {
    zs.min = caps.zoom.min || 1; zs.max = caps.zoom.max; zs.step = caps.zoom.step || 0.1;
    const cur = (track.getSettings && track.getSettings().zoom) || caps.zoom.min || 1;
    zs.value = cur; toggle("zoomWrap", true);
  } else toggle("zoomWrap", false);
  // ライト
  toggle("btnTorch", !!caps.torch);
  // 背面レンズ一覧(初回のみ。Samsung等は超広角が近接に強い)
  if (!camList.length) {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const cams = devs.filter(d => d.kind === "videoinput");
      // 内側(フロント)カメラは使わないので除外。ラベルで判別できない場合は全て残す
      const backs = cams.filter(d => !/front|face|user|内|前面|selfie/i.test(d.label || ""));
      camList = backs.length ? backs : cams;
      const cur = track.getSettings ? track.getSettings().deviceId : null;
      const i = camList.findIndex(d => d.deviceId === cur); if (i >= 0) camIdx = i;
    } catch (e) {}
  }
  toggle("btnCamSwitch", camList.length > 1);
  return true;
}

/* カメラ(レンズ)切替: 近接で合わない時は別レンズへ */
$("btnCamSwitch").addEventListener("click", async () => {
  if (camList.length < 2) return;
  camIdx = (camIdx + 1) % camList.length;
  setScanMsg("カメラを切り替えました（" + (camIdx + 1) + "/" + camList.length + "）…ピントを確認");
  const ok = await openCamera(camList[camIdx].deviceId);
  if (!ok) setScanMsg("このカメラは使えませんでした。もう一度切替を");
});

/* ズーム調整 */
$("zoomSlider").addEventListener("input", async () => {
  if (!liveStream) return;
  try { await liveStream.getVideoTracks()[0].applyConstraints({ advanced: [{ zoom: parseFloat($("zoomSlider").value) }] }); } catch (e) {}
});

/* タップでピント合わせ(対応端末) */
video.addEventListener("click", async () => {
  if (!liveStream) return;
  try {
    const track = liveStream.getVideoTracks()[0];
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (caps.focusMode && caps.focusMode.includes("single-shot")) {
      await track.applyConstraints({ advanced: [{ focusMode: "single-shot" }] });
      setScanMsg("ピント調整中…");
      setTimeout(() => {
        if (scanning && caps.focusMode.includes("continuous"))
          track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {});
      }, 1500);
    }
  } catch (e) {}
});

function stopLiveScan(show) {
  scanning = false;
  if (scanRaf) cancelAnimationFrame(scanRaf);
  if (liveStream) { liveStream.getTracks().forEach(t => t.stop()); liveStream = null; }
  toggle("scanWrap", false); toggle("scanCtrls", false); toggle("btnStart", true); toggle("btnStop", false); toggle("btnTorch", false);
  if (show && (acc.type || acc.vin || acc.plate || acc.engine)) { scanComplete = true; showResult(accResult(), { fromScan: true }); }
}
const setScanMsg = t => setText("scanMsg", t);

/* ライト切替 */
$("btnTorch").addEventListener("click", async () => {
  if (!liveStream) return;
  const track = liveStream.getVideoTracks()[0];
  const on = !track.__torch;
  try { await track.applyConstraints({ advanced: [{ torch: on }] }); track.__torch = on; $("btnTorch").style.opacity = on ? "1" : ".55"; } catch (e) {}
});

/* QR検出時 */
function onLiveQr(data) {
  if (!data || payloads.has(data)) return;
  payloads.add(data);
  if (navigator.vibrate) navigator.vibrate(50);
  mergeAcc(parsePayloads(payloads));
  afterScanUpdate("QR");
}
/* 文字(OCR)検出時 */
function onLiveText(d) {
  const before = acc.type + "|" + acc.vin + "|" + acc.engine;
  mergeAcc(d);
  if (acc.type + "|" + acc.vin + "|" + acc.engine !== before) {
    if (navigator.vibrate) navigator.vibrate(40);
    afterScanUpdate("文字");
  }
}
function afterScanUpdate(src) {
  updateScanProgress(acc);
  if (accComplete()) { setScanMsg("✓ 全項目そろいました"); stopLiveScan(true); return; }
  // 車台番号が揃っても指定・類別(コード3)未取得なら継続
  if (acc.vin && !accCode3()) {
    setScanMsg("✓ 車台番号OK。残りは右下の二次元コード3（指定・類別）を写す／完了は✓");
    return;
  }
  const need = [!acc.vin && "車台番号", !acc.engine && "原動機型式", !acc.plate && "登録番号"].filter(Boolean).join("・");
  setScanMsg("✓ " + src + "読取。次は" + (need ? "「" + need + "」" : "二次元コード3（指定・類別）") + "を写してください");
}

async function scanTick() {
  if (!scanning) return;
  if (!tickBusy && video.readyState >= 2 && video.videoWidth) {
    tickBusy = true; tickN++;
    const vw = video.videoWidth, vh = video.videoHeight;
    try {
      // --- QR: ネイティブ + ZXing/jsQR を併用(取りこぼし防止) ---
      if (nativeDetector) {
        try { (await nativeDetector.detect(video)).forEach(c => onLiveQr(c.rawValue)); }
        catch (e) { nativeDetector = null; }
      }
      // 中央70%を実解像度でZXing/jsQR(ネイティブが小QRを取りこぼす対策)
      const s = Math.floor(Math.min(vw, vh) * 0.7);
      cv.width = s; cv.height = s;
      ctx.drawImage(video, (vw - s) >> 1, (vh - s) >> 1, s, s, 0, 0, s, s);
      let t = decodeCanvas(cv);
      if (!t && tickN % 3 === 0) { // 全面も時々
        const cap = 1600, sc = Math.min(1, cap / Math.max(vw, vh));
        const w = Math.round(vw * sc), h = Math.round(vh * sc);
        cv.width = w; cv.height = h; ctx.drawImage(video, 0, 0, w, h);
        t = decodeCanvas(cv);
      }
      if (t) onLiveQr(t);
    } catch (e) {}
    tickBusy = false;
    // --- 文字認識(OCR): 重いので約1.5秒に1回、別スレッドで ---
    if (Date.now() - lastOcrAt > 1500 && !ocrBusy) {
      lastOcrAt = Date.now(); ocrBusy = true;
      const oc = grabOcrFrame(vw, vh);
      getOcrWorker().then(w => w.recognize(oc)).then(({ data }) => {
        if (!scanning) return;
        const d = extractFromOcrText(data.text || "");
        if (d.type || d.vin) onLiveText(d);
      }).catch(() => {}).finally(() => { ocrBusy = false; });
    }
  }
  scanRaf = requestAnimationFrame(scanTick);
}

/* ===== ライブOCR用: フレーム切り出し + 前処理(グレースケール+大津二値化) ===== */
const ocrCv = document.createElement("canvas"), ocrCtx = ocrCv.getContext("2d", { willReadFrequently: true });
let ocrWorker = null, ocrWorkerReady = null, ocrBusy = false, lastOcrAt = 0;

function grabOcrFrame(vw, vh) {
  // 中央の横長帯(型式・車台番号の行が来やすい)を高解像度で取り、前処理して返す
  const sw = Math.floor(vw * 0.92), sh = Math.floor(vh * 0.55);
  const sx = (vw - sw) >> 1, sy = (vh - sh) >> 1;
  const targetW = 1500, sc = targetW / sw;
  ocrCv.width = targetW; ocrCv.height = Math.round(sh * sc);
  ocrCtx.drawImage(video, sx, sy, sw, sh, 0, 0, ocrCv.width, ocrCv.height);
  return preprocessOcr(ocrCv);
}
/* グレースケール + 大津の二値化(印字テキストのOCR精度を上げる) */
function preprocessOcr(srcCanvas) {
  const w = srcCanvas.width, h = srcCanvas.height;
  const id = srcCanvas.getContext("2d").getImageData(0, 0, w, h);
  const g = new Uint8ClampedArray(w * h), hist = new Array(256).fill(0);
  for (let i = 0, j = 0; i < id.data.length; i += 4, j++) {
    const y = (id.data[i] * 0.299 + id.data[i + 1] * 0.587 + id.data[i + 2] * 0.114) | 0;
    g[j] = y; hist[y]++;
  }
  const total = w * h; let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, maxVar = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue; const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
    if (v > maxVar) { maxVar = v; thr = t; }
  }
  const out = document.createElement("canvas"); out.width = w; out.height = h;
  const octx = out.getContext("2d"), oid = octx.createImageData(w, h);
  for (let j = 0, k = 0; j < g.length; j++, k += 4) {
    const v = g[j] > thr ? 255 : 0;
    oid.data[k] = oid.data[k + 1] = oid.data[k + 2] = v; oid.data[k + 3] = 255;
  }
  octx.putImageData(oid, 0, 0);
  return out;
}
function getOcrWorker() {
  if (ocrWorkerReady) return ocrWorkerReady;
  ocrWorkerReady = (async () => {
    await loadTesseract();
    const w = await Tesseract.createWorker("eng", 1); // 型式・車台番号は英数 → engが高精度
    try { await w.setParameters({ tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-", tessedit_pageseg_mode: "6" }); } catch (e) {}
    ocrWorker = w; return w;
  })();
  return ocrWorkerReady;
}

/* 写真フォールバック (カメラ不可端末用。1枚ずつ撮影して蓄積) */
$("qrPhotoIn").addEventListener("change", async e => {
  const file = e.target.files[0]; $("qrPhotoIn").value = "";
  if (!file) return;
  if (scanComplete) resetScan();
  toggle("qrPhotoStatus", true); $("qrPhotoStatus").textContent = "画像を解析中…";
  try {
    const before = payloads.size;
    (await decodePhotoQR(file)).forEach(c => payloads.add(c));
    const added = payloads.size - before;
    mergeAcc(parsePayloads(payloads));
    updateScanProgress(acc); toggle("scanActions", acc.type || acc.vin || acc.plate);
    if (accComplete()) { scanComplete = true; showResult(accResult(), { fromScan: true }); }
    else if (added === 0) $("qrPhotoStatus").innerHTML = "QRを検出できませんでした。1つのQRが<b>画面いっぱい</b>になるまで近づけて撮影してください。";
    else {
      const need = [!acc.type && "型式", !acc.vin && "車台番号"].filter(Boolean).join("・");
      $("qrPhotoStatus").textContent = "✓ " + added + "件読取。続けて" + (need ? "「" + need + "」の" : "別の") + "QRを撮影してください。";
    }
  } catch (err) { $("qrPhotoStatus").textContent = "読み取りエラー: " + (err.message || err); }
});

/* 読み取り済み項目の進捗表示 */
function updateScanProgress(d) {
  const box = $("scanProgress");
  const items = [
    ["車台番号", d.vin], ["原動機型式", d.engine], ["登録番号", d.plate], ["指定・類別", formatKata(d.kataShitei)],
  ];
  box.innerHTML = items.map(([label, val]) =>
    '<div class="progRow ' + (val ? "got" : "") + '">' +
    '<span class="progIco">' + (val ? "✓" : "○") + '</span>' +
    '<span class="progLabel">' + label + '</span>' +
    '<span class="progVal">' + (val ? esc(String(val)) : "未取得") + '</span></div>'
  ).join("");
  toggle("scanProgress", true);
}

function loadImageEl(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => { URL.revokeObjectURL(url); res(im); };
    im.onerror = () => { URL.revokeObjectURL(url); rej(new Error("画像を読み込めませんでした")); };
    im.src = url;
  });
}

/* 1枚の写真からQRを抽出して配列で返す(純関数。グローバルは触らない) */
async function decodePhotoQR(file) {
  const out = new Set();
  // ① ネイティブ検出 (Android Chrome): 1枚で複数QRを一度に取得
  if (nativeDetector) {
    try {
      const bmp = await createImageBitmap(file);
      const codes = await nativeDetector.detect(bmp);
      if (bmp.close) bmp.close();
      codes.forEach(c => { if (c.rawValue) out.add(c.rawValue); });
      if (out.size) return [...out];
    } catch (e) {}
  }
  // ② jsQR (iPhone等): 複数QRが1枚に並ぶと全体スキャンは失敗するため、
  //    タイル分割して各領域を個別に読む
  const img = await loadImageEl(file);
  const W = img.width, H = img.height;
  // スキャン対象領域: 全体 + 3x2のオーバーラップタイル + 左右半分(QRが横一列の車検証向け)
  const regions = [[0, 0, W, H], [0, 0, W / 2, H], [W / 2, 0, W / 2, H]];
  const cols = 3, rows = 2, ov = 0.5;
  const tw = W / cols, th = H / rows;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const sx = Math.max(0, c * tw - tw * ov * 0.5);
    const sy = Math.max(0, r * th - th * ov * 0.5);
    regions.push([sx, sy, Math.min(W - sx, tw * (1 + ov)), Math.min(H - sy, th * (1 + ov))]);
  }
  const cap = 1400;
  for (const [sx, sy, sw, sh] of regions) {
    const sc = Math.min(1, cap / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * sc)), h = Math.max(1, Math.round(sh * sc));
    cv.width = w; cv.height = h;
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
    const t = decodeCanvas(cv);
    if (t) out.add(t);
  }
  return [...out];
}

/* ネイティブQR検出器 (Android Chrome等。jsQRより高速・高精度) */
let nativeDetector = null;
if ("BarcodeDetector" in window) {
  try { nativeDetector = new BarcodeDetector({ formats: ["qr_code"] }); } catch (e) { nativeDetector = null; }
}

/* ===== QR生データをAIに渡して項目分け(端末パーサーで埋まらない時の確実な手段) ===== */
function buildQrParsePrompt(rawList) {
  return [
    "あなたは日本の自動車検査証(車検証)の二次元コード(QRコード)を解析する専門家です。",
    "以下はスマホで読み取った車検証QRコードの生データ(複数のQRを行ごとに記載、フィールドは「/」区切り)です。",
    "車検証の二次元コード仕様(二次元コード2: バージョン/登録番号/標板コード/車台番号/原動機型式/帳票種別。二次元コード3: バージョン/打刻位置/型式指定番号類別区分番号/有効期間満了日(YYMMDD)/初度登録年月(YYMM)/型式/以降に軸重・騒音・燃料種別等)を踏まえ、各データを正しい項目に振り分けてください。",
    "重要(配置ミス防止): kataShitei(型式指定番号・類別区分番号)は『型式指定番号(最大5桁)＋類別区分番号(最大4桁)』を連結した数字で、現行車は9桁・旧車は7桁になる。大型車・特装車・輸入車には存在しない(その場合はnull)。原動機型式や帳票種別の数字をkataShiteiに入れないこと。車台番号は英数字＋ハイフン、原動機型式は短い英数字、登録番号は地名(漢字)を含むことで区別する。各値を取り違えないよう、桁数と文字種で必ず検証すること。",
    "999999や9999は未設定を意味します。日付は西暦に変換(満了日・初度登録年月の下2桁年は20xxと解釈)。",
    "出力は厳密なJSONのみ(前後に文章やコードフェンス不要)。キーは以下、該当データが無ければnull:",
    '{"type":型式, "vin":車台番号, "engine":原動機型式, "plate":登録番号, "kataShitei":型式指定番号類別区分番号(数字のみ連結), "expiry":有効期間満了日(YYYY-MM-DD), "firstRegYear":初度登録の西暦年(数値), "firstRegMonth":初度登録の月(数値), "fuel":燃料種別}',
    "",
    "■QR生データ:",
    ...rawList.map((p, i) => (i + 1) + ": " + p),
  ].join("\n");
}
function extractJson(text) {
  if (!text) return null;
  let t = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}
function applyAiQr(o) {
  const d = {};
  if (o.type) d.type = String(o.type).toUpperCase().trim();
  if (o.vin) d.vin = String(o.vin).toUpperCase().trim();
  if (o.engine) d.engine = String(o.engine).toUpperCase().trim();
  if (o.plate) d.plate = String(o.plate).trim();
  if (o.kataShitei) d.kataShitei = String(o.kataShitei).replace(/[^0-9]/g, "");
  if (o.expiry) { const dt = new Date(o.expiry); if (!isNaN(dt.getTime())) d.expiry = dt; }
  if (o.firstRegYear && o.firstRegMonth) { const y = +o.firstRegYear, m = +o.firstRegMonth; if (y > 1980 && m >= 1 && m <= 12) d.firstReg = { year: y, month: m }; }
  mergeAcc(d);              // 未取得の項目だけ埋める(既存の正しい値は保持)
  showResult(accResult(), { fromScan: true });  // AI補完した指定・類別等も履歴(DB)へ保存
}
$("btnAiQr").addEventListener("click", async () => {
  stopFieldMic();
  if (!localStorage.getItem(LS.gemini)) {
    alert("QRのAI解析には無料のGemini APIキーの設定が必要です（設定タブ）。");
    switchView("settings"); return;
  }
  const raw = (current.qrRaw && current.qrRaw.length) ? current.qrRaw : [...payloads];
  if (!raw.length) { toggle("aiQrStatus", true); $("aiQrStatus").textContent = "QRの生データがありません(QRを読み取ってからお試しください)。"; return; }
  toggle("aiQrStatus", true); $("aiQrStatus").textContent = "🔧 メカ君がQRデータを項目分け中…";
  setBtnLoading($("btnAiQr"), true, "メカ君が解析中…");
  try {
    const r = await geminiAsk(buildQrParsePrompt(raw));
    const obj = extractJson(r.text);
    if (!obj) throw new Error("AIの応答を解釈できませんでした。もう一度お試しください。");
    applyAiQr(obj);
    // AIが何を抽出したかを明示(AI解析の証跡)
    const lines = [];
    if (obj.type) lines.push("型式: " + obj.type);
    if (obj.engine) lines.push("原動機型式: " + obj.engine);
    if (obj.vin) lines.push("車台番号: " + obj.vin);
    if (obj.plate) lines.push("登録番号: " + obj.plate);
    if (obj.kataShitei) lines.push("指定-類別: " + obj.kataShitei);
    if (obj.expiry) lines.push("有効期限: " + obj.expiry);
    if (obj.firstRegYear && obj.firstRegMonth) lines.push("初度登録: " + obj.firstRegYear + "年" + obj.firstRegMonth + "月");
    if (obj.fuel) lines.push("燃料: " + obj.fuel);
    const head = r.model === "cache" ? "🔧 前回のメカ君の解析結果を再利用しました" : "🔧 メカ君がQRを解析しました（" + r.model + "）";
    toggle("aiQrParse", true); toggle("aiQrStatus", true);
    $("aiQrStatus").style.whiteSpace = "pre-wrap";
    $("aiQrStatus").textContent = head + "\n" + (lines.length ? "メカ君が読み取った内容:\n・" + lines.join("\n・") : "QRから抽出できる項目がありませんでした。");
  } catch (e) {
    if (e.message !== "__cancelled__") { toggle("aiQrParse", true); toggle("aiQrStatus", true); $("aiQrStatus").textContent = "⚠ " + (e.message || e); }
  } finally {
    setBtnLoading($("btnAiQr"), false);
  }
});

/* ---- 手動入力 (複数項目) ---- */
$("btnManual").addEventListener("click", () => {
  const uc = id => $(id).value.trim().toUpperCase();
  const type = uc("manualType"), engine = uc("manualEngine"), vin = uc("manualVin");
  const plate = $("manualPlate").value.trim();
  const user = $("manualUser").value.trim();
  if (!type && !vin && !plate && !engine) { alert("いずれか1項目以上を入力してください。"); return; }
  const d = { type: type || null, engine: engine || null, vin: vin || null, plate: plate || null,
    raw: [type, engine, vin, plate].filter(Boolean) };
  showResult(d, { fromScan: true });
  if (user) saveUserName(user);
  setText("rUser", user || "—");
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
    if (scanComplete) resetScan();
    const text = await ocrTesseract(file);
    const d = extractFromOcrText(text);
    mergeAcc({ type: d.type, vin: d.vin, raw: d.rawCandidates });
    if (acc.type || acc.vin) {
      $("ocrStatus").innerHTML = "✓ OCR完了。<b>" + (acc.type || "型式未検出") + "</b> / " + (acc.vin || "車台番号未検出") + " — 誤りがあればRAWチップから修正してください。";
      scanComplete = true;
      showResult(accResult(), { fromScan: true });
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
/* OCR入口: 高精度OCR(Cloud Vision)がON+キー設定済みならVision、無ければ無料Tesseract */
function visionEnabled() { return localStorage.getItem("ss_usevision") === "1" && !!localStorage.getItem("ss_visionkey"); }
async function ocrCloudVision(file) {
  const key = localStorage.getItem("ss_visionkey");
  if (!key) throw new Error("Cloud Vision APIキー未設定");
  const data = await fileToBase64(file);
  const res = await fetch("https://vision.googleapis.com/v1/images:annotate?key=" + encodeURIComponent(key), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requests: [{ image: { content: data }, features: [{ type: "DOCUMENT_TEXT_DETECTION" }] }] })
  });
  if (!res.ok) throw new Error("Cloud Vision APIエラー (" + res.status + ")");
  const j = await res.json();
  const r = j.responses && j.responses[0];
  if (r && r.error) throw new Error(r.error.message || "Cloud Visionエラー");
  return (r && r.fullTextAnnotation && r.fullTextAnnotation.text) || "";
}
async function ocrTesseract(file, statusId = "ocrStatus") {
  if (visionEnabled()) {
    try {
      if ($(statusId)) $(statusId).textContent = "高精度OCR（Cloud Vision）で解析中…";
      const t = await ocrCloudVision(file);
      if (t) return t;
    } catch (e) {
      if ($(statusId)) $(statusId).textContent = "Cloud Vision失敗→無料OCRに切替（" + (e.message || e) + "）…";
    }
  }
  await loadTesseract();
  // 前処理: 拡大+二値化で印字の認識精度を上げる
  let target = file;
  try {
    const img = await loadImageEl(file);
    const tw = Math.min(2200, Math.max(1400, img.width)), sc = tw / img.width;
    const tmp = document.createElement("canvas"); tmp.width = tw; tmp.height = Math.round(img.height * sc);
    tmp.getContext("2d").drawImage(img, 0, 0, tmp.width, tmp.height);
    target = preprocessOcr(tmp);
  } catch (e) {}
  const worker = await Tesseract.createWorker("jpn", 1, {
    logger: m => {
      if (m.status === "recognizing text" && $(statusId))
        $(statusId).textContent = "文字認識中… " + Math.round(m.progress * 100) + "%";
    }
  });
  const { data } = await worker.recognize(target);
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

/* フォールバック手段の表示切替 (普段はリンクのみ) */
function foldEntryAreas() { toggle("ocrArea", false); toggle("manualArea", false); toggle("plateArea", false); }
$("lnkShowManual").addEventListener("click", () => { foldEntryAreas(); toggle("manualArea", true); $("manualType").focus(); });
$("lnkShowPlate").addEventListener("click", () => { foldEntryAreas(); toggle("plateArea", true); renderPlateSearch(); });

/* ナンバー検索 (使用者名でも引ける・部分一致) */
function renderPlateSearch() {
  const q = normPlate($("plateSearch").value);
  const qRaw = $("plateSearch").value.trim();
  const box = $("plateResults"); box.innerHTML = "";
  const hist = getHistory().filter(h => h.plate || h.name);
  if (!hist.length) { box.innerHTML = '<div class="empty">保存済みの車両がまだありません。<br>スキャンするとナンバーが自動保存されます。</div>'; return; }
  const matches = (q || qRaw)
    ? hist.filter(h => (h.plate && normPlate(h.plate).includes(q)) || (h.name && qRaw && h.name.includes(qRaw)))
    : hist.slice(0, 10);
  if (!matches.length) { box.innerHTML = '<div class="empty">一致する車両がありません。</div>'; return; }
  matches.slice(0, 20).forEach(h => {
    const div = document.createElement("div"); div.className = "histItem";
    const main = document.createElement("div"); main.className = "hMain";
    main.innerHTML = '<div class="hType">' + esc(h.plate || "ナンバー未登録") + (h.name ? ' <span style="font-weight:400">／ ' + esc(h.name) + '</span>' : '') + '</div>' +
      '<div class="hSub">' + esc(h.type || "型式不明") + " ・ " + esc(h.vin || "車台番号なし") + '</div>';
    main.addEventListener("click", () => { foldEntryAreas(); showResult(histToResult(h), { fromScan: false }); });
    div.appendChild(main); box.appendChild(div);
  });
}
$("plateSearch").addEventListener("input", renderPlateSearch);

/* ===== 車両データを直接修正(VEHICLE IDENTIFICATION) ===== */
function pad2(n) { return String(n).padStart(2, "0"); }
$("lnkFixRead").addEventListener("click", () => {
  $("vidType").value = current.type || "";
  $("vidEngine").value = current.engine || "";
  $("vidVin").value = current.vin || "";
  $("vidPlate").value = current.plate || "";
  $("vidUser").value = (findHistEntry(getHistory(), current) || {}).name || "";
  $("vidFirstReg").value = current.firstReg ? current.firstReg.year + "-" + pad2(current.firstReg.month) : "";
  $("vidExpiry").value = current.expiry ? current.expiry.getFullYear() + "-" + pad2(current.expiry.getMonth() + 1) + "-" + pad2(current.expiry.getDate()) : "";
  $("vidKata").value = current.kataShitei || "";
  toggle("vidEdit", true); $("vidEdit").scrollIntoView({ behavior: "smooth" });
});
$("btnVidCancel").addEventListener("click", () => toggle("vidEdit", false));
$("lnkRawChips").addEventListener("click", () => { toggle("secRaw", true); $("secRaw").scrollIntoView({ behavior: "smooth" }); });
$("btnVidSave").addEventListener("click", () => {
  const uc = id => $(id).value.trim().toUpperCase();
  current.type = uc("vidType") || null;
  current.engine = uc("vidEngine") || null;
  current.vin = uc("vidVin") || null;
  current.plate = $("vidPlate").value.trim() || null;
  current.kataShitei = $("vidKata").value.replace(/[^0-9]/g, "") || null;
  const fr = $("vidFirstReg").value;  // YYYY-MM
  current.firstReg = /^\d{4}-\d{2}$/.test(fr) ? { year: +fr.slice(0, 4), month: +fr.slice(5, 7) } : null;
  const ex = $("vidExpiry").value;    // YYYY-MM-DD
  current.expiry = /^\d{4}-\d{2}-\d{2}$/.test(ex) ? new Date(+ex.slice(0, 4), +ex.slice(5, 7) - 1, +ex.slice(8, 10)) : null;
  // accにも反映
  if (typeof acc !== "undefined") ["type", "engine", "vin", "plate", "kataShitei", "firstReg", "expiry"].forEach(k => acc[k] = current[k]);
  const user = $("vidUser").value.trim();
  toggle("vidEdit", false);
  showResult(current, { fromScan: true });   // 再描画＋履歴に統合保存(自動保存)
  if (user) { saveUserName(user); setText("rUser", user || "—"); }
  registerVehicleToDB();   // 保存と同時にDBの登録車種へ追加/更新
});

/* 「保存（DBに登録）」: 現在の車両をカスタムDB(登録車種一覧)へ追加/更新 */
function escRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function vinPrefix(v) { return v ? (v.includes("-") ? v.split("-")[0] : v) : null; }
const VALID_MAKERS = new Set([...Object.keys(MAKER_RECALL), "other"]);
function registerVehicleToDB(opt = {}) {
  const d = current;
  if (!d || (!d.vin && !d.type && !d.plate)) { return false; }
  const histE = findHistEntry(getHistory(), d) || {};
  const learned = getLearned(vehicleKey(d)) || {};
  const user = histE.name || null;
  // 型式マッチ = 車台番号のハイフンより前の英数字(例: FW74HZ-510123 → FW74HZ)
  const prefixRaw = vinPrefix(d.vin);
  const prefix = prefixRaw ? prefixRaw.toUpperCase().replace(/[^A-Z0-9]/g, "") : null;
  // 車種名 = 車台番号(先頭)から内蔵DB検索した車種名 > メンテAIで取得した車種名 > 代替
  // ※自分が保存したカスタムレコードに自己ヒットしないよう内蔵DBのみを検索
  const found = prefix ? findBuiltinVehicle(prefix) : null;
  const aiModel = histE.model || learned.model || null;
  const name = (found && found.name) || aiModel || user || d.plate || d.vin || d.type || "無名車両";
  const match = prefix
    || (d.type ? escRegex(String(d.type.includes("-") ? d.type.split("-")[1] : d.type).toUpperCase()) : (d.kataShitei || escRegex(name)));
  // メーカー = DB一致のメーカー > AI推定メーカー(有効なキーのみ) > 既存 > other
  const aiMaker = histE.maker || learned.maker || null;
  const maker = (found && found.maker) || (VALID_MAKERS.has(aiMaker) ? aiMaker : null) || null;
  const specs = (histE.specs && histE.specs.length ? histE.specs : learned.specs) || [];
  const faults = (histE.faults && histE.faults.length ? histE.faults : learned.faults) || [];
  // 同一車両は upsert(車台番号で特定。無ければ型式/登録番号)
  let rec = (d.vin && CUSTOM_DB.find(x => x.vin && x.vin === d.vin))
    || CUSTOM_DB.find(x => x.name === name && x.match === match);
  const isNew = !rec;
  if (isNew) { rec = { id: "c" + Date.now(), maker: "other" }; CUSTOM_DB.unshift(rec); }
  Object.assign(rec, {
    name, match, maker: maker || rec.maker || "other",
    vin: d.vin || rec.vin || null, engine: d.engine || rec.engine || null,
    plate: d.plate || rec.plate || null, kataShitei: d.kataShitei || rec.kataShitei || null,
    user: user || rec.user || null,
    faults: faults.length ? faults : (rec.faults || []),
    specs: specs.length ? specs : (rec.specs || []),
    notes: rec.notes || "",
  });
  saveCustomDB();
  if (window.Cloud) window.Cloud.pushVehicle(rec);   // 社内共有へ
  try { renderDBList(); } catch (e) {}
  if (!opt.silent) {
    const msg = $("vidSavedMsg");
    if (msg) { msg.textContent = "✓ DBの登録車種に" + (isNew ? "追加" : "更新保存") + "しました（「" + name + "」）。DB編集タブで確認できます。"; toggle("vidSavedMsg", true); }
  }
  return true;
}
$("btnVidRegister").addEventListener("click", () => registerVehicleToDB());

/* 認識後の行き先選択(メンテ/診断/部品交換は独立ページ) */
function goVehiclePage(name) {
  switchView(name);
  window.scrollTo(0, 0);
  if (name === "maint") {
    // 諸元が無い車両のときだけ自動でAI解析(保存済み/内蔵データがあればAIを使わない=消費節約)
    if (localStorage.getItem(LS.gemini) && shownSpecs.length === 0 && !$("specAiBox").textContent.trim()) $("btnSpecAI").click();
  }
  // 診断・部品はタブを開いた時点では入力欄にフォーカスしない(自動でキーボードが出るのを防ぐ)
}
$("btnGoMaint").addEventListener("click", () => goVehiclePage("maint"));
$("btnGoDiag").addEventListener("click", () => goVehiclePage("diag"));
$("btnGoParts").addEventListener("click", () => goVehiclePage("parts"));
/* 全ページ共通ナビ(← 車両 / メンテ / 診断 / 部品) */
document.querySelectorAll(".pageNav .navBtn").forEach(b =>
  b.addEventListener("click", () => {
    const go = b.dataset.go;
    if (go === "scan") switchView("scan"); else goVehiclePage(go);
  }));

/* ===== 部品交換手順: AI + 動画リンク ===== */
function buildPartsPrompt(part) {
  const v = current.type ? findVehicle(current.type.includes("-") ? current.type.split("-")[1] : current.type) : null;
  return [
    "あなたは日本の自動車整備士を支援するベテランメカニックです。次の部品の交換手順を、現場で使える形で説明してください。",
    "前置き・免責・挨拶は不要。Markdown記号(**, #, 表)は使わず、必ず次の形式で:",
    "■準備する工具・部品",
    "必要な工具と新品部品・消耗品(ガスケット等)を列挙。",
    "■交換手順",
    "1. 手順(安全確保→取り外し→取り付け→確認の順で具体的に)",
    "2. (以降番号順に)",
    "■締付トルク・規定値",
    "関連する締付トルクや規定値があれば(確信が持てない値は「要確認」を付ける)。",
    "■電子制御・特別手順",
    "この作業に電子制御の操作が必要な場合は必ず具体的に記す。例: 電動パーキングブレーキ(EPB)搭載車のリアブレーキ交換は『メンテナンスモード/整備モード』への移行と解除が必要(車種ごとの入り方を簡潔に)。ワイパー交換はサービスポジション(整備位置)への移し方。SAS/ステアリング角・バッテリー登録・DPF再生等が絡む場合もその旨。該当しなければ『特になし』。",
    "■純正部品の参考価格",
    "この部品の純正(OEM)新品のおおよその価格を日本円で(例: 約8,000〜12,000円・要確認)。分からなければ「要確認」と記す。",
    "■注意点",
    "事故・破損を防ぐ注意を1〜3行。最後に必ず『正確な手順・規定値は整備書(FAINES等)で確認してください』と記す。",
    "",
    "■対象車両: 型式 " + (current.type || "不明") + (current.engine ? " / 原動機 " + current.engine : "") + (v ? "（" + v.name + "）" : ""),
    "■交換する部品: " + part,
  ].join("\n");
}
function renderPartsVideoLinks(part) {
  const box = $("partsLinks"); box.innerHTML = "";
  const v = current.type ? findVehicle(current.type.includes("-") ? current.type.split("-")[1] : current.type) : null;
  const carName = v ? v.name : (current.type || "");
  const q = (carName + " " + part + " 交換 方法").trim();
  const links = [
    ["▶ YouTubeで交換動画を探す", "https://www.youtube.com/results?search_query=" + encodeURIComponent(q)],
    ["🔍 交換手順をWebで検索", "https://www.google.com/search?q=" + encodeURIComponent(q)],
  ];
  links.forEach(([label, url]) => {
    const a = document.createElement("a"); a.className = "linkbtn"; a.href = url; a.target = "_blank"; a.rel = "noopener";
    a.append(label);
    const arr = document.createElement("span"); arr.className = "arr"; arr.textContent = "↗"; a.appendChild(arr);
    box.appendChild(a);
  });
}
let partsBusy = false;
$("btnPartsGo").addEventListener("click", async () => {
  stopFieldMic();
  const part = $("partName").value.trim();
  if (!part) { $("partName").focus(); return; }
  renderPartsVideoLinks(part);   // 動画リンクは即出す(AIキー無しでも使える)
  if (!localStorage.getItem(LS.gemini)) {
    toggle("partsResult", true);
    $("partsResult").textContent = "AI手順を使うには設定タブで無料Geminiキーを設定してください（動画リンクはそのまま使えます）。";
    return;
  }
  if (partsBusy) return; partsBusy = true;
  const box = $("partsResult"); toggle("partsResult", true);
  box.textContent = "メカ君が交換手順を調べています…";
  setBtnLoading($("btnPartsGo"), true, "メカ君が調べ中…");
  try {
    const r = await geminiAsk(buildPartsPrompt(part));
    renderAiAnswer(box, r.text);
  } catch (e) {
    if (e.message !== "__cancelled__") box.textContent = "⚠ " + (e.message || "AIへの接続に失敗しました");
  } finally {
    partsBusy = false; setBtnLoading($("btnPartsGo"), false);
  }
});
$("btnPartsClear").addEventListener("click", () => {
  cancelAI();
  $("partName").value = "";
  $("partsResult").innerHTML = ""; toggle("partsResult", false);
  $("partsLinks").innerHTML = "";
});

/* この車両について質問(AI Q&A) */
let vehAskBusy = false;
$("btnVehClear").addEventListener("click", () => {
  cancelAI();
  $("qVehText").value = "";
  $("qVehResult").innerHTML = ""; toggle("qVehResult", false);
});
$("btnVehAsk").addEventListener("click", async () => {
  stopFieldMic();
  const q = $("qVehText").value.trim();
  if (!q) { $("qVehText").focus(); return; }
  if (!localStorage.getItem(LS.gemini)) {
    alert("質問するには設定タブで無料のGemini APIキーを設定してください。");
    switchView("settings"); return;
  }
  if (vehAskBusy) return; vehAskBusy = true;
  const box = $("qVehResult"); toggle("qVehResult", true);
  box.textContent = "🔧 メカ君が考えています…";
  const btn = $("btnVehAsk"); setBtnLoading(btn, true, "メカ君が考え中…");
  try {
    const prompt = [
      "あなたは『メカ君』。まじめで頼れるロボ整備士(一人称ボク)で、どこかおちゃめな愛嬌もある。次の車両について整備士の質問に正確かつ実務的に答え、説明は親しみやすく(軽い一言を添えてもよいが控えめに)。",
      "確信が持てない点は「（要確認）」を付け、年式・グレードで差がある場合は明記。前置き・免責不要。Markdown記号(**、#、表)は使わず、見出しは■、箇条書きは・で。",
      "■対象車両: " + vehicleDesc(),
      "■質問: " + q,
    ].join("\n");
    const r = await geminiAsk(prompt);
    renderAiAnswer(box, r.text);
  } catch (e) {
    if (e.message !== "__cancelled__") box.textContent = "⚠ " + (e.message || "AIへの接続に失敗しました");
  } finally {
    vehAskBusy = false; setBtnLoading(btn, false);
  }
});

function showResult(d, opt = {}) {
  current = d;
  if (typeof scanning !== "undefined" && scanning) stopLiveScan(false);
  switchView("scan");
  toggle("result", true);
  // 毎回まず「何をしますか？」の選択に戻す
  toggle("choicePanel", true); toggle("vidEdit", false); toggle("secRaw", false); toggle("vidSavedMsg", false);
  toggle("mechaHero", false);   // 車両表示中はメカ君ヒーローを隠す
  // フォールバックUI・スキャン進捗は畳む。次の撮影は新しい車両として開始
  foldEntryAreas();
  toggle("scanProgress", false); toggle("scanActions", false); toggle("qrPhotoStatus", false);
  scanComplete = true;
  // 保存済みの使用者名を表示
  const histEntry = findHistEntry(getHistory(), d);
  setText("rUser", (histEntry && histEntry.name) || "—");
  // QR生データがあり、未取得項目があればAI解析ボタンを出す
  current.qrRaw = d.qrRaw && d.qrRaw.length ? d.qrRaw : (current.qrRaw || []);
  // 限定表示項目: 車台番号 / 原動機型式 / 登録番号 / 指定・類別 / 使用者
  const missing = !d.engine || !d.plate || !d.kataShitei;
  toggle("aiQrParse", current.qrRaw.length > 0 && missing);
  toggle("aiQrStatus", false);
  setText("rEngine", d.engine || "—");
  setText("rVin", d.vin || "未検出");
  setText("rPlate", d.plate || "—");
  setText("rKata", formatKata(d.kataShitei) || "記載なし");

  // DB照合: 型式のハイフン以降(無ければ全体)
  let hit = null;
  if (d.type) {
    const code = (d.type.includes("-") ? d.type.split("-")[1] : d.type).toUpperCase();
    hit = findVehicle(code);
  }
  // 車台番号で登録済みカスタムレコードも照合(型式が無い/一致しない車両のため)
  if (d.vin) {
    const byVin = CUSTOM_DB.find(x => x.vin && x.vin === d.vin);
    if (byVin && (!hit || hit !== byVin)) hit = byVin;
  }
  const histEntry2 = findHistEntry(getHistory(), d);
  const learned = getLearned(vehicleKey(d));
  // DB(カスタム=ユーザーが直接編集できる正データ)を最優先。無ければ学習/履歴
  const dbFaults = (hit && hit.faults) || [];
  const learnedFaults = (histEntry2 && histEntry2.faults) || (learned && learned.faults) || [];
  const allFaults = dbFaults.length
    ? [...dbFaults, ...learnedFaults.filter(f => !dbFaults.includes(f))]
    : learnedFaults;

  const m = $("rMatch");
  if (hit) {
    m.textContent = "⚙ 車種DB一致: " + hit.name;
    if (hit.notes) { setText("notesBody", hit.notes); toggle("secNotes", true); } else toggle("secNotes", false);
  } else {
    m.textContent = "";   // 「未登録」表記は出さない(代わりに修正/保存ボタンを設置)
    toggle("secNotes", false);
  }
  renderFaultList(allFaults); toggle("secFault", allFaults.length > 0);
  // 諸元: DB(編集可能) ＞ 車両レコード ＞ 学習(型式) の優先で表示
  const recSpecs = (hit && hit.specs && hit.specs.length) ? hit.specs
    : (histEntry2 && histEntry2.specs) || (learned && learned.specs) || null;
  if (recSpecs && recSpecs.length) renderSpecs(recSpecs, (hit && hit.specs && hit.specs.length) ? "db" : "learned");
  else renderSpecs([], "");

  // リコール: DB(カスタム) ＞ 履歴/学習
  const recalls = (hit && hit.recalls && hit.recalls.length ? hit.recalls : null) || (histEntry2 && histEntry2.recalls) || (learned && learned.recalls) || [];
  renderRecalls(recalls);
  const mk = hit ? MAKER_RECALL[hit.maker] : null;
  toggle("secRecall", !!mk || recalls.length > 0 || !!d.vin);
  toggle("lnkMaker", !!mk);
  if (mk) {
    $("lnkMlit").href = MLIT_RECALL;
    const lm = $("lnkMaker");
    lm.firstChild.textContent = mk.label; lm.href = mk.url;
  }
  $("lnkGoogle").href = "https://www.google.com/search?q=" + encodeURIComponent((d.type || d.vin || "") + " リコール 改善対策");
  renderRecallVin(d.type, d.vin);   // 型式(車台番号から特定)と車台番号をそれぞれコピー

  // RAWチップ (「手動で修正する」リンクから開く。読取データが無ければリンク自体を隠す)
  const wrap = $("rawChips"); wrap.innerHTML = "";
  (d.raw || []).forEach(f => {
    const c = document.createElement("div"); c.className = "chip"; c.textContent = f;
    c.addEventListener("click", () => showAssign(f)); wrap.appendChild(c);
  });
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
    const k = b.dataset.assign;
    const uc = zen2han(pendingVal).toUpperCase().trim();
    if (k === "type") current.type = uc;
    else if (k === "engine") current.engine = uc;
    else if (k === "vin") current.vin = uc;
    else if (k === "plate") current.plate = pendingVal.trim();              // 登録番号は大文字化しない(漢字含む)
    else if (k === "kataShitei") current.kataShitei = uc.replace(/[^0-9]/g, "");
    else if (k === "firstReg") {                                            // YYMM / YYYY年M月 等を解釈
      const m = uc.replace(/[^0-9]/g, "");
      if (m.length === 4) current.firstReg = parseYYMM(m);
      else if (m.length === 6) current.firstReg = { year: +m.slice(0, 4), month: +m.slice(4, 6) };
    } else if (k === "expiry") {
      const m = uc.replace(/[^0-9]/g, "");
      if (m.length === 6) current.expiry = parseYYMMDD(m);
      else if (m.length === 8) current.expiry = new Date(+m.slice(0, 4), +m.slice(4, 6) - 1, +m.slice(6, 8));
    }
    // accにも反映(上書き)してQR解析ボタンの状態と整合
    if (typeof acc !== "undefined") acc[k] = current[k];
    hideAssign(); showResult(current, { fromScan: true });  // 割り当てた値も履歴(DB)へ保存
  }));
$("abClose").addEventListener("click", hideAssign);

/* メンテナンス諸元 [{k,v}] を表形式で表示 */
let shownSpecs = [];        // 現在表示中の諸元(訂正の初期値に使う)
function renderSpecs(specs, source) {
  shownSpecs = normalizeSpecs(specs || []);   // 固まった値は項目ごとに自動分解して表示
  const dl = $("specList"); dl.innerHTML = "";
  toggle("specAiBox", false); $("specAiBox").innerHTML = "";  // 車両が変わったらAI結果をリセット
  toggle("specEditBox", false);
  shownSpecs.forEach(s => {
    const item = document.createElement("div"); item.className = "specItem";
    const k = document.createElement("div"); k.className = "specK"; k.textContent = s.k;
    const v = document.createElement("div"); v.className = "specV"; v.textContent = s.v;
    item.append(k, v); dl.appendChild(item);
  });
  toggle("specList", shownSpecs.length > 0);
  // 出所ラベル
  const lbl = source === "learned" ? "✓ 訂正保存済みのデータ（この端末に記憶）"
    : source === "db" ? "内蔵データ（参考値）" : "";
  setText("specSource", lbl); toggle("specSource", !!lbl);
  // 訂正ボタンは車両を識別できれば常に出す(保存先キーになる)
  const vk = vehicleKey(current);
  toggle("btnSpecEdit", !!vk);
  // AIで調べるボタンは「保存済み or 内蔵データが無い」時だけ表示
  toggle("btnSpecAI", shownSpecs.length === 0 && !!vk);
  // 最新に更新ボタンは、諸元が既にある時に表示(再取得して都度DB更新)
  toggle("btnSpecReload", shownSpecs.length > 0 && !!vk);
  // 内蔵データが無くても車両を識別できればセクションは出す
  toggle("secSpec", shownSpecs.length > 0 || !!vk);
}

/* 車両識別キー: 型式 > 指定・類別 > 車台番号 の順(型式を読まなくても記憶できる) */
function vehicleKey(d) {
  d = d || current;
  if (d.type) return d.type.toUpperCase();
  if (d.kataShitei) return "K:" + String(d.kataShitei).replace(/[^0-9]/g, "");
  if (d.vin) return "V:" + d.vin.toUpperCase();
  return null;
}
/* 学習データ(localStorage)。1キーに諸元(specs)と定番故障/持病(faults)をまとめて記憶し次回はAI不要 */
function getLearned(key) {
  if (!key) return null;
  try { return (JSON.parse(localStorage.getItem("ss_learnedspecs") || "{}"))[key] || null; } catch (e) { return null; }
}
function setLearned(key, patch) {
  if (!key) return;
  try {
    const c = JSON.parse(localStorage.getItem("ss_learnedspecs") || "{}");
    c[key] = Object.assign({}, c[key], patch, { key, at: new Date().toISOString() });
    localStorage.setItem("ss_learnedspecs", JSON.stringify(c));
  } catch (e) {}
}
function getLearnedSpecs(d) { const e = getLearned(vehicleKey(d)); return (e && e.specs) || null; }
/* AIで取得した諸元・故障を車両レコード(履歴=DB)へ自動保存(車台番号で同一車両を特定) */
function saveVehicleAiData(specs, faults, recalls, extra) {
  const hist = getHistory();
  let e = findHistEntry(hist, current);
  if (!e) { addHistory(current); e = findHistEntry(getHistory(), current); if (!e) return; }
  const h2 = getHistory();
  const t = findHistEntry(h2, current); if (!t) return;
  if (specs && specs.length) t.specs = specs;
  if (faults && faults.length) t.faults = faults;
  if (recalls && recalls.length) t.recalls = recalls;
  if (extra && extra.model) t.model = extra.model;
  if (extra && extra.maker) t.maker = extra.maker;
  t.aiAt = new Date().toISOString();
  localStorage.setItem(LS.hist, JSON.stringify(h2));
  if (window.Cloud) window.Cloud.pushRecord(t);   // 諸元・故障も社内共有へ
}
function specsToText(specs) { return (specs || []).map(s => s.k + ": " + s.v).join("\n"); }
function textToSpecs(text) {
  return (text || "").split(/\n+/).map(l => l.trim()).filter(Boolean).map(l => {
    const i = l.search(/[:：]/);
    return i > 0 ? { k: l.slice(0, i).trim(), v: l.slice(i + 1).trim() } : { k: l, v: "" };
  }).filter(s => s.k);
}
/* 諸元テキスト → [{k,v}] 抽出。改行が無く「項目: 値。項目: 値。」の文章でも分割できる */
let lastSpecAiText = "";
function splitSpecText(text) {
  let t = " " + (text || "").replace(/```/g, "").replace(/[■【][^。\n]*[】]?/g, " ");
  t = t.replace(/その他[^:：。\n]*[:：]/g, " ");   // 「その他…追加:」等のノイズを除去
  // 「。」「・」「番号.」「改行」の直後に来る『短いラベル:』の前で改行(値の途中の。では切らない)
  t = t.replace(/([。\n・]|\d+[.)、]\s)\s*(?=[^\s:：。、，)）]{2,16}[:：])/g, "$1\n");
  return t.split(/\n+/)
    .map(s => s.replace(/^[\s。・]+/, "").replace(/^\d+[.)、]\s*/, "").trim())
    .filter(Boolean)
    .map(seg => {
      const i = seg.search(/[:：]/); if (i <= 0) return null;
      const k = seg.slice(0, i).trim();
      const v = seg.slice(i + 1).trim().replace(/[。\s]+$/, "");
      return (k && v && k.length <= 16) ? { k, v } : null;
    })
    .filter(Boolean);
}
const aiTextToSpecs = splitSpecText;
/* 1項目に固まった値を項目ごとに分解(壊れた保存データの表示・編集を救済) */
function normalizeSpecs(specs) {
  const out = [];
  (specs || []).forEach(s => {
    // 値に複数の「ラベル:」が含まれる＝固まったデータ → 分解
    const merged = splitSpecText(s.k + ": " + s.v);
    if (merged.length > 1) out.push(...merged);
    else out.push({ k: s.k, v: s.v });
  });
  // 同名項目は先勝ちで重複排除
  const seen = new Set();
  return out.filter(s => { const key = s.k; if (seen.has(key)) return false; seen.add(key); return true; });
}

/* 項目ごとの訂正フォーム(行ごとに 項目名／値) */
function addSpecRow(k, v) {
  const row = document.createElement("div"); row.className = "specEditRow";
  const ik = document.createElement("input"); ik.type = "text"; ik.className = "seK"; ik.placeholder = "項目"; ik.value = k || "";
  const iv = document.createElement("input"); iv.type = "text"; iv.className = "seV"; iv.placeholder = "値"; iv.value = v || "";
  const del = document.createElement("button"); del.type = "button"; del.className = "seDel"; del.textContent = "×";
  del.addEventListener("click", () => row.remove());
  row.append(ik, iv, del);
  $("specEditRows").appendChild(row);
}
function collectSpecRows() {
  const out = [];
  $("specEditRows").querySelectorAll(".specEditRow").forEach(r => {
    const k = r.querySelector(".seK").value.trim(), v = r.querySelector(".seV").value.trim();
    if (k) out.push({ k, v });
  });
  return out;
}
$("btnSpecEdit").addEventListener("click", () => {
  const init = shownSpecs.length ? shownSpecs : aiTextToSpecs(lastSpecAiText);
  $("specEditRows").innerHTML = "";
  (init.length ? init : [{ k: "", v: "" }]).forEach(s => addSpecRow(s.k, s.v));
  toggle("specEditBox", true);
});
$("btnSpecAddRow").addEventListener("click", () => addSpecRow("", ""));
$("btnSpecEditCancel").addEventListener("click", () => toggle("specEditBox", false));
$("btnSpecSave").addEventListener("click", () => {
  const vk = vehicleKey(current);
  if (!vk) { alert("車両を識別できないため保存できません(車台番号や指定・類別が必要です)。"); return; }
  const specs = collectSpecRows();
  if (!specs.length) { alert("1件以上入力してください。"); return; }
  setLearned(vk, { specs });
  saveVehicleAiData(specs, null);
  registerVehicleToDB({ silent: true });   // 訂正した諸元をDB登録車種にも反映(更新)
  renderSpecs(specs, "learned");
  toggle("specEditBox", false);
});

function fillList(id, arr, chk) {
  const ul = $(id); ul.innerHTML = "";
  arr.forEach(t => { const li = document.createElement("li"); if (chk) li.className = "chk"; li.textContent = t; ul.appendChild(li); });
}
/* 修理タブへ移動して部品名/症状で手順検索 */
function gotoRepair(term) {
  switchView("parts"); window.scrollTo(0, 0);
  const inp = $("partName"); inp.value = term;
  $("btnPartsGo").click();
}
/* 故障/原因の文からAIで交換部品名を特定 → 修理タブの部品名へ挿入して検索 */
async function gotoRepairFromText(rawText, kind) {
  switchView("parts"); window.scrollTo(0, 0);
  const inp = $("partName");
  let part = rawText;
  if (localStorage.getItem(LS.gemini)) {
    inp.value = "🔧 部品を特定中…";
    try {
      const lead = kind === "fault"
        ? "次の自動車の定番故障・不具合から、修理で交換する主要な部品名を1つだけ、日本語の部品名のみ短く答えてください(説明・記号・句読点なし)。\n不具合: "
        : "次の自動車の故障原因から、交換・修理対象となる主要な部品名を1つだけ、日本語の部品名のみ短く答えてください(説明・記号・句読点なし)。\n原因: ";
      const r = await geminiAsk(lead + rawText);
      const p = (r.text || "").split(/\n/)[0].replace(/[「」『』。、・*#:：\-]/g, "").trim();
      if (p) part = p.slice(0, 40);
    } catch (e) {}
  }
  inp.value = part;
  $("btnPartsGo").click();
}
/* 原因候補をタップ→修理タブの「点検手順」にAIで詳しい点検方法を表示 */
async function gotoInspection(text) {
  switchView("parts"); window.scrollTo(0, 0);
  toggle("secInspect", true);
  setText("inspectTarget", "点検対象: " + text);
  const box = $("inspectResult"); box.textContent = "🔧 メカ君が点検手順を調べています…(数秒〜十数秒)";
  $("secInspect").scrollIntoView({ behavior: "smooth" });
  if (!localStorage.getItem(LS.gemini)) {
    box.textContent = "点検手順のAI調査には設定タブで無料Geminiキーが必要です。"; return;
  }
  try {
    const prompt = [
      "あなたは日本の自動車整備士を支援するベテラン整備士『メカ君』です。次の故障原因について、現場での点検方法を、経験の浅い整備士にも分かるよう具体的に説明してください。",
      "前置き・免責不要。Markdown記号(**、#、表)は使わず、必ず次の形式で:",
      "■準備する工具・計測器",
      "必要な工具・テスター等を列挙。",
      "■点検手順",
      "1. どこを どの工具で どう測る/見るか。判定の目安となる数値・状態を必ず添える。",
      "2.（番号順に具体的に。安全確保→分解/アクセス→計測→判定の順）",
      "■判定の目安",
      "正常値・異常値の境目を具体的に。",
      "■次のアクション",
      "点検結果に応じた次の一手を1〜2行。",
      "",
      "■対象車両: " + vehicleDesc(),
      "■点検する原因: " + text,
    ].join("\n");
    const r = await geminiAsk(prompt);
    renderAiAnswer(box, r.text);
  } catch (e) {
    if (e.message !== "__cancelled__") box.textContent = "⚠ " + (e.message || "AIへの接続に失敗しました");
  }
}
/* 定番故障・持病の一覧(タップ機能なし) */
function renderFaultList(faults) {
  const ul = $("faultList"); ul.innerHTML = "";
  (faults || []).forEach(t => {
    const li = document.createElement("li"); li.textContent = t;
    ul.appendChild(li);
  });
}
/* AIが調べたリコール・改善対策の一覧を描画(参考情報の注記付き) */
function renderRecalls(recalls) {
  recalls = recalls || [];
  fillList("recallList", recalls, false);
  toggle("recallList", recalls.length > 0);
  toggle("recallNote", recalls.length > 0);
}
/* リコール確認用: 車台番号をハイフン前/後で別々にコピー＋各々別タブでサイトを開く */
function copyText(t) {
  try { navigator.clipboard.writeText(t); } catch (e) {
    const ta = document.createElement("textarea"); ta.value = t; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (e2) {} ta.remove();
  }
}
/* 車台番号→型式 のキャッシュ＆AI特定 */
function getCachedKata(vin) { try { return JSON.parse(localStorage.getItem("ss_katacache") || "{}")[vinPrefix(vin).toUpperCase()] || null; } catch (e) { return null; } }
function setCachedKata(vin, k) { try { const c = JSON.parse(localStorage.getItem("ss_katacache") || "{}"); c[vinPrefix(vin).toUpperCase()] = k; localStorage.setItem("ss_katacache", JSON.stringify(c)); } catch (e) {} }
async function resolveKatashiki(type, vin) {
  if (type && type.includes("-")) return type;          // 読み取った完全形の型式があればそれ
  if (!vin) return type || "";
  const cached = getCachedKata(vin); if (cached) return cached;
  if (!localStorage.getItem(LS.gemini)) return type || vinPrefix(vin);
  try {
    const prompt = "次の日本の自動車の車台番号から、車検証に記載される『型式』を1つだけ答えてください。型式のみ(例: QKG-FV60VX)、説明・記号・改行なし。車台番号: " + vin + (type ? " / 参考: " + type : "");
    const r = await geminiAsk(prompt);
    const k = (r.text || "").split(/\n/)[0].replace(/[「」『』。、\s]/g, "").trim().toUpperCase();
    if (/^[0-9A-Z]{2,4}-[A-Z0-9]{3,10}$/.test(k)) { setCachedKata(vin, k); return k; }
  } catch (e) {}
  return type || vinPrefix(vin);
}
function renderRecallVin(type, vin) {
  const box = $("recallVin"); box.innerHTML = "";
  if (!vin && !type) return;
  const head = document.createElement("div"); head.className = "hint"; head.style.margin = "0 0 6px";
  head.textContent = "型式・車台番号をコピーして、下のリコール検索サイトに貼り付けて確認できます。";
  box.appendChild(head);
  const cols = document.createElement("div"); cols.style.cssText = "display:flex;gap:10px";
  const mkCol = (label, val) => {
    const c = document.createElement("div"); c.style.cssText = "flex:1 1 0;min-width:0";
    const lab = document.createElement("div"); lab.style.cssText = "font-size:12px;color:var(--dim);margin-bottom:4px"; lab.textContent = label;
    const r = document.createElement("div"); r.style.cssText = "display:flex;align-items:center;gap:6px";
    const code = document.createElement("code"); code.textContent = val;
    code.style.cssText = "font-size:15px;font-weight:700;background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:6px 10px;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    const cp = document.createElement("button"); cp.className = "btn btn-ghost btn-sm"; cp.style.cssText = "flex:0 0 auto;padding:8px 11px"; cp.textContent = "📋"; cp.title = "コピー";
    cp.addEventListener("click", () => { copyText(code.textContent); cp.textContent = "✓"; setTimeout(() => cp.textContent = "📋", 1200); });
    r.append(code, cp); c.append(lab, r); return { col: c, code };
  };
  // 型式: 車台番号から正しい型式を特定して表示(初期は仮表示→AI/キャッシュで更新)
  const kataInit = (type && type.includes("-")) ? type : (vin ? (getCachedKata(vin) || vinPrefix(vin)) : (type || ""));
  const kataCol = mkCol("型式", kataInit || "—");
  cols.appendChild(kataCol.col);
  if (vin) cols.appendChild(mkCol("車台番号", vin).col);
  box.appendChild(cols);
  if (vin) resolveKatashiki(type, vin).then(k => { if (k) kataCol.code.textContent = k; });
}

/* =========================================================
   スキャン履歴 (型式/車台番号/日時のみ。所有者情報は保存しない)
   ========================================================= */
function getHistory() {
  try { return JSON.parse(localStorage.getItem(LS.hist)) || []; } catch (e) { return []; }
}
/* ナンバー比較用の正規化 (空白・記号除去、全角英数→半角) */
function normPlate(s) {
  if (!s) return "";
  return String(s)
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\s\-・･.．]/g, "")
    .toUpperCase();
}
/* 同一車両の既存履歴を探す (車台番号優先、なければナンバー) */
function findHistEntry(hist, d) {
  return hist.find(h =>
    (d.vin && h.vin && h.vin === d.vin) ||
    (!d.vin && d.plate && h.plate && normPlate(h.plate) === normPlate(d.plate)));
}
function addHistory(d) {
  const hist = getHistory();
  const exist = findHistEntry(hist, d);
  if (exist) {
    // 同一車両: 情報を統合して先頭へ (使用者名は保持)
    Object.assign(exist, {
      type: d.type || exist.type, vin: d.vin || exist.vin, plate: d.plate || exist.plate,
      engine: d.engine || exist.engine,
      expiry: d.expiry ? d.expiry.getTime() : exist.expiry,
      firstReg: d.firstReg || exist.firstReg, kataShitei: d.kataShitei || exist.kataShitei,
      at: new Date().toISOString(),
    });
    hist.splice(hist.indexOf(exist), 1); hist.unshift(exist);
  } else {
    hist.unshift({
      id: Date.now(), type: d.type || null, vin: d.vin || null, plate: d.plate || null, name: null,
      engine: d.engine || null,
      expiry: d.expiry ? d.expiry.getTime() : null,
      firstReg: d.firstReg || null, kataShitei: d.kataShitei || null,
      at: new Date().toISOString(),
    });
  }
  localStorage.setItem(LS.hist, JSON.stringify(hist.slice(0, 200)));
  renderHistory();
  if (window.Cloud) window.Cloud.pushRecord(findHistEntry(getHistory(), d));   // 社内共有へ
}
/* 現在表示中の車両に使用者名を保存 */
function saveUserName(name) {
  const hist = getHistory();
  let e = findHistEntry(hist, current);
  if (!e) { addHistory(current); e = findHistEntry(getHistory(), current); if (!e) return; }
  const h2 = getHistory();
  const t = findHistEntry(h2, current);
  if (t) { t.name = name || null; localStorage.setItem(LS.hist, JSON.stringify(h2)); renderHistory(); if (window.Cloud) window.Cloud.pushRecord(t); }
}
function histToResult(h) {
  return {
    type: h.type, vin: h.vin, plate: h.plate || null, engine: h.engine || null,
    expiry: h.expiry ? new Date(h.expiry) : null,
    firstReg: h.firstReg || null, kataShitei: h.kataShitei || null,
    raw: [h.type, h.vin, h.plate].filter(Boolean),
  };
}
function renderHistory() {
  const hist = getHistory();
  const box = $("histList"); box.innerHTML = "";
  if (!hist.length) { box.innerHTML = '<div class="empty"><img src="img/mecha.png" class="mascot-mini" alt="メカ君"><br>履歴はまだないよ。<br>車検証をスキャンするとここに記録されます。</div>'; return; }
  hist.forEach(h => {
    const div = document.createElement("div"); div.className = "histItem";
    const main = document.createElement("div"); main.className = "hMain";
    const dt = new Date(h.at);
    const title = [h.plate, h.name].filter(Boolean).join(" ／ ") || h.type || "型式不明";
    main.innerHTML = '<div class="hType">' + esc(title) + '</div>' +
      '<div class="hSub">' + esc(h.type || "型式不明") + " ・ " + esc(h.vin || "車台番号なし") + " ・ " +
      dt.getFullYear() + "/" + String(dt.getMonth()+1).padStart(2,"0") + "/" + String(dt.getDate()).padStart(2,"0") +
      " " + String(dt.getHours()).padStart(2,"0") + ":" + String(dt.getMinutes()).padStart(2,"0") + "</div>";
    main.addEventListener("click", () => showResult(histToResult(h), { fromScan: false }));
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
        if (window.Cloud) window.Cloud.deleteVehicle(v.id);
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
  saveCustomDB(); if (window.Cloud) window.Cloud.pushVehicle(rec); toggle("dbFormSec", false); renderDBList();
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
/* DB内蔵データの全消去: 内蔵・カスタム・学習(諸元/定番故障)をすべて削除(履歴は残す) */
$("btnClearDb").addEventListener("click", () => {
  if (!confirm("DB内蔵データを全消去します。\n・内蔵車種DB\n・カスタムDB\n・AIが学習した諸元/定番故障\nをすべて削除します（スキャン履歴は残ります）。よろしいですか？")) return;
  localStorage.setItem("ss_dbcleared", "1");
  localStorage.removeItem(LS.custom);
  localStorage.removeItem("ss_learnedspecs");
  CUSTOM_DB = []; BUILTIN_DB = [];
  renderDBList();
  setText("verNote", "メカノAI v" + APP_VER + " ／ DBデータを全消去しました。スキャンやAI調査で再び蓄積されます。");
  alert("DB内蔵データを全消去しました。");
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

async function runDiag() {
  const text = $("diagText").value.trim();
  if (!text) { $("diagResults").innerHTML = '<div class="empty">コードまたは症状を入力してください。</div>'; return; }
  const dtcs = extractDTCs(text);
  const symptoms = matchSymptoms(text);
  const vf = matchVehicleFaults(text, dtcs);
  renderDiagResults(dtcs, symptoms, vf, text);
  await runDiagAI(text); // 解析と同時にAI思考を自動実行(ボタンの処理中表示が完了まで持続)
}
function updateDiagVehicleHint() {
  $("diagVehicleHint").textContent = current.type
    ? "🚚 スキャン済み車両: " + current.type + " — 検索リンクと持病照合に反映されます"
    : "車検証をスキャンしておくと、車種固有の持病との照合・型式付き事例検索ができます";
}
$("btnDiagRun").addEventListener("click", async () => {
  stopFieldMic();
  // 写真・動画の添付があればメディアAI解析、無ければ従来のコード/問診解析
  if (diagAttachments.length) { await diagMediaAnalyze(); return; }
  const btn = $("btnDiagRun"); setBtnLoading(btn, true, "メカ君が考え中…");
  try { await runDiag(); } finally { setBtnLoading(btn, false); }
});
$("btnDiagClear").addEventListener("click", () => {
  cancelAI();   // 考え中のメカ君を中断
  $("diagText").value = ""; $("diagResults").innerHTML = "";
  toggle("diagVideoStatus", false);
  clearDiagAttachments();
});

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
/* モード別モデル候補 (上から順に試行。無料枠上限・未提供時は次へフォールバック) */
const GEMINI_MODELS = {
  // 1.5系はGoogleが廃止のため除外。lite系は無料枠が広くフォールバックに有効
  flash: ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash", "gemini-2.0-flash-lite"],
  pro: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"]
};
/* AI結果キャッシュ: 同じ問い合わせは再消費しない(無料枠節約) */
function hashStr(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); }
function aiCacheGet(k) { try { return (JSON.parse(localStorage.getItem("ss_aicache") || "{}"))[k] || null; } catch (e) { return null; } }
function aiCacheSet(k, v) {
  try {
    const c = JSON.parse(localStorage.getItem("ss_aicache") || "{}");
    c[k] = v; const ks = Object.keys(c);
    while (ks.length > 150) delete c[ks.shift()];
    localStorage.setItem("ss_aicache", JSON.stringify(c));
  } catch (e) {}
}
function getAiMode() { return localStorage.getItem(LS.aimode) === "pro" ? "pro" : "flash"; }
function renderAiMode() {
  const mode = getAiMode();
  document.querySelectorAll(".mode-btn").forEach(b => b.classList.toggle("mode-active", b.dataset.mode === mode));
}
document.querySelectorAll(".mode-btn").forEach(b => b.addEventListener("click", () => {
  localStorage.setItem(LS.aimode, b.dataset.mode);
  renderAiMode();
}));

function renderGeminiStat() {
  const has = !!localStorage.getItem(LS.gemini);
  $("geminiStat").textContent = has
    ? "✓ 設定済み — 診断タブで「メカ君に相談」が使えます。空欄で保存すると解除。"
    : "未設定 — キーはこの端末のみに保存され、Google以外には送信されません。";
}
$("btnGeminiSave").addEventListener("click", () => {
  const v = $("geminiKey").value.trim();
  if (v) localStorage.setItem(LS.gemini, v); else localStorage.removeItem(LS.gemini);
  $("geminiKey").value = "";
  renderGeminiStat();
});

/* ---- Cloud Vision(高精度OCR)設定 ---- */
function renderVisionStat() {
  const has = !!localStorage.getItem("ss_visionkey");
  const on = localStorage.getItem("ss_usevision") === "1";
  $("useVision").checked = on;
  $("visionStat").textContent = has
    ? (on ? "✓ 高精度OCR(Cloud Vision)を使用中。" : "キー設定済み（OFF）。ONにすると有料OCRを使います。")
    : "未設定 — キーはこの端末のみに保存。OFFまたは未設定なら無料Tesseractを使います。";
}
$("btnVisionSave").addEventListener("click", () => {
  const v = $("visionKey").value.trim();
  if (v) localStorage.setItem("ss_visionkey", v); else localStorage.removeItem("ss_visionkey");
  $("visionKey").value = "";
  if (!localStorage.getItem("ss_visionkey")) localStorage.removeItem("ss_usevision");
  renderVisionStat();
});
$("useVision").addEventListener("change", () => {
  if ($("useVision").checked && !localStorage.getItem("ss_visionkey")) {
    alert("先にCloud Vision APIキーを保存してください。");
    $("useVision").checked = false; return;
  }
  localStorage.setItem("ss_usevision", $("useVision").checked ? "1" : "0");
  renderVisionStat();
});

/* 進行中のAIリクエストを中断するためのコントローラ */
let aiAbort = null;
function cancelAI() {
  if (aiAbort) { try { aiAbort.abort(); } catch (e) {} aiAbort = null; }
  // 各処理の「考え中」状態を解除
  diagAiBusy = false; if (typeof diagMediaBusy !== "undefined") diagMediaBusy = false;
  if (typeof partsBusy !== "undefined") partsBusy = false; if (typeof vehAskBusy !== "undefined") vehAskBusy = false;
  ["btnDiagRun", "btnPartsGo", "btnSpecAI", "btnSpecReload", "btnVehAsk", "btnAiQr"].forEach(id => { const b = $(id); if (b) setBtnLoading(b, false); });
}
async function geminiAsk(prompt, opts) {
  opts = opts || {};
  const mode = opts.mode || getAiMode();   // 会話など回数が多い用途は flash 指定で無料枠を節約
  const key = localStorage.getItem(LS.gemini);
  // キャッシュ命中なら無料枠を消費せず即返す(noCache指定時は最新を取得)
  const ck = mode + ":" + hashStr(prompt);
  if (!opts.noCache) {
    const cached = aiCacheGet(ck);
    if (cached) return { text: cached.text, truncated: cached.truncated, model: "cache" };
  }
  let lastErr = null;
  aiAbort = new AbortController();   // クリアで中断できるように
  for (const model of GEMINI_MODELS[mode]) {
    try {
      // 思考トークンと本文が両方収まるよう上限は大きめに確保
      const genCfg = { temperature: 0.2, maxOutputTokens: 16384 };
      // 2.5系: 思考モードを有効化(-1=タスクに応じてAIが思考量を自動調整)。精度優先
      if (model.startsWith("gemini-2.5")) genCfg.thinkingConfig = { thinkingBudget: -1 };
      const res = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + encodeURIComponent(key),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: aiAbort.signal,
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: genCfg
          })
        });
      if (res.status === 404) { lastErr = new Error(model + " は利用不可"); continue; }
      if (res.status === 429) { lastErr = new Error("無料枠の上限に達しました。1分待つ／設定で標準モードにする／日本時間の夕方(米国0時)のリセットを待つ、をお試しください。"); continue; } // 下位モデルで再試行
      if (res.status === 400 || res.status === 403) throw new Error("APIキーが無効です。設定タブでキーを確認してください。");
      if (!res.ok) throw new Error("AI応答エラー (" + res.status + ")");
      const j = await res.json();
      const cand = j.candidates?.[0];
      // 思考パート(thought:true)を除いた本文のみ結合
      const text = cand?.content?.parts?.filter(p => !p.thought).map(p => p.text || "").join("") || "";
      if (!text) throw new Error("AIから回答が得られませんでした");
      const r = { text, truncated: cand?.finishReason === "MAX_TOKENS", model };
      aiCacheSet(ck, { text: r.text, truncated: r.truncated });
      return r;
    } catch (e) {
      if (e && e.name === "AbortError") throw new Error("__cancelled__");   // クリアで中断
      if (e.message && (e.message.includes("上限") || e.message.includes("キーが無効"))) throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error("AIに接続できませんでした(要ネット接続)");
}

function buildDiagPrompt(text) {
  const lines = [
    "あなたは『メカ君』。まじめで頼れるロボ整備士(一人称ボク)で、どこかおちゃめな愛嬌もあるが診断は正確第一。下記の形式は守りつつ、各説明は親しみやすく分かりやすい言葉で(冒頭か末尾に軽い一言を添えてもよいが、やりすぎない)。",
    "回答前に十分に考えてから答えること。正確性を最優先し、確信が持てない内容には「（要確認）」を付け、推測と確定的な事実を混同しないこと。一般論より、提示された車種・エンジンに固有の既知事例を優先すること。",
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
function renderAiAnswer(container, text, opts) {
  opts = opts || {};
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

/* 「解析する」から自動実行されるAI診断 (キー未設定なら案内カードのみ) */
let diagAiBusy = false;
async function runDiagAI(text) {
  const box = $("diagResults");
  if (!localStorage.getItem(LS.gemini)) {
    const { sec, body } = diagSection("", "AI", "AI診断を使うには");
    const p = document.createElement("div");
    p.className = "hint";
    p.textContent = "無料のGemini APIキーを設定すると、ここにAIの診断見解も表示されます(クレジットカード不要)。";
    const go = document.createElement("button");
    go.type = "button"; go.className = "btn btn-ghost btn-sm"; go.style.marginTop = "8px";
    go.textContent = "⚙ 設定画面でキーを取得・保存する";
    go.addEventListener("click", () => switchView("settings"));
    body.append(p, go);
    box.prepend(sec);
    return;
  }
  if (diagAiBusy) return;
  diagAiBusy = true;
  const { sec, body } = diagSection("", "メカ君", "メカ君の見解" + (getAiMode() === "pro" ? "（高精度モード）" : ""));
  const p = document.createElement("div");
  p.className = "ai-answer"; p.textContent = "🔧 メカ君が考えています…(数秒〜十数秒)";
  body.appendChild(p);
  box.prepend(sec);
  try {
    const r = await geminiAsk(buildDiagPrompt(text));
    renderAiAnswer(p, r.text, { linkCauses: true });
    const note = document.createElement("div");
    note.className = "hint"; note.style.marginTop = "10px";
    note.textContent = (r.truncated ? "⚠ 回答が長すぎて一部省略されました。症状を絞って再度相談してください。 " : "")
      + "※ AIの回答は参考情報です。必ず実測・実点検で裏取りしてください。";
    body.appendChild(note);
    appendAiFollowup(body, text, r.text);
  } catch (e) {
    if (e.message !== "__cancelled__") p.textContent = "⚠ " + (e.message || "AIへの接続に失敗しました");
  } finally {
    diagAiBusy = false;
  }
}

/* 各診断の下に「追加で相談」欄(テキスト＋写真/動画添付、会話モードは除く)。回答後さらに追い相談を連鎖 */
function appendAiFollowup(body, origText, prevAnswer) {
  const wrap = document.createElement("div");
  wrap.style.marginTop = "12px"; wrap.style.paddingTop = "12px"; wrap.style.borderTop = "1px dashed var(--line)";
  const lab = document.createElement("div");
  lab.className = "hint"; lab.style.marginBottom = "6px";
  lab.textContent = "解決しない・追加で相談したい場合 — 実施内容や追加の症状を書く／写真・動画を添付して、メカ君にもう一度相談できます。";
  const ta = document.createElement("textarea");
  ta.placeholder = "例: EGRを清掃したが まだ白煙が出る。圧縮圧は正常。— 写真や動画も添付できます。";
  ta.style.minHeight = "64px";

  // 追加相談用の添付(音声入力/写真/写真撮影/動画/動画撮影)
  const atts = [];
  const icons = document.createElement("div"); icons.className = "fuIcons";
  // 音声入力ボタン
  const micBtn = document.createElement("button"); micBtn.type = "button"; micBtn.className = "diagIco txt"; micBtn.title = "音声で入力"; micBtn.textContent = "🎤";
  let fuRec = null;
  micBtn.addEventListener("click", () => {
    if (fuRec) { try { fuRec.stop(); } catch (e) {} fuRec = null; return; }
    const rec = getSpeechRecognition();
    if (!rec) { alert("この端末/ブラウザは音声入力に対応していません(Chrome等をお試しください)。"); return; }
    fuRec = rec; const base = ta.value; micBtn.textContent = "●"; micBtn.classList.add("sel");
    rec.onresult = e => { let s = ""; for (let i = 0; i < e.results.length; i++) s += e.results[i][0].transcript; ta.value = (base ? base + " " : "") + s; };
    rec.onend = () => { fuRec = null; micBtn.textContent = "🎤"; micBtn.classList.remove("sel"); };
    try { rec.start(); } catch (e) { fuRec = null; micBtn.textContent = "🎤"; micBtn.classList.remove("sel"); }
  });
  icons.appendChild(micBtn);
  const preview = document.createElement("div"); preview.id = ""; preview.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;margin-top:8px";
  function renderPv() {
    preview.innerHTML = "";
    atts.forEach((a, i) => {
      const d = document.createElement("div"); d.className = "attachThumb";
      const m = document.createElement(a.kind === "video" ? "video" : "img"); m.src = a.url; if (a.kind === "video") { m.muted = true; m.playsInline = true; }
      const del = document.createElement("button"); del.className = "axDel"; del.textContent = "×";
      del.addEventListener("click", () => { URL.revokeObjectURL(a.url); atts.splice(i, 1); renderPv(); });
      d.append(m, del); preview.appendChild(d);
    });
  }
  const defs = [
    ["img/ic-photo.png", "写真を添付", "image/*", false],
    ["img/ic-photo-cam.png", "写真を撮って添付", "image/*", true],
    ["img/ic-video.png", "動画を添付", "video/*", false],
    ["img/ic-video-cam.png", "動画を撮って添付", "video/*", true],
  ];
  defs.forEach(([src, title, accept, cap]) => {
    const b = document.createElement("button"); b.type = "button"; b.className = "diagIco"; b.title = title;
    const im = document.createElement("img"); im.src = src; b.appendChild(im);
    const inp = document.createElement("input"); inp.type = "file"; inp.accept = accept; if (cap) inp.capture = "environment"; inp.className = "hidden";
    b.addEventListener("click", () => inp.click());
    inp.addEventListener("change", async e => {
      let f = e.target.files[0]; inp.value = ""; if (!f) return;
      const isV = (f.type || "").startsWith("video");
      if (isV && f.size > ATTACH_MAX) { try { f = await compressVideo(f, ATTACH_MAX); } catch (er) {} if (f.size > ATTACH_MAX) { alert("動画が大きすぎます。短く撮り直してください。"); return; } }
      atts.push({ file: f, kind: isV ? "video" : "image", url: URL.createObjectURL(f) }); renderPv();
    });
    icons.appendChild(b); wrap.appendChild(inp);
  });

  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "btn btn-ghost btn-sm"; btn.style.marginTop = "8px";
  btn.innerHTML = '<img src="img/kangae.png" class="btnMecha" alt="">メカ君に追加で相談';
  const ans = document.createElement("div"); ans.className = "ai-answer hidden"; ans.style.marginTop = "10px";
  btn.addEventListener("click", async () => {
    const tried = ta.value.trim();
    if (!tried && !atts.length) { ta.focus(); return; }
    if (diagAiBusy) return;
    diagAiBusy = true; setBtnLoading(btn, true, "メカ君が考え中…");
    ans.classList.remove("hidden"); ans.textContent = "🔧 メカ君が追加で考えています…";
    try {
      const prompt = [
        "あなたは日本の自動車整備士を支援するベテラン診断アドバイザー『メカ君』です。前回の見解で解決しなかったため、整備士の追加情報(文章・写真・動画)を踏まえ、悩みを正確に理解して的確に助言してください。",
        "前回の原因候補は試して効果が無かった前提で、見落としやすい原因・上流の根本原因・確定診断の手順を可能性の高い順に最大5つ。各項目に切り分け(工具・測定値の目安)を簡潔に。最後に『次の確定的な一手』を1行。前置き・免責不要、Markdown記号なし。",
        "■当初の相談内容: " + origText,
        "■前回の見解(試して無効): " + String(prevAnswer).slice(0, 1200),
        "■追加情報(整備士の実施内容・結果・追加症状): " + (tried || "(テキストなし。添付を参照)"),
      ].join("\n");
      let r;
      if (atts.length) {
        const media = [];
        for (const a of atts) media.push({ mimeType: a.file.type || (a.kind === "video" ? "video/mp4" : "image/jpeg"), data: await fileToBase64(a.file) });
        r = await geminiAskMedia(prompt, media);
      } else {
        r = await geminiAsk(prompt);
      }
      renderAiAnswer(ans, r.text, { linkCauses: true });
      // さらに追い相談できるよう、回答の下に次の相談欄を連鎖
      appendAiFollowup(body, origText + " / " + tried, r.text);
    } catch (e) {
      if (e.message !== "__cancelled__") ans.textContent = "⚠ " + (e.message || "AIへの接続に失敗しました");
    } finally {
      diagAiBusy = false; setBtnLoading(btn, false);
    }
  });
  wrap.append(lab, ta, icons, preview, btn, ans);
  body.appendChild(wrap);
}

/* 対象車両の説明文(型式が無くても指定・類別/原動機/車台番号で識別) */
function vehicleDesc() {
  const parts = [];
  if (current.type) parts.push("型式 " + current.type);
  if (current.kataShitei) parts.push("型式指定番号・類別区分番号 " + current.kataShitei);
  if (current.engine) parts.push("原動機型式 " + current.engine);
  if (current.vin) parts.push("車台番号 " + current.vin);
  const code = current.type && current.type.includes("-") ? current.type.split("-")[1] : current.type;
  const v = code ? findVehicle(code) : null;
  if (v) parts.push("（" + v.name + "）");
  return parts.length ? parts.join(" / ") : "不明";
}
/* メンテナンス諸元＋定番故障/持病をAIから一括取得(JSON) */
function buildSpecPrompt() {
  return [
    "あなたは日本の自動車整備士向けのデータアドバイザーです。",
    "次の車両について、(A)整備に必要なメンテナンス諸元、(B)この車種の定番故障・持病、(C)過去に届出された主なリコール・改善対策・サービスキャンペーンの有無 を答えてください。",
    "型式が不明な場合は、型式指定番号・類別区分番号や車台番号・原動機型式から車種を推定して構いません。",
    "確信が持てない値には必ず「（要確認）」を付け、年式・エンジンで差がある場合はその旨を値の中に明記すること。",
    "リコールは事実が不確かなものを断定しないこと。代表的な届出が思い当たればその内容を1件1文で挙げ(必要なら「要確認」付き)、心当たりが無ければrecallsは空配列にすること。",
    "あわせて、推定できる車種名(メーカー名+車種名、例『日野 プロフィア』)と、メーカーを次のローマ字キーのいずれかで答えること: isuzu,hino,fuso,ud,nissan,toyota,honda,mazda,suzuki,daihatsu,subaru,other。判別できなければmodelは空文字、makerは\"other\"。",
    "出力は厳密なJSONのみ(前後に文章やコードフェンス不要)。形式:",
    '{"model":"日野 プロフィア","maker":"hino","specs":[{"k":"エンジンオイル量","v":"約13L（フィルタ交換時・要確認）"},{"k":"推奨オイル粘度","v":"…"},{"k":"オイル交換目安","v":"…"},{"k":"クーラント量","v":"…"},{"k":"ホイールナット締付トルク","v":"…"},{"k":"ATF/CVT/ミッションオイル","v":"…"},{"k":"車台番号の打刻位置","v":"…(例: 助手席足元のフロア、右フロントシート下など)"},{"k":"エンジン型式の打刻位置","v":"…(例: シリンダーブロック前面など)"}],"faults":["定番故障・持病を1件1文で複数"],"recalls":["主なリコール/改善対策を1件1文(年式・対象部位が分かれば併記)"]}',
    "specsには『車台番号の打刻位置』『エンジン型式の打刻位置』を必ず含め、その車種で分かる範囲の具体的な場所を記すこと(不明なら要確認)。上記以外も整備で重要なものがあれば追加してよい。faultsは既知の弱点・定番トラブルを具体的に。",
    "",
    "■対象車両: " + vehicleDesc()
  ].join("\n");
}
async function runSpecAI(srcBtn) {
  stopFieldMic();
  if (!localStorage.getItem(LS.gemini)) {
    alert("AIで調べるには無料のGemini APIキーの設定が必要です。\n\n設定タブ →「AI相談機能」の手順でキーを取得・保存してください(クレジットカード不要)。");
    switchView("settings");
    return;
  }
  const box = $("specAiBox");
  toggle("specAiBox", true);
  box.textContent = "🔧 メカ君が諸元・定番故障を調べています…(数秒〜十数秒)";
  const btn = srcBtn || $("btnSpecAI"); setBtnLoading(btn, true, "メカ君が調べ中…");
  const force = srcBtn && srcBtn.id === "btnSpecReload";   // 「最新に更新」はキャッシュを使わず再取得
  try {
    const r = await geminiAsk(buildSpecPrompt(), { noCache: force });
    const obj = extractJson(r.text);
    let specs = [], faults = [], recalls = [], model = "", maker = "";
    if (obj) {
      specs = Array.isArray(obj.specs) ? obj.specs.filter(s => s && s.k).map(s => ({ k: String(s.k).trim(), v: String(s.v || "").trim() })) : [];
      faults = Array.isArray(obj.faults) ? obj.faults.map(x => String(x).trim()).filter(Boolean) : [];
      recalls = Array.isArray(obj.recalls) ? obj.recalls.map(x => String(x).trim()).filter(Boolean) : [];
      model = obj.model ? String(obj.model).trim() : "";
      maker = obj.maker ? String(obj.maker).trim().toLowerCase() : "";
    }
    // JSONで取れない時はテキストを諸元へフォールバック分解
    if (!specs.length) { lastSpecAiText = r.text; specs = aiTextToSpecs(r.text); }
    if (!specs.length && !faults.length && !recalls.length) { renderAiAnswer(box, r.text); return; }
    // DB(車両レコード)＋学習キーへ自動保存 → 次回はAI不要
    setLearned(vehicleKey(current), { specs, faults, recalls, model, maker });
    saveVehicleAiData(specs, faults, recalls, { model, maker });
    registerVehicleToDB({ silent: true });   // 諸元・故障・車種名・メーカーをDB登録車種へ自動反映
    // 表示: 諸元は表で、定番故障/持病はFAULTセクション、リコールはRECALLセクションへ
    toggle("specAiBox", false);
    if (specs.length) renderSpecs(specs, "learned");
    if (faults.length) { renderFaultList(faults); toggle("secFault", true); }
    renderRecalls(recalls);
  } catch (e) {
    if (e.message !== "__cancelled__") box.textContent = "⚠ " + (e.message || "AIへの接続に失敗しました");
  } finally {
    setBtnLoading(btn, false);
  }
}
$("btnSpecAI").addEventListener("click", () => runSpecAI($("btnSpecAI")));
$("btnSpecReload").addEventListener("click", () => runSpecAI($("btnSpecReload")));  // 最新に更新(都度DB更新)

/* ---- 写真・動画の添付AI解析(Geminiマルチモーダル) ---- */
function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1]);
    r.onerror = () => rej(new Error("ファイルを読み込めませんでした"));
    r.readAsDataURL(file);
  });
}
/* 動画(＋プロンプト)をGeminiに送って解析。textのみ版geminiAskと別系統(キャッシュなし) */
async function geminiAskMedia(prompt, media) {
  const key = localStorage.getItem(LS.gemini);
  if (!key) throw new Error("Gemini APIキーが未設定です。");
  let lastErr = null;
  for (const model of GEMINI_MODELS[getAiMode()]) {
    try {
      const genCfg = { temperature: 0.2, maxOutputTokens: 16384 };
      if (model.startsWith("gemini-2.5")) genCfg.thinkingConfig = { thinkingBudget: -1 };
      const parts = [{ text: prompt }, ...media.map(m => ({ inlineData: { mimeType: m.mimeType, data: m.data } }))];
      const res = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + encodeURIComponent(key),
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts }], generationConfig: genCfg }) });
      if (res.status === 404) { lastErr = new Error(model + " は利用不可"); continue; }
      if (res.status === 429) { lastErr = new Error("無料枠の上限に達しました。1分待つ／標準モードにする等をお試しください。"); continue; }
      if (res.status === 400 || res.status === 403) throw new Error("APIキーが無効、または動画が大きすぎる可能性があります。より短い動画でお試しください。");
      if (!res.ok) throw new Error("AI応答エラー (" + res.status + ")");
      const j = await res.json();
      const cand = j.candidates?.[0];
      const text = cand?.content?.parts?.filter(p => !p.thought).map(p => p.text || "").join("") || "";
      if (!text) throw new Error("AIから回答が得られませんでした");
      return { text, truncated: cand?.finishReason === "MAX_TOKENS", model };
    } catch (e) {
      if (e.message && (e.message.includes("上限") || e.message.includes("キーが無効") || e.message.includes("大きすぎる"))) throw e;
      lastErr = e;
    }
  }
  throw lastErr || new Error("AIに接続できませんでした(要ネット接続)");
}
function buildMediaDiagPrompt() {
  const lines = [
    "あなたは日本の自動車整備士を支援するベテラン診断アドバイザーです。",
    "添付の写真・動画(整備士が撮影した不具合の様子)を観察し、判断できる症状(異音の種類・発生タイミング、煙や排気の色、振動、警告灯、液漏れ、損傷、異常な挙動など)を読み取ってください。",
    "動画に音声があれば異音の特徴も考慮すること。映像・音声から判断できないことは断定せず推測には「（要確認）」を付けること。",
    "前置き・免責・挨拶は不要。Markdown記号(**、#、表)は使わず、必ず次の形式で:",
    "■写真・動画から読み取れる症状",
    "・観察できた症状を箇条書き(判別できなければ『判別不可』)",
    "■原因候補（可能性が高い順）",
    "1. 原因名（一言で）",
    "切り分け: 確認方法。使用工具と測定値の目安を含める。1〜2文で簡潔に。",
    "2.（同様に最大5つまで）",
    "■最初の1手",
    "現場で最初にやるべきことを1〜2文で。",
    ""
  ];
  if (current.type || current.vin) {
    const code = current.type && current.type.includes("-") ? current.type.split("-")[1] : current.type;
    const v = code ? findVehicle(code) : null;
    lines.push("■車両: " + (current.type ? "型式 " + current.type : "車台番号 " + current.vin) + (v ? "（" + v.name + "）" : ""));
    if (v && (v.faults || []).length) lines.push("この車種の既知の持病: " + v.faults.join(" / "));
  }
  const extra = $("diagText").value.trim();
  if (extra) lines.push("■整備士の補足メモ: " + extra);
  return lines.join("\n");
}
/* ===== 診断: 写真・動画の添付(4方式) + 自動圧縮 + メディアAI解析 ===== */
const diagAttachments = [];          // {file, kind:'image'|'video', url}
const ATTACH_MAX = 12 * 1024 * 1024;   // インライン送信の安全上限(base64で約1.37倍に膨らむため raw 12MB ≒ 16.5MB)
const VIDEO_TARGET = 9 * 1024 * 1024;  // 圧縮の目標サイズ(余裕を持って)

const attachMap = [
  ["btnAttachPhoto", "inAttachPhoto"],
  ["btnAttachPhotoCam", "inAttachPhotoCam"],
  ["btnAttachVideo", "inAttachVideo"],
  ["btnAttachVideoCam", "inAttachVideoCam"],
];
attachMap.forEach(([btn, input]) => {
  $(btn).addEventListener("click", () => {
    if (typeof closeVoiceChat === "function") closeVoiceChat();   // 添付選択で会話モードを閉じる
    document.querySelectorAll(".diagIco").forEach(b => b.classList.remove("sel"));
    $(btn).classList.add("sel");
    $(input).click();
  });
  $(input).addEventListener("change", async e => {
    const files = [...e.target.files]; e.target.value = "";
    for (const f of files) await addDiagAttachment(f);
  });
});

async function addDiagAttachment(file) {
  const isVideo = (file.type || "").startsWith("video");
  const st = $("diagVideoStatus");
  let f = file;
  if (isVideo && file.size > ATTACH_MAX) {
    toggle("diagVideoStatus", true);
    st.textContent = "動画が大きい(" + Math.round(file.size / 1048576) + "MB)ので自動圧縮しています…";
    try {
      f = await compressVideo(file, VIDEO_TARGET);
      st.textContent = "✓ 圧縮しました(" + Math.round(f.size / 1048576) + "MB)。";
    } catch (e) {
      f = file;
      st.textContent = "⚠ 自動圧縮できませんでした。短い動画で撮り直すか、低画質で撮影してください。";
    }
    if (f.size > ATTACH_MAX) {
      st.textContent = "⚠ 圧縮しても大きすぎます(" + Math.round(f.size / 1048576) + "MB)。10秒程度に短く撮り直してください。";
      return;
    }
  }
  diagAttachments.push({ file: f, kind: isVideo ? "video" : "image", url: URL.createObjectURL(f) });
  renderDiagAttachList();
}
function renderDiagAttachList() {
  const box = $("diagAttachList");
  box.innerHTML = "";
  diagAttachments.forEach((a, i) => {
    const d = document.createElement("div"); d.className = "attachThumb";
    const media = document.createElement(a.kind === "video" ? "video" : "img");
    media.src = a.url; if (a.kind === "video") { media.muted = true; media.playsInline = true; }
    const kind = document.createElement("span"); kind.className = "axKind"; kind.textContent = a.kind === "video" ? "動画" : "写真";
    const del = document.createElement("button"); del.className = "axDel"; del.textContent = "×";
    del.addEventListener("click", () => { URL.revokeObjectURL(a.url); diagAttachments.splice(i, 1); renderDiagAttachList(); });
    d.append(media, kind, del); box.appendChild(d);
  });
  toggle("diagAttachList", diagAttachments.length > 0);
}
function clearDiagAttachments() {
  diagAttachments.forEach(a => URL.revokeObjectURL(a.url));
  diagAttachments.length = 0; renderDiagAttachList();
  document.querySelectorAll(".diagIco").forEach(b => b.classList.remove("sel"));
}

/* 大きい動画をcanvas+MediaRecorderで縮小再エンコード(音声も維持。短時間クリップ向け) */
function compressVideo(file, targetBytes) {
  return new Promise((resolve, reject) => {
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) { reject(new Error("非対応")); return; }
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.src = url;
    v.onloadedmetadata = () => {
      const maxDim = 540;                       // 長辺540pxへ縮小(送信サイズ優先)
      const scale = Math.min(1, maxDim / Math.max(v.videoWidth, v.videoHeight));
      const w = Math.max(2, Math.round(v.videoWidth * scale) & ~1);
      const h = Math.max(2, Math.round(v.videoHeight * scale) & ~1);
      const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
      const cx = canvas.getContext("2d");
      const cstream = canvas.captureStream(24);
      // 元動画の音声トラックを合成(取得できる端末のみ)
      try {
        const vs = v.captureStream ? v.captureStream() : null;
        const at = vs && vs.getAudioTracks ? vs.getAudioTracks()[0] : null;
        if (at) cstream.addTrack(at);
      } catch (e) {}
      const dur = v.duration && isFinite(v.duration) ? v.duration : 12;
      const bitrate = Math.max(250000, Math.min(1800000, Math.floor(targetBytes * 8 / Math.max(1, dur) * 0.8)));
      let mime = "video/webm;codecs=vp8,opus";
      if (!MediaRecorder.isTypeSupported(mime)) mime = MediaRecorder.isTypeSupported("video/webm") ? "video/webm" : "";
      let rec;
      try { rec = new MediaRecorder(cstream, mime ? { mimeType: mime, videoBitsPerSecond: bitrate } : { videoBitsPerSecond: bitrate }); }
      catch (e) { URL.revokeObjectURL(url); reject(e); return; }
      const chunks = [];
      rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        URL.revokeObjectURL(url);
        const blob = new Blob(chunks, { type: mime || "video/webm" });
        resolve(new File([blob], "compressed.webm", { type: blob.type }));
      };
      const draw = () => { if (v.ended || v.paused) return; cx.drawImage(v, 0, 0, w, h); requestAnimationFrame(draw); };
      v.onplay = () => draw();
      v.onended = () => { try { rec.stop(); } catch (e) {} };
      rec.start();
      v.play().catch(err => { URL.revokeObjectURL(url); reject(err); });
      // 保険: 想定尺+2秒で強制停止
      setTimeout(() => { if (rec.state !== "inactive") { try { v.pause(); rec.stop(); } catch (e) {} } }, (dur + 2) * 1000);
    };
    v.onerror = () => { URL.revokeObjectURL(url); reject(new Error("動画を読み込めませんでした")); };
  });
}

let diagMediaBusy = false;
async function diagMediaAnalyze() {
  if (!localStorage.getItem(LS.gemini)) {
    alert("写真・動画のAI解析には無料のGemini APIキーの設定が必要です（設定タブ）。");
    switchView("settings"); return;
  }
  // 合計サイズの安全チェック(インライン送信の上限対策)
  const totalSize = diagAttachments.reduce((s, a) => s + (a.file.size || 0), 0);
  if (totalSize > ATTACH_MAX) {
    toggle("diagVideoStatus", true);
    $("diagVideoStatus").textContent = "⚠ 添付の合計サイズが大きすぎます(" + Math.round(totalSize / 1048576) + "MB)。動画は1本・10秒程度に、写真は枚数を減らしてください。";
    return;
  }
  if (diagMediaBusy) return;
  diagMediaBusy = true;
  const runBtn = $("btnDiagRun"); setBtnLoading(runBtn, true, "メカ君が解析中…");
  const st = $("diagVideoStatus"); toggle("diagVideoStatus", true);
  st.textContent = "メカ君が写真・動画を解析しています…(数十秒かかる場合があります)";
  // テキストにコード/症状があれば内蔵DB照合も表示
  const text = $("diagText").value.trim();
  if (text) { const dtcs = extractDTCs(text); renderDiagResults(dtcs, matchSymptoms(text), matchVehicleFaults(text, dtcs), text); }
  try {
    const media = [];
    for (const a of diagAttachments) media.push({ mimeType: a.file.type || (a.kind === "video" ? "video/mp4" : "image/jpeg"), data: await fileToBase64(a.file) });
    const r = await geminiAskMedia(buildMediaDiagPrompt(), media);
    const box = $("diagResults");
    const { sec, body } = diagSection("", "メカ君", "写真・動画からのメカ君診断" + (getAiMode() === "pro" ? "（高精度モード）" : ""));
    const p = document.createElement("div"); p.className = "ai-answer"; body.appendChild(p);
    renderAiAnswer(p, r.text, { linkCauses: true });
    const note = document.createElement("div"); note.className = "hint"; note.style.marginTop = "10px";
    note.textContent = (r.truncated ? "⚠ 回答が長すぎて一部省略されました。 " : "") + "※ 映像・音声からの推定です。必ず実測・実点検で裏取りしてください。";
    body.appendChild(note);
    appendAiFollowup(body, text || "(添付の写真・動画による相談)", r.text);  // この診断にも追加相談欄
    box.prepend(sec);
    st.textContent = "✓ 解析が完了しました。下に結果を表示しています。";
    sec.scrollIntoView({ behavior: "smooth" });
  } catch (err) {
    if (err.message !== "__cancelled__") st.textContent = "⚠ " + (err.message || "解析に失敗しました");
  } finally {
    diagMediaBusy = false; setBtnLoading(runBtn, false);
  }
}

/* ===== 音声入力(Web Speech API) ===== */
function getSpeechRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const r = new SR(); r.lang = "ja-JP"; r.interimResults = true; r.continuous = false;
  return r;
}
let micRec = null, micListening = false, micBtnCur = null;
/* 検索/相談ボタン押下時に音声入力を終了させる */
function stopFieldMic() { micListening = false; if (micRec) { try { micRec.stop(); } catch (e) {} } }
/* 音声で文字入力: 押すと認識開始。無音で切れても押すまで自動再開し続ける。再押下で停止 */
function wireFieldMic(btnId, fieldId, idleLabel) {
  const btn = $(btnId); if (!btn) return;
  btn.addEventListener("click", () => {
    if (typeof closeVoiceChat === "function") closeVoiceChat();
    if (micListening && micBtnCur === btn) {      // 停止
      micListening = false;
      if (micRec) { try { micRec.stop(); } catch (e) {} }
      btn.textContent = idleLabel; btn.classList.remove("sel");
      return;
    }
    if (micRec) { try { micRec.stop(); } catch (e) {} micRec = null; }
    if (!getSpeechRecognition()) { alert("この端末/ブラウザは音声入力に対応していません(Chrome等をお試しください)。"); return; }
    const fld = $(fieldId);
    const base = fld.value ? fld.value + " " : "";
    let accum = "", sessionFinal = "";
    micListening = true; micBtnCur = btn; btn.textContent = "●"; btn.classList.add("sel");
    const startSession = () => {
      const rec = getSpeechRecognition(); if (!rec) { micListening = false; return; }
      rec.continuous = true; rec.interimResults = true; micRec = rec; sessionFinal = "";
      rec.onresult = e => {
        let f = "", interim = "";
        for (let i = 0; i < e.results.length; i++) { if (e.results[i].isFinal) f += e.results[i][0].transcript; else interim += e.results[i][0].transcript; }
        sessionFinal = f;
        fld.value = base + dedupRepeats(accum + f + interim);
      };
      rec.onerror = () => {};
      rec.onend = () => {
        accum += sessionFinal; sessionFinal = ""; micRec = null;
        if (micListening) { startSession(); return; }   // 押すまで聞き続ける
        btn.textContent = idleLabel; btn.classList.remove("sel");
        fld.value = base + dedupRepeats(accum);
      };
      try { rec.start(); } catch (e) { micListening = false; btn.textContent = idleLabel; btn.classList.remove("sel"); }
    };
    startSession();
  });
}
wireFieldMic("btnDiagMic", "diagText", "🎤");
wireFieldMic("btnPartsMic", "partName", "🎤");
wireFieldMic("btnVehMic", "qVehText", "🎤");

/* ===== メカ君と音声会話(STT → Gemini → TTS) ===== */
let voiceRec = null, voiceHistory = [], voiceActive = false;
$("btnDiagVoiceChat").addEventListener("click", () => {
  if (!localStorage.getItem(LS.gemini)) {
    alert("音声会話には無料のGemini APIキーの設定が必要です（設定タブ）。");
    switchView("settings"); return;
  }
  if (!getSpeechRecognition()) { alert("この端末/ブラウザは音声認識に対応していません(Chrome等をお試しください)。"); return; }
  toggle("voiceChatSec", true);
  $("voiceChatSec").scrollIntoView({ behavior: "smooth" });
});
/* 会話モードを閉じる(履歴・ログは保持し、再開で続きから) */
function closeVoiceChat() {
  voiceActive = false; voiceListening = false;
  if (voiceRec) { try { voiceRec.stop(); } catch (e) {} voiceRec = null; }
  try { window.speechSynthesis.cancel(); } catch (e) {}
  toggle("voiceChatSec", false);
}
$("btnVoiceStop").addEventListener("click", closeVoiceChat);
function vcAppend(role, text) {
  const d = document.createElement("div"); d.className = "vcMsg " + (role === "user" ? "user" : "mecha");
  if (role === "user") {
    d.textContent = "あなた: " + text;
  } else {
    const ic = document.createElement("img"); ic.className = "vcIco"; ic.src = "img/speak.png"; ic.alt = "メカ君";
    d.append(ic, document.createTextNode(text));
  }
  $("voiceLog").appendChild(d); $("voiceLog").scrollTop = $("voiceLog").scrollHeight;
}
function speak(text) {
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.replace(/[■#*]/g, "")); u.lang = "ja-JP"; u.rate = 1.5;
    window.speechSynthesis.speak(u);
  } catch (e) {}
}
/* 連続する同一フレーズの重複を1回に圧縮(音声認識の重複バグ対策) */
function dedupRepeats(s) {
  s = String(s || "").replace(/\s+/g, " ").trim();
  let prev;
  do { prev = s; s = s.replace(/(.{3,}?)\1+/g, "$1"); } while (s !== prev);
  return s;
}
let voiceListening = false, voiceAccum = "", voiceSessionFinal = "";
/* メカ君の読み上げだけ止める */
$("btnVoiceMute").addEventListener("click", () => {
  try { window.speechSynthesis.cancel(); } catch (e) {}
  $("voiceStatus").textContent = "読み上げを止めました。「押して話す」で続けられます。";
});
/* 1セッションの音声認識(無音で切れても voiceListening 中は自動再開して待ち続ける) */
function startVoiceSession() {
  const rec = getSpeechRecognition(); if (!rec) { voiceListening = false; return; }
  rec.continuous = true; rec.interimResults = true;
  voiceRec = rec; voiceSessionFinal = "";
  rec.onresult = e => {
    // 毎回 全結果から作り直す(重複・連結バグ防止)
    let f = "", interim = "";
    for (let i = 0; i < e.results.length; i++) {
      if (e.results[i].isFinal) f += e.results[i][0].transcript; else interim += e.results[i][0].transcript;
    }
    voiceSessionFinal = f;
    $("voiceStatus").textContent = "🎤 " + dedupRepeats(voiceAccum + f + interim);
  };
  rec.onerror = () => {};
  rec.onend = () => {
    voiceAccum += voiceSessionFinal; voiceSessionFinal = ""; voiceRec = null;
    if (voiceListening) { startVoiceSession(); return; }  // 押すまで聞き続ける
    finishVoiceTurn();
  };
  try { rec.start(); } catch (e) { voiceRec = null; }
}
async function finishVoiceTurn() {
  $("btnVoiceTalk").textContent = "🎤 押して話す";
  const said = dedupRepeats(voiceAccum); voiceAccum = "";
  if (!said) { $("voiceStatus").textContent = "聞き取れませんでした。もう一度「押して話す」を。"; return; }
  vcAppend("user", said); voiceHistory.push({ role: "user", text: said });
  $("voiceStatus").textContent = "🔧 メカ君が考えています…";
  try {
    const r = await geminiAsk(buildVoiceChatPrompt(), { mode: "flash" });  // 会話は標準モードで無料枠を節約
    voiceHistory.push({ role: "mecha", text: r.text });
    vcAppend("mecha", r.text); speak(r.text);
    $("voiceStatus").textContent = "「押して話す」でさらに質問できます。読み上げ中は🔇停止や「押して話す」で止められます。";
  } catch (err) {
    $("voiceStatus").textContent = "⚠ " + (err.message || "メカ君に接続できませんでした");
  }
}
$("btnVoiceTalk").addEventListener("click", () => {
  try { window.speechSynthesis.cancel(); } catch (e) {}   // 読み上げ中なら止めて聞き取りへ
  if (voiceListening) {            // 2回目の押下=話し終わり → 停止して送信
    voiceListening = false;
    if (voiceRec) { try { voiceRec.stop(); } catch (e) {} } else { finishVoiceTurn(); }
    $("btnVoiceTalk").textContent = "🎤 押して話す";
    return;
  }
  voiceActive = true; voiceListening = true; voiceAccum = ""; voiceSessionFinal = "";
  $("voiceStatus").textContent = "🎤 聞いています…話し終わったら、もう一度ボタンを押してください。";
  $("btnVoiceTalk").textContent = "■ 話し終えたらタップ";
  startVoiceSession();
});
function buildVoiceChatPrompt() {
  const lines = [
    "あなたは『メカ君』。基本はまじめで頼れるロボット整備士だが、どこかおちゃめで愛嬌がある。一人称は『ボク』。",
    "丁寧で分かりやすい口調(です・ます調)で噛み砕いて話し、時々ちょっとした軽口やユーモアを一言だけ添える(やりすぎない・本題を邪魔しない)。安全と正確さは最優先で、確信が持てない点は正直に『要確認』と伝える。",
    "音声で読み上げるので、簡潔に話し言葉で。箇条書き記号やMarkdown記号は使わず、2〜4文程度で要点を。",
  ];
  if (current.type || current.vin) {
    const code = current.type && current.type.includes("-") ? current.type.split("-")[1] : current.type;
    const v = code ? findVehicle(code) : null;
    lines.push("対象車両: " + (current.type ? "型式 " + current.type : "車台番号 " + current.vin) + (v ? "（" + v.name + "）" : ""));
  }
  lines.push("これまでの会話:");
  voiceHistory.slice(-8).forEach(m => lines.push((m.role === "user" ? "整備士" : "メカ君") + ": " + m.text));
  lines.push("メカ君として次の返答を述べてください。");
  return lines.join("\n");
}

/* =========================================================
   タブ切替・初期化
   ========================================================= */
function switchView(name) {
  if (name !== "scan" && typeof scanning !== "undefined" && scanning) stopLiveScan(false);
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === "view-" + name));
  // 車両のサブページ(メンテ/診断/部品)は下部タブ上「スキャン」を選択状態に
  const tabName = ["maint", "diag", "parts"].includes(name) ? "scan" : name;
  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("active", b.dataset.view === tabName));
  // 共通ナビの現在ページをハイライト(枠だけ色)
  document.querySelectorAll(".pageNav .navBtn").forEach(b => b.classList.toggle("navActive", b.dataset.go === name));
  if (name === "diag") updateDiagVehicleHint();
  if (name === "admin" && window.CloudAdmin) window.CloudAdmin.open();
  window.scrollTo(0, 0);
}
document.querySelectorAll("#tabs button").forEach(b =>
  b.addEventListener("click", () => switchView(b.dataset.view)));

(async function init() {
  loadCustomDB();
  await Promise.all([loadBuiltinDB(), loadDiagDB()]);
  renderHistory();
  renderDBList();
  renderGeminiStat();
  renderVisionStat();
  renderAiMode();
  setText("verNote", "メカノAI v" + APP_VER + " ／ 内蔵DB " + BUILTIN_DB.length + "車種 ＋ カスタム " + CUSTOM_DB.length + "車種。データはすべてこの端末内に保存されます。");
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
