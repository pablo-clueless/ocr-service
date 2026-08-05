/**
 * The extraction layer's canonical shapes. Every provider — GLM-OCR, Tesseract,
 * pdf-parse, mammoth — normalizes its output into a {@link RecognizedDocument},
 * so the interpretation layer sees one format regardless of source. This is the
 * load-bearing abstraction of the whole service.
 */

export type MimeGroup = "pdf" | "image" | "docx" | "text";

export type Capability = "text" | "layout" | "tables" | "handwriting" | "seals";

export type BlockLabel = "image" | "text" | "formula" | "table";

/** A single layout region. `bbox` is normalized 0–1: [x0, y0, x1, y1]. */
export type LayoutBlock = {
  index: number;
  page: number;
  label: BlockLabel;
  bbox?: [number, number, number, number];
  content: string;
};

export type PageResult = {
  page: number;
  markdown: string;
  width?: number;
  height?: number;
};

export type RecognizedDocument = {
  markdown: string;
  plainText: string;
  pages: PageResult[];
  blocks: LayoutBlock[];
  pageCount: number;
  provider: string;
  fellBackFrom?: string;
  tokensUsed?: number;
  durationMs: number;
};

/** Raw input handed to a provider. `mimeGroup` is already sniffed. */
export type DocumentInput = {
  buffer: Buffer;
  mimeGroup: MimeGroup;
  sha256: string;
  originalName: string;
};

export type RecognizeOptions = {
  /** 1-based inclusive page range; omitted means the whole document. */
  pageRange?: [number, number];
  /** OCR language hint (Tesseract / rasterized paths). */
  language?: string;
  /** Return cropped region screenshots — used by SIGNING. */
  returnCropImages?: boolean;
  requestId?: string;
  /** Hashed tenant id for provider tracing; never a raw tenant id. */
  userIdHash?: string;
  signal?: AbortSignal;
};

/**
 * Contract every extraction provider implements. Functions declare the
 * capabilities they need; the router matches them against `capabilities` here.
 */
export interface OcrProvider {
  readonly name: string;
  readonly accepts: readonly MimeGroup[];
  readonly capabilities: readonly Capability[];
  recognize(input: DocumentInput, opts: RecognizeOptions): Promise<RecognizedDocument>;
}
