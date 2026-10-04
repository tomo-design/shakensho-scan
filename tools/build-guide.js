"use strict";
/* 公開用「整備メモ」ページの生成 — 検索から来た整備士の入口にする
 *
 *   node tools/build-guide.js
 *
 * アプリ内蔵の db/guides.json(点検の手引き)・db/symptoms.json(症状)・db/dtc.json(故障コード)から
 * guide/ 以下の静的HTMLと sitemap.xml を作り直す。db を直したらこれを実行して push する。
 * oil.json / wheel_torque.json は他者の資料が出典なので公開ページにはしない。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "guide");
const SITE = "https://mechanoai-cablueie.com";
const BRAND = "メカノAI";

const readDb = f => JSON.parse(fs.readFileSync(path.join(ROOT, "db", f), "utf8"));
const guides = readDb("guides.json").guides;
const symptoms = readDb("symptoms.json").symptoms;
const dtcDb = readDb("dtc.json");
const codes = dtcDb.codes;

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

/* ---------- 関連づけ(アプリの診断と同じ考え方: コードは前方一致、症状はキーワード) ---------- */

const guidesForCode = c => guides.filter(g => c.code.split(",").some(one => g.codes.some(p => one.startsWith(p))));
const codesForGuide = g => codes.filter(c => guidesForCode(c).includes(g));
const symptomText = s => s.name + " " + s.kw.join(" ");
const guidesForSymptom = s => guides.filter(g => g.kw.some(k => symptomText(s).includes(k)));
const symptomsForGuide = g => symptoms.filter(s => guidesForSymptom(s).includes(g));

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

// rel はそのページから guide/ までの相対パス("" か "../")
function linkList(rel, items) {
  if (!items.length) return "";
  return '<ul class="links">' + items.map(x => '<li><a href="' + rel + x.url + '">' + esc(x.label) + "</a></li>").join("") + "</ul>";
}

const guideLinks = list => list.map(g => ({ url: guideUrl(g), label: g.title }));
const symptomLinks = list => list.map(s => ({ url: symptomUrl(s), label: s.name }));
const codeLinks = list => list.map(c => ({ url: codeUrl(c), label: c.code + " " + c.name }));

function page(o) {
  const rel = o.file.includes("/") ? "../" : "";
  const url = SITE + "/guide/" + (o.file === "index.html" ? "" : o.file);
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
<link rel="canonical" href="${url}">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.desc)}">
<meta property="og:type" content="${o.file === "index.html" ? "website" : "article"}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${SITE}/icons/icon-512.png">
<link rel="icon" type="image/png" href="${rel}../icons/icon-192.png">
<link rel="stylesheet" href="${rel}guide.css">
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>
</head>
<body>
<header class="top"><a class="brand" href="${rel || "./"}"><img src="${rel}../icons/icon-192.png" alt="" width="28" height="28">${BRAND} <span>整備メモ</span></a></header>
<main>
<nav class="crumbs">${trail}</nav>
<h1>${esc(o.h1)}</h1>
${o.body}
<aside class="cta">
  <div class="ctaH">この車両ではどうか、まで調べるなら</div>
  <p>${BRAND}は、車検証を読み取るだけで、その車両のメンテナンス諸元・定番故障・故障コードの原因候補をまとめて出す整備士向けアプリです。</p>
  <a class="btn" href="${rel}../?demo=1">登録なしで体験する</a>
  <a class="btn btnLine" href="${rel}../?pocket=start">個人で使う（7日間無料）</a>
  <a class="btnSub" href="${rel}../biz.html">会社・チームで使う</a>
