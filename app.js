"use strict";
/*! メカノAI (MECHANO-AI) © 2026 Cablueie. All Rights Reserved. 無断複製・改変・再配布・リバースエンジニアリングを禁じます。 */
/* =========================================================
   車検証スキャン 整備サポート v1.0
   - QR読取(jsQR) + 国交省二次元コード仕様パーサ
   - 車両ノウハウDB(db/vehicles.json + localStorageカスタム)
   - スキャン履歴 / DB編集 / OCRフォールバック
   ========================================================= */

const APP_VER = "1.0.0";
/* 表示バージョン: Service Worker のキャッシュ名(shaken-scan-vNNN)から取得。無ければ APP_VER。 */
async function appVerDisplay() {
  try {
    const keys = await caches.keys();
    const nums = keys.map(k => (String(k).match(/shaken-scan-v(\d+)/) || [])[1]).filter(Boolean).map(Number);
    if (nums.length) return "v" + Math.max(...nums);
  } catch (e) {}
  return "v" + APP_VER;
}
const LS = { hist: "ss_history", custom: "ss_customdb", gemini: "ss_geminikey", aimode: "ss_aimode" };
/* AIが使えるか: 自分のGeminiキーがある or 契約中の店舗(サーバー経由=鍵不要)。*/
function aiOK() { return !!localStorage.getItem(LS.gemini) || !!(window.Cloud && window.Cloud.aiReady && window.Cloud.aiReady()); }

const $ = id => document.getElementById(id);
const toggle = (id, show) => { const el = $(id); if (el) el.classList.toggle("hidden", !show); };
/* 表示モード: personal=個人版(クラウド同期/契約を隠す・BYOK) / corp=法人版(従来通り) */
function getAppMode() { return localStorage.getItem("ss_appmode") === "personal" ? "personal" : "corp"; }
function applyAppMode() {
  const personal = getAppMode() === "personal";
  document.body.classList.toggle("personalMode", personal);
  // 個人版はAPIキーが前提。キー設定を自動で開いて見つけやすく
  if (personal) { const f = $("secAiKeyFold"); if (f) f.open = true; }
}
function setAppMode(m) { localStorage.setItem("ss_appmode", m === "personal" ? "personal" : "corp"); applyAppMode(); }
const setText = (id, t) => { const el = $(id); if (el) el.textContent = t; };
/* メールアドレスらしい文字列か(使用者名・車種名へのメール混入対策) */
const isEmailLike = s => typeof s === "string" && /\S+@\S+\.\S+/.test(s);
const noEmail = s => (isEmailLike(s) ? "" : s);
/* 全角数字→半角(表示用) */
const han = s => String(s == null ? "" : s).replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
/* AI(グラウンディング)が混ぜる引用マーカー・英語注釈を除去して読みやすくする。
   例: 「540〜590 N·m [cite: 17 (from previous search)]」→「540〜590 N·m」 */
const cleanCite = s => String(s == null ? "" : s)
  .replace(/\[\s*cite[^\]]*\]/gi, "")                       // [cite: 17 (from previous search), 29 ...]
  .replace(/【[^】]*(?:cite|search)[^】]*】/gi, "")           // 全角括弧版
  .replace(/\((?:from\s+)?previous\s+search[^)]*\)/gi, "")   // (from previous search)
  .replace(/\[\s*\d+(?:\s*,\s*\d+)*\s*\]/g, "")             // 裸の [17] / [17, 29, 36]
  .replace(/[ \t]{2,}/g, " ")
  .replace(/\s+([、。,.，])/g, "$1")
  .replace(/[\s、,，]+$/g, "")
  .trim();
/* 検索グラウンディング有効時に混入する引用マーカーを、オブジェクト内の全文字列から再帰的に除去 */
function cleanCiteDeep(v) {
  if (typeof v === "string") return cleanCite(v);
  if (Array.isArray(v)) return v.map(cleanCiteDeep);
  if (v && typeof v === "object") { const o = {}; for (const k in v) o[k] = cleanCiteDeep(v[k]); return o; }
  return v;
}
/* 表示用: 全角英数字・記号→半角、全角スペース→半角、連続スペースを1つに整える(履歴などの見栄え統一) */
const dispText = s => String(s == null ? "" : s)
  .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))   // 全角ASCII(英数字・記号)→半角
  .replace(/　/g, " ").replace(/\s+/g, " ").trim();
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

/* フィラー(埋め草)判定: 車検証二次元コードは非該当フィールドを 9999… / 0000… / **** 等で埋める。
   同一文字の連続(長さ4以上)は「未設定」とみなし、正しい値の位置に誤って固定されるのを防ぐ */
function isFiller(v) {
  if (!v) return true;
  const t = String(v).replace(/[\s\-\[\]]/g, "");
  if (t.length < 4) return false;
  return /^(.)\1+$/.test(t) || /^\*+$/.test(t);   // 9999999 / 0000000 / AAAAA / ***** など
}
/* 登録番号(ナンバー)の妥当性: 地名(漢字/かな)＋分類番号＋かな＋一連番号。数字のみ/記号のみは不可 */
function isValidPlate(v) {
  if (!v) return false;
  const t = String(v).trim();
  if (!t) return false;
  if (/^[\d\s\-ー－]+$/.test(t)) return false;          // 数字(と区切り)だけはナンバーではない
  return /[぀-ヿ゠-ヿ㐀-鿿一-龠]/.test(t);              // 地名(漢字)またはかなを含むこと
}

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
      const kata = f[2] && /^\d{5,10}$/.test(f[2]) && !isFiller(f[2]) ? f[2] : null;
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
      const plateRaw = (f[1] || "").replace(/[　 ]+/g, " ").trim();
      if (isValidPlate(plateRaw)) out.plate = plateRaw;   // 地名(漢字/かな)を含むもののみ。数字のみは不可
      const vin = zen2han(f[3] || "").toUpperCase();
      if (/^[A-Z0-9\[\]\-]{4,23}$/.test(vin) && !isFiller(vin)) out.vin = vin;
      // f[4] = 原動機型式 (位置で確定。空欄/伏字/純数字の帳票種別・フィラーは除外)
      const eng = zen2han(f[4] || "").toUpperCase().trim();
      if (eng && !eng.startsWith("*") && /^[A-Z0-9\-]{2,10}$/.test(eng) && !/^\d+$/.test(eng) && !isFiller(eng)) out.engine = eng;
      out.structured = true;
    }
  }
  return out;
}

/* ---- 従来ヒューリスティック(維持・フォールバック) ----
   exclude: 原動機型式など「型式候補にしてはいけない」値の集合 */
function parseHeuristic(fields, exclude = new Set()) {
  let type = null, vin = null, plate = null, engine = null;
  for (const f of fields) {
    const u = zen2han(f).toUpperCase();
    if (!vin && /^[A-Z0-9]{2,8}-[0-9]{5,8}$/.test(u)) { vin = u; continue; }
    // ハイフン付き型式(排ガス記号-車種記号)は型式として確実(エンジン型式と紛れない)
    if (!type && /^[0-9A-Z]{2,4}-[A-Z][A-Z0-9]{2,8}$/.test(u) && !/^[0-9]+$/.test(u.split("-")[1])) { type = u; continue; }
    if (!plate && /[぀-ヿ㐀-鿿]/.test(f) && f.length <= 12) { plate = f; continue; }
    // 単独の短い英数字コード(K6A / EF / 3SZ 等)は原動機型式とみなす。
    // ※ 型式(車種)には入れない → 型式は車台番号の接頭辞 or コード3で確定させる(原動機型式の誤混入を防止)
    if (!engine && !exclude.has(u) && /^[A-Z0-9]{2,7}$/.test(u) && /[A-Z]/.test(u) && !/^\d+$/.test(u)) { engine = u; continue; }
  }
  return { type, vin, plate, engine };
}

