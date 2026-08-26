// node test.mjs   -- fails loudly if the parsing/normalizing logic breaks.
import assert from 'node:assert/strict';
import { parseCSV, detectColumns, normalizePhone, findPhone, mapQuery, toCSV } from './dialer.js';

// --- CSV ---
const csv = `Business Name,Phone Number,Business Type,Full Address,Website
"Joe's Pizza, Inc.",(212) 555-0182,Restaurant,"7 Carmine St, New York, NY 10014",joespizza.com
Acme Plumbing,212.555.0199 x44,Plumber,"12 Main St
Suite 4",
No Phone Co,,Consultant,99 Nowhere Rd,
"Quote ""Kings""",+44 20 7946 0958,Retail,London,`;

const { headers, records } = parseCSV(csv);
assert.equal(headers.length, 5);
assert.equal(records.length, 4, 'blank-ish rows dropped, data rows kept');
assert.equal(records[0]['Business Name'], "Joe's Pizza, Inc.", 'comma inside quotes');
assert.equal(records[1]['Full Address'], '12 Main St\nSuite 4', 'newline inside quotes');
assert.equal(records[3]['Business Name'], 'Quote "Kings"', 'escaped quotes');
assert.equal(records[0].__row, 2, 'row numbers are 1-based file lines');

// --- column detection ---
const cols = detectColumns(headers);
assert.equal(cols.phone, 'Phone Number');
assert.equal(cols.name, 'Business Name');
assert.equal(cols.category, 'Business Type');
assert.equal(cols.address, 'Full Address');
assert.equal(cols.website, 'Website');

// --- phone normalizing ---
assert.equal(normalizePhone('(212) 555-0182').e164, '+12125550182');
assert.equal(normalizePhone('212.555.0199 x44').e164, '+12125550199', 'extension stripped');
assert.equal(normalizePhone('1-212-555-0182').e164, '+12125550182');
assert.equal(normalizePhone('+44 20 7946 0958').e164, '+442079460958');
assert.equal(normalizePhone('00442079460958').e164, '+442079460958');
assert.equal(normalizePhone('212-555-0182 / 212-555-0183').e164, '+12125550182', 'first of several');
assert.equal(normalizePhone('').ok, false);
assert.equal(normalizePhone('  ').ok, false);
assert.equal(normalizePhone(null).ok, false);
assert.equal(normalizePhone('n/a').ok, false);
assert.equal(normalizePhone('555-0182').ok, false, '7 digits is not dialable');
assert.equal(normalizePhone('112-555-0182').ok, false, 'area code cannot start with 1');
assert.match(normalizePhone('555-0182').reason, /too short/);

// --- recovery + skip reporting ---
assert.equal(findPhone(records[0], headers, cols).e164, '+12125550182');
const recovered = findPhone({ 'Phone Number': '', 'Website': 'call 305-555-0100' }, ['Phone Number', 'Website'], cols);
assert.equal(recovered.e164, '+13055550100');
assert.equal(recovered.recovered, true, 'flags that it came from another column');
const skipped = findPhone(records[2], headers, cols);
assert.equal(skipped.ok, false);
assert.ok(skipped.reason, 'skips always carry a reason');

// --- map query ---
assert.equal(mapQuery(records[0], cols), '7 Carmine St, New York, NY 10014');
assert.equal(mapQuery({ lat: '40.73', lng: '-74.00' }, { lat: 'lat', lng: 'lng' }), '40.73,-74.00');
assert.equal(mapQuery({ lat: 'n/a', lng: '', addr: '5 Elm St' }, { lat: 'lat', lng: 'lng', address: 'addr' }), '5 Elm St', 'bad coords fall back to address');

// --- export round-trip ---
const out = toCSV(['a', 'b'], [{ a: 'x,y', b: 'he said "hi"' }]);
assert.equal(parseCSV(out).records[0].b, 'he said "hi"');

// --- the cases that actually bite: wrong number dialed, or leads silently lost ---

// a longitude must never become a phone number
const geoHeaders = ['name', 'phone', 'latitude', 'longitude', 'rating', 'zip'];
const geoCols = detectColumns(geoHeaders);
const geo = findPhone(
  { name: "Joe's", phone: '', latitude: '40.71277530', longitude: '-73.98566439', rating: '4.5', zip: '10014' },
  geoHeaders, geoCols);
assert.equal(geo.ok, false, 'coordinates are not phone numbers');
assert.equal(normalizePhone('-73.98566439').ok, false);
assert.equal(normalizePhone('47.60621000').ok, false, 'trailing zeros do not make it dialable');
assert.equal(normalizePhone('1299.99').ok, false);

// national trunk prefix: +44 (0)20 ... must drop the 0, not dial it
assert.equal(normalizePhone('+44 (0)20 7946 0958').e164, '+442079460958');
assert.equal(normalizePhone('+49 (0)30 12345678').e164, '+493012345678');
assert.equal(normalizePhone('+1 212 555 0182.0').e164, '+12125550182', 'Excel-coerced intl');
assert.equal(normalizePhone('+1 212 555 018').ok, false, '+1 must be exactly 11 digits');
assert.equal(normalizePhone('2125550182.0').e164, '+12125550182', 'Excel-coerced local');

// labels around the number should not lose the lead
assert.equal(normalizePhone('Tel and Fax: 212-555-0182').e164, '+12125550182');
assert.equal(normalizePhone('Phone/Fax: 212-555-0182').e164, '+12125550182');
assert.equal(normalizePhone('(212) 555-0182 (main)').e164, '+12125550182');

// one stray quote must not swallow every row after it
const stray = parseCSV('Name,Phone\n"Joe,212-555-0182\nMary,305-555-0100\n');
assert.equal(stray.records.length, 2, 'unterminated quote recovers instead of eating the file');
assert.equal(stray.records[1].Name, 'Mary');

// CRLF is what Excel actually writes
const crlf = parseCSV('a,b\r\n"1 Main St\r\nSuite 4",x\r\n');
assert.equal(crlf.records[0].a, '1 Main St\nSuite 4', 'no stray \\r inside quoted fields');

// semicolon exports
const semi = parseCSV('Business Name;Phone Number;City\nJoe;212-555-0182;NYC');
assert.deepEqual(semi.headers, ['Business Name', 'Phone Number', 'City']);
assert.equal(findPhone(semi.records[0], semi.headers, detectColumns(semi.headers)).e164, '+12125550182');

// duplicate headers must not destroy the populated one
const dup = parseCSV('Phone,Name,Phone\n212-555-0182,Joe,');
assert.deepEqual(dup.headers, ['Phone', 'Name', 'Phone_3']);
assert.equal(findPhone(dup.records[0], dup.headers, detectColumns(dup.headers)).e164, '+12125550182');

// space before a quote
assert.equal(parseCSV('a,b,c\n1, "x,y", 3').records[0].b, 'x,y');

// __row must be the real file line, past blank rows and multiline fields
const lines = parseCSV('Name,Phone\nA,212-555-0182\n\n"B\nB2",212-555-0183\nC,212-555-0184');
assert.deepEqual(lines.records.map(r => r.__row), [2, 4, 6], 'row numbers survive blanks and wrapped fields');

// a column literally named __row cannot spoof the row number
const spoof = parseCSV('name,__row\nx,<img src=q onerror=alert(1)>');
assert.equal(spoof.records[0].__row, 2);

// degenerate files
assert.deepEqual(parseCSV('').records, []);
assert.deepEqual(parseCSV('Name,Phone\n').records, [], 'header-only file');
assert.equal(parseCSV('Name,Phone\n').headers.length, 2);

console.log('all checks passed');