</aside>
<p class="note">このページは現場での点検の進め方をまとめた参考情報です。数値や手順は車種・年式で異なるため、作業前に必ず整備要領書・メーカー資料で確認してください。</p>
</main>
<script src="${rel}../track.js" defer></script>
<footer><a href="${rel}../terms.html">利用規約</a> ・ <a href="${rel}../privacy.html">プライバシーポリシー</a> ・ <a href="${rel}../tokushoho.html">特定商取引法に基づく表記</a><br>© 2026 Cablueie</footer>
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
    title: g.title + "｜準備物・手順・判定の目安 - " + BRAND,
    desc: cut(g.title + "。準備物、点検手順" + g.steps.length + "ステップ、判定の目安、作業時の注意を整備士向けにまとめました。" + g.steps[0], 120),
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
  pages.push({
    file: symptomUrl(s),
    title: h1 + " - " + BRAND,
    desc: cut(s.name + "で考えられる主な原因は、" + s.causes.slice(0, 3).join("、") + "。最初の確認は「" + s.checks[0] + "」から。", 120),
    h1: h1,
    crumbs: [{ name: "症状から調べる", url: SITE + "/guide/#symptom" }, { name: s.name }],
    body: [
      '<p class="lead">考えられる原因と、現場で確認する順番の目安です。</p>',
      section("考えられる原因", ul(s.causes)),
      section("点検・確認すること", ol(s.checks)),
      section("詳しい点検の手引き", linkList(rel, guideLinks(guidesForSymptom(s))))
    ].join("\n")
  });
});

codes.forEach(c => {
  const rel = "../";
  const sys = systemOf(c.code.split(",")[0]);
  const h1 = c.code.replace(/,/g, "・") + " " + c.name;
  pages.push({
    file: codeUrl(c),
    title: h1 + "｜原因と点検手順 - " + BRAND,
    desc: cut("故障コード " + c.code.replace(/,/g, "・") + "（" + c.name + "）の主な原因は、" + c.causes.slice(0, 2).join("、") + "など。確認の手順をまとめました。", 120),
    h1: h1,
    crumbs: [{ name: "故障コードから調べる", url: SITE + "/guide/#dtc" }, { name: c.code.replace(/,/g, "・") }],
    body: [
      '<p class="lead">' + (sys ? "系統: " + esc(sys) + "。" : "") + "考えられる原因と、確認する順番の目安です。</p>",
      section("考えられる原因", ul(c.causes)),
      section("点検・確認すること", ol(c.checks)),
      section("詳しい点検の手引き", linkList(rel, guideLinks(guidesForCode(c))))
    ].join("\n")
  });
});

pages.push({
  file: "index.html",
  title: BRAND + " 整備メモ｜点検の手引き・症状・故障コードから調べる",
  desc: "整備士向けの点検メモ集。DPF・尿素SCR・エアブレーキなどの点検の手引き、白煙や始動不良など症状別の原因、故障コード別の確認手順をまとめています。",
  h1: BRAND + " 整備メモ",
  body: [
    '<p class="lead">現場での点検の進め方を、手引き・症状・故障コードの3つの入口からまとめています。</p>',
    '<section id="tebiki"><h2>点検の手引き</h2>' + linkList("", guideLinks(guides)) + "</section>",
    '<section id="symptom"><h2>症状から調べる</h2>' + linkList("", symptomLinks(symptoms)) + "</section>",
    '<section id="dtc"><h2>故障コードから調べる</h2>' + linkList("", codeLinks(codes)) + "</section>"
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
pages.forEach(p => fs.writeFileSync(path.join(OUT, p.file), page(p)));

const urls = ["/", "/biz.html", "/faq.html", "/manual.html"]
  .concat(pages.map(p => "/guide/" + (p.file === "index.html" ? "" : p.file)).sort());
fs.writeFileSync(path.join(ROOT, "sitemap.xml"),
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
  + urls.map(u => "  <url><loc>" + SITE + u + "</loc></url>").join("\n") + "\n</urlset>\n");

console.log("生成: 手引き " + guides.length + " / 症状 " + symptoms.length + " / 故障コード " + codes.length + " + 目次1 = " + pages.length + "ページ");
console.log("sitemap.xml: " + urls.length + " URL");
