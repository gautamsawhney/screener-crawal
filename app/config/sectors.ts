// Hardcoded sectors to filter stocks by
// These map to Screener.in sector/industry classifications

export const ALLOWED_SECTORS = [
  "Metals & Mining",      // Metals
  "Aerospace & Defense",  // Defense
  "Banks",                // PSU Banks
  "Automobiles",          // Auto
  "Finance",              // Capital Markets / MF companies
] as const;

// More granular industry filters within the allowed sectors
export const ALLOWED_INDUSTRIES = [
  // Metals
  "Iron & Steel",
  "Aluminium & Copper",
  "Mining & Mineral products",
  "Metals & Mining",

  // Defense
  "Aerospace & Defense",
  "Defence",

  // Banks (PSU Banks)
  "Public Sector Bank",
  "Private Sector Bank",
  "Banks",

  // Auto
  "Passenger Cars & Utility Vehicles",
  "2/3 Wheelers",
  "Commercial Vehicles",
  "Auto Ancillaries",
  "Automobiles",

  // Capital Markets / MF Companies
  "Asset Management",
  "Stock/ Commodity Brokers",
  "Finance",
  "Financial Services",
  "Holding Companies",
] as const;

// Human-readable category names for display
export const SECTOR_CATEGORIES: Record<string, string[]> = {
  "Metals": [
    "Iron & Steel",
    "Aluminium & Copper",
    "Mining & Mineral products",
    "Metals & Mining",
  ],
  "Defense": [
    "Aerospace & Defense",
    "Defence",
  ],
  "PSU Banks": [
    "Public Sector Bank",
    "Private Sector Bank",
    "Banks",
  ],
  "Auto": [
    "Passenger Cars & Utility Vehicles",
    "2/3 Wheelers",
    "Commercial Vehicles",
    "Auto Ancillaries",
    "Automobiles",
  ],
  "Capital Markets": [
    "Asset Management",
    "Stock/ Commodity Brokers",
    "Finance",
    "Financial Services",
    "Holding Companies",
  ],
};

// Get category name from industry
export const getCategoryFromIndustry = (industry: string): string | null => {
  for (const [category, industries] of Object.entries(SECTOR_CATEGORIES)) {
    if (industries.includes(industry)) {
      return category;
    }
  }
  return null;
};
