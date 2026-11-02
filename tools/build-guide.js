"use strict";
/* 公開用「整備メモ」ページの生成 — 検索から来た整備士の入口にする
 *
 *   node tools/build-guide.js
 *
 * アプリ内蔵の db/guides.json(点検の手引き)・db/symptoms.json(症状)・db/dtc.json(故障コード)から
 * guide/ 以下の静的HTMLと sitemap.xml を作り直す。db を直したらこれを実行して push する。
 * oil.json / wheel_torque.json は他者の資料が出典なので公開ページにはしない。
 *
 * ■ 2026-11-02 の方針変更(検索対策)
 *  計測したところ、故障コードのページは本文が平均49字しかなく、全65ページが「中身の薄いページ」だった。
 *  薄いページを大量に出すと、そのページが上がらないだけでなくサイト全体の評価を下げる。そこで:
 *   (1) 本文が MIN_INDEX_CHARS 未満のページは noindex,follow にして sitemap からも外す
 *       (ページ自体は消さない。アプリやリンクからは今までどおり見られる)
 *   (2) 代わりに「系統別の一覧ページ」を作り、薄いコードの中身はそこに集約して読ませる
 *       → 1ページに10〜20コード分が載るので、検索に出せる厚みになる
 *   (3) db/dtc.json の中身が厚くなったコードは、自動で個別ページが検索対象に戻る
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "guide");
const SITE = "https://mechanoai-cablueie.com";
const BRAND = "メカノAI";
// このくらい本文(原因＋確認すること)が無いページは検索に出さない。db が厚くなれば自動で戻る。
const MIN_INDEX_CHARS = 70;

const readDb = f => JSON.parse(fs.readFileSync(path.join(ROOT, "db", f), "utf8"));
const guides = readDb("guides.json").guides;
const symptoms = readDb("symptoms.json").symptoms;
const dtcDb = readDb("dtc.json");
const codes = dtcDb.codes;

// 最終更新日(db の更新日。ページ表示と sitemap の lastmod に使う)
const ymd = d => new Date(d).toISOString().slice(0, 10);
// db だけでなく、このテンプレート自身の更新でもページの中身は変わるので新しい方を採る
const DB_MTIME = ymd(Math.max(
  ...["guides.json", "symptoms.json", "dtc.json"].map(f => fs.statSync(path.join(ROOT, "db", f)).mtimeMs),
  fs.statSync(__filename).mtimeMs));

/* ---------- URL(ファイル名) ---------- */

// 症状はdbにidが無いので、名前→URLの対応をここで固定する(名前を変えたらここも直す)
const SYMPTOM_SLUG = {
  "白煙": "white-smoke",
  "黒煙": "black-smoke",
  "青白い煙・オイル臭": "blue-smoke",
  "始動不良": "hard-start",
  "セルが回らない": "no-crank",
  "アイドリング不調・ハンチング": "rough-idle",
  "エンスト": "stall",
  "加速不良・出力不足": "low-power",
  "息つき・ギクシャク": "hesitation",
  "警告灯点灯": "warning-light",
  "オーバーヒート・水温異常": "overheat",
  "異音(部位特定前)": "noise",
  "ガラガラ音": "rattle-noise",
  "キュルキュル音": "squeal-noise",
  "ゴー/うなり音(車速連動)": "hum-noise",
  "カタカタ/コトコト音(足回り)": "knock-noise",
  "ブレーキ鳴き": "brake-squeal",
  "制動力不足・ペダル異常": "brake-weak",
  "振動・ジャダー": "vibration",
  "燃費悪化": "fuel-economy",
  "オイル漏れ": "oil-leak",
  "冷却水漏れ・減少": "coolant-leak",
  "エアコン不調": "air-conditioner",
  "充電系・バッテリー上がり": "battery",
  "直進性不良・偏摩耗": "alignment",
  "AT/CVT/AMT不調": "transmission",
  "シフトレバーのスカスカ・ギア不能(シフトケーブル樹脂ブッシュ破損)": "shift-cable-bush",
  "ブレーキランプ点灯しっぱなし→バッテリー上がり(ペダルストッパーゴム欠落)": "brake-lamp-stopper",
  "エア系統不良(大型)": "air-system",
  "尿素SCR系警告": "scr-warning",
  "DPF系不調": "dpf-trouble"
};

function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const guideUrl = g => "tebiki/" + g.id + ".html";
const symptomUrl = s => "symptom/" + (SYMPTOM_SLUG[s.name] || "s-" + hashStr(s.name)) + ".html";
const codeUrl = c => "dtc/" + c.code.toLowerCase().replace(/,/g, "-") + ".html";
const hubUrl = h => "dtc/" + h.slug + "/index.html";

