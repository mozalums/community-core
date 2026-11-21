import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile } from 'svelte/compiler';
const { chromium } = await import(process.env.E50_PLAYWRIGHT_MODULE ?? 'playwright-core');
const root = process.cwd();
registerHooks({
 resolve(specifier, context, next) {
  if (!specifier.startsWith('$lib/')) return next(specifier, context);
  const p = resolve(root, 'src/lib', specifier.slice(5));
  return { url: pathToFileURL(existsSync(p) ? p : `${p}.ts`).href, shortCircuit: true };
 },
 load(url, context, next) {
  if (!url.endsWith('.svelte')) return next(url, context);
  const filename = fileURLToPath(url);
  return { format: 'module', source: compile(readFileSync(filename, 'utf8'), { filename, generate: 'server' }).js.code, shortCircuit: true };
 }
});
const { render } = await import('svelte/server');
const { default: MemberTile } = await import(pathToFileURL(resolve('src/lib/components/MemberTile.svelte')).href);
const cssDir = '.svelte-kit/output/client/_app/immutable/assets';
const css = readdirSync(cssDir).filter(p => p.endsWith('.css')).map(p => readFileSync(`${cssDir}/${p}`, 'utf8')).join('\n');
const gridClass = readFileSync('src/routes/group/[slug]/members/+page.svelte', 'utf8').match(/<ul class="([^"]+)"/)[1];
const names = ['Maximiliana Konstantinopoulou-Vanderbilt de la Torre y Fitzgerald-Nguy', 'Bartholomew Featherstonehaugh-Cholmondeley', 'Alexandria Montgomery', 'Konstantinopoulos Montgomery', 'Chandrasekharan Ramachandran', 'Venkatanarasimha Srinivasan', 'Alexandria-Christine Montgomery', 'Christopher Alexander', 'Ana Ruiz'];
const tiles = names.map((name, i) => render(MemberTile, { props: {member: {id: `m${i}`, name, city: i % 2 ? null : 'Saint-Jean-sur-Richelieu', gravatarHash: null, avatarId: null, matched: i===4 ? [{label:'Hobbies',words:['cars']}] : []}, href: `/group/g/members/m${i}`, starred: i%2===0, onToggleStar() {}} }).body).join('\n');
const html = `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><body><div class="flex min-h-screen bg-gray-100"><div class="sticky top-0 hidden h-screen shrink-0 md:block"><aside class="w-72"></aside></div><div class="flex min-w-0 flex-1 flex-col"><main class="mx-auto w-full px-4 py-8 max-w-3xl"><ul class="${gridClass}">${tiles}</ul></main></div></div></body></html>`;
writeFileSync('node_modules/.cache/e50/review-layout.html', html);
const browser = await chromium.launch({headless:true});
try {
 const page = await browser.newPage();
 const results = [];
 for (const width of [375,640,768,1024,1280]) {
  await page.setViewportSize({width,height:850});
  await page.setContent(html);
  const rows = await page.locator('li').evaluateAll(tiles => tiles.map(tile => {
   const name = tile.querySelector('p');
   const n = name.getBoundingClientRect();
   const star = tile.querySelector('button').getBoundingClientRect();
   const surnameText = name.textContent.trim().split(/\s+/).at(-1);
   const walker = document.createTreeWalker(name, NodeFilter.SHOW_TEXT);
   let text; let index = -1;
   while ((text = walker.nextNode())) {
    index = text.textContent.indexOf(surnameText);
    if (index >= 0) break;
   }
   if (!text) throw new Error(`Surname text missing: ${surnameText}`);
   const range = document.createRange();
   range.setStart(text, index); range.setEnd(text, index + 1);
   const surname = range.getBoundingClientRect();
   const style = getComputedStyle(name);
   return {name: name.textContent, tileWidth: tile.getBoundingClientRect().width, textWidth: n.width, nameHeight:n.height, lineHeight: style.lineHeight, starGap: star.left-n.right, surnameTop: surname.top-n.top, surnameVisible: surname.bottom<=n.bottom, label:tile.querySelector('a').getAttribute('aria-label'), clamp:style.webkitLineClamp,hyphens:style.hyphens,wrap:style.overflowWrap};
  }));
  console.log(JSON.stringify({width,rows}));
  results.push({width,rows});
  for(const row of rows) assert.ok(row.starGap>=0, `star overlap at ${width}: ${row.name}`);
  if ([375,1280].includes(width)) await page.screenshot({path:`node_modules/.cache/e50/review-${width}.png`,fullPage:true});
 }
 writeFileSync('node_modules/.cache/e50/review-layout.json', JSON.stringify(results,null,2));
 for (const width of [375, 640, 768, 1024, 1280]) {
 test(`R1: a two-word name retains its surname at ${width}px`, () => {
   const row = results.find(x => x.width === width).rows.find(x => x.name === 'Alexandria-Christine Montgomery');
   assert.ok(row.surnameVisible, `${width}px: Montgomery starts at y=${row.surnameTop}px inside a ${row.nameHeight}px name; text column is ${row.textWidth}px`);
 });
 }
} finally { await browser.close(); }
