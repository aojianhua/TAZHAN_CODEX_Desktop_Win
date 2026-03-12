export type ComposerImageAttachment = {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
  sizeBytes: number;
};

export type ComposerTurnInput = { type: "image"; url: string } | { type: "text"; text: string };

export function buildComposerTurnInput(text: string, images: ComposerImageAttachment[]): ComposerTurnInput[] {
  const items: ComposerTurnInput[] = images.map((image) => ({ type: "image", url: image.dataUrl }));
  if (text.trim().length > 0) {
    items.push({ type: "text", text });
  }
  return items;
}

export function formatComposerAttachmentMeta(image: ComposerImageAttachment): string {
  const kind = image.mimeType.trim().startsWith("image/") ? image.mimeType.replace("image/", "").toUpperCase() : "IMAGE";
  if (image.sizeBytes <= 0) {
    return kind;
  }
  return `${kind} · ${formatBytes(image.sizeBytes)}`;
}

export async function filesToComposerImageAttachments(files: File[]): Promise<ComposerImageAttachment[]> {
  return await Promise.all(
    files.map(async (file, index) => {
      const mimeType = file.type.trim() || "image/png";
      return {
        id: createComposerImageId(index),
        name: normalizeClipboardFileName(file, index, mimeType),
        mimeType,
        dataUrl: await fileToDataUrl(file),
        sizeBytes: Number.isFinite(file.size) ? file.size : 0
      };
    })
  );
}

function createComposerImageId(index: number): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `composer-image-${Date.now()}-${index}`;
}

function normalizeClipboardFileName(file: File, index: number, mimeType: string): string {
  const name = file.name.trim();
  if (name.length > 0) {
    return name;
  }
  return `clipboard-image-${index + 1}.${mimeTypeToExtension(mimeType)}`;
}

function mimeTypeToExtension(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "image/jpeg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/svg+xml":
      return "svg";
    default:
      return "png";
  }
}

function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read clipboard image"));
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Clipboard image reader returned no data"));
    };
    reader.readAsDataURL(file);
  });
}

function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(sizeBytes < 10 * 1024 ? 1 : 0)} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(sizeBytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