/* ---------- 故障コードの系統別まとめ ----------
   薄い個別ページの代わりに検索に出す「厚いページ」。prefix は長いものから順に判定する。 */
const HUBS = [
  { slug: "engine-fuel", name: "エンジン・燃料・空気量系", prefixes: ["P00", "P01", "P02"],
    lead: "エアフロ・O2センサ・水温センサ・インジェクタ・燃圧など、燃料と空気の計量まわりで出るコードです。" },
  { slug: "ignition-misfire", name: "点火・失火系", prefixes: ["P03", "P3"],
    lead: "失火検出、プラグ・コイル、クランク角/カム角センサまわりで出るコードです。" },
  { slug: "exhaust-dpf-egr", name: "排気・後処理系（EGR・触媒・DPF・尿素SCR）", prefixes: ["P04", "P2"],
    lead: "EGR・触媒・EVAP・DPF/DPD/DPR・尿素SCRなど、排気と後処理まわりで出るコードです。大型車で多く見るコードもここに入ります。" },
  { slug: "idle-ecu", name: "アイドル・車速・ECU系", prefixes: ["P05", "P06"],
    lead: "アイドル制御、車速信号、電源・ECU出力回路まわりで出るコードです。" },
  { slug: "transmission", name: "トランスミッション系", prefixes: ["P07", "P08", "P09"],
    lead: "AT/CVT/AMTの制御・センサ・ソレノイドまわりで出るコードです。" },
  { slug: "chassis-body-network", name: "シャシ・ボディ・通信系（ABS・エアバッグ・CAN）", prefixes: ["C", "B", "U"],
    lead: "ABS・ブレーキ・ステアリング(C)、エアバッグ・電装(B)、CAN通信(U)で出るコードです。" },
  { slug: "maker", name: "メーカー固有コード", prefixes: ["P1"],
    lead: "メーカー独自のコードです。定義は車種別資料での照会が必要になります。" }
];
const HUB_PREFIXES = [];
HUBS.forEach(h => h.prefixes.forEach(p => HUB_PREFIXES.push({ p: p, hub: h })));
HUB_PREFIXES.sort((a, b) => b.p.length - a.p.length);
const hubOf = c => (HUB_PREFIXES.find(x => c.code.split(",")[0].startsWith(x.p)) || {}).hub || null;

/* ---------- 関連づけ(アプリの診断と同じ考え方: コードは前方一致、症状はキーワード) ---------- */

const guidesForCode = c => guides.filter(g => c.code.split(",").some(one => g.codes.some(p => one.startsWith(p))));
const codesForGuide = g => codes.filter(c => guidesForCode(c).includes(g));
const symptomText = s => s.name + " " + s.kw.join(" ");
const guidesForSymptom = s => guides.filter(g => g.kw.some(k => symptomText(s).includes(k)));
const symptomsForGuide = g => symptoms.filter(s => guidesForSymptom(s).includes(g));
// コード→症状(間に手引きをはさんで結ぶ)。回遊とクロール経路を増やすための内部リンク。
const symptomsForCode = c => {
  const gs = guidesForCode(c);
  return symptoms.filter(s => guidesForSymptom(s).some(g => gs.includes(g)));
};
const codesForSymptom = s => {
  const gs = guidesForSymptom(s);
  return codes.filter(c => guidesForCode(c).some(g => gs.includes(g)));
};

function systemOf(code) {
  const hit = dtcDb.fallback.filter(f => code.startsWith(f.prefix)).sort((a, b) => b.prefix.length - a.prefix.length)[0];
  return hit ? hit.sys : "";
}

/* ---------- HTML部品 ---------- */

const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const ul = items => "<ul>" + items.map(x => "<li>" + esc(x) + "</li>").join("") + "</ul>";
const ol = items => "<ol>" + items.map(x => "<li>" + esc(x) + "</li>").join("") + "</ol>";
const section = (title, inner) => (inner ? "<section><h2>" + esc(title) + "</h2>" + inner + "</section>" : "");
const textLen = a => a.filter(Boolean).join("").length;

// rel はそのページから guide/ までの相対パス("" / "../" / "../../")
function linkList(rel, items) {
  if (!items.length) return "";
  return '<ul class="links">' + items.map(x => '<li><a href="' + rel + x.url + '">' + esc(x.label) + "</a></li>").join("") + "</ul>";
}

