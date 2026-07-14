/**
 * Intelligence module index.
 */

export { spellCheck } from "./spellcheck.js";
export { suggestProductTag, findDuplicates } from "./suggest.js";
export { loadHistoricalData, getCache, isCacheLoaded, suggestFeatureFromCache, suggestAssigneeFromCache, getDetectedProductTags, getDetectedIteration } from "./history-cache.js";
