// Generates the favicon set and the Open Graph image into public/.
// Run with `npm run assets`. Commit the outputs; the build does not run this.
import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const root = new URL("..", import.meta.url);
const file = (path) => new URL(path, root);

// A "p." monogram: the first letter of the wordmark and its dot, as
// Inter SemiBold outlines (@fontsource/inter 5.3.0, inter-latin-600-normal),
// scaled to 19 units wide and centered. Outlines, not text, so the icon
// does not depend on fonts. The tile is dark on light browser chrome and
// light on dark chrome.
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <style>
    .tile { fill: #171717 }
    .glyph { fill: #fafafa }
    @media (prefers-color-scheme: dark) {
      .tile { fill: #fafafa }
      .glyph { fill: #171717 }
    }
  </style>
  <rect class="tile" width="32" height="32" rx="7"/>
  <path class="glyph" d="M6.5 25.05L6.5 7.11L9.47 7.11L9.47 9.27L9.66 9.27Q9.9 8.81 10.33 8.27Q10.76 7.73 11.5 7.34Q12.25 6.95 13.4 6.95Q14.92 6.95 16.13 7.72Q17.35 8.49 18.07 9.99Q18.79 11.49 18.79 13.66Q18.79 15.81 18.08 17.32Q17.38 18.83 16.16 19.61Q14.94 20.4 13.39 20.4Q12.28 20.4 11.53 20.02Q10.79 19.64 10.34 19.11Q9.9 18.57 9.66 18.1L9.54 18.1L9.54 25.05ZM12.57 17.9Q13.59 17.9 14.28 17.35Q14.97 16.79 15.32 15.83Q15.67 14.87 15.67 13.65Q15.67 12.44 15.32 11.49Q14.98 10.53 14.29 9.99Q13.6 9.45 12.57 9.45Q11.57 9.45 10.88 9.97Q10.19 10.5 9.83 11.44Q9.48 12.38 9.48 13.65Q9.48 14.93 9.83 15.88Q10.19 16.84 10.89 17.37Q11.58 17.9 12.57 17.9ZM23.62 20.37Q22.84 20.37 22.29 19.83Q21.75 19.29 21.75 18.5Q21.75 17.72 22.29 17.18Q22.84 16.64 23.62 16.64Q24.41 16.64 24.96 17.18Q25.5 17.72 25.5 18.5Q25.5 19.29 24.96 19.83Q24.41 20.37 23.62 20.37Z"/>
</svg>
`;

const networks = [
  ["Ethereum", "ethereum"],
  ["Base", "base"],
  ["Robinhood", "robinhood"],
  ["Monad", "monad"],
  ["Solana", "solana"],
  ["Sui", "sui"],
  ["Aptos", "aptos"],
  ["Stellar", "stellar"],
  // Project Thruput uses the Stellar mark on its official site.
  ["Thruput", "stellar"],
];

async function dataUrl(path, type) {
  return `data:${type};base64,${(await readFile(file(path))).toString("base64")}`;
}

async function ogHtml() {
  const inter = await dataUrl(
    "node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
    "font/woff2",
  );
  const logos = await Promise.all(
    networks.map(async ([name, icon]) => [
      name,
      await dataUrl(`src/assets/networks/${icon}.svg`, "image/svg+xml"),
    ]),
  );
  // Colors from the landing page's dark theme (shadcn neutral).
  return `<!doctype html><html><head><style>
    @font-face { font-family: Inter; src: url(${inter}) format("woff2"); font-weight: 100 900; }
    * { margin: 0; box-sizing: border-box; }
    body { width: 1200px; height: 630px; background: #0a0a0a; color: #fafafa;
      font-family: Inter; font-feature-settings: "cv02","cv03","cv04","cv11","ss01","ss03";
      display: flex; flex-direction: column; justify-content: space-between; padding: 72px 80px 64px; }
    .wordmark { font-size: 40px; font-weight: 600; letter-spacing: -0.025em; }
    h1 { font-size: 76px; font-weight: 600; line-height: 1.05; letter-spacing: -0.035em; }
    p { margin-top: 24px; font-size: 27px; color: #a1a1a1; letter-spacing: -0.01em; }
    ul { list-style: none; padding: 28px 0 0; border-top: 1px solid #262626;
      display: flex; justify-content: space-between; font-size: 20px; color: #d4d4d4; }
    li { display: flex; align-items: center; gap: 8px; }
    .mark { width: 22px; height: 22px; background: currentColor;
      mask-size: contain; mask-repeat: no-repeat; mask-position: center; }
  </style></head><body>
    <div class="wordmark">paymvc.</div>
    <div>
      <h1>One payments app.<br>Many smart contracts.</h1>
      <p>Smart contract platform explorer and test harness for blockchain developers.</p>
    </div>
    <ul>${logos
      .map(
        ([name, url]) =>
          `<li><span class="mark" style="mask-image:url('${url}')"></span>${name}</li>`,
      )
      .join("")}</ul>
  </body></html>`;
}

// An ICO file can hold PNG images directly (Windows Vista and later).
function ico(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, index) => {
    const entry = 6 + index * 16;
    header.writeUInt8(size, entry);
    header.writeUInt8(size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map(({ png }) => png)]);
}

const browser = await chromium.launch();
async function render(html, width, height, scheme = "light") {
  const page = await browser.newPage({
    viewport: { width, height },
    colorScheme: scheme,
  });
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready);
  const png = await page.screenshot({ omitBackground: true });
  await page.close();
  return png;
}
// iOS rounds home screen icons itself, so the touch icon is a full square.
const touchIcon = favicon.replace('rx="7"', 'rx="0"');
const iconHtml = (size, svg = favicon) =>
  `<html><body style="margin:0"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}" width="${size}" height="${size}"></body></html>`;

await writeFile(file("public/favicon.svg"), favicon);
await writeFile(
  file("public/favicon.ico"),
  ico([
    { size: 16, png: await render(iconHtml(16), 16, 16) },
    { size: 32, png: await render(iconHtml(32), 32, 32) },
    { size: 48, png: await render(iconHtml(48), 48, 48) },
  ]),
);
await writeFile(
  file("public/apple-touch-icon.png"),
  await render(iconHtml(180, touchIcon), 180, 180),
);
await writeFile(file("public/og.png"), await render(await ogHtml(), 1200, 630));
await browser.close();
console.log(
  "Wrote public/favicon.svg, favicon.ico, apple-touch-icon.png, og.png",
);
