// Builds the public, crawlable Quickies section from a JSON export of published summaries.
//
//   node _build/build-quickies.mjs [path/to/quickies.json]
//
// Input: a JSON array of summary documents (title, description, sections, facts, jargons,
// categories, coverImageUrl, articleUrl/pageUrl, publicationDate, ...) or a folder of such
// files (e.g. QuickyWiki-Content/quickies/en), defaulting to _build/quickies.json.
// Output: quickies/index.html (top picks per category), quickies/topics/<category>/index.html
// (every Quicky in that category), quickies/<slug>/index.html per Quicky, sitemap.xml and
// robots.txt. Underscore folders are not published by Jekyll, so
// the data and this script never reach the live site.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "https://quickywiki.app";
const INPUT = resolve(process.argv[2] ?? join(ROOT, "_build", "quickies.json"));
const OUT_DIR = join(ROOT, "quickies");
const APP_STORE = "https://apps.apple.com/app/quickywiki-daily-summaries/id6761535300";
const PLAY_STORE = "https://play.google.com/store/apps/details?id=com.quickywiki.app";
const WORDS_PER_MINUTE = 200;
const RELATED_COUNT = 6;
const HUB_PER_CATEGORY = 8;

// Matches the Category enum in the backend; numeric values come from older exports.
const CATEGORIES = ["Miscellaneous", "Science", "Tech", "Art", "Space", "Geography", "History", "Figures", "Sports", "Politics", "Medicine"];
const CATEGORY_LABELS = { Miscellaneous: "Curiosities", Figures: "People" };

// ---------------------------------------------------------------- helpers

const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const slugify = (s) => String(s)
  .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  .toLowerCase().replace(/&/g, " and ")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  .slice(0, 80).replace(/-+$/, "") || "quicky";

const categoryOf = (doc) => {
  const raw = (doc.categories ?? [])[0];
  const name = typeof raw === "number" ? CATEGORIES[raw] : raw;
  return CATEGORIES.includes(name) ? name : "Miscellaneous";
};
const categoryLabel = (c) => CATEGORY_LABELS[c] ?? c;
const topicPath = (c) => `/quickies/topics/${slugify(categoryLabel(c))}/`;

const plain = (s) => String(s ?? "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/\s+/g, " ").trim();

const clip = (s, max) => {
  const t = plain(s);
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  return cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:.\s]+$/, "") + "…";
};

const isoDate = (v) => {
  const d = v ? new Date(v) : null;
  return d && !isNaN(d) ? d.toISOString() : null;
};

