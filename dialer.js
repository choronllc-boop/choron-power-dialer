// Pure helpers. No DOM, no deps, no framework. Run `node test.mjs` to check them.

/** Excel and EU exports use ';' or tab. Guess from the header line. */
function sniffDelimiter(text) {
  const head = text.split('\n', 1)[0];
  return [';', '\t', ','].reduce((best, d) =>
    head.split(d).length > head.split(best).length ? d : best, ',');
}

/**
 * RFC4180-ish CSV parse: quoted fields, "" escapes, embedded delimiters + newlines.
 * Records carry __row = the real line in the file, so skip reports point at the right row.
 */
export function parseCSV(text) {
  text = String(text).replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const delim = sniffDelimiter(text);
  const rows = [];
  let row = [], field = '', quoted = false, line = 1, rowLine = 1, qStart = -1;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '\n') line++;
      if (c !== '"') { field += c; continue; }
      if (text[i + 1] === '"') { field += '"'; i++; continue; }
      quoted = false;
    } else if (c === '"' && !field.trim()) {
      quoted = true; qStart = i; field = '';        // allows `a, "b,c"` with a space before the quote
    } else if (c === delim) {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push([row, rowLine]);
      row = []; field = ''; line++; rowLine = line;
    } else if (c !== '\r') {
      field += c;
    }
  }
  // One stray quote must not swallow the rest of the file - drop it and reparse.
  if (quoted && qStart >= 0) return parseCSV(text.slice(0, qStart) + text.slice(qStart + 1));
  if (field !== '' || row.length) { row.push(field); rows.push([row, rowLine]); }
  if (!rows.length) return { headers: [], records: [] };

  const headers = rows[0][0]
    .map((h, i) => h.trim() || `column_${i + 1}`)
    .map((h, i, all) => all.indexOf(h) === i ? h : `${h}_${i + 1}`);   // merged exports repeat "Phone"

  const records = rows.slice(1)
    .filter(([r]) => r.some(v => v.trim() !== ''))
    .map(([r, ln]) => {
      const rec = {};
      headers.forEach((h, j) => { rec[h] = (r[j] ?? '').trim(); });
      rec.__row = ln;                              // assigned last: a CSV column named __row can't clobber it
      return rec;
    });
  return { headers, records };
}

const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/** Find the header that best matches a list of candidate names. Exact match wins over substring. */
export function pickColumn(headers, candidates) {
  for (const c of candidates) {
    const hit = headers.find(h => slug(h) === slug(c));
    if (hit) return hit;
  }
  for (const c of candidates) {
    const hit = headers.find(h => slug(h).includes(slug(c)));
    if (hit) return hit;
  }
  return null;
}

/** Guess which columns hold what. Everything else still gets displayed verbatim. */
export function detectColumns(headers) {
  return {
    phone: pickColumn(headers, ['phone', 'phone_number', 'telephone', 'mobile', 'cell', 'tel', 'number', 'contact']),
    name: pickColumn(headers, ['business_name', 'company_name', 'name', 'business', 'company', 'title', 'account']),
    category: pickColumn(headers, ['business_type', 'category', 'categories', 'industry', 'type', 'niche', 'vertical']),
    address: pickColumn(headers, ['full_address', 'address', 'street_address', 'location', 'formatted_address']),
    city: pickColumn(headers, ['city', 'town', 'locality']),
    state: pickColumn(headers, ['state', 'province', 'region']),
    zip: pickColumn(headers, ['zip', 'zipcode', 'postal_code', 'postcode']),
    website: pickColumn(headers, ['website', 'url', 'site', 'domain', 'web']),
    email: pickColumn(headers, ['email', 'e-mail', 'email_address']),
    lat: pickColumn(headers, ['latitude', 'lat']),
    lng: pickColumn(headers, ['longitude', 'lng', 'lon']),
  };
}

const bad = (reason, raw) => ({ ok: false, reason, raw });

/**
 * "(555) 123-4567 ext. 12" -> { ok: true, e164: "+15551234567" }
 * Anything unusable comes back with a human reason so the UI can say why it skipped.
 * Returning a WRONG number is the failure that matters here, so it fails closed.
 */
