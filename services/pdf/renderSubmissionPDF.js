/*
====================================================================
services/pdf/renderSubmissionPDF.js

Entry point. One code path for every form in the table:

    submission -> normalizeSchema() -> renderFormHtml() -> Chromium -> PDF

No form-specific code. A new form created in FormBuilder gets a correct
PDF with no deploy.

OVERRIDES (optional, rarely needed)
-----------------------------------
If one particular printed form has a layout the schema genuinely can't
express (a pre-printed government form, an odd legal grid), register a
hand-written HTML template in OVERRIDES below and it wins for that form
only. Everything else keeps using the dynamic path. Start with none.

npm install puppeteer
Slim container also needs Chromium's libs + fonts-liberation — see README.
====================================================================
*/

const puppeteer = require("puppeteer");

const { buildSubmissionHtml } = require("./buildSubmissionHtml");

/* ------------------------- browser reuse ------------------------ */

let browserPromise = null;

async function getBrowser() {
    if (!browserPromise) {
        browserPromise = puppeteer.launch({
            headless: "new",
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--font-render-hinting=none"
            ]
        });
    }

    let browser;
    try {
        browser = await browserPromise;
    } catch (err) {
        browserPromise = null;
        throw err;
    }

    const alive = browser.connected ?? browser.isConnected?.();
    if (alive === false) {
        browserPromise = null;
        return getBrowser();
    }

    return browser;
}

async function closeBrowser() {
    if (!browserPromise) return;
    const b = await browserPromise.catch(() => null);
    browserPromise = null;
    if (b) await b.close().catch(() => {});
}

process.once("SIGTERM", closeBrowser);
process.once("SIGINT", closeBrowser);

/* --------------------------- rendering -------------------------- */

const FOOTER = `
<div style="width:100%;font-family:Arial,sans-serif;font-size:7.5pt;color:#7A7A78;
            padding:0 13mm;display:flex;justify-content:center">
  Page <span class="pageNumber"></span> of <span class="totalPages"></span>
</div>`;

async function htmlToPdfBuffer(html) {
    const browser = await getBrowser();
    const page = await browser.newPage();

    try {
        await page.emulateMediaType("print");
        await page.setContent(html, { waitUntil: "load", timeout: 30000 });

        return await page.pdf({
            format: "A4",
            printBackground: true,
            margin: { top: "12mm", right: "13mm", bottom: "14mm", left: "13mm" },
            displayHeaderFooter: true,
            headerTemplate: "<div></div>",
            footerTemplate: FOOTER
        });
    } finally {
        await page.close().catch(() => {});
    }
}

/**
 * @param {object} submission joined row (form_data/form_schema parsed)
 * @param {object} [opts] { includeDoctorOnly:false } for a patient copy
 */
async function renderSubmissionPDF(submission, opts = {}) {
    return htmlToPdfBuffer(buildSubmissionHtml(submission, opts));
}

module.exports = {
    renderSubmissionPDF,
    buildSubmissionHtml, // re-exported for convenience
    htmlToPdfBuffer,
    closeBrowser
};