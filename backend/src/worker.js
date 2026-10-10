import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Builder, By, until } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';

const PORTAL_URL =
  'https://services.nesl.co.in/NeslPortalWebUtility/';

const WAIT_MS = 90_000;
const PDF_TIMEOUT_MS = 180_000;
const DOWNLOAD_RETRIES = 3;

const pause = ms => sleep(ms);
const now = () => new Date().toISOString();

function ensureDir(folder) {
  fs.mkdirSync(folder, { recursive: true });
  return path.resolve(folder);
}

function addLog(job, level, message) {
  job.logs.push({
    at: now(),
    level,
    message
  });

  if (job.logs.length > 500) {
    job.logs.splice(0, job.logs.length - 500);
  }

  console.log(`[${level.toUpperCase()}] ${message}`);
}

function normalizeStatus(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');
}

function modeAllows(mode, eStamp, eSign) {
  const stamp = normalizeStatus(eStamp) === 'SUCCESS';
  const sign = normalizeStatus(eSign) === 'SUCCESS';

  if (mode === 'fully-executed') {
    return stamp && sign;
  }

  if (mode === 'only-estamped') {
    return stamp && !sign;
  }

  return stamp;
}

function safeName(id) {
  return (
    String(id)
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .trim() || 'transaction'
  );
}

async function listPdfs(folder) {
  try {
    const entries = await fs.promises.readdir(folder, {
      withFileTypes: true
    });

    return new Set(
      entries
        .filter(
          entry =>
            entry.isFile() &&
            entry.name.toLowerCase().endsWith('.pdf')
        )
        .map(entry => path.resolve(folder, entry.name))
    );
  } catch {
    return new Set();
  }
}

async function fileStable(file) {
  try {
    const first = await fs.promises.stat(file);

    await pause(3000);

    const second = await fs.promises.stat(file);

    return first.size > 0 && first.size === second.size;
  } catch {
    return false;
  }
}

async function waitForNewPdf(folder, before) {
  const deadline = Date.now() + PDF_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const entries = await fs.promises
      .readdir(folder, { withFileTypes: true })
      .catch(() => []);

    for (const entry of entries) {
      if (
        !entry.isFile() ||
        !entry.name.toLowerCase().endsWith('.pdf')
      ) {
        continue;
      }

      const fullPath = path.resolve(folder, entry.name);

      if (before.has(fullPath)) {
        continue;
      }

      if (await fileStable(fullPath)) {
        return fullPath;
      }
    }

    await pause(1000);
  }

  throw new Error('PDF download timeout after 180 seconds.');
}

/**
 * Read a value from the NeSL transaction details table.
 */
async function textByHeader(driver, headerName) {
  const script = `
    var tables = document.querySelectorAll('table.childTbl');

    for (var i = 0; i < tables.length; i++) {
      var table = tables[i];

      if (!table || table.offsetParent === null) {
        continue;
      }

      var headers = table.querySelectorAll('td.tblColHeader');

      for (var j = 0; j < headers.length; j++) {
        var header = (headers[j].innerText || '').trim();

        if (header.toLowerCase() === arguments[0].toLowerCase()) {
          var cell = headers[j].nextElementSibling;

          if (cell) {
            return (cell.innerText || '').trim();
          }
        }
      }
    }

    return '';
  `;

  const deadline = Date.now() + WAIT_MS;

  while (Date.now() < deadline) {
    const value = String(
      (await driver.executeScript(script, headerName)) ?? ''
    ).trim();

    if (value) {
      return value;
    }

    await pause(500);
  }

  throw new Error(
    `${headerName} not found in expanded transaction details.`
  );
}

/**
 * Dismiss a browser alert when one is present.
 */
async function dismissAlert(driver, job) {
  try {
    const alert = await driver.switchTo().alert();
    const text = await alert.getText();

    await alert.accept();

    addLog(job, 'warn', `Portal alert dismissed: ${text}`);

    return text;
  } catch {
    return '';
  }
}

/**
 * Open the DDE Search page.
 */
async function clickDdeSearch(driver, wait) {
  const link = await wait.until(
    until.elementLocated(
      By.xpath("//a[normalize-space()='DDE Search']")
    )
  );

  await wait.until(until.elementIsVisible(link));

  await driver.executeScript(
    'arguments[0].click();',
    link
  );

  const loanType = await driver.findElement(By.id('loanType'));

  await wait.until(until.elementIsVisible(loanType));
}

/**
 * Search for a transaction and read its status details.
 */
