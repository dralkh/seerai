import "./setImmediatePolyfill";
import * as mammoth from "mammoth";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

interface ImageData {
  path: string;
  bytes: Uint8Array;
  contentType: string;
}

export function isDocxFile(fileName: string, mimeType?: string): boolean {
  if (mimeType === DOCX_MIME) return true;
  return fileName.toLowerCase().endsWith(".docx");
}

export function isDocFile(fileName: string, mimeType?: string): boolean {
  if (mimeType === "application/msword") return true;
  return fileName.toLowerCase().endsWith(".doc");
}

export function isWordFile(fileName: string, mimeType?: string): boolean {
  return isDocxFile(fileName, mimeType) || isDocFile(fileName, mimeType);
}

export async function convertDocxToMarkdown(arrayBuffer: ArrayBuffer): Promise<{
  markdown: string;
  images: ImageData[];
  warnings: string[];
}> {
  const images: ImageData[] = [];
  let imgCounter = 0;

  const mammothAny = mammoth as any;
  const result = await mammothAny.convertToMarkdown({ arrayBuffer } as any, {
    convertImage: mammoth.images.imgElement(async (image) => {
      imgCounter++;
      const imgId = `image-${String(imgCounter).padStart(3, "0")}`;
      const ext = (image.contentType.split("/").pop() || "png").replace(
        "jpeg",
        "jpg",
      );
      const imgPath = `attachments/${imgId}.${ext}`;
      const base64 = await image.readAsBase64String();
      const binaryStr = atob(base64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      images.push({ path: imgPath, bytes, contentType: image.contentType });
      return { src: imgPath };
    }),
  });

  return {
    markdown: result.value,
    images,
    warnings: (result.messages as Array<any>).map(
      (m: { message: string }) => m.message,
    ),
  };
}

export async function renderDocxPreview(
  arrayBuffer: ArrayBuffer,
  bodyContainer: HTMLElement,
): Promise<void> {
  try {
    const docxPreview = await import("docx-preview");
    const blob = new Blob([arrayBuffer], {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    await docxPreview.renderAsync(blob, bodyContainer, bodyContainer, {
      inWrapper: true,
      ignoreWidth: false,
      ignoreHeight: false,
      ignoreFonts: true,
      breakPages: false,
      ignoreLastRenderedPageBreak: true,
      useBase64URL: true,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
    });
  } catch {
    const mammothHtml = await mammoth.convertToHtml({ arrayBuffer });
    bodyContainer.innerHTML = mammothHtml.value;
  }
}
