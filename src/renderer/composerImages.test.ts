import { describe, expect, it } from "vitest";

import { buildComposerTurnInput, formatComposerAttachmentMeta, type ComposerImageAttachment } from "./composerImages";

function attachment(overrides: Partial<ComposerImageAttachment> = {}): ComposerImageAttachment {
  return {
    id: "img-1",
    name: "clipboard-image-1.png",
    mimeType: "image/png",
    dataUrl: "data:image/png;base64,AAA",
    sizeBytes: 2048,
    ...overrides
  };
}

describe("buildComposerTurnInput", () => {
  it("places pasted images before text", () => {
    expect(buildComposerTurnInput("describe this", [attachment(), attachment({ id: "img-2", dataUrl: "data:image/png;base64,BBB" })])).toEqual([
      { type: "image", url: "data:image/png;base64,AAA" },
      { type: "image", url: "data:image/png;base64,BBB" },
      { type: "text", text: "describe this" }
    ]);
  });

  it("supports image-only turns", () => {
    expect(buildComposerTurnInput("   ", [attachment()])).toEqual([{ type: "image", url: "data:image/png;base64,AAA" }]);
  });
});

describe("formatComposerAttachmentMeta", () => {
  it("shows image kind and size", () => {
    expect(formatComposerAttachmentMeta(attachment())).toBe("PNG · 2.0 KB");
  });

  it("falls back to image kind without size", () => {
    expect(formatComposerAttachmentMeta(attachment({ mimeType: "", sizeBytes: 0 }))).toBe("IMAGE");
  });
});