// Section bodies are plain text: paragraphs split by blank lines, **bold** for emphasis.
// The first mention of each jargon term links to its definition in the glossary.
function renderBody(text, terms) {
  return String(text ?? "").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => {
    let html = esc(p);
    for (const t of terms) {
      if (t.used) continue;
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${t.pattern})(?=[^\\p{L}\\p{N}]|$)`, "iu");
      if (re.test(html)) {
        html = html.replace(re, (_, pre, word) => `${pre}<a class="term" href="#${t.anchor}">${word}</a>`);
        t.used = true;
      }
    }
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br>");
    return `<p>${html}</p>`;
  }).join("\n      ");
}

// Covers are web-sized copies saved by _build/covers under the blob slug of the title
// (SummaryMapper.ToBlobSlug in the backend). A Quicky without one keeps the placeholder.
const COVER_DIR = "/assets/covers/q/";
const blobSlug = (title) => [...String(title).trim().toLowerCase().replace(/ /g, "-")].filter((c) => /[a-z0-9-]/.test(c)).join("").replace(/^-+|-+$/g, "");
const coverFor = (d) => {
  const path = `${COVER_DIR}${blobSlug(d.title)}.webp`;
  return existsSync(join(ROOT, path)) ? path : null;
};

const regexEscape =(s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------------------------------------------------------------- load + normalise

if (!existsSync(INPUT)) {
  console.error(`Input not found: ${INPUT}`);
  process.exit(1);
}
const readJson = (file) => JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
const docs = statSync(INPUT).isDirectory()
  ? readdirSync(INPUT).filter((f) => f.endsWith(".json")).sort().flatMap((f) => [readJson(join(INPUT, f))].flat())
  : readJson(INPUT);
if (!Array.isArray(docs) || docs.length === 0) {
  console.error("Input must be a non-empty JSON array of summaries.");
  process.exit(1);
}

// A title that appears twice (a re-generated Quicky) keeps its first occurrence only.
const seen = new Set(["topics"]); // /quickies/topics/ hosts the category pages
const seenTitles = new Set();
const quickies = docs
  .filter((d) => d?.title && Array.isArray(d.sections) && d.sections.length)
  .filter((d) => {
    const key = plain(d.title).toLowerCase();
    if (seenTitles.has(key)) return false;
    seenTitles.add(key);
    return true;
  })
  .map((d) => {
    let slug = slugify(d.title);
    for (let n = 2; seen.has(slug); n++) slug = `${slugify(d.title)}-${n}`;
    seen.add(slug);

    const words = d.sections.reduce((n, s) => n + plain(s.content).split(" ").length, 0);
    const category = categoryOf(d);
    const description = plain(d.description) || clip(d.sections[0]?.content, 180);
    return {
      slug,
      url: `${SITE}/quickies/${slug}/`,
      title: plain(d.title),
      description,
      metaDescription: clip(description, 158),
      category,
      sections: d.sections.map((s) => ({ heading: plain(s.heading?.text ?? s.heading ?? ""), content: s.content ?? "" })),
      facts: (d.facts ?? []).map(plain).filter(Boolean),
      jargons: Object.entries(d.jargons ?? {}).map(([term, def]) => ({ term: plain(term), def: plain(def) })).filter((j) => j.term && j.def),
      cover: coverFor(d),
      source: [d.articleUrl, d.pageUrl].find((u) => typeof u === "string" && /^https:\/\/[a-z-]+\.wikipedia\.org\//.test(u)) ?? null,
      published: isoDate(d.publicationDate),
      modified: isoDate(d.contentUpdatedAt) ?? isoDate(d.modificationDate) ?? isoDate(d.publicationDate),
      minutes: Math.max(3, Math.ceil(words / WORDS_PER_MINUTE)),
    };
  });

const byCategory = new Map();
for (const q of quickies) {
  if (!byCategory.has(q.category)) byCategory.set(q.category, []);
  byCategory.get(q.category).push(q);
}
const categoryOrder = [...byCategory.keys()].sort((a, b) => byCategory.get(b).length - byCategory.get(a).length || a.localeCompare(b));

// ---------------------------------------------------------------- shared chrome

const GTAG = `<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-69NKB9P3LH"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-1TELEXWQ17');
</script>`;

const QGLYPH = `<symbol id="qglyph" viewBox="0 0 528.5 560.3"><path class="q" d="M419.7 551.4C406.2 549.7 389.8 543.3 376.6 534.5C364 526.1 346.2 507.9 331.7 488.5C325.1 479.7 319.5 472.3 319.2 472C318.9 471.8 315.1 466.8 310.8 461C294.7 439.8 283.5 427.9 266.1 413.5C255.7 405 239.9 399 227.5 399C219.3 399 212.4 400.6 203 404.6L195.3 407.8L190.7 402.3C188.2 399.3 186.2 396.5 186.2 396.1C186.2 393.4 202.6 381.6 212.7 377C244.4 362.8 281 362.2 312.2 375.3C324.5 380.4 344.9 393.5 350.6 399.9C351.7 401.1 353 402 353.6 402C354.8 402 359.1 393.4 362.9 383.1C370.5 362.6 377 332.7 380.2 302.5C382 285.5 382.6 244.1 381.3 226C376 153 355.4 96.2 322.1 62.9C306.3 47.1 288.1 37.7 267 34.6C244 31.2 224.3 34.1 204.7 43.6C183 54.2 164.8 73.4 150.3 101.2C138.8 123.1 131.2 147.6 125.8 180C121.6 205.5 121.1 211.1 120.5 245.5C120.1 272.3 120.3 281.8 121.7 295.5C124.7 325.9 130.1 351.7 138 373.5C144.3 391.2 157.7 417.5 164.5 425.9C166.2 428.1 168.8 431.4 170.2 433.2C175.8 440.6 189.9 453.4 198.6 458.7C224.2 474.6 257.4 478.5 284.5 468.9C287.7 467.8 290.7 467 291.2 467.2C292.3 467.6 309.2 491.7 309.2 492.9C309.2 493.4 307.3 494 305 494.4C302.6 494.7 296.7 495.6 291.9 496.5C256.7 502.5 214.8 500.1 179.2 489.9C137 477.8 106.6 460.3 77.7 431.6C52.2 406.4 35.8 380.5 22.8 344.9C18.5 333.1 13 310.5 10.6 295C8.3 280.5 8 236 10.1 220C14.1 188.8 23 159 36 133.5C41.5 122.7 56.5 99.5 62 93.5C63.5 91.8 67.3 87.4 70.5 83.8C93.9 57.3 132.3 32.5 167.6 21C195.1 12 220.7 8 251.2 8C271.5 8 283.8 9.1 301.2 12.5C364.2 24.9 413.2 55.8 449.8 106.2C455.8 114.4 467.1 134.3 470.1 141.8C471.1 144.4 473.4 149.7 475 153.5C481.2 167.9 487.4 192.3 490.9 216C493.1 231.5 493.4 277 491.4 292C486.6 327.3 477 356.7 461.3 384C458.4 389.3 454.9 394.9 453.7 396.5C435.8 421.2 418.5 440.1 404.6 449.9L401.3 452.3L407.5 459.4C416.3 469.4 432.7 485.3 439.8 490.6C447 496 461 503.3 467.2 504.8C481.8 508.5 493.4 506.5 506.9 498C509.5 496.4 511.3 497.6 517 505.4L520.5 510.3L514.6 515.9C488.5 540.8 462 552.3 431.7 551.9C426.8 551.8 421.4 551.6 419.7 551.4Z" fill-rule="evenodd"/></symbol>`;

function head({ title, description, canonical, image, ogType = "website", jsonLd = [] }) {
  const img = image ?? `${SITE}/logo.png`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
${GTAG}
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#072117">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="index, follow, max-image-preview:large">
<link rel="canonical" href="${esc(canonical)}">

<meta property="og:type" content="${ogType}">
<meta property="og:site_name" content="QuickyWiki">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(img)}">

<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(img)}">

<link rel="icon" type="image/png" href="/logo.png">
<link rel="apple-touch-icon" href="/logo.png">

<link rel="preconnect" href="https://api.fontshare.com">
<link rel="preconnect" href="https://cdn.fontshare.com" crossorigin>
<link href="https://api.fontshare.com/v2/css?f[]=satoshi@400,401,500,700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/pages.css">
<link rel="stylesheet" href="/assets/quickies.css">
${jsonLd.map((o) => `<script type="application/ld+json">\n${JSON.stringify(o, null, 2).replace(/</g, "\\u003c")}\n</script>`).join("\n")}
</head>
<body>

<svg width="0" height="0" style="position:absolute" aria-hidden="true">
  <defs>
    ${QGLYPH}
    <symbol id="i-back" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M11 6l-6 6 6 6"/></symbol>
  </defs>
</svg>
`;
}

function pageHead({ back, eyebrow, h1, lede, extra = "" }) {
  return `<div class="page-head">
  <svg class="rings" viewBox="0 0 900 900" aria-hidden="true">
    <circle cx="450" cy="450" r="440"/>
    <circle cx="450" cy="450" r="330" class="dashed"/>
    <circle cx="450" cy="450" r="220"/>
  </svg>
  <svg class="glyph" viewBox="0 0 528.5 560.3" aria-hidden="true"><use href="#qglyph"/></svg>

  <header class="nav">
    <div class="nav-capsule">
      <a class="brand" href="/"><span class="brand-chip"><svg viewBox="0 0 528.5 560.3"><use href="#qglyph"/></svg></span>QuickyWiki</a>
      <a class="nav-back" href="${back.href}"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-back"/></svg>${esc(back.label)}</a>
    </div>
  </header>

  <div class="wrap head-inner">
    ${eyebrow}
    <h1>${h1}</h1>
    <p class="lede">${esc(lede)}</p>
    ${extra}
  </div>
</div>
`;
}

const STORES = `<div class="q-stores">
        <a class="store" href="${APP_STORE}" target="_blank" rel="noopener" aria-label="Download QuickyWiki on the App Store"><img src="/assets/badges/download-on-the-app-store.svg" alt="" width="144" height="48"></a>
        <a class="store" href="${PLAY_STORE}" target="_blank" rel="noopener" aria-label="Get QuickyWiki on Google Play"><img src="/assets/badges/google-play-button.png" alt="" height="48"></a>
      </div>`;

const FOOTER = `<footer>
  <div class="wrap">
    <div class="foot-inner">
      <a class="foot-brand" href="/"><svg viewBox="0 0 528.5 560.3"><use href="#qglyph"/></svg>QuickyWiki</a>
      <nav class="foot-links" aria-label="Footer">
        <a href="/">Home</a>
        <a href="/quickies/">Quickies</a>
        <a href="/privacy.html">Privacy Policy</a>
        <a href="/terms.html">Terms of Use</a>
        <a href="/contact.html">Contact</a>
        <a href="https://www.instagram.com/quickywiki.app/" target="_blank" rel="noopener">Instagram</a>
      </nav>
    </div>
    <div class="foot-note">
      <span>&copy; ${new Date().getFullYear()} QuickyWiki. Made for curious minds.</span>
      <span>Summaries are crafted from openly licensed sources, including Wikipedia.</span>
    </div>
  </div>
</footer>

</body>
</html>
`;

const ORG = { "@type": "Organization", name: "QuickyWiki", url: `${SITE}/`, logo: { "@type": "ImageObject", url: `${SITE}/logo.png` } };

function card(q, { eager = false } = {}) {
  const img = q.cover
    ? `<img class="qc-img" src="${esc(q.cover)}" alt="" width="640" height="640" loading="${eager ? "eager" : "lazy"}" decoding="async">`
    : `<span class="qc-img qc-fallback" aria-hidden="true"><svg viewBox="0 0 528.5 560.3"><use href="#qglyph"/></svg></span>`;
  return `<li><a class="qcard" href="/quickies/${q.slug}/">
          ${img}
          <span class="qc-body">
            <span class="qc-cat">${esc(categoryLabel(q.category))}</span>
            <span class="qc-title">${esc(q.title)}</span>
            <span class="qc-desc">${esc(clip(q.description, 120))}</span>
            <span class="qc-meta">${q.minutes} min read${q.facts.length ? ` · ${q.facts.length} facts` : ""}</span>
          </span>
        </a></li>`;
}

// ---------------------------------------------------------------- per-Quicky page

function quickyPage(q) {
  const terms = q.jargons
    .map((j) => ({ ...j, anchor: `term-${slugify(j.term)}`, pattern: regexEscape(esc(j.term)), used: false }))
    .sort((a, b) => b.term.length - a.term.length);

  const sectionsHtml = q.sections.map((s, i) => `<section class="q-section">
      ${s.heading ? `<h2 id="s${i + 1}">${esc(s.heading)}</h2>` : ""}
      ${renderBody(s.content, terms)}
    </section>`).join("\n    ");

  const factsHtml = q.facts.length ? `<aside class="card q-facts" aria-labelledby="facts-h">
      <h2 class="label" id="facts-h">${q.facts.length} key facts</h2>
      <ol>
        ${q.facts.map((f) => `<li>${esc(f)}</li>`).join("\n        ")}
      </ol>
    </aside>` : "";

  const glossary = [...terms].sort((a, b) => a.term.localeCompare(b.term));
  const glossaryHtml = glossary.length ? `<section class="q-glossary" aria-labelledby="terms-h">
      <h2 id="terms-h">Key terms, decoded</h2>
      <dl>
        ${glossary.map((t) => `<div id="${t.anchor}"><dt>${esc(t.term)}</dt><dd>${esc(t.def)}</dd></div>`).join("\n        ")}
      </dl>
    </section>` : "";

  const sourceHtml = q.source
    ? `<p>This Quicky is an original summary based on the Wikipedia article <a href="${esc(q.source)}" rel="noopener" target="_blank">“${esc(decodeURIComponent(q.source.split("/wiki/")[1] ?? q.title).replace(/_/g, " "))}”</a>, available under the <a href="https://creativecommons.org/licenses/by-sa/4.0/" rel="license noopener" target="_blank">CC BY-SA 4.0</a> license.</p>`
    : `<p>This Quicky is an original summary crafted from openly licensed sources, including Wikipedia, available under the <a href="https://creativecommons.org/licenses/by-sa/4.0/" rel="license noopener" target="_blank">CC BY-SA 4.0</a> license.</p>`;

  const related = [
    ...byCategory.get(q.category).filter((o) => o !== q),
    ...quickies.filter((o) => o.category !== q.category),
  ].slice(0, RELATED_COUNT);

  const article = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: q.title.slice(0, 110),
    description: q.metaDescription,
    url: q.url,
    mainEntityOfPage: q.url,
    ...(q.cover && { image: [`${SITE}${q.cover}`] }),
    ...(q.published && { datePublished: q.published }),
    ...(q.modified && { dateModified: q.modified }),
    articleSection: categoryLabel(q.category),
    inLanguage: "en",
    timeRequired: `PT${q.minutes}M`,
    author: ORG,
    publisher: ORG,
    ...(q.source && { isBasedOn: q.source }),
    license: "https://creativecommons.org/licenses/by-sa/4.0/",
  };
  const breadcrumbs = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: `${SITE}/` },
      { "@type": "ListItem", position: 2, name: "Quickies", item: `${SITE}/quickies/` },
      { "@type": "ListItem", position: 3, name: categoryLabel(q.category), item: `${SITE}${topicPath(q.category)}` },
      { "@type": "ListItem", position: 4, name: q.title, item: q.url },
    ],
  };

  return head({
    title: `${q.title}: explained in ${q.minutes} minutes · QuickyWiki`,
    description: q.metaDescription,
    canonical: q.url,
    image: q.cover && `${SITE}${q.cover}`,
    ogType: "article",
    jsonLd: [article, breadcrumbs],
  }) + pageHead({
    back: { href: "/quickies/", label: "All Quickies" },
    eyebrow: `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a><span aria-hidden="true">/</span><a href="/quickies/">Quickies</a><span aria-hidden="true">/</span><a href="${topicPath(q.category)}">${esc(categoryLabel(q.category))}</a></nav>`,
    h1: esc(q.title),
    lede: q.description,
    extra: `<p class="updated">${q.minutes} min read${q.facts.length ? ` · ${q.facts.length} key facts` : ""}${q.jargons.length ? ` · ${q.jargons.length} terms decoded` : ""}</p>`,
  }) + `
<main class="doc q-article">
    ${q.cover ? `<figure class="q-cover"><img src="${esc(q.cover)}" alt="Illustration for ${esc(q.title)}" width="640" height="640" fetchpriority="high" decoding="async"></figure>` : ""}
    <article>
    ${sectionsHtml}
    </article>

    ${factsHtml}

    ${glossaryHtml}

    <aside class="q-cta">
      <p class="label">Read it in the app</p>
      <p class="q-cta-title">This is one of thousands of Quickies.</p>
      <p>Get a fresh pick every day, jargon decoded as you read, and any topic on demand, in English and Arabic.</p>
      ${STORES}
    </aside>

    <div class="callout q-source">
      ${sourceHtml}
    </div>
</main>

<section class="q-related wrap-wide" aria-labelledby="related-h">
  <h2 id="related-h">Keep exploring</h2>
  <ul class="qgrid">
        ${related.map((r) => card(r)).join("\n        ")}
  </ul>
  <p class="q-all"><a class="btn btn-green" href="/quickies/">Browse all ${quickies.length} Quickies</a></p>
</section>

${FOOTER}`;
}

