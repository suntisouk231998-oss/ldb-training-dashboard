// Runs inside GitHub Actions. Loads dashboard.html (the template, with its
// own upload/parsing logic baked in) in headless Chromium, feeds it
// sheet_export.xlsx (downloaded by the workflow step before this script
// runs), reads back the parsed archive from localStorage, then embeds that
// archive into dashboard.html's #rawData script tag to produce index.html.
//
// This intentionally reuses the dashboard's OWN parsing code (same as the
// human "upload Excel" button) rather than re-implementing the Excel
// parsing logic here, so behavior always matches what a person would see
// if they uploaded the file by hand in the browser.

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();

  page.on('console', msg => console.log('[console]', msg.type(), msg.text()));
  page.on('pageerror', err => console.log('[pageerror]', err.message));

  const htmlPath = path.join(ROOT, 'dashboard.html');
  await page.goto('file://' + htmlPath);

  await page.waitForSelector('#fileInput', { timeout: 15000 });

  await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
  await page.reload();
  await page.waitForSelector('#fileInput', { timeout: 15000 });

  const xlsxPath = path.join(ROOT, 'sheet_export.xlsx');
  const xlsxBuffer = fs.readFileSync(xlsxPath);
  await page.setInputFiles('#fileInput', {
    name: 'sheet_export.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: xlsxBuffer
  });

  for (let i = 0; i < 3; i++) {
    try {
      await page.waitForFunction(() => {
        const bd = document.getElementById('modalBackdrop');
        return bd && !bd.hidden;
      }, { timeout: 8000 });
    } catch (e) {
      console.log('[info] no more modals after', i, 'click(s)');
      break;
    }
    const modalTitle = await page.evaluate(() => {
      const t = document.getElementById('modalTitle');
      return t ? t.textContent : null;
    });
    console.log('[info] modal appeared:', modalTitle);
    await page.click('#modalOk');
    await page.waitForTimeout(600);
  }

  // The actual parse/match/render/save work after the modals close can take
  // a long time (tens of seconds) for a large sheet, with no reliable DOM
  // signal of completion (the save-button text does not reflect it). So
  // instead of waiting for a fixed delay or a button state, poll the
  // localStorage payload's length until it stops changing across
  // consecutive checks -- that's what "done" actually looks like.
  let lastLen = -1;
  let stableCount = 0;
  const REQUIRED_STABLE = 3;
  const POLL_MS = 3000;
  const MAX_MS = 170000;
  const started = Date.now();
  while (Date.now() - started < MAX_MS) {
    const len = await page.evaluate(() => {
      try {
        const v = localStorage.getItem('ldb_training_dashboard_v2');
        return v ? v.length : 0;
      } catch (e) { return -1; }
    });
    console.log('[poll]', Math.round((Date.now() - started) / 1000) + 's', 'localStorage length =', len);
    if (len > 0 && len === lastLen) {
      stableCount++;
      if (stableCount >= REQUIRED_STABLE) {
        console.log('[info] localStorage stable for', REQUIRED_STABLE, 'checks -- done');
        break;
      }
    } else {
      stableCount = 0;
    }
    lastLen = len;
    await page.waitForTimeout(POLL_MS);
  }

  const archiveJson = await page.evaluate(() => {
    try { return localStorage.getItem('ldb_training_dashboard_v2'); } catch (e) { return null; }
  });

  await browser.close();

  if (!archiveJson) {
    console.log('[error] no archive found in localStorage after upload -- aborting without touching index.html');
    process.exit(1);
  }

  const parsed = JSON.parse(archiveJson);
  console.log('[info] archive v=', parsed.v, 'years=', Object.keys(parsed.years || {}));
  for (const y of Object.keys(parsed.years || {})) {
    const tr = (parsed.years[y].tracking || []).length;
    console.log('[info] year', y, 'tracking records:', tr);
  }

  fs.writeFileSync(path.join(ROOT, 'archive.json'), archiveJson);
  console.log('[info] wrote archive.json, length =', archiveJson.length);

  const startMarker = Buffer.from('<script id="rawData" type="application/json">');
  const endMarker = Buffer.from('</script>');

  const htmlBuf = fs.readFileSync(htmlPath);
  const archiveBuf = fs.readFileSync(path.join(ROOT, 'archive.json'));

  const startIdx = htmlBuf.indexOf(startMarker);
  if (startIdx === -1) throw new Error('rawData start marker not found in dashboard.html');
  const contentStart = startIdx + startMarker.length;
  const endIdx = htmlBuf.indexOf(endMarker, contentStart);
  if (endIdx === -1) throw new Error('rawData end marker not found in dashboard.html');

  const newHtml = Buffer.concat([
    htmlBuf.subarray(0, contentStart),
    archiveBuf,
    htmlBuf.subarray(endIdx)
  ]);

  fs.writeFileSync(path.join(ROOT, 'index.html'), newHtml);
  console.log('[info] wrote index.html,', newHtml.length, 'bytes');
})().catch(err => {
  console.error('[fatal]', err);
  process.exit(1);
});
