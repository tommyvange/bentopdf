import { showLoader, hideLoader, showAlert } from '../ui.js';
import {
  downloadFile,
  readFileAsArrayBuffer,
  formatBytes,
} from '../utils/helpers.js';
import { state } from '../state.js';
import { t } from '../i18n/index.js';
import * as pdfjsLib from 'pdfjs-dist';

import { PDFDocument, PDFName, PDFDict, PDFStream, PDFNumber } from 'pdf-lib';

function dataUrlToBytes(dataUrl: any) {
  const base64 = dataUrl.split(',')[1];
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function performSmartCompression(arrayBuffer: any, settings: any) {
  const pdfDoc = await PDFDocument.load(arrayBuffer, {
    ignoreEncryption: true,
  });
  const pages = pdfDoc.getPages();

  if (settings.removeMetadata) {
    try {
      pdfDoc.setTitle('');
      pdfDoc.setAuthor('');
      pdfDoc.setSubject('');
      pdfDoc.setKeywords([]);
      pdfDoc.setCreator('');
      pdfDoc.setProducer('');
    } catch (e) {
      console.warn('Could not remove metadata:', e);
    }
  }

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const resources = page.node.Resources();
    if (!resources) continue;

    const xobjects = resources.lookup(PDFName.of('XObject'));
    if (!(xobjects instanceof PDFDict)) continue;

    for (const [key, value] of xobjects.entries()) {
      const stream = pdfDoc.context.lookup(value);
      if (
        !(stream instanceof PDFStream) ||
        stream.dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')
      )
        continue;

      try {
        const imageBytes = stream.getContents();
        if (imageBytes.length < settings.skipSize) continue;

        const width =
          stream.dict.get(PDFName.of('Width')) instanceof PDFNumber
            ? (stream.dict.get(PDFName.of('Width')) as PDFNumber).asNumber()
            : 0;
        const height =
          stream.dict.get(PDFName.of('Height')) instanceof PDFNumber
            ? (stream.dict.get(PDFName.of('Height')) as PDFNumber).asNumber()
            : 0;
        const bitsPerComponent =
          stream.dict.get(PDFName.of('BitsPerComponent')) instanceof PDFNumber
            ? (
                stream.dict.get(PDFName.of('BitsPerComponent')) as PDFNumber
              ).asNumber()
            : 8;

        if (width > 0 && height > 0) {
          let newWidth = width;
          let newHeight = height;

          const scaleFactor = settings.scaleFactor || 1.0;
          newWidth = Math.floor(width * scaleFactor);
          newHeight = Math.floor(height * scaleFactor);

          if (newWidth > settings.maxWidth || newHeight > settings.maxHeight) {
            const aspectRatio = newWidth / newHeight;
            if (newWidth > newHeight) {
              newWidth = Math.min(newWidth, settings.maxWidth);
              newHeight = newWidth / aspectRatio;
            } else {
              newHeight = Math.min(newHeight, settings.maxHeight);
              newWidth = newHeight * aspectRatio;
            }
          }

          const minDim = settings.minDimension || 50;
          if (newWidth < minDim || newHeight < minDim) continue;

          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          canvas.width = Math.floor(newWidth);
          canvas.height = Math.floor(newHeight);

          const img = new Image();
          const imageUrl = URL.createObjectURL(
            new Blob([new Uint8Array(imageBytes)])
          );

          await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
            img.src = imageUrl;
          });

          ctx.imageSmoothingEnabled = settings.smoothing !== false;
          ctx.imageSmoothingQuality = settings.smoothingQuality || 'medium';

          if (settings.grayscale) {
            ctx.filter = 'grayscale(100%)';
          } else if (settings.contrast) {
            ctx.filter = `contrast(${settings.contrast}) brightness(${settings.brightness || 1})`;
          }

          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

          let bestBytes = null;
          let bestSize = imageBytes.length;

          const jpegDataUrl = canvas.toDataURL('image/jpeg', settings.quality);
          const jpegBytes = dataUrlToBytes(jpegDataUrl);
          if (jpegBytes.length < bestSize) {
            bestBytes = jpegBytes;
            bestSize = jpegBytes.length;
          }

          if (settings.tryWebP) {
            try {
              const webpDataUrl = canvas.toDataURL(
                'image/webp',
                settings.quality
              );
              const webpBytes = dataUrlToBytes(webpDataUrl);
              if (webpBytes.length < bestSize) {
                bestBytes = webpBytes;
                bestSize = webpBytes.length;
              }
            } catch (e) {
              /* WebP not supported */
            }
          }

          if (bestBytes && bestSize < imageBytes.length * settings.threshold) {
            (stream as any).contents = bestBytes;
            stream.dict.set(PDFName.of('Length'), PDFNumber.of(bestSize));
            stream.dict.set(PDFName.of('Width'), PDFNumber.of(canvas.width));
            stream.dict.set(PDFName.of('Height'), PDFNumber.of(canvas.height));
            stream.dict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
            stream.dict.delete(PDFName.of('DecodeParms'));
            stream.dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));

            if (settings.grayscale) {
              stream.dict.set(
                PDFName.of('ColorSpace'),
                PDFName.of('DeviceGray')
              );
            }
          }
          URL.revokeObjectURL(imageUrl);
        }
      } catch (error) {
        console.warn('Skipping an uncompressible image in smart mode:', error);
      }
    }
  }

  const saveOptions = {
    useObjectStreams: settings.useObjectStreams !== false,
    addDefaultPage: false,
    objectsPerTick: settings.objectsPerTick || 50,
  };

  return await pdfDoc.save(saveOptions);
}