// ---------------------------------------------------------------- hub + topic pages

const APP_CTA = `<aside class="q-cta q-cta-wide">
    <p class="label">Want more?</p>
    <p class="q-cta-title">Thousands more Quickies are waiting in the app.</p>
    <p>A personalized daily digest, curated multi-chapter series, and any Wikipedia topic on demand.</p>
    ${STORES}
  </aside>`;

const chipsNav = (active) => `<nav class="chips" aria-label="Categories">
      ${active ? `<a class="chip" href="/quickies/">All</a>` : ""}
      ${categoryOrder.map((c) => `<a class="chip${c === active ? " active" : ""}" href="${topicPath(c)}"${c === active ? ` aria-current="page"` : ""}>${esc(categoryLabel(c))} <span>${byCategory.get(c).length}</span></a>`).join("\n      ")}
    </nav>`;

function topicPage(c) {
  const label = categoryLabel(c);
  const list = byCategory.get(c);
  const url = `${SITE}${topicPath(c)}`;
  const title = `${label} explained: ${list.length} five-minute reads · QuickyWiki`;
  const description = clip(`Free 5-minute ${label.toLowerCase()} reads: ${list.slice(0, 4).map((q) => q.title).join(", ")} and more, each with key facts and plain-English definitions.`, 158);

  const collection = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: `${label} Quickies`,
    url,
    description,
    isPartOf: { "@type": "WebSite", name: "QuickyWiki", url: `${SITE}/` },
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: list.length,
      itemListElement: list.map((q, i) => ({ "@type": "ListItem", position: i + 1, url: q.url, name: q.title })),
    },
  };
  const breadcrumbs = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: `${SITE}/` },
      { "@type": "ListItem", position: 2, name: "Quickies", item: `${SITE}/quickies/` },
      { "@type": "ListItem", position: 3, name: label, item: url },
    ],
  };

  return head({ title, description, canonical: url, jsonLd: [collection, breadcrumbs] }) + pageHead({
    back: { href: "/quickies/", label: "All Quickies" },
    eyebrow: `<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a><span aria-hidden="true">/</span><a href="/quickies/">Quickies</a></nav>`,
    h1: `${esc(label)}, <em>five minutes at a time.</em>`,
    lede: `${list.length} short, beautifully written ${label.toLowerCase()} reads. Each one comes with key facts and the jargon decoded.`,
    extra: chipsNav(c),
  }) + `
<main class="hub">
  <ul class="qgrid">
        ${list.map((q, i) => card(q, { eager: i < 4 })).join("\n        ")}
  </ul>

  ${APP_CTA}
</main>

${FOOTER}`;
}

