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

  // start from a clean localStorage so we don't merge with a stale profile
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

  // The app opens a modal asking which year this data is for (pre-filled),
  // and sometimes a second confirm modal ("overwrite existing year data?").
  // Both use the same #modalOk button. Click through up to 3 times.
  for (let i = 0; i < 3; i++) {
    try {
      await page.waitForFunction(() => {
        const bd = document.getElementById('modalBackdrop');
        return bd && !bd.hidden;
      }, { timeout: 5000 });
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
    await page.waitForTimeout(400);
  }

  await page.waitForFunction(() => {
    const btn = document.getElementById('saveBtn');
    if (!btn) return false;
    const t = btn.textContent || '';
    return t.indexOf('ບັນທຶກແລ້ວ') !== -1 || t.indexOf('ໃນເຄື່ອງນີ້') !== -1 ||
           t.indexOf('ບໍ່ສຳເລັດ') !== -1 || t.indexOf('ອ່ານຢ່າງດຽວ') !== -1;
  }, { timeout: 15000 }).catch(e => console.log('[warn] save state wait timed out:', e.message));

  await page.waitForTimeout(1500);

  const archiveJson = await page.evaluate(() => {
    try { return localStorage.getItem('ldb_training_dashboard_v2'); } catch (e) { return null; }
  });

  await browser.close();

  if (!archiveJson) {
    console.log('[error] no archive found in localStorage after upload — aborting without touching index.html');
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

  // Embed archive.json into dashboard.html's #rawData tag -> index.html
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

  // Also build the simplified executive view (3 tabs only: overview, monthly
  // topic tracking, executive report) at exec/index.html. Same data, same
  // template, but with the ldb-exec-mode meta flag flipped to "true" so the
  // dashboard's own JS hides the staff/dept/QR/AI/multi-year tabs.
  const execMarker = Buffer.from('<meta name="ldb-exec-mode" content="false">');
  const execMarkerOn = Buffer.from('<meta name="ldb-exec-mode" content="true">');
  const execMarkerIdx = htmlBuf.indexOf(execMarker);
  if (execMarkerIdx === -1) {
    console.log('[warn] ldb-exec-mode meta marker not found — skipping exec/index.html build');
  } else {
    const execHtmlBuf = Buffer.concat([
      htmlBuf.subarray(0, execMarkerIdx),
      execMarkerOn,
      htmlBuf.subarray(execMarkerIdx + execMarker.length)
    ]);
    const execStartIdx = execHtmlBuf.indexOf(startMarker);
    const execContentStart = execStartIdx + startMarker.length;
    const execEndIdx = execHtmlBuf.indexOf(endMarker, execContentStart);
    const newExecHtml = Buffer.concat([
      execHtmlBuf.subarray(0, execContentStart),
      archiveBuf,
      execHtmlBuf.subarray(execEndIdx)
    ]);
    fs.mkdirSync(path.join(ROOT, 'exec'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'exec', 'index.html'), newExecHtml);
    console.log('[info] wrote exec/index.html,', newExecHtml.length, 'bytes');
  }
})().catch(err => {
  console.error('[fatal]', err);
  process.exit(1);
});
