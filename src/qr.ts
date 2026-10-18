/* StreamDrop v5 — QR codes, in every direction.
 *
 * Encoding uses `qrcode`; decoding prefers the platform's BarcodeDetector and falls back to
 * jsQR, so a QR can be read on Android, Chrome, Firefox and Safari alike. Three ways in, all
 * wired here so the Send and Receive screens never need to care:
 *   • the camera (scanQrCamera)
 *   • an image from the gallery / files (importQrImage → decodeQrImage)
 *   • plain pasted text (handled by the screens themselves)
 */
import { announce, el } from "./ui";

export async function qrDataUrl(payload: string, width = 320, ecc: "L" | "M" | "Q" | "H" = "M"): Promise<string> {
  const qrcode = await import("qrcode");
  return qrcode.toDataURL(payload, { width, margin: 2, errorCorrectionLevel: ecc });
}

/** A QR image (PNG data-URL) plus a save button, ready to drop into a card. */
export async function qrCard(
  payload: string,
  fileName: string,
  alt: string,
  width = 320,
): Promise<HTMLElement> {
  const dataUrl = await qrDataUrl(payload, width);
  const box = el("div", { class: "qr" });
  box.append(el("img", { src: dataUrl, alt, width: String(width), height: String(width) }));
  const save = el("button", { class: "btn small", type: "button", text: "Save PNG" });
  save.addEventListener("click", () => {
    const a = el("a", { href: dataUrl, download: fileName });
    a.click();
    a.remove();
  });
  box.append(save);
  return box;
}

/* ── decoding ────────────────────────────────────────────────────── */

interface DetectedBarcode {
  rawValue: string;
}
interface Detector {
  detect: (source: CanvasImageSource | ImageBitmapSource) => Promise<DetectedBarcode[]>;
}

function makeDetector(): Detector | null {
  const ctor = (window as unknown as { BarcodeDetector?: new (opts?: { formats?: string[] }) => Detector }).BarcodeDetector;
  if (!ctor) return null;
  try {
    return new ctor({ formats: ["qr_code"] });
  } catch {
    return null;
  }
}

async function jsQrFromImageData(image: ImageData): Promise<string | null> {
  const { default: jsQR } = await import("jsqr");
  return jsQR(image.data, image.width, image.height, { inversionAttempts: "attemptBoth" })?.data ?? null;
}

/** Reads the first QR it can find in a still image (screenshot, photo, downloaded PNG). */
export async function decodeQrImage(file: Blob): Promise<string | null> {
  const bitmap = await createImageBitmap(file);
  try {
    const detector = makeDetector();
    if (detector) {
      try {
        const hits = await detector.detect(bitmap);
        if (hits[0]?.rawValue) return hits[0].rawValue;
      } catch {
        /* fall through to jsQR */
      }
    }
    // Downscale very large photos: jsQR is reliable and much faster at a sane resolution.
    const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, w, h);
    return await jsQrFromImageData(ctx.getImageData(0, 0, w, h));
  } finally {
    bitmap.close?.();
  }
}

/** Opens the photo/file picker (gallery included) and decodes whatever QR is in the image. */
export async function importQrImage(): Promise<string | null> {
  const input = el("input", { type: "file", accept: "image/*", hidden: true });
  document.body.append(input);
  try {
    const picked = await new Promise<File | null>((resolve) => {
      input.addEventListener("change", () => resolve(input.files?.[0] ?? null), { once: true });
      // If the picker is dismissed, focus returns without a change event — don't hang forever.
      window.addEventListener("focus", () => setTimeout(() => resolve(input.files?.[0] ?? null), 800), { once: true });
      input.click();
    });
    if (!picked) return null;
    return await decodeQrImage(picked);
  } finally {
    input.remove();
  }
}

export const cameraAvailable = (): boolean =>
  typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

function readVideoFrame(video: HTMLVideoElement): ImageData | null {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) return null;
  const scale = Math.min(1, 720 / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

/** Live camera scan. Resolves with the raw QR text, or null on timeout. */
export async function scanQrCamera(video: HTMLVideoElement, timeoutMs = 30_000): Promise<string | null> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  video.srcObject = stream;
  video.hidden = false;
  try {
    await video.play();
    const detector = makeDetector();
    announce("Point the camera at the QR code.");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (detector) {
        try {
          const hits = await detector.detect(video);
          if (hits[0]?.rawValue) return hits[0].rawValue;
        } catch {
          /* transient detector failure — keep trying */
        }
      } else {
        const frame = readVideoFrame(video);
        const raw = frame ? await jsQrFromImageData(frame) : null;
        if (raw) return raw;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return null;
  } finally {
    for (const track of stream.getTracks()) track.stop();
    video.hidden = true;
    video.srcObject = null;
  }
}
