import { showLoader, hideLoader, showAlert } from '../ui.js';
import { downloadFile, readFileAsArrayBuffer } from '../utils/helpers.js';
import { state } from '../state.js';
import { t } from '../i18n/index.js';
import JSZip from 'jszip';

export async function pdfToPng() {
  showLoader(String(t('alerts.convertingToPng')));
  try {
    // @ts-expect-error TS(2304) FIXME: Cannot find name 'pdfjsLib'.
    const pdf = await pdfjsLib.getDocument(
      await readFileAsArrayBuffer(state.files[0])
    ).promise;
    const zip = new JSZip();
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 2.0 });
      const canvas = document.createElement('canvas');
      canvas.height = viewport.height;
      canvas.width = viewport.width;
      const context = canvas.getContext('2d');
      await page.render({ canvasContext: context, viewport: viewport }).promise;
      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, 'image/png')
      );
      zip.file(`page_${i}.png`, blob as Blob);
    }
    const zipBlob = await zip.generateAsync({ type: 'blob' });
    downloadFile(zipBlob, 'converted_pngs.zip');
  } catch (e) {
    console.error(e);
    showAlert(String(t('alerts.error')), String(t('alerts.failedConvertPng')));
  } finally {
    hideLoader();
  }
}