function hubPage() {
  const title = `Quickies: ${quickies.length} fascinating topics explained in 5 minutes · QuickyWiki`;
  const description = `Free 5-minute reads on science, history, space, art and more. Each Quicky distills a big topic into a short story, key facts and plain-English definitions.`;

  const itemList = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Quickies",
    url: `${SITE}/quickies/`,
    description,
    isPartOf: { "@type": "WebSite", name: "QuickyWiki", url: `${SITE}/` },
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: quickies.length,
      itemListElement: categoryOrder.map((c, i) => ({ "@type": "ListItem", position: i + 1, url: `${SITE}${topicPath(c)}`, name: `${categoryLabel(c)} Quickies` })),
    },
  };
  const breadcrumbs = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: `${SITE}/` },
      { "@type": "ListItem", position: 2, name: "Quickies", item: `${SITE}/quickies/` },
    ],
  };

  let eagerLeft = 4;
  const groups = categoryOrder.map((c) => {
    const all = byCategory.get(c);
    const more = all.length > HUB_PER_CATEGORY
      ? `<p class="q-more"><a href="${topicPath(c)}">See all ${all.length} ${esc(categoryLabel(c))} Quickies</a></p>`
      : "";
    return `<section class="q-group" id="${slugify(categoryLabel(c))}" aria-labelledby="h-${slugify(c)}">
    <h2 id="h-${slugify(c)}"><a href="${topicPath(c)}">${esc(categoryLabel(c))}</a></h2>
    <ul class="qgrid">
        ${all.slice(0, HUB_PER_CATEGORY).map((q) => card(q, { eager: eagerLeft-- > 0 })).join("\n        ")}
    </ul>
    ${more}
  </section>`;
  }).join("\n\n  ");

  return head({ title, description, canonical: `${SITE}/quickies/`, jsonLd: [itemList, breadcrumbs] }) + pageHead({
    back: { href: "/", label: "Back to site" },
    eyebrow: `<p class="eyebrow">The library</p>`,
    h1: `Big ideas, <em>five minutes each.</em>`,
    lede: "A free sample of the QuickyWiki library: short, beautifully written reads on the topics people are most curious about. Pick one and know something new before your coffee cools.",
    extra: chipsNav(),
  }) + `
<main class="hub">
  ${groups}

  ${APP_CTA}
</main>

${FOOTER}`;
}