async function searchTransaction(driver, wait, transactionId) {
  await dismissAlert(driver, { logs: [] });

  await clickDdeSearch(driver, wait);

  const select = await wait.until(
    until.elementLocated(By.id('loanType'))
  );

  await driver.executeScript(
    `
      arguments[0].value = 'submitterTxnId';
      arguments[0].dispatchEvent(
        new Event('change', { bubbles: true })
      );
    `,
    select
  );

  const input = await wait.until(
    until.elementLocated(By.id('ddSearchReqNo'))
  );

  await input.clear();
  await input.sendKeys(transactionId);

  const validateButton = await wait.until(
    until.elementLocated(By.id('validate'))
  );

  await validateButton.click();

  const deadline = Date.now() + WAIT_MS;

  let ddeId = '';

  while (Date.now() < deadline) {
    const rows = await driver.findElements(
      By.css('#tblDDESearch tbody tr[role="row"]')
    );

    for (const row of rows) {
      try {
        if (!(await row.isDisplayed())) {
          continue;
        }

        const cells = await row.findElements(By.css('td'));

        if (cells.length) {
          ddeId = (await cells[0].getText()).trim();

          if (ddeId) {
            break;
          }
        }
      } catch {
        // Ignore rows that disappear while the table updates.
      }
    }

    if (ddeId) {
      break;
    }

    await pause(500);
  }

  if (!ddeId) {
    throw new Error(
      'Transaction not found in DDE Search (or search results timed out).'
    );
  }

  const firstCell = await driver.findElement(
    By.css('#tblDDESearch tbody tr[role="row"] td')
  );

  await driver.executeScript(
    `
      arguments[0].scrollIntoView({ block: 'center' });
      arguments[0].click();
    `,
    firstCell
  );

  const childDeadline = Date.now() + WAIT_MS;

  while (Date.now() < childDeadline) {
    const found = await driver.executeScript(`
      return [...document.querySelectorAll('table.childTbl')]
        .some(table =>
          table.offsetParent !== null &&
          (table.innerText || '').includes('E-Stamp Status') &&
          (table.innerText || '').includes('E-Sign Status')
        );
    `);

    if (found) {
      break;
    }

    await pause(500);
  }

  const [
    submittedDate,
    eSignStatus,
    eStampStatus
  ] = await Promise.all([
    textByHeader(driver, 'Submitted date'),
    textByHeader(driver, 'E-Sign Status'),
    textByHeader(driver, 'E-Stamp Status')
  ]);

  return {
    ddeId,
    submittedDate,
    eSignStatus,
    eStampStatus
  };
}

/**
 * Trigger a document download from the portal.
 */
async function downloadPdf(driver, downloadDir, job) {
  const before = await listPdfs(downloadDir);

  const deadline = Date.now() + WAIT_MS;

  while (Date.now() < deadline) {
    try {
      const id = await driver.executeScript(`
        var tables = document.querySelectorAll('table.childTbl');

        for (var i = 0; i < tables.length; i++) {
          var table = tables[i];

          if (!table || table.offsetParent === null) {
            continue;
          }

          var headers = table.querySelectorAll('td.tblColHeader');

          for (var j = 0; j < headers.length; j++) {
            var header = (headers[j].innerText || '').trim();

            if (header.toLowerCase() === 'doc link') {
              var cell = headers[j].nextElementSibling;

              if (!cell) {
                continue;
              }

              var link = cell.querySelector('a.li1');

              if (!link || !link.id) {
                continue;
              }

              downloadfile(link.id);

              return link.id;
            }
          }
        }

        return '';
      `);

      if (!id) {
        await pause(500);
        continue;
      }

      addLog(
        job,
        'info',
        'Triggered portal PDF download. Waiting for the file.'
      );

      return await waitForNewPdf(downloadDir, before);
    } catch (error) {
      const alertText = await dismissAlert(driver, job);

      if (alertText.toLowerCase().includes('no file found')) {
        throw new Error('No File Found');
      }

      if (error?.message?.includes('PDF download timeout')) {
        throw error;
      }

      await pause(500);
    }
  }

  throw new Error(
    'Doc Link download control was not found within 90 seconds.'
  );
}

/**
 * Retry document downloads when retry is enabled.
 */
async function downloadWithRetry(
  driver,
  downloadDir,
  job,
  retryEnabled
) {
  const maxAttempts = retryEnabled ? DOWNLOAD_RETRIES : 1;

  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    addLog(
      job,
      'info',
      `PDF download attempt ${attempt}/${maxAttempts}.`
    );

    try {
      return await downloadPdf(driver, downloadDir, job);
    } catch (error) {
      lastError = error;

      await dismissAlert(driver, job);

      addLog(
        job,
        'warn',
        `Attempt ${attempt} failed: ${
          error?.message || 'Unknown error'
        }`
      );

      if (attempt < maxAttempts) {
        addLog(
          job,
          'info',
          'Waiting 3 seconds before retry.'
        );

        await pause(3000);
      }
    }
  }

  throw lastError || new Error('PDF download failed.');
}