export function normalizePhone(raw) {
  if (raw == null || String(raw).trim() === '') return bad('no phone value', raw);
  let s = String(raw).trim();

  // A bare decimal with a real fraction is a coordinate, price or rating - never a phone.
  // (".0" is excluded: that's just Excel coercing an integer. "212.555.0199" isn't a decimal at all.)
  const dec = /^-?\d+\.(\d+)$/.exec(s);
  if (dec && /[1-9]/.test(dec[1])) return bad('looks like a coordinate or amount, not a phone', raw);

  s = s.replace(/\.0+$/, '');          // Excel writes 2125550182 as "2125550182.0"
  s = s.replace(/\(0\)/g, '');         // +44 (0)20 ... - the trunk 0 must not be dialed

  // A cell can hold several numbers, or a label like "Tel and Fax:". Take the first chunk with real digits.
  const parts = s.split(/\s*(?:[;|/]|,|\bor\b|\band\b)\s*/i);
  s = (parts.find(p => p.replace(/\D/g, '').length >= 7) ?? s)
        .replace(/\s*(?:ext|extension|x)\s*\.?\s*:?\s*\d+\s*$/i, '');

  const intl = /^\s*(?:\+|00)/.test(s);
  const digits = s.replace(/\D/g, '');
  if (!digits) return bad(`no digits in "${raw}"`, raw);

  if (intl) {
    const d = digits.replace(/^00/, '');
    if (d[0] === '1') {
      if (d.length !== 11) return bad(`+1 number needs 11 digits, got ${d.length}`, raw);
      if (!/^1[2-9]\d{2}[2-9]/.test(d)) return bad('invalid US area/exchange code', raw);
    } else if (d.length < 8 || d.length > 15) {
      return bad(`bad international length (${d.length} digits)`, raw);
    }
    return { ok: true, e164: '+' + d, raw };
  }
  if (digits.length === 11 && digits[0] === '1') {
    if (!/^1[2-9]\d{2}[2-9]/.test(digits)) return bad('invalid US area/exchange code', raw);
    return { ok: true, e164: '+' + digits, raw };
  }
  if (digits.length === 10) {
    if (!/^[2-9]\d{2}[2-9]/.test(digits)) return bad('invalid US area/exchange code', raw);
    return { ok: true, e164: '+1' + digits, raw };
  }
  if (digits.length < 10) return bad(`too short (${digits.length} digits)`, raw);
  return bad(`unrecognized format (${digits.length} digits)`, raw);
}

/**
 * Prefer the detected phone column; if it's unusable, scan the other cells before giving up.
 * Coordinate and postal columns are excluded - an 8-decimal longitude reads as a valid
 * 10-digit number, and dialing one is worse than skipping the row.
 */
export function findPhone(record, headers, cols) {
  const primary = cols.phone ? normalizePhone(record[cols.phone]) : bad('no phone column in CSV', '');
  if (primary.ok) return { ...primary, source: cols.phone };

  const skip = new Set([cols.phone, cols.lat, cols.lng, cols.zip].filter(Boolean));
  for (const h of headers) {
    if (skip.has(h) || /^(lat|lon|lng)/i.test(h)) continue;
    const v = record[h];
    if (!v || v.replace(/\D/g, '').length < 10) continue;
    const alt = normalizePhone(v);
    if (alt.ok) return { ...alt, source: h, recovered: true };
  }
  return primary;
}

export function prettyPhone(e164) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 || '');
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : (e164 || '');
}

/** Best available map query: lat/lng beats an address string beats name + city. */
export function mapQuery(record, cols) {
  const lat = cols.lat && record[cols.lat], lng = cols.lng && record[cols.lng];
  if (lat && lng && !isNaN(+lat) && !isNaN(+lng)) return `${lat},${lng}`;

  const parts = [];
  if (cols.address && record[cols.address]) parts.push(record[cols.address]);
  else if (cols.name && record[cols.name]) parts.push(record[cols.name]);
  for (const k of ['city', 'state', 'zip']) {
    const col = cols[k];
    if (col && record[col] && !parts.join(' ').includes(record[col])) parts.push(record[col]);
  }
  return parts.filter(Boolean).join(', ');
}

const esc = v => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCSV(headers, rows) {
  return [headers.map(esc).join(','), ...rows.map(r => headers.map(h => esc(r[h])).join(','))].join('\r\n');
}