// ---------------------------------------------------------------- sitemap + robots

function sitemap() {
  const today = new Date().toISOString().slice(0, 10);
  const static_ = [
    { loc: `${SITE}/`, priority: "1.0", changefreq: "weekly" },
    { loc: `${SITE}/quickies/`, priority: "0.9", changefreq: "weekly" },
    { loc: `${SITE}/contact.html`, priority: "0.3", changefreq: "yearly" },
    { loc: `${SITE}/privacy.html`, priority: "0.2", changefreq: "yearly" },
    { loc: `${SITE}/terms.html`, priority: "0.2", changefreq: "yearly" },
  ];
  const urls = [
    ...static_.map((u) => ({ ...u, lastmod: today })),
    ...categoryOrder.map((c) => ({ loc: `${SITE}${topicPath(c)}`, lastmod: today, changefreq: "weekly", priority: "0.8" })),
    ...quickies.map((q) => ({ loc: q.url, lastmod: (q.modified ?? today).slice(0, 10), changefreq: "monthly", priority: "0.7", image: q.cover && `${SITE}${q.cover}` })),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${urls.map((u) => `  <url>
    <loc>${esc(u.loc)}</loc>
    <lastmod>${u.lastmod}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>${u.image ? `\n    <image:image><image:loc>${esc(u.image)}</image:loc></image:image>` : ""}
  </url>`).join("\n")}
</urlset>
`;
}

const ROBOTS = `User-agent: *
Allow: /

Sitemap: ${SITE}/sitemap.xml
`;

// ---------------------------------------------------------------- write

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "index.html"), hubPage());
for (const c of categoryOrder) {
  const dir = join(ROOT, topicPath(c));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.html"), topicPage(c));
}
for (const q of quickies) {
  mkdirSync(join(OUT_DIR, q.slug), { recursive: true });
  writeFileSync(join(OUT_DIR, q.slug, "index.html"), quickyPage(q));
}
writeFileSync(join(ROOT, "sitemap.xml"), sitemap());
writeFileSync(join(ROOT, "robots.txt"), ROBOTS);

console.log(`Built ${quickies.length} Quickies across ${categoryOrder.length} categories → quickies/, sitemap.xml, robots.txt`);