const guideLinks = list => list.map(g => ({ url: guideUrl(g), label: g.title }));
const symptomLinks = list => list.map(s => ({ url: symptomUrl(s), label: s.name }));
const codeLinks = list => list.map(c => ({ url: codeUrl(c), label: c.code + " " + c.name }));
const hubLinks = list => list.map(h => ({ url: hubUrl(h), label: h.name }));

function page(o) {
  const depth = (o.file.match(/\//g) || []).length;         // guide/ からの深さ
  const rel = "../".repeat(depth);                          // guide/ へ戻る
  const up = rel + "../";                                   // サイト直下へ戻る
  const url = SITE + "/guide/" + (o.file === "index.html" ? "" : o.file.replace(/\/index\.html$/, "/"));
  const crumbs = [{ name: BRAND + " 整備メモ", url: SITE + "/guide/" }].concat(o.crumbs || []);
  const ld = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.name, item: c.url || url }))
  };
  // 目次ページ自身にはパンくずを出さない
  const trail = !o.crumbs ? "" : crumbs.map((c, i) => (i < crumbs.length - 1
    ? '<a href="' + esc(c.url.replace(SITE + "/guide/", rel)) + '">' + esc(c.name) + "</a>"
    : "<span>" + esc(c.name) + "</span>")).join(" › ");

  return `<!DOCTYPE html>
<!-- このファイルは tools/build-guide.js が db/*.json から自動生成します。直接編集しないでください。 -->
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.desc)}">
${o.noindex ? '<meta name="robots" content="noindex,follow">\n' : ""}<link rel="canonical" href="${url}">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.desc)}">
<meta property="og:type" content="${o.file === "index.html" ? "website" : "article"}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE}/icons/icon-512.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" type="image/png" href="${up}icons/icon-192.png">
<link rel="stylesheet" href="${rel}guide.css">
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>
</head>
<body>
<header class="top"><a class="brand" href="${rel || "./"}"><img src="${up}icons/icon-192.png" alt="" width="28" height="28">${BRAND} <span>整備メモ</span></a></header>
<main>
<nav class="crumbs">${trail}</nav>
<h1>${esc(o.h1)}</h1>
${o.body}
<aside class="cta">
  <div class="ctaH">この車両ではどうか、まで調べるなら</div>
  <p>${BRAND}は、車検証を読み取るだけで、その車両のメンテナンス諸元・定番故障・故障コードの原因候補をまとめて出す整備士向けアプリです。</p>
  <a class="btn" href="${up}?pocket=start">7日間無料ではじめる</a>
  <p class="ctaNote">登録はメールアドレスだけ。カード登録はいりません。IDと初期パスワードがすぐ届きます。</p>
  <a class="btn btnLine" href="${up}?demo=1">先に登録なしで試す</a>
  <a class="btnSub" href="${up}biz.html">会社・チームで使う（法人版）</a>
</aside>
<p class="note">このページは現場での点検の進め方をまとめた参考情報です。数値や手順は車種・年式で異なるため、作業前に必ず整備要領書・メーカー資料で確認してください。</p>
<p class="upd">最終更新: ${DB_MTIME}</p>
</main>
<script src="${up}track.js" defer></script>
<footer><a href="${up}terms.html">利用規約</a> ・ <a href="${up}privacy.html">プライバシーポリシー</a> ・ <a href="${up}tokushoho.html">特定商取引法に基づく表記</a><br>© 2026 Cablueie</footer>
</body>
</html>
`;
}

/* ---------- 各ページ ---------- */

const pages = [];

guides.forEach(g => {
  const rel = "../";
  pages.push({
    file: guideUrl(g),
    title: g.title + "｜準備物・手順・判定の目安｜" + BRAND,
    desc: cut(g.title + "。準備するもの、点検手順" + g.steps.length + "ステップ、判定の目安、作業時の注意までまとめました。最初の手順は「" + g.steps[0] + "」。", 120),
    h1: g.title,
    crumbs: [{ name: "点検の手引き", url: SITE + "/guide/#tebiki" }, { name: g.title }],
    body: [
      '<p class="lead">準備するもの、点検の手順、判定の目安、作業時の注意の順にまとめています。</p>',
      section("準備するもの", ul(g.tools)),
      section("点検の手順", ol(g.steps)),
      section("判定の目安", ul(g.judge)),
      section("作業時の注意", '<div class="warn">' + ul(g.cautions) + "</div>"),
      section("この手引きを使う症状", linkList(rel, symptomLinks(symptomsForGuide(g)))),
      section("関連する故障コード", linkList(rel, codeLinks(codesForGuide(g))))
    ].join("\n")
  });
});

