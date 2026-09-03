import { createLink, parseConfig } from "../helpers.mjs";
import PortfolioSummonSpecialEffect from "../../../data/pseudo-documents/power-roll-effects/base-power-roll-effect.mjs";

/** @type {TextEditorEnricherConfig["id"]} */
export const id = "ds.signature";
/* -------------------------------------------------- */
/** @type {TextEditorEnricherConfig["pattern"]} */
export const pattern = new RegExp("\\[\\[/(?<type>signature)(?<config> .*?)?]](?!])(?:{(?<label>[^}]+)})?", "gi");

/* -------------------------------------------------- */
/**
 * Enricher function.
 * @type {TextEditorEnricher}
 */
export async function enricher(match, options) {
  let { config, label: fallback } = match.groups;
  if (!config) return null;

  /** @type {ParsedConfig} */
  const parsedConfig = parseConfig(config);
  parsedConfig._input = match[0];

}
