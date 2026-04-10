/**
 * services/dataMerger.js — Merge manual and scraped data sources
 *
 * Manual data (uploaded/pasted by customer) takes priority.
 * Scraped data is appended after a separator.
 * The merged result is stored in property_data for backward compatibility.
 */

/**
 * Merge manual and scraped data into a single property_data string.
 * Manual data is listed first (higher priority for the context compiler).
 *
 * @param {string|null} manualData - Customer-uploaded/pasted data
 * @param {string|null} scrapedData - Web-scraped data
 * @returns {string} Merged data string
 */
function mergePropertyData(manualData, scrapedData) {
  const manual = (manualData || "").trim();
  const scraped = (scrapedData || "").trim();

  if (manual && scraped) {
    return manual + "\n\n--- Scraped Data ---\n\n" + scraped;
  }
  return manual || scraped || "";
}

module.exports = { mergePropertyData };