symptoms.forEach(s => {
  const rel = "../";
  const h1 = s.name + "の原因と点検ポイント";
  const others = symptoms.filter(x => x !== s).slice(0, 10);
  pages.push({
    file: symptomUrl(s),
    title: s.name + "の原因と点検の順番｜整備士向け｜" + BRAND,
    desc: cut(s.name + "で考えられる原因は" + s.causes.length + "つ（" + s.causes.slice(0, 3).join("、") + "など）。現場で確認する順番は「" + s.checks[0] + "」から。整備士向けの点検メモです。", 120),
    h1: h1,
    noindex: textLen(s.causes.concat(s.checks)) < MIN_INDEX_CHARS,
    crumbs: [{ name: "症状から調べる", url: SITE + "/guide/#symptom" }, { name: s.name }],
    body: [
      '<p class="lead">考えられる原因と、現場で確認する順番の目安です。</p>',
      section("考えられる原因", ul(s.causes)),
      section("点検・確認すること", ol(s.checks)),
      section("詳しい点検の手引き", linkList(rel, guideLinks(guidesForSymptom(s)))),
      section("この症状で出ることがある故障コード", linkList(rel, codeLinks(codesForSymptom(s).slice(0, 12)))),
      section("ほかの症状から調べる", linkList(rel, symptomLinks(others)))
    ].join("\n")
  });
});

codes.forEach(c => {
  const rel = "../";
  const sys = systemOf(c.code.split(",")[0]);
  const hub = hubOf(c);
  const h1 = c.code.replace(/,/g, "・") + " " + c.name;
  const sibling = codes.filter(x => x !== c && hubOf(x) === hub).slice(0, 12);
  pages.push({
    file: codeUrl(c),
    title: c.code.replace(/,/g, "・") + " " + c.name + "｜原因と点検手順｜" + BRAND,
    desc: cut("故障コード " + c.code.replace(/,/g, "・") + "（" + c.name + "）の主な原因は" + c.causes.join("、") + "。現場で確認する順番と、関連する点検の手引きをまとめました。", 120),
    h1: h1,
    noindex: textLen(c.causes.concat(c.checks)) < MIN_INDEX_CHARS,
    crumbs: [{ name: "故障コードから調べる", url: SITE + "/guide/#dtc" }].concat(
      hub ? [{ name: hub.name, url: SITE + "/guide/" + hubUrl(hub).replace(/index\.html$/, "") }] : []
    ).concat([{ name: c.code.replace(/,/g, "・") }]),
    body: [
      '<p class="lead">' + (sys ? "系統: " + esc(sys) + "。" : "") + "考えられる原因と、確認する順番の目安です。</p>",
      section("考えられる原因", ul(c.causes)),
      section("点検・確認すること", ol(c.checks)),
      section("詳しい点検の手引き", linkList(rel, guideLinks(guidesForCode(c)))),
      section("関連する症状", linkList(rel, symptomLinks(symptomsForCode(c).slice(0, 10)))),
      section("同じ系統の故障コード", linkList(rel, codeLinks(sibling))
        + (hub ? '<p class="more"><a href="' + hub.slug + '/">' + esc(hub.name) + "の一覧をまとめて見る</a></p>" : ""))
    ].join("\n")
  });
});

// 系統別まとめ(薄い個別ページの受け皿。個別ページが検索対象のコードは見出しとリンクだけにして重複を避ける)
HUBS.forEach(h => {
  const rel = "../../";
  const mine = codes.filter(c => hubOf(c) === h);
  if (!mine.length) return;
  const blocks = mine.map(c => {
    const anchor = c.code.toLowerCase().replace(/,/g, "-");
    const detail = textLen(c.causes.concat(c.checks)) < MIN_INDEX_CHARS;
    return '<section class="codeBlock"><h3 id="' + esc(anchor) + '">' + esc(c.code.replace(/,/g, "・")) + " " + esc(c.name) + "</h3>"
      + (detail
        ? "<p><b>考えられる原因</b>: " + esc(c.causes.join("、")) + "</p><p><b>確認する順番</b>: "
          + esc(c.checks.map((x, i) => (i + 1) + ". " + x).join(" → ")) + "</p>"
        : "<p>" + esc(cut(c.causes.join("、"), 60)) + "</p>")
      + '<p class="more"><a href="' + rel + codeUrl(c) + '">'
      + esc(c.code.replace(/,/g, "・")) + "の詳しいページ</a></p></section>";
  });
  pages.push({
    file: hubUrl(h),
    title: h.name + "の故障コード一覧｜原因と確認の順番｜" + BRAND,
    desc: cut(h.name + "の故障コード" + mine.length + "件（" + mine.slice(0, 5).map(c => c.code).join("・") + "など）について、考えられる原因と現場で確認する順番をまとめました。整備士向けの点検メモです。", 120),
    h1: h.name + "の故障コード一覧",
    noindex: textLen(mine.map(c => c.name + c.causes.join("") + c.checks.join(""))) < MIN_INDEX_CHARS * 3,
    crumbs: [{ name: "故障コードから調べる", url: SITE + "/guide/#dtc" }, { name: h.name }],
    body: [
      '<p class="lead">' + esc(h.lead) + "全" + mine.length + "件。考えられる原因と、現場で確認する順番の目安です。</p>",
      blocks.join("\n"),
      section("ほかの系統から調べる", linkList(rel, hubLinks(HUBS.filter(x => x !== h))))
    ].join("\n")
  });
});

