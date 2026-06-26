/* Wake-completeness driver: runs every window.__wake.verify* against the source-aliased dev server.
     BENCH_PORT=4320 node bench/xyflow-granular/drive-wake.cjs */
const { chromium } = require('@playwright/test');

const PORT = process.env.BENCH_PORT || '4320';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('CONSOLE ERROR:', m.text());
  });
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__wake, null, { timeout: 30000 });

  const names = await page.evaluate(() => Object.keys(window.__wake).filter((k) => k.startsWith('verify')));
  let ok = true;
  for (const name of names) {
    const r = await page.evaluate(async (n) => await window.__wake[n](), name);
    console.log(`\n=== ${name}: ${r.ok ? 'OK' : 'FAIL'} ===`);
    console.log(JSON.stringify(r.checks, null, 2));
    ok = ok && r.ok;
  }

  await browser.close();
  console.log(ok ? '\nALL WAKE VERIFIERS OK' : '\nWAKE VERIFIERS FAILED');
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
