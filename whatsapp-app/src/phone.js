import { config } from './config.js';

// Normalise un numéro au format international sans "+" (ex. 212655047042).
// Retourne null si le numéro est invalide.
export function normalizePhone(raw, countryCode = config.defaultCountryCode) {
  let digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  else if (digits.startsWith('0') && countryCode) digits = countryCode + digits.slice(1);
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}