pages.push({
  file: "index.html",
  title: BRAND + " 整備メモ｜症状・故障コード・点検手順を整備士向けにまとめた無料メモ",
  desc: "整備士向けの点検メモ集（無料・登録不要）。DPF・尿素SCR・エアブレーキなどの点検の手引き16件、白煙や始動不良など症状別31件、故障コード別65件の原因と確認手順をまとめています。",
  h1: BRAND + " 整備メモ",
  body: [
    '<p class="lead">現場での点検の進め方を、手引き・症状・故障コードの3つの入口からまとめています。登録なしで全部読めます。</p>',
    '<section id="tebiki"><h2>点検の手引き（' + guides.length + "件）</h2>" + linkList("", guideLinks(guides)) + "</section>",
    '<section id="symptom"><h2>症状から調べる（' + symptoms.length + "件）</h2>" + linkList("", symptomLinks(symptoms)) + "</section>",
    '<section id="dtc"><h2>故障コードから調べる（' + codes.length + "件）</h2>"
      + '<p>系統ごとにまとめた一覧から探せます。</p>' + linkList("", hubLinks(HUBS.filter(h => codes.some(c => hubOf(c) === h))))
      + '<h3>コード番号から直接さがす</h3>' + linkList("", codeLinks(codes)) + "</section>"
  ].join("\n")
});

/* ---------- 書き出し ---------- */

// URLがぶつかるとページが黙って上書きされるので先に止める
const seen = {};
pages.forEach(p => {
  if (seen[p.file]) throw new Error("URLが重複: " + p.file);
  seen[p.file] = true;
});

["tebiki", "symptom", "dtc"].forEach(d => {
  fs.rmSync(path.join(OUT, d), { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, d), { recursive: true });
});
HUBS.forEach(h => fs.mkdirSync(path.join(OUT, "dtc", h.slug), { recursive: true }));
pages.forEach(p => fs.writeFileSync(path.join(OUT, p.file), page(p)));

// sitemap は「検索に出したいページ」だけ。noindex のページは載せない。
const siteFile = f => {
  try { return ymd(fs.statSync(path.join(ROOT, f)).mtimeMs); } catch (e) { return DB_MTIME; }
};
const urls = [
  { loc: "/", lastmod: siteFile("index.html") },
  { loc: "/biz.html", lastmod: siteFile("biz.html") },
  { loc: "/faq.html", lastmod: siteFile("faq.html") },
  { loc: "/manual.html", lastmod: siteFile("manual.html") }
].concat(pages.filter(p => !p.noindex)
  .map(p => ({ loc: "/guide/" + (p.file === "index.html" ? "" : p.file.replace(/\/index\.html$/, "/")), lastmod: DB_MTIME }))
  .sort((a, b) => a.loc.localeCompare(b.loc)));

fs.writeFileSync(path.join(ROOT, "sitemap.xml"),
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
  + urls.map(u => "  <url><loc>" + SITE + u.loc + "</loc><lastmod>" + u.lastmod + "</lastmod></url>").join("\n")
  + "\n</urlset>\n");

const noidx = pages.filter(p => p.noindex);
console.log("生成: 手引き " + guides.length + " / 症状 " + symptoms.length + " / 故障コード " + codes.length
  + " / 系統まとめ " + HUBS.filter(h => codes.some(c => hubOf(c) === h)).length + " + 目次1 = " + pages.length + "ページ");
console.log("検索に出す: " + (pages.length - noidx.length) + "ページ / noindex(中身が" + MIN_INDEX_CHARS + "字未満): " + noidx.length + "ページ");
console.log("sitemap.xml: " + urls.length + " URL (lastmod " + DB_MTIME + ")");
