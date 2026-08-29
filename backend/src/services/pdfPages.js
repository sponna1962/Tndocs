const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { PDFDocument } = require('pdf-lib');

async function splitPdfIntoPages(filePath) {
  const bytes = await fs.readFile(filePath);
  const source = await PDFDocument.load(bytes, { ignoreEncryption: false });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tnpsc-pages-'));
  const pages = [];
  try {
    for (let i = 0; i < source.getPageCount(); i += 1) {
      const out = await PDFDocument.create();
      const [copied] = await out.copyPages(source, [i]);
      out.addPage(copied);
      const outPath = path.join(dir, `page-${i + 1}.pdf`);
      await fs.writeFile(outPath, await out.save());
      pages.push({ pageNumber: i + 1, filePath: outPath, mimeType: 'application/pdf' });
    }
    return { totalPages: pages.length, pages, tempDir: dir };
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true });
    throw err;
  }
}

async function cleanupSplitPdf(tempDir) {
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
}
module.exports = { splitPdfIntoPages, cleanupSplitPdf };
