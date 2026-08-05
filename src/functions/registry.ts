import { OcrFunction, type OcrFunctionDefinition, type OcrFunctionKey } from "./define";
import { documentAuthenticity } from "./document-authenticity";
import { documentClassification } from "./document-classification";
import { formDataExtraction } from "./form-data-extraction";
import { idVerification } from "./id-verification";
import { receiptParsing } from "./receipt-parsing";
import { textExtraction } from "./text-extraction";
import { resumeParsing } from "./resume-parsing";
import type { JsonSchema } from "../llm/schema";
import { toJsonSchema } from "../llm/schema";
import { signing } from "./signing";

/** Heterogeneous arg/result types across the catalog; the registry is keyed by function. */
export type AnyOcrFunctionDefinition = OcrFunctionDefinition<any, any>;

const definitions: AnyOcrFunctionDefinition[] = [
  textExtraction,
  documentClassification,
  receiptParsing,
  formDataExtraction,
  resumeParsing,
  idVerification,
  signing,
  documentAuthenticity,
];

const registry = new Map<OcrFunctionKey, AnyOcrFunctionDefinition>(definitions.map((d) => [d.key, d]));

export const getFunction = (key: string): AnyOcrFunctionDefinition | undefined => registry.get(key as OcrFunctionKey);

export const isOcrFunctionKey = (key: string): key is OcrFunctionKey =>
  Object.prototype.hasOwnProperty.call(OcrFunction, key);

export const listFunctions = (): AnyOcrFunctionDefinition[] => [...registry.values()];

/** Catalog entry for `GET /v1/ocr/functions` — JSON Schemas let callers generate forms + validate client-side. */
export type CatalogEntry = {
  key: OcrFunctionKey;
  description: string;
  accepts: readonly string[];
  requires: readonly string[];
  sensitivity: string;
  maxPages: number;
  argsSchema: JsonSchema;
  /** Absent for dynamic-schema functions whose result shape depends on args. */
  resultSchema?: JsonSchema;
};

/** Walks the registry and returns the JSON-Schema catalog. */
export const buildCatalog = (): CatalogEntry[] =>
  listFunctions().map((def) => ({
    key: def.key,
    description: def.description,
    accepts: def.accepts,
    requires: def.requires,
    sensitivity: def.sensitivity,
    maxPages: def.maxPages,
    argsSchema: toJsonSchema(def.argsSchema, `${def.key}_args`),
    resultSchema:
      typeof def.resultSchema === "function" ? undefined : toJsonSchema(def.resultSchema, `${def.key}_result`),
  }));
