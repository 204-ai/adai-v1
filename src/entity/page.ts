// The standalone entity page: the server-rendered entity view (view.ts) in a
// document of its own, for direct links, invitations and search engines.
// The same stylesheet and script serve the /field overlay.

import { htmlEscape as esc } from "../templates.js";
import { fieldPath, siteBase } from "../utils/site.js";
import { nodePath, type EntityNode, type EntityRender } from "./view.js";

export const ENTITY_ASSET_VERSION = "20261022b";

export function entityPage(node: EntityNode, r: EntityRender): string {
  const canonical = siteBase() + nodePath(node);
  const fieldHref = fieldPath(node);
  const og = [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="A(DAI)">`,
    `<meta property="og:title" content="${esc(r.title)}">`,
    `<meta property="og:description" content="${esc(r.description)}">`,
    `<meta property="og:url" content="${esc(canonical)}">`,
    r.image ? `<meta property="og:image" content="${esc(r.image)}">` : "",
    `<meta name="twitter:card" content="${r.image ? "summary_large_image" : "summary"}">`,
  ].join("");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(r.title)} — A(DAI)</title>
<meta name="description" content="${esc(r.description)}">
<link rel="canonical" href="${esc(canonical)}">${og}
<link rel="stylesheet" href="/field-static/css/fonts.css?v=20260530a">
<link rel="stylesheet" href="/field-static/css/entity-view.css?v=${ENTITY_ASSET_VERSION}">
</head><body class="ev-page">
<div id="entity-view" class="is-open is-page">
  <nav class="ev-topbar" aria-label="site">
    <a class="ev-topbar-home" href="/">A<span>(DAI)</span></a>
    <span class="ev-topbar-links"><a href="${fieldHref}">field</a><a href="/contribute">contribute</a><a href="/whitepaper">whitepaper</a></span>
  </nav>
  ${r.article}
</div>
<script defer src="/field-static/js-interface/entity-view.js?v=${ENTITY_ASSET_VERSION}"></script>
</body></html>`;
}