function parsePayloads(payloadSet) {
  const list = [...payloadSet];
  const codes = reconstructCodes(list);
  const s = parseStructured(codes);

  const rawFields = [];
  list.forEach(p => p.split("/").forEach(f => { f = f.trim(); if (f) rawFields.push(f); }));
  const uniq = [...new Set(rawFields)];
  // 型式・車台番号・原動機型式(確定済み)はヒューリスティックの再判定から除外
  const exclude = new Set([s.engine, s.vin, s.type].filter(Boolean).map(x => zen2han(x).toUpperCase()));
  const h = parseHeuristic(uniq, exclude);

  // 型式は コード3(f[5]) 優先 → 無ければ車台番号の接頭辞(例 MK21S-149973 → MK21S) → ハイフン付き型式
  const vinVal = s.vin || h.vin || null;
  const vinPref = vinVal ? (vinVal.match(/^([A-Z0-9]{2,8})-\d{3,8}$/) || [])[1] : null;
  let type   = s.type || vinPref || h.type || null;
  let engine = s.engine || h.engine || null;
  // 誤混入是正: 原動機型式が型式欄に入っていたら車台番号接頭辞へ差し替え(無ければ空)
  if (type && engine && type === engine) type = vinPref || null;

  return {
    type:     type,
    vin:      vinVal,
    plate:    s.plate  || h.plate  || null,
    engine:   engine,
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
/* かすれ・低コントラストのQR向け: グレースケール+コントラスト強調(自動レベル補正) */
function boostContrast(canvas) {
  const c = canvas.getContext("2d"), w = canvas.width, h = canvas.height;
  const id = c.getImageData(0, 0, w, h), d = id.data;
  let lo = 255, hi = 0;
  for (let i = 0; i < d.length; i += 4) { const y = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0; d[i] = d[i + 1] = d[i + 2] = y; if (y < lo) lo = y; if (y > hi) hi = y; }
  const range = Math.max(1, hi - lo); const gain = 255 / range;
  // 5〜95パーセンタイル的に締めるのではなく、min-max を 0-255 に線形伸張(軽量)
  for (let i = 0; i < d.length; i += 4) { const v = Math.max(0, Math.min(255, (d[i] - lo) * gain)); d[i] = d[i + 1] = d[i + 2] = v; }
  c.putImageData(id, 0, 0);
}

/* ===== ライブ連続スキャン: QRと文字(OCR)を同時に自動認識して蓄積 ===== */
let scanComplete = false;   // 直前に車両を確定表示したか(次の開始で新規)
let liveStream = null, scanning = false, scanRaf = null, tickBusy = false, tickN = 0, lastHitAt = 0, scanOkPending = false;

/* 統合アキュムレータ: QR・OCR・手動のどれからでも項目を埋めていく */
function freshAcc() { return { type: null, vin: null, engine: null, plate: null, expiry: null, firstReg: null, kataShitei: null, raw: [] }; }
let acc = freshAcc();
function mergeAcc(d) {
  // 読み取り順に依存せず、正しい値を採用する:
  //  ・フィラー(9999999等)は取り込まない  ・既存がフィラーなら実値で上書き
  const fillable = new Set(["type", "vin", "engine", "plate", "kataShitei"]);
  for (const k of ["type", "vin", "engine", "plate", "expiry", "firstReg", "kataShitei"]) {
    const nv = d[k];
    if (!nv) continue;
    const isStr = typeof nv === "string";
    if (fillable.has(k) && isStr && isFiller(nv)) continue;                 // フィラーは無視
    if (k === "plate" && !isValidPlate(nv)) continue;                       // 登録番号は数字のみ不可(地名を含むこと)
    if (!acc[k] || (fillable.has(k) && typeof acc[k] === "string" && isFiller(acc[k]))) acc[k] = nv;  // 空 or 既存フィラーなら採用
  }
  if (d.raw) { const s = new Set(acc.raw); d.raw.forEach(x => x && s.add(x)); acc.raw = [...s]; }
}
function accCode3() { return !!(acc.kataShitei || acc.type); } // コード3(指定・類別)を取得済みか
function accComplete() { return !!(acc.vin && acc.engine); } // 車台番号＋原動機型式が揃えば完了
function accResult() { return { ...acc, raw: acc.raw.length ? acc.raw : [acc.type, acc.engine, acc.vin, acc.plate].filter(Boolean), qrRaw: [...payloads] }; }
function resetScan() { payloads.clear(); acc = freshAcc(); scanComplete = false; scanOkPending = false; tickBusy = false; nativeBusy = false; lastScanProc = 0; lastNewDataAt = 0; lastOcrAt = 0; lastOcrCand = { type: null, vin: null }; if (typeof scanGrace !== "undefined" && scanGrace) { clearTimeout(scanGrace); scanGrace = null; } toggle("scanOK", false); }

$("btnStart").addEventListener("click", startLiveScan);
/* 再スキャン: 状態を初期化しカメラを開き直す(検出が固まった時の確実な復帰手段) */
async function rescanNow() {
  resetScan();
  updateScanProgress(acc);
  toggle("scanProgress", false); toggle("scanActions", false); toggle("qrPhotoStatus", false);
  if (!scanning) { startLiveScan(); return; }
  // スキャン中でもカメラを開き直してピント(AF)・検出状態を初期化 → 失敗後に読めなくなるのを防ぐ
  setScanMsg("カメラを再初期化中…ピントを合わせています");
  nativeBusy = false; tickBusy = false; ocrBusy = false;   // 固まったフラグを解除
  await openCamera(null);
  setScanMsg("再スキャン中: QRを枠内に大きく・はっきり写してください");
}
$("btnStop").addEventListener("click", rescanNow);
$("scanBack").addEventListener("click", goHome);   // スキャン中の「戻る」→ ホームへ

let camList = [], camIdx = 0;

async function startLiveScan() {
  resetScan();   // 新規スキャンは必ず状態を初期化(固まったフラグ・前回データの持ち越しを防ぐ)
  const ok = await openCamera(null);
  if (!ok) {
    toggle("qrPhotoStatus", true);
    $("qrPhotoStatus").innerHTML = "カメラを起動できませんでした（権限・対応状況をご確認ください）。<br>下の「写真で1枚ずつ撮影」もお試しください。";
    return;
  }
  toggle("scanWrap", true); toggle("scanCtrls", true); toggle("btnStart", false); toggle("btnStop", true); toggle("btnStopRow", true);
  toggle("scanActions", true);
  toggle("mechaHero", false); document.body.classList.add("scanningNow");   // スキャン中はメカ君を隠しカメラを画面中央へ
  updateScanProgress(acc);
  setScanMsg("自動で読み取り中… 車検証のQRを枠内に大きく写してください");
  scanning = true; tickBusy = false; tickN = 0; lastOcrAt = 0; scanTick();
}

/* カメラを開く(deviceId指定可)。AF/ズーム/ライト/レンズ一覧を設定 */
async function openCamera(deviceId) {
  if (liveStream) { liveStream.getTracks().forEach(t => t.stop()); liveStream = null; }
  // 指定が無ければ、前回ユーザーが選んだ「接写に強いレンズ」を優先(ラベルで照合)。
  // これで機種ごとに毎回カメラ切替をしなくて済む。初回は環境カメラ(背面)を使う。
  if (!deviceId) {
    try {
      const savedLabel = localStorage.getItem("ss_camLabel");
      if (savedLabel) {
        const devs = await navigator.mediaDevices.enumerateDevices();
        const m = devs.find(d => d.kind === "videoinput" && d.label === savedLabel);
        if (m) deviceId = m.deviceId;
      }
    } catch (e) {}
  }
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
  if (ok) {
    // 選んだレンズを記憶(次回から自動でこのレンズを使う=毎回の切替が不要に)
    try { const lbl = camList[camIdx].label || (liveStream.getVideoTracks()[0] || {}).label; if (lbl) localStorage.setItem("ss_camLabel", lbl); } catch (e) {}
  } else setScanMsg("このカメラは使えませんでした。もう一度切替を");
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
  toggle("scanWrap", false); toggle("scanCtrls", false); toggle("btnStart", true); toggle("btnStop", false); toggle("btnStopRow", false); toggle("btnTorch", false);
  document.body.classList.remove("scanningNow");   // カメラ中央表示を解除
  if (show && (acc.type || acc.vin || acc.plate || acc.engine)) { scanComplete = true; showResult(accResult(), { fromScan: true }); }
  else { toggle("mechaHero", true); toggle("scanProgress", false); toggle("scanActions", false); toggle("qrPhotoStatus", false); }   // キャンセル時はメカ君を戻し進捗・やり直しを閉じる
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
  if (!data || payloads.has(data)) return;   // 同じQRの再読は無視(進捗にならない)
  payloads.add(data);
  lastNewDataAt = Date.now();   // 新しいQRを取得 → 進捗あり(直後は少しZXingを休ませる)
  if (navigator.vibrate) navigator.vibrate(50);
  flashScan();   // 読み取れた瞬間に緑フラッシュ(見える化)
  mergeAcc(parsePayloads(payloads));
  afterScanUpdate("QR");
}
/* 文字(OCR)検出時。壁の模様・影などの誤検出を防ぐため、
   同じ値が2回連続で読めた項目だけを採用する(1回だけの値は捨てる)。QRは正確なので対象外。 */
let lastOcrCand = { type: null, vin: null };
function onLiveText(d) {
  const use = {};
  if (d.type && d.type === lastOcrCand.type) use.type = d.type;   // 前回と一致した型式のみ採用
  if (d.vin && d.vin === lastOcrCand.vin) use.vin = d.vin;        // 前回と一致した車台番号のみ採用
  lastOcrCand = { type: d.type || null, vin: d.vin || null };
  if (!use.type && !use.vin) return;                              // 初回や不一致(ノイズ)は無視
  const before = acc.type + "|" + acc.vin + "|" + acc.engine;
  mergeAcc(use);
  if (acc.type + "|" + acc.vin + "|" + acc.engine !== before) {
    if (navigator.vibrate) navigator.vibrate(40);
    flashScan();
    afterScanUpdate("文字");
  }
}
/* 読み取れた瞬間に緑フラッシュ(端末差に依存せず「今読めた」を明示) */
function flashScan() {
  const el = $("scanFlash"); if (!el) return;
  el.classList.remove("hit"); void el.offsetWidth; el.classList.add("hit");
}
let scanGrace = null;
/* サッと1パスで確定: 全項目そろえば即、車両を識別できれば短い猶予で残りを拾って確定 */
function finalizeScan() {
  if (scanOkPending) return;
  if (!acc.vin) return;   // 車台番号が無ければ「✓完了」を出さない(誤OK防止の最後の砦)
  scanOkPending = true; scanning = false;
  if (scanGrace) { clearTimeout(scanGrace); scanGrace = null; }
  setScanMsg("✓ 読み取り完了");
  toggle("scanOK", true);
  if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
  setTimeout(() => { toggle("scanOK", false); scanOkPending = false; stopLiveScan(true); }, 550);  // OKをサッと見せて即表示
}
function afterScanUpdate(src) {
  updateScanProgress(acc);
  // 全項目そろえば即確定(両QRが1フレームに入れば一瞬)
  if (accComplete()) { finalizeScan(); return; }
  // 安定化: 確実な読取である「車台番号(コード2)」を基準に確定。型式だけの曖昧な状態では完了しない。
  if (acc.vin) {
    setScanMsg("✓ 読み取り中… そのままかざしてください");
    // 車台番号が取れたら短い猶予で残りQR(型式コード3)も拾って確定
    if (!scanGrace) scanGrace = setTimeout(() => { scanGrace = null; if (scanning && acc.vin) finalizeScan(); }, 500);
    return;
  }
  // 型式のみ(コード3先読み)の場合は、車台番号(コード2)を必須として待ち続ける。
  // ここで勝手に完了させない → 車台番号 未検出のまま「✓読み取り完了」を出さないため(誤OK防止)。
  if (acc.type) {
    setScanMsg("あと少し: 車台番号側の二次元コード(コード2)も枠に入れてください");
    return;
  }
  setScanMsg("QRを枠内に大きく写してください");
}

let lastScanProc = 0, nativeBusy = false, lastNewDataAt = 0;
async function scanTick() {
  if (!scanning) return;
  const ready = video.readyState >= 2 && video.videoWidth;
  // ① ネイティブ検出(BarcodeDetector=端末カメラと同じエンジン) → かざした瞬間に読める。
  //    一部端末でdetect()のPromiseが返らず固まる対策として700msでタイムアウト。
  //    ※nativeDetectorは殺さない(次フレームで再挑戦)。固まっても下の②ZXingが確実に拾う。
  if (ready && nativeDetector && !nativeBusy) {
    nativeBusy = true;
    Promise.race([
      nativeDetector.detect(video),
      new Promise((_, rej) => setTimeout(() => rej(0), 700)),
    ])
      .then(codes => { if (scanning && codes && codes.length) codes.forEach(c => onLiveQr(c.rawValue)); })
      .catch(() => {})            // タイムアウト/失敗は無視(nativeは残す)
      .finally(() => { nativeBusy = false; });
  }
  // ② ZXing/jsQR を併走。「進捗が無い(=新しいデータが増えていない)」間は常に実行。
  //    → ネイティブが簡単な方のQRを再読し続けても、難しい方のQRにZXing(コントラスト強調等)で本気を出す。
  //    → ネイティブが固まっても検出が止まらない(常時フォールバック)。
  if (ready && !tickBusy && Date.now() - lastScanProc >= 200 && Date.now() - lastNewDataAt > 500) {
    lastScanProc = Date.now(); tickBusy = true; tickN++;
    const vw = video.videoWidth, vh = video.videoHeight;
    try {
      const cropF = (tickN % 2 === 0) ? 0.75 : 0.55;
      const s = Math.floor(Math.min(vw, vh) * cropF);
      cv.width = s; cv.height = s;
      ctx.drawImage(video, (vw - s) >> 1, (vh - s) >> 1, s, s, 0, 0, s, s);
      let dt = decodeCanvas(cv);
      if (!dt) {
        const cap = 1920, sc = Math.min(1, cap / Math.max(vw, vh));
        const w = Math.round(vw * sc), h = Math.round(vh * sc);
        cv.width = w; cv.height = h; ctx.drawImage(video, 0, 0, w, h);
        dt = decodeCanvas(cv);
      }
      if (!dt && tickN % 2 === 0) {
        const s2 = Math.floor(Math.min(vw, vh) * 0.75);
        cv.width = s2; cv.height = s2;
        ctx.drawImage(video, (vw - s2) >> 1, (vh - s2) >> 1, s2, s2, 0, 0, s2, s2);
        boostContrast(cv);
        dt = decodeCanvas(cv);
      }
      if (dt) onLiveQr(dt);
    } catch (e) {}
    tickBusy = false;
  }
  // ③ 券面OCR(型式・車台番号の印字補完): 約2.2秒に1回、別スレッドで
  if (ready && Date.now() - lastOcrAt > 2200 && !ocrBusy) {
    lastOcrAt = Date.now(); ocrBusy = true;
    const oc = grabOcrFrame(video.videoWidth, video.videoHeight);
    getOcrWorker().then(w => w.recognize(oc)).then(({ data }) => {
      if (!scanning) return;
      const d = extractFromOcrText(data.text || "");
      if (d.type || d.vin) onLiveText(d);
    }).catch(() => {}).finally(() => { ocrBusy = false; });
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
  if (o.plate && isValidPlate(o.plate)) d.plate = String(o.plate).trim();
  if (o.kataShitei) d.kataShitei = String(o.kataShitei).replace(/[^0-9]/g, "");
  if (o.expiry) { const dt = new Date(o.expiry); if (!isNaN(dt.getTime())) d.expiry = dt; }
  if (o.firstRegYear && o.firstRegMonth) { const y = +o.firstRegYear, m = +o.firstRegMonth; if (y > 1980 && m >= 1 && m <= 12) d.firstReg = { year: y, month: m }; }
  mergeAcc(d);              // 未取得の項目だけ埋める(既存の正しい値は保持)
  showResult(accResult(), { fromScan: true, noAutoAi: true });  // AI補完も履歴保存。再度の自動AI解析は起動しない(ループ/画面のガタつき防止)
}
/* ===== 写真(車検証)をAI Vision(メカ君)で直接読み取る = 最高精度のフォールバック =====
   QRが読めない/印字が擦れている車検証でも、画像を理解して各項目を構造化抽出する。 */
function buildPhotoReadPrompt() {
  return [
    "あなたは日本の自動車の車両情報を写真から読み取る精密OCRエンジンです。",
    "添付は整備士が現場で撮影した写真で、次のいずれかです: (1)車検証(紙/電子車検証の閲覧アプリ画面) (2)車体のコーションプレート/コーションラベル(金属やシールの銘板。型式・車台番号・原動機型式・型式指定/類別番号等が刻印) (3)整備管理システムやFAINES等のパソコン画面 (4)その他 車両情報が写ったもの。",
    "どの種類の写真でも、写っている車両情報を最大限読み取ること。『車検証ではないから』と読み取りを諦めない。コーションプレートには登録番号や使用者は無いことが多い→その場合はnullでよい。",
    "重要(取り違え防止・桁数と文字種で必ず検証すること):",
    "・型式(type): 排出ガス等の識別記号+ハイフン+英数字。例 3BA-GK5 / 2PG-FW74HZ。",
    "・車台番号(vin): 英数字(+ハイフン)。例 GK5-1234567 / FW74HZ-510123。",
    "・原動機の型式(engine): 短い英数字。例 L15B / N04C / 2NR。",
    "・登録番号(plate): 地名(漢字)+分類番号+ひらがな+一連番号。例 品川 500 あ 12-34。地名を必ず含める。",
    "・kataShitei: 『型式指定番号(最大5桁)＋類別区分番号(最大4桁)』の連結数字。現行車は9桁/旧車は7桁。大型・特装・輸入車には無い(null)。原動機型式や帳票番号を入れない。",
    "読み取れない項目はnull。推測や9999等のダミーで埋めない。英数字は半角・大文字。日付は西暦。",
    "出力は厳密なJSONのみ(前後に文章・コードフェンス不要)。キーは以下:",
    '{"type":型式, "vin":車台番号, "engine":原動機型式, "plate":登録番号, "kataShitei":型式指定番号類別区分番号(数字のみ連結), "expiry":有効期間満了日(YYYY-MM-DD), "firstRegYear":初度登録の西暦年(数値), "firstRegMonth":初度登録の月(数値), "name":使用者の氏名又は名称, "model":車名(メーカー)}',
  ].join("\n");
}
/* 画像を長辺maxDimまで縮小しJPEG base64化(通信量削減・AI精度は維持) */
async function fileToJpegBase64(file, maxDim, quality) {
  try {
    const img = await loadImageEl(file);
    let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const sc = Math.min(1, (maxDim || 1800) / Math.max(w, h));
    w = Math.max(1, Math.round(w * sc)); h = Math.max(1, Math.round(h * sc));
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    c.getContext("2d").drawImage(img, 0, 0, w, h);
    const durl = c.toDataURL("image/jpeg", quality || 0.85);
    const i = durl.indexOf("base64,");
    return i >= 0 ? durl.slice(i + 7) : durl.slice(durl.indexOf(",") + 1);
  } catch (e) { return await fileToBase64(file); }   // 変換失敗時は原本を送る
}
async function readShakenPhotoAI(file) {
  const data = await fileToJpegBase64(file, 1800, 0.85);
  const r = await geminiAskMedia(buildPhotoReadPrompt(), [{ mimeType: "image/jpeg", data }]);
  const obj = extractJson(r.text);
  if (!obj) throw new Error("AIの応答を解釈できませんでした");
  return obj;
}
let aiQrDone = false;   // 同じ読取で二重解析しない
async function runAiQrParse(fromAuto) {
  stopFieldMic();
  if (!aiOK()) {
    if (fromAuto) return;   // 自動時はキー未設定なら静かに何もしない(ボタンで手動可)
    alert("QRのAI解析には無料のGemini APIキーの設定が必要です（設定タブ）。");
    switchView("settings"); return;
  }
  const raw = (current.qrRaw && current.qrRaw.length) ? current.qrRaw : [...payloads];
  if (!raw.length) { if (!fromAuto) { toggle("aiQrStatus", true); $("aiQrStatus").textContent = "QRの生データがありません(QRを読み取ってからお試しください)。"; } return; }
  aiQrDone = true;
  toggle("aiQrParse", true); toggle("aiQrStatus", true); $("aiQrStatus").textContent = "🔧 メカ君がQRデータを項目分け中…";
  setBtnLoading($("btnAiQr"), true, "メカ君が解析中…");
  try {
    const r = await geminiAsk(buildQrParsePrompt(raw), { mode: "flash" });   // 構造抽出はflashで高速
    const obj = extractJson(r.text);
    if (!obj) throw new Error("AIの応答を解釈できませんでした。もう一度お試しください。");
    applyAiQr(obj);
    const lines = [];
    if (obj.type) lines.push("型式: " + obj.type);
    if (obj.engine) lines.push("原動機型式: " + obj.engine);
    if (obj.vin) lines.push("車台番号: " + obj.vin);
    if (obj.plate) lines.push("登録番号: " + obj.plate);
    if (obj.kataShitei) lines.push("指定-類別: " + obj.kataShitei);
    if (obj.expiry) lines.push("有効期限: " + obj.expiry);
    if (obj.firstRegYear && obj.firstRegMonth) lines.push("初度登録: " + obj.firstRegYear + "年" + obj.firstRegMonth + "月");
    if (obj.fuel) lines.push("燃料: " + obj.fuel);
    const head = r.model === "cache" ? "🔧 前回のメカ君の解析結果を再利用しました" : "🔧 メカ君がQRを自動解析しました";
    toggle("aiQrParse", true); toggle("aiQrStatus", true);
    $("aiQrStatus").style.whiteSpace = "pre-wrap";
    $("aiQrStatus").textContent = head + "\n" + (lines.length ? "メカ君が読み取った内容:\n・" + lines.join("\n・") : "QRから抽出できる項目がありませんでした。");
  } catch (e) {
    aiQrDone = false;   // 失敗時は再試行できるように
    if (e.message !== "__cancelled__") { toggle("aiQrParse", true); toggle("aiQrStatus", true); $("aiQrStatus").textContent = "⚠ " + (e.message || e); }
  } finally {
    setBtnLoading($("btnAiQr"), false);
  }
}
$("btnAiQr").addEventListener("click", () => runAiQrParse(false));

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
const _btnOcr = $("btnOcr"); if (_btnOcr) _btnOcr.addEventListener("click", () => ocrIn.click());
ocrIn.addEventListener("change", async e => {
  const file = e.target.files[0]; if (!file) return;
  ocrIn.value = "";
  toggle("ocrBox", true);
  $("ocrPreview").src = URL.createObjectURL(file);
  if (scanComplete) resetScan();
  // ① AI Vision(メカ君)が使えるなら、写真から全項目を高精度で直接読み取る(最優先)
  if (aiOK()) {
    $("ocrStatus").innerHTML = '<img src="img/kangae.png" class="btnMecha spin" alt=""> メカ君が車検証を読み取り中…（高精度）';
    try {
      const obj = await readShakenPhotoAI(file);
      if (obj && (obj.type || obj.vin || obj.plate || obj.engine || obj.kataShitei)) {
        applyAiQr(obj);   // 既存の項目マージ＋結果表示を再利用(型式/車台/原動機/登録番号/指定類別/有効期限/初度登録)
        if (obj.name) { try { const nm = String(obj.name).trim(); if (nm) { saveUserName(nm); setText("rUser", nm); } } catch (_) {} }
        const parts = [acc.type, acc.vin].filter(Boolean).join(" / ");
        $("ocrStatus").innerHTML = "✓ メカ君が読み取りました（" + (parts || "各項目") + "）。誤りがあれば各項目をタップして修正できます。";
        return;
      }
      $("ocrStatus").innerHTML = "AIが項目を特定できませんでした。通常OCRで再挑戦します…";
    } catch (err) {
      $("ocrStatus").innerHTML = "AI読み取りに失敗（" + (err.message || err) + "）→ 通常OCRに切替…";
    }
  }
  // ② フォールバック: OCR(Cloud Vision / 無料Tesseract) + 正規表現抽出
  try {
    if (!aiOK()) $("ocrStatus").innerHTML = "OCR を準備中…(初回はモデル取得に少し時間がかかります)";
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
function visionEnabled() {
  if (localStorage.getItem("ss_usevision") === "1" && !!localStorage.getItem("ss_visionkey")) return true;
  return !!(window.Cloud && window.Cloud.aiReady && window.Cloud.aiReady());   // 契約店舗はサーバー経由で高精度OCR
}
async function ocrCloudVision(file) {
  const key = localStorage.getItem("ss_visionkey");
  const data = await fileToBase64(file);
  // ローカル鍵が無くても契約中の店舗はサーバー(visionOcr)経由でOCR
  if (!key && window.Cloud && window.Cloud.aiReady && window.Cloud.aiReady()) {
    const d = await window.Cloud.callFn("visionOcr", { imageBase64: data });
    return (d && d.text) || "";
  }
  if (!key) throw new Error("Cloud Vision APIキー未設定");
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
$("lnkShowOcr").addEventListener("click", () => {
  if (typeof scanning !== "undefined" && scanning) stopLiveScan(false);   // QRモードを止める(起動したまま残らないように)
  toggle("scanProgress", false); toggle("scanActions", false);            // 未取得・やり直しを閉じる
  foldEntryAreas(); toggle("lastVehicle", false); toggle("ocrArea", true); ocrIn.click();
});
{ const lm = $("lnkShowManual"); if (lm) lm.addEventListener("click", () => {
  if (!$("manualArea").classList.contains("hidden")) { toggle("manualArea", false); return; }   // 再タップで閉じる
  foldEntryAreas(); toggle("lastVehicle", false); toggle("manualArea", true); $("manualType").focus();
}); }
$("lnkShowPlate").addEventListener("click", () => {
  if (!$("plateArea").classList.contains("hidden")) { toggle("plateArea", false); return; }   // 再タップで閉じる
  foldEntryAreas(); toggle("lastVehicle", false); toggle("plateArea", true); renderPlateSearch();
});

/* ナンバー検索 (使用者名でも引ける・部分一致) */
function renderPlateSearch() {
  const q = normPlate($("plateSearch").value);
  const qRaw = $("plateSearch").value.trim();
  const box = $("plateResults"); box.innerHTML = "";
  const hist = dedupeHistoryStore().filter(h => h.plate || h.name || h.model || h.type);
  if (!hist.length) { box.innerHTML = '<div class="empty">保存済みの車両がまだありません。<br>スキャンするとナンバーが自動保存されます。</div>'; return; }
  const matches = (q || qRaw)
    ? hist.filter(h =>
        (h.plate && normPlate(h.plate).includes(q)) ||
        (qRaw && h.name && h.name.includes(qRaw)) ||
        (qRaw && h.model && h.model.includes(qRaw)) ||
        (qRaw && h.type && h.type.toUpperCase().includes(qRaw.toUpperCase())))
    : hist.slice(0, 10);
  if (!matches.length) { box.innerHTML = '<div class="empty">一致する車両がありません。</div>'; return; }
  matches.slice(0, 20).forEach(h => {
    const div = document.createElement("div"); div.className = "histItem";
    const main = document.createElement("div"); main.className = "hMain";
    main.innerHTML = '<div class="hType">' + esc(dispText(h.plate) || "ナンバー未登録") + (h.name ? ' <span style="font-weight:400">／ ' + esc(dispText(h.name)) + '</span>' : '') + '</div>' +
      '<div class="hSub">' + esc(dispText(h.model || h.type) || "型式不明") + " ・ " + esc(dispText(h.vin) || "車台番号なし") + '</div>';
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
{ const b = $("btnCopyQrRaw"); if (b) b.addEventListener("click", async () => {
  const raw = (current && current.qrRaw && current.qrRaw.length) ? current.qrRaw : [...payloads];
  const txt = raw.length ? raw.join("\n") : "(QR生データなし)";
  try { await navigator.clipboard.writeText(txt); b.textContent = "✓ コピーしました"; setTimeout(() => b.textContent = "🔎 QR生データをコピー（不具合報告用）", 1600); }
  catch (e) { alert(txt); }
}); }
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
  // 手動修正後は自動AI-QR解析を起動しない(空白訂正がキャッシュのAI結果で元に戻るのを防ぐ)
  showResult(current, { fromScan: true, noAutoAi: true });   // 再描画＋履歴に統合保存(自動保存)
  saveUserName(user); setText("rUser", user || "—");   // 空欄なら空欄で上書き(誤入力の訂正クリアを反映)
  registerVehicleToDB();   // 保存と同時にDBの登録車種へ追加/更新
});

/* 「保存（DBに登録）」: 現在の車両をカスタムDB(登録車種一覧)へ追加/更新 */
function escRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
const VALID_MAKERS = new Set([...Object.keys(MAKER_RECALL), "other"]);
function registerVehicleToDB(opt = {}) {
  const d = current;
  if (!d || (!d.vin && !d.type && !d.plate)) { return false; }
  const histE = findHistEntry(getHistory(), d) || {};
  const learned = getLearned(vehicleKey(d)) || {};
  const user = noEmail(histE.name) || null;   // 使用者にメールが混入していたら使わない
  // 型式マッチ = 車台番号のハイフンより前の英数字(例: FW74HZ-510123 → FW74HZ)
  const prefixRaw = vinPrefix(d.vin);
  const prefix = prefixRaw ? prefixRaw.toUpperCase().replace(/[^A-Z0-9]/g, "") : null;
  // 車種名 = 車台番号(先頭)から内蔵DB検索した車種名 > メンテAIで取得した車種名 > 代替
  // ※自分が保存したカスタムレコードに自己ヒットしないよう内蔵DBのみを検索
  const found = prefix ? findBuiltinVehicle(prefix) : null;
  const aiModel = noEmail(histE.model || learned.model) || null;
  const name = noEmail((found && found.name) || aiModel || user || d.plate || d.vin || d.type) || "無名車両";
  const match = prefix
    || (d.type ? escRegex(String(d.type.includes("-") ? d.type.split("-")[1] : d.type).toUpperCase()) : (d.kataShitei || escRegex(name)));
  // メーカー = DB一致のメーカー > AI推定メーカー(有効なキーのみ) > 既存 > other
  const aiMaker = histE.maker || learned.maker || null;
  const maker = (found && found.maker) || (VALID_MAKERS.has(aiMaker) ? aiMaker : null) || null;
  const specs = (histE.specs && histE.specs.length ? histE.specs : learned.specs) || [];
  const faults = (histE.faults && histE.faults.length ? histE.faults : learned.faults) || [];
  // DBは「登録車種」なので同じ型式は1件に統一(重複を避ける)。型式 > 車台番号 > 車種名+型式 の順で既存を探す
  let rec = (match && CUSTOM_DB.find(x => x.match && x.match === match))
    || (d.vin && CUSTOM_DB.find(x => x.vin && x.vin === d.vin))
    || CUSTOM_DB.find(x => x.name === name && x.match === match);
  const isNew = !rec;
  if (isNew) { rec = { id: "c" + Date.now(), maker: "other" }; CUSTOM_DB.unshift(rec); }
  // 手動編集済みレコードは車種名(と型式マッチ・メーカー)を「正データ」として尊重し、AI/内蔵推定で上書きしない。
  // 諸元・持病はユーザーの訂正で常に更新されるべきなのでロックしない(他端末へ反映させる)。
  const locked = !!rec.manual;
  Object.assign(rec, {
    name: locked ? rec.name : name,
    match: locked ? (rec.match || match) : match,
    maker: locked ? (rec.maker || "other") : (maker || rec.maker || "other"),
    vin: d.vin || rec.vin || null, engine: d.engine || rec.engine || null,
    plate: d.plate || rec.plate || null, kataShitei: d.kataShitei || rec.kataShitei || null,
    user: user || rec.user || null,
    faults: faults.length ? faults : (rec.faults || []),
    specs: specs.length ? specs : (rec.specs || []),
    notes: rec.notes || "",
    updatedAt: Date.now(),   // 同期時に古いクラウドで上書きされないよう更新時刻を記録
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
    if (aiOK() && shownSpecs.length === 0 && !$("specAiBox").textContent.trim()) $("btnSpecAI").click();
  }
  // 診断・部品はタブを開いた時点では入力欄にフォーカスしない(自動でキーボードが出るのを防ぐ)
}
$("btnGoMaint").addEventListener("click", () => goVehiclePage("maint"));
$("btnGoDiag").addEventListener("click", () => goVehiclePage("diag"));
$("btnGoParts").addEventListener("click", () => goVehiclePage("parts"));
$("btnGoKarte").addEventListener("click", () => goVehiclePage("karte"));
/* 全ページ共通ナビ(← 車両 / メンテ / 診断 / 部品) */
document.querySelectorAll(".pageNav .navBtn").forEach(b =>
  b.addEventListener("click", () => {
    const go = b.dataset.go;
    if (go === "scan") switchView("scan"); else goVehiclePage(go);
  }));

/* ===== 部品の洗い出し + 部品商への注文リスト ===== */
function buildPartsBreakdownPrompt(part) {
  return [
    "あなたは日本の自動車整備士を支援するベテランメカニックです。次の車両で『指定の部品交換/作業』を行う際に、部品商へ注文すべき部品を洗い出してください。",
    "含めるもの: ①作業対象の本体部品(正式名称)、②同時交換が必須または強く推奨される部品(ガスケット/オイルシール/Oリング/一度使用のボルト・ナット/割ピン/クリップ/ロックワッシャ等)、③消耗品(オイル/クーラント/グリス/ブレーキフルード等)。",
    "各部品は日本の整備現場で通じる正式名称で。純正品番が推定できれば目安を書き、不確かなら「要確認」。数量も。分からない項目は正直に空/要確認。",
    "出力は厳密なJSONのみ(前後の文章・コードフェンス不要)。形式:",
    '{"official":"作業対象の正式部品名/作業名","note":"補足(あれば)","items":[{"name":"部品の正式名称","qty":"1","kind":"本体|同時交換必須|消耗品","partno":"純正品番の目安 または 要確認","memo":"補足(サイズ・容量・左右等)"}]}',
    "kindは必ず『本体』『同時交換必須』『消耗品』のいずれか。同時交換必須が無ければその項目は省略可。",
    "",
    "■対象車両: " + vehicleDesc(),
    "■部品/作業: " + part,
  ].join("\n");
}
let lastOrderText = "";
function renderPartsBreakdown(box, obj, part) {
  const items = Array.isArray(obj.items) ? obj.items.filter(i => i && i.name) : [];
  if (!items.length) { box.innerHTML = '<div class="hint">部品を洗い出せませんでした。表記を変えて再度お試しください。</div>'; return; }
  const kinds = [["本体", "部品本体"], ["同時交換必須", "同時交換が必須・推奨"], ["消耗品", "消耗品・油脂類"]];
  let html = '<div class="ai-h">' + esc(han(obj.official || part)) + ' に必要な部品</div>';
  if (obj.note) html += '<div class="ai-p">' + esc(han(obj.note)) + '</div>';
  kinds.forEach(([k, label]) => {
    const list = items.filter(i => (i.kind || "本体") === k);
    if (!list.length) return;
    html += '<div class="partsGroup"><div class="partsGroupT">' + label + '</div>';
    list.forEach(i => {
      html += '<div class="partsItem"><div class="pName">' + esc(han(i.name)) + (i.qty ? ' <span class="pQty">×' + esc(han(String(i.qty))) + '</span>' : "") + '</div>' +
        '<div class="pMeta">' + (i.partno ? "品番: " + esc(han(i.partno)) : "品番: 要確認") + (i.memo ? " ／ " + esc(han(i.memo)) : "") + '</div></div>';
    });
    html += '</div>';
  });
  // 部品商への注文リスト(コピー/共有しやすいテキスト)
  const head = "【部品注文リスト】\n車種: " + (currentVehicleFacts().model || "—") + " ／ 型式: " + (current.type || "—") +
    (current.vin ? " ／ 車台番号: " + current.vin : "") + "\n作業: " + (obj.official || part) + "\n";
  const lines = items.map(i => "・" + i.name + (i.qty ? " ×" + i.qty : "") + (i.partno && i.partno.indexOf("要確認") < 0 ? "（品番: " + i.partno + "）" : "") + (i.memo ? " " + i.memo : ""));
  lastOrderText = head + lines.join("\n") + "\n※品番は要確認。";
  html += '<div class="orderBox"><div class="orderT">📋 部品商への注文リスト</div><pre class="orderPre" id="orderPre"></pre>' +
    '<div class="btnRow"><button class="btn btn-amber btn-sm" id="btnOrderCopy">コピー</button><button class="btn btn-ghost btn-sm" id="btnOrderShare">共有・メール</button></div></div>';
  box.innerHTML = html;
  $("orderPre").textContent = lastOrderText;
  $("btnOrderCopy") && $("btnOrderCopy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(lastOrderText); $("btnOrderCopy").textContent = "✓ コピーしました"; setTimeout(() => { const b = $("btnOrderCopy"); if (b) b.textContent = "コピー"; }, 1500); }
    catch (e) { const p = $("orderPre"); const r = document.createRange(); r.selectNodeContents(p); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  });
  $("btnOrderShare") && $("btnOrderShare").addEventListener("click", async () => {
    const title = "部品注文リスト";
    if (navigator.share) { try { await navigator.share({ title, text: lastOrderText }); return; } catch (e) { if (e && e.name === "AbortError") return; } }
    location.href = "mailto:?subject=" + encodeURIComponent(title) + "&body=" + encodeURIComponent(lastOrderText);
  });
}
let partsBusy = false;
$("btnPartsGo") && $("btnPartsGo").addEventListener("click", async () => {
  stopFieldMic();
  const part = $("partName").value.trim();
  if (!part) { $("partName").focus(); return; }
  if (!vehicleKey(current)) { alert("先に車両を読み込んでください(車台番号や型式が必要です)。"); return; }
  if (!aiOK()) {
    toggle("partsResult", true);
    $("partsResult").innerHTML = '<div class="hint">部品の洗い出しにはAI（無料Geminiキー）の設定が必要です。設定タブで登録してください。</div>';
    return;
  }
  if (partsBusy) return; partsBusy = true;
  const box = $("partsResult"); toggle("partsResult", true);
  box.innerHTML = '<div class="stepFigLoad">🔧 メカ君が必要な部品を洗い出しています…</div>';
  setBtnLoading($("btnPartsGo"), true, "メカ君が調べ中…");
  try {
    const r = await geminiAsk(buildPartsBreakdownPrompt(part));
    const obj = extractJson(r.text);
    if (obj && (obj.items || obj.official)) renderPartsBreakdown(box, obj, part);
    else renderAiAnswer(box, r.text);
  } catch (e) {
    if (e.message !== "__cancelled__") box.innerHTML = "⚠ " + esc(e.message || "AIへの接続に失敗しました");
  } finally {
    partsBusy = false; setBtnLoading($("btnPartsGo"), false);
  }
});
$("btnPartsClear") && $("btnPartsClear").addEventListener("click", () => {
  cancelAI();
  $("partName").value = "";
  $("partsResult").innerHTML = ""; toggle("partsResult", false);
  $("partsLinks").innerHTML = "";
  $("partsLoc").innerHTML = ""; toggle("partsLoc", false);
});

/* 部品の取り付け位置: この車両でどこにあるかを文章＋図＋Web画像リンクで表示 */
let partsLocBusy = false;
$("btnPartsLoc") && $("btnPartsLoc").addEventListener("click", async () => {
  stopFieldMic();
  const part = $("partName").value.trim();
  if (!part) { $("partName").focus(); return; }
  const carName = figureVehicleDesc();
  const q = ((currentVehicleFacts().model || current.type || "") + " " + part + " 取り付け位置").trim();
  const linkHtml = '<a class="linkbtn" target="_blank" rel="noopener" href="https://www.google.com/search?q='
    + encodeURIComponent(q) + '&tbm=isch">🔍 実物の取り付け位置をWebの画像で探す<span class="arr">↗</span></a>';
  const box = $("partsLoc"); toggle("partsLoc", true);
  if (!aiOK()) {
    box.innerHTML = '<div class="hint">AIの解説には無料Geminiキー設定が必要です（設定タブ）。Web画像リンクはそのまま使えます。</div>' + linkHtml;
    return;
  }
  if (partsLocBusy) return; partsLocBusy = true;
  box.innerHTML = '<div class="stepFigLoad">🔧 メカ君が「' + esc(part) + '」の取り付け位置を調べています…(十数秒〜30秒ほど)</div>';
  setBtnLoading($("btnPartsLoc"), true, "位置を調べ中…");
  try {
    // ①場所の文章解説
    const locPrompt = [
      "あなたは自動車整備士向けのアドバイザーです。次の車両で、指定部品が『どこに付いているか』を現場目線で簡潔に説明してください。",
      "含める: どの区画か(エンジンルーム/車両下部/室内/トランク等)、周囲の目印になる部品との位置関係、アクセス方法(上から/下から/カバーを外す等)、左右・前後。前置き不要。Markdown記号は使わず3〜5行で。確信が持てない点は「（要確認）」。",
      "■対象車両: " + vehicleDesc(),
      "■部品: " + part,
    ].join("\n");
    const r = await geminiAsk(locPrompt);
    // ②取り付け位置の図(実物に忠実な図→イラスト化の二段。失敗はスキップ)
    let imgHtml = "";
    try {
      let refDesc = ""; try { refDesc = await geminiStepVisualRef(part + " の取り付け位置", carName); } catch (e) { if (e && e.message === "__cancelled__") throw e; }
      let refInline = null;
      try { const p = await geminiGenImage(buildPartLocationPhotoPrompt(part, carName, refDesc)); if (p) refInline = dataUrlToInline(p); } catch (e) { if (e && e.message === "__cancelled__") throw e; }
      const dataUrl = await geminiGenImage(buildPartLocationImagePrompt(part, carName, refDesc, !!refInline), refInline ? { refImages: [refInline] } : undefined);
      if (dataUrl) imgHtml = '<div class="stepFigSvg"><img alt="取り付け位置" src="' + dataUrl + '"></div><div class="stepFigCap">メカ君が描いた取り付け位置の参考図（イメージ）</div>';
    } catch (e) { if (e && e.message === "__cancelled__") throw e; }
    const textHtml = '<div class="ai-answer">' + esc(r.text).replace(/\n/g, "<br>") + '</div>';
    box.innerHTML = textHtml + imgHtml + linkHtml;
  } catch (e) {
    box.innerHTML = (e && e.message === "__cancelled__" ? "" : '<div class="hint">⚠ ' + esc(e.message || "取得に失敗しました") + '</div>') + linkHtml;
  } finally {
    partsLocBusy = false; setBtnLoading($("btnPartsLoc"), false);
  }
});

/* この車両について質問(AI Q&A) */
let vehAskBusy = false;
$("btnVehClear").addEventListener("click", () => {
  cancelAI();
  $("qVehText").value = ""; autoGrow($("qVehText"));
  $("qVehResult").innerHTML = ""; toggle("qVehResult", false);
  clearVehAttachments();
});
$("btnVehAsk").addEventListener("click", async () => {
  stopFieldMic();
  const q = $("qVehText").value.trim();
  if (!q && !vehAttachments.length) { $("qVehText").focus(); return; }
  if (!aiOK()) {
    alert("質問するには設定タブで無料のGemini APIキーを設定してください。");
    switchView("settings"); return;
  }
  if (vehAskBusy) return; vehAskBusy = true;
  const box = $("qVehResult"); toggle("qVehResult", true);
  box.innerHTML = '<div class="stepFigLoad">🔧 メカ君が考えています…</div>';
  const btn = $("btnVehAsk"); setBtnLoading(btn, true, "メカ君が考え中…");
  try {
    const qFull = q || "添付した写真の部位について教えてください。";
    let r;
    if (vehAttachments.length) {   // 写真添付あり: 画像も一緒にメカ君へ送る
      const media = [];
      for (const a of vehAttachments) media.push({ mimeType: cleanMime(a.file.type, "image/jpeg"), data: await fileToBase64(a.file) });
      r = await geminiAskMedia(buildRepairPrompt(qFull, true), media);
    } else {
      // 工具サイズ・トルクを実際に調べさせるため、Google検索グラウンディング＋高精度モードで問い合わせる
      r = await geminiAsk(buildRepairPrompt(qFull), { mode: "pro", search: true });
    }
    const obj = cleanCiteDeep(extractJson(r.text));   // 検索グラウンディングの引用マーカーを全項目から除去
    if (obj && obj.isWork && Array.isArray(obj.steps) && obj.steps.length) renderRepairAnswer(box, obj, qFull);
    else renderAiAnswer(box, (obj && obj.answer) ? obj.answer : r.text);
  } catch (e) {
    if (e.message !== "__cancelled__") box.textContent = "⚠ " + (e.message || "AIへの接続に失敗しました");
  } finally {
    vehAskBusy = false; setBtnLoading(btn, false);
  }
});
/* 修理質問プロンプト(作業名なら構造化JSON、質問なら文章)。hasMedia=添付写真あり */
function buildRepairPrompt(q, hasMedia) {
  return [
    "あなたは『メカ君』。まじめで頼れるロボ整備士。次の車両の修理について答える。出力は厳密なJSONのみ(前後の文章・コードフェンス不要)。",
    hasMedia ? "添付された写真(複数の場合あり)をよく観察し、写っている部位・部品・損傷・警告灯・漏れ・摩耗などを踏まえて回答すること。写真から部品名や作業を推定できる場合は具体的に述べる。" : "",
    "入力が『パッド交換』のような作業名・部品名なら isWork=true とし、下記を埋める。単なる質問なら isWork=false とし answer に文章(見出しは■、箇条書きは・)で答える。",
    "形式: {\"isWork\":true,\"location\":\"取り付け位置の説明(区画・周囲の目印・アクセス方法・左右前後)\",\"time\":\"標準作業時間の目安(要確認可)\",\"order\":[{\"name\":\"部品名\",\"qty\":\"1\",\"kind\":\"本体\"または\"同時交換推奨\",\"step\":2}],\"torque\":\"締付トルク・規定値(調べた具体値。無ければ空)\",\"special\":\"特殊工具・整備モード(EPB/SAS/DPF再生/バッテリー登録等。無ければ特になし)\",\"steps\":[{\"text\":\"手順1(安全確保)\",\"tools\":[\"使用する工具1\",\"工具2\"]}],\"answer\":\"\"}",
    "【最重要】location・order・steps・tools・torque はすべて、下記『対象車両』(その車種・型式・原動機)に固有の内容にすること。一般論や別車種の情報にしない。取り付け位置も工具サイズもこの車両に合わせる。",
    "orderには『当該作業の本体部品』と『推奨される同時交換部品(ガスケット/シール/Oリング/一度使用ボルト/クリップ/油脂類等)』を含める。品番は書かない。",
    "各order項目の step は、その部品を実際に取り付け/交換する steps の手順番号(1始まり)。該当が無ければ step は省略。",
    "steps は安全確保→取り外し→取り付け→確認の順。各stepは {text:手順文, tools:その手順で使う工具・計測器の配列}。部品名は該当手順のtextにも登場させる。",
    "toolsは具体的に。ソケット(コマ)・メガネ・スパナは必ず実寸サイズ(mm)を明記(例『ラチェット＋14mmソケット』『12mmメガネレンチ』)、ヘックス/トルクスも番手明記(例『T30トルクス』『6mmヘックス』)。",
    "【工具サイズは必ず調べてから答える】ボルト・ナットの二面幅サイズは、対象車両の整備要領書・部品情報・整備事例・分解レポート等をGoogle検索で実際に調べ、その車両の実サイズを書くこと。『サイズ要確認』『適合サイズを確認』のような逃げの表現は禁止。調べれば分かることを調べずに濁さない。",
    "toolsにトルクレンチが含まれる手順では、その工具名の直後にその締結部の規定トルク値も併記する(例『トルクレンチ(締付 108N·m)』)。トルク値も検索で調べて具体値を書く。",
    "【要確認は最終手段】十分に検索しても確かな一次情報が得られなかった値に限り『（要確認）』とする(逃げの要確認は不可)。ただし誤った数値を書くのは最悪なので、本当に不明な場合のみ要確認とし、創作はしない。",
    "年式・グレードでサイズが異なる場合は、どの年式・グレードの値かを明記して具体値を書く。トルクは整備書(FAINES)での最終確認を促す。",
    "■対象車両: " + vehicleDesc(),
    "■質問/作業: " + q,
    (window.APP_LANG === "en" ? "Fill every JSON string value (location, video title, order names, steps, tools, torque, special, answer) in natural technical English. Keep the JSON keys exactly as specified in English." : ""),
  ].filter(Boolean).join("\n");
}
function ytId(url) { const m = /(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{11})/.exec(String(url || "")); return m ? m[1] : ""; }
/* 検索用の車名(読み取った車両の車種名。無ければ型式)。動画/画像検索がその車両に当たるように */
function searchCarName() { return (currentVehicleFacts().model || current.type || "").trim(); }
function renderRepairAnswer(box, obj, q) {
  const mainPart = (Array.isArray(obj.order) && (obj.order.find(o => o.kind === "本体") || obj.order[0]) || {}).name || q;
  const carName = searchCarName();
  box.innerHTML = "";
  const sec = (label) => { const h = document.createElement("div"); h.className = "ai-h"; h.textContent = label; box.appendChild(h); };
  // ① 取り付け位置(＋交換動画のサムネ・URL)
  if (obj.location) {
    sec("取り付け位置");
    const p = document.createElement("div"); p.className = "ai-p"; p.textContent = han(String(obj.location)); box.appendChild(p);
  }
  // 実写画像はワンタップのWeb検索ボタンで(設定不要)。動画検索の上に配置
  const iq = (carName + " " + mainPart + " 取り付け位置").trim();
  const ia = document.createElement("a"); ia.className = "linkbtn"; ia.target = "_blank"; ia.rel = "noopener";
  ia.href = "https://www.google.com/search?q=" + encodeURIComponent(iq) + "&tbm=isch";
  ia.innerHTML = "🔍 実物の位置をWeb画像で探す<span class='arr'>↗</span>"; box.appendChild(ia);
  // 動画検索
  const yq = (carName + " " + mainPart + " 交換").trim();
  const sa = document.createElement("a"); sa.className = "linkbtn"; sa.target = "_blank"; sa.rel = "noopener";
  sa.href = "https://www.youtube.com/results?search_query=" + encodeURIComponent(yq);
  sa.innerHTML = "▶ YouTubeで交換動画を探す<span class='arr'>↗</span>"; box.appendChild(sa);
  // ② 所要時間
  if (obj.time) { sec("所要時間の目安"); const p = document.createElement("div"); p.className = "ai-p"; p.textContent = han(String(obj.time)); box.appendChild(p); }
  // ③ 部品注文リスト(品番なし・当該作業＋推奨同時交換／部品名タップで手順へ)
  const order = Array.isArray(obj.order) ? obj.order.filter(o => o && o.name) : [];
  if (order.length) {
    const hasRec = order.some(o => o.kind === "同時交換推奨");
    // 見出し右端に凡例(※同時交換推奨)
    const h = document.createElement("div"); h.className = "ai-h orderHead";
    h.innerHTML = '<span>部品注文リスト</span>' + (hasRec ? '<span class="orderLegend">※同時交換推奨</span>' : "");
    box.appendChild(h);
    const list = document.createElement("div"); list.className = "orderBox";
    order.forEach(o => {
      const row = document.createElement("div"); row.className = "orderRow";
      const nm = document.createElement("span"); nm.className = "orderName pic"; nm.textContent = "・" + han(o.name) + (o.qty ? " ×" + han(String(o.qty)) : "");
      nm.title = "タップで部品画像";
      row.appendChild(nm);
      if (o.kind === "同時交換推奨") { const meta = document.createElement("span"); meta.className = "orderMeta"; meta.textContent = "※"; row.appendChild(meta); }
      list.appendChild(row);
      // 部品名タップで実物画像パネルを開閉(初回のみ取得)
      const pane = document.createElement("div"); pane.className = "partPic hidden";
      list.appendChild(pane);
      attachPartPicture(nm, pane, o.name);
    });
    // コピー/共有テキスト(品番なし)
    const head = "【部品注文リスト】\n車種: " + (currentVehicleFacts().model || "—") + " ／ 型式: " + (current.type || "—") + "\n作業: " + q + "\n";
    const orderText = head + order.map(o => "・" + o.name + (o.qty ? " ×" + o.qty : "") + (o.kind === "同時交換推奨" ? "（※同時交換推奨）" : "")).join("\n");
    const bar = document.createElement("div"); bar.className = "btnRow"; bar.style.marginTop = "8px";
    const copy = document.createElement("button"); copy.className = "btn btn-amber btn-sm"; copy.textContent = "コピー";
    copy.addEventListener("click", async () => { try { await navigator.clipboard.writeText(orderText); copy.textContent = "✓ コピー"; setTimeout(() => copy.textContent = "コピー", 1500); } catch (e) {} });
    const share = document.createElement("button"); share.className = "btn btn-ghost btn-sm"; share.textContent = "共有・メール";
    share.addEventListener("click", async () => { if (navigator.share) { try { await navigator.share({ title: "部品注文リスト", text: orderText }); return; } catch (e) { if (e && e.name === "AbortError") return; } } location.href = "mailto:?subject=" + encodeURIComponent("部品注文リスト") + "&body=" + encodeURIComponent(orderText); });
    bar.append(copy, share); list.appendChild(bar);
    box.appendChild(list);
  }
  // ④ この作業で使うソケット・メガネのサイズだけを集約表示(その他の工具は載せない)
  const wrenchSizes = extractWrenchSizes(obj.steps);
  if (wrenchSizes.length) {
    sec("必要なソケット・メガネ");
    const p = document.createElement("div"); p.className = "ai-p wrenchSizes"; p.textContent = wrenchSizes.join("　・　");
    box.appendChild(p);
  }
  // ⑤ 交換手順(タップでその手順の工具を表示・部品名からのジャンプ先アンカー)
  if (Array.isArray(obj.steps) && obj.steps.length) {
    sec("交換手順");
    const ol = document.createElement("ol"); ol.className = "guide-steps ai-list";
    obj.steps.forEach((s, i) => {
      const text = (s && typeof s === "object") ? (s.text || "") : String(s);
      const tools = (s && s.tools && s.tools.length) ? s.tools : [];
      const li = document.createElement("li"); li.id = "rstep-" + (i + 1); li.className = "hasTools";
      const d = document.createElement("div");
      const t = document.createElement("div"); t.className = "ai-cause"; t.textContent = han(text); d.appendChild(t);
      const toolBox = document.createElement("div"); toolBox.className = "stepTools hidden";
      toolBox.innerHTML = tools.length ? '<b>使う工具:</b> ' + tools.map(x => esc(han(String(x)))).join(" ・ ") : "この手順の工具情報はありません。";
      d.appendChild(toolBox);
      li.appendChild(d);
      d.addEventListener("click", () => { toolBox.classList.toggle("hidden"); });   // 案内文言は出さずタップで開閉のみ
      ol.appendChild(li);
    });
    box.appendChild(ol);
  }
  // ⑤ 締付トルク・特殊工具
  if (obj.torque) { sec("締付トルク・規定値"); const p = document.createElement("div"); p.className = "ai-p"; p.textContent = han(String(obj.torque)); box.appendChild(p); }
  if (obj.special && !/特になし/.test(obj.special)) { sec("特殊工具・整備モード"); const p = document.createElement("div"); p.className = "ai-p"; p.textContent = han(String(obj.special)); box.appendChild(p); }
}
/* 交換手順の各工具リストから、ソケット(コマ)・メガネ・スパナのサイズだけを抽出(重複除去)。
   その他の工具(ドライバー・プライヤー等)は対象外。 */
function extractWrenchSizes(steps) {
  const set = new Set();
  (Array.isArray(steps) ? steps : []).forEach(s => {
    const tools = (s && Array.isArray(s.tools)) ? s.tools : [];
    tools.forEach(t => {
      const str = han(String(t || ""));
      // ソケット/コマ/メガネ/スパナ/ボックスレンチ に付くmmサイズ
      if (/(ソケット|コマ|メガネ|スパナ|ボックス)/.test(str)) {
        (str.match(/\d{1,2}(?:\.\d)?\s*mm/gi) || []).forEach(m => set.add(m.replace(/\s+/g, "").toUpperCase().replace("MM", "mm")));
      }
      // ヘックス(六角)・トルクスは番手で
      let m;
      if ((m = str.match(/(?:ヘックス|HEX|六角)[^0-9]{0,4}(\d{1,2})/i))) set.add("HEX" + m[1]);
      if ((m = str.match(/(?:トルクス|TORX|T)\s?(\d{2})/i))) set.add("T" + m[1]);
    });
  });
  return [...set];
}
function jumpToStep(box, n) {
  const li = box.querySelector("#rstep-" + n); if (!li) return;
  li.scrollIntoView({ behavior: "smooth", block: "center" });
  li.classList.remove("stepFlash"); void li.offsetWidth; li.classList.add("stepFlash");
}

/* 車両が変わったら診断・修理タブの前車両データを消す(混ざり防止) */
/* 車両ごとの作業内容(故障診断結果・修理質問)を保持。切替時に前車両を退避し、選んだ車両の内容を復元。 */
const vehWork = {};   // vehicleKey -> {diagText, diagNodes[], qVehText, qVehShown, qVehNodes[]}
function saveVehWork(key) {
  if (!key) return;
  vehWork[key] = {
    diagText: ($("diagText") || {}).value || "",
    diagNodes: $("diagResults") ? [...$("diagResults").childNodes] : [],
    qVehText: ($("qVehText") || {}).value || "",
    qVehShown: $("qVehResult") ? !$("qVehResult").classList.contains("hidden") : false,
    qVehNodes: $("qVehResult") ? [...$("qVehResult").childNodes] : [],
  };
}
function restoreVehWork(key) {
  const w = vehWork[key];
  const setNodes = (id, nodes) => { const el = $(id); if (!el) return; el.innerHTML = ""; (nodes || []).forEach(n => el.appendChild(n)); };
  if ($("diagText")) $("diagText").value = w ? w.diagText : "";
  setNodes("diagResults", w ? w.diagNodes : []);
  if ($("qVehText")) $("qVehText").value = w ? w.qVehText : "";
  setNodes("qVehResult", w ? w.qVehNodes : []);
  toggle("qVehResult", !!(w && w.qVehShown && w.qVehNodes && w.qVehNodes.length));
}

function showResult(d, opt = {}) {
  // 別車両に切り替わったら、前車両の作業内容を退避し、選んだ車両の内容を復元(診断・修理を保持)
  const oldKey = current ? vehicleKey(current) : null;
  const newKey = vehicleKey(d);
  if (oldKey !== newKey) { try { cancelAI(); } catch (e) {} saveVehWork(oldKey); restoreVehWork(newKey); }
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
  setText("rUser", noEmail(histEntry && histEntry.name) || "—");   // メール混入は表示しない
  // QR生データがあり、未取得項目があればAI解析(自動実行・タップ不要)
  current.qrRaw = d.qrRaw && d.qrRaw.length ? d.qrRaw : (current.qrRaw || []);
  // 限定表示項目: 車台番号 / 原動機型式 / 登録番号 / 指定・類別 / 使用者
  const missing = !d.engine || !d.plate || !d.kataShitei;
  toggle("aiQrParse", current.qrRaw.length > 0 && missing);
  toggle("aiQrStatus", false);
  aiQrDone = false;
  // スキャン由来で未取得項目がある時は、メカ君のQR解析を自動で開始(ワンタップ不要)
  if (opt && opt.fromScan && !opt.noAutoAi && current.qrRaw.length > 0 && missing) setTimeout(() => { if (!aiQrDone) runAiQrParse(true); }, 60);
  setText("rEngine", han(d.engine) || "—");
  setText("rVin", han(d.vin) || "未検出");
  setText("rPlate", han(d.plate) || "—");
  setText("rKata", han(formatKata(d.kataShitei)) || "記載なし");
  if (typeof renderCopyKata === "function") renderCopyKata();     // 修理タブのコピーを更新
  if (typeof pushRecentVehicle === "function") pushRecentVehicle(d);  // 表示した車両を記録(前回=最後に表示していた車両)
  toggle("lastVehicle", false);   // 車両を表示中は「前回の車両」チップは出さない(ホームでのみ表示)

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

  // 手動修正済みの正データがあれば、履歴・学習の車種名もそれに揃える(誤特定名の残留を解消)
  if (hit && hit.manual && hit.name) {
    const hh = getHistory(); const te = findHistEntry(hh, d);
    if (te && te.model !== hit.name) { te.model = hit.name; te.updatedAt = Date.now(); localStorage.setItem(LS.hist, JSON.stringify(hh)); if (window.Cloud) window.Cloud.pushRecord(te); }
    if (!learned || learned.model !== hit.name) setLearned(vehicleKey(d), { model: hit.name });
  }
  const m = $("rMatch");
  if (hit) {
    m.textContent = "⚙ 車種DB一致: " + hit.name;
    if (hit.notes) { setText("notesBody", hit.notes); toggle("secNotes", true); } else toggle("secNotes", false);
  } else {
    m.textContent = "";   // 「未登録」表記は出さない(代わりに修正/保存ボタンを設置)
    toggle("secNotes", false);
  }
  renderFaultList(allFaults); toggle("secFault", allFaults.length > 0);
  // 諸元: 「最も新しく更新されたデータ」を表示する(端末間で別IDのDB重複があっても、訂正の取りこぼしを防ぐ)。
  // 候補: DBレコード(hit) / 車両レコード(履歴) / 学習。updatedAtが最大で諸元を持つものを採用。
  const learnedAt = learned && learned.at ? Date.parse(learned.at) || 0 : 0;
  const specCands = [
    { list: hit && hit.specs, t: (hit && hit.updatedAt) || 0, src: "db" },
    { list: histEntry2 && histEntry2.specs, t: (histEntry2 && histEntry2.updatedAt) || 0, src: "learned" },
    { list: learned && learned.specs, t: learnedAt, src: "learned" },
  ];
  let bestSpec = null;
  for (const c of specCands) if (c.list && c.list.length && (!bestSpec || c.t >= bestSpec.t)) bestSpec = c;
  if (bestSpec && bestSpec.list.length) renderSpecs(bestSpec.list, bestSpec.src);
  else renderSpecs([], "");

  // リコール: 同様に最新を優先
  const recallCands = [
    { list: hit && hit.recalls, t: (hit && hit.updatedAt) || 0 },
    { list: histEntry2 && histEntry2.recalls, t: (histEntry2 && histEntry2.updatedAt) || 0 },
    { list: learned && learned.recalls, t: learnedAt },
  ];
  let bestRecall = null;
  for (const c of recallCands) if (c.list && c.list.length && (!bestRecall || c.t >= bestRecall.t)) bestRecall = c;
  const recalls = (bestRecall && bestRecall.list) || [];
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
  toggle("karteForm", false); renderKarte();   // 整備カルテ(車両ごとの作業記録)
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
    if (s.manual) item.classList.add("specManual");
    const k = document.createElement("div"); k.className = "specK"; k.textContent = cleanCite(han(s.k));
    const v = document.createElement("div"); v.className = "specV";
    // 引用マーカーを除去し、「／」区切りや改行を行分けして見やすく表示
    v.innerHTML = esc(cleanCite(han(s.v))).replace(/\n/g, "<br>").replace(/\s*[／/]\s*/g, "<br>");
    const up = document.createElement("button"); up.className = "specItemUp"; up.title = "この項目だけAIで最新に更新"; up.textContent = "🔄";
    up.addEventListener("click", e => { e.stopPropagation(); refreshSpecItem(s.k, up); });
    const hint = document.createElement("div"); hint.className = "specTapHint"; hint.textContent = "タップで編集";
    item.append(up, k, v, hint); dl.appendChild(item);
    item.addEventListener("click", () => { if (!item.classList.contains("editing")) enterSpecItemEdit(item, s.k); });
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

/* 諸元項目をタップ → その場で項目名・値を編集して保存(手動修正) */
function enterSpecItemEdit(item, key) {
  if (!vehicleKey(current)) { alert("車両を識別できないため編集できません(車台番号や指定・類別が必要です)。"); return; }
  const s = shownSpecs.find(x => x.k === key) || { k: key, v: "" };
  item.classList.add("editing"); item.innerHTML = "";
  const ik = document.createElement("input"); ik.type = "text"; ik.className = "seK"; ik.value = s.k; ik.placeholder = "項目名";
  const iv = document.createElement("textarea"); iv.className = "seV"; iv.value = s.v; iv.placeholder = "値・内容"; iv.rows = 2;
  const row = document.createElement("div"); row.className = "specEditInline";
  const save = document.createElement("button"); save.type = "button"; save.className = "btn btn-amber btn-sm"; save.textContent = "保存";
  const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "btn btn-ghost btn-sm"; cancel.textContent = "取消";
  save.addEventListener("click", () => saveSpecItemInline(key, ik.value.trim(), iv.value.trim(), false));
  cancel.addEventListener("click", () => renderSpecs(shownSpecs, "learned"));
  iv.addEventListener("keydown", e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) save.click(); });
  row.append(save, cancel);
  if (isManager()) {   // 諸元の削除は管理者のみ(未ログインの個人利用も可)
    const del = document.createElement("button"); del.type = "button"; del.className = "btn btn-ghost btn-sm"; del.textContent = "削除";
    del.addEventListener("click", () => { if (confirm("この項目を削除しますか？")) saveSpecItemInline(key, "", "", true); });
    row.append(del);
  }
  item.append(ik, iv, row);
  iv.focus();
}
/* 新しい諸元項目を1件、その場編集で追加 */
function addSpecItemInline() {
  if (!vehicleKey(current)) { alert("車両を識別できないため追加できません(車台番号や指定・類別が必要です)。"); return; }
  toggle("secSpec", true); toggle("specList", true);
  const item = document.createElement("div"); item.className = "specItem editing";
  const ik = document.createElement("input"); ik.type = "text"; ik.className = "seK"; ik.placeholder = "項目名(例: エンジンオイル量)";
  const iv = document.createElement("textarea"); iv.className = "seV"; iv.placeholder = "値・内容"; iv.rows = 2;
  const row = document.createElement("div"); row.className = "specEditInline";
  const save = document.createElement("button"); save.type = "button"; save.className = "btn btn-amber btn-sm"; save.textContent = "保存";
  const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "btn btn-ghost btn-sm"; cancel.textContent = "取消";
  save.addEventListener("click", () => saveSpecItemInline(null, ik.value.trim(), iv.value.trim(), false));
  cancel.addEventListener("click", () => renderSpecs(shownSpecs, "learned"));
  ik.addEventListener("keydown", e => { if (e.key === "Enter") iv.focus(); });
  row.append(save, cancel);
  item.append(ik, iv, row);
  $("specList").appendChild(item);
  item.scrollIntoView({ block: "center", behavior: "smooth" });
  ik.focus();
}
function saveSpecItemInline(oldKey, newKey, newVal, remove) {
  let specs = shownSpecs.slice();
  const idx = specs.findIndex(x => x.k === oldKey);
  if (remove) { if (idx >= 0) specs.splice(idx, 1); }
  else {
    if (!newKey) { alert("項目名を入力してください。"); return; }
    const item = { k: newKey, v: newVal, manual: true };   // 手動修正としてマーク(AI更新でも保持)
    if (idx >= 0) specs[idx] = item; else specs.push(item);
  }
  setLearned(vehicleKey(current), { specs });
  saveVehicleAiData(specs, null);
  registerVehicleToDB({ silent: true });
  renderSpecs(specs, "learned");
}

/* =========================================================
   整備カルテ(車両ごとの作業記録) — 写真OCR不要・手入力/音声入力
   履歴レコードの karte 配列に保存し、社内共有(union同期)
   ========================================================= */
/* 2端末で同時追加しても両方残るよう id で統合(削除は deleted フラグでソフト削除) */
function mergeKarte(a, b) {
  const m = {};
  [...(a || []), ...(b || [])].forEach(e => {
    if (!e || !e.id) return;
    const p = m[e.id];
    if (!p || String(e.at || "") > String(p.at || "")) m[e.id] = e;
  });
  return Object.values(m).sort((x, y) =>
    String(y.date || "").localeCompare(String(x.date || "")) || String(y.at || "").localeCompare(String(x.at || "")));
}
function getKarteList() {
  const e = findHistEntry(getHistory(), current);
  return mergeKarte(e && e.karte, []).filter(k => !k.deleted);
}
function saveKarteEntry(entry) {
  let e = findHistEntry(getHistory(), current);
  if (!e) { addHistory(current); e = findHistEntry(getHistory(), current); if (!e) return; }
  const h2 = getHistory();
  const t = findHistEntry(h2, current); if (!t) return;
  const list = (t.karte || []).slice();
  const idx = list.findIndex(k => k.id === entry.id);
  // 記入者(by=uid, byName=氏名)を記録。既存の編集では元の記入者を保持する。
  if (idx >= 0) { entry.by = list[idx].by || entry.by || null; entry.byName = list[idx].byName || entry.byName || null; list[idx] = entry; }
  else { entry.by = (window.Cloud && window.Cloud.myUid && window.Cloud.myUid()) || null; entry.byName = (window.Cloud && window.Cloud.myName && window.Cloud.myName()) || entry.staff || null; list.unshift(entry); }
  t.karte = list; t.updatedAt = Date.now();
  localStorage.setItem(LS.hist, JSON.stringify(h2));
  if (window.Cloud) window.Cloud.pushRecord(t);   // 社内共有へ
  try { reconcileFluidsFromKarte(entry); } catch (e) {}   // 油脂類の実績量で諸元を自動更新
}
/* カルテ編集・削除の権限: 未ログイン(個人利用)=可 / 管理者=常に可 / 従業員=自分が記入した記録のみ */
function canEditKarte(k) {
  if (!window.Cloud || !window.Cloud.isLoggedIn || !window.Cloud.isLoggedIn()) return true;
  if (window.Cloud.isManager && window.Cloud.isManager()) return true;
  const uid = (window.Cloud.myUid && window.Cloud.myUid()) || "";
  if (k && k.by) return k.by === uid;
  // 記入者IDが無い旧データは、担当者名が自分と一致する場合のみ許可
  return !!(k && k.byName && k.byName === (window.Cloud.myName && window.Cloud.myName()));
}
function renderKarte() {
  const box = $("karteList"); if (!box) return;
  box.innerHTML = "";
  if (!current || !vehicleKey(current)) { box.innerHTML = '<div class="hint">車両を読み込むと、その車の作業記録を残せます。まず車検証をスキャンするか、履歴/検索から車両を開いてください。</div>'; return; }
  const list = getKarteList();
  if (!list.length) { box.innerHTML = '<div class="hint">まだ記録がありません。「＋ 記録を追加」から作業内容を残せます。</div>'; return; }
  list.forEach(k => {
    const card = document.createElement("div"); card.className = "karteItem";
    // ヘッダー: 日付/走行/担当 + 編集・削除
    const head = document.createElement("div"); head.className = "kHead";
    const metaBits = [dispText(k.date), k.odo ? han(String(k.odo)) + "km" : "", k.staff ? "担当: " + esc(han(k.staff)) : ""].filter(Boolean);
    head.innerHTML = '<span class="kDate">' + metaBits.join(' <i class="kSep">・</i> ') + '</span>';
    const btns = document.createElement("div"); btns.className = "kBtns";
    if (canEditKarte(k)) {   // 記入者本人・管理者のみ 編集/削除ボタンを表示
      const edit = document.createElement("button"); edit.className = "kEdit"; edit.textContent = "編集";
      edit.addEventListener("click", () => editKarteInline(card, k));
      const del = document.createElement("button"); del.className = "kDel"; del.textContent = "削除";
      del.addEventListener("click", () => {
        if (!confirm("この記録を削除しますか？")) return;
        saveKarteEntry(Object.assign({}, k, { deleted: true, at: new Date().toISOString() }));
        renderKarte();
      });
      btns.append(edit, del);
    }
    head.appendChild(btns);
    // 本文: 作業・部品は「、,改行」で分割して箇条書き。費用・メモは1行。
    const body = document.createElement("div"); body.className = "kBody";
    const block = (label, val) => {
      if (!val) return "";
      const items = String(val).split(/[、,，・\s]+/).map(s => han(s).trim()).filter(Boolean);   // 読点・カンマ・中黒・空白(全角空白含む)・改行で区切る
      if (items.length <= 1) return '<div class="kBlock"><span class="kLbl">' + label + '</span><div class="kVal">' + esc(han(String(val))) + '</div></div>';
      return '<div class="kBlock"><span class="kLbl">' + label + '</span><ul class="kItems">' + items.map(i => '<li>' + esc(i) + '</li>').join("") + '</ul></div>';
    };
    // 部品は「部品名＋数量」を1行に並べ、右側に数量列を作る(数字始まりのトークンを直前の部品名の数量とみなす)
    const partsBlock = (val) => {
      if (!val) return "";
      const toks = String(val).split(/[、,，・\s]+/).map(s => han(s).trim()).filter(Boolean);
      const rows = []; let name = [];
      toks.forEach(t => { if (/^\d/.test(t) && name.length) { rows.push({ n: name.join(" "), q: t }); name = []; } else name.push(t); });
      if (name.length) rows.push({ n: name.join(" "), q: "" });
      if (!rows.length) return "";
      // 見栄え: 末尾の(…)/（…）は改行して小さく別行に。ASSY等の長名は1行に収める(CSSで縮小)
      const fmtName = n => {
        const m = String(n).match(/^(.*?\S)\s*([（(].*[)）])\s*$/);
        if (m) return esc(m[1]) + '<span class="kPnSub">' + esc(m[2]) + '</span>';
        return esc(n);
      };
      return '<div class="kBlock kParts"><div class="kPartHead"><span class="kLbl">部品</span><span class="kQtyLbl">数量</span></div>' +
        '<ul class="kItems kPartRows">' + rows.map(r => '<li><span class="kPn">' + fmtName(r.n) + '</span><span class="kQty">' + esc(r.q) + '</span></li>').join("") + '</ul></div>';
    };
    body.innerHTML = block("作業", k.work) + partsBlock(k.parts) +
      (k.cost ? '<div class="kBlock"><span class="kLbl">費用</span><div class="kVal">¥' + han(String(k.cost)) + '</div></div>' : "") +
      block("メモ", k.note);
    card.append(head, body); box.appendChild(card);
  });
}
/* カード内でその場編集(別フォームに飛ばず直接編集) */
function editKarteInline(card, k) {
  card.innerHTML = "";
  const wrap = document.createElement("div"); wrap.className = "kEditBox";
  const row = (label, el) => { const r = document.createElement("div"); r.className = "kEditRow"; const l = document.createElement("label"); l.className = "fld"; l.textContent = label; r.append(l, el); return r; };
  const inp = (type, val) => { const i = document.createElement("input"); i.type = type; if (val != null) i.value = val; return i; };
  const ta = (val, ph) => { const t = document.createElement("textarea"); t.className = "kGrow"; t.style.minHeight = "48px"; if (val) t.value = val; if (ph) t.placeholder = ph; return t; };
  const nl = v => v ? String(v).replace(/[、,，・]\s*/g, "\n").replace(/\n{2,}/g, "\n").trim() : "";   // 区切りを改行にして見やすく
  const dDate = inp("date", k.date || ""); const dOdo = inp("number", k.odo != null ? k.odo : ""); dOdo.inputMode = "numeric";
  const dWork = ta(nl(k.work), "1行に1件（作業内容）"); const dParts = ta(nl(k.parts), "1行に1件（交換部品・使用材料）");
  const dCost = inp("number", k.cost != null ? k.cost : ""); dCost.inputMode = "numeric"; const dStaff = inp("text", k.staff || "");
  const dNote = ta(k.note, "メモ");
  wrap.append(row("日付", dDate), row("走行距離(km)", dOdo), row("作業内容", dWork), row("交換部品・使用材料", dParts), row("費用(円)", dCost), row("担当者", dStaff), row("メモ", dNote));
  const btns = document.createElement("div"); btns.className = "btnRow"; btns.style.marginTop = "10px";
  const save = document.createElement("button"); save.className = "btn btn-amber"; save.textContent = "保存";
  const cancel = document.createElement("button"); cancel.className = "btn btn-ghost"; cancel.style.flex = "0 0 28%"; cancel.textContent = "取消";
  save.addEventListener("click", () => {
    const work = dWork.value.trim(), parts = dParts.value.trim(), note = dNote.value.trim();
    if (!work && !parts && !note) { alert("作業内容・交換部品・メモのいずれかを入力してください。"); return; }
    saveKarteEntry({ id: k.id, date: dDate.value || "", odo: dOdo.value ? Number(dOdo.value) : null, work, parts, cost: dCost.value ? Number(dCost.value) : null, staff: dStaff.value.trim(), note, at: new Date().toISOString() });
    renderKarte();
  });
  cancel.addEventListener("click", renderKarte);
  btns.append(save, cancel); wrap.appendChild(btns);
  card.appendChild(wrap);
  autoGrowAll();
}
function openKarteForm(edit) {
  if (!vehicleKey(current)) { alert("車両を識別できないため記録できません(車台番号や指定・類別が必要です)。"); return; }
  const today = new Date(); const iso = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0");
  $("kDate").value = (edit && edit.date) || iso;
  $("kOdo").value = (edit && edit.odo) || "";
  $("kWork").value = (edit && edit.work) || "";
  $("kParts").value = (edit && edit.parts) || "";
  $("kCost").value = (edit && edit.cost) || "";
  $("kStaff").value = (edit && edit.staff) || (window.Cloud && window.Cloud.myName && window.Cloud.myName()) || "";
  $("kNote").value = (edit && edit.note) || "";
  karteEditId = edit ? edit.id : null;
  toggle("karteForm", true);
  autoGrowAll();   // 内容に合わせて入力欄の高さを調整
  $("karteForm").scrollIntoView({ behavior: "smooth", block: "center" });
}
/* テキストエリアを内容量に応じて自動拡大 */
function autoGrow(el) { if (!el) return; el.style.height = "auto"; el.style.height = Math.max(el.clientHeight, el.scrollHeight) + "px"; }
function autoGrowAll() { document.querySelectorAll(".kGrow").forEach(autoGrow); }
document.addEventListener("input", e => { if (e.target && e.target.classList && e.target.classList.contains("kGrow")) autoGrow(e.target); });
let karteEditId = null;
$("btnKarteAdd") && $("btnKarteAdd").addEventListener("click", () => openKarteForm(null));
$("btnKarteCancel") && $("btnKarteCancel").addEventListener("click", () => { stopFieldMic(); toggle("karteForm", false); });
$("btnKarteSave") && $("btnKarteSave").addEventListener("click", () => {
  stopFieldMic();
  const work = $("kWork").value.trim();
  const parts = $("kParts").value.trim();
  const note = $("kNote").value.trim();
  if (!work && !parts && !note) { alert("作業内容・交換部品・メモのいずれかを入力してください。"); return; }
  const entry = {
    id: karteEditId || ("k" + Date.now() + Math.floor(Math.random() * 1000)),
    date: $("kDate").value || "", odo: $("kOdo").value ? Number($("kOdo").value) : null,
    work, parts, cost: $("kCost").value ? Number($("kCost").value) : null,
    staff: $("kStaff").value.trim(), note,
    at: new Date().toISOString(),
  };
  saveKarteEntry(entry);
  toggle("karteForm", false);
  renderKarte();
});

/* 写真から自動入力: 作業伝票/メモ等の画像をAI(マルチモーダル)で解析し各項目に下書き */
$("btnKartePhoto") && $("btnKartePhoto").addEventListener("click", () => {
  if (!vehicleKey(current)) { alert("車両を識別してから記録してください(車台番号や指定・類別が必要です)。"); return; }
  if (!aiOK()) {
    alert("写真からの自動入力には無料のGemini APIキーの設定が必要です（設定タブ）。");
    switchView("settings"); return;
  }
  $("kPhotoIn").click();
});
$("kPhotoIn") && $("kPhotoIn").addEventListener("change", async e => {
  const file = e.target.files[0]; e.target.value = ""; if (!file) return;
  const st = $("kPhotoStatus"); toggle("kPhotoStatus", true);
  st.innerHTML = '<img src="img/kangae.png" class="btnMecha spin" alt=""> メカ君が写真を読み取っています…(数十秒かかる場合があります)';
  try {
    const prompt = [
      "次の画像は日本の自動車整備士が書いた『手書きの作業メモ』です(伝票やレシートの場合もあります)。字が崩れていたり略字・専門用語が多いので、整備の文脈で丁寧に判読してください。読み取った内容を整備カルテの各項目に整理してJSONで返します。",
      "略号の展開(整備現場の頻出略号。書かれていれば正式名に展開してよい。※メーカー名・数量・品番など書かれていない情報は足さない): E/O=エンジンオイル, O/E=オイルエレメント(オイルフィルター), B/O=ブレーキオイル(ブレーキフルード), M/O=ミッションオイル, T/M=トランスミッション, A/T=オートマチックオイル, CVT/F=CVTフルード, D/O=デフオイル, P/S=パワステフルード, L/L=ロングライフクーラント(冷却水), F/パッド=フロントブレーキパッド, R/パッド=リアブレーキパッド, F/ローター=フロントローター, R/ローター=リアローター, W/ブレード=ワイパーブレード, バッテリ/BATT=バッテリー, プラグ=スパークプラグ, エレメント=フィルター, O/H=オーバーホール, 脱着=取り外し・取り付け。",
      "判読のヒント: 『OIL/オイル交換』『EG/エンジン』『ミッション/AT/CVT』『Fブレーキ/Rブレーキ』『パッド』『ローター』『バッテリー/BATT』『エレメント/フィルター』『点検』『下回り』等の整備略語を考慮。走行距離は『8.2万km』『82,000』『82000キロ』等どの表記でも数値(km)に統一。日付は和暦・年月日・『R7.6.1』等でも西暦YYYY-MM-DDに変換(年が無ければ空文字)。金額の『¥』『円』『,』は除いて数値のみ。",
      "各項目に振り分け: work=実施した作業/点検内容, parts=交換した部品・使用材料(品番があれば含む), cost=合計金額の数値, staff=担当者/記入者名, note=次回の申し送り・特記(不具合や気づき)。判読できない文字は無理に決めつけず、その項目は空にする。",
      "【最重要・厳守】メモに書かれていない情報を勝手に補完・推測・追加しないこと。特にメーカー名・銘柄・商品名・品番・数量・単位は、メモに明記されていない限り一切足さない(例: 『オイル 3.7L』とだけあれば、そのまま『オイル 3.7L』とし、メーカー名や『エンジンオイル』等の語を付け足さない)。あくまで書かれた文字をそのまま転記する。",
      "出力は厳密なJSONのみ(前後の文章・コードフェンス・説明は不要)。数字は半角。",
      "形式: {\"date\":\"\",\"odo\":null,\"work\":\"\",\"parts\":\"\",\"cost\":null,\"staff\":\"\",\"note\":\"\"}",
    ].join("\n");
    const media = [{ mimeType: cleanMime(file.type, "image/jpeg"), data: await fileToBase64(file) }];
    const r = await geminiAskMedia(prompt, media);
    const obj = extractJson(r.text) || {};
    openKarteForm(null);   // フォームを開いてから流し込む(当日日付・担当者を初期化した上で上書き)
    if (obj.date) $("kDate").value = String(obj.date).trim();
    if (obj.odo != null && obj.odo !== "") $("kOdo").value = String(obj.odo).replace(/[^\d]/g, "");
    if (obj.work) $("kWork").value = String(obj.work).trim();
    if (obj.parts) $("kParts").value = String(obj.parts).trim();
    if (obj.cost != null && obj.cost !== "") $("kCost").value = String(obj.cost).replace(/[^\d]/g, "");
    if (obj.staff) $("kStaff").value = String(obj.staff).trim();
    if (obj.note) $("kNote").value = String(obj.note).trim();
    st.textContent = "✓ 読み取りました。内容を確認・修正して保存してください。";
  } catch (err) {
    st.textContent = "⚠ " + (err.message === "__cancelled__" ? "中断しました" : (err.message || "写真を読み取れませんでした")) + "（手入力・音声入力もできます）";
  }
});

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
  t.aiAt = new Date().toISOString(); t.updatedAt = Date.now();
  localStorage.setItem(LS.hist, JSON.stringify(h2));
  if (window.Cloud) window.Cloud.pushRecord(t);   // 諸元・故障も社内共有へ
}
function specsToText(specs) { return (specs || []).map(s => s.k + ": " + s.v).join("\n"); }

/* 油脂類の種別グループ(カルテ部品名・諸元項目名の両方をこのキーワードで判定) */
const FLUID_GROUPS = [
  { canon: "エンジンオイル", kw: ["エンジンオイル", "エンジン油", "eo", "e/o"] },
  { canon: "ミッションオイル", kw: ["ミッションオイル", "ミッション", "トランスミッション", "ギヤオイル", "ギアオイル", "m/t", "mtオイル"] },
  { canon: "デフオイル", kw: ["デフオイル", "デフ", "デファレンシャル", "終減速", "ディファレンシャル"] },
  { canon: "ブレーキフルード", kw: ["ブレーキフルード", "ブレーキ液", "ブレーキオイル", "フルード"] },
  { canon: "パワステフルード", kw: ["パワステ", "パワーステアリング", "psf", "p/s"] },
  { canon: "クーラント", kw: ["クーラント", "冷却水", "llc", "ロングライフ", "不凍液"] },
  { canon: "ATF", kw: ["atf", "オートマオイル"] },
  { canon: "CVTフルード", kw: ["cvt"] },
  { canon: "アドブルー", kw: ["アドブルー", "adblue", "尿素水"] },
];
const fluidNorm = s => String(s || "").toLowerCase().replace(/[\s　]+/g, "");
function fluidGroupOf(name) { const n = fluidNorm(name); return FLUID_GROUPS.find(g => g.kw.some(k => n.includes(fluidNorm(k)))) || null; }
function parseLiters(v) { const m = String(v || "").match(/([\d]+(?:\.\d+)?)\s*[lLｌＬ]/); return m ? parseFloat(m[1]) : null; }
/* カルテの油脂類の実績量(L)を諸元(この車両の記憶値)へ反映。相違があれば諸元を実績値で更新して保存。 */
function reconcileFluidsFromKarte(entry) {
  if (!entry || entry.deleted || !entry.parts || !current) return;
  // 「部品名 + 数量」に分解(数字始まりを直前の名前の数量とみなす)
  const toks = String(entry.parts).split(/[、,，・\s]+/).map(s => han(s).trim()).filter(Boolean);
  const rows = []; let name = [];
  toks.forEach(t => { if (/^\d/.test(t) && name.length) { rows.push({ n: name.join(" "), q: t }); name = []; } else name.push(t); });
  if (name.length) rows.push({ n: name.join(" "), q: "" });
  // 油脂類 かつ L(リットル)量 のものだけ抽出
  const found = [];
  rows.forEach(r => {
    const g = fluidGroupOf(r.n); if (!g) return;                                  // 油脂類のみ
    // 「4.5L」等はもちろん、単位なしの数字「4.5」も油脂類なら L(リットル)量として扱う
    let liters = parseLiters(r.q);
    if (liters == null && /^\d+(?:\.\d+)?$/.test(r.q)) liters = parseFloat(r.q);
    if (liters == null) return;
    found.push({ g, liters, qtyStr: liters + "L" });
  });
  if (!found.length) return;
  const he = findHistEntry(getHistory(), current) || {};
  const learned = getLearned(vehicleKey(current)) || {};
  let specs = ((he.specs && he.specs.length ? he.specs : learned.specs) || []).map(s => s.manual ? { k: s.k, v: s.v, manual: true } : { k: s.k, v: s.v });
  const changes = [];
  found.forEach(f => {
    // 同じ油脂グループの諸元項目を探す
    const i = specs.findIndex(s => { const g = fluidGroupOf(s.k); return g && g.canon === f.g.canon; });
    if (i < 0) {
      // 諸元に該当項目が無ければ、カルテ実績から新規追加(緑=手動確定)
      specs.push({ k: f.g.canon + "量", v: f.qtyStr, manual: true });
      changes.push({ k: f.g.canon + "量", oldV: "", newV: f.qtyStr });
      return;
    }
    const cur = parseLiters(specs[i].v);
    if (cur != null && Math.abs(cur - f.liters) < 0.001) return;   // 一致していれば変更なし
    changes.push({ k: specs[i].k, oldV: specs[i].v, newV: f.qtyStr });
    specs[i] = { k: specs[i].k, v: f.qtyStr, manual: true };   // 実績確定値として緑で固定(AI再読込でも上書きされない)
  });
  if (!changes.length) return;
  saveVehicleAiData(specs);                          // 履歴(DB)＋社内共有へ
  setLearned(vehicleKey(current), { specs });        // この端末の記憶へ
  // メンテ画面を開いていれば即再描画
  const mv = document.getElementById("view-maint");
  if (mv && mv.classList.contains("active") && typeof renderSpecs === "function") renderSpecs(specs, "learned");
  // 表示は簡潔に。括弧書き(例:「デフオイル（デファレンシャルオイル）」)や末尾「量」を落として重複を防ぐ
  const shortK = k => String(k).replace(/[（(].*?[）)]/g, "").replace(/量$/, "").trim();
  showToast("諸元を更新しました\n" + changes.map(c => "・" + shortK(c.k) + " " + c.newV).join("\n"));
}
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
    if (merged.length > 1) out.push(...merged.map(m => s.manual ? { ...m, manual: true } : m));
    else out.push(s.manual ? { k: s.k, v: s.v, manual: true } : { k: s.k, v: s.v });
  });
  // 値が空 or「（要確認）」だけの項目は非表示(見苦しいため)。ただし手入力項目は残す
  const isEmptyish = v => { const t = String(v || "").replace(/[（）()\s]/g, ""); return t === "" || t === "要確認"; };
  // 同名項目は先勝ちで重複排除
  const seen = new Set();
  return out.filter(s => {
    if (!s.manual && isEmptyish(s.v)) return false;
    const key = s.k; if (seen.has(key)) return false; seen.add(key); return true;
  });
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
  // 直前の表示値と比較し、変更した項目(と新規項目)だけ「手動修正」フラグを付ける
  const prior = {}; (shownSpecs || []).forEach(s => { prior[s.k] = { v: s.v, manual: !!s.manual }; });
  const out = [];
  $("specEditRows").querySelectorAll(".specEditRow").forEach(r => {
    const k = r.querySelector(".seK").value.trim(), v = r.querySelector(".seV").value.trim();
    if (!k) return;
    const p = prior[k];
    const manual = p ? (p.v !== v ? true : p.manual) : true;   // 値が変わった/新規 → 手動
    out.push(manual ? { k, v, manual: true } : { k, v });
  });
  return out;
}
/* AI諸元に、手動修正済み項目を上書き保持してマージ(『最新に更新』で手入力が消えないように) */
function mergeKeepManual(aiSpecs, curSpecs) {
  const manual = {}; (curSpecs || []).forEach(s => { if (s.manual) manual[s.k] = s; });
  const used = new Set();
  const out = (aiSpecs || []).map(s => {
    if (manual[s.k]) { used.add(s.k); return { k: s.k, v: manual[s.k].v, manual: true }; }
    return s;
  });
  Object.keys(manual).forEach(k => { if (!used.has(k)) out.push({ k, v: manual[k].v, manual: true }); });
  return out;
}
$("btnSpecEdit").addEventListener("click", () => addSpecItemInline());
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
  if (aiOK()) {
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
  if (!aiOK()) {
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
  const cols = document.createElement("div"); cols.style.cssText = "display:flex;flex-direction:column;gap:8px";
  // 修理タブ下部のコピー(.copyKata)と同じ見た目のピルボタン。タップでコピー。
  const mkCol = (label, val) => {
    const btn = document.createElement("button"); btn.type = "button"; btn.className = "copyKata"; btn.style.marginTop = "0";
    const code = document.createElement("b"); code.textContent = val;
    btn.append(document.createTextNode("📋 " + label + ": "), code, document.createTextNode(" をコピー"));
    btn.addEventListener("click", () => {
      copyText(code.textContent);
      btn.innerHTML = "✓ コピー";
      setTimeout(() => { btn.innerHTML = ""; btn.append(document.createTextNode("📋 " + label + ": "), code, document.createTextNode(" をコピー")); }, 1200);
    });
    return { col: btn, code };
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
/* 同一車両(車台番号 または ナンバー)の重複を1件に統合。新しい情報・updatedAtを優先して残す */
function dedupeHistory(list) {
  const out = []; const idx = {};
  for (const h of (list || [])) {
    if (!h) continue;
    const key = (h.vin && ("V:" + String(h.vin).toUpperCase())) || (h.plate && ("P:" + normPlate(h.plate))) || null;
    if (key == null) { out.push(h); continue; }
    if (idx[key] == null) { idx[key] = out.length; out.push(h); continue; }
    // 既存とマージ(各フィールドは値がある方/新しい方を採用)
    const a = out[idx[key]];
    const newer = (h.updatedAt || 0) >= (a.updatedAt || 0) ? h : a;
    const older = newer === h ? a : h;
    const pick = k => newer[k] != null ? newer[k] : older[k];
    out[idx[key]] = {
      id: a.id || h.id, rid: newer.rid || older.rid || a.rid || h.rid,
      vin: pick("vin"), plate: pick("plate"), type: pick("type"), engine: pick("engine"),
      name: newer.name != null ? newer.name : older.name,
      model: pick("model"), kataShitei: pick("kataShitei"), firstReg: pick("firstReg"), expiry: pick("expiry"),
      specs: pick("specs"), faults: pick("faults"), recalls: pick("recalls"), maker: pick("maker"),
      karte: mergeKarte(a.karte, h.karte),
      at: (newer.at || older.at), updatedAt: Math.max(a.updatedAt || 0, h.updatedAt || 0),
    };
  }
  return out;
}
/* 重複を統合して保存し、統合後の配列を返す(描画・検索の前に呼ぶ) */
function dedupeHistoryStore() {
  const before = getHistory();
  const after = dedupeHistory(before);
  if (after.length !== before.length) localStorage.setItem(LS.hist, JSON.stringify(after.slice(0, 500)));
  return after;
}
/* ナンバー比較用の正規化 (空白・記号除去、全角英数→半角) */
function normPlate(s) {
  if (!s) return "";
  return String(s)
    .replace(/[０-９Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\s\-・･.．]/g, "")
    .toUpperCase();
}
/* 不変の識別ID(訂正で登録番号や型式が変わっても同じレコードを追える) */
function newRid() { return "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
/* 同一車両の既存履歴を探す (不変ID > 車台番号 > ナンバー の順) */
function findHistEntry(hist, d) {
  return hist.find(h =>
    (d.rid && h.rid && h.rid === d.rid) ||
    (d.vin && h.vin && h.vin === d.vin) ||
    (!d.vin && d.plate && h.plate && normPlate(h.plate) === normPlate(d.plate)));
}
function addHistory(d) {
  const hist = getHistory();
  const exist = findHistEntry(hist, d);
  let target;
  if (exist) {
    // 同一車両: 情報を統合して先頭へ (使用者名・不変IDは保持)
    if (!exist.rid) exist.rid = d.rid || newRid();
    Object.assign(exist, {
      type: d.type || exist.type, vin: d.vin || exist.vin, plate: d.plate || exist.plate,
      engine: d.engine || exist.engine,
      expiry: d.expiry ? d.expiry.getTime() : exist.expiry,
      firstReg: d.firstReg || exist.firstReg, kataShitei: d.kataShitei || exist.kataShitei,
      at: new Date().toISOString(), updatedAt: Date.now(),
    });
    hist.splice(hist.indexOf(exist), 1); hist.unshift(exist);
    target = exist;
  } else {
    target = {
      id: Date.now(), rid: d.rid || newRid(), type: d.type || null, vin: d.vin || null, plate: d.plate || null, name: null,
      engine: d.engine || null,
      expiry: d.expiry ? d.expiry.getTime() : null,
      firstReg: d.firstReg || null, kataShitei: d.kataShitei || null,
      at: new Date().toISOString(), updatedAt: Date.now(),
    };
    hist.unshift(target);
  }
  if (d && !d.rid) d.rid = target.rid;   // current等にも不変IDを伝播(以降の訂正で同じレコードを更新)
  localStorage.setItem(LS.hist, JSON.stringify(hist.slice(0, 200)));
  renderHistory();
  if (window.Cloud) window.Cloud.pushRecord(target);   // 社内共有へ
}
/* 現在表示中の車両に使用者名を保存 */
function saveUserName(name) {
  const hist = getHistory();
  let e = findHistEntry(hist, current);
  if (!e) { addHistory(current); e = findHistEntry(getHistory(), current); if (!e) return; }
  const h2 = getHistory();
  const t = findHistEntry(h2, current);
  // 空欄("")は「意図的に消した」印として保持し、統合時に古い名前へ戻らないようにする(null=未入力とは区別)
  if (t) { t.name = noEmail(name); t.updatedAt = Date.now(); localStorage.setItem(LS.hist, JSON.stringify(h2)); renderHistory(); if (window.Cloud) window.Cloud.pushRecord(t); }
}
function histToResult(h) {
  return {
    rid: h.rid || null,
    type: h.type, vin: h.vin, plate: h.plate || null, engine: h.engine || null,
    model: h.model || null,
    expiry: h.expiry ? new Date(h.expiry) : null,
    firstReg: h.firstReg || null, kataShitei: h.kataShitei || null,
    raw: [h.type, h.vin, h.plate].filter(Boolean),
  };
}
function renderHistory() {
  const hist = dedupeHistoryStore();
  const box = $("histList"); box.innerHTML = "";
  if (!hist.length) { box.innerHTML = '<div class="empty"><img src="img/mecha.png" class="mascot-mini" alt="メカ君"><br>履歴はまだないよ。<br>車検証をスキャンするとここに記録されます。</div>'; return; }
  hist.forEach(h => {
    const div = document.createElement("div"); div.className = "histItem";
    const main = document.createElement("div"); main.className = "hMain";
    const dt = new Date(h.at);
    const title = [h.plate, h.name].map(dispText).filter(Boolean).join(" ／ ") || dispText(h.type) || "型式不明";
    main.innerHTML = '<div class="hType">' + esc(title) + '</div>' +
      '<div class="hSub">' + esc(dispText(h.type) || "型式不明") + " ・ " + esc(dispText(h.vin) || "車台番号なし") + " ・ " +
      dt.getFullYear() + "/" + String(dt.getMonth()+1).padStart(2,"0") + "/" + String(dt.getDate()).padStart(2,"0") +
      " " + String(dt.getHours()).padStart(2,"0") + ":" + String(dt.getMinutes()).padStart(2,"0") + "</div>";
    main.addEventListener("click", () => showResult(histToResult(h), { fromScan: false }));
    div.appendChild(main);
    if (isManager()) {   // 履歴の削除は管理者のみ
      const del = document.createElement("button"); del.className = "hDel"; del.textContent = "削除";
      del.addEventListener("click", () => {
        if (window.Cloud) window.Cloud.deleteRecord(h);   // クラウドからも削除(復活防止)
        localStorage.setItem(LS.hist, JSON.stringify(getHistory().filter(x => x.id !== h.id)));
        renderHistory();
      });
      div.appendChild(del);
    }
    box.appendChild(div);
  });
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* 管理者権限: 未ログインの個人利用は許可、ログイン中は admin/super のみ許可(従業員は不可) */
function isManager() { return (window.Cloud && typeof window.Cloud.isManager === "function") ? window.Cloud.isManager() : true; }
/* 権限に応じてUIを更新(データ管理セクションの表示 / 履歴・DBの削除ボタン再描画) */
function applyRoleUI() {
  const mgr = isManager();
  const dm = $("secDataMgmt"); if (dm) dm.classList.toggle("hidden", !mgr);
  if (typeof renderHistory === "function") renderHistory();
  if (typeof renderDBList === "function") renderDBList();
}
window.applyRoleUI = applyRoleUI;

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
    if (custom && isManager()) {   // DBの削除は管理者のみ
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
  const id = editingId || ("c" + Date.now());
  const prev = CUSTOM_DB.find(x => x.id === id) || {};
  const rec = {
    ...prev,   // vin/plate/engine/kataShitei/user など既存フィールドを維持
    id,
    name, match, maker: $("dbfMaker").value,
    faults: lines("dbfFaults"),
    specs: lines("dbfSpecs").map(l => {
      const i = l.search(/[:：]/);
      return i > 0 ? { k: l.slice(0, i).trim(), v: l.slice(i + 1).trim() } : { k: l, v: "" };
    }).filter(s => s.k),
    notes: $("dbfNotes").value.trim(),
    manual: true,   // 手動編集=正データ。AI/内蔵推定で上書きさせない
    updatedAt: Date.now(),
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
  if (!isManager()) { alert("この操作は管理者のみ行えます。"); return; }
  if (confirm("スキャン履歴をすべて削除しますか？")) { localStorage.removeItem(LS.hist); renderHistory(); }
});
$("btnClearCustom").addEventListener("click", () => {
  if (!isManager()) { alert("この操作は管理者のみ行えます。"); return; }
  if (confirm("カスタム車種DBをすべて削除しますか？（内蔵DBは残ります）")) { CUSTOM_DB = []; saveCustomDB(); renderDBList(); }
});
/* DB内蔵データの全消去: 内蔵・カスタム・学習(諸元/定番故障)をすべて削除(履歴は残す) */
$("btnClearDb").addEventListener("click", () => {
  if (!isManager()) { alert("この操作は管理者のみ行えます。"); return; }
  if (!confirm("DB内蔵データを全消去します。\n・内蔵車種DB\n・カスタムDB\n・AIが学習した諸元/定番故障\nをすべて削除します（スキャン履歴は残ります）。よろしいですか？")) return;
  localStorage.setItem("ss_dbcleared", "1");
  localStorage.removeItem(LS.custom);
  localStorage.removeItem("ss_learnedspecs");
  CUSTOM_DB = []; BUILTIN_DB = [];
  renderDBList();
  appVerDisplay().then(ver => setText("verNote", "メカノAI " + ver + " ／ DBデータを全消去しました。スキャンやAI調査で再び蓄積されます。"));
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
  $("diagText").value = ""; autoGrow($("diagText")); $("diagResults").innerHTML = "";
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
/* 画像生成モデル(通称Nano Banana=Gemini 2.5 Flash Image。同じキーで実画像を返す) */
const GEMINI_IMAGE_MODELS = ["gemini-2.5-flash-image", "gemini-2.5-flash-image-preview", "gemini-2.0-flash-preview-image-generation"];
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

// 個人モードのバナー「APIキーの設定へ」→ キー設定を開いてスクロール
$("btnJumpKey") && $("btnJumpKey").addEventListener("click", () => {
  const f = $("secAiKeyFold"); if (f) f.open = true;
  const s = $("secAiKey"); if (s) s.scrollIntoView({ behavior: "smooth", block: "start" });
});

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

/* ---- Google Programmable Search(実写画像) 設定 ---- */
/* 契約中の店舗はサーバー経由(運営のキー)で使えるため、自前キーの設定は不要 */
function cseCorp() { return !!(window.Cloud && window.Cloud.aiReady && window.Cloud.aiReady()); }
function cseReady() { return !!(localStorage.getItem("ss_cse_key") && localStorage.getItem("ss_cse_cx")) || cseCorp(); }
function renderCseStat() {
  const el = $("cseStat"); if (!el) return;
  const corp = cseCorp(), own = !!(localStorage.getItem("ss_cse_key") && localStorage.getItem("ss_cse_cx"));
  // 契約中は運営のキーで動くため、取得手順・入力欄を隠して「設定不要」と案内
  toggle("cseCorpNote", corp);
  toggle("cseSetup", !corp);
  el.textContent = corp ? "✓ ご契約中 — 部品名タップで実写画像を表示します（設定不要）。"
    : own ? "✓ 設定済み — 部品名タップで実写画像を表示します。"
    : "未設定 — 「Web画像で探す」リンクのみ使えます。";
}
$("btnCseSave") && $("btnCseSave").addEventListener("click", () => {
  const key = $("cseKey").value.trim(), cx = $("cseCx").value.trim();
  if (key) localStorage.setItem("ss_cse_key", key); else localStorage.removeItem("ss_cse_key");
  if (cx) localStorage.setItem("ss_cse_cx", cx); else localStorage.removeItem("ss_cse_cx");
  $("cseKey").value = "";
  renderCseStat();
});
/* Google Custom Search で画像を検索(CORS対応のJSON API)。結果配列[{thumb,link,ctx,title}] */
async function googleImageSearch(query, num) {
  const key = localStorage.getItem("ss_cse_key"), cx = localStorage.getItem("ss_cse_cx");
  // 自前キーが無く契約中なら、サーバー(運営のキー)経由で検索 → 契約と同時に使える
  if ((!key || !cx) && cseCorp()) {
    const d = await window.Cloud.callFn("imageSearch", { q: query, num: num || 3 });
    return Array.isArray(d && d.items) ? d.items.filter(x => x && x.thumb) : [];
  }
  if (!key || !cx) return [];
  const url = "https://www.googleapis.com/customsearch/v1?searchType=image&safe=active&num=" + (num || 3) +
    "&key=" + encodeURIComponent(key) + "&cx=" + encodeURIComponent(cx) + "&q=" + encodeURIComponent(query);
  const res = await fetch(url);
  if (!res.ok) {
    let reason = "";
    try { const ej = await res.json(); reason = (ej.error && ej.error.message) || ""; } catch (_) {}
    const r = reason.toLowerCase();
    let msg;
    if (res.status === 429 || /quota|rate limit/.test(r)) msg = "本日の無料枠(100回)を使い切りました。明日また使えます。";
    else if (/has not been used|is disabled|not been enabled|api.*not.*enabled|does not have the access/.test(r)) msg = "「Custom Search API」がまだ有効になっていません。設定→部品の実写画像の案内から『Custom Search APIを有効にする』を押してください。";
    else if (res.status === 403 && /referer|referrer|blocked|not authorized/.test(r)) msg = "APIキーに利用制限がかかっています。キーの制限を『なし』にするか、このサイトを許可してください。";
    else if (res.status === 400 && /invalid.*key|api key not valid/.test(r)) msg = "APIキーが正しくありません。②のキーを貼り直してください。";
    else if (res.status === 400 && (/invalid.*cx|invalid value/.test(r) || !localStorage.getItem("ss_cse_cx"))) msg = "検索エンジンID(cx)が正しくありません。①のIDを貼り直してください。";
    else msg = "画像検索エラー(" + res.status + ")" + (reason ? "：" + reason : "");
    const err = new Error(msg); err.userMsg = msg; throw err;
  }
  const j = await res.json();
  return (j.items || []).map(it => ({
    thumb: (it.image && it.image.thumbnailLink) || it.link,
    link: it.link,
    ctx: (it.image && it.image.contextLink) || it.link,
    title: it.title || "",
  })).filter(x => x.thumb);
}

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
  const ck = mode + (opts.search ? ":s" : "") + ":" + hashStr(prompt);
  if (!opts.noCache) {
    const cached = aiCacheGet(ck);
    if (cached) return { text: cached.text, truncated: cached.truncated, model: "cache" };
  }
  // 自分の鍵が無い契約店舗のみサーバー(mecha)経由。鍵がある人は従来どおりローカル利用(壊さない)。
  if (!key && window.Cloud && window.Cloud.aiReady && window.Cloud.aiReady()) {
    const d = await window.Cloud.callFn("mecha", { prompt, mode, search: !!opts.search });
    const r = { text: (d && d.text) || "", truncated: !!(d && d.truncated), model: "proxy" };
    if (!r.text) throw new Error("AIから回答が得られませんでした");
    aiCacheSet(ck, { text: r.text, truncated: r.truncated }); return r;
  }
  let lastErr = null;
  aiAbort = new AbortController();   // クリアで中断できるように
  for (const model of GEMINI_MODELS[mode]) {
    try {
      // 思考トークンと本文が両方収まるよう上限は大きめに確保
      const genCfg = { temperature: 0.2, maxOutputTokens: 16384 };
      // 2.5系の思考トークン制御: 標準(flash)は思考OFF=0で高速化、高精度(pro)は-1で自動調整
      if (model.startsWith("gemini-2.5")) {
        // flash-lite/2.0系はもともと高速。gemini-2.5-flash/proは思考が重いのでモードで切替
        genCfg.thinkingConfig = { thinkingBudget: mode === "pro" ? -1 : 0 };
      }
      const res = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + encodeURIComponent(key),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: aiAbort.signal,
          body: JSON.stringify(Object.assign({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: genCfg
          }, opts.search ? { tools: [{ google_search: {} }] } : {}))
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

/* 画像生成: Geminiの画像モデルで実画像(PNG)を生成し data URL を返す。失敗時は "" */
const imgMemCache = new Map();   // セッション内キャッシュ(無料枠の節約)
function imgCacheGet(k) {
  if (imgMemCache.has(k)) return imgMemCache.get(k);
  try { const c = JSON.parse(localStorage.getItem("ss_imgcache") || "{}"); if (c[k]) { imgMemCache.set(k, c[k]); return c[k]; } } catch (e) {}
  return null;
}
function imgCacheSet(k, dataUrl) {
  imgMemCache.set(k, dataUrl);
  // localStorageは容量が小さいので最新数件のみ保持(超過時は古いものから捨てる)
  try {
    const c = JSON.parse(localStorage.getItem("ss_imgcache") || "{}");
    c[k] = dataUrl;
    let ks = Object.keys(c);
    while (ks.length > 8) delete c[ks.shift()];
    while (ks.length) {
      try { localStorage.setItem("ss_imgcache", JSON.stringify(c)); break; }
      catch (e) { delete c[ks.shift()]; }   // 容量超過なら古い順に減らして再試行
    }
  } catch (e) {}
}
/* dataURL("data:image/png;base64,...") → {mimeType,data} (参照画像として渡す用) */
function dataUrlToInline(dataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl || "");
  return m ? { mimeType: m[1], data: m[2] } : null;
}
async function geminiGenImage(prompt, opts) {
  opts = opts || {};
  const key = localStorage.getItem(LS.gemini);
  if (!key) throw new Error("APIキー未設定");
  const refs = (opts.refImages || []).filter(Boolean);
  // 参照画像がある時はキャッシュキーにも反映(内容が変わるため)
  const ck = "img:" + hashStr(prompt + "|" + refs.map(r => (r.data || "").slice(0, 32)).join(","));
  if (!opts.noCache) { const c = imgCacheGet(ck); if (c) return c; }
  aiAbort = new AbortController();
  let lastErr = null;
  for (const model of GEMINI_IMAGE_MODELS) {
    try {
      const parts = [{ text: prompt }];
      refs.forEach(r => parts.push({ inlineData: { mimeType: r.mimeType || "image/png", data: r.data } }));
      const res = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + encodeURIComponent(key),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: aiAbort.signal,
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: { responseModalities: ["IMAGE", "TEXT"] }
          })
        });
      if (res.status === 404) { lastErr = new Error(model + " 利用不可"); continue; }
      if (res.status === 429) { lastErr = new Error("無料枠の上限"); continue; }
      if (res.status === 400 || res.status === 403) { lastErr = new Error("画像モデル非対応/キー権限不足"); continue; }
      if (!res.ok) { lastErr = new Error("画像生成エラー(" + res.status + ")"); continue; }
      const j = await res.json();
      const respParts = j.candidates?.[0]?.content?.parts || [];
      const img = respParts.find(p => p.inlineData && p.inlineData.data);
      if (!img) { lastErr = new Error("画像が返りませんでした"); continue; }
      const mime = img.inlineData.mimeType || "image/png";
      const dataUrl = "data:" + mime + ";base64," + img.inlineData.data;
      imgCacheSet(ck, dataUrl);
      return dataUrl;
    } catch (e) {
      if (e && e.name === "AbortError") throw new Error("__cancelled__");
      lastErr = e;
    }
  }
  throw lastErr || new Error("画像生成に失敗しました");
}

/* 出力言語の指示(UIが英語のときは英語で回答させる)。■等の見出し記号はそのまま維持させる */
function aiLangDirective() {
  return (window.APP_LANG === "en")
    ? "Write the entire answer in natural English (technical automotive English). Keep the section markers such as ■ and the numbering exactly as specified, but translate their labels and all content into English."
    : "";
}

function buildDiagPrompt(text) {
  const lines = [
    "あなたは『メカ君』。まじめで頼れるロボ整備士(一人称ボク)で、どこかおちゃめな愛嬌もあるが診断は正確第一。下記の形式は守りつつ、各説明は親しみやすく分かりやすい言葉で(冒頭か末尾に軽い一言を添えてもよいが、やりすぎない)。",
    "回答前に十分に考えてから答えること。正確性を最優先し、確信が持てない内容には「（要確認）」を付け、推測と確定的な事実を混同しないこと。一般論より、提示された車種・エンジンに固有の既知事例を優先すること。",
    "以下の情報から原因を診断してください。前置き・免責・挨拶は一切不要。Markdown記号(**、#、表)は使わず、必ず次の出力形式に従うこと:",
    "",
    "■原因候補（可能性が高い順）",
    "1. 原因名（一言で）",
    "理由: なぜこの症状・DTCからこの原因を疑うのか、根拠を1文で簡潔に。",
    "切り分け: 確認方法。使用工具と測定値の目安を含める。1〜2文で簡潔に。",
    "2. （同様に最大5つまで。各候補に必ず『理由:』と『切り分け:』を付ける）",
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
  const ld = aiLangDirective(); if (ld) lines.push("\n" + ld);
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
      if (opts.illustrate) attachStepFigure(li, div, n[2]);   // タップで参考図を表示
      li.appendChild(div);
      list.appendChild(li);
      continue;
    }
    // 「理由:」行 → 折り畳み(タップで開閉。他を開くと現在の理由は畳む=アコーディオン)
    const rz = line.match(/^[・]?\s*(理由|根拠)\s*[:：]\s*(.+)$/);
    if (rz && list && list.lastElementChild) {
      const wrap = document.createElement("div"); wrap.className = "ai-reason";
      const tog = document.createElement("button"); tog.type = "button"; tog.className = "ai-reason-toggle"; tog.textContent = "理由";
      const body = document.createElement("div"); body.className = "ai-reason-body"; body.textContent = rz[2];
      tog.addEventListener("click", () => {
        const willOpen = !wrap.classList.contains("open");
        container.querySelectorAll(".ai-reason.open").forEach(el => el.classList.remove("open"));   // 他の理由を畳む
        if (willOpen) wrap.classList.add("open");
      });
      wrap.append(tog, body);
      list.lastElementChild.firstElementChild.appendChild(wrap);
      continue;
    }
    // 「切り分け:」行 → 直前の項目にぶら下げ(ラベル文字は表示しない)
    const k = line.match(/^[・]?\s*(切り分け|確認|点検方法)\s*[:：]\s*(.+)$/);
    if (k && list && list.lastElementChild) {
      const d = document.createElement("div");
      d.className = "ai-check";
      d.textContent = k[2];   // 「切り分け」ラベルは付けず内容のみ
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

/* 部品注文リストの部品名タップで、実物画像を下に開閉(初回のみ取得)。
   CSE(画像検索キー)設定済み→実写サムネ、未設定→Web画像検索リンクのみ。 */
function attachPartPicture(nameEl, pane, partName) {
  let loaded = false;
  nameEl.addEventListener("click", async () => {
    const open = pane.classList.toggle("hidden") === false;
    if (!open || loaded) return;
    loaded = true;
    const car = (currentVehicleFacts().model || (current && current.type) || "").trim();
    const q = (car + " " + han(partName) + " 部品").trim();
    const linkHtml = '<a class="linkbtn" target="_blank" rel="noopener" href="https://www.google.com/search?q='
      + encodeURIComponent(q) + '&tbm=isch">🔍 Web画像でもっと探す<span class="arr">↗</span></a>';
    if (!cseReady()) {
      pane.innerHTML = '<div class="partPicNote">実写画像を表示するには、設定タブで画像検索キーの登録が必要です。</div>' + linkHtml;
      return;
    }
    pane.innerHTML = '<div class="partPicNote">画像を探しています…</div>';
    try {
      const imgs = await googleImageSearch(q, 3);
      if (!imgs.length) { pane.innerHTML = '<div class="partPicNote">画像が見つかりませんでした。</div>' + linkHtml; return; }
      pane.innerHTML = '<div class="partPicRow">' + imgs.map(im =>
        '<a href="' + esc(im.ctx) + '" target="_blank" rel="noopener"><img src="' + esc(im.thumb) + '" alt="' + esc(partName) + '" loading="lazy"></a>'
      ).join("") + '</div><div class="partPicCap">' + esc(han(partName)) + '（Web画像・参考）</div>' + linkHtml;
    } catch (e) {
      pane.innerHTML = '<div class="partPicNote">' + esc((e && e.userMsg) || "画像を取得できませんでした。") + '</div>' + linkHtml;
    }
  });
}

/* 手順の li をタップ可能にして、参考図(メカ君の図解＋画像検索)を下に開く */
function attachStepFigure(li, div, stepText) {
  li.classList.add("hasFig");
  const fig = document.createElement("div"); fig.className = "stepFig hidden";
  div.appendChild(fig);
  const hint = document.createElement("div"); hint.className = "stepFigHint"; hint.textContent = "参考図";
  div.appendChild(hint);
  let loaded = false;
  div.addEventListener("click", async () => {
    const open = fig.classList.toggle("hidden") === false;
    hint.textContent = open ? "参考図を隠す" : "参考図";
    if (!open || loaded) return;
    loaded = true;
    fig.innerHTML = '<div class="stepFigLoad">🔧 メカ君が実物を確認して図を描いています…(十数秒〜30秒ほど)</div>';
    // 画像検索リンク(AIキーが無くても使える保険)
    const carName = figureVehicleDesc();
    const q = ((currentVehicleFacts().model || current.type || "") + " " + stepText).trim();
    const linkHtml = '<a class="linkbtn" target="_blank" rel="noopener" href="https://www.google.com/search?q='
      + encodeURIComponent(q) + '&tbm=isch">🔍 実物の参考画像をWebで探す<span class="arr">↗</span></a>';
    if (!aiOK()) { fig.innerHTML = linkHtml; return; }
    try {
      // ①「実物の特徴」を文章で正確に洗い出す(実写知識で図の精度を上げる。失敗しても続行)
      let refDesc = "";
      try { refDesc = await geminiStepVisualRef(stepText, carName); } catch (e) { if (e && e.message === "__cancelled__") throw e; }
      // ②実物に忠実な写実リファレンス画像を生成(部品形状・取付位置の再現性の土台)
      let refInline = null;
      try {
        const photo = await geminiGenImage(buildPartPhotoPrompt(stepText, carName, refDesc));
        if (photo) refInline = dataUrlToInline(photo);
      } catch (e) { if (e && e.message === "__cancelled__") throw e; }
      // ③リファレンスの構造(形状・取付位置・工具の当たり)を保持したまま、今のイラストタッチで描き直す
      let body = "";
      try {
        const dataUrl = await geminiGenImage(
          buildStepImagePrompt(stepText, carName, refDesc, !!refInline),
          refInline ? { refImages: [refInline] } : undefined
        );
        if (dataUrl) body = '<div class="stepFigSvg"><img alt="参考図" src="' + dataUrl + '"></div><div class="stepFigCap">メカ君が描いた参考イラスト（イメージ）</div>';
      } catch (e) { if (e && e.message === "__cancelled__") throw e; }
      if (!body) {
        const svg = await geminiStepFigure(stepText);
        if (svg) body = '<div class="stepFigSvg">' + svg + '</div><div class="stepFigCap">メカ君のイメージ図（参考）</div>';
      }
      fig.innerHTML = body + linkHtml;
    } catch (e) {
      fig.innerHTML = (e && e.message === "__cancelled__" ? "" : '<div class="hint">図を描けませんでした。</div>') + linkHtml;
      loaded = false;
    }
  });
}
/* 図解用の車両記述(読み取った車両データを作画へ反映) */
function figureVehicleDesc() {
  const f = currentVehicleFacts();
  const makerJa = { isuzu: "いすゞ", hino: "日野", fuso: "三菱ふそう", ud: "UD", nissan: "日産", toyota: "トヨタ", honda: "ホンダ", mazda: "マツダ", suzuki: "スズキ", daihatsu: "ダイハツ", subaru: "スバル" };
  const code = current.type && current.type.includes("-") ? current.type.split("-")[1] : current.type;
  const hit = code ? findVehicle(code) : null;
  const mk = hit && makerJa[hit.maker] ? makerJa[hit.maker] : null;
  const parts = [];
  if (f.model) parts.push(f.model); else if (mk) parts.push(mk);
  if (current.type) parts.push("型式 " + current.type);
  if (current.engine) parts.push("原動機 " + current.engine);
  return parts.length ? parts.join(" / ") : "一般的な自動車";
}
/* 写実リファレンス画像用プロンプト(構造再現の土台。イラスト化はしない) */
/* 取り付け位置の写実リファレンス(区画全体＋対象部品が文脈で分かる) */
function buildPartLocationPhotoPrompt(part, carName, refDesc) {
  const lines = [
    "自動車整備の資料用に、指定部品の『取り付け位置』が分かる実物に忠実なクローズアップ画像を1枚生成してください。",
    "目的: その部品が車両のどの区画(エンジンルーム/車両下部/室内/トランク等)の、どこに・どんな向きで付いているかを、周囲の部品との位置関係が分かる引き〜中距離で正確に示す。",
    "対象車両: " + (carName || "一般的な自動車") + "。この車種・車格に実在する該当部品と周辺レイアウトの正しい形にする。別車種にしない。",
    "写実・正確第一。文字/数字/ロゴ/透かしは入れない。イラスト化・誇張はしない(資料写真)。",
  ];
  if (refDesc) { lines.push("【実物の特徴メモ(反映)】"); lines.push(refDesc); }
  lines.push("対象部品: " + part);
  return lines.join("\n");
}
/* 取り付け位置のイラスト(区画を示し、対象部品を丸/矢印で強調) */
function buildPartLocationImagePrompt(part, carName, refDesc, hasRef) {
  const lines = [
    "自動車整備マニュアル用の『部品の取り付け位置イラスト』を1枚生成してください。",
    "目的: 指定部品が車両のどこに付いているかが一目で分かる図。該当区画(エンジンルーム/下部/室内等)を示し、対象部品を控えめな丸囲みまたは矢印で1か所だけ強調する。周囲の目印部品も描いて位置関係が分かるように。",
    "対象車両(実物に合わせる): " + (carName || "一般的な自動車") + "。車格・レイアウトをこの車種に合わせ、別車格の部品を描かない。",
  ];
  if (hasRef) lines.push("【最重要】添付の参照画像に厳密に従い、部品の形状・位置・周囲との関係を正確に再現(構造は保持)。画風だけ下記イラストに変える。");
  if (refDesc && !hasRef) { lines.push("【実物の特徴(反映)】"); lines.push(refDesc); }
  lines.push(
    "スタイル(厳守): 清潔感のある半写実イラスト(整備教本の挿絵風)。やわらかい陰影と分かりやすい色分け。1コマのみ。写真そのものにはしない。",
    "禁止: 文字/数字/ロゴ/寸法線/透かし、人物の顔や全身、過度な誇張。強調の丸/矢印以外の余計な装飾は避ける。",
    "強調する対象部品: " + part
  );
  return lines.join("\n");
}
function buildPartPhotoPrompt(stepText, carName, refDesc) {
  const lines = [
    "自動車整備の資料用に、実物に忠実な写実的クローズアップ画像を1枚生成してください。",
    "目的: 部品の実際の形状・取り付け位置・向き・締結部(ボルト/クリップ)・周囲の部品との位置関係を、現車と同等の再現性で正確に示すこと。",
    "対象車両: " + (carName || "一般的な自動車") + "。この車種・車格に実在する該当部品の正しい形状とレイアウトにすること。別車種・別車格の部品にしない。",
    "構図: 作業対象の部品を画面中央に大きく、実際の取り付け状態(車体上の位置関係が分かる範囲)で。整備士の手や工具は入れても入れなくてもよいが、部品の形状を隠さない。",
    "写実・正確第一。文字/数字/ロゴ/寸法線/透かしは入れない。誇張やイラスト化はしない(これは資料写真)。",
  ];
  if (refDesc) { lines.push("【実物の特徴メモ(反映する)】"); lines.push(refDesc); }
  lines.push("作業/対象: " + stepText);
  return lines.join("\n");
}
/* 画像生成モデル向けプロンプト(整備イラスト)。carName=車両 / refDesc=特徴資料 / hasRef=参照画像あり */
function buildStepImagePrompt(stepText, carName, refDesc, hasRef) {
  const lines = [
    "自動車整備マニュアルの『作業手順イラスト』を1枚生成してください。",
    "最重要: 車の外観カタログ写真ではなく、その作業を“今まさに行っている動作”が一目で分かる図にすること。",
    "対象車両(この車の実物に合わせて描く): " + (carName || "一般的な自動車") + "。この車種の車格・ボディタイプ(軽/乗用/ミニバン/トラック等)や、該当部品の実際の形状・レイアウトに合わせること。別の車格の部品を描かない。",
  ];
  if (hasRef) {
    lines.push("【最重要・添付の参照画像に厳密に従う】添付画像は実物に忠実な資料です。部品の形状・比率・取り付け位置・向き・締結部・周囲部品との位置関係を、参照画像どおりに正確に再現(トレースするつもりで構造を保持)すること。位置や形を勝手に変えない。");
    lines.push("変えるのは画風だけ: 参照画像の構造はそのまま、下記のイラストタッチに描き直す。");
  }
  lines.push(
    "視点・構図: 作業対象の部品を画面中央に大きく配置(寄りのクローズアップ)。整備士の手と工具が、その部品のどこに・どの向きで当たり、どう動かすかが明確に分かる角度で描く。",
    "動作の明示: 工具の回転方向や部品の着脱方向を、控えめな矢印で1〜2本だけ示す。手は作業に必要な分だけ(1〜2本)描き、部品を隠さない。",
    "正確さ: 工具の種類(レンチ/ラチェット/ドライバー/ジャッキ等)と部品の形状・取り付け位置を、その作業として技術的に正しく描く。ボルト本数や向きなど分かる範囲で実機に忠実に。誤った構造は描かない。"
  );
  if (refDesc && !hasRef) { lines.push("【実物の特徴(忠実に反映)】"); lines.push(refDesc); }
  lines.push(
    "スタイル(厳守・変更禁止): 清潔感のある半写実イラスト(整備教本の挿絵風)。やわらかい陰影と分かりやすい色分け。背景は薄いガレージ床/単色でごく簡素にし、作業部位を最も目立たせる。1コマのみ(複数コマ・分割なし)。写真そのものにはしない。",
    "禁止: 車全体の外観・テールランプ・エンブレム等“車種が分かるだけ”の絵、文字/数字/ロゴ/寸法線/透かし、人物の顔や全身、過度な誇張やマンガ的効果。",
    "作業内容(これを描く): " + stepText
  );
  return lines.join("\n");
}
/* 実物の見た目を文章で正確に洗い出す(実写知識ベースの資料。イラスト精度向上用。キャッシュあり) */
async function geminiStepVisualRef(stepText, carName) {
  const prompt = [
    "あなたは自動車整備の資料担当です。次の作業を図解するための『実物の見た目メモ』を作ってください。",
    "実際の写真を思い出すつもりで、事実に基づいて具体的に。箇条書きで4〜6行、各行短く。",
    "含める観点: 作業対象の部品の形状・色・素材感 / 使う工具の種類と当て方 / 手の位置と動かす方向 / 周囲にある目印になる部品 / 一番分かりやすいカメラ視点。",
    "推測が混じる場合はその旨は書かず、最も一般的で確からしい実物の特徴を書く。前置き・説明・見出しは不要、メモ本文だけ。",
    "対象車両: " + (carName || "一般的な自動車"),
    "作業: " + stepText,
  ].join("\n");
  const r = await geminiAsk(prompt, { mode: "flash" });
  return String(r.text || "").trim().slice(0, 700);
}
/* 手順テキストから、シンプルな線画SVGをGeminiに描かせる(キャッシュあり) */
async function geminiStepFigure(stepText) {
  const prompt = [
    "あなたは整備マニュアル用の図を描くイラストレーターです。",
    "次の自動車整備の手順を理解しやすくする、シンプルな線画の説明イラストを SVG で1枚描いてください。",
    "条件: 出力は <svg> ～ </svg> のみ(前後の文章・コードフェンス・説明は一切不要)。",
    "viewBox=\"0 0 400 300\" を指定し、width/heightは付けない。背景は描かない(透明)。",
    "線は stroke=\"#1f2a44\" stroke-width=\"3\" fill=\"none\" を基本に、必要な部分だけ薄い塗り(fill=\"#dbe4f3\")。",
    "要点を矢印で示し、日本語の短いラベルを <text fill=\"#1f2a44\" font-size=\"15\"> で2〜4個まで添える。",
    "写実的でなくてよい。記号的・模式的に、工具や部品の位置関係が伝わることを最優先。",
    "<script> や外部参照(href, image)は使わないこと。",
    "■対象車両: " + ((current && (current.model || current.type)) || "一般車両"),
    "■描く手順: " + stepText,
  ].join("\n");
  const r = await geminiAsk(prompt, { mode: "flash" });
  let s = String(r.text || "").trim();
  const i = s.indexOf("<svg"); const j = s.lastIndexOf("</svg>");
  if (i < 0 || j < 0) return "";
  s = s.slice(i, j + 6);
  // 安全化: scriptや外部参照を除去
  s = s.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/\son\w+="[^"]*"/gi, "")
       .replace(/(href|xlink:href|src)\s*=\s*"[^"]*"/gi, "");
  return /<svg[\s\S]*<\/svg>/i.test(s) ? s : "";
}

/* 「解析する」から自動実行されるAI診断 (キー未設定なら案内カードのみ) */
let diagAiBusy = false;
async function runDiagAI(text) {
  const box = $("diagResults");
  if (!aiOK()) {
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
    const r = await geminiAsk(buildDiagPrompt(text), { mode: "pro" });   // 故障診断は常に高精度(思考ON)
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
        for (const a of atts) media.push({ mimeType: cleanMime(a.file.type, a.kind === "video" ? "video/mp4" : "image/jpeg"), data: await fileToBase64(a.file) });
        r = await geminiAskMedia(prompt, media);
      } else {
        r = await geminiAsk(prompt, { mode: "pro" });   // 故障診断は常に高精度(思考ON)
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
/* 現在の車両について分かっている事実(車種名・諸元・持病)をまとめて返す。
   車種名は 正データ(手動編集DB) > DB一致 > 履歴/学習 の優先で確定 */
function currentVehicleFacts() {
  const d = current || {};
  const code = d.type && d.type.includes("-") ? d.type.split("-")[1] : d.type;
  const v = code ? findVehicle(code) : null;
  const byVin = d.vin ? CUSTOM_DB.find(x => x.vin && x.vin === d.vin) : null;
  const he = findHistEntry(getHistory(), d) || {};
  const learned = getLearned(vehicleKey(d)) || {};
  // 手動編集済みの正データを最優先
  const hit = (byVin && byVin.manual && byVin) || (v && v.manual && v) || byVin || v || null;
  const model = (hit && hit.name) || he.model || learned.model || null;
  const faults = (hit && hit.faults && hit.faults.length ? hit.faults : null) || he.faults || learned.faults || [];
  const specs = (he.specs && he.specs.length ? he.specs : learned.specs) || (hit && hit.specs) || [];
  return { d, model, faults, specs };
}
function vehicleDesc() {
  const parts = [];
  const f = currentVehicleFacts();
  if (f.model) parts.push("車種 " + f.model);
  if (current.type) parts.push("型式 " + current.type);
  if (current.kataShitei) parts.push("型式指定番号・類別区分番号 " + current.kataShitei);
  if (current.engine) parts.push("原動機型式 " + current.engine);
  if (current.vin) parts.push("車台番号 " + current.vin);
  return parts.length ? parts.join(" / ") : "不明";
}
/* メンテナンス諸元＋定番故障/持病をAIから一括取得(JSON) */
function buildSpecPrompt() {
  return [
    "あなたは日本の自動車整備士向けのデータアドバイザーです。",
    "次の車両について、(A)整備に必要なメンテナンス諸元、(B)この車種の定番故障・持病、(C)過去に届出された主なリコール・改善対策・サービスキャンペーンの有無 を答えてください。",
    "型式が不明な場合は、型式指定番号・類別区分番号や車台番号・原動機型式から車種を推定して構いません。",
    "【必ず調べてから答える】記憶や勘で数値を出さない。付与されたGoogle検索ツールを使い、メーカー公式諸元・整備解説・信頼できる情報源で、この車種・型式・原動機・年式に固有の実際の値を確認してから答えること。オイル量・冷却水量・各種容量・締付トルクは車種差が大きいので必ず裏取りする。",
    "【値は具体的に出す・安易な要確認は禁止】検索して得られた実値を、できる限り具体的な数値で書くこと。少し調べれば分かる値を『（要確認）』で済ませない。値が交換条件で変わるなら『値＋条件』(例: エンジンオイル量『9.0L（オイルのみ）／10.0L（エレメント同時交換）』)。締付トルクは『規定値±公差』(例: ホイールナット『600±50 N·m』)。範囲だけ(550〜650)や創作値は不可。",
    "【要確認は最終手段】十分に検索しても確かな一次情報が得られなかった値に限り『（要確認）』とする(逃げの要確認は不可)。ただし誤った数値を書くのは最悪なので、本当に不明なら創作せず要確認にする。",
    "【リコールも必ず検索して調べる】記憶や心当たりで書かない。Google検索で『国土交通省 リコール届出情報』やメーカー公式のリコール・改善対策・サービスキャンペーン情報を、この型式・車種・年式で実際に調べること。見つかった届出は『年月・対象部位・不具合内容・対策』が分かる形で1件1文にまとめる(最大5件、新しい順)。検索しても該当が確認できなければrecallsは空配列にし、憶測で埋めない。",
    "【定番故障も検索して裏取り】faultsも記憶頼みにせず、この車種・型式の整備事例・故障事例・不具合報告を検索し、実際に多発が確認できた症状のみを書く。症状だけでなく『原因部位』と『出やすい時期(走行距離・年式)』が分かれば併記する。創作・一般論(どの車にも言える話)は不可。確認できなければ空配列でよい。",
    "あわせて、推定できる車種名(メーカー名+車種名、例『日野 プロフィア』)と、メーカーを次のローマ字キーのいずれかで答えること: isuzu,hino,fuso,ud,nissan,toyota,honda,mazda,suzuki,daihatsu,subaru,other。判別できなければmodelは空文字、makerは\"other\"。",
    "【表記ルール】各値は日本語＋数値のみで簡潔に。引用・出典マーカー([cite:...]、[17]、(from previous search)等)や英語の注釈は絶対に本文へ入れない。検索は内部で行い、結果の数値だけを書く。",
    "出力は厳密なJSONのみ(前後に文章やコードフェンス不要)。形式:",
    '{"model":"日野 プロフィア","maker":"hino","specs":[{"k":"エンジンオイル量","v":"12.0L（オイルのみ）／13.0L（エレメント同時交換）"},{"k":"推奨オイル粘度","v":"…"},{"k":"クーラント量","v":"…"},{"k":"ホイールナット締付トルク","v":"600±50 N·m"},{"k":"ATF/CVT/ミッションオイル","v":"…"},{"k":"デフオイル（デファレンシャルオイル）","v":"…(粘度・油量・該当する場合は前後/LSD有無も)"},{"k":"車台番号の打刻位置","v":"…(例: 助手席足元のフロア、右フロントシート下など)"},{"k":"エンジン型式の打刻位置","v":"…(例: シリンダーブロック前面など)"}],"faults":["定番故障・持病を1件1文で複数"],"recalls":["主なリコール/改善対策を1件1文(年式・対象部位が分かれば併記)"]}',
    "『オイルエレメント』『オイル交換目安』の項目は出力しないこと。『デフオイル（デファレンシャルオイル）』『車台番号の打刻位置』『エンジン型式の打刻位置』は、確証があれば含める(不確かなら無理に出さない)。整備で重要かつ確証のある項目のみ追加してよい。",
    "",
    "■対象車両: " + vehicleDesc()
  ].join("\n");
}
async function runSpecAI(srcBtn) {
  stopFieldMic();
  if (!aiOK()) {
    alert("AIで調べるには無料のGemini APIキーの設定が必要です。\n\n設定タブ →「AI相談機能」の手順でキーを取得・保存してください(クレジットカード不要)。");
    switchView("settings");
    return;
  }
  // 「最新に更新」で既存の(訂正含む)データを上書きする前に確認
  if (srcBtn && srcBtn.id === "btnSpecReload" && shownSpecs && shownSpecs.length) {
    if (!confirm("最新のAI結果で諸元を取り直します。手動で訂正した項目はそのまま保持します。よろしいですか？")) return;
  }
  const box = $("specAiBox");
  toggle("specAiBox", true);
  box.textContent = "🔧 メカ君が諸元・定番故障を調べています…(数秒〜十数秒)";
  const btn = srcBtn || $("btnSpecAI"); setBtnLoading(btn, true, "メカ君が調べ中…");
  const force = srcBtn && srcBtn.id === "btnSpecReload";   // 「最新に更新」はキャッシュを使わず再取得
  try {
    // 諸元は正確性最優先: 高精度(pro/思考ON)＋Google検索グラウンディングで実データから取得。
    // 車両ごとに一度取得すれば学習キャッシュに保存され次回はAI不要(コストは初回のみ)。
    const r = await geminiAsk(buildSpecPrompt(), { noCache: force, mode: "pro", search: true });
    const obj = extractJson(r.text);
    let specs = [], faults = [], recalls = [], model = "", maker = "";
    if (obj) {
      specs = Array.isArray(obj.specs) ? obj.specs.filter(s => s && s.k).map(s => ({ k: cleanCite(String(s.k)), v: cleanCite(String(s.v || "")) })).filter(s => s.k && s.v) : [];
      faults = Array.isArray(obj.faults) ? obj.faults.map(x => cleanCite(String(x))).filter(Boolean) : [];
      recalls = Array.isArray(obj.recalls) ? obj.recalls.map(x => cleanCite(String(x))).filter(Boolean) : [];
      model = obj.model ? String(obj.model).trim() : "";
      maker = obj.maker ? String(obj.maker).trim().toLowerCase() : "";
    }
    // JSONで取れない時はテキストを諸元へフォールバック分解
    if (!specs.length) { lastSpecAiText = r.text; specs = aiTextToSpecs(r.text); }
    if (!specs.length && !faults.length && !recalls.length) { renderAiAnswer(box, r.text); return; }
    // 手動修正済みの項目はAI結果で消さずに保持
    if (specs.length) specs = mergeKeepManual(specs, shownSpecs);
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

/* 項目ごとに最新値だけ取り直す(右上の🔄) */
async function refreshSpecItem(key, btn) {
  stopFieldMic();
  if (!aiOK()) {
    alert("AIで調べるには無料のGemini APIキーの設定が必要です。\n\n設定タブ →「AI相談機能」の手順でキーを取得・保存してください(クレジットカード不要)。");
    switchView("settings"); return;
  }
  if (btn) { btn.classList.add("loading"); btn.disabled = true; }
  try {
    const prompt = [
      "あなたは日本の自動車整備士向けのデータアドバイザーです。",
      "次の車両の整備諸元のうち、指定された1項目だけを答えてください。",
      "【要確認の書き方】確信が持てない場合のみ『（要確認）』とだけ書く。長い但し書きは不要。",
      "【曖昧禁止】『オイルパンの仕様により異なる』等の逃げは禁止。車台番号・原動機型式から特定して確定値を出すこと。交換条件で変わる場合のみ『値＋条件』を簡潔に。",
      "【締付トルク】範囲ではなく『規定値±公差』の形(例 600±50 N·m)。",
      "出力は厳密なJSONのみ。形式: {\"v\":\"値\"}",
      "",
      "■対象車両: " + vehicleDesc(),
      "■知りたい項目: " + key
    ].join("\n");
    const r = await geminiAsk(prompt, { noCache: true, mode: "pro" });   // 項目の再取得は高精度
    const obj = extractJson(r.text);
    const nv = obj && obj.v != null ? String(obj.v).trim() : String(r.text || "").trim();
    if (!nv) return;
    const idx = shownSpecs.findIndex(s => s.k === key);
    if (idx >= 0) shownSpecs[idx] = { k: key, v: nv }; else shownSpecs.push({ k: key, v: nv });
    const specs = shownSpecs.slice();
    setLearned(vehicleKey(current), { specs });
    saveVehicleAiData(specs);
    registerVehicleToDB({ silent: true });
    renderSpecs(specs, "learned");
  } catch (e) {
    if (e.message !== "__cancelled__") alert("⚠ " + (e.message || "更新に失敗しました"));
  } finally {
    if (btn) { btn.classList.remove("loading"); btn.disabled = false; }
  }
}

/* ---- 写真・動画の添付AI解析(Geminiマルチモーダル) ---- */
function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => {
      // data URL の mime に codecs="vp8,opus" などコンマが含まれる場合があるため "base64," 以降を厳密に取り出す
      const s = String(r.result);
      const i = s.indexOf("base64,");
      res(i >= 0 ? s.slice(i + 7) : s.slice(s.indexOf(",") + 1));
    };
    r.onerror = () => rej(new Error("ファイルを読み込めませんでした"));
    r.readAsDataURL(file);
  });
}
/* inlineData用にmimeTypeからcodecsなどのパラメータをはずしてGeminiが受け付ける形に */
function cleanMime(m, fallback) {
  m = (m || fallback || "").split(";")[0].trim();
  return m || fallback;
}
/* 動画(＋プロンプト)をGeminiに送って解析。textのみ版geminiAskと別系統(キャッシュなし) */
/* 動画・画像対応モデル(liteは動画非対応のことがあるため除外) */
const GEMINI_MEDIA_MODELS = {
  flash: ["gemini-2.5-flash", "gemini-2.0-flash"],
  pro: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"]
};
async function geminiAskMedia(prompt, media) {
  const key = localStorage.getItem(LS.gemini);
  // 自分の鍵が無い契約店舗のみサーバー(mecha)経由(画像/動画も渡す)。鍵がある人は従来どおり。
  if (!key && window.Cloud && window.Cloud.aiReady && window.Cloud.aiReady()) {
    const d = await window.Cloud.callFn("mecha", { prompt, mode: getAiMode(), media });
    if (d && d.text) return { text: d.text, truncated: !!d.truncated, model: "proxy" };
    throw new Error("AIから回答が得られませんでした");
  }
  if (!key) throw new Error("Gemini APIキーが未設定です。");
  let lastErr = null;
  for (const model of GEMINI_MEDIA_MODELS[getAiMode()]) {
    try {
      const genCfg = { temperature: 0.2, maxOutputTokens: 16384 };
      if (model.startsWith("gemini-2.5")) genCfg.thinkingConfig = { thinkingBudget: -1 };
      const parts = [{ text: prompt }, ...media.map(m => ({ inlineData: { mimeType: m.mimeType, data: m.data } }))];
      const res = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + encodeURIComponent(key),
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts }], generationConfig: genCfg }) });
      if (res.status === 404) { lastErr = new Error(model + " は利用不可"); continue; }
      if (res.status === 429) { lastErr = new Error("無料枠の上限に達しました。1分待つ／標準モードにする等をお試しください。"); continue; }
      if (res.status === 403) throw new Error("APIキーが無効です。設定タブでキーを確認してください。");
      if (res.status === 400) {   // 400は次モデルでも試す(モデル非対応やサイズ等の切り分け)
        let detail = ""; try { detail = (await res.json()).error?.message || ""; } catch (e) {}
        lastErr = new Error("送信できませんでした(" + model + "): " + (detail || "動画が大きすぎる可能性。10〜15秒に短く／低画質でお試しを"));
        continue;
      }
      if (!res.ok) { lastErr = new Error("AI応答エラー (" + res.status + ")"); continue; }
      const j = await res.json();
      const cand = j.candidates?.[0];
      const text = cand?.content?.parts?.filter(p => !p.thought).map(p => p.text || "").join("") || "";
      if (!text) throw new Error("AIから回答が得られませんでした");
      return { text, truncated: cand?.finishReason === "MAX_TOKENS", model };
    } catch (e) {
      if (e.message && (e.message.includes("上限") || e.message.includes("キーが無効"))) throw e;
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
    "理由: なぜこの症状・映像からこの原因を疑うのか、根拠を1文で簡潔に。",
    "切り分け: 確認方法。使用工具と測定値の目安を含める。1〜2文で簡潔に。",
    "2.（同様に最大5つまで。各候補に必ず『理由:』と『切り分け:』を付ける）",
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
  const ld = aiLangDirective(); if (ld) lines.push("\n" + ld);
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

/* ===== 修理タブ「修理について質問」の写真添付(複数枚・画像のみ) ===== */
const vehAttachments = [];   // {file, url}
[["btnVehPhoto", "inVehPhoto"], ["btnVehPhotoCam", "inVehPhotoCam"]].forEach(([btn, input]) => {
  const b = $(btn), inp = $(input); if (!b || !inp) return;
  b.addEventListener("click", () => inp.click());
  inp.addEventListener("change", e => {
    const files = [...e.target.files]; e.target.value = "";
    for (const f of files) { if ((f.type || "").startsWith("image")) { vehAttachments.push({ file: f, url: URL.createObjectURL(f) }); } }
    renderVehAttachList();
  });
});
function renderVehAttachList() {
  const box = $("vehAttachList"); if (!box) return;
  box.innerHTML = "";
  vehAttachments.forEach((a, i) => {
    const d = document.createElement("div"); d.className = "attachThumb";
    const img = document.createElement("img"); img.src = a.url;
    const kind = document.createElement("span"); kind.className = "axKind"; kind.textContent = "写真";
    const del = document.createElement("button"); del.className = "axDel"; del.textContent = "×";
    del.addEventListener("click", () => { URL.revokeObjectURL(a.url); vehAttachments.splice(i, 1); renderVehAttachList(); });
    d.append(img, kind, del); box.appendChild(d);
  });
  toggle("vehAttachList", vehAttachments.length > 0);
}
function clearVehAttachments() {
  vehAttachments.forEach(a => URL.revokeObjectURL(a.url));
  vehAttachments.length = 0; renderVehAttachList();
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
        resolve(new File([blob], "compressed.webm", { type: cleanMime(blob.type, "video/webm") }));
      };
      const st0 = $("diagVideoStatus");
      const draw = () => {
        if (v.ended || v.paused) return;
        cx.drawImage(v, 0, 0, w, h);
        if (st0 && dur) st0.textContent = "動画を圧縮中… " + Math.min(99, Math.round(v.currentTime / dur * 100)) + "%（動画の長さ分かかります）";
        requestAnimationFrame(draw);
      };
      v.onplay = () => draw();
      v.onended = () => { try { rec.stop(); } catch (e) {} };
      rec.start();
      v.play().catch(err => { URL.revokeObjectURL(url); reject(err); });
      // 保険: 想定尺+3秒で強制停止
      setTimeout(() => { if (rec.state !== "inactive") { try { v.pause(); rec.stop(); } catch (e) {} } }, (dur + 3) * 1000);
    };
    v.onerror = () => { URL.revokeObjectURL(url); reject(new Error("動画を読み込めませんでした")); };
  });
}

let diagMediaBusy = false;
async function diagMediaAnalyze() {
  if (!aiOK()) {
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
    for (const a of diagAttachments) media.push({ mimeType: cleanMime(a.file.type, a.kind === "video" ? "video/mp4" : "image/jpeg"), data: await fileToBase64(a.file) });
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
        if (typeof autoGrow === "function") autoGrow(fld);
      };
      rec.onerror = () => {};
      rec.onend = () => {
        // 自動再開しない(再開のたびに開始音=ピコ音が鳴るのを防ぐ)。1回の認識で確定
        accum += sessionFinal; sessionFinal = ""; micRec = null; micListening = false;
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
wireFieldMic("btnKarteMic", "kWork", "🎤");

/* ===== メカ君と音声会話(STT → Gemini → TTS) ===== */
let voiceRec = null, voiceHistory = [], voiceActive = false;
/* 音声会話セクションを開く。呼び出し元(診断/質問)の直下へ移動して表示 */
function openVoiceChat(afterEl) {
  if (!aiOK()) {
    alert("音声会話には無料のGemini APIキーの設定が必要です（設定タブ）。");
    switchView("settings"); return;
  }
  if (!getSpeechRecognition()) { alert("この端末/ブラウザは音声認識に対応していません(Chrome等をお試しください)。"); return; }
  const sec = $("voiceChatSec");
  if (afterEl && afterEl.parentNode) afterEl.parentNode.insertBefore(sec, afterEl.nextSibling);
  toggle("voiceChatSec", true);
  sec.scrollIntoView({ behavior: "smooth" });
}
$("btnDiagVoiceChat") && $("btnDiagVoiceChat").addEventListener("click", e => openVoiceChat(e.currentTarget.closest("section")));
$("btnVehVoiceChat") && $("btnVehVoiceChat").addEventListener("click", e => openVoiceChat(e.currentTarget.closest("section")));
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
    // 自動再開しない(ピコ音の連発防止)。話し終わり(無音)または再押下で1回分を送信
    voiceAccum += voiceSessionFinal; voiceSessionFinal = ""; voiceRec = null; voiceListening = false;
    $("btnVoiceTalk").textContent = "🎤 押して話す";
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
  const f = currentVehicleFacts();
  if (f.d && (f.d.type || f.d.vin || f.model)) {
    lines.push("");
    lines.push("【この相談は下記の特定車両についてです。一般論ではなく、必ずこの車両を前提に具体的に答えること。車種・型式が分かっているのに『車種が分かりません』『一般的には』と逃げない】");
    lines.push("対象車両: " + vehicleDesc());
    if (f.faults && f.faults.length) lines.push("この車種の既知の持病・定番故障: " + f.faults.slice(0, 8).join(" / "));
    if (f.specs && f.specs.length) lines.push("把握済みの整備諸元: " + f.specs.slice(0, 12).map(s => s.k + "=" + s.v).join(" / "));
  } else {
    lines.push("(まだ車両が読み取られていません。車両が必要な質問なら、車検証スキャンを促してください。)");
  }
  lines.push("");
  lines.push("これまでの会話:");
  voiceHistory.slice(-8).forEach(m => lines.push((m.role === "user" ? "整備士" : "メカ君") + ": " + m.text));
  lines.push("メカ君として次の返答を述べてください。");
  if (window.APP_LANG === "en") lines.push("Reply in natural spoken English (2-4 short sentences, no markdown).");
  return lines.join("\n");
}

/* =========================================================
   タブ切替・初期化
   ========================================================= */
function switchView(name) {
  if (name !== "scan" && typeof scanning !== "undefined" && scanning) stopLiveScan(false);
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === "view-" + name));
  // 車両のサブページ(メンテ/診断/部品)は下部タブ上「スキャン」を選択状態に
  const tabName = ["maint", "diag", "parts", "karte"].includes(name) ? "scan" : name;
  if (name === "karte") { toggle("karteForm", false); renderKarte(); }
  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("active", b.dataset.view === tabName));
  // 共通ナビの現在ページをハイライト(枠だけ色)
  document.querySelectorAll(".pageNav .navBtn").forEach(b => b.classList.toggle("navActive", b.dataset.go === name));
  if (name === "diag") updateDiagVehicleHint();
  if (name === "parts") renderCopyKata();
  if (name === "scan") renderLastVehicle();
  if (name === "admin" && window.CloudAdmin) window.CloudAdmin.open();
  // 表示に切り替わった時、内容のある自動拡大欄の高さを再計算(タブ移動で縮むのを防ぐ)
  if (typeof autoGrowAll === "function") requestAnimationFrame(autoGrowAll);
  window.scrollTo(0, 0);
}
document.querySelectorAll("#tabs button").forEach(b =>
  b.addEventListener("click", () => {
    // 下部「スキャン」タブ: 車両表示中に押したらホーム(3つの入口=カメラ/全体を撮影/手動入力)へ戻す
    if (b.dataset.view === "scan" && !$("result").classList.contains("hidden")) { goHome(); return; }
    switchView(b.dataset.view);
  }));

/* ホーム(スキャン初期画面)に戻す: 車両表示・進捗を畳み、メカ君ヒーローとスキャンボタンを出す */
function goHome() {
  if (typeof scanning !== "undefined" && scanning) stopLiveScan(false);
  switchView("scan");
  toggle("result", false);
  toggle("mechaHero", true);
  foldEntryAreas();
  toggle("scanWrap", false); toggle("scanCtrls", false);
  toggle("scanProgress", false); toggle("scanActions", false); toggle("qrPhotoStatus", false);
  toggle("btnStart", true); toggle("btnStop", false); toggle("btnStopRow", false);
  document.body.classList.remove("scanningNow");
  toggle("fallbackLinks", true);
  // ホームへ戻る際、閲覧中だった車両を「前回の車両」にする。
  // 診断/修理の作業内容は保存しておき、チップから開き直したとき復元できるようにする。
  if (current && (current.type || current.vin || current.kataShitei)) {
    try { saveVehWork(vehicleKey(current)); } catch (e) {}
  }
  current = null;
  renderLastVehicle();
  window.scrollTo(0, 0);
}
/* ヘッダーのロゴ/文字タップでホームへ戻る */
(() => { const h = document.querySelector("header"); if (h) { h.style.cursor = "pointer"; h.addEventListener("click", goHome); } })();

/* 型式のハイフンより後ろ(車種記号)だけ取り出す。例 2PG-FW74HZ → FW74HZ */
function kataSuffix(t) { const s = String(t || "").trim(); if (!s) return ""; const i = s.indexOf("-"); return i >= 0 ? s.slice(i + 1).trim() : s; }
/* 車台番号のハイフンより前(打刻の車種記号部)。例 RK5-1028429 → RK5 / NKR85Y-70123 → NKR85Y
   ハイフンが無い打刻(例 NKR85Y7012345)は、末尾の一連番号(英字の後に続く5桁以上の数字)を除いた記号部を返す */
function vinPrefix(v) {
  let s = String(v || "").trim(); if (!s) return "";
  const i = s.indexOf("-"); if (i >= 0) s = s.slice(0, i).trim();   // ハイフンがあれば前半のみ
  // FAINESの車台番号キーワード検索は「英字＋数字」までで一致する。末尾の英字・一連番号は落とす。
  //   例: CYG60CM → CYG60 ／ NKR85Y7012345 → NKR85 ／ RK5(-1028429) → RK5
  const m = s.match(/^([A-Za-z]+\d+)/);
  return (m ? m[1] : s).trim();
}
/* 修理タブ: FAINES検索用に車台番号(ハイフン前)をコピー。無ければ型式(車種記号)で代替 */
function renderCopyKata() {
  const el = $("copyKata"); if (!el) return;
  const code = vinPrefix(current && current.vin) || kataSuffix(current && current.type);
  if (!code) { toggle("copyKata", false); return; }
  el.innerHTML = '📋 <b>' + esc(code) + '</b> をコピー';
  toggle("copyKata", true);
  el.onclick = async () => {
    try { await navigator.clipboard.writeText(code); } catch (e) {}
    const orig = el.innerHTML; el.innerHTML = '✓ コピー';
    setTimeout(() => { el.innerHTML = orig; }, 1200);
  };
  // 年式(初度登録年)を横に表示(参考表示・コピー不可)
  const yEl = $("kataYear"); if (yEl) {
    const fr = current && current.firstReg; const yr = fr && fr.year;
    if (yr) { yEl.textContent = "年式: " + yr + "年" + (fr.month ? "/" + fr.month + "月" : ""); toggle("kataYear", true); }
    else toggle("kataYear", false);
  }
}
/* 最近表示した車両を記録(表示のたびに更新。前回=最後に表示していた車両) */
function vehId(v) { return [(v && v.type) || "", (v && v.vin) || "", (v && v.kataShitei) || "", (v && v.plate) || ""].join("|"); }
function pushRecentVehicle(d) {
  if (!d || !(d.type || d.vin || d.kataShitei)) return;
  try {
    let arr = JSON.parse(localStorage.getItem("ss_recentVeh") || "[]");
    const nm = (findHistEntry(getHistory(), d) || {}).name || d.name || null;
    const card = { type: d.type || null, vin: d.vin || null, kataShitei: d.kataShitei || null, plate: d.plate || null, name: nm, rid: d.rid || null, at: Date.now() };
    arr = arr.filter(v => vehId(v) !== vehId(card));   // 同一車両は重複させない
    arr.unshift(card);
    localStorage.setItem("ss_recentVeh", JSON.stringify(arr.slice(0, 6)));
  } catch (e) {}
}
/* 型式が空の車両を、車台番号(打刻)からAIで特定して自動保存する。返り値=特定できた型式 or null */
const typeInferBusy = new Set();
async function inferTypeFromVin(d) {
  if (!d || d.type || !d.vin) return null;
  if (!localStorage.getItem(LS.gemini)) return null;
  const id = vehId(d);
  if (typeInferBusy.has(id)) return null; typeInferBusy.add(id);
  try {
    const prompt = [
      "あなたは日本の自動車整備士向けデータアドバイザーです。",
      "次の車台番号(と分かれば原動機型式)から、この車両の『型式』(排出ガス記号-車種記号。例 2PG-FW74HZ / SKG-NKR85YN)を特定してください。",
      "車台番号の打刻(例 NKR85-7012345 の『NKR85』)は車種記号に対応します。排ガス記号・年式まで確実でなくても、少なくとも車種記号部分は答えること。",
      "確実に判断できない場合のみ type は空文字。憶測での断定は避ける。出力は厳密なJSONのみ: {\"type\":\"...\"}",
      "車台番号: " + d.vin + (d.engine ? "\n原動機型式: " + d.engine : "")
    ].join("\n");
    const r = await geminiAsk(prompt, { mode: "flash" });
    const obj = extractJson(r.text);
    let ty = obj && obj.type ? String(obj.type).toUpperCase().trim() : "";
    if (!ty || /不明|^[-\s]*$/.test(ty)) return null;
    d.type = ty;
    // 履歴(=車両データ)へ自動保存＋社内共有
    const h2 = getHistory(); const e = findHistEntry(h2, d);
    if (e) { e.type = ty; e.updatedAt = Date.now(); localStorage.setItem(LS.hist, JSON.stringify(h2)); if (window.Cloud) window.Cloud.pushRecord(e); }
    return ty;
  } catch (e) { return null; } finally { typeInferBusy.delete(id); }
}
/* スキャン済み履歴のうち、型式が空で車台番号がある車両をまとめてVINから特定・保存(起動後に静かに実行) */
async function backfillTypesFromVin() {
  if (!localStorage.getItem(LS.gemini) || !navigator.onLine) return;
  const targets = getHistory().filter(h => h.vin && !h.type).slice(0, 15);
  let changed = false;
  for (const h of targets) {
    const ty = await inferTypeFromVin({ type: null, vin: h.vin, engine: h.engine, plate: h.plate, kataShitei: h.kataShitei, rid: h.rid });
    if (ty) changed = true;
    await new Promise(r => setTimeout(r, 700));   // 無料枠に配慮して間隔をあける
  }
  if (changed) { renderHistory(); renderLastVehicle(); }
}
/* ホーム: 前回の車両チップ(=現在表示中を除いた、最後に表示していた車両) */
function renderLastVehicle() {
  const el = $("lastVehicle"); if (!el) return;
  let arr = [];
  try { arr = JSON.parse(localStorage.getItem("ss_recentVeh") || "[]"); } catch (e) {}
  const curId = (current && (current.type || current.vin || current.kataShitei)) ? vehId(current) : "";
  const last = arr.find(v => vehId(v) !== curId);
  if (!last) { toggle("lastVehicle", false); return; }
  const label = [dispText(last.plate), dispText(last.name)].filter(Boolean).join(" / ") || dispText(last.type) || "前回の車両";
  el.innerHTML = '🕒 前回の車両: <b>' + esc(label) + '</b> ›';
  toggle("lastVehicle", true);
  el.onclick = () => { const e2 = findHistEntry(getHistory(), last); showResult(e2 ? histToResult(e2) : last, { fromScan: false }); };
}

/* さりげないトースト通知(数秒で自動的に消える) */
function showToast(msg) {
  let t = document.getElementById("appToast");
  if (!t) { t = document.createElement("div"); t.id = "appToast"; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove("show"), 2800);
}

(async function init() {
  applyAppMode();   // 個人/法人モードを反映(同期・契約タブの表示切替)
  loadCustomDB();
  await Promise.all([loadBuiltinDB(), loadDiagDB()]);
  renderHistory();
  renderLastVehicle();   // ホームに前回車両チップ
  renderDBList();
  applyRoleUI();   // 権限に応じてデータ管理/削除ボタンを制御
  renderGeminiStat();
  renderVisionStat();
  renderCseStat();
  renderAiMode();
  // Stripe決済から戻ってきた時のお礼(?paid=1)。プラン有効化は数秒後にサーバー側で反映される。
  try {
    if (/[?&]paid=1/.test(location.search)) {
      showToast("お支払いありがとうございます。数秒後に契約が有効になります。");
      history.replaceState(null, "", location.pathname);
    }
  } catch (e) {}
  // 表示バージョンは Service Worker のキャッシュ番号(shaken-scan-vNNN)から自動取得(二重管理を避ける)
  appVerDisplay().then(ver => {
    if (sessionStorage.getItem("ss_justUpdated")) { sessionStorage.removeItem("ss_justUpdated"); showToast("最新版に更新しました（" + ver + "）"); }
    setText("verNote", "メカノAI " + ver + " ／ 内蔵DB " + BUILTIN_DB.length + "車種 ＋ カスタム " + CUSTOM_DB.length + "車種。データはすべてこの端末内に保存されます。");
  });
  if ("serviceWorker" in navigator) {
    // 更新は「起動直後(操作前)」だけ適用。使用中は絶対にリロードしない(閲覧・入力が飛ぶのを防ぐ)。
    const hadController = !!navigator.serviceWorker.controller;
    let refreshing = false, startupWindow = true;
    setTimeout(() => { startupWindow = false; }, 4000);   // 起動から数秒だけ自動適用を許可
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshing || !hadController) return;
      refreshing = true;
      try { sessionStorage.setItem("ss_justUpdated", "1"); } catch (e) {}   // 更新後にさりげなく通知するため
      location.reload();
    });
    // updateViaCache:'none' … sw.js を常にネットから取得し、起動時に必ず新版を検出(古いまま固まるのを防ぐ)
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(reg => {
      // 前回セッションでDL済みの新版が待機していれば、この起動直後(操作前)に一度だけ適用
      if (reg.waiting && navigator.serviceWorker.controller) { try { reg.waiting.postMessage("skipWaiting"); } catch (e) {} }
      // 起動時に一度だけ更新チェック。今回セッション中に見つかった新版は「待機」のまま(次回起動で適用)。
      // 起動直後の短い間に用意できた場合のみ自動適用し、以降は使用中に勝手に切り替えない。
      reg.addEventListener("updatefound", () => {
        const nw = reg.installing; if (!nw) return;
        nw.addEventListener("statechange", () => {
          if (nw.state === "installed" && navigator.serviceWorker.controller && startupWindow) {
            try { nw.postMessage("skipWaiting"); } catch (e) {}   // 起動直後だけ適用
          }
        });
      });
      try { reg.update(); } catch (e) {}
    }).catch(() => {});
  }
})();
