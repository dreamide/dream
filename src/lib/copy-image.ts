import { getDesktopApi } from "@/lib/electron";

const PNG_TYPE = "image/png";

const blobToBytes = async (blob: Blob) =>
  new Uint8Array(await blob.arrayBuffer());

// Draws a non-PNG image (JPEG, WebP, GIF, SVG, ...) onto a canvas and
// re-encodes it, because clipboards only reliably accept PNG. Loading from
// an object URL keeps the canvas same-origin, so it is never tainted.
const convertToPng = async (blob: Blob) => {
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();

    const canvas = document.createElement("canvas");
    // SVGs without intrinsic dimensions report 0; fall back to the CSS default.
    canvas.width = image.naturalWidth || 300;
    canvas.height = image.naturalHeight || 150;

    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Canvas is not available.");
    }
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    const png = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, PNG_TYPE),
    );
    if (!png) {
      throw new Error("Could not encode the image as PNG.");
    }
    return blobToBytes(png);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
};

export const imageUrlToPngBytes = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not load the image (HTTP ${response.status}).`);
  }

  const blob = await response.blob();
  return blob.type === PNG_TYPE ? blobToBytes(blob) : convertToPng(blob);
};

/** Copies the image at `url` (data:, blob: or http(s):) to the clipboard. */
export const copyImageToClipboard = async (url: string) => {
  const png = await imageUrlToPngBytes(url);

  const desktopApi = getDesktopApi();
  if (desktopApi) {
    if (!(await desktopApi.writeClipboardImage(png))) {
      throw new Error("Clipboard copy failed.");
    }
    return;
  }

  if (!navigator?.clipboard?.write) {
    throw new Error("Clipboard API not available.");
  }
  await navigator.clipboard.write([
    new ClipboardItem({ [PNG_TYPE]: new Blob([png], { type: PNG_TYPE }) }),
  ]);
};