async function performLegacyCompression(arrayBuffer: any, settings: any) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url
  ).toString();

  const pdfJsDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const newPdfDoc = await PDFDocument.create();

  for (let i = 1; i <= pdfJsDoc.numPages; i++) {
    const page = await pdfJsDoc.getPage(i);
    const viewport = page.getViewport({ scale: settings.scale });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    canvas.height = viewport.height;
    canvas.width = viewport.width;

    await page.render({ canvasContext: context, viewport, canvas: canvas })
      .promise;

    const jpegBlob = await new Promise((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', settings.quality)
    );
    // @ts-expect-error TS(2339) FIXME: Property 'arrayBuffer' does not exist on type 'unk... Remove this comment to see the full error message
    const jpegBytes = await jpegBlob.arrayBuffer();
    const jpegImage = await newPdfDoc.embedJpg(jpegBytes);
    const newPage = newPdfDoc.addPage([viewport.width, viewport.height]);
    newPage.drawImage(jpegImage, {
      x: 0,
      y: 0,
      width: viewport.width,
      height: viewport.height,
    });
  }
  return await newPdfDoc.save();
}

export async function compress() {
  // @ts-expect-error TS(2339) FIXME: Property 'value' does not exist on type 'HTMLEleme... Remove this comment to see the full error message
  const level = document.getElementById('compression-level').value;
  // @ts-expect-error TS(2339) FIXME: Property 'value' does not exist on type 'HTMLEleme... Remove this comment to see the full error message
  const algorithm = document.getElementById('compression-algorithm').value;

  const settings = {
    balanced: {
      smart: {
        quality: 0.5,
        threshold: 0.95,
        maxWidth: 1800,
        maxHeight: 1800,
        skipSize: 3000,
      },
      legacy: { scale: 1.5, quality: 0.6 },
    },
    'high-quality': {
      smart: {
        quality: 0.7,
        threshold: 0.98,
        maxWidth: 2500,
        maxHeight: 2500,
        skipSize: 5000,
      },
      legacy: { scale: 2.0, quality: 0.9 },
    },
    'small-size': {
      smart: {
        quality: 0.3,
        threshold: 0.95,
        maxWidth: 1200,
        maxHeight: 1200,
        skipSize: 2000,
      },
      legacy: { scale: 1.2, quality: 0.4 },
    },
    extreme: {
      smart: {
        quality: 0.1,
        threshold: 0.95,
        maxWidth: 1000,
        maxHeight: 1000,
        skipSize: 1000,
      },
      legacy: { scale: 1.0, quality: 0.2 },
    },
  };

  const smartSettings = { ...settings[level].smart, removeMetadata: true };
  const legacySettings = settings[level].legacy;

  try {
    const originalFile = state.files[0];
    const arrayBuffer = await readFileAsArrayBuffer(originalFile);

    let resultBytes;
    let usedMethod;

    if (algorithm === 'vector') {
      showLoader(String(t('alerts.runningVectorCompression')));
      resultBytes = await performSmartCompression(arrayBuffer, smartSettings);
      usedMethod = 'Vector';
    } else if (algorithm === 'photon') {
      showLoader(String(t('alerts.runningPhotonCompression')));
      resultBytes = await performLegacyCompression(arrayBuffer, legacySettings);
      usedMethod = 'Photon';
    } else {
      showLoader(String(t('alerts.runningAutomaticVector')));
      const vectorResultBytes = await performSmartCompression(
        arrayBuffer,
        smartSettings
      );

      if (vectorResultBytes.length < originalFile.size) {
        resultBytes = vectorResultBytes;
        usedMethod = 'Vector (Automatic)';
      } else {
        showAlert(String(t('alerts.vectorFailedTryingPhoton')), 'info');
        showLoader(String(t('alerts.runningAutomaticPhoton')));
        resultBytes = await performLegacyCompression(
          arrayBuffer,
          legacySettings
        );
        usedMethod = 'Photon (Automatic)';
      }
    }

    const originalSize = formatBytes(originalFile.size);
    const compressedSize = formatBytes(resultBytes.length);
    const savings = originalFile.size - resultBytes.length;
    const savingsPercent =
      savings > 0 ? ((savings / originalFile.size) * 100).toFixed(1) : 0;

    if (savings > 0) {
      showAlert(
        String(t('alerts.compressionComplete')),
        `Method: **${usedMethod}**. ` +
          `File size reduced from ${originalSize} to ${compressedSize} (Saved ${savingsPercent}%).`
      );
    } else {
      showAlert(
        String(t('alerts.compressionFinished')),
        `Method: **${usedMethod}**. ` +
          `Could not reduce file size. Original: ${originalSize}, New: ${compressedSize}.`,
        // @ts-expect-error TS(2554) FIXME: Expected 2 arguments, but got 3.
        'warning'
      );
    }

    downloadFile(
      new Blob([resultBytes], { type: 'application/pdf' }),
      'compressed-final.pdf'
    );
  } catch (e) {
    showAlert(
      String(t('alerts.error')),
      String(t('alerts.errorDuringCompression', { error: e.message }))
    );
  } finally {
    hideLoader();
  }
}