/**
 * Escape CSV values.
 */
function csvCell(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

async function appendCsv(file, headers, row) {
  const exists =
    fs.existsSync(file) &&
    fs.statSync(file).size > 0;

  const line =
    row.map(csvCell).join(',') + '\r\n';

  if (!exists) {
    await fs.promises.appendFile(
      file,
      headers.map(csvCell).join(',') + '\r\n',
      'utf8'
    );
  }

  await fs.promises.appendFile(file, line, 'utf8');
}

/**
 * Create Chrome options suitable for local development and Render.
 *
 * IMPORTANT:
 * This configures Chrome to run headlessly on Render.
 * Chrome must still be installed in the server environment.
 */
function createChromeOptions(downloadDir) {
  const options = new chrome.Options();

  const isRender = Boolean(process.env.RENDER);

  const isHeadless =
    isRender ||
    String(process.env.CHROME_HEADLESS).toLowerCase() === 'true';

  if (isHeadless) {
    options.addArguments(
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1440,1000'
    );
  } else {
    options.addArguments('--start-maximized');
  }

  options.addArguments(
    '--disable-popup-blocking',
    '--disable-extensions'
  );

  if (process.env.CHROME_BIN) {
    options.setChromeBinaryPath(process.env.CHROME_BIN);
  }

  options.setUserPreferences({
    'download.default_directory': downloadDir,
    'download.prompt_for_download': false,
    'download.directory_upgrade': true,
    'plugins.always_open_pdf_externally': true,
    'safebrowsing.enabled': true
  });

  return options;
}

/**
 * Main download job.
 */
export async function runDownloadJob({
  ids,
  mode,
  retryEnabled,
  username,
  password,
  job,
  onProgress
}) {
  const downloadDir = ensureDir(
    process.env.DOWNLOAD_DIR || './downloads'
  );

  const outputDir = ensureDir(
    process.env.OUTPUT_DIR || './output'
  );

  const statusDir = ensureDir(
    process.env.STATUS_DIR || './status'
  );

  const jobPrefix = `nesl-${job.id.slice(0, 8)}`;

  const resultCsv = path.join(
    statusDir,
    `${jobPrefix}-result.csv`
  );

  const pendingCsv = path.join(
    statusDir,
    `${jobPrefix}-pending_transactions.csv`
  );

  const esignSuccessCsv = path.join(
    statusDir,
    `${jobPrefix}-esign_success.csv`
  );

  const esignNotAffixedCsv = path.join(
    statusDir,
    `${jobPrefix}-esign_not_affixed.csv`
  );

  const esignPendingCsv = path.join(
    statusDir,
    `${jobPrefix}-esign_pending.csv`
  );

  for (const file of [
    resultCsv,
    pendingCsv,
    esignSuccessCsv,
    esignNotAffixedCsv,
    esignPendingCsv
  ]) {
    await fs.promises.rm(file, { force: true });
  }

  await fs.promises.writeFile(
    resultCsv,
    [
      'NESL Transaction ID',
      'Status',
      'File',
      'E-Stamp Status',
      'E-Sign Status',
      'Message'
    ].map(csvCell).join(',') + '\r\n',
    'utf8'
  );

  for (const file of [
    pendingCsv,
    esignSuccessCsv,
    esignNotAffixedCsv,
    esignPendingCsv
  ]) {
    await fs.promises.writeFile(
      file,
      ['NESL Transaction ID', 'Submitted Date']
        .map(csvCell)
        .join(',') + '\r\n',
      'utf8'
    );
  }

  const chromeOptions = createChromeOptions(downloadDir);

  let driver;

  try {
    addLog(
      job,
      'info',
      'Starting Chrome and opening the NeSL portal.'
    );

    driver = await new Builder()
      .forBrowser('chrome')
      .setChromeOptions(chromeOptions)
      .build();

    /*
     * Chrome's download preferences alone may not be enough
     * for headless Chrome. Enable downloads through CDP too.
     */
    if (
      process.env.RENDER ||
      String(process.env.CHROME_HEADLESS).toLowerCase() === 'true'
    ) {
      try {
        await driver.sendDevToolsCommand(
          'Page.setDownloadBehavior',
          {
            behavior: 'allow',
            downloadPath: downloadDir
          }
        );
      } catch (error) {
        addLog(
          job,
          'warn',
          `Could not configure Chrome download behavior: ${
            error?.message || error
          }`
        );
      }
    }

    const wait = {
      until: (condition, timeout = WAIT_MS) =>
        driver.wait(condition, timeout)
    };

    await driver.get(PORTAL_URL);

    await driver.wait(
      until.elementLocated(By.id('username')),
      WAIT_MS
    );

    await (
      await driver.findElement(By.id('username'))
    ).sendKeys(username || process.env.NESL_USERNAME);

    await (
      await driver.findElement(By.id('password'))
    ).sendKeys(password || process.env.NESL_PASSWORD);

    await (
      await driver.findElement(
        By.css("button[type='submit']")
      )
    ).click();

    await driver.wait(
      until.elementLocated(
        By.xpath("//a[normalize-space()='DDE Search']")
      ),
      WAIT_MS
    );

    addLog(job, 'success', 'Portal login succeeded.');

    for (const [index, transactionId] of ids.entries()) {
      const result = {
        transactionId,
        status: 'FAILED',
        file: '',
        eStampStatus: '',
        eSignStatus: '',
        message: ''
      };

      addLog(
        job,
        'info',
        `Processing ${index + 1}/${ids.length}: ${transactionId}`
      );

      try {
        const details = await searchTransaction(
          driver,
          wait,
          transactionId
        );

        result.eStampStatus = details.eStampStatus;
        result.eSignStatus = details.eSignStatus;

        addLog(
          job,
          'info',
          `${transactionId}: E-Stamp=${details.eStampStatus}; E-Sign=${details.eSignStatus}`
        );

        const eSign = normalizeStatus(details.eSignStatus);

        if (eSign === 'SUCCESS') {
          await appendCsv(
            esignSuccessCsv,
            ['NESL Transaction ID', 'Submitted Date'],
            [transactionId, details.submittedDate]
          );
        } else if (eSign === 'ESIGN NOT AFFIXED') {
          await appendCsv(
            esignNotAffixedCsv,
            ['NESL Transaction ID', 'Submitted Date'],
            [transactionId, details.submittedDate]
          );
        } else if (eSign === 'PENDING') {
          await appendCsv(
            esignPendingCsv,
            ['NESL Transaction ID', 'Submitted Date'],
            [transactionId, details.submittedDate]
          );
        }

        if (
          normalizeStatus(details.eStampStatus) === 'PENDING'
        ) {
          await appendCsv(
            pendingCsv,
            ['NESL Transaction ID', 'Submitted Date'],
            [transactionId, details.submittedDate]
          );
        }

        if (
          !modeAllows(
            mode,
            details.eStampStatus,
            details.eSignStatus
          )
        ) {
          result.status = 'SKIPPED';

          result.message =
            mode === 'fully-executed'
              ? 'Requires E-Stamp SUCCESS and E-Sign SUCCESS.'
              : mode === 'only-estamped'
                ? 'Only e-stamped, not fully e-signed documents are included.'
                : 'Requires E-Stamp SUCCESS.';

          job.skipped++;
        } else {
          const downloaded = await downloadWithRetry(
            driver,
            downloadDir,
            job,
            retryEnabled
          );

          const destination = path.join(
            outputDir,
            `${safeName(transactionId)}.pdf`
          );

          await fs.promises.copyFile(
            downloaded,
            destination
          );

          await fs.promises.unlink(downloaded).catch(() => {});

          result.status = 'SUCCESS';
          result.file = path.basename(destination);
          result.message = 'Downloaded successfully.';

          job.success++;

          addLog(
            job,
            'success',
            `Saved ${result.file}`
          );
        }
      } catch (error) {
        result.status = 'FAILED';
        result.message =
          error?.message || 'Unknown transaction error.';

        job.failed++;

        await dismissAlert(driver, job);

        addLog(
          job,
          'error',
          `${transactionId}: ${result.message}`
        );
      }

      job.results.push(result);

      await appendCsv(
        resultCsv,
        [
          'NESL Transaction ID',
          'Status',
          'File',
          'E-Stamp Status',
          'E-Sign Status',
          'Message'
        ],
        [
          result.transactionId,
          result.status,
          result.file,
          result.eStampStatus,
          result.eSignStatus,
          result.message
        ]
      );

      job.completed = index + 1;

      onProgress({
        completed: job.completed,
        success: job.success,
        skipped: job.skipped,
        failed: job.failed
      });
    }

    job.resultCsv = resultCsv;

    job.statusFiles = {
      result: resultCsv,
      pending: pendingCsv,
      esignSuccess: esignSuccessCsv,
      esignNotAffixed: esignNotAffixedCsv,
      esignPending: esignPendingCsv
    };

    job.outputDirectory = outputDir;

    job.pdfFiles = job.results
      .filter(result => result.status === 'SUCCESS')
      .map(result => path.join(outputDir, result.file));

    addLog(
      job,
      'success',
      `Finished. PDFs are saved to ${outputDir}`
    );
  } finally {
    if (driver) {
      await driver.quit().catch(() => {});
    }
  }
}